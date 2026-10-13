/**
 * 运动数据的展示逻辑：分组、文案、数值格式化。
 *
 * 时间口径：Strava 训练日志的 start_date_local_raw 是"本地墙上时间当 UTC"的
 * epoch（本地 20:11 的骑行，raw 读作 UTC 就是 20:11），因此所有格式化都用
 * UTC 读法，绝不能用本地时区再换算一次。
 */

import type { SportActivity, SportKind } from '@/types/strava'

export const sportKindLabels: Record<SportKind, string> = {
  ride: '骑行',
  run: '跑步',
  hike: '远足',
  walk: '健走',
  swim: '游泳',
  other: '',
}

/** Strava sport_type 归一到分组，用于卡片文案；未收录的归到 other */
export function resolveSportKind(sportType: string): SportKind {
  const normalized = sportType.toLowerCase()

  if (normalized.includes('swim')) {
    return 'swim'
  }

  if (normalized.includes('ride') || normalized.includes('bike') || normalized.includes('cycling') || normalized.includes('velomobile') || normalized.includes('handcycle')) {
    return 'ride'
  }

  if (normalized.includes('hike')) {
    return 'hike'
  }

  if (normalized.includes('walk')) {
    return 'walk'
  }

  if (normalized.includes('run')) {
    return 'run'
  }

  return 'other'
}

/**
 * 悬停上色指标：统一按速度（红=快、绿=慢）。
 * 之前徒步用爬升率，但上坡必然慢，两套口径反而绕，所以合并成一套；
 * 将来若要按类型区分，在这里改即可（'grade' 的算法仍保留在 lib/strava-metrics.ts）。
 */
export function resolveMetricKind(_kind: SportKind): 'speed' | 'grade' | null {
  return 'speed'
}

/** 星期词，Strava 默认名可能是 "Sunday Evening Cycle" 或 "周日傍晚骑行" */
const weekdayWords = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  '周一',
  '周二',
  '周三',
  '周四',
  '周五',
  '周六',
  '周日',
  '周天',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
  '星期日',
  '星期天',
]

/** 时段词 */
const timeOfDayWords = [
  'morning',
  'lunch',
  'afternoon',
  'evening',
  'night',
  '早上',
  '上午',
  '中午',
  '午间',
  '下午',
  '傍晚',
  '晚上',
  '夜间',
  '凌晨',
  '晨间',
]

/** 各运动类型在 Strava 默认名里出现过的项目词 */
const sportWords: Record<string, string[]> = {
  Ride: ['ride', 'cycle', 'cycling', 'bike', 'biking', '骑行', '自行车'],
  VirtualRide: ['virtual ride', 'ride', 'cycle', '骑行'],
  EBikeRide: ['e-bike ride', 'ride', 'cycle', '骑行'],
  GravelRide: ['gravel ride', 'ride', 'cycle', '骑行'],
  MountainBikeRide: ['mountain bike ride', 'ride', 'cycle', '骑行'],
  Run: ['run', 'running', 'indoor run', 'treadmill run', '户外跑', '室内跑', '跑步'],
  VirtualRun: ['virtual run', 'run', '跑步'],
  TrailRun: ['trail run', 'run', '越野跑', '跑步'],
  Hike: ['hike', 'hiking', '远足', '徒步'],
  Walk: ['walk', 'walking', '健走', '步行'],
  Swim: ['swim', 'swimming', '游泳'],
  WeightTraining: ['weight training', 'strength training', 'weights', '举重训练', '力量训练'],
  Workout: ['workout', 'other indoor', 'indoor', 'hiit', 'strength training', '锻炼', '训练'],
  HighIntensityIntervalTraining: ['hiit', 'high intensity interval training', '高强度间歇训练', '锻炼'],
  Elliptical: ['elliptical', '椭圆机'],
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '')
}

function stripPrefix(value: string, prefixes: string[]): string {
  for (const prefix of prefixes) {
    const normalized = normalizeName(prefix)
    if (normalized && value.startsWith(normalized)) {
      return value.slice(normalized.length)
    }
  }

  return value
}

/**
 * 判断活动名称是不是 Strava 自动生成的默认名。
 * 默认名形如「[星期][时段]项目」，例如 Sunday Evening Cycle / Friday Morning Indoor Run / 傍晚骑行。
 * 中文与英文混排、有无空格都能识别；识别不出的一律当作改过名。
 */
export function isDefaultActivityName(name: string | null | undefined, sportType: string, displayType: string): boolean {
  if (!name) {
    return true
  }

  const candidates = new Set<string>()
  for (const word of [...(sportWords[sportType] ?? []), sportType, displayType]) {
    if (word) {
      candidates.add(normalizeName(word))
    }
  }

  let rest = normalizeName(name)
  rest = stripPrefix(rest, weekdayWords)
  rest = stripPrefix(rest, timeOfDayWords)

  // 「星期 + 时段 + 项目」以外，也见过只有项目名的默认名
  return candidates.has(rest)
}

