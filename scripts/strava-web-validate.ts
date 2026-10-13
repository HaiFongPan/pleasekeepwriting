/**
 * 网页登录态数据源的真实数据验证（只读，不写仓库）。
 *
 * 用法：pnpm strava-web-validate
 *
 * 验证内容：
 *   1. 训练日志分页能拉全（total 与逐页累计一致）
 *   2. 每条的元数据是否能凑齐卡片要的距离/时长/类型/日期
 *   3. streams 轨迹 -> 裁剪首尾 -> 简化 -> 投影，是否都能出图
 *   4. FIT 卡路里是否拿得到（session/lap），并与距离、时长交叉校验
 *   5. 拼一张样本图到系统临时目录，用于肉眼确认轨迹形状
 */

import type { TrackPoint } from './lib/strava-track'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { loadDotEnv } from './lib/env'
import { buildTrackFromPoints, defaultTrackOptions } from './lib/strava-track'
import { fetchOriginalFitSummary, fetchStreams, fetchTrainingActivities, trainingPageSize } from './lib/strava-web'

const sampleCount = Number.parseInt(process.env.STRAVA_WEB_SAMPLE_COUNT ?? '6', 10)
const maxPages = Number.parseInt(process.env.STRAVA_WEB_MAX_PAGES ?? '40', 10)

