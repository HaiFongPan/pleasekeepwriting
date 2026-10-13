/**
 * 轨迹流水线：把 Strava 的 encoded polyline 变成只含归一化几何的 SVG 路径。
 *
 * 隐私要点：输出里没有经纬度、没有城市、没有海拔，只有已经缩放平移到 viewBox 的
 * 图形坐标，无法据此反查位置。构建期（而非浏览器）完成全部几何计算。
 */

import type { SportTrackFile } from '../../src/types/strava'
import type { MetricLevels } from './strava-metrics'
import { aggregateLevels, levelsToHex } from './strava-metrics'

export interface TrackPoint {
  lat: number
  lng: number
}

export interface TrackBuildOptions {
  /** viewBox 宽高，卡片会按 aspect 等比显示 */
  viewBox: [number, number]
  /** 四周留白，viewBox 单位 */
  padding: number
  /** 隐私圈：丢掉起点/终点该距离内的轨迹点，单位米 */
  trimStartMeters: number
  /** 至少保留的里程比例，短活动会按比例收小隐私圈 */
  minRetainRatio: number
  /** 隐私圈半径下限，单位米 */
  minTrimMeters: number
  /** 简化容差，单位米 */
  simplifyTolerance: number
  /** 简化后允许的最大点数 */
  maxPoints: number
  /** 是否输出地图中心（用于将来接底图） */
  showMap: boolean
}

export const defaultTrackOptions: TrackBuildOptions = {
  viewBox: [100, 62],
  padding: 6,
  trimStartMeters: 200,
  minRetainRatio: 0.5,
  minTrimMeters: 50,
  simplifyTolerance: 5,
  maxPoints: 200,
  showMap: false,
}

export type TrackBuildOutcome = TrackRender | TrackNone

export interface TrackRender {
  kind: 'track'
  file: SportTrackFile
  stats: TrackStats
}

export interface TrackNone {
  kind: 'none'
  reason: 'empty' | 'too-short' | 'degenerate'
  stats: TrackStats
}

export interface TrackStats {
  rawPoints: number
  trimmedHead: number
  trimmedTail: number
  /** 实际使用的隐私圈半径，短活动会小于配置值 */
  trimRadius: number
  /** 裁剪后保留的里程比例 */
  retainedRatio: number
  simplifiedPoints: number
  pathChars: number
}

const earthRadiusMeters = 6378137
const minPoints = 8
const minExtentMeters = 25

/** 解码 Google encoded polyline（Strava 用 precision 5） */
export function decodePolyline(encoded: string, precision = 5): TrackPoint[] {
  const factor = 10 ** precision
  const points: TrackPoint[] = []
  let index = 0
  let lat = 0
  let lng = 0

  while (index < encoded.length) {
    const latStep = decodeValue(encoded, index)
    index = latStep.next
    const lngStep = decodeValue(encoded, index)
    index = lngStep.next
    lat += latStep.delta
    lng += lngStep.delta
    points.push({ lat: lat / factor, lng: lng / factor })
  }

  return points
}

function decodeValue(encoded: string, start: number): { delta: number, next: number } {
  let shift = 0
  let result = 0
  let index = start
  let byte = 0x20

  while (byte >= 0x20) {
    byte = encoded.charCodeAt(index++) - 63
    result |= (byte & 0x1F) << shift
    shift += 5
  }

  const delta = result & 1 ? ~(result >> 1) : result >> 1
  return { delta, next: index }
}

