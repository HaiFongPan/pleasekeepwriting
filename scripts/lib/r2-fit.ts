/**
 * 手机 FIT 上传（对象前缀 activities/v1/）的解析。
 *
 * 单位与时间：
 *   - @garmin/fitsdk 默认应用 scale/offset，距离为米、时长为秒、卡路里为千卡；
 *   - FIT 的 position_lat/long 是半圆单位（semicircles），这里显式换算成度；
 *   - FIT 时间戳是 UTC，展示口径统一换算成配置时区（默认 Asia/Shanghai）的
 *     「本地墙上时间当 UTC」epoch，与 Strava start_date_local_raw 一致；
 *   - 室内活动（跑步机、力量训练等）没有 GPS 点，不生成轨迹。
 *
 * 去重标识直接复用 Worker 的完整 identity 模块（内容归一后的 activityId），
 * 这样手机上传和历史归档里的同一份 WorkOutDoors 运动能对上。
 */

import type { RecordMesg, SessionMesg } from '@garmin/fitsdk'
import type { SportKind } from '../../src/types/strava'
import process from 'node:process'
import { Decoder, Stream } from '@garmin/fitsdk'
import { resolveSportKind } from '../../src/utils/sport'
import { identifyFit, InvalidFitError } from '../../workers/workout-upload/src/identity.mjs'
import { readFitSummary } from './fit'
import { haversineMeters } from './strava-track'

export const defaultDisplayTimeZone = 'Asia/Shanghai'
/** FIT position_lat/long 半圆单位换算成度 */
const semicircleToDegrees = 180 / 2 ** 31

export class PhoneFitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhoneFitError'
  }
}

export interface FitIdentity {
  sha256: string
  activityId: string
  dedupMode: string
  identityVersion: string
}

/** 与 Worker 完全一致的内容标识；FIT 损坏时抛出 PhoneFitError */
export function identifyFitFile(bytes: Uint8Array): FitIdentity {
  try {
    return identifyFit(bytes) as FitIdentity
  }
  catch (error) {
    if (error instanceof InvalidFitError) {
      throw new PhoneFitError('FIT 文件不完整或无法解析')
    }

    throw error
  }
}

export function resolveDisplayTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  return env.R2_SYNC_TIMEZONE?.trim() || defaultDisplayTimeZone
}

/**
 * UTC 瞬间 -> 指定时区的本地墙上时间 epoch（本地 09:00 读作 UTC 09:00）。
 * 展示层用 UTC getter 读取，避免再次时区换算。
 */
export function zonedWallClockEpoch(date: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(date)
  }
  catch {
    throw new PhoneFitError(`无效的展示时区：${timeZone}`)
  }

  const values = new Map(parts.map(part => [part.type, part.value]))
  const year = Number(values.get('year'))
  const month = Number(values.get('month'))
  const day = Number(values.get('day'))
  const hour = Number(values.get('hour'))
  const minute = Number(values.get('minute'))
  const second = Number(values.get('second'))
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) {
    throw new PhoneFitError(`无法在时区 ${timeZone} 下解析运动开始时间`)
  }

  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000
}

export interface FitSessionSummary {
  sportType: string
  displayType: string
  kind: SportKind
  /** UTC 开始时间 */
  start: Date
  distanceMeters: number | null
  /** 设备 total_timer_time（秒），不是 Strava movingTime */
  timerSeconds: number | null
  /** 设备 total_elapsed_time（秒） */
  elapsedSeconds: number | null
  calories: number | null
  elevationGainMeters: number | null
}

export interface FitTrackPoint {
  lat: number
  lng: number
  /** 相对第一个点的秒数 */
  time: number
  /** 米 */
  distance: number
  /** 米 */
  altitude: number | null
}

export interface PhoneFitData {
  identity: FitIdentity
  /** 没有 session 的 FIT 无法生成展示记录（Worker 允许归档，消费端跳过） */
  session: FitSessionSummary | null
  points: FitTrackPoint[]
  hasGps: boolean
}

const fitSportTypes: Record<string, string> = {
  cycling: 'Ride',
  running: 'Run',
  hiking: 'Hike',
  walking: 'Walk',
  swimming: 'Swim',
  training: 'Workout',
}

const fitDisplayTypes: Record<string, string> = {
  Ride: '骑行',
  Run: '跑步',
  Hike: '远足',
  Walk: '健走',
  Swim: '游泳',
  Workout: '训练',
}

