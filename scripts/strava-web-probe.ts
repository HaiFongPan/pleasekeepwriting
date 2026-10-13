/**
 * 网页登录态（非官方 API）探测：确认哪条路能拿到
 * 日期 / 类型 / 距离 / 时长 / 卡路里 / 轨迹，只读、低频。
 *
 * 用法：pnpm strava-web-probe
 * 前置：.env 里配置 STRAVA_COOKIE_STRAVA4_SESSION（可选 STRAVA_WEB_JWT）。
 *
 * 结论只打印状态码、字段名和少量标量值，不打印 cookie 与完整响应体。
 */

import process from 'node:process'
import { loadDotEnv } from './lib/env'
import { describeFitMessages, readFitSummary } from './lib/fit'

const webBase = 'https://www.strava.com'

// 必须延迟读取：loadDotEnv() 在 main() 里才执行，模块顶层的常量会早于它求值
function getCookie(): string | undefined {
  return process.env.STRAVA_COOKIE_STRAVA4_SESSION?.trim() || undefined
}

function getJwt(): string | undefined {
  return process.env.STRAVA_WEB_JWT?.trim() || undefined
}

function webHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const cookie = getCookie()
  const jwt = getJwt()
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

  if (jwt) {
    headers.Authorization = `Bearer ${jwt}`
  }

  return headers
}

interface ProbeResult {
  status: number
  contentType: string | null
  length: number
  text: string
}

async function probe(name: string, path: string, extraHeaders: Record<string, string> = {}): Promise<ProbeResult | null> {
  const url = path.startsWith('http') ? path : `${webBase}${path}`
  const response = await fetch(url, { headers: webHeaders(extraHeaders) })
  const text = await response.text()
  const contentType = response.headers.get('content-type')
  console.log(`${name}\n  ${path}\n  -> HTTP ${response.status} ${response.statusText} | ${contentType} | ${text.length} bytes`)

  if (!response.ok) {
    console.log(`  响应片段：${text.slice(0, 160).replace(/\s+/g, ' ')}`)
    return null
  }

  return { status: response.status, contentType, length: text.length, text }
}

/** 只打印字段名与标量值，避免把整份响应灌进终端 */
function summarizeKeys(value: unknown, depth = 0, prefix = ''): string[] {
  if (depth > 1 || value === null || typeof value !== 'object') {
    return []
  }

  const lines: string[] = []
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(item)) {
      lines.push(`${path}: array(${item.length})`)
      if (item.length > 0 && depth === 0) {
        const first = item[0]
        const firstKeys = first && typeof first === 'object' ? Object.keys(first as object).join(',') : typeof first
        lines.push(`  ${path}[0] 字段：${firstKeys}`)
      }
    }
    else if (item && typeof item === 'object') {
      lines.push(...summarizeKeys(item, depth + 1, path))
    }
    else {
      const rendered = typeof item === 'string' && item.length > 48 ? `${item.slice(0, 48)}…` : String(item)
      lines.push(`${path} = ${rendered}`)
    }
  }

  return lines
}

function pickRecord(payload: unknown): Record<string, unknown> | null {
  if (Array.isArray(payload) && payload.length > 0 && typeof payload[0] === 'object') {
    return payload[0] as Record<string, unknown>
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['models', 'activities', 'data', 'results']) {
      const candidate = record[key]
      if (Array.isArray(candidate) && candidate.length > 0 && typeof candidate[0] === 'object') {
        console.log(`  （数组在 ${key} 字段下，共 ${candidate.length} 条）`)
        return candidate[0] as Record<string, unknown>
      }
    }
  }

  return null
}

function reportRecord(label: string, record: Record<string, unknown> | null) {
  if (!record) {
    console.log(`  ${label}：没有可用记录`)
    return
  }

  console.log(`  ${label} 字段与示例值：`)
  for (const line of summarizeKeys(record)) {
    console.log(`    ${line}`)
  }
}