function formatKm(meters: number): string {
  return `${(meters / 1000).toFixed(2)}km`
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = Math.floor(seconds % 60)
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

interface Sample {
  activityId: number
  sportType: string
  displayType: string
  distanceRaw: number
  movingTimeRaw: number
  calories: number | null
  path: string
  start: [number, number]
  end: [number, number]
  stats: ReturnType<typeof buildTrackFromPoints>['stats']
  rawPoints: number
}

function buildContactSheet(samples: Sample[], outputWidth = 220): string {
  const scale = outputWidth / defaultTrackOptions.viewBox[0]
  const trackHeight = defaultTrackOptions.viewBox[1] * scale
  const labelHeight = 30
  const cellHeight = trackHeight + labelHeight
  const gap = 14
  const margin = 16
  const columns = Math.min(3, Math.max(1, samples.length))
  const rows = Math.ceil(samples.length / columns)
  const width = margin * 2 + columns * outputWidth + (columns - 1) * gap
  const height = margin * 2 + rows * cellHeight + (rows - 1) * gap

  const cells = samples.map((sample, index) => {
    const offsetX = margin + (index % columns) * (outputWidth + gap)
    const offsetY = margin + Math.floor(index / columns) * (cellHeight + gap)
    const title = `${sample.displayType} ${formatKm(sample.distanceRaw)} ${formatDuration(sample.movingTimeRaw)} ${sample.calories ?? '—'}kcal`
    const subtitle = `${sample.rawPoints}→${sample.stats.simplifiedPoints}点 裁头尾${sample.stats.trimmedHead}/${sample.stats.trimmedTail}`

    return `<rect x="${offsetX}" y="${offsetY}" width="${outputWidth}" height="${cellHeight}" fill="none" stroke="#ddd" />
      <text x="${offsetX + 8}" y="${offsetY + 14}" font-family="sans-serif" font-size="11" fill="#333">${title}</text>
      <text x="${offsetX + 8}" y="${offsetY + 26}" font-family="sans-serif" font-size="9" fill="#999">${subtitle}</text>
      <g transform="translate(${offsetX} ${offsetY + labelHeight}) scale(${scale})">
        <path d="${sample.path}" fill="none" stroke="#111" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
        <circle cx="${sample.start[0]}" cy="${sample.start[1]}" r="2.4" fill="#111" />
        <rect x="${sample.end[0] - 1.8}" y="${sample.end[1] - 1.8}" width="3.6" height="3.6" fill="none" stroke="#111" stroke-width="1.2" />
      </g>`
  }).join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#fff" />
    ${cells}
  </svg>`
}

async function main() {
  loadDotEnv()

  console.log('拉取训练日志…')
  const all = []
  let total = 0
  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchTrainingActivities(page)
    total = result.total
    all.push(...result.models)
    console.log(`  第 ${page} 页：${result.models.length} 条（累计 ${all.length}/${total}）`)
    if (result.models.length < trainingPageSize || all.length >= total) {
      break
    }
  }

  if (all.length === 0) {
    throw new Error('训练日志为空，检查 cookie 是否有效。')
  }

  const withGps = all.filter(activity => activity.has_latlng)
  const privateCount = all.filter(activity => activity.private).length
  const totalDistance = all.reduce((sum, activity) => sum + activity.distance_raw, 0)
  console.log(`\n共 ${all.length} 条（total 声明 ${total}）：${all[all.length - 1].start_date.slice(0, 10)} → ${all[0].start_date.slice(0, 10)}`)
  console.log(`有 GPS：${withGps.length} 条；private 标记：${privateCount} 条；累计距离 ${formatKm(totalDistance)}`)
  console.log(`字段自检：id=${all[0].id} sport_type=${all[0].sport_type} display_type=${all[0].display_type} start_date=${all[0].start_date} distance_raw=${all[0].distance_raw} moving_time_raw=${all[0].moving_time_raw} elevation_gain_raw=${all[0].elevation_gain_raw}`)

  const byType = new Map<string, number>()
  for (const activity of all) {
    byType.set(activity.sport_type, (byType.get(activity.sport_type) ?? 0) + 1)
  }

  console.log('\n按类型（sport_type / display_type）：')
  for (const [sportType, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    const example = all.find(activity => activity.sport_type === sportType)
    console.log(`  ${sportType.padEnd(22)} ${String(count).padStart(4)}  ${example?.display_type ?? ''}`)
  }

  // 抽样：优先每种类型一条，保证样本覆盖不同轨迹形态
  const picked: typeof all = []
  const seen = new Set<string>()
  for (const activity of withGps) {
    if (picked.length >= sampleCount) {
      break
    }

    if (!seen.has(activity.sport_type)) {
      seen.add(activity.sport_type)
      picked.push(activity)
    }
  }

  console.log(`\n拉取 ${picked.length} 条的 streams 与原始 FIT（每条 2 次请求）…`)
  const samples: Sample[] = []
  for (const activity of picked) {
    const streams = await fetchStreams(activity.id)
    const points: TrackPoint[] = streams.latlng.map(([lat, lng]) => ({ lat, lng }))
    const outcome = buildTrackFromPoints(points, defaultTrackOptions)
    const fit = await fetchOriginalFitSummary(activity.id)

    const distanceDelta = fit.summary?.totalDistanceMeters == null
      ? null
      : Math.abs(fit.summary.totalDistanceMeters - activity.distance_raw)
    const timeDelta = fit.summary?.totalTimerSeconds == null
      ? null
      : Math.abs(fit.summary.totalTimerSeconds - activity.moving_time_raw)

    console.log(`\n  #${activity.id} ${activity.sport_type}（${activity.display_type}）`)
    console.log(`    轨迹：streams 点=${points.length} 裁剪头尾=${outcome.stats.trimmedHead}/${outcome.stats.trimmedTail} 简化后=${outcome.stats.simplifiedPoints} path=${outcome.stats.pathChars}字符`)
    console.log(`    卡路里：FIT=${fit.summary?.totalCalories ?? '无'}（${fit.bytes} bytes）| 距离校验 差=${distanceDelta?.toFixed(1)}m | 时长校验 差=${timeDelta?.toFixed(1)}s | 平均心率=${fit.summary?.averageHeartRate ?? '无'}`)

    if (outcome.kind !== 'track') {
      console.log(`    ⚠ 未出图：${outcome.reason}`)
      continue
    }

    samples.push({
      activityId: activity.id,
      sportType: activity.sport_type,
      displayType: activity.display_type,
      distanceRaw: activity.distance_raw,
      movingTimeRaw: activity.moving_time_raw,
      calories: fit.summary?.totalCalories ?? null,
      path: outcome.file.p,
      start: outcome.file.s,
      end: outcome.file.e,
      stats: outcome.stats,
      rawPoints: points.length,
    })
  }

  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'strava-web-validate-'))
  const svg = buildContactSheet(samples)
  const svgPath = path.join(outputDir, 'tracks.svg')
  await fs.writeFile(svgPath, svg, 'utf8')

  let pngPath: string | null = null
  try {
    const sharp = (await import('sharp')).default
    pngPath = path.join(outputDir, 'tracks.png')
    await sharp(Buffer.from(svg)).png().toFile(pngPath)
  }
  catch (error) {
    console.warn(`PNG 渲染失败（可看 SVG）：${error instanceof Error ? error.message : String(error)}`)
  }

  console.log(`\n样本目录：${outputDir}`)
  if (pngPath) {
    console.log(`样本图：${pngPath}`)
  }

  const uploadedBytes = samples.length * (120 * 1024 + 85 * 1024)
  console.log(`\n按每条 streams≈120KB + FIT≈85KB 估算：样本 ${samples.length} 条约 ${(uploadedBytes / 1024 / 1024).toFixed(1)}MB；全量 ${all.length} 条约 ${(all.length * 205 / 1024).toFixed(0)}MB（一次性）`)
  console.log(`每日增量成本：1 次列表请求 + 每条新活动 2 次请求`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
