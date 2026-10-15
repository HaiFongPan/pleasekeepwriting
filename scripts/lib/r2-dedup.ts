/**
 * 手机上传与历史 Strava 归档的去重匹配。
 *
 * 两条判定链路：
 *   1. 普通内容标识：完整复用 Worker 的 identity 模块，手机 FIT 与历史 FIT 的
 *      activityId / sha256 相同即同一活动（WorkOutDoors 重导出也能归一到一起）。
 *   2. Strava 改写核验：Strava 会把 WorkOutDoors 原件改头后再提供下载
 *      （FILE_ID.manufacturer=development→strava、补 product、creator 的
 *      manufacturer 一并改写），并在 11 条 record 的 distance 上加 24 个原始
 *      单位（0.24m），其余消息与字段完全一致，普通 identity 会退回 file 模式。
 *      对这种来源，仅在「强候选 + 逐条 distance 差 ≤ 0.25m + 其他消息与字段
 *      全相同」时才判定同一活动。绝不按时间、距离大概相等静默合并。
 *
 * 隐私：本模块只处理已在内存中的字节与摘要；不打印内容，不写日志。
 */

import type { SportKind } from '../../src/types/strava'
import type { ArchivedOriginal } from './r2-archive'
import { createHash } from 'node:crypto'
import { Decoder, Profile, Stream } from '@garmin/fitsdk'
import { canonicalValue } from '../../workers/workout-upload/src/identity.mjs'

/** distance 在 FIT 里的原始单位是 1/100 米，0.25m = 25 */
const maxDistanceDeltaRaw = 25
/** 候选预筛：开始时间差上限（秒） */
export const candidateStartToleranceSeconds = 120

const decodeOptions = {
  includeUnknownData: true,
  convertDateTimesToDates: false,
  convertTypesToStrings: true,
  applyScaleAndOffset: false,
  expandSubFields: false,
  expandComponents: false,
  mergeHeartRates: false,
  decodeMemoGlobs: false,
} as const

/** Strava 改写允许变化的 FILE_ID 字段 */
const fileIdRewrittenFields = new Set(['manufacturer', 'product', 'productName', 'timeCreated', 'serialNumber'])
/** Strava 改写允许变化的 creator device_info 字段 */
const creatorRewrittenFields = new Set(['manufacturer', 'product', 'productName', 'serialNumber', 'timestamp'])
/** record 的 distance 单独做 0.25m 容差核验，不参与其他字段的严格比较 */
const recordDistanceField = 'distance'

function omitFields(message: Record<string, unknown>, dropped: Set<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(message)) {
    if (!dropped.has(key)) {
      result[key] = value
    }
  }

  return result
}

interface WodMessage {
  number: number
  /** 归一化后的字段摘要（distance 已剔除） */
  canonical: string
  distanceRaw: number | null
}

interface DecodedWod {
  messages: WodMessage[]
  fileIdManufacturer: string | null
  fileIdProductName: string | null
  fileIdType: string | null
  creatorManufacturer: string | null
  hasSession: boolean
  recordCount: number
  distanceCount: number
  distanceSumRaw: number
}