/** 两点间的球面距离，单位米 */
export function haversineMeters(a: TrackPoint, b: TrackPoint): number {
  const toRadians = (value: number) => (value * Math.PI) / 180
  const dLat = toRadians(b.lat - a.lat)
  const dLng = toRadians(b.lng - a.lng)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** 沿轨迹的累计距离，单位米 */
function cumulativeMeters(points: TrackPoint[]): number[] {
  const cumulative: number[] = [0]

  for (let index = 1; index < points.length; index++) {
    cumulative.push(cumulative[index - 1] + haversineMeters(points[index - 1], points[index]))
  }

  return cumulative
}

/** 按给定半径找出要保留的下标区间 */
function findTrimRange(points: TrackPoint[], radius: number): { startIndex: number, endIndex: number } {
  const first = points[0]
  let head = 0
  while (head + 1 < points.length && haversineMeters(first, points[head + 1]) < radius) {
    head++
  }

  const last = points[points.length - 1]
  let tail = 0
  while (tail + 1 < points.length && haversineMeters(last, points[points.length - 2 - tail]) < radius) {
    tail++
  }

  return { startIndex: head + 1, endIndex: points.length - 1 - tail }
}

/**
 * 裁掉起终点附近 radius 内的点，形成隐私缺口。
 * 若整条轨迹都在圈内，返回空数组，由调用方判定为无轨迹。
 */
export function trimEnds(points: TrackPoint[], radius: number): { points: TrackPoint[], head: number, tail: number } {
  if (radius <= 0 || points.length < 3) {
    return { points, head: 0, tail: 0 }
  }

  const { startIndex, endIndex } = findTrimRange(points, radius)
  if (startIndex > endIndex) {
    return { points: [], head: points.length, tail: 0 }
  }

  return {
    points: points.slice(startIndex, endIndex + 1),
    head: startIndex,
    tail: points.length - 1 - endIndex,
  }
}

export interface TrimOptions {
  /** 期望的隐私圈半径，单位米 */
  privacyMeters: number
  /** 至少保留的里程比例，避免短活动被裁成线团 */
  minRetainRatio: number
  /** 隐私圈半径下限，不会为了凑比例降到这个值以下 */
  minTrimMeters: number
}

export interface TrimResult {
  points: TrackPoint[]
  /** 裁掉的头部点数 */
  head: number
  /** 裁掉的尾部点数 */
  tail: number
  /** 实际使用的隐私圈半径 */
  radius: number
  /** 裁剪后保留的里程比例 */
  retainedRatio: number
}

/**
 * 自适应裁剪：优先用 privacyMeters，若保留里程不足 minRetainRatio，
 * 就按档位收小半径到刚好够（下限 minTrimMeters）。
 * 半径越小保留越多，保留比例关于半径单调递减。
 */
export function trimEndsAdaptive(points: TrackPoint[], options: TrimOptions): TrimResult {
  if (options.privacyMeters <= 0 || points.length < 3) {
    return { points, head: 0, tail: 0, radius: 0, retainedRatio: 1 }
  }

  const cumulative = cumulativeMeters(points)
  const total = cumulative[cumulative.length - 1]

  const evaluate = (radius: number) => {
    const { startIndex, endIndex } = findTrimRange(points, radius)
    if (startIndex > endIndex || total <= 0) {
      return { startIndex, endIndex, retained: 0 }
    }

    const lostHead = cumulative[startIndex]
    const lostTail = total - cumulative[endIndex]
    return { startIndex, endIndex, retained: Math.max(0, total - lostHead - lostTail) }
  }

  const target = total * options.minRetainRatio
  const floor = Math.min(options.minTrimMeters, options.privacyMeters)

  let radius = options.privacyMeters
  let best = evaluate(radius)

  if (best.retained < target) {
    // 保留比例关于半径单调递减，但"整条轨迹都落在圆内"会让它在某一点突然掉到 0。
    // 二分因此会挑到 199.5 这种只比配置小一点的退化解（既没保住形状也没保护隐私），
    // 所以改成按固定档位从大到小找第一个满足比例的半径。
    const ladder = [1, 0.75, 0.5, 0.375, 0.25, 0.125]
      .map(fraction => Math.round(options.privacyMeters * fraction))
      .filter(candidate => candidate >= floor)
      .concat(floor)

    radius = floor
    best = evaluate(floor)

    for (const candidate of ladder) {
      const evaluated = evaluate(candidate)
      if (evaluated.retained >= target) {
        radius = candidate
        best = evaluated
        break
      }
    }
  }

  const startIndex = Math.max(0, Math.min(best.startIndex, points.length - 1))
  const endIndex = Math.max(startIndex, Math.min(best.endIndex, points.length - 1))
  const retained = Math.max(0, cumulative[endIndex] - cumulative[startIndex])

  return {
    points: points.slice(startIndex, endIndex + 1),
    head: startIndex,
    tail: points.length - 1 - endIndex,
    radius: Math.round(radius),
    retainedRatio: total > 0 ? retained / total : 0,
  }
}

/** 球面 Mercator 投影，输出米制平面坐标，正北朝上，形状与真实比例一致 */
export function projectMercator(point: TrackPoint): [number, number] {
  const x = (point.lng * Math.PI / 180) * earthRadiusMeters
  const clampedLat = Math.max(-85, Math.min(85, point.lat))
  const y = Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI / 180) / 2)) * earthRadiusMeters
  return [x, y]
}

