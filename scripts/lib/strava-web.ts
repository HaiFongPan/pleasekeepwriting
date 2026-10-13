/**
 * 网页登录态数据源（非官方接口）。
 *
 * 为什么不用官方 API：账号上的 API 应用处于 Inactive（Strava 2025 年后的
 * 开发者计划要求持有该应用的账号有订阅），所有业务接口返回
 * 403 {"resource":"Application","field":"Status","code":"Inactive"}，
 * 而 OAuth 换 token 仍能成功——所以这条路走不通。
 *
 * 本模块用浏览器登录态（_strava4_session）访问站点自己的接口：
 *   - 列表/元数据：GET /athlete/training_activities?page=N（固定 20 条/页）
 *   - 轨迹：GET /api/v3/activities/{id}/streams?keys=latlng（lng/lat 数组，约 120KB）
 *   - 卡路里：GET /activities/{id}/export_original（原始 FIT，约 85KB，
 *     取 session.total_calories 或 lap.total_calories 累加）
 *
 * 注意：cookie 权限等同于账号登录态，请求保持低频；接口随时可能变更，
 * 变更时只需改本文件。
 */

import type { FitSummary } from './fit'
import process from 'node:process'
import { loadDotEnv } from './env'
import { readFitSummary } from './fit'

const webBase = 'https://www.strava.com'
/** 训练日志接口固定返回 20 条/页，per_page 参数无效 */
export const trainingPageSize = 20
/** 非官方接口，主动放慢，避免给服务器和账号带来风险 */
const requestDelayMs = Number.parseInt(process.env.STRAVA_WEB_DELAY_MS ?? '400', 10)

export class StravaSessionExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StravaSessionExpiredError'
  }
}

/** 训练日志接口返回的单条活动 */
export interface TrainingActivity {
  id: number
  name: string | null
  /** Strava sport_type，例如 Ride / Run / Hike */
  sport_type: string
  /** 本地化显示名，例如 骑行 / 跑步 */
  display_type: string
  /** 本地时间，形如 2026-10-11 17:32:05 UTC+8 */
  start_date: string
  start_date_local_raw: number
  /** 米 */
  distance_raw: number
  /** 秒 */
  moving_time_raw: number
  /** 秒 */
  elapsed_time_raw: number
  /** 米 */
  elevation_gain_raw: number | null
  /** 是否有 GPS 轨迹，用来决定是否拉 streams */
  has_latlng: boolean
  private: boolean
  visibility: string | null
}

export interface TrainingActivitiesPage {
  models: TrainingActivity[]
  page: number
  perPage: number
  total: number
}

function getCookie(): string | undefined {
  return process.env.STRAVA_COOKIE_STRAVA4_SESSION?.trim() || undefined
}

/** 读取本地 .env 并确认 cookie 存在 */
export function requireCookie(): string {
  loadDotEnv()
  const cookie = getCookie()
  if (!cookie) {
    throw new Error('缺少 STRAVA_COOKIE_STRAVA4_SESSION。请在 .env 或环境变量里配置浏览器登录态 cookie。')
  }

  return cookie
}

function webHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const cookie = getCookie()
  const headers: Record<string, string> = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': `${webBase}/athlete/training`,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest',
    ...extra,
  }

  if (cookie) {
    headers.Cookie = `_strava4_session=${cookie}`
  }

  return headers
}

async function sleep(ms: number) {
  if (ms > 0) {
    await new Promise(resolve => setTimeout(resolve, ms))
  }
}

/** 登录态失效时 Strava 会跳登录页或返回 401，统一抛出可读错误 */
function assertAuthenticated(response: Response, what: string, bodyStart: string) {
  if (response.status === 401 || response.status === 403) {
    throw new StravaSessionExpiredError(`${what} 被拒绝（HTTP ${response.status}）。cookie 可能已过期，请重新从浏览器获取 _strava4_session。`)
  }

  if (response.status === 302 || (bodyStart.includes('<html') && bodyStart.includes('login'))) {
    throw new StravaSessionExpiredError(`${what} 被重定向到登录页。cookie 已失效，请重新获取。`)
  }

  if (!response.ok) {
    throw new Error(`${what} 请求失败（HTTP ${response.status}）。`)
  }
}

/** 训练日志：按页拉取活动元数据，倒序 */
export async function fetchTrainingActivities(page: number): Promise<TrainingActivitiesPage> {
  const response = await fetch(`${webBase}/athlete/training_activities?keywords=&activity_type=&workout_type=&commute=&private_activities=&gear=&new_activity_only=false&page=${page}&per_page=${trainingPageSize}&order=`, {
    headers: webHeaders(),
  })
  const text = await response.text()
  assertAuthenticated(response, `训练日志第 ${page} 页`, text.slice(0, 400))

  let payload: TrainingActivitiesPage
  try {
    payload = JSON.parse(text) as TrainingActivitiesPage
  }
  catch {
    throw new StravaSessionExpiredError(`训练日志第 ${page} 页返回的不是 JSON（可能被重定向到登录页）。请重新获取 cookie。`)
  }

  await sleep(requestDelayMs)
  return { ...payload, models: payload.models ?? [] }
}

/** 轨迹流：返回 latlng（[lat, lng] 数组）与可选的距离/时间流 */
export async function fetchStreams(activityId: number): Promise<{ latlng: Array<[number, number]>, time: number[] | null, distance: number[] | null, altitude: number[] | null }> {
  const keys = 'latlng,time,distance,altitude'
  const response = await fetch(`${webBase}/api/v3/activities/${activityId}/streams?keys=${keys}&key_by_type=true`, {
    headers: webHeaders(),
  })
  const text = await response.text()
  if (response.status === 404) {
    await sleep(requestDelayMs)
    return { latlng: [], time: null, distance: null, altitude: null }
  }

  assertAuthenticated(response, `活动 ${activityId} 的 streams`, text.slice(0, 400))

  const payload = JSON.parse(text) as Record<string, { data?: unknown[] } | undefined>
  const latlng = (payload.latlng?.data ?? []) as Array<[number, number]>
  await sleep(requestDelayMs)

  return {
    latlng,
    time: (payload.time?.data ?? null) as number[] | null,
    distance: (payload.distance?.data ?? null) as number[] | null,
    altitude: (payload.altitude?.data ?? null) as number[] | null,
  }
}

/**
 * 原始文件（FIT）里的汇总。
 * 不是 FIT（例如 GPX 上传）时只有轨迹，没有卡路里，返回 null。
 */
export async function fetchOriginalFitSummary(activityId: number): Promise<{ summary: FitSummary | null, bytes: number }> {
  const response = await fetch(`${webBase}/activities/${activityId}/export_original`, {
    headers: webHeaders({ Accept: 'application/octet-stream' }),
  })

  if (response.status === 404) {
    await sleep(requestDelayMs)
    return { summary: null, bytes: 0 }
  }

  const buffer = new Uint8Array(await response.arrayBuffer())
  assertAuthenticated(response, `活动 ${activityId} 的原始文件`, '')
  await sleep(requestDelayMs)

  return { summary: readFitSummary(buffer), bytes: buffer.length }
}
