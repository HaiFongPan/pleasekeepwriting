/**
 * Strava 历史归档核心（共享 R2 归档协议 v1）。
 *
 * 每条活动在私有 bucket 下有三份产物：
 *   strava/v1/activities/<id>/original.<fit|gpx|tcx|bin>  响应原字节（可能是 gzip，不改写）
 *   strava/v1/activities/<id>/streams.json                {latlng,time,distance,altitude,raw}
 *   strava/v1/activities/<id>/manifest.json               {version,activity,original,streams}
 * 总索引：strava/v1/archive-index.json
 *
 * 几条硬约束：
 *   - manifest 只在原件与 streams 都“有结论”后写：对象写成功，或 Strava 明确 404。
 *     401/403/429/5xx 一律不能伪装成 unavailable。
 *   - 已有 manifest 且对象仍在时跳过原件/streams 大文件，只刷新训练元信息，支持断点续跑。
 *   - 明确 404 记录 unavailable；失败的活动不写 manifest，也不计入 complete。
 *   - 只有分页扫完、所有活动都有 manifest、failedIds 为空时才把索引标 complete。
 *   - 归档全部活动（含私密）；本模块只写私有 R2，不把任何数据落进公开仓库。
 *
 * 数据源与存储都以接口注入，网络与 S3 细节留在调用方，测试用内存实现。
 */

import type { TrainingActivitiesPage, TrainingActivity } from './strava-web'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { isRetryableStravaError, StravaRequestError, StravaSessionExpiredError, trainingPageSize } from './strava-web'

export const archiveVersion = 1
export const archiveRoot = 'strava/v1'
export const archiveActivitiesPrefix = `${archiveRoot}/activities`
export const archiveIndexKey = `${archiveRoot}/archive-index.json`

/** 训练日志的完整模型（保留接口返回的全部字段，不只 TrainingActivity 的子集） */
export type ArchivedActivity = TrainingActivity & Record<string, unknown>

export type OriginalFormat = 'fit' | 'gpx' | 'tcx' | 'unknown'

export interface ArchiveOriginalStored {
  status: 'stored'
  key: string
  sha256: string
  bytes: number
  format: OriginalFormat
  compression: 'gzip' | null
}

export interface ArchiveOriginalUnavailable {
  status: 'unavailable'
  reason: string
}

export type ArchiveOriginal = ArchiveOriginalStored | ArchiveOriginalUnavailable

export interface ArchiveStreamsStored {
  status: 'stored'
  key: string
  sha256: string
}

export interface ArchiveStreamsUnavailable {
  status: 'unavailable'
  reason: string
}

export type ArchiveStreams = ArchiveStreamsStored | ArchiveStreamsUnavailable

export interface ArchiveManifest {
  version: 1
  activity: ArchivedActivity
  original: ArchiveOriginal
  streams: ArchiveStreams
}

export interface ArchiveIndex {
  version: 1
  total: number
  activityIds: number[]
  complete: boolean
  unavailableOriginals: number
  failedIds: number[]
}

/** streams.json 的兼容结构：四个键与站点现有 fetchStreams 对齐，raw 保留完整 API 响应 */
export interface ArchivedStreamsFile {
  latlng: Array<[number, number]>
  time: number[] | null
  distance: number[] | null
  altitude: number[] | null
  raw: Record<string, unknown>
}

export interface ArchiveStorageObject {
  key: string
  size: number
}

export interface ArchiveStorage {
  put: (key: string, body: Uint8Array, contentType: string) => Promise<void>
  get: (key: string) => Promise<Uint8Array | null>
  list: (prefix: string) => Promise<ArchiveStorageObject[]>
}

/** 归档所需的数据源；明确 404 用 null 表示，其余错误直接抛出 */
export interface ArchiveSource {
  fetchActivitiesPage: (page: number) => Promise<TrainingActivitiesPage>
  fetchOriginal: (activityId: number) => Promise<Uint8Array | null>
  fetchStreams: (activityId: number) => Promise<Record<string, unknown> | null>
}

export interface RetryPolicy {
  attempts: number
  baseDelayMs: number
  sleep: (ms: number) => Promise<void>
}