/** Douglas-Peucker 简化，迭代实现，返回保留下来的下标（等级数据要对齐回来） */
function simplifyIndices(points: Array<[number, number]>, tolerance: number): number[] {
  if (points.length <= 2 || tolerance <= 0) {
    return points.map((_, index) => index)
  }

  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]

  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number]
    let maxDistance = 0
    let farthest = -1

    for (let index = start + 1; index < end; index++) {
      const distance = perpendicularDistance(points[index], points[start], points[end])
      if (distance > maxDistance) {
        maxDistance = distance
        farthest = index
      }
    }

    if (farthest > 0 && maxDistance > tolerance) {
      keep[farthest] = 1
      stack.push([start, farthest], [farthest, end])
    }
  }

  const indices: number[] = []
  for (let index = 0; index < points.length; index++) {
    if (keep[index] === 1) {
      indices.push(index)
    }
  }

  return indices
}

function perpendicularDistance(point: [number, number], lineStart: [number, number], lineEnd: [number, number]): number {
  const [x, y] = point
  const [x1, y1] = lineStart
  const [x2, y2] = lineEnd
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy

  if (lengthSquared === 0) {
    return Math.hypot(x - x1, y - y1)
  }

  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared))
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

/** 点数过多时按等间隔抽稀，输入输出都是下标 */
function downsampleIndices(indices: number[], maxPoints: number): number[] {
  if (indices.length <= maxPoints) {
    return indices
  }

  const step = (indices.length - 1) / (maxPoints - 1)
  const result: number[] = []
  for (let index = 0; index < maxPoints; index++) {
    const picked = indices[Math.round(index * step)]
    if (result[result.length - 1] !== picked) {
      result.push(picked)
    }
  }

  return result
}