function prettifySport(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

/** FIT sport 映射到 Strava 风格的 sport_type / 本地化显示名 / 站点分组 */
export function mapFitSport(sport: string | undefined): { sportType: string, displayType: string, kind: SportKind } {
  const normalized = (sport ?? '').trim().toLowerCase()
  const sportType = fitSportTypes[normalized] ?? (normalized ? prettifySport(normalized) : 'Workout')
  return {
    sportType,
    displayType: fitDisplayTypes[sportType] ?? (normalized ? prettifySport(normalized) : '训练'),
    kind: resolveSportKind(sportType),
  }
}

/** FIT 时间戳：@garmin/fitsdk 的 DateTime 类型（含 "min" 哨兵） */
type FitDateTime = number | Date | 'min'

function toDate(value: FitDateTime | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value)
  }

  return null
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function decodePhoneFitMessages(bytes: Uint8Array) {
  try {
    const result = new Decoder(Stream.fromByteArray(bytes)).read({
      applyScaleAndOffset: true,
      convertDateTimesToDates: true,
      convertTypesToStrings: true,
      expandSubFields: false,
      expandComponents: false,
      mergeHeartRates: false,
      decodeMemoGlobs: false,
    })

    if (result.errors.length > 0) {
      throw new PhoneFitError('FIT 文件解码出错')
    }

    return result.messages
  }
  catch (error) {
    if (error instanceof PhoneFitError) {
      throw error
    }

    throw new PhoneFitError('FIT 文件无法解析')
  }
}

function positionToDegrees(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  const degrees = value * semicircleToDegrees
  return degrees >= -180 && degrees <= 180 ? degrees : null
}

/** 从 record 消息提取 GPS 点；没有位置的室内活动返回空数组 */
export function parseFitTrack(messages: { recordMesgs?: RecordMesg[] }): { points: FitTrackPoint[], hasGps: boolean } {
  const rawPoints: Array<{ lat: number, lng: number, timeMs: number, distance: number | null, altitude: number | null }> = []

  for (const record of messages.recordMesgs ?? []) {
    const lat = positionToDegrees(record.positionLat)
    const lng = positionToDegrees(record.positionLong)
    const timestamp = toDate(record.timestamp)
    if (lat == null || lng == null || !timestamp) {
      continue
    }

    rawPoints.push({
      lat,
      lng,
      timeMs: timestamp.getTime(),
      distance: finiteOrNull(record.distance),
      altitude: finiteOrNull(record.enhancedAltitude) ?? finiteOrNull(record.altitude),
    })
  }

  if (rawPoints.length === 0) {
    return { points: [], hasGps: false }
  }

  const firstMs = rawPoints[0].timeMs
  // 设备距离流完整时按设备口径，否则按坐标累计球面距离，保证 time/distance 对齐
  const useDeviceDistance = rawPoints.every(point => point.distance != null)
  const points: FitTrackPoint[] = []

  for (let index = 0; index < rawPoints.length; index++) {
    const point = rawPoints[index]
    let distance = 0
    if (index > 0) {
      const previous = points[index - 1]
      distance = useDeviceDistance
        ? point.distance ?? previous.distance
        : previous.distance + haversineMeters(previous, point)
    }

    points.push({
      lat: point.lat,
      lng: point.lng,
      time: (point.timeMs - firstMs) / 1000,
      distance,
      altitude: point.altitude,
    })
  }

  return { points, hasGps: true }
}

function pickSession(messages: { sessionMesgs?: SessionMesg[] }): SessionMesg | null {
  for (const session of messages.sessionMesgs ?? []) {
    if (toDate(session.startTime)) {
      return session
    }
  }

  return null
}

function summarizeSession(session: SessionMesg, bytes: Uint8Array): FitSessionSummary {
  const start = toDate(session.startTime)
  if (!start) {
    throw new PhoneFitError('FIT session 缺少开始时间')
  }

  const sport = mapFitSport(typeof session.sport === 'string' ? session.sport : undefined)
  return {
    ...sport,
    start,
    distanceMeters: finiteOrNull(session.totalDistance),
    timerSeconds: finiteOrNull(session.totalTimerTime),
    elapsedSeconds: finiteOrNull(session.totalElapsedTime),
    // 设备口径优先，缺省回退到旧解析器的 lap 累加
    calories: finiteOrNull(session.totalCalories) ?? readFitSummary(bytes)?.totalCalories ?? null,
    elevationGainMeters: finiteOrNull(session.totalAscent),
  }
}

/**
 * 解析一个手机归档 FIT：identity（去重）+ session（展示元信息）+ GPS 点。
 * 归档对象必须是 FIT；损坏时抛错，不产出半条记录。
 */
export function readPhoneFit(bytes: Uint8Array): PhoneFitData {
  const identity = identifyFitFile(bytes)
  const messages = decodePhoneFitMessages(bytes)
  const session = pickSession(messages)
  const track = parseFitTrack(messages)

  return {
    identity,
    session: session ? summarizeSession(session, bytes) : null,
    points: track.points,
    hasGps: track.hasGps,
  }
}
