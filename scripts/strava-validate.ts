/**
 * 官方 API 路线的只读验证：确认列表字段、calories 需要详情接口、轨迹流水线效果。
 *
 * 现状：本账号的 API 应用处于 Inactive，业务接口一律 403，本脚本目前跑不通。
 * 网页登录态路线的验证请用 pnpm strava-web-validate。
 */
import type { StravaDetailedActivity, StravaSummaryActivity } from '../src/types/strava'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { loadDotEnv } from './lib/env'
import { getActivityDetail, getAthlete, getCredentials, listActivities, maxPerPage, refreshAccessToken } from './lib/strava-api'
import { buildTrack, decodePolyline, defaultTrackOptions } from './lib/strava-track'

const maxPages = Number.parseInt(process.env.STRAVA_VALIDATE_MAX_PAGES ?? '50', 10)
const detailSamples = Number.parseInt(process.env.STRAVA_VALIDATE_DETAILS ?? '3', 10)
const trackSamples = Number.parseInt(process.env.STRAVA_VALIDATE_TRACKS ?? '6', 10)

function formatKm(meters: number): string {
  return `${(meters / 1000).toFixed(1)}km`
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}m` : `${minutes}m`
}

function padRight(value: string, width: number): string {
  // 中文按 2 个字符宽度计算
  const visualWidth = [...value].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2E80 ? 2 : 1), 0)
  return value + ' '.repeat(Math.max(0, width - visualWidth))
}

/** 按 200/页 拉完所有活动 */
async function fetchAllActivities(accessToken: string) {
  const activities: StravaSummaryActivity[] = []
  let lastRateLimit = null as Awaited<ReturnType<typeof listActivities>>['rateLimit']
  let page = 1

  while (page <= maxPages) {
    const response = await listActivities(accessToken, { page, perPage: maxPerPage })
    lastRateLimit = response.rateLimit
    activities.push(...response.data)
    console.log(`  已拉取第 ${page} 页：${response.data.length} 条（累计 ${activities.length}）`)

    if (response.data.length < maxPerPage) {
      break
    }

    page++
  }

  return { activities, rateLimit: lastRateLimit, pages: page }
}

interface Sample {
  activity: StravaSummaryActivity
  polylinePoints: number
  outcome: ReturnType<typeof buildTrack>
}

function pickTrackSamples(activities: StravaSummaryActivity[], limit: number): StravaSummaryActivity[] {
  const picked: StravaSummaryActivity[] = []
  const seenSports = new Set<string>()

  for (const activity of activities) {
    if (picked.length >= limit) {
      break
    }

    const polyline = activity.map?.summary_polyline
    if (!polyline || seenSports.has(activity.sport_type)) {
      continue
    }

    seenSports.add(activity.sport_type)
    picked.push(activity)
  }

  // 运动类型不够多时，用剩余的有轨迹活动补足
  for (const activity of activities) {
    if (picked.length >= limit) {
      break
    }

    if (activity.map?.summary_polyline && !picked.includes(activity)) {
      picked.push(activity)
    }
  }

  return picked
}

function buildContactSheet(samples: Sample[], outputWidth = 200): string {
  const scale = outputWidth / defaultTrackOptions.viewBox[0]
  const trackHeight = defaultTrackOptions.viewBox[1] * scale
  const labelHeight = 26
  const cellHeight = trackHeight + labelHeight
  const gap = 14
  const margin = 16
  const columns = Math.min(3, Math.max(1, samples.length))
  const rows = Math.ceil(samples.length / columns)
  const width = margin * 2 + columns * outputWidth + (columns - 1) * gap
  const height = margin * 2 + rows * cellHeight + (rows - 1) * gap

  const cells = samples.map((sample, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const offsetX = margin + column * (outputWidth + gap)
    const offsetY = margin + row * (cellHeight + gap)
    const { file } = sample.outcome.kind === 'track'
      ? sample.outcome
      : { file: null }

    const track = file
      ? `<g transform="translate(${offsetX} ${offsetY + labelHeight}) scale(${scale})">
        <path d="${file.p}" fill="none" stroke="#111" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
        <circle cx="${file.s[0]}" cy="${file.s[1]}" r="2.4" fill="#111" />
        <rect x="${file.e[0] - 1.8}" y="${file.e[1] - 1.8}" width="3.6" height="3.6" fill="none" stroke="#111" stroke-width="1.2" />
      </g>`
      : `<text x="${offsetX + outputWidth / 2}" y="${offsetY + labelHeight + trackHeight / 2}" font-family="sans-serif" font-size="20" fill="#888" text-anchor="middle">${sample.activity.sport_type}</text>`

    const label = `${sample.activity.sport_type} · ${formatKm(sample.activity.distance)} · ${sample.polylinePoints}→${sample.outcome.kind === 'track' ? sample.outcome.stats.simplifiedPoints : 0}pts`
    return `<rect x="${offsetX}" y="${offsetY}" width="${outputWidth}" height="${cellHeight}" fill="none" stroke="#ddd" />
      <text x="${offsetX + 8}" y="${offsetY + 17}" font-family="sans-serif" font-size="11" fill="#555">${label}</text>
      ${track}`
  }).join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#fff" />
    ${cells}
  </svg>`
}