export const defaultRetryPolicy: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 1500,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

export interface ArchiveRunOptions {
  /** 本次最多做多少次真实归档（拉原件/流）；刷新已有 manifest 的元信息不计。null 表示不限 */
  limit: number | null
  /** 复用已有对象时重新拉取对象并比对 manifest 里的 sha256，不一致就重新归档（默认只按 listing 大小核对） */
  verify?: boolean
}

export interface ArchiveRunSummary {
  pages: number
  total: number
  discovered: number
  processed: number
  /** 触发原件/streams 拉取的活动数（计入 limit） */
  workCount: number
  originalStored: number
  originalUnavailable: number
  originalReused: number
  streamsStored: number
  streamsUnavailable: number
  streamsReused: number
  refreshed: number
  failedIds: number[]
  scanComplete: boolean
  /** 因 --limit 提前结束（部分执行） */
  limited: boolean
  indexWritten: boolean
  complete: boolean
}

export interface ArchiveDependencies {
  source: ArchiveSource
  storage: ArchiveStorage
  log?: (line: string) => void
  retry?: Partial<RetryPolicy>
}

export function activityKeyPrefix(activityId: number): string {
  return `${archiveActivitiesPrefix}/${activityId}`
}

export function manifestKeyFor(activityId: number): string {
  return `${activityKeyPrefix(activityId)}/manifest.json`
}

export function originalKeyFor(activityId: number, format: OriginalFormat): string {
  return `${activityKeyPrefix(activityId)}/original.${originalExtension(format)}`
}

export function streamsKeyFor(activityId: number): string {
  return `${activityKeyPrefix(activityId)}/streams.json`
}

export function originalExtension(format: OriginalFormat): string {
  return format === 'unknown' ? 'bin' : format
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1F && bytes[1] === 0x8B
}

function isFit(bytes: Uint8Array): boolean {
  return bytes.length >= 12
    && bytes[0] >= 12
    && String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === '.FIT'
}

function sniffFormat(bytes: Uint8Array): OriginalFormat {
  if (isFit(bytes)) {
    return 'fit'
  }

  const head = new TextDecoder().decode(bytes.slice(0, 1024)).replace(/^\uFEFF/, '')
  if (/<gpx[\s>]/i.test(head)) {
    return 'gpx'
  }

  if (/<TrainingCenterDatabase[\s>]/i.test(head)) {
    return 'tcx'
  }

  return 'unknown'
}

/**
 * 按内容判断原件格式：先看 gzip 魔数，再在解压后的字节上辨认 FIT/GPX/TCX。
 * compression 记录的是响应原字节是否被 gzip 包装；format 是解压后的格式。
 */
export function detectOriginalFormat(bytes: Uint8Array): { format: OriginalFormat, compression: 'gzip' | null } {
  const gzipped = hasGzipMagic(bytes)
  if (!gzipped) {
    return { format: sniffFormat(bytes), compression: null }
  }

  try {
    return { format: sniffFormat(new Uint8Array(gunzipSync(bytes))), compression: 'gzip' }
  }
  catch {
    // gzip 魔数在但解不开：按 unknown 保存原字节，不猜格式
    return { format: 'unknown', compression: 'gzip' }
  }
}

/** 把 streams 响应整理成兼容结构；没有任何可用流时返回 null */
export function buildStreamsFile(payload: Record<string, unknown>): ArchivedStreamsFile | null {
  const dataOf = (key: string): unknown[] | null => {
    const stream = payload[key]
    if (stream && typeof stream === 'object' && Array.isArray((stream as { data?: unknown }).data)) {
      return (stream as { data: unknown[] }).data
    }

    return null
  }

  const hasAnyData = Object.values(payload).some(value =>
    value !== null
    && typeof value === 'object'
    && Array.isArray((value as { data?: unknown }).data),
  )
  if (!hasAnyData) {
    return null
  }

  return {
    latlng: (dataOf('latlng') ?? []) as Array<[number, number]>,
    time: dataOf('time') as number[] | null,
    distance: dataOf('distance') as number[] | null,
    altitude: dataOf('altitude') as number[] | null,
    raw: payload,
  }
}

