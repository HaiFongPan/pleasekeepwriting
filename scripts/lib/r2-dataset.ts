/**
 * 把历史归档 manifest 与手机 FIT 记录合并成站点数据集。
 *
 * 迁移原则：
 *   - 旧数值 Strava ID 原样保留，手机上传用 identity 的 64 位十六进制 ID；
 *   - 已有展示元信息（卡路里、卡路里同步标记、轨迹）不因重建而丢失或回退；
 *   - 归档明确标记 private 的历史活动从公开数据集移除；
 *   - 归档缺失的旧数值活动只保留并告警，不自动删除（等待明确的删除授权）；
 *   - 数据与渲染参数都没变时沿用旧 generatedAt，保证空增量零 diff。
 */

import type { SportActivitiesData, SportActivity, SportKind, SportRenderParams } from '../../src/types/strava'
import type { ArchivedActivity } from './r2-archive'
import { compareActivityIdsDesc, formatLocalDate, resolveSportKind } from '../../src/utils/sport'

export function activityIdKey(id: SportActivity['id']): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`
}

/** 历史 manifest -> 展示记录；缺省字段从旧数据继承，卡路里绝不回退 */
export function historyActivityFromManifest(activity: ArchivedActivity, previous?: SportActivity): SportActivity {
  const start = activity.start_date_local_raw
  return {
    id: activity.id,
    sportType: activity.sport_type,
    displayType: activity.display_type,
    name: activity.name,
    kind: resolveSportKind(activity.sport_type),
    start,
    date: formatLocalDate(start),
    distance: activity.distance_raw,
    movingTime: activity.moving_time_raw,
    elapsedTime: activity.elapsed_time_raw,
    calories: previous?.calories ?? null,
    caloriesSynced: previous?.caloriesSynced ?? false,
    elevation: activity.elevation_gain_raw ?? previous?.elevation ?? null,
    hasGps: activity.has_latlng,
    track: previous?.track ?? false,
    trackSynced: previous?.trackSynced ?? false,
  }
}

export interface PhoneActivityInput {
  activityId: string
  /** 展示时区下的「本地墙上时间当 UTC」epoch */
  start: number
  sportType: string
  displayType: string
  kind: SportKind
  distance: number
  /** 设备 total_timer_time，不是 Strava movingTime */
  movingTime: number
  elapsedTime: number
  calories: number | null
  elevation: number | null
  hasGps: boolean
  track: boolean
  trackSynced: boolean
}

/** 手机 FIT -> 展示记录；显式标注 device-timer 口径与 phone 来源 */
export function phoneActivityFromFit(input: PhoneActivityInput, previous?: SportActivity): SportActivity {
  return {
    id: input.activityId,
    sportType: input.sportType,
    displayType: input.displayType,
    name: null,
    kind: input.kind,
    start: input.start,
    date: formatLocalDate(input.start),
    distance: input.distance,
    movingTime: input.movingTime,
    elapsedTime: input.elapsedTime,
    calories: previous?.calories ?? input.calories ?? null,
    caloriesSynced: true,
    elevation: input.elevation ?? previous?.elevation ?? null,
    hasGps: input.hasGps,
    track: input.track,
    trackSynced: input.trackSynced,
    timeSource: 'device-timer',
    origin: 'phone',
  }
}

export interface MergeDatasetInput {
  params: SportRenderParams
  previous: SportActivitiesData | null
  /** 本次归档里可公开的历史记录 */
  history: SportActivity[]
  /** 本次归档里出现的全部数值 ID（含私密），用于识别本地多了哪些历史 */
  manifestIds: Set<number>
  /** 归档明确标记私密的历史 ID，需要从公开数据集中移除 */
  privateIds: Set<number>
  /** 未命中历史去重、需要展示的手机记录 */
  phones: SportActivity[]
  /** 本次手机前缀里出现的全部对象 ID */
  phoneIds: Set<string>
}

export interface MergeDatasetResult {
  data: SportActivitiesData
  warnings: {
    /** 本地有、但归档 manifest 集合里没有的旧历史（保留并告警） */
    missingHistoryIds: number[]
    /** 因归档标记私密而移除的公开历史 */
    removedPrivateIds: number[]
    /** 手机对象已从 R2 消失而移除的展示记录 */
    removedPhoneIds: string[]
  }
}

function paramsEqual(left: SportRenderParams | undefined, right: SportRenderParams): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function mergeDataset(input: MergeDatasetInput): MergeDatasetResult {
  const records = new Map<string, SportActivity>()
  for (const activity of input.history) {
    records.set(activityIdKey(activity.id), activity)
  }

  for (const activity of input.phones) {
    records.set(activityIdKey(activity.id), activity)
  }

  const warnings: MergeDatasetResult['warnings'] = {
    missingHistoryIds: [],
    removedPrivateIds: [],
    removedPhoneIds: [],
  }

  for (const activity of input.previous?.activities ?? []) {
    if (typeof activity.id === 'string') {
      if (!input.phoneIds.has(activity.id)) {
        warnings.removedPhoneIds.push(activity.id)
      }

      continue
    }

    if (input.privateIds.has(activity.id)) {
      // 归档明确 private：无论旧数据是否在展示，都不保留公开记录
      if (records.has(activityIdKey(activity.id))) {
        records.delete(activityIdKey(activity.id))
      }

      warnings.removedPrivateIds.push(activity.id)
      continue
    }

    const key = activityIdKey(activity.id)
    if (records.has(key)) {
      continue
    }

    // 归档里没有这条旧历史：保守保留，等待明确的删除授权
    records.set(key, activity)
    warnings.missingHistoryIds.push(activity.id)
  }

  const activities = [...records.values()].sort((left, right) =>
    right.start - left.start || compareActivityIdsDesc(left.id, right.id),
  )

  const previous = input.previous
  const unchanged = previous != null
    && paramsEqual(previous.params, input.params)
    && JSON.stringify(previous.activities) === JSON.stringify(activities)

  const withTrack = activities.filter(activity => activity.track).length
  const missingCalories = activities.filter(activity => activity.calories == null).length

  return {
    data: {
      generatedAt: unchanged && previous ? previous.generatedAt : new Date().toISOString(),
      source: { provider: 'strava', athleteId: null },
      params: input.params,
      summary: {
        activityCount: activities.length,
        trackCount: withTrack,
        calorieMissing: missingCalories,
        firstActivityAt: activities.length > 0 ? activities[activities.length - 1].date : null,
        lastActivityAt: activities.length > 0 ? activities[0].date : null,
      },
      activities,
    },
    warnings,
  }
}