function formatCoordinate(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/**
 * 等比缩放并平移到 viewBox 中心，正北朝上。
 * 返回 kept：去重后每个点对应输入数组的下标，用于把等级数据对齐回来。
 */
export function fitToViewBox(
  points: Array<[number, number]>,
  viewBox: [number, number],
  padding: number,
): { path: string, points: Array<[number, number]>, kept: number[], start: [number, number], end: [number, number] } | null {
  if (points.length < 2) {
    return null
  }

  const xs = points.map(point => point[0])
  const ys = points.map(point => point[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const extentX = maxX - minX
  const extentY = maxY - minY

  if (Math.max(extentX, extentY) < minExtentMeters) {
    return null
  }

  const [width, height] = viewBox
  const availableWidth = Math.max(1, width - padding * 2)
  const availableHeight = Math.max(1, height - padding * 2)
  const scale = Math.min(
    extentX > 0 ? availableWidth / extentX : Number.POSITIVE_INFINITY,
    extentY > 0 ? availableHeight / extentY : Number.POSITIVE_INFINITY,
  )
  if (!Number.isFinite(scale) || scale <= 0) {
    return null
  }

  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const mapped = points.map(([x, y]) => {
    const svgX = width / 2 + (x - centerX) * scale
    // 屏幕坐标 y 轴向下，需要翻转
    const svgY = height / 2 - (y - centerY) * scale
    return [Math.round(svgX * 10) / 10, Math.round(svgY * 10) / 10] as [number, number]
  })

  const deduped: Array<[number, number]> = []
  const kept: number[] = []
  for (let index = 0; index < mapped.length; index++) {
    const point = mapped[index]
    const previous = deduped[deduped.length - 1]
    if (previous && point[0] === previous[0] && point[1] === previous[1]) {
      continue
    }

    deduped.push(point)
    kept.push(index)
  }

  if (deduped.length < 2) {
    return null
  }

  const path = deduped
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${formatCoordinate(x)} ${formatCoordinate(y)}`)
    .join('')

  return {
    path,
    points: deduped,
    kept,
    start: deduped[0],
    end: deduped[deduped.length - 1],
  }
}
/** 完整流水线：encoded polyline -> 可直接发布的轨迹文件 */
export function buildTrack(encoded: string | null | undefined, options: TrackBuildOptions = defaultTrackOptions): TrackBuildOutcome {
  return buildTrackFromPoints(decodePolyline(encoded ?? ''), options)
}

/**
 * 完整流水线：坐标点直接进入（例如来自 streams 接口）。
 * metric 是每段一个等级的速度/爬升数据，对齐到 rawPoints，会在简化时合并到发布点上。
 */
export function buildTrackFromPoints(
  rawPoints: TrackPoint[],
  options: TrackBuildOptions = defaultTrackOptions,
  metric?: MetricLevels | null,
): TrackBuildOutcome {
  const emptyStats: TrackStats = {
    rawPoints: rawPoints.length,
    trimmedHead: 0,
    trimmedTail: 0,
    trimRadius: 0,
    retainedRatio: 0,
    simplifiedPoints: 0,
    pathChars: 0,
  }

  if (rawPoints.length < 2) {
    return { kind: 'none', reason: 'empty', stats: emptyStats }
  }

  const trimmed = trimEndsAdaptive(rawPoints, {
    privacyMeters: options.trimStartMeters,
    minRetainRatio: options.minRetainRatio,
    minTrimMeters: options.minTrimMeters,
  })
  const stats: TrackStats = {
    rawPoints: rawPoints.length,
    trimmedHead: trimmed.head,
    trimmedTail: trimmed.tail,
    trimRadius: trimmed.radius,
    retainedRatio: trimmed.retainedRatio,
    simplifiedPoints: 0,
    pathChars: 0,
  }

  if (trimmed.points.length < minPoints) {
    return { kind: 'none', reason: 'too-short', stats }
  }

  // 保留区间在原始点里的起点，等级数组按原始段编号，最后要对齐回来
  const retainedStart = trimmed.head
  const projected = trimmed.points.map(projectMercator)
  const simplifiedIndices = simplifyIndices(projected, options.simplifyTolerance)
  const selectedIndices = downsampleIndices(simplifiedIndices, options.maxPoints)
  stats.simplifiedPoints = selectedIndices.length

  const selected = selectedIndices.map(index => projected[index])
  const fitted = fitToViewBox(selected, options.viewBox, options.padding)
  if (!fitted) {
    return { kind: 'none', reason: 'degenerate', stats }
  }

  stats.pathChars = fitted.path.length

  const file: SportTrackFile = {
    v: 2,
    p: fitted.path,
    s: fitted.start,
    e: fitted.end,
  }

  if (metric && metric.levels.length > 0) {
    const rawIndexAt = (keptIndex: number) => retainedStart + selectedIndices[fitted.kept[keptIndex]]
    const levels: number[] = []
    for (let index = 0; index + 1 < fitted.points.length; index++) {
      levels.push(aggregateLevels(metric.levels, rawIndexAt(index), rawIndexAt(index + 1)))
    }

    file.k = metric.kind
    file.q = levelsToHex(levels)
  }

  if (options.showMap) {
    const center = trimmed.points[Math.floor(trimmed.points.length / 2)]
    file.c = [Number(center.lng.toFixed(4)), Number(center.lat.toFixed(4))]
  }

  return { kind: 'track', file, stats }
}