async function main() {
  loadDotEnv()
  const jwt = getJwt()
  if (!getCookie() && !jwt) {
    throw new Error('缺少凭据：请在 .env 配置 STRAVA_COOKIE_STRAVA4_SESSION 或 STRAVA_WEB_JWT。')
  }

  const cookie = getCookie()
  console.log(`凭据：cookie=${cookie ? `有(${cookie.length}字符)` : '无'} jwt=${jwt ? `有(${jwt.length}字符)` : '无'}\n`)

  let activityId: number | null = null
  let sawPolylineField = false

  // A. 官方 REST 形态，看登录态能否直接授权 /api/v3
  console.log('=== A. /api/v3/athlete/activities（登录态是否等同 API 授权） ===')
  const apiList = await probe('A', '/api/v3/athlete/activities?per_page=5')
  if (apiList) {
    try {
      const payload = JSON.parse(apiList.text)
      const record = pickRecord(payload)
      reportRecord('A', record)
      if (record) {
        activityId = Number(record.id) || null
        sawPolylineField = 'map' in record
      }
    }
    catch {
      console.log('  响应不是 JSON')
    }
  }

  // B. 网页训练日志内部接口：不依赖 API 应用
  console.log('\n=== B. /athlete/training_activities（网页训练日志） ===')
  const training = await probe('B', '/athlete/training_activities?keywords=&activity_type=&workout_type=&commute=&private_activities=&gear=&new_activity_only=false&page=1&per_page=100&order=')
  if (training) {
    try {
      const payload = JSON.parse(training.text)
      const record = pickRecord(payload)
      reportRecord('B', record)
      const meta = payload as { page?: number, perPage?: number, total?: number }
      console.log(`  分页信息：page=${meta.page} perPage=${meta.perPage} total=${meta.total}`)
      if (record) {
        activityId = activityId ?? (Number(record.id) || null)
        sawPolylineField = sawPolylineField || 'map' in record || 'polyline' in record
        console.log(`  B 全部字段（一行）：${Object.keys(record).sort().join(',')}`)
        const keys = Object.keys(record)
        console.log(`  关键字段自查：日期=${keys.filter(k => /date|time/.test(k)).join('/')} 类型=${keys.filter(k => /type/.test(k)).join('/')} 距离=${keys.filter(k => /distance/.test(k)).join('/')} 卡路里=${keys.filter(k => /calorie/i.test(k)).join('/') || '无'}`)
      }
    }
    catch {
      console.log('  响应不是 JSON')
    }
  }

  // C. GraphQL（只有提供 JWT 时才试）
  if (jwt) {
    console.log('\n=== C. POST /graphql（JWT） ===')
    const response = await fetch(`${webBase}/graphql`, {
      method: 'POST',
      headers: webHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        query: `query { athleteActivities(first: 3) { edges { node { id name startDate distance movingTime elapsedTime type calories { __typename } } } } }`,
      }),
    })
    const text = await response.text()
    console.log(`  -> HTTP ${response.status} | ${text.length} bytes | 片段：${text.slice(0, 300).replace(/\s+/g, ' ')}`)
  }

  if (!activityId) {
    console.log('\n没有拿到活动 id，跳过详情 / 轨迹探测。')
    return
  }

  console.log(`\n用活动 id=${activityId} 继续探测卡路里与轨迹`)

  // D. 卡路里
  console.log('\n=== D. /api/v3/activities/{id}（calories） ===')
  const detail = await probe('D', `/api/v3/activities/${activityId}`)
  if (detail) {
    try {
      const record = JSON.parse(detail.text) as Record<string, unknown>
      console.log(`  calories = ${String(record.calories)} | kilojoules = ${String(record.kilojoules)} | sport_type = ${String(record.sport_type)} | 城市字段 = ${String(record.location_city)}`)
      console.log(`  map.summary_polyline 长度 = ${String((record.map as { summary_polyline?: string } | undefined)?.summary_polyline?.length ?? 0)}`)
    }
    catch {
      console.log('  响应不是 JSON')
    }
  }

  // E. 轨迹：streams
  console.log('\n=== E. /api/v3/activities/{id}/streams ===')
  const streams = await probe('E', `/api/v3/activities/${activityId}/streams?keys=latlng,time&key_by_type=true`)
  if (streams) {
    try {
      const payload = JSON.parse(streams.text) as Record<string, unknown>
      console.log(`  streams 字段：${Object.keys(payload).join(', ')}`)
      const latlng = payload.latlng as { data?: unknown[] } | undefined
      console.log(`  latlng 点数：${latlng?.data?.length ?? 0}`)
    }
    catch {
      console.log('  响应不是 JSON')
    }
  }

  // F. 轨迹：网页 GPX 导出
  console.log('\n=== F. /activities/{id}/export_gpx（网页导出） ===')
  const gpx = await probe('F', `/activities/${activityId}/export_gpx`)
  if (gpx) {
    const trackPoints = (gpx.text.match(/<trkpt/g) ?? []).length
    console.log(`  GPX 轨迹点数：${trackPoints}，开头：${gpx.text.slice(0, 120).replace(/\s+/g, ' ')}`)
  }

  // G. 活动页 HTML 里是否有卡路里（训练日志接口没有 calories）
  console.log('\n=== G. /activities/{id}（活动页 HTML 里的卡路里） ===')
  const activityPage = await probe('G', `/activities/${activityId}`, { Accept: 'text/html,application/xhtml+xml' })
  if (activityPage) {
    const patterns = [
      /"calories"\s*:\s*[\d.]+/gi,
      /calories["'\s:=]{1,12}[\d,]+/gi,
      /\bCalories\b[\s\S]{0,160}?([\d,]{2,6})/gi,
    ]
    for (const pattern of patterns) {
      const matches = [...activityPage.text.matchAll(pattern)].slice(0, 3).map(match => match[0].replace(/\s+/g, ' ').slice(0, 120))
      console.log(`  模式 ${pattern.source}：命中 ${matches.length}${matches.length > 0 ? ` → ${matches.join(' | ')}` : ''}`)
    }
  }

  // H. 训练日志里是否已经带轨迹（static_map 的 path 参数）与分页上限
  console.log('\n=== H1. training_activities 的 static_map / has_latlng ===')
  if (training) {
    const payload = JSON.parse(training.text) as { models?: Array<Record<string, unknown>> }
    for (const record of (payload.models ?? []).slice(0, 2)) {
      const staticMap = String(record.static_map ?? '')
      const pathMatch = staticMap.match(/[?&]path=([^&]+)/)
      console.log(`  id=${record.id} has_latlng=${record.has_latlng} static_map 长度=${staticMap.length} path 参数=${pathMatch ? `${decodeURIComponent(pathMatch[1]).slice(0, 60)}…` : '无'}`)
    }
  }

  console.log('\n=== H2. 分页参数上限 ===')
  for (const query of ['page=1&per_page=100', 'page=1&page_size=100']) {
    const response = await fetch(`${webBase}/athlete/training_activities?${query}`, { headers: webHeaders() })
    const payload = await response.json() as { models?: unknown[], perPage?: number, total?: number }
    console.log(`  ${query} -> HTTP ${response.status} models=${payload.models?.length} perPage=${payload.perPage} total=${payload.total}`)
  }

  console.log('\n=== H3. /activities/{id}/export_original（原始文件里是否带卡路里） ===')
  const originalResponse = await fetch(`${webBase}/activities/${activityId}/export_original`, { headers: webHeaders() })
  const originalBuffer = new Uint8Array(await originalResponse.arrayBuffer())
  const head = [...originalBuffer.slice(0, 12)].map(byte => byte.toString(16).padStart(2, '0')).join(' ')
  const isGzip = originalBuffer[0] === 0x1F && originalBuffer[1] === 0x8B
  const fitOffset = isGzip ? 0 : head.indexOf('46 49 54')
  console.log(`  -> HTTP ${originalResponse.status} | ${originalResponse.headers.get('content-type')} | ${originalBuffer.length} bytes | 头字节：${head}${isGzip ? '（gzip，需解压后看是否 FIT）' : ''}${fitOffset >= 0 ? '（FIT 文件）' : ''}`)

  // I. 登录页 HTML 里是否嵌了 JWT，且该 JWT 能否直接当 Bearer 用
  console.log('\n=== I1. 页面 HTML 里的 JWT ===')
  const pages = ['/athlete/training', `/activities/${activityId}`]
  let foundJwt: string | null = null
  for (const pagePath of pages) {
    const response = await fetch(`${webBase}${pagePath}`, { headers: webHeaders({ Accept: 'text/html,application/xhtml+xml' }) })
    const html = await response.text()
    const tokens = [...new Set([...html.matchAll(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g)].map(match => match[0]))]
    const jwtKeys = [...new Set([...html.matchAll(/["'](\w*jwt\w*)["']\s*:/gi)].map(match => match[1]))]
    console.log(`  ${pagePath} -> HTTP ${response.status} ${html.length} bytes | JWT 候选 ${tokens.length} 个${tokens.length > 0 ? `（首个 ${tokens[0].slice(0, 12)}… 长度 ${tokens[0].length}）` : ''} | jwt 字段名：${jwtKeys.join(',') || '无'}`)
    if (!foundJwt && tokens.length > 0) {
      foundJwt = tokens[0]
    }
  }

  console.log('\n=== I2. 用该 JWT 试 /api/v3 ===')
  if (!foundJwt) {
    console.log('  没找到 JWT，跳过。')
  }
  else {
    for (const apiPath of ['/api/v3/athlete/activities?per_page=2', `/api/v3/activities/${activityId}`]) {
      const response = await fetch(`${webBase}${apiPath}`, {
        headers: { ...webHeaders({ Accept: 'application/json' }), Authorization: `Bearer ${foundJwt}` },
      })
      const body = await response.text()
      console.log(`  ${apiPath} -> HTTP ${response.status} | ${body.slice(0, 200).replace(/\s+/g, ' ')}`)
    }
  }

  // J1. 不带 XHR 头拿真实 HTML，找 JWT（上一步 /athlete/training 被 XHR 头变成了 JSON）
  console.log('\n=== J1. 真实 HTML 页面里的 JWT ===')
  for (const pagePath of ['/dashboard', '/athlete/training']) {
    const response = await fetch(`${webBase}${pagePath}`, {
      headers: { ...webHeaders({ Accept: 'text/html,application/xhtml+xml' }), 'X-Requested-With': '' },
    })
    const html = await response.text()
    const tokens = [...new Set([...html.matchAll(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g)].map(match => match[0]))]
    console.log(`  ${pagePath} -> HTTP ${response.status} ${html.length} bytes | JWT 候选 ${tokens.length} 个 | 含 graphql=${html.includes('graphql')} | 含 isServerSide=${html.includes('window.__')}`)
  }

  // J2. TCX 导出里是否有 Strava 口径的卡路里
  console.log('\n=== J2. /activities/{id}/export_tcx（Calories） ===')
  const tcxResponse = await fetch(`${webBase}/activities/${activityId}/export_tcx`, { headers: webHeaders() })
  const tcx = await tcxResponse.text()
  const calories = [...tcx.matchAll(/<Calories>([\d.]+)<\/Calories>/g)].map(match => match[1])
  const totalTime = tcx.match(/<TotalTimeSeconds>([\d.]+)</)?.[1]
  const distance = tcx.match(/<DistanceMeters>([\d.]+)</)?.[1]
  const trkPoints = (tcx.match(/<Trackpoint>/g) ?? []).length
  console.log(`  -> HTTP ${tcxResponse.status} | ${tcxResponse.headers.get('content-type')} | ${tcx.length} bytes`)
  console.log(`  Calories 值=${calories.join(',') || '无'} | TotalTimeSeconds=${totalTime} | DistanceMeters=${distance} | Trackpoint 数=${trkPoints}`)

  // K. 原始 FIT 里的会话汇总，并用「FIT 距离/时长必须与训练日志一致」自校验解析器
  console.log('\n=== K. export_original -> FIT 会话汇总（卡路里） ===')
  if (training) {
    const payload = JSON.parse(training.text) as { models?: Array<Record<string, unknown>> }
    const candidates = (payload.models ?? []).filter(record => record.has_latlng).slice(0, 3)
    for (const record of candidates) {
      const id = Number(record.id)
      const response = await fetch(`${webBase}/activities/${id}/export_original`, { headers: webHeaders() })
      const buffer = new Uint8Array(await response.arrayBuffer())
      const summary = readFitSummary(buffer)
      if (!summary) {
        console.log(`  id=${id} -> HTTP ${response.status} ${buffer.length} bytes，非 FIT（可能是 GPX/TCX 上传）`)
        continue
      }

      const logDistance = Number(record.distance_raw)
      const logMoving = Number(record.moving_time_raw)
      const distanceDelta = summary.totalDistanceMeters == null ? null : Math.abs(summary.totalDistanceMeters - logDistance)
      console.log(`  id=${id} ${record.sport_type} (${record.display_type}) | FIT 卡路里=${summary.totalCalories} | FIT 距离=${summary.totalDistanceMeters} 日志距离=${logDistance} 差=${distanceDelta?.toFixed(1)}m | FIT 计时=${summary.totalTimerSeconds}s 日志移动时长=${logMoving}s | 平均心率=${summary.averageHeartRate}`)
      if (summary.totalCalories == null) {
        const inventory = describeFitMessages(buffer)
        for (const message of inventory.slice(0, 6)) {
          console.log(`      消息 globalNum=${message.globalNum} 字段：${message.fieldNums.join(',')}`)
        }
      }
    }
  }

  console.log(`\n小结：列表接口里有轨迹字段 = ${sawPolylineField}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
