/**
 * 仅供测试的合成 FIT 构造器：不含任何真实运动、位置或个人信息。
 * WorkOutDoors 的导出器标识用 development + productName 复现，
 * 用于验证内容归一与 Strava 改写核验。
 */

import type { Mesg } from '@garmin/fitsdk'
import { Encoder, Profile } from '@garmin/fitsdk'

const semicirclesPerDegree = 2 ** 31 / 180

export function toSemicircles(degrees: number): number {
  return Math.round(degrees * semicirclesPerDegree)
}

export interface SyntheticFitPoint {
  lat: number
  lng: number
  distanceMeters?: number
  altitudeMeters?: number
}

export interface SyntheticFitOptions {
  exportedAt?: Date
  start?: Date
  serialNumber?: number
  manufacturer?: string
  productName?: string
  /** Strava 改写会追加的 product 字段 */
  product?: number
  creatorManufacturer?: string
  sport?: string
  distanceMeters?: number
  timerSeconds?: number
  elapsedSeconds?: number
  calories?: number
  points?: SyntheticFitPoint[]
  includeSession?: boolean
  includeActivity?: boolean
}

export function createSyntheticFit(options: SyntheticFitOptions = {}): Uint8Array {
  const {
    exportedAt = new Date('2026-10-15T00:00:00Z'),
    start = new Date('2026-10-14T01:00:00Z'),
    serialNumber = 100,
    manufacturer = 'development',
    productName = 'WorkOutDoors',
    product,
    creatorManufacturer = manufacturer,
    sport = 'running',
    distanceMeters = 1000,
    timerSeconds = 600,
    elapsedSeconds = 660,
    calories = 50,
    points = [],
    includeSession = true,
    includeActivity = true,
  } = options

  const encoder = new Encoder()
  const emit = (mesgNum: number, fields: Record<string, unknown>) => {
    encoder.onMesg(mesgNum, fields as unknown as Mesg)
  }

  emit(Profile.MesgNum.FILE_ID, {
    type: 'activity',
    manufacturer,
    productName,
    ...(product != null ? { product } : {}),
    serialNumber,
    timeCreated: exportedAt,
  })

  emit(Profile.MesgNum.DEVICE_INFO, {
    deviceIndex: 'creator',
    manufacturer: creatorManufacturer,
    productName,
    serialNumber,
    timestamp: exportedAt,
  })

  emit(Profile.MesgNum.EVENT, { timestamp: start, event: 'timer', eventType: 'start' })

  points.forEach((point, index) => {
    emit(Profile.MesgNum.RECORD, {
      timestamp: new Date(start.getTime() + index * 1000),
      positionLat: toSemicircles(point.lat),
      positionLong: toSemicircles(point.lng),
      ...(point.distanceMeters != null ? { distance: point.distanceMeters } : {}),
      ...(point.altitudeMeters != null ? { altitude: point.altitudeMeters } : {}),
    })
  })

  emit(Profile.MesgNum.LAP, { startTime: start, totalDistance: distanceMeters, totalTimerTime: timerSeconds })

  if (includeSession) {
    emit(Profile.MesgNum.SESSION, {
      startTime: start,
      sport,
      totalDistance: distanceMeters,
      totalTimerTime: timerSeconds,
      totalElapsedTime: elapsedSeconds,
      totalCalories: calories,
    })
  }

  if (includeActivity) {
    emit(Profile.MesgNum.ACTIVITY, { timestamp: start, totalTimerTime: timerSeconds, numSessions: 1, type: 'manual' })
  }

  return encoder.close()
}
