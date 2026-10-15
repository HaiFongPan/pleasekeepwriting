/**
 * 共享 R2 归档协议 v1 的读取与校验（消费端）。
 *
 * 布局：
 *   strava/v1/archive-index.json                          总索引
 *   strava/v1/activities/<numeric-id>/manifest.json       每条历史活动
 *
 * 校验原则：manifest 只在对象可靠写入或明确 404 无原件后才会发布，
 * 所以消费端把「stored 但对象缺失」当作完整性错误拒绝继续，而不是当成
 * unavailable；私密字段缺失时按私密处理（fail closed）。
 */

import { gunzipSync } from 'node:zlib'

export const archiveIndexKey = 'strava/v1/archive-index.json'
export const archiveActivitiesPrefix = 'strava/v1/activities/'

const manifestKeyPattern = /^strava\/v1\/activities\/(\d+)\/manifest\.json$/

export type ArchiveOriginalFormat = 'fit' | 'gpx' | 'tcx' | 'unknown'

export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveFormatError'
  }
}

/** 历史活动条目：完整 TrainingActivity 加上归档器保留的额外源字段 */
export interface ArchivedActivity {
  id: number
  name: string | null
  sport_type: string
  display_type: string
  start_date: string
  start_date_local_raw: number
  distance_raw: number
  moving_time_raw: number
  elapsed_time_raw: number
  elevation_gain_raw: number | null
  has_latlng: boolean
  private: boolean
  visibility: string | null
  [extra: string]: unknown
}

export interface ArchivedOriginal {
  status: 'stored' | 'unavailable'
  key?: string
  sha256?: string
  bytes?: number
  format?: ArchiveOriginalFormat
  compression?: 'gzip' | null
  reason?: string
}

export interface ArchivedStreams {
  status: 'stored' | 'unavailable'
  key?: string
  sha256?: string
  reason?: string
}

export interface ArchivedManifest {
  version: number
  activity: ArchivedActivity
  original: ArchivedOriginal
  streams: ArchivedStreams
}

export interface ArchiveIndex {
  version: number
  total: number
  activityIds: number[]
  complete: boolean
  failedIds: number[]
  unavailableOriginalIds: number[]
  unavailableOriginalCount: number
}

export interface ArchivedStreamsData {
  latlng: Array<[number, number]>
  time: number[] | null
  distance: number[] | null
  altitude: number[] | null
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArchiveFormatError(`${what} 不是 JSON 对象`)
  }

  return value as Record<string, unknown>
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function requireNumber(record: Record<string, unknown>, field: string, what: string): number {
  const value = record[field]
  if (!isFiniteNumber(value)) {
    throw new ArchiveFormatError(`${what}.${field} 不是有限数值`)
  }

  return value
}

function optionalNumber(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function requireString(record: Record<string, unknown>, field: string, what: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ArchiveFormatError(`${what}.${field} 不是非空字符串`)
  }

  return value
}

function requireIntegerArray(value: unknown, what: string): number[] {
  if (!Array.isArray(value)) {
    throw new ArchiveFormatError(`${what} 不是数组`)
  }

  return value.map((item) => {
    if (!Number.isSafeInteger(item) || (item as number) <= 0) {
      throw new ArchiveFormatError(`${what} 含非法活动 ID`)
    }

    return item as number
  })
}

/** 从 manifest 对象键解析 Strava 数值 ID，不符合布局时返回 null */
export function activityIdFromManifestKey(key: string): number | null {
  const match = manifestKeyPattern.exec(key)
  if (!match) {
    return null
  }

  const id = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** gzip 检测：manifest / streams / 原件都可能带 compression: gzip */
export function maybeGunzip(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 2 && bytes[0] === 0x1F && bytes[1] === 0x8B) {
    return new Uint8Array(gunzipSync(bytes))
  }

  return bytes
}

/** 解析对象字节里的 JSON；错误信息里不含对象键或内容 */
export function parseJsonBytes(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(maybeGunzip(bytes)))
  }
  catch {
    throw new ArchiveFormatError(`${what} 不是合法 JSON`)
  }
}

