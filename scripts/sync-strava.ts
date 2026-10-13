/**
 * 把 Strava 运动数据同步进仓库。
 *
 * 用法：
 *   pnpm sync-strava                 # 增量：只扫最新几页训练日志
 *   pnpm sync-strava --full          # 全量：扫完所有页，并以本次结果为权威（会清掉已删除的活动）
 *   pnpm sync-strava --rebuild-tracks # 按当前渲染参数重建全部轨迹
 *   pnpm sync-strava --limit 50      # 本次最多处理 50 条（每条 0-2 次请求）
 *
 * 产物（都不含经纬度、城市、海拔）：
 *   src/data/strava/activities.json   指标索引
 *   public/strava/tracks/{id}.json    归一化后的 SVG 几何，按需懒加载
 *
 * 凭据：.env 或环境变量里的 STRAVA_COOKIE_STRAVA4_SESSION（浏览器登录态）。
 * 过程可重入：每处理若干条就落盘一次，超时或中断后重跑会接着做。
 */

import type { SportActivitiesData, SportActivity, SportRenderParams, SportTrackFile } from '../src/types/strava'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { themeConfig } from '../src/config'
import { formatLocalDate, resolveMetricKind, resolveSportKind } from '../src/utils/sport'
import { loadDotEnv } from './lib/env'
import { computeGradeLevels, computeSpeedLevels } from './lib/strava-metrics'
import { buildTrackFromPoints, defaultTrackOptions } from './lib/strava-track'
import { fetchOriginalFitSummary, fetchStreams, fetchTrainingActivities, requireCookie, StravaSessionExpiredError, trainingPageSize } from './lib/strava-web'

const datasetPath = 'src/data/strava/activities.json'
const tracksDir = 'public/strava/tracks'
/** 渲染算法版本，改算法时递增，会触发全部轨迹重建 */
const rendererVersion = 4
/** 每处理多少条落盘一次 */
const flushEvery = 20

interface CliOptions {
  full: boolean
  rebuildTracks: boolean
  limit: number
  maxPages: number
}

function parseArgs(argv: string[]): CliOptions {
  const config = themeConfig.sport
  const options: CliOptions = {
    full: argv.includes('--full'),
    rebuildTracks: argv.includes('--rebuild-tracks'),
    limit: Number.parseInt(process.env.STRAVA_SYNC_LIMIT ?? String(config.maxNewPerSync), 10),
    maxPages: Number.parseInt(process.env.STRAVA_SYNC_MAX_PAGES ?? (argv.includes('--full') ? '100' : '3'), 10),
  }

  const limitIndex = argv.indexOf('--limit')
  if (limitIndex >= 0 && argv[limitIndex + 1]) {
    options.limit = Number.parseInt(argv[limitIndex + 1], 10)
  }

  return options
}

function resolveParams(): SportRenderParams {
  const { track, showMap, showLocationNames } = themeConfig.sport
  return {
    renderer: rendererVersion,
    viewBox: track.viewBox,
    padding: track.padding,
    trimStartMeters: track.trimStartMeters,
    minRetainRatio: track.minRetainRatio,
    minTrimMeters: track.minTrimMeters,
    simplifyTolerance: track.simplifyTolerance,
    maxPoints: track.maxPoints,
    showMap,
    showLocationNames,
  }
}

function trackOptionsFrom(params: SportRenderParams) {
  return {
    ...defaultTrackOptions,
    viewBox: params.viewBox,
    padding: params.padding,
    trimStartMeters: params.trimStartMeters,
    minRetainRatio: params.minRetainRatio,
    minTrimMeters: params.minTrimMeters,
    simplifyTolerance: params.simplifyTolerance,
    maxPoints: params.maxPoints,
    showMap: params.showMap,
  }
}

function paramsEqual(left: SportRenderParams | undefined, right: SportRenderParams): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function readDataset(): Promise<SportActivitiesData | null> {
  try {
    const raw = await fs.readFile(datasetPath, 'utf8')
    return JSON.parse(raw) as SportActivitiesData
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }
}

async function writeJsonAtomically(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  await fs.writeFile(temporaryPath, contents, 'utf8')
  await fs.rename(temporaryPath, filePath)
}

