/**
 * R2 导入产出的数据集状态（提交到仓库，供下一次增量同步使用）。
 *
 * 内容限制：manifest / 历史 identity 缓存只保存公开历史活动的对象键与摘要，
 * 绝不写入私密活动的 id、名称、日期或来源键；手机对象状态属于用户已授权
 * 展示的手机上传数据。生成时间戳只在内容变化时更新，保证空增量零 diff。
 */

import type { SportKind } from '../../src/types/strava'
import type { WodFileSignature } from './r2-dedup'

export const syncStatePath = 'src/data/strava/r2-sync-state.json'

export interface SyncStateOriginalEntry {
  status: 'stored' | 'unavailable'
  format?: 'fit' | 'gpx' | 'tcx' | 'unknown'
  sha256?: string
  key?: string
}

export interface SyncStateStreamsEntry {
  status: 'stored' | 'unavailable'
  key?: string
}

export interface SyncStateManifestEntry {
  etag: string
  sha256: string
  original: SyncStateOriginalEntry
  streams: SyncStateStreamsEntry
}

export interface SyncStateHistoryFitEntry {
  sourceSha256: string
  activityId: string | null
  sha256: string | null
  wod: WodFileSignature | null
}

export interface SyncStatePhoneEntry {
  etag: string
  sha256: string
  dedupMode: string
  wod: WodFileSignature | null
  /** 无 session 的 FIT 只记录对象状态，不做展示与匹配 */
  skipped?: 'no-session'
  start?: number
  distance?: number
  kind?: SportKind
  hasGps?: boolean
  track?: boolean
  trackSynced?: boolean
  /** 命中的公开历史活动 id；命中私密历史不会出现在这里 */
  suppressedBy?: number
}

export interface SyncStateArchiveEntry {
  key: string
  etag: string
  sha256: string
  version: number
  complete: boolean
  total: number
  failed: number
  unavailableOriginals: number
}

export interface SyncState {
  version: 1
  parser: number
  renderer: number
  generatedAt: string
  timezone: string
  archive: SyncStateArchiveEntry
  /** 键是公开历史的数值 Strava ID（这些 id 已在 activities.json 里公开） */
  manifests: Record<string, SyncStateManifestEntry>
  historyFitIdentities: Record<string, SyncStateHistoryFitEntry>
  /** 键是手机上传的内容标识（也是轨迹文件名），用户已授权展示 */
  phones: Record<string, SyncStatePhoneEntry>
  totals: {
    historyPublic: number
    historyPrivate: number
    phone: number
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

const sportKinds = new Set(['ride', 'run', 'hike', 'walk', 'swim', 'other'])

function isWodSignature(value: unknown): value is WodFileSignature {
  if (value === null) {
    return true
  }

  return isRecord(value) && typeof value.signature === 'string' && isStringOrNull(value.fileIdManufacturer)
}

function isManifestEntry(value: unknown): value is SyncStateManifestEntry {
  if (!isRecord(value) || typeof value.etag !== 'string' || typeof value.sha256 !== 'string' || !isRecord(value.original) || !isRecord(value.streams)) {
    return false
  }

  return isStringOrNull(value.original.status)
}

function isHistoryFitEntry(value: unknown): value is SyncStateHistoryFitEntry {
  return isRecord(value)
    && typeof value.sourceSha256 === 'string'
    && isStringOrNull(value.activityId)
    && isStringOrNull(value.sha256)
    && isWodSignature(value.wod)
}

function isPhoneEntry(value: unknown): value is SyncStatePhoneEntry {
  if (!isRecord(value)
    || typeof value.etag !== 'string'
    || typeof value.sha256 !== 'string'
    || typeof value.dedupMode !== 'string'
    || !isWodSignature(value.wod)) {
    return false
  }

  const optionalNumbers = ['start', 'distance', 'suppressedBy']
  if (optionalNumbers.some(field => value[field] != null && !isFiniteNumber(value[field]))) {
    return false
  }

  if (value.kind != null && (typeof value.kind !== 'string' || !sportKinds.has(value.kind))) {
    return false
  }

  if (value.skipped == null && (!isFiniteNumber(value.start) || !isFiniteNumber(value.distance) || typeof value.kind !== 'string')) {
    return false
  }

  return true
}

function isEntryMap(value: unknown, predicate: (entry: unknown) => boolean): boolean {
  return isRecord(value) && Object.values(value).every(predicate)
}

/** 解析状态文件；结构不符时返回 null，让下一次同步按全量重建处理 */
export function parseSyncState(value: unknown): SyncState | null {
  if (!isRecord(value) || value.version !== 1) {
    return null
  }

  if (!isFiniteNumber(value.parser) || !isFiniteNumber(value.renderer) || typeof value.timezone !== 'string' || !isRecord(value.archive)) {
    return null
  }

  if (!isEntryMap(value.manifests, isManifestEntry)
    || !isEntryMap(value.historyFitIdentities, isHistoryFitEntry)
    || !isEntryMap(value.phones, isPhoneEntry)) {
    return null
  }

  return {
    version: 1,
    parser: value.parser,
    renderer: value.renderer,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : new Date().toISOString(),
    timezone: value.timezone,
    archive: value.archive as unknown as SyncStateArchiveEntry,
    manifests: value.manifests as Record<string, SyncStateManifestEntry>,
    historyFitIdentities: value.historyFitIdentities as Record<string, SyncStateHistoryFitEntry>,
    phones: value.phones as Record<string, SyncStatePhoneEntry>,
    totals: isRecord(value.totals)
      ? {
          historyPublic: isFiniteNumber(value.totals.historyPublic) ? value.totals.historyPublic : 0,
          historyPrivate: isFiniteNumber(value.totals.historyPrivate) ? value.totals.historyPrivate : 0,
          phone: isFiniteNumber(value.totals.phone) ? value.totals.phone : 0,
        }
      : { historyPublic: 0, historyPrivate: 0, phone: 0 },
  }
}

/** 是否只有 generatedAt 不同（用于空增量不写文件） */
export function stateContentEquals(left: SyncState, right: SyncState): boolean {
  const { generatedAt: _leftGeneratedAt, ...leftRest } = left
  const { generatedAt: _rightGeneratedAt, ...rightRest } = right
  return JSON.stringify(leftRest) === JSON.stringify(rightRest)
}