/** 解析并校验已有 manifest；版本、id 或状态形状不对时返回 null，让调用方重新归档 */
export function parseArchiveManifest(text: string, activityId: number): ArchiveManifest | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    return null
  }

  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<ArchiveManifest>
  const activity = candidate.activity as ArchivedActivity | undefined
  if (candidate.version !== archiveVersion || !activity || typeof activity !== 'object' || Number(activity.id) !== activityId) {
    return null
  }

  const original = candidate.original
  if (!original || typeof original !== 'object') {
    return null
  }

  if (original.status === 'stored') {
    if (!original.key || !original.sha256 || typeof original.bytes !== 'number' || !isOriginalFormat(original.format)) {
      return null
    }
  }
  else if (original.status !== 'unavailable') {
    return null
  }

  const streams = candidate.streams
  if (!streams || typeof streams !== 'object') {
    return null
  }

  if (streams.status === 'stored') {
    if (!streams.key || !streams.sha256) {
      return null
    }
  }
  else if (streams.status !== 'unavailable') {
    return null
  }

  return candidate as ArchiveManifest
}

function isOriginalFormat(value: unknown): value is OriginalFormat {
  return value === 'fit' || value === 'gpx' || value === 'tcx' || value === 'unknown'
}

/** 429/5xx 与网络层错误按低频退避重试；401/403 等直接抛出 */
export async function withArchiveRetry<T>(
  operation: () => Promise<T>,
  policy: RetryPolicy,
  isRetryable: (error: unknown) => boolean = defaultIsRetryable,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return await operation()
    }
    catch (error) {
      lastError = error
      if (attempt >= policy.attempts || !isRetryable(error)) {
        throw error
      }

      await policy.sleep(policy.baseDelayMs * attempt)
    }
  }

  throw lastError
}

/** 从 manifest key 解析活动 id，只认协议路径 */
export function activityIdFromManifestKey(key: string): number | null {
  const match = new RegExp(`^${archiveActivitiesPrefix}/(\\d+)/manifest\\.json$`).exec(key)
  if (!match) {
    return null
  }

  const id = Number.parseInt(match[1], 10)
  return Number.isInteger(id) ? id : null
}

/** fetch 的网络层错误是 TypeError（如 `fetch failed`），同样值得重试 */
function defaultIsRetryable(error: unknown): boolean {
  return isRetryableStravaError(error) || error instanceof TypeError
}

interface ActivityOutcome {
  didWork: boolean
  originalStored: boolean
  originalUnavailable: boolean
  originalReused: boolean
  streamsStored: boolean
  streamsUnavailable: boolean
  streamsReused: boolean
  manifestWritten: boolean
}

interface ActivityContext {
  source: ArchiveSource
  storage: ArchiveStorage
  retry: RetryPolicy
  knownObjects: Map<string, number>
  verify: boolean
}