function asMessage(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function readString(message: Record<string, unknown>, field: string): string | null {
  const value = message[field]
  return typeof value === 'string' ? value : null
}

/**
 * 解码并归一化一条 FIT。任何无法无损表达或解码出错的情况都返回 null，
 * 走保守分支（不做严格合并），不会把未知值当成相等。
 */
function decodeWod(bytes: Uint8Array): DecodedWod | null {
  const decoded: DecodedWod = {
    messages: [],
    fileIdManufacturer: null,
    fileIdProductName: null,
    fileIdType: null,
    creatorManufacturer: null,
    hasSession: false,
    recordCount: 0,
    distanceCount: 0,
    distanceSumRaw: 0,
  }

  try {
    const result = new Decoder(Stream.fromByteArray(bytes)).read({
      ...decodeOptions,
      mesgListener(number, rawMessage) {
        const message = asMessage(rawMessage)
        if (!message) {
          throw new Error('not a plain message')
        }

        if (number === Profile.MesgNum.FILE_ID) {
          decoded.fileIdManufacturer = readString(message, 'manufacturer')
          decoded.fileIdProductName = readString(message, 'productName')
          decoded.fileIdType = readString(message, 'type')
        }
        else if (number === Profile.MesgNum.DEVICE_INFO && message.deviceIndex === 'creator') {
          decoded.creatorManufacturer = readString(message, 'manufacturer')
        }
        else if (number === Profile.MesgNum.SESSION) {
          decoded.hasSession = true
        }

        let normalized = message
        if (number === Profile.MesgNum.FILE_ID) {
          normalized = omitFields(message, fileIdRewrittenFields)
        }
        else if (number === Profile.MesgNum.DEVICE_INFO && message.deviceIndex === 'creator') {
          normalized = omitFields(message, creatorRewrittenFields)
        }
        else if (number === Profile.MesgNum.RECORD) {
          normalized = omitFields(message, new Set([recordDistanceField]))
          decoded.recordCount++
        }

        let distanceRaw: number | null = null
        if (number === Profile.MesgNum.RECORD) {
          const distance = message[recordDistanceField]
          distanceRaw = typeof distance === 'number' && Number.isFinite(distance) ? distance : null
          if (distanceRaw != null) {
            decoded.distanceCount++
            decoded.distanceSumRaw += distanceRaw
          }
        }

        decoded.messages.push({ number, canonical: canonicalValue([number, normalized]), distanceRaw })
      },
    })

    if (result.errors.length > 0) {
      return null
    }
  }
  catch {
    return null
  }

  return decoded
}

export interface WodFileSignature {
  /** 归一化消息流（剔除 Strava 改写字段与 record.distance）的 sha256 */
  signature: string
  fileIdManufacturer: string | null
  fileIdProductName: string | null
  fileIdType: string | null
  creatorManufacturer: string | null
  hasSession: boolean
  recordCount: number
  distanceCount: number
  distanceSumRaw: number
}

/** 计算 WorkOutDoors 归一化签名；无法解析时返回 null（调用方保守处理） */
export function computeWodSignature(bytes: Uint8Array): WodFileSignature | null {
  const decoded = decodeWod(bytes)
  if (!decoded || decoded.recordCount === 0 || !decoded.hasSession) {
    return null
  }

  const hash = createHash('sha256')
  for (const message of decoded.messages) {
    hash.update(`${message.number}\0${message.canonical}\n`)
  }

  return {
    signature: hash.digest('hex'),
    fileIdManufacturer: decoded.fileIdManufacturer,
    fileIdProductName: decoded.fileIdProductName,
    fileIdType: decoded.fileIdType,
    creatorManufacturer: decoded.creatorManufacturer,
    hasSession: decoded.hasSession,
    recordCount: decoded.recordCount,
    distanceCount: decoded.distanceCount,
    distanceSumRaw: decoded.distanceSumRaw,
  }
}

function isWorkOutDoorsSide(signature: Pick<WodFileSignature, 'fileIdManufacturer' | 'fileIdProductName' | 'fileIdType' | 'creatorManufacturer' | 'hasSession'>, manufacturer: string): boolean {
  return signature.fileIdManufacturer === manufacturer
    && signature.fileIdProductName === 'WorkOutDoors'
    && signature.fileIdType === 'activity'
    && signature.creatorManufacturer === manufacturer
    && signature.hasSession
}

/**
 * 强候选：一侧是手机里的 WOD 原件，另一侧是 Strava 改写后的 WOD 下载件。
 * 两侧的归一化消息流必须完全一致，distance 总和差值只能来自逐条 ≤0.25m 的改写。
 */
export function isStravaRewrittenWodCandidate(phone: WodFileSignature, history: WodFileSignature): boolean {
  if (!isWorkOutDoorsSide(phone, 'development') || !isWorkOutDoorsSide(history, 'strava')) {
    return false
  }

  return phone.signature === history.signature
    && phone.recordCount === history.recordCount
    && phone.distanceCount === history.distanceCount
    && Math.abs(phone.distanceSumRaw - history.distanceSumRaw) <= maxDistanceDeltaRaw * phone.distanceCount
}

/**
 * 严格核验：两条 FIT 的消息数量、顺序、除允许改写外的字段必须逐条一致，
 * 且每条 record 的 distance 差不超过 0.25m。任一不满足即判定不同活动。
 */
export function verifyStravaRewrittenWod(phoneBytes: Uint8Array, historyBytes: Uint8Array): boolean {
  const phone = decodeWod(phoneBytes)
  const history = decodeWod(historyBytes)
  if (!phone || !history) {
    return false
  }

  if (!isWorkOutDoorsSide(phone, 'development') || !isWorkOutDoorsSide(history, 'strava')) {
    return false
  }

  if (phone.messages.length !== history.messages.length) {
    return false
  }

  for (let index = 0; index < phone.messages.length; index++) {
    const left = phone.messages[index]
    const right = history.messages[index]
    if (left.number !== right.number || left.canonical !== right.canonical) {
      return false
    }

    if (left.number === Profile.MesgNum.RECORD) {
      if (left.distanceRaw == null || right.distanceRaw == null) {
        return false
      }

      if (Math.abs(left.distanceRaw - right.distanceRaw) > maxDistanceDeltaRaw) {
        return false
      }
    }
  }

  return true
}

export interface PhoneDedupRef {
  activityId: string
  sha256: string
  wod: WodFileSignature | null
  /** 展示口径的本地墙上时间 epoch，与历史 start_date_local_raw 同一口径 */
  start: number
  distance: number
  kind: SportKind
}

export interface HistoryDedupCandidate {
  id: number
  start: number
  distance: number
  kind: SportKind
  original: ArchivedOriginal
}

export interface HistoryFitIdentity {
  sourceSha256: string
  activityId: string | null
  sha256: string | null
  wod: WodFileSignature | null
}

/** 候选预筛只用来决定是否值得下载原件核验，不构成同一活动判定 */
export function findHistoryCandidates(phone: Pick<PhoneDedupRef, 'start' | 'distance' | 'kind'>, history: HistoryDedupCandidate[]): HistoryDedupCandidate[] {
  return history.filter(candidate =>
    candidate.kind === phone.kind
    && candidate.original.status === 'stored'
    && Math.abs(candidate.start - phone.start) <= candidateStartToleranceSeconds
    && distanceNear(candidate.distance, phone.distance),
  )
}

function distanceNear(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(200, Math.max(Math.abs(left), Math.abs(right)) * 0.02)
}

export function historyIdentityMatches(phone: Pick<PhoneDedupRef, 'activityId' | 'sha256'>, identity: Pick<HistoryFitIdentity, 'activityId' | 'sha256'>): boolean {
  return (identity.activityId != null && identity.activityId === phone.activityId)
    || (identity.sha256 != null && identity.sha256 === phone.sha256)
}

export interface PhoneDedupResolvers {
  /** 解析历史 FIT 的内容标识（可缓存；必要时下载原件） */
  historyIdentity: (candidate: HistoryDedupCandidate) => Promise<HistoryFitIdentity>
  /** 读取历史 FIT 原始字节，仅严格核验需要 */
  historyBytes: (candidate: HistoryDedupCandidate) => Promise<Uint8Array>
  /** 读取手机 FIT 原始字节，仅严格核验需要 */
  phoneBytes: () => Promise<Uint8Array>
}

export type PhoneDedupResult
  = | { matched: false }
    | { matched: true, historyId: number, mode: 'identity' | 'strava-rewrite' }

/**
 * 判定手机活动是否与某条公开历史是同一活动。
 * 非 FIT 历史（GPX/TCX）没有可核验的内容标识，只在 sha256 完全一致时才抑制。
 */
export async function decidePhoneDedup(
  phone: PhoneDedupRef,
  candidates: HistoryDedupCandidate[],
  resolvers: PhoneDedupResolvers,
): Promise<PhoneDedupResult> {
  for (const candidate of candidates) {
    if (candidate.original.sha256 != null && candidate.original.sha256 === phone.sha256) {
      return { matched: true, historyId: candidate.id, mode: 'identity' }
    }

    if (candidate.original.format !== 'fit' || !candidate.original.key) {
      continue
    }

    const identity = await resolvers.historyIdentity(candidate)
    if (historyIdentityMatches(phone, identity)) {
      return { matched: true, historyId: candidate.id, mode: 'identity' }
    }

    if (!phone.wod || !identity.wod || !isStravaRewrittenWodCandidate(phone.wod, identity.wod)) {
      continue
    }

    const phoneBytes = await resolvers.phoneBytes()
    const historyBytes = await resolvers.historyBytes(candidate)
    if (verifyStravaRewrittenWod(phoneBytes, historyBytes)) {
      return { matched: true, historyId: candidate.id, mode: 'strava-rewrite' }
    }
  }

  return { matched: false }
}