/**
 * 是否属于可公开消费的历史活动。
 * 沿用原站点的 private=false 筛选（包括 followers_only）；Only Me 不公开。
 * 缺 private 字段时按私密处理，绝不因为字段缺失而公开。
 */
export function isPublicArchivedActivity(activity: ArchivedActivity): boolean {
  if (activity.private) {
    return false
  }

  const visibility = activity.visibility?.trim().toLowerCase() ?? ''
  return !visibility.startsWith('only') && !visibility.includes('private')
}

function parseArchivedActivity(value: unknown): ArchivedActivity {
  const raw = asRecord(value, 'manifest.activity')
  const id = requireNumber(raw, 'id', 'manifest.activity')
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ArchiveFormatError('manifest.activity.id 不是正整数')
  }

  const sportType = optionalString(raw.sport_type) ?? 'Workout'
  return {
    ...raw,
    id,
    name: optionalString(raw.name),
    sport_type: sportType,
    display_type: optionalString(raw.display_type) ?? sportType,
    start_date: optionalString(raw.start_date) ?? '',
    start_date_local_raw: requireNumber(raw, 'start_date_local_raw', 'manifest.activity'),
    distance_raw: requireNumber(raw, 'distance_raw', 'manifest.activity'),
    moving_time_raw: requireNumber(raw, 'moving_time_raw', 'manifest.activity'),
    elapsed_time_raw: requireNumber(raw, 'elapsed_time_raw', 'manifest.activity'),
    elevation_gain_raw: optionalNumber(raw.elevation_gain_raw),
    has_latlng: raw.has_latlng === true,
    // 缺 private 字段时按私密处理（fail closed）
    private: typeof raw.private === 'boolean' ? raw.private : true,
    visibility: optionalString(raw.visibility),
  }
}

function parseOriginal(value: unknown): ArchivedOriginal {
  const raw = asRecord(value, 'manifest.original')
  const status = raw.status
  if (status !== 'stored' && status !== 'unavailable') {
    throw new ArchiveFormatError('manifest.original.status 不是 stored/unavailable')
  }

  if (status === 'unavailable') {
    const original: ArchivedOriginal = { status }
    const reason = optionalString(raw.reason)
    if (reason) {
      original.reason = reason
    }

    return original
  }

  const format = raw.format === 'fit' || raw.format === 'gpx' || raw.format === 'tcx' ? raw.format : 'unknown'
  return {
    status,
    key: requireString(raw, 'key', 'manifest.original'),
    sha256: optionalString(raw.sha256) ?? undefined,
    bytes: optionalNumber(raw.bytes) ?? undefined,
    format,
    compression: raw.compression === 'gzip' ? 'gzip' : null,
  }
}

function parseStreams(value: unknown): ArchivedStreams {
  const raw = asRecord(value, 'manifest.streams')
  const status = raw.status
  if (status !== 'stored' && status !== 'unavailable') {
    throw new ArchiveFormatError('manifest.streams.status 不是 stored/unavailable')
  }

  if (status === 'unavailable') {
    const streams: ArchivedStreams = { status }
    const reason = optionalString(raw.reason)
    if (reason) {
      streams.reason = reason
    }

    return streams
  }

  return {
    status,
    key: requireString(raw, 'key', 'manifest.streams'),
    sha256: optionalString(raw.sha256) ?? undefined,
  }
}

/** 解析并校验一条 manifest */
export function parseManifest(value: unknown): ArchivedManifest {
  const raw = asRecord(value, 'manifest')
  return {
    version: requireNumber(raw, 'version', 'manifest'),
    activity: parseArchivedActivity(raw.activity),
    original: parseOriginal(raw.original),
    streams: parseStreams(raw.streams),
  }
}

function parseIndexIds(value: unknown, what: string): number[] {
  return requireIntegerArray(value, what)
}