async function archiveActivity(activity: ArchivedActivity, context: ActivityContext): Promise<ActivityOutcome> {
  const activityId = activity.id
  const manifestKey = manifestKeyFor(activityId)
  const outcome: ActivityOutcome = {
    didWork: false,
    originalStored: false,
    originalUnavailable: false,
    originalReused: false,
    streamsStored: false,
    streamsUnavailable: false,
    streamsReused: false,
    manifestWritten: false,
  }

  // 已有 manifest：读取并校验，原件/流对象仍在（大小一致）才算可复用
  let existingSerialized: string | null = null
  let existingManifest: ArchiveManifest | null = null
  if (context.knownObjects.has(manifestKey)) {
    const raw = await context.storage.get(manifestKey)
    if (raw) {
      existingSerialized = new TextDecoder().decode(raw)
      existingManifest = parseArchiveManifest(existingSerialized, activityId)
    }
  }

  let original = existingManifest?.original ?? null
  if (original?.status === 'stored' && context.knownObjects.get(original.key) !== original.bytes) {
    original = null
  }

  let streams = existingManifest?.streams ?? null
  if (streams?.status === 'stored' && !context.knownObjects.has(streams.key)) {
    streams = null
  }

  // --verify：复用前重新读回对象，按 manifest 的 sha256 校验到字节
  if (context.verify && original?.status === 'stored') {
    const stored = await context.storage.get(original.key)
    if (stored === null || sha256Hex(stored) !== original.sha256) {
      original = null
    }
  }

  if (context.verify && streams?.status === 'stored') {
    const stored = await context.storage.get(streams.key)
    if (stored === null || sha256Hex(stored) !== streams.sha256) {
      streams = null
    }
  }

  const needOriginal = original === null
  const needStreams = streams === null
  outcome.didWork = needOriginal || needStreams

  if (needOriginal) {
    const bytes = await withArchiveRetry(() => context.source.fetchOriginal(activityId), context.retry)
    if (bytes === null) {
      original = { status: 'unavailable', reason: 'http-404' }
    }
    else if (bytes.length === 0) {
      throw new Error(`活动 ${activityId} 的原始文件为空。`)
    }
    else {
      const { format, compression } = detectOriginalFormat(bytes)
      const key = originalKeyFor(activityId, format)
      await context.storage.put(key, bytes, 'application/octet-stream')
      original = { status: 'stored', key, sha256: sha256Hex(bytes), bytes: bytes.length, format, compression }
      outcome.originalStored = true
    }
  }

  if (needStreams) {
    const payload = await withArchiveRetry(() => context.source.fetchStreams(activityId), context.retry)
    if (payload === null) {
      streams = { status: 'unavailable', reason: 'http-404' }
    }
    else {
      const file = buildStreamsFile(payload)
      if (file === null) {
        streams = { status: 'unavailable', reason: 'no-streams' }
      }
      else {
        const bytes = new TextEncoder().encode(JSON.stringify(file))
        const key = streamsKeyFor(activityId)
        await context.storage.put(key, bytes, 'application/json')
        streams = { status: 'stored', key, sha256: sha256Hex(bytes) }
        outcome.streamsStored = true
      }
    }
  }

  if (!needOriginal && original?.status === 'stored') {
    outcome.originalReused = true
  }

  if (original?.status === 'unavailable') {
    outcome.originalUnavailable = true
  }

  if (!needStreams && streams?.status === 'stored') {
    outcome.streamsReused = true
  }

  if (streams?.status === 'unavailable') {
    outcome.streamsUnavailable = true
  }

  // 原件与 streams 都有结论后才发布 manifest；刷新元信息时凭字符串比较避免无意义写入
  const manifest: ArchiveManifest = { version: archiveVersion, activity, original: original as ArchiveOriginal, streams: streams as ArchiveStreams }
  const serialized = JSON.stringify(manifest)
  if (serialized !== existingSerialized) {
    await context.storage.put(manifestKey, new TextEncoder().encode(serialized), 'application/json')
    outcome.manifestWritten = true
  }

  return outcome
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').slice(0, 200)
}

/**
 * 跑一轮完整归档：分页扫训练日志 → 逐条归档 → 必要时写总索引。
 * 返回统计；授权失败与 429 会直接抛出，交给调用方中止并保留已有进度。
 */
