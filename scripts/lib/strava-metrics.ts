/**
 * 从 Strava streams 计算"每段一个等级"的指标，供卡片悬停时给轨迹上色。
 *
 * 等级 0..15：0 = 绿（慢 / 下坡），15 = 红（快 / 上坡），中间过渡到黄。
 * 全部在构建期算完，浏览器只拿到一个 hex 字符串。
 */

/** 上色指标：速度（跑步/骑行）或爬升率（徒步） */
export type TrackMetricKind = 'speed' | 'grade'

export interface MetricStreams {
  /** 秒，与 latlng 对齐 */
  time?: number[] | null
  /** 米，累计距离 */
  distance?: number[] | null
  /** 米 */
  altitude?: number[] | null
}

/** 每段一个等级，长度 = 点数 - 1 */
export interface MetricLevels {
  kind: TrackMetricKind
  levels: Uint8Array
}

const levelCount = 16
/** 速度按里程窗口计算，避免 GPS 点太密时用相邻点求差导致噪声 */
const speedDistanceWindow = 30
/** 爬升率按里程窗口计算 */
const gradeDistanceWindow = 25
/** 海拔预平滑窗口（段数） */
const altWindow = 5
/** 结果轻度平滑（段数） */
const resultWindow = 3
/** 爬升率映射范围：±8% 对应绿/红两端 */
const gradeClampPercent = 8
/** 速度分布过窄时不硬凑对比 */
const minSpeedRange = 0.3

function mean(values: ArrayLike<number>, from: number, to: number): number {
  let sum = 0
  let count = 0
  for (let index = from; index < to; index++) {
    sum += values[index]
    count++
  }

  return count > 0 ? sum / count : 0
}

/** 居中滑动平均，长度不变 */
function smooth(values: number[], window: number): number[] {
  if (values.length <= 2 || window <= 1) {
    return values
  }

  const half = Math.floor(window / 2)
  return values.map((_, index) => {
    const from = Math.max(0, index - half)
    const to = Math.min(values.length, index + half + 1)
    return mean(values, from, to)
  })
}

function quantile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) {
    return 0
  }

  const position = (sorted.length - 1) * ratio
  const low = Math.floor(position)
  const high = Math.ceil(position)
  if (low === high) {
    return sorted[low]
  }

  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

function toLevel(ratio: number): number {
  const clamped = Math.max(0, Math.min(1, ratio))
  return Math.max(0, Math.min(levelCount - 1, Math.round(clamped * (levelCount - 1))))
}

/**
 * 按里程窗口找终点下标：从 start 出发累积到至少 minDistance 米。
 * 密集采样（相邻点不到 1 米）时用相邻点求差会把结果打成噪声，所以统一走窗口。
 */
function findWindowEnd(distance: number[], start: number, minDistance: number): number {
  let end = start + 1
  while (end + 1 < distance.length && distance[end] - distance[start] < minDistance) {
    end++
  }

  return end
}

/** 按速度上色：快 = 红，慢 = 绿（跑步 / 骑行） */
export function computeSpeedLevels(streams: MetricStreams): MetricLevels | null {
  const { time, distance } = streams
  if (!time || !distance || time.length < 3 || distance.length !== time.length) {
    return null
  }

  const rawSpeeds: number[] = []
  for (let index = 0; index < time.length - 1; index++) {
    const end = findWindowEnd(distance, index, speedDistanceWindow)
    const deltaTime = time[end] - time[index]
    const deltaDistance = distance[end] - distance[index]
    // 停下来（距离不变）或时间异常时记为 0，正好落到绿色
    rawSpeeds.push(deltaTime > 0 && deltaDistance > 0 ? deltaDistance / deltaTime : 0)
  }

  const speeds = smooth(rawSpeeds, resultWindow)
  const moving = speeds.filter(speed => speed > 0).sort((left, right) => left - right)
  if (moving.length === 0) {
    return null
  }

  const low = quantile(moving, 0.1)
  const high = quantile(moving, 0.9)
  const range = high - low
  const levels = new Uint8Array(speeds.length)

  for (let index = 0; index < speeds.length; index++) {
    levels[index] = range < minSpeedRange
      ? Math.floor((levelCount - 1) / 2)
      : toLevel((speeds[index] - low) / range)
  }

  return { kind: 'speed', levels }
}

/** 按爬升率上色：上坡 = 红，下坡 = 绿（徒步） */
export function computeGradeLevels(streams: MetricStreams): MetricLevels | null {
  const { distance, altitude } = streams
  if (!distance || !altitude || distance.length < 3 || altitude.length !== distance.length) {
    return null
  }

  const altitudeRange = Math.max(...altitude) - Math.min(...altitude)
  // 海拔基本没变化时不做爬升上色
  if (altitudeRange < 5) {
    return null
  }

  const smoothedAltitude = smooth(altitude, altWindow)
  const rawGrades: number[] = []
  for (let index = 0; index < distance.length - 1; index++) {
    const end = findWindowEnd(distance, index, gradeDistanceWindow)
    const deltaDistance = distance[end] - distance[index]
    const deltaAltitude = smoothedAltitude[end] - smoothedAltitude[index]
    rawGrades.push(deltaDistance > 1 ? (deltaAltitude / deltaDistance) * 100 : 0)
  }

  const grades = smooth(rawGrades, resultWindow)
  const levels = new Uint8Array(grades.length)
  for (let index = 0; index < grades.length; index++) {
    levels[index] = toLevel((grades[index] + gradeClampPercent) / (gradeClampPercent * 2))
  }

  return { kind: 'grade', levels }
}

/** 等级数组 -> hex 字符串，一段一个字符 */
export function levelsToHex(levels: ArrayLike<number>): string {
  let output = ''
  for (let index = 0; index < levels.length; index++) {
    output += levels[index].toString(16)
  }

  return output
}

/** 取某段原始等级区间的平均值，用于简化后把多段合成一段 */
export function aggregateLevels(levels: ArrayLike<number>, from: number, to: number): number {
  if (to <= from) {
    return from < levels.length ? levels[from] : 8
  }

  return Math.round(mean(levels, from, Math.min(to, levels.length)))
}

export { levelCount }