async function main() {
  loadDotEnv()
  const credentials = getCredentials()

  const tokens = await refreshAccessToken(credentials)
  console.log(`token 刷新成功，scope=${tokens.scope ?? '未知'}，有效期至 ${new Date(tokens.expiresAt * 1000).toISOString()}`)
  console.log(tokens.rotated
    ? '注意：Strava 返回了新的 refresh token，旧值已失效，必须持久化最新值。'
    : '本次 refresh token 未轮换。')

  const athlete = await getAthlete(tokens.accessToken)
  console.log(`运动员：${athlete.data.id}${athlete.data.username ? ` (@${athlete.data.username})` : ''}\n`)

  console.log('拉取活动列表…')
  const { activities, rateLimit, pages } = await fetchAllActivities(tokens.accessToken)
  if (activities.length === 0) {
    throw new Error('列表为空：检查应用是否被该运动员授权，以及 scope 是否包含 activity:read。')
  }

  const oldest = activities[activities.length - 1]
  const newest = activities[0]
  console.log(`\n共 ${activities.length} 条活动（${pages} 次列表请求）：${oldest.start_date_local.slice(0, 10)} → ${newest.start_date_local.slice(0, 10)}`)

  const withPolyline = activities.filter(activity => activity.map?.summary_polyline)
  const privateCount = activities.filter(activity => activity.private).length
  const totalDistance = activities.reduce((sum, activity) => sum + activity.distance, 0)
  const totalMovingTime = activities.reduce((sum, activity) => sum + activity.moving_time, 0)
  console.log(`有 summary_polyline：${withPolyline.length}（${(withPolyline.length / activities.length * 100).toFixed(1)}%）`)
  console.log(`private（Only Me）活动：${privateCount} 条`)
  console.log(`累计距离：${formatKm(totalDistance)}，累计运动时长：${formatDuration(totalMovingTime)}`)

  const bySportType = new Map<string, { count: number, distance: number }>()
  for (const activity of activities) {
    const entry = bySportType.get(activity.sport_type) ?? { count: 0, distance: 0 }
    entry.count++
    entry.distance += activity.distance
    bySportType.set(activity.sport_type, entry)
  }

  console.log('\n按运动类型：')
  for (const [sport, entry] of [...bySportType.entries()].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${padRight(sport, 22)} ${padRight(String(entry.count), 6)} ${formatKm(entry.distance)}`)
  }

  const byYear = new Map<string, { count: number, distance: number }>()
  for (const activity of activities) {
    const year = activity.start_date_local.slice(0, 4)
    const entry = byYear.get(year) ?? { count: 0, distance: 0 }
    entry.count++
    entry.distance += activity.distance
    byYear.set(year, entry)
  }

  console.log('\n按年份：')
  for (const [year, entry] of [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    console.log(`  ${year}  ${padRight(String(entry.count), 6)} ${formatKm(entry.distance)}`)
  }

  // 1. 详情接口验证：calories 只能从这里拿
  const detailTargets = withPolyline.slice(0, Math.max(0, detailSamples))
  console.log(`\n详情接口抽样 ${detailTargets.length} 条（验证 calories）：`)
  for (const activity of detailTargets) {
    const detail = await getActivityDetail(tokens.accessToken, activity.id)
    const data: StravaDetailedActivity = detail.data
    const summaryPoints = activity.map?.summary_polyline?.length ?? 0
    const detailedPoints = data.map?.polyline?.length ?? 0
    console.log(`  #${activity.id} ${padRight(data.sport_type, 16)} calories=${data.calories ?? 'null'} kilojoules=${data.kilojoules ?? 'null'} 主轨迹点数=${detailedPoints} 简化轨迹串长=${summaryPoints} 爬升=${data.total_elevation_gain}m 城市=${data.location_city ?? 'null'}`)
  }

  // 2. 轨迹流水线验证
  console.log('\n轨迹流水线抽样（截断首尾 + 简化 + 投影）：')
  const sampleActivities = pickTrackSamples(activities, trackSamples)
  const samples: Sample[] = sampleActivities.map((activity) => {
    const encoded = activity.map?.summary_polyline ?? ''
    const outcome = buildTrack(encoded, defaultTrackOptions)
    const polylinePoints = encoded ? decodePolyline(encoded).length : 0

    if (outcome.kind === 'track') {
      const { stats } = outcome
      const retained = (stats.simplifiedPoints / Math.max(1, stats.rawPoints) * 100).toFixed(0)
      console.log(`  #${activity.id} ${padRight(activity.sport_type, 16)} 原始=${padRight(String(stats.rawPoints), 5)} 裁掉头/尾=${stats.trimmedHead}/${stats.trimmedTail} 简化后=${padRight(String(stats.simplifiedPoints), 4)} (${retained}%) path=${stats.pathChars} 字符`)
    }
    else {
      console.log(`  #${activity.id} ${padRight(activity.sport_type, 16)} 判定为无轨迹（${outcome.reason}）：原始=${outcome.stats.rawPoints} 裁掉头/尾=${outcome.stats.trimmedHead}/${outcome.stats.trimmedTail}`)
    }

    return { activity, polylinePoints, outcome }
  })

  // 3. 全量轨迹可行性 + 落盘体积估算
  let trackCount = 0
  let noneCount = 0
  const noneReasons = new Map<string, number>()
  let totalPathChars = 0
  for (const activity of withPolyline) {
    const outcome = buildTrack(activity.map?.summary_polyline, defaultTrackOptions)
    if (outcome.kind === 'track') {
      trackCount++
      totalPathChars += outcome.stats.pathChars
    }
    else {
      noneCount++
      noneReasons.set(outcome.reason, (noneReasons.get(outcome.reason) ?? 0) + 1)
    }
  }

  console.log(`\n全量轨迹构建：可出图 ${trackCount} 条，判为无轨迹 ${noneCount} 条（${[...noneReasons.entries()].map(([reason, count]) => `${reason}:${count}`).join(', ') || '无'}）`)
  console.log(`轨迹文件总体积约 ${(totalPathChars / 1024).toFixed(0)}KB（平均 ${trackCount > 0 ? Math.round(totalPathChars / trackCount) : 0} 字符/条）`)
  console.log(`calories 回填需要 ${activities.length} 次详情请求；按 400 次/运行、1000 次/天上限估算，约需 ${Math.ceil(activities.length / 400)} 次运行`)

  // 4. 写出样本图到临时目录（含几何，绝不进仓库）
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strava-validate-'))
  for (const sample of samples) {
    if (sample.outcome.kind === 'track') {
      await fs.writeFile(
        path.join(outputDir, `${sample.activity.id}.json`),
        `${JSON.stringify(sample.outcome.file)}\n`,
        'utf8',
      )
    }
  }

  const svg = buildContactSheet(samples)
  const svgPath = path.join(outputDir, 'contact-sheet.svg')
  await fs.writeFile(svgPath, svg, 'utf8')

  let pngPath: string | null = null
  try {
    const sharp = (await import('sharp')).default
    pngPath = path.join(outputDir, 'contact-sheet.png')
    await sharp(Buffer.from(svg)).png().toFile(pngPath)
  }
  catch (error) {
    console.warn(`PNG 渲染失败（可看 SVG）：${error instanceof Error ? error.message : String(error)}`)
  }

  console.log(`\n样本输出目录：${outputDir}`)
  if (pngPath) {
    console.log(`样本图：${pngPath}`)
  }

  if (rateLimit) {
    console.log(`\n限流用量：15 分钟 ${rateLimit.shortUsage}/${rateLimit.shortLimit}，当天 ${rateLimit.dailyUsage}/${rateLimit.dailyLimit}`)
  }
  else {
    console.log('\n响应里没有限流头，按默认 100/15min、1000/day 估算。')
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