export async function archiveStrava(dependencies: ArchiveDependencies, options: ArchiveRunOptions): Promise<ArchiveRunSummary> {
  const { source, storage } = dependencies
  const log = dependencies.log ?? (() => {})
  const retry: RetryPolicy = { ...defaultRetryPolicy, ...dependencies.retry }

  const knownObjects = new Map<string, number>()
  for (const object of await storage.list(archiveRoot)) {
    knownObjects.set(object.key, object.size)
  }

  const existingManifestIds = new Set<number>()
  for (const key of knownObjects.keys()) {
    const id = activityIdFromManifestKey(key)
    if (id !== null) {
      existingManifestIds.add(id)
    }
  }

  const summary: ArchiveRunSummary = {
    pages: 0,
    total: 0,
    discovered: 0,
    processed: 0,
    workCount: 0,
    originalStored: 0,
    originalUnavailable: 0,
    originalReused: 0,
    streamsStored: 0,
    streamsUnavailable: 0,
    streamsReused: 0,
    refreshed: 0,
    failedIds: [],
    scanComplete: false,
    limited: false,
    indexWritten: false,
    complete: false,
  }

  const seen = new Set<number>()
  const publishedManifests = new Set<number>()
  const failed = new Set<number>()
  let declaredTotal = 0
  let previousTotal: number | null = null

  let stop = false

  for (let page = 1; !stop; page++) {
    const result = await withArchiveRetry(() => source.fetchActivitiesPage(page), retry)
    summary.pages = page

    // Strava 的 total 可能随扫描过程中的增删而变动，以最新值为准判断是否扫完
    const latestTotal = result.total
    if (previousTotal !== null && previousTotal !== latestTotal) {
      log(`注意：训练日志 total 从 ${previousTotal} 变为 ${latestTotal}`)
    }

    previousTotal = latestTotal
    declaredTotal = latestTotal
    summary.total = declaredTotal
    log(`第 ${page} 页：${result.models.length} 条（已发现 ${seen.size}/${declaredTotal}）`)

    for (const model of result.models) {
      if (seen.has(model.id)) {
        continue
      }

      seen.add(model.id)
      const activity = { ...model } as ArchivedActivity
      summary.processed++

      try {
        const outcome = await archiveActivity(activity, { source, storage, retry, knownObjects, verify: options.verify ?? false })
        summary.originalStored += outcome.originalStored ? 1 : 0
        summary.originalUnavailable += outcome.originalUnavailable ? 1 : 0
        summary.originalReused += outcome.originalReused ? 1 : 0
        summary.streamsStored += outcome.streamsStored ? 1 : 0
        summary.streamsUnavailable += outcome.streamsUnavailable ? 1 : 0
        summary.streamsReused += outcome.streamsReused ? 1 : 0
        summary.refreshed += outcome.didWork ? 0 : 1

        if (outcome.didWork) {
          summary.workCount++
        }

        publishedManifests.add(model.id)
        if (summary.processed % 100 === 0) {
          log(`…已处理 ${summary.processed} 条（新归档 ${summary.originalStored} 个原件）`)
        }
      }
      catch (error) {
        // 授权失效与限流直接中止整轮，避免继续消耗账号配额
        if (error instanceof StravaSessionExpiredError || (error instanceof StravaRequestError && error.status === 429)) {
          throw error
        }

        failed.add(model.id)
        log(`归档失败 #${model.id}：${errorText(error)}`)
      }

      if (options.limit !== null && summary.workCount >= options.limit) {
        summary.limited = true
        stop = true
        log(`已达到本次上限 ${options.limit} 条（部分执行）`)
        break
      }
    }

    if (stop) {
      break
    }

    if (result.models.length === 0) {
      break
    }

    if (seen.size >= declaredTotal) {
      break
    }

    if (result.models.length < trainingPageSize) {
      break
    }

    // 防御脏数据：接口声明 total 在但翻页不再推进时，不要无限请求
    if (page >= Math.ceil(declaredTotal / trainingPageSize) + 3) {
      break
    }
  }

  summary.discovered = seen.size
  summary.scanComplete = seen.size >= declaredTotal
  summary.failedIds = [...failed].sort((left, right) => left - right)

  if (summary.scanComplete) {
    const activityIds = [...seen].sort((left, right) => left - right)
    const unresolved = activityIds.filter(id => !publishedManifests.has(id) && !existingManifestIds.has(id))
    summary.complete = unresolved.length === 0 && summary.failedIds.length === 0
    const index: ArchiveIndex = {
      version: archiveVersion,
      total: activityIds.length,
      activityIds,
      complete: summary.complete,
      unavailableOriginals: summary.originalUnavailable,
      failedIds: summary.failedIds,
    }
    await storage.put(archiveIndexKey, new TextEncoder().encode(JSON.stringify(index)), 'application/json')
    summary.indexWritten = true
    log(`索引已更新：total=${index.total} complete=${index.complete} failed=${index.failedIds.length}`)
  }
  else {
    log('本次未扫完训练日志，保留上一个索引')
  }

  return summary
}
