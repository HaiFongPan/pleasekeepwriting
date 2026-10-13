/**
 * Strava API 访问层：token 刷新、限流感知请求、分页。
 *
 * 凭据只从进程环境（或本地 .env）读取，不写入日志、不落盘到仓库。
 * 参考：https://developers.strava.com/docs/reference/
 */

import type { StravaAthlete, StravaDetailedActivity, StravaSummaryActivity } from '../../src/types/strava'
import process from 'node:process'

/** 注意：Strava 计划在 2027-01-04 把 API base URL 迁到 api-v3.strava.com */
export const stravaApiBase = 'https://www.strava.com/api/v3'
export const stravaOauthUrl = 'https://www.strava.com/oauth/token'

/** 非上传类接口的默认限额 */
export const defaultRateLimit = { shortLimit: 100, dailyLimit: 1000 }

/** 列表接口单页上限 */
export const maxPerPage = 200

export interface StravaCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export interface StravaTokens {
  accessToken: string
  /** Strava 可能轮换 refresh token，调用方必须持久化最新值 */
  refreshToken: string
  expiresAt: number
  scope: string | null
  rotated: boolean
}

export interface RateLimit {
  shortUsage: number
  shortLimit: number
  dailyUsage: number
  dailyLimit: number
}

export class StravaRateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StravaRateLimitError'
  }
}

/** 解析 X-Ratelimit-Usage / X-Ratelimit-Limit，格式为 "15分钟用量,日用量" */
export function parseRateLimit(headers: Headers): RateLimit | null {
  const usage = headers.get('x-ratelimit-usage')
  const limit = headers.get('x-ratelimit-limit')
  if (!usage) {
    return null
  }

  const [shortUsage, dailyUsage] = usage.split(',').map(value => Number.parseInt(value, 10))
  const [shortLimit, dailyLimit] = (limit ?? '').split(',').map(value => Number.parseInt(value, 10))

  return {
    shortUsage: Number.isFinite(shortUsage) ? shortUsage : 0,
    shortLimit: Number.isFinite(shortLimit) ? shortLimit : defaultRateLimit.shortLimit,
    dailyUsage: Number.isFinite(dailyUsage) ? dailyUsage : 0,
    dailyLimit: Number.isFinite(dailyLimit) ? dailyLimit : defaultRateLimit.dailyLimit,
  }
}

/** 用 refresh token 换 access token */
export async function refreshAccessToken(credentials: StravaCredentials): Promise<StravaTokens> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
  })

  const response = await fetch(stravaOauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`换取 access token 失败（HTTP ${response.status}）：${detail.slice(0, 300)}`)
  }

  const payload = await response.json() as {
    access_token?: string
    refresh_token?: string
    expires_at?: number
    scope?: string
  }

  if (!payload.access_token) {
    throw new Error('Strava 未返回 access_token。')
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? credentials.refreshToken,
    expiresAt: payload.expires_at ?? 0,
    scope: payload.scope ?? null,
    rotated: Boolean(payload.refresh_token) && payload.refresh_token !== credentials.refreshToken,
  }
}

/** 带限流信息的 GET 请求 */
export async function stravaGet<T>(
  accessToken: string,
  apiPath: string,
  params: Record<string, string | number | undefined> = {},
): Promise<{ data: T, rateLimit: RateLimit | null }> {
  const url = new URL(`${stravaApiBase}${apiPath}`)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value))
    }
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const rateLimit = parseRateLimit(response.headers)

  if (response.status === 429) {
    throw new StravaRateLimitError(`Strava 返回 429，${apiPath} 请求被限流。usage=${rateLimit ? `${rateLimit.shortUsage}/${rateLimit.shortLimit},${rateLimit.dailyUsage}/${rateLimit.dailyLimit}` : 'unknown'}`)
  }

  if (!response.ok) {
    throw new Error(`Strava 请求失败（HTTP ${response.status}）：${apiPath}`)
  }

  return { data: await response.json() as T, rateLimit }
}

/** 获取当前授权运动员 */
export async function getAthlete(accessToken: string) {
  return stravaGet<StravaAthlete>(accessToken, '/athlete')
}

/** 分页获取活动列表，按时间倒序 */
export async function listActivities(
  accessToken: string,
  options: { page?: number, after?: number, before?: number, perPage?: number } = {},
) {
  return stravaGet<StravaSummaryActivity[]>(accessToken, '/athlete/activities', {
    page: options.page ?? 1,
    per_page: Math.min(options.perPage ?? maxPerPage, maxPerPage),
    after: options.after,
    before: options.before,
  })
}

/** 获取活动详情，唯一能拿到 calories 的接口 */
export async function getActivityDetail(accessToken: string, activityId: number) {
  return stravaGet<StravaDetailedActivity>(accessToken, `/activities/${activityId}`)
}

/**
 * 短期限额用尽时等到下一个 15 分钟窗口。
 * Strava 的短期限额按自然刻（0/15/30/45 分）重置。
 */
export async function waitForShortWindow(rateLimit: RateLimit, reserve = 5): Promise<number> {
  if (rateLimit.shortUsage < rateLimit.shortLimit - reserve) {
    return 0
  }

  const now = new Date()
  const next = new Date(now)
  next.setMinutes(Math.floor(now.getMinutes() / 15) * 15 + 15, 0, 0)
  const waitMs = next.getTime() - now.getTime() + 2000

  await new Promise(resolve => setTimeout(resolve, waitMs))
  return waitMs
}

/** 从进程环境读取凭据 */
export function getCredentials(): StravaCredentials {
  const clientId = process.env.STRAVA_CLIENT_ID?.trim()
  const clientSecret = process.env.STRAVA_CLIENT_SECRET?.trim()
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN?.trim()

  const missing = [
    ['STRAVA_CLIENT_ID', clientId],
    ['STRAVA_CLIENT_SECRET', clientSecret],
    ['STRAVA_REFRESH_TOKEN', refreshToken],
  ].filter(([, value]) => !value).map(([name]) => name)

  if (missing.length > 0) {
    throw new Error(`缺少凭据：${missing.join(', ')}。请在项目外设置环境变量，或写入本地 .env（已 gitignore）。`)
  }

  return {
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    refreshToken: refreshToken as string,
  }
}