/**
 * 卡片上的类型文案：主要分组用中文标签，其余（HIIT、举重训练等）
 * 直接用 Strava 返回的本地化类型名；改过名称的活动拼成「类型·名称」。
 */
export function getSportLabel(activity: Pick<SportActivity, 'kind' | 'displayType' | 'sportType' | 'name'>): string {
  const base = sportKindLabels[activity.kind] || activity.displayType || activity.sportType
  if (isDefaultActivityName(activity.name, activity.sportType, activity.displayType)) {
    return base
  }

  return `${base}·${(activity.name as string).trim()}`
}

/** 本地日期 YYYY-MM-DD */
export function formatLocalDate(start: number): string {
  const date = new Date(start * 1000)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}-${day}`
}

/** 本地年份，用于按年分组 */
export function getLocalYear(start: number): number {
  return new Date(start * 1000).getUTCFullYear()
}

/** 卡片上的日期文案：MM-DD */
export function formatShortDate(start: number): string {
  return formatLocalDate(start).slice(5)
}

/** 距离文案：默认公里两位小数 */
export function formatDistance(meters: number, units: 'metric' | 'imperial' = 'metric'): string {
  if (units === 'imperial') {
    return `${(meters / 1609.344).toFixed(2)}mi`
  }

  return `${(meters / 1000).toFixed(2)}km`
}

/** 时长文案：超过一小时用 h:mm:ss，否则 m:ss */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
  }

  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/** 卡路里文案，缺失显示为 — */
export function formatCalories(calories: number | null): string {
  if (calories == null || calories <= 0) {
    return '—'
  }

  return `${Math.round(calories)}`
}

/** 按年份分组，年份从新到旧（输入需已按时间倒序） */
export function groupByYear(activities: SportActivity[]): Array<{ year: number, activities: SportActivity[] }> {
  const groups = new Map<number, SportActivity[]>()

  for (const activity of activities) {
    const year = getLocalYear(activity.start)
    const bucket = groups.get(year)
    if (bucket) {
      bucket.push(activity)
    }
    else {
      groups.set(year, [activity])
    }
  }

  return [...groups.entries()].map(([year, items]) => ({ year, activities: items }))
}

export interface SportYearTotals {
  count: number
  distance: number
  movingMinutes: number
  /** 各分组的总距离，用于顶部统计 */
  byKind: Partial<Record<SportKind, number>>
}

export interface SportIndex {
  /** 年份，从新到旧 */
  years: number[]
  totals: Record<string, SportYearTotals>
  /** 只含有活动的日期：YYYY-MM-DD -> 移动分钟数（活力图用） */
  days: Record<string, number>
}

/** 预计算活力图与顶部统计需要的数据，避免把明细重复塞进页面 */
export function buildSportIndex(activities: SportActivity[]): SportIndex {
  const years = new Set<number>()
  const totals: Record<string, SportYearTotals> = {}
  const days: Record<string, number> = {}

  for (const activity of activities) {
    const year = getLocalYear(activity.start)
    const key = String(year)
    years.add(year)

    const total = totals[key] ?? { count: 0, distance: 0, movingMinutes: 0, byKind: {} }
    total.count++
    total.distance += activity.distance
    total.movingMinutes += activity.movingTime / 60
    total.byKind[activity.kind] = (total.byKind[activity.kind] ?? 0) + activity.distance
    totals[key] = total

    const date = formatLocalDate(activity.start)
    days[date] = (days[date] ?? 0) + activity.movingTime / 60
  }

  // 取整，避免 JSON 里出现 1418.0333333333333 这种浮点噪声
  for (const total of Object.values(totals)) {
    total.distance = Math.round(total.distance)
    total.movingMinutes = Math.round(total.movingMinutes)
    for (const kind of Object.keys(total.byKind)) {
      total.byKind[kind as SportKind] = Math.round(total.byKind[kind as SportKind] as number)
    }
  }

  for (const date of Object.keys(days)) {
    days[date] = Math.round(days[date])
  }

  return {
    years: [...years].sort((left, right) => right - left),
    totals,
    days,
  }
}

/** 汇总多个月份或全部年份的统计 */
export function sumYearTotals(index: SportIndex, years: number[]): SportYearTotals {
  const result: SportYearTotals = { count: 0, distance: 0, movingMinutes: 0, byKind: {} }

  for (const year of years) {
    const total = index.totals[String(year)]
    if (!total) {
      continue
    }

    result.count += total.count
    result.distance += total.distance
    result.movingMinutes += total.movingMinutes
    for (const [kind, distance] of Object.entries(total.byKind)) {
      result.byKind[kind as SportKind] = (result.byKind[kind as SportKind] ?? 0) + (distance ?? 0)
    }
  }

  return result
}
