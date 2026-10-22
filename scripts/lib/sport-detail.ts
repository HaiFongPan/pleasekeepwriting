/**
 * 详情曲线流水线：把原始 streams / FIT record 抽样成弹窗用的小文件。
 *
 * 隐私要点：只发布速度与步频/踏频。不输出经纬度、开始时刻、心率、海拔和功率；
 * 时间只保留"从开始算起的移动秒数"，路线位置复用轨迹的取景投影，落在隐私圈里的点写 null。
 */

import type { SportDetailFile, SportKind } from '../../src/types/strava'
import type { TrackFrame, TrackPoint } from './strava-track'

/** 与时间流对齐的原始通道；缺失的值用 null */
export interface DetailStreams {
  /** 秒，相对第一个点，单调不减 */
  time: number[]
  /** 米，累计距离 */
  distance?: Array<number | null> | null
  /** 米/秒 */
  velocity?: Array<number | null> | null
  /** 设备原值：骑行 rpm，跑步/步行是单脚步频 */
  cadence?: Array<number | null> | null
  /** Strava 的 moving 流；缺失时按速度判定 */
  moving?: boolean[] | null
  latlng?: Array<TrackPoint | null> | null
}

export interface DetailBuildOptions {
  kind: SportKind
  /** 轨迹的取景，下标对齐 streams；没有轨迹时不输出 xy */
  frame?: TrackFrame | null
  samples?: number
}