function buildDataset(activities: SportActivity[], params: SportRenderParams, previous?: SportActivitiesData | null): SportActivitiesData {
  const sorted = [...activities].sort((left, right) => right.start - left.start || right.id - left.id)
  const withTrack = sorted.filter(activity => activity.track).length
  const missingCalories = sorted.filter(activity => activity.calories == null).length

  // 数据与参数都没变时沿用旧时间戳，避免每天产生一次没有意义的提交
  const unchanged = previous != null
    && paramsEqual(previous.params, params)
    && JSON.stringify(previous.activities) === JSON.stringify(sorted)

  return {
    generatedAt: unchanged && previous ? previous.generatedAt : new Date().toISOString(),
    source: { provider: 'strava', athleteId: null },
    params,
    summary: {
      activityCount: sorted.length,
      trackCount: withTrack,
      calorieMissing: missingCalories,
      firstActivityAt: sorted.length > 0 ? sorted[sorted.length - 1].date : null,
      lastActivityAt: sorted.length > 0 ? sorted[0].date : null,
    },
    activities: sorted,
  }
}

async function pruneTracks(activities: SportActivity[]) {
  const keep = new Set(activities.filter(activity => activity.track).map(activity => `${activity.id}.json`))
  let entries: string[] = []

  try {
    entries = await fs.readdir(tracksDir)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }

    throw error
  }

  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.json') || keep.has(entry)) {
      continue
    }

    await fs.rm(path.join(tracksDir, entry))
    removed++
  }

  return removed
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  loadDotEnv()
  requireCookie()

  const config = themeConfig.sport
  const params = resolveParams()
  const trackOptions = trackOptionsFrom(params)

  const existing = await readDataset()
  const paramsChanged = existing != null && !paramsEqual(existing.params, params)
  const known = new Map<number, SportActivity>((existing?.activities ?? []).map(activity => [activity.id, activity]))

  console.log(`已有 ${known.size} 条数据${paramsChanged ? '；渲染参数已变化，将重建全部轨迹' : ''}`)
  console.log(`本次上限 ${options.limit} 条，最多扫 ${options.maxPages} 页训练日志${options.full ? '（全量）' : '（增量）'}\n`)

  const scannedIds = new Set<number>()
  let newActivities = 0
  let tracksFetched = 0
  let trackFailed = 0
  let caloriesFetched = 0
  let updatedMetrics = 0
  let skippedPrivate = 0
  let requests = 0
  let processed = 0
  let reachedLimit = false
  let scanComplete = false

  const flush = async () => {
    await writeJsonAtomically(datasetPath, `${JSON.stringify(buildDataset([...known.values()], params, existing), null, 2)}\n`)
  }

  for (let page = 1; page <= options.maxPages; page++) {
    if (reachedLimit) {
      break
    }

    const result = await fetchTrainingActivities(page)
    requests++
    console.log(`第 ${page} 页：${result.models.length} 条（训练日志共 ${result.total} 条）`)

    if (result.models.length < trainingPageSize) {
      scanComplete = true
    }

    if (result.models.length === 0) {
      break
    }

    for (const model of result.models) {
      if (model.private && config.excludePrivate) {
        skippedPrivate++
        known.delete(model.id)
        continue
      }

      scannedIds.add(model.id)
      const previous = known.get(model.id)
      const isNew = !previous
      const needTrack = model.has_latlng && (options.rebuildTracks || paramsChanged || previous?.trackSynced !== true)
      const needCalories = previous?.caloriesSynced !== true

      if (!isNew && !needTrack && !needCalories) {
        // 指标可能被用户在 Strava 侧修改过，顺手刷新
        known.set(model.id, {
          ...previous,
          sportType: model.sport_type,
          displayType: model.display_type,
          name: model.name ?? null,
          kind: resolveSportKind(model.sport_type),
          distance: model.distance_raw,
          movingTime: model.moving_time_raw,
          elapsedTime: model.elapsed_time_raw,
          elevation: model.elevation_gain_raw ?? null,
          date: formatLocalDate(model.start_date_local_raw),
        })
        updatedMetrics++
        continue
      }

      const cost = (needTrack ? 1 : 0) + (needCalories ? 1 : 0)
      if (processed > 0 && processed + cost > options.limit) {
        reachedLimit = true
        scanComplete = false
        break
      }

      const record: SportActivity = {
        id: model.id,
        sportType: model.sport_type,
        displayType: model.display_type,
        name: model.name ?? null,
        kind: resolveSportKind(model.sport_type),
        start: model.start_date_local_raw,
        date: formatLocalDate(model.start_date_local_raw),
        distance: model.distance_raw,
        movingTime: model.moving_time_raw,
        elapsedTime: model.elapsed_time_raw,
        calories: previous?.calories ?? null,
        caloriesSynced: previous?.caloriesSynced ?? false,
        elevation: model.elevation_gain_raw ?? null,
        hasGps: model.has_latlng,
        track: previous?.track ?? false,
        trackSynced: previous?.trackSynced ?? false,
      }

      const label = `#${model.id} ${model.sport_type} ${record.date} ${(model.distance_raw / 1000).toFixed(2)}km`

      if (needTrack) {
        try {
          const streams = await fetchStreams(model.id)
          requests++
          const points = streams.latlng.map(([lat, lng]) => ({ lat, lng }))
          const metricKind = resolveMetricKind(record.kind)
          const metric = metricKind === 'speed'
            ? computeSpeedLevels(streams)
            : metricKind === 'grade'
              ? computeGradeLevels(streams)
              : null
          const outcome = buildTrackFromPoints(points, trackOptions, metric)

          if (outcome.kind === 'track') {
            const file: SportTrackFile = outcome.file
            await writeJsonAtomically(path.join(tracksDir, `${model.id}.json`), `${JSON.stringify(file)}\n`)
            record.track = true
            tracksFetched++
          }
          else {
            record.track = false
            trackFailed++
          }

          record.trackSynced = true
          const metricNote = outcome.kind === 'track' && outcome.file.k ? `，上色=${outcome.file.k}(${outcome.file.q?.length ?? 0} 段)` : ''
          console.log(`  ${label} 轨迹：${outcome.kind === 'track' ? `${outcome.stats.rawPoints}→${outcome.stats.simplifiedPoints} 点，隐私圈 ${outcome.stats.trimRadius}m，保留 ${(outcome.stats.retainedRatio * 100).toFixed(0)}%${metricNote}` : `无（${outcome.reason}）`}`)
        }
        catch (error) {
          if (error instanceof StravaSessionExpiredError) {
            throw error
          }

          console.warn(`  ${label} 轨迹同步失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (needCalories) {
        try {
          const fit = await fetchOriginalFitSummary(model.id)
          requests++
          record.calories = fit.summary?.totalCalories ?? null
          record.caloriesSynced = true
          caloriesFetched++
          console.log(`  ${label} 卡路里：${record.calories ?? '原始文件里没有'}`)
        }
        catch (error) {
          if (error instanceof StravaSessionExpiredError) {
            throw error
          }

          console.warn(`  ${label} 卡路里同步失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }

      known.set(model.id, record)
      if (isNew) {
        newActivities++
      }

      processed++
      if (processed % flushEvery === 0) {
        await flush()
        console.log(`  …已落盘（本次已处理 ${processed} 条）`)
      }
    }
  }

  if (options.full && scanComplete) {
    for (const id of [...known.keys()]) {
      if (!scannedIds.has(id)) {
        known.delete(id)
      }
    }
  }
  else if (options.full) {
    console.warn('警告：本次扫描未覆盖全部活动（到达数量或页数上限），已跳过 --full 的清理步骤。')
  }

  await flush()
  const removedTracks = await pruneTracks([...known.values()])

  const dataset = buildDataset([...known.values()], params, existing)
  console.log('\n同步完成：')
  console.log(`  活动总数 ${dataset.summary.activityCount}（新增 ${newActivities}，本次刷新指标 ${updatedMetrics}）`)
  console.log(`  有轨迹 ${dataset.summary.trackCount}，缺卡路里 ${dataset.summary.calorieMissing}`)
  console.log(`  本次新拉轨迹 ${tracksFetched}${trackFailed > 0 ? `，判定无轨迹 ${trackFailed}` : ''}；新拉卡路里 ${caloriesFetched}`)
  console.log(`  跳过私密活动 ${skippedPrivate}，清理无用轨迹文件 ${removedTracks}`)
  console.log(`  请求数约 ${requests}${reachedLimit ? `（已到本次上限 ${options.limit} 条，再跑一次可继续）` : ''}`)
  console.log(`  时间范围 ${dataset.summary.firstActivityAt} → ${dataset.summary.lastActivityAt}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
