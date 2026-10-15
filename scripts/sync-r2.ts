/**
 * 从只读 R2 归档导入运动数据：历史 Strava manifest + 手机 FIT 上传。
 *
 * 用法：
 *   pnpm sync-r2                      # 正式导入（要求归档索引完整），写回仓库并更新状态
 *   pnpm sync-r2 --dry-run            # 只写 node_modules/.cache/strava-r2-dry-run，先检查再切
 *   pnpm sync-r2 --out-dir /tmp/x     # 把产物写到指定目录做验证，不动仓库文件
 *   pnpm sync-r2 --full               # 忽略增量状态，逐条重新校验
 *   pnpm sync-r2 --timezone UTC       # 覆盖展示时区（默认 R2_SYNC_TIMEZONE 或 Asia/Shanghai）
 *
 * 正式导入的门槛：archive-index.json 必须存在，complete=true、failedIds 为空，
 * total/activityIds 与实际 manifest 集合完全一致；任一不满足就非零退出且不写
 * 数据与状态。--dry-run / --out-dir 允许在不完整归档上做诊断。
 *
 * 凭据（只读）：R2_ENDPOINT / R2_BUCKET / R2_READ_ACCESS_KEY_ID /
 * R2_READ_SECRET_ACCESS_KEY。不写任何远端对象；日志不输出凭据、对象键、
 * 坐标或私密活动元信息。
 */

import type { SportActivitiesData, SportActivity, SportKind, SportRenderParams } from '../src/types/strava'
import type { ArchivedActivity, ArchivedStreamsData, ArchiveIndex } from './lib/r2-archive'
import type { R2Object, R2ObjectInfo, R2Reader } from './lib/r2-client'
import type { HistoryDedupCandidate, HistoryFitIdentity, PhoneDedupRef, PhoneDedupResult } from './lib/r2-dedup'
import type { FitTrackPoint, PhoneFitData } from './lib/r2-fit'
import type { SyncState, SyncStateHistoryFitEntry, SyncStateManifestEntry, SyncStatePhoneEntry } from './lib/r2-state'
import type { TrackBuildOptions } from './lib/strava-track'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { themeConfig } from '../src/config'
import { resolveMetricKind } from '../src/utils/sport'
import { loadDotEnv } from './lib/env'
import { readFitSummary } from './lib/fit'
import { activityIdFromManifestKey, archiveActivitiesPrefix, archiveIndexKey, checkArchiveReadiness, isPublicArchivedActivity, maybeGunzip, parseArchiveIndex, parseJsonBytes, parseManifest, parseStreamsObject } from './lib/r2-archive'
import { createR2Reader, readR2Config } from './lib/r2-client'
import { activityIdKey, historyActivityFromManifest, mergeDataset, phoneActivityFromFit } from './lib/r2-dataset'
import { computeWodSignature, decidePhoneDedup, findHistoryCandidates } from './lib/r2-dedup'
import { identifyFitFile, readPhoneFit, resolveDisplayTimeZone, zonedWallClockEpoch } from './lib/r2-fit'
import { parseSyncState, stateContentEquals, syncStatePath } from './lib/r2-state'
import { computeGradeLevels, computeSpeedLevels } from './lib/strava-metrics'
import { buildTrackFromPoints, defaultTrackOptions } from './lib/strava-track'

const datasetPath = 'src/data/strava/activities.json'
const tracksDir = 'public/strava/tracks'
const phonePrefix = 'activities/v1/'
const phoneKeyPattern = /^activities\/v1\/([0-9a-f]{64})\.fit$/
/** 解析器版本，改手机 FIT 解析口径时递增 */
const parserVersion = 1
/** 渲染器版本，与旧同步脚本一致，改轨迹算法时递增 */
const rendererVersion = 4
const dryRunRoot = path.join('node_modules', '.cache', 'strava-r2-dry-run')

class SyncIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncIntegrityError'
  }
}

interface CliOptions {
  dryRun: boolean
  full: boolean
  /** 只做验证（dry-run 或指定输出目录），允许不完整归档 */
  verification: boolean
  limit: number
  timezone: string | null
  outDir: string | null
}

function readArgValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null
}

function parseArgs(argv: string[]): CliOptions {
  const dryRun = argv.includes('--dry-run')
  const outDir = readArgValue(argv, '--out-dir')
  const verification = dryRun || outDir != null

  let limit = Number.POSITIVE_INFINITY
  const limitValue = readArgValue(argv, '--limit')
  if (limitValue != null) {
    limit = Number.parseInt(limitValue, 10)
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('--limit 需要非负整数')
    }

    if (!verification) {
      throw new Error('--limit 只能和 --dry-run 或 --out-dir 一起用，避免正式导入只写一半')
    }
  }

  return {
    dryRun,
    full: argv.includes('--full'),
    verification,
    limit,
    timezone: readArgValue(argv, '--timezone'),
    outDir,
  }
}

function resolveParams(): SportRenderParams {
  const { track, showMap, showLocationNames } = themeConfig.sport
  return {
    renderer: rendererVersion,
    viewBox: track.viewBox,
    padding: track.padding,
    trimStartMeters: track.trimStartMeters,
    minRetainRatio: track.minRetainRatio,
    minTrimMeters: track.minTrimMeters,
    simplifyTolerance: track.simplifyTolerance,
    maxPoints: track.maxPoints,
    showMap,
    showLocationNames,
  }
}

function trackOptionsFromParams(params: SportRenderParams): TrackBuildOptions {
  return {
    ...defaultTrackOptions,
    viewBox: params.viewBox,
    padding: params.padding,
    trimStartMeters: params.trimStartMeters,
    minRetainRatio: params.minRetainRatio,
    minTrimMeters: params.minTrimMeters,
    simplifyTolerance: params.simplifyTolerance,
    maxPoints: params.maxPoints,
    showMap: params.showMap,
  }
}

function verifiedBytes(bytes: Uint8Array, expected: string | undefined): Uint8Array {
  if (!expected || sha256Hex(bytes) !== expected) {
    throw new SyncIntegrityError('归档对象 SHA-256 校验失败')
  }
  return bytes
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  }
  catch {
    return false
  }
}

async function writeFileIfChanged(filePath: string, contents: string): Promise<boolean> {
  const current = await readText(filePath)
  if (current === contents) {
    return false
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  await fs.writeFile(temporaryPath, contents, 'utf8')
  await fs.rename(temporaryPath, filePath)
  return true
}

async function readDataset(root: string): Promise<SportActivitiesData | null> {
  const text = await readText(path.join(root, datasetPath))
  if (text == null) {
    return null
  }

  try {
    return JSON.parse(text) as SportActivitiesData
  }
  catch {
    throw new Error(`${datasetPath} 不是合法 JSON，拒绝覆盖`)
  }
}

async function readState(root: string): Promise<SyncState | null> {
  const text = await readText(path.join(root, syncStatePath))
  if (text == null) {
    return null
  }

  try {
    return parseSyncState(JSON.parse(text))
  }
  catch {
    return null
  }
}

function summarizeOriginal(original: { status: 'stored' | 'unavailable', key?: string, sha256?: string, format?: 'fit' | 'gpx' | 'tcx' | 'unknown' }): SyncStateManifestEntry['original'] {
  return { status: original.status, format: original.format, sha256: original.sha256, key: original.key }
}

function summarizeStreams(streams: { status: 'stored' | 'unavailable', key?: string, sha256?: string }): SyncStateManifestEntry['streams'] {
  return { status: streams.status, key: streams.key, sha256: streams.sha256 }
}

function buildHistoryTrack(streams: ArchivedStreamsData, kind: SportKind, options: TrackBuildOptions) {
  const points = streams.latlng.map(([lat, lng]) => ({ lat, lng }))
  const metricKind = resolveMetricKind(kind)
  const metric = metricKind === 'speed'
    ? computeSpeedLevels(streams)
    : metricKind === 'grade'
      ? computeGradeLevels(streams)
      : null

  return buildTrackFromPoints(points, options, metric)
}

function buildPhoneTrack(points: FitTrackPoint[], options: TrackBuildOptions) {
  const trackPoints = points.map(point => ({ lat: point.lat, lng: point.lng }))
  const metric = points.length >= 3
    ? computeSpeedLevels({
        time: points.map(point => point.time),
        distance: points.map(point => point.distance),
      })
    : null

  return buildTrackFromPoints(trackPoints, options, metric)
}

/** 清理输出目录里不再被数据集引用的轨迹文件 */
async function pruneTracks(root: string, keep: Set<string>): Promise<number> {
  const directory = path.join(root, tracksDir)
  let entries: string[] = []

  try {
    entries = await fs.readdir(directory)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }

    throw error
  }

  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.json') || keep.has(entry)) {
      continue
    }

    await fs.rm(path.join(directory, entry))
    removed++
  }

  return removed
}