/** 解析总索引；unavailableOriginals 允许是 id 数组或数量 */
export function parseArchiveIndex(value: unknown): ArchiveIndex {
  const raw = asRecord(value, 'archive-index')
  const availability = raw.unavailableOriginals
  let unavailableOriginalIds: number[] = []
  let unavailableOriginalCount = 0

  if (Array.isArray(availability)) {
    unavailableOriginalIds = parseIndexIds(availability, 'archive-index.unavailableOriginals')
    unavailableOriginalCount = unavailableOriginalIds.length
  }
  else if (isFiniteNumber(availability)) {
    unavailableOriginalCount = availability
  }

  return {
    version: requireNumber(raw, 'version', 'archive-index'),
    total: requireNumber(raw, 'total', 'archive-index'),
    activityIds: parseIndexIds(raw.activityIds, 'archive-index.activityIds'),
    complete: raw.complete === true,
    failedIds: raw.failedIds == null ? [] : parseIndexIds(raw.failedIds, 'archive-index.failedIds'),
    unavailableOriginalIds,
    unavailableOriginalCount,
  }
}

export interface ArchiveReadiness {
  ready: boolean
  /** 只描述问题与数量，不含任何活动 ID、名称或日期 */
  problems: string[]
}

/**
 * 归档就绪门槛：complete、failedIds 为空、total 一致、activityIds 与
 * 实际 manifest 集合完全对应，缺一不可。消费端只有在就绪时才把归档
 * 当作完整历史，否则正式同步拒绝写入。
 */
export function checkArchiveReadiness(index: ArchiveIndex, manifestIds: Set<number>): ArchiveReadiness {
  const problems: string[] = []
  const knownIds = new Set(index.activityIds)

  if (index.version !== 1) {
    problems.push(`归档索引 version=${index.version}，不是受支持的 1`)
  }

  if (!index.complete) {
    problems.push('归档索引 complete 不是 true')
  }

  if (index.failedIds.length > 0) {
    problems.push(`归档索引 failedIds 非空（${index.failedIds.length} 条）`)
  }

  if (index.total !== index.activityIds.length) {
    problems.push(`归档索引 total=${index.total} 与 activityIds 数量 ${index.activityIds.length} 不一致`)
  }

  if (knownIds.size !== index.activityIds.length) {
    problems.push('归档索引 activityIds 有重复项')
  }

  if (index.unavailableOriginalIds.some(id => !knownIds.has(id))) {
    problems.push('归档索引 unavailableOriginals 含 activityIds 之外的 id')
  }

  const missingManifests = index.activityIds.filter(id => !manifestIds.has(id)).length
  if (missingManifests > 0) {
    problems.push(`归档索引有 ${missingManifests} 条活动的 manifest 缺失`)
  }

  const extraManifests = [...manifestIds].filter(id => !knownIds.has(id)).length
  if (extraManifests > 0) {
    problems.push(`发现 ${extraManifests} 条不在归档索引里的 manifest`)
  }

  return { ready: problems.length === 0, problems }
}

function numberArrayOrNull(value: unknown, what: string): number[] | null {
  if (value == null) {
    return null
  }

  if (!Array.isArray(value) || value.some(item => !isFiniteNumber(item))) {
    throw new ArchiveFormatError(`${what} 不是有限数值数组`)
  }

  return value.map(item => item as number)
}

/** 解析 streams 对象：{latlng,time,distance,altitude}，与 fetchStreams 口径一致 */
export function parseStreamsObject(value: unknown): ArchivedStreamsData {
  const raw = asRecord(value, 'streams')
  const latlng: Array<[number, number]> = []
  if (raw.latlng != null) {
    if (!Array.isArray(raw.latlng)) {
      throw new ArchiveFormatError('streams.latlng 不是数组')
    }

    for (const pair of raw.latlng) {
      if (!Array.isArray(pair) || pair.length < 2 || !isFiniteNumber(pair[0]) || !isFiniteNumber(pair[1])) {
        throw new ArchiveFormatError('streams.latlng 含非法坐标')
      }

      latlng.push([pair[0], pair[1]])
    }
  }

  return {
    latlng,
    time: numberArrayOrNull(raw.time, 'streams.time'),
    distance: numberArrayOrNull(raw.distance, 'streams.distance'),
    altitude: numberArrayOrNull(raw.altitude, 'streams.altitude'),
  }
}