const defaultSamples = 300
const minRawPoints = 10
/** 距离轴至少要这么长，否则按时间轴（原地 HIIT 的漂移距离不算数） */
const minDistanceAxis = 200
/** 低于这个速度视为停下，不计移动时间 */
const stopSpeed = 0.3
/** 一个通道有效值不到这个比例就整条丢弃 */
const minChannelCoverage = 0.3

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function aligned<T>(values: T[] | null | undefined, length: number): T[] | null {
  return values && values.length === length ? values : null
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 区间均值，忽略 null；全空返回 null */
function bucketMean(values: Array<number | null> | null, from: number, to: number): number | null {
  if (!values) {
    return null
  }

  let sum = 0
  let count = 0
  for (let index = from; index <= to; index++) {
    const value = values[index]
    if (finite(value)) {
      sum += value
      count++
    }
  }

  return count > 0 ? sum / count : null
}

/** 距离流可能有 null 或回跳，前向填充成单调不减 */
function monotonicDistance(distance: Array<number | null>): number[] {
  const result: number[] = []
  let last = 0
  for (const value of distance) {
    if (finite(value) && value > last) {
      last = value
    }

    result.push(last)
  }

  return result
}

/** 累计移动时间：优先用 moving 流，否则按段速度判定 */
function movingSeconds(time: number[], distance: number[] | null, moving: boolean[] | null): number[] {
  const result = [0]
  for (let index = 1; index < time.length; index++) {
    const dt = Math.max(0, time[index] - time[index - 1])
    let isMoving = true
    if (moving) {
      isMoving = moving[index]
    }
    else if (distance) {
      isMoving = dt > 0 && (distance[index] - distance[index - 1]) / dt >= stopSpeed
    }

    result.push(result[index - 1] + (isMoving ? dt : 0))
  }

  return result
}

function keepChannel(values: Array<number | null>): Array<number | null> | undefined {
  const valid = values.filter(finite).length
  return valid / values.length >= minChannelCoverage ? values : undefined
}

/** 跑步、徒步、步行的设备步频是单脚，展示统一换成双脚 spm */
function cadenceFactor(kind: SportKind): number {
  return kind === 'run' || kind === 'hike' || kind === 'walk' ? 2 : 1
}

export function buildDetailFile(streams: DetailStreams, options: DetailBuildOptions): SportDetailFile | null {
  const { time } = streams
  const length = time.length
  if (length < minRawPoints || !time.every(finite)) {
    return null
  }

  const rawDistance = aligned(streams.distance, length)
  const distance = rawDistance ? monotonicDistance(rawDistance) : null
  const axis: SportDetailFile['axis'] = distance && distance[length - 1] >= minDistanceAxis ? 'distance' : 'time'
  // 室内训练的漂移距离不能用来判停，时间轴只认 moving 流
  const moving = movingSeconds(time, axis === 'distance' ? distance : null, aligned(streams.moving, length))
  // 时间轴用移动时间，避免暂停把曲线拉出一段空白
  const axisValues = axis === 'distance' ? distance as number[] : moving
  const total = axisValues[length - 1]
  if (total <= 0) {
    return null
  }

  const samples = Math.max(2, Math.min(options.samples ?? defaultSamples, length))
  const velocity = aligned(streams.velocity, length)
  const cadence = aligned(streams.cadence, length)
  const latlng = aligned(streams.latlng, length)
  const frame = options.frame && latlng ? options.frame : null
  const factor = cadenceFactor(options.kind)

  const d: number[] = []
  const t: number[] = []
  const spd: Array<number | null> = []
  const cad: Array<number | null> = []
  const xy: Array<[number, number] | null> = []

  // 每个抽样点代表横轴上等宽的一段，取段内均值；段末的累计值作为该点的位置
  let from = 0
  let previousEnd = 0
  for (let sample = 0; sample < samples; sample++) {
    const boundary = total * (sample + 1) / samples
    let to = from
    while (to + 1 < length && axisValues[to + 1] <= boundary) {
      to++
    }

    if (sample === samples - 1) {
      to = length - 1
    }

    d.push(axis === 'distance' ? Math.round((distance as number[])[to]) : 0)
    t.push(Math.round(moving[to]))
    cad.push(nullableRound(scale(bucketMean(cadence, from, to), factor), 0))

    // 速度：段内移动距离 / 移动时间，比设备的瞬时速度更稳；没有距离时退回速度流
    const segmentTime = moving[to] - moving[previousEnd]
    const segmentDistance = distance ? distance[to] - distance[previousEnd] : null
    const derived = segmentDistance != null && segmentTime > 0 ? segmentDistance / segmentTime : null
    spd.push(nullableRound(derived ?? bucketMean(velocity, from, to), 2))

    if (frame) {
      xy.push(pickPosition(latlng as Array<TrackPoint | null>, frame, from, to))
    }

    previousEnd = to
    from = Math.min(length - 1, to + 1)
  }

  const speed = axis === 'distance' ? keepChannel(spd) : undefined
  const cadenceChannel = keepChannel(cad)
  // 室内训练没有速度也没有步频时，没有可画的曲线，不生成文件
  if (!speed && !cadenceChannel) {
    return null
  }

  const file: SportDetailFile = { v: 2, axis, t }
  if (axis === 'distance') {
    file.d = d
  }

  if (speed) {
    file.spd = speed
  }

  if (cadenceChannel) {
    file.cad = cadenceChannel
  }

  if (frame && xy.some(point => point != null)) {
    file.xy = xy
  }

  return file
}

function scale(value: number | null, factor: number): number | null {
  return value == null ? null : value * factor
}

function nullableRound(value: number | null, digits: number): number | null {
  return value == null ? null : round(value, digits)
}

/** 段中点附近、落在保留区间里的第一个有坐标的点；都在隐私圈里时返回 null */
function pickPosition(latlng: Array<TrackPoint | null>, frame: TrackFrame, from: number, to: number): [number, number] | null {
  const middle = Math.round((from + to) / 2)
  for (let offset = 0; offset <= to - from; offset++) {
    for (const index of [middle - offset, middle + offset]) {
      if (index < from || index > to || index < frame.from || index > frame.to) {
        continue
      }

      const point = latlng[index]
      if (point) {
        return frame.project(point)
      }
    }
  }

  return null
}