interface VerificationDiff {
  added: string[]
  removed: string[]
  changed: string[]
}

function diffDatasets(before: SportActivitiesData | null, after: SportActivitiesData): VerificationDiff {
  const beforeById = new Map((before?.activities ?? []).map(activity => [activityIdKey(activity.id), activity]))
  const afterById = new Map(after.activities.map(activity => [activityIdKey(activity.id), activity]))
  const diff: VerificationDiff = { added: [], removed: [], changed: [] }

  for (const [key, activity] of afterById) {
    const previous = beforeById.get(key)
    if (!previous) {
      diff.added.push(String(activity.id))
    }
    else if (JSON.stringify(previous) !== JSON.stringify(activity)) {
      diff.changed.push(String(activity.id))
    }
  }

  for (const [key, activity] of beforeById) {
    if (!afterById.has(key)) {
      diff.removed.push(String(activity.id))
    }
  }

  return diff
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  loadDotEnv()

  const timezone = options.timezone ?? resolveDisplayTimeZone()
  const params = resolveParams()
  const trackOptions = trackOptionsFromParams(params)
  const reader: R2Reader = createR2Reader(readR2Config())

  const inputRoot = process.cwd()
  const outRoot = options.outDir
    ? path.resolve(options.outDir)
    : options.dryRun
      ? path.resolve(dryRunRoot)
      : inputRoot

  if (options.dryRun && options.outDir == null) {
    await fs.rm(outRoot, { recursive: true, force: true })
  }

  const existing = await readDataset(inputRoot)
  const loadedState = await readState(inputRoot)
  const previousState = loadedState?.parser === parserVersion ? loadedState : null
  console.log(`站点已有 ${existing?.activities.length ?? 0} 条活动；状态文件${previousState ? '已读取' : '不存在，将逐条重建'}`)
  console.log(`展示时区 ${timezone}${options.full ? '；--full 忽略增量状态' : ''}\n`)

  // ---- 归档索引与就绪门槛 ----
  const indexObject = await reader.get(archiveIndexKey)
  let index: ArchiveIndex | null = null
  const gateProblems: string[] = []
  if (!indexObject) {
    gateProblems.push('归档索引 strava/v1/archive-index.json 缺失')
  }
  else {
    try {
      index = parseArchiveIndex(parseJsonBytes(indexObject.bytes, 'archive-index'))
    }
    catch (error) {
      gateProblems.push(error instanceof Error ? error.message : String(error))
    }
  }

  const archiveObjects = await reader.list(archiveActivitiesPrefix)
  const manifestInfos: Array<R2ObjectInfo & { id: number }> = []
  for (const object of archiveObjects) {
    const id = activityIdFromManifestKey(object.key)
    if (id != null) {
      manifestInfos.push({ ...object, id })
    }
  }

  if (index) {
    gateProblems.push(...checkArchiveReadiness(index, new Set(manifestInfos.map(info => info.id))).problems)
  }

  if (gateProblems.length > 0) {
    if (!options.verification) {
      console.error('R2 归档未就绪，本次不写入任何数据或状态：')
      for (const problem of gateProblems) {
        console.error(`  - ${problem}`)
      }

      process.exitCode = 1
      return
    }

    console.warn('警告：归档未就绪，仅供验证诊断：')
    for (const problem of gateProblems) {
      console.warn(`  - ${problem}`)
    }
  }

  // 只并发读取新增或变更的 manifest；R2 读取无需沿用 Strava 的请求间隔。
  const manifestObjects = new Map<string, R2Object | null>()
  const pendingManifests = manifestInfos.filter(info => options.full
    || previousState?.manifests[String(info.id)]?.etag !== info.etag).slice(0, options.limit)
  let manifestCursor = 0
  await Promise.all(Array.from({ length: Math.min(8, pendingManifests.length) }, async () => {
    while (manifestCursor < pendingManifests.length) {
      const info = pendingManifests[manifestCursor++]
      manifestObjects.set(info.key, await reader.get(info.key))
    }
  }))

  // ---- 历史归档 ----
  const previousById = new Map<string, SportActivity>((existing?.activities ?? []).map(activity => [activityIdKey(activity.id), activity]))
  const paramsChanged = existing != null && JSON.stringify(existing.params) !== JSON.stringify(params)
  const rendererChanged = options.full || paramsChanged
    || (loadedState != null && previousState == null)
    || (previousState != null && previousState.renderer !== rendererVersion)

  const manifestIds = new Set<number>()
  const privateIds = new Set<number>()
  const publicHistory: SportActivity[] = []
  const nextManifests: Record<string, SyncStateManifestEntry> = {}
  const pendingTracks = new Map<string, string>()
  let budget = options.limit
  let completeRun = true
  let historyAdded = 0
  let historyUpdated = 0
  let historyPrivate = 0
  let historyReused = 0
  let tracksBuilt = 0
  let tracksReused = 0
  let caloriesFilled = 0

  for (let manifestIndex = 0; manifestIndex < manifestInfos.length; manifestIndex++) {
    const info = manifestInfos[manifestIndex]
    manifestIds.add(info.id)
    const previous = previousById.get(activityIdKey(info.id))
    const cached = options.full ? undefined : previousState?.manifests[String(info.id)]
    const cacheUsable = cached != null && cached.etag === info.etag && previous != null
    const sourceChanged = options.full || (previousState != null && !cacheUsable)
    const trackExists = previous?.track === true
      ? await fileExists(path.join(inputRoot, tracksDir, `${info.id}.json`))
      : false
    const wantTrack = (previous?.hasGps ?? true) && (rendererChanged || previous == null || previous.trackSynced !== true || (previous.track && !trackExists))
    const wantCalories = options.full || previous == null || previous.caloriesSynced !== true

    if (cacheUsable && !wantTrack && !wantCalories) {
      publicHistory.push({ ...previous })
      nextManifests[String(info.id)] = cached
      historyReused++
      continue
    }

    if (budget <= 0) {
      completeRun = false
      if (cached != null) {
        nextManifests[String(info.id)] = cached
      }

      if (previous != null) {
        publicHistory.push({ ...previous })
      }

      continue
    }

    budget--

    let source: ArchivedActivity | null = null
    let active: SyncStateManifestEntry
    if (cacheUsable) {
      active = cached
    }
    else {
      const object = manifestObjects.has(info.key) ? manifestObjects.get(info.key) : await reader.get(info.key)
      if (!object) {
        throw new SyncIntegrityError(`归档 manifest 对象缺失（清单第 ${manifestIndex + 1} 条）`)
      }

      const parsed = parseManifest(parseJsonBytes(object.bytes, 'manifest'))
      if (parsed.activity.id !== info.id) {
        throw new SyncIntegrityError(`归档 manifest 内容与对象键不一致（清单第 ${manifestIndex + 1} 条）`)
      }

      if (!isPublicArchivedActivity(parsed.activity)) {
        privateIds.add(info.id)
        historyPrivate++
        continue
      }

      source = parsed.activity
      active = {
        etag: info.etag,
        sha256: sha256Hex(object.bytes),
        original: summarizeOriginal(parsed.original),
        streams: summarizeStreams(parsed.streams),
      }
    }

    const record = source != null
      ? historyActivityFromManifest(source, previous)
      : { ...previous } as SportActivity

    if ((wantTrack || sourceChanged) && record.hasGps) {
      if (active.streams.status === 'stored' && active.streams.key) {
        const object = await reader.get(active.streams.key)
        if (!object) {
          throw new SyncIntegrityError('归档 streams 对象缺失')
        }

        const streams = parseStreamsObject(parseJsonBytes(verifiedBytes(object.bytes, active.streams.sha256), 'streams'))
        const outcome = buildHistoryTrack(streams, record.kind, trackOptions)
        if (outcome.kind === 'track') {
          pendingTracks.set(`${info.id}.json`, JSON.stringify(outcome.file))
          record.track = true
          tracksBuilt++
        }
        else {
          record.track = false
        }

        record.trackSynced = true
      }
      else {
        record.track = false
        record.trackSynced = true
      }
    }
    else {
      record.track = previous?.track ?? false
      record.trackSynced = previous?.trackSynced ?? false
      if (record.track) {
        tracksReused++
      }
    }

    if (wantCalories) {
      let calories = previous?.calories ?? null
      if (active.original.status === 'stored' && active.original.format === 'fit' && active.original.key) {
        const object = await reader.get(active.original.key)
        if (!object) {
          throw new SyncIntegrityError('归档原件对象缺失')
        }

        const summary = readFitSummary(verifiedBytes(object.bytes, active.original.sha256))
        if (calories == null && summary?.totalCalories != null) {
          calories = summary.totalCalories
          caloriesFilled++
        }
      }

      record.calories = calories
      record.caloriesSynced = true
    }

    if (previous == null) {
      historyAdded++
    }
    else if (JSON.stringify(previous) !== JSON.stringify(record)) {
      historyUpdated++
    }

    publicHistory.push(record)
    nextManifests[String(info.id)] = active
  }

  // ---- 手机 FIT 上传 ----
  const historyCandidates: HistoryDedupCandidate[] = publicHistory.filter(record => nextManifests[String(record.id)] != null).map((record) => {
    const entry = nextManifests[String(record.id)]
    return {
      id: record.id as number,
      start: record.start,
      distance: record.distance,
      kind: record.kind,
      original: {
        status: entry.original.status,
        format: entry.original.format,
        sha256: entry.original.sha256,
        key: entry.original.key,
      },
    }
  })

  const historyIdentities: Record<string, SyncStateHistoryFitEntry> = { ...(previousState?.historyFitIdentities ?? {}) }

  const resolveHistoryIdentity = async (candidate: HistoryDedupCandidate): Promise<HistoryFitIdentity> => {
    const sourceSha = candidate.original.sha256 ?? ''
    const cached = historyIdentities[String(candidate.id)]
    if (!options.full && cached && cached.sourceSha256 === sourceSha) {
      return cached
    }

    const entry: SyncStateHistoryFitEntry = { sourceSha256: sourceSha, activityId: null, sha256: null, wod: null }
    if (candidate.original.status === 'stored' && candidate.original.format === 'fit' && candidate.original.key) {
      const object = await reader.get(candidate.original.key)
      if (!object) {
        throw new SyncIntegrityError('历史原件对象缺失')
      }

      const bytes = maybeGunzip(verifiedBytes(object.bytes, candidate.original.sha256))
      entry.wod = computeWodSignature(bytes)
      try {
        const identity = identifyFitFile(bytes)
        entry.activityId = identity.activityId
        entry.sha256 = identity.sha256
      }
      catch {
        // 无法解析的历史原件按“不能判定同一活动”处理
      }
    }

    historyIdentities[String(candidate.id)] = entry
    return entry
  }

  const loadHistoryFitBytes = async (candidate: HistoryDedupCandidate): Promise<Uint8Array> => {
    if (candidate.original.status !== 'stored' || !candidate.original.key) {
      throw new SyncIntegrityError('历史原件不可用')
    }

    const object = await reader.get(candidate.original.key)
    if (!object) {
      throw new SyncIntegrityError('历史原件对象缺失')
    }

    return maybeGunzip(verifiedBytes(object.bytes, candidate.original.sha256))
  }

  const phoneObjects: Array<{ info: R2ObjectInfo, id: string }> = []
  let phoneObjectsSkipped = 0
  for (const info of await reader.list(phonePrefix)) {
    const match = phoneKeyPattern.exec(info.key)
    if (!match) {
      phoneObjectsSkipped++
      continue
    }

    phoneObjects.push({ info, id: match[1] })
  }

  phoneObjects.sort((left, right) => left.id.localeCompare(right.id))

  const phoneIds = new Set<string>()
  const nextPhones: Record<string, SyncStatePhoneEntry> = {}
  const phoneRecords: SportActivity[] = []
  let phoneAdded = 0
  let phoneUpdated = 0
  let phoneReused = 0
  let phoneSuppressed = 0
  let phoneSkipped = 0
  let phoneTracks = 0

  for (const { info, id } of phoneObjects) {
    phoneIds.add(id)
    const previous = previousById.get(activityIdKey(id))
    const cached = options.full ? undefined : previousState?.phones[id]
    const timezoneMatches = previousState == null || previousState.timezone === timezone
    const cachedUsable = cached != null
      && cached.etag === info.etag
      && cached.skipped == null
      && cached.start != null
      && cached.distance != null
      && cached.kind != null
      && timezoneMatches

    if (cached?.skipped === 'no-session' && cached.etag === info.etag && timezoneMatches) {
      nextPhones[id] = { ...cached }
      phoneSkipped++
      continue
    }

    if (!cachedUsable && budget <= 0) {
      completeRun = false
      if (cached != null) {
        nextPhones[id] = { ...cached }
      }

      if (previous != null) {
        phoneRecords.push({ ...previous })
      }

      continue
    }

    if (!cachedUsable) {
      budget--
    }

    let bytes: Uint8Array | null = null
    const phoneBytes = async (): Promise<Uint8Array> => {
      if (bytes == null) {
        const object = await reader.get(info.key)
        if (!object) {
          throw new SyncIntegrityError('手机归档对象缺失')
        }

        bytes = object.bytes
      }

      return bytes
    }

    const parsePhone = async (): Promise<PhoneFitData> => readPhoneFit(await phoneBytes())

    let ref: PhoneDedupRef
    let dedupMode: string
    let hasGps: boolean
    let parsed: PhoneFitData | null = null

    if (cachedUsable) {
      ref = {
        activityId: id,
        sha256: cached.sha256,
        wod: cached.wod,
        start: cached.start as number,
        distance: cached.distance as number,
        kind: cached.kind as SportKind,
      }
      dedupMode = cached.dedupMode
      hasGps = cached.hasGps === true
    }
    else {
      parsed = await parsePhone()
      if (parsed.identity.activityId !== id) {
        throw new SyncIntegrityError('手机归档对象键与内容标识不一致')
      }

      const wod = computeWodSignature(await phoneBytes())
      if (!parsed.session) {
        nextPhones[id] = { etag: info.etag, sha256: parsed.identity.sha256, dedupMode: parsed.identity.dedupMode, wod, skipped: 'no-session' }
        phoneSkipped++
        continue
      }

      ref = {
        activityId: id,
        sha256: parsed.identity.sha256,
        wod,
        start: zonedWallClockEpoch(parsed.session.start, timezone),
        distance: parsed.session.distanceMeters ?? 0,
        kind: parsed.session.kind,
      }
      dedupMode = parsed.identity.dedupMode
      hasGps = parsed.hasGps
    }

    const candidates = findHistoryCandidates(ref, historyCandidates)
    let decision: PhoneDedupResult = { matched: false }
    const previousMatch = cachedUsable && cached.suppressedBy != null
      ? candidates.find(candidate => candidate.id === cached.suppressedBy
        && candidate.original.sha256 != null
        && candidate.original.sha256 === previousState?.manifests[String(candidate.id)]?.original.sha256)
      : undefined
    if (previousMatch) {
      decision = { matched: true, historyId: previousMatch.id, mode: 'identity' }
    }
    else if (candidates.length > 0) {
      decision = await decidePhoneDedup(ref, candidates, {
        historyIdentity: resolveHistoryIdentity,
        historyBytes: loadHistoryFitBytes,
        phoneBytes,
      })
    }

    if (decision.matched) {
      nextPhones[id] = {
        etag: info.etag,
        sha256: ref.sha256,
        dedupMode,
        wod: ref.wod,
        start: ref.start,
        distance: ref.distance,
        kind: ref.kind,
        hasGps,
        suppressedBy: decision.historyId,
      }
      phoneSuppressed++
      continue
    }

    const trackExists = previous?.track === true
      ? await fileExists(path.join(inputRoot, tracksDir, `${id}.json`))
      : false
    const trackWork = hasGps && (rendererChanged || previous == null || previous.trackSynced !== true || (previous.track && !trackExists))
    const recordWork = !cachedUsable || previous == null || trackWork

    let record: SportActivity
    if (recordWork) {
      const fit = parsed ?? await parsePhone()
      const session = fit.session
      if (!session) {
        throw new SyncIntegrityError('手机 FIT 缺少 session')
      }

      let track = false
      if (hasGps) {
        const outcome = buildPhoneTrack(fit.points, trackOptions)
        if (outcome.kind === 'track') {
          pendingTracks.set(`${id}.json`, JSON.stringify(outcome.file))
          track = true
          phoneTracks++
        }
      }

      record = phoneActivityFromFit({
        activityId: id,
        start: ref.start,
        sportType: session.sportType,
        displayType: session.displayType,
        kind: session.kind,
        distance: ref.distance,
        movingTime: session.timerSeconds ?? 0,
        elapsedTime: session.elapsedSeconds ?? 0,
        calories: session.calories,
        elevation: session.elevationGainMeters,
        hasGps,
        track,
        trackSynced: true,
      }, previous)
    }
    else {
      record = { ...previous } as SportActivity
    }

    if (previous == null) {
      phoneAdded++
    }
    else if (JSON.stringify(previous) !== JSON.stringify(record)) {
      phoneUpdated++
    }
    else {
      phoneReused++
    }

    phoneRecords.push(record)
    nextPhones[id] = {
      etag: info.etag,
      sha256: ref.sha256,
      dedupMode,
      wod: ref.wod,
      start: ref.start,
      distance: ref.distance,
      kind: ref.kind,
      hasGps,
      track: record.track,
      trackSynced: record.trackSynced,
    }
  }

  // 私密 / 已消失的历史不再保留 identity 缓存（也不写进状态文件）
  const publicIds = new Set(publicHistory.map(record => record.id))
  for (const key of Object.keys(historyIdentities)) {
    if (!publicIds.has(Number(key))) {
      delete historyIdentities[key]
    }
  }

  const merged = mergeDataset({
    params,
    previous: existing,
    history: publicHistory,
    manifestIds,
    privateIds,
    phones: phoneRecords,
    phoneIds,
  })
  const keepTracks = new Set(merged.data.activities.filter(activity => activity.track).map(activity => `${activity.id}.json`))

  const nextState: SyncState = {
    version: 1,
    parser: parserVersion,
    renderer: rendererVersion,
    generatedAt: previousState?.generatedAt ?? '',
    timezone,
    archive: {
      key: archiveIndexKey,
      etag: indexObject?.etag ?? '',
      sha256: indexObject ? sha256Hex(indexObject.bytes) : '',
      version: index?.version ?? 0,
      complete: index?.complete ?? false,
      total: index?.total ?? 0,
      failed: index?.failedIds.length ?? 0,
      unavailableOriginals: index?.unavailableOriginalCount ?? 0,
    },
    manifests: nextManifests,
    historyFitIdentities: historyIdentities,
    phones: nextPhones,
    totals: {
      historyPublic: publicHistory.length,
      historyPrivate,
      phone: Object.keys(nextPhones).length,
    },
  }

  // ---- 落盘：全部远端读取与解析成功后才写本地 ----
  let tracksWritten = 0
  for (const [name, contents] of pendingTracks) {
    if (await writeFileIfChanged(path.join(outRoot, tracksDir, name), `${contents}\n`)) {
      tracksWritten++
    }
  }

  if (outRoot !== inputRoot) {
    for (const name of keepTracks) {
      if (pendingTracks.has(name))
        continue
      const content = await readText(path.join(inputRoot, tracksDir, name))
      if (content == null)
        throw new SyncIntegrityError('需要沿用的轨迹文件缺失')
      await writeFileIfChanged(path.join(outRoot, tracksDir, name), content)
    }
  }

  const datasetChanged = await writeFileIfChanged(path.join(outRoot, datasetPath), `${JSON.stringify(merged.data, null, 2)}\n`)
  const tracksRemoved = completeRun ? await pruneTracks(outRoot, keepTracks) : 0

  let stateWritten = false
  if (previousState == null || !stateContentEquals(nextState, previousState) || outRoot !== inputRoot) {
    if (previousState == null || !stateContentEquals(nextState, previousState)) {
      nextState.generatedAt = new Date().toISOString()
    }
    stateWritten = await writeFileIfChanged(path.join(outRoot, syncStatePath), `${JSON.stringify(nextState, null, 2)}\n`)
  }

  // ---- 汇总 ----
  const data = merged.data
  console.log('\nR2 导入完成：')
  console.log(`  归档索引：${index?.activityIds.length ?? 0} 条历史（公开 ${publicHistory.length}，私密 ${historyPrivate}）`)
  console.log(`  历史：新增 ${historyAdded}，更新 ${historyUpdated}，未变复用 ${historyReused}，归档缺失保留 ${merged.warnings.missingHistoryIds.length}，私密移除 ${merged.warnings.removedPrivateIds.length}`)
  console.log(`  手机：新增 ${phoneAdded}，更新 ${phoneUpdated}，未变复用 ${phoneReused}，与历史同活动抑制 ${phoneSuppressed}，无 session 跳过 ${phoneSkipped}，其他对象跳过 ${phoneObjectsSkipped}`)
  console.log(`  轨迹：重建 ${tracksBuilt + phoneTracks}（历史 ${tracksBuilt} / 手机 ${phoneTracks}），沿用 ${tracksReused}，写入 ${tracksWritten}，清理 ${tracksRemoved}`)
  console.log(`  卡路里：从原件补全 ${caloriesFilled} 条`)
  console.log(`  数据集：${data.summary.activityCount} 条活动、${data.summary.trackCount} 条轨迹、缺卡路里 ${data.summary.calorieMissing}`)
  console.log(`  文件：${datasetChanged ? 'activities.json 已更新' : 'activities.json 无变化'}，${stateWritten ? '状态已更新' : '状态无变化'}${completeRun ? '' : '（本次未完整处理，已跳过轨迹清理）'}`)

  if (merged.warnings.missingHistoryIds.length > 0) {
    console.warn(`警告：${merged.warnings.missingHistoryIds.length} 条旧历史不在归档 manifest 集合里，已保留展示并等待明确删除授权。`)
  }

  if (merged.warnings.removedPhoneIds.length > 0) {
    console.log(`  手机归档已消失的记录：移除 ${merged.warnings.removedPhoneIds.length} 条`)
  }

  if (options.verification) {
    const diff = diffDatasets(existing, data)
    console.log(`\n验证输出目录：${outRoot}`)
    console.log(`  与当前站点数据相比：新增 ${diff.added.length}，移除 ${diff.removed.length}，更新 ${diff.changed.length}`)
    if (diff.added.length > 0) {
      console.log(`  新增 ID：${diff.added.join(', ')}`)
    }

    if (diff.removed.length > 0) {
      console.log(`  移除 ID：${diff.removed.join(', ')}`)
    }

    if (diff.changed.length > 0) {
      console.log(`  更新 ID：${diff.changed.join(', ')}`)
    }
  }
}

main().catch((error) => {
  console.error(`R2 导入失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
