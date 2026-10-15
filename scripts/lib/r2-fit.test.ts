import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { formatLocalDate } from '../../src/utils/sport'
import { identifyFitFile, mapFitSport, parseFitTrack, readPhoneFit, resolveDisplayTimeZone, zonedWallClockEpoch } from './r2-fit'
import { createSyntheticFit } from './r2-fit-fixture'

const shanghaiStart = new Date('2026-10-14T01:00:00Z')

function gpsPoints() {
  return [
    { lat: 31.2304, lng: 121.4737, distanceMeters: 0, altitudeMeters: 10 },
    { lat: 31.2314, lng: 121.4747, distanceMeters: 140, altitudeMeters: 12 },
    { lat: 31.2324, lng: 121.4757, distanceMeters: 280, altitudeMeters: 14 },
    { lat: 31.2334, lng: 121.4767, distanceMeters: 420, altitudeMeters: 16 },
  ]
}

test('手机 FIT：session 单位、口径与展示时区换算正确', () => {
  const bytes = createSyntheticFit({
    start: shanghaiStart,
    distanceMeters: 5015.96,
    timerSeconds: 2077,
    elapsedSeconds: 2254,
    calories: 343,
    points: gpsPoints(),
  })

  const fit = readPhoneFit(bytes)
  assert.ok(fit.session)
  assert.equal(fit.session.sportType, 'Run')
  assert.equal(fit.session.displayType, '跑步')
  assert.equal(fit.session.kind, 'run')
  assert.equal(fit.session.distanceMeters, 5015.96)
  assert.equal(fit.session.timerSeconds, 2077)
  assert.equal(fit.session.elapsedSeconds, 2254)
  assert.equal(fit.session.calories, 343)

  const start = zonedWallClockEpoch(fit.session.start, 'Asia/Shanghai')
  assert.equal(new Date(fit.session.start.toISOString()).getTime(), shanghaiStart.getTime())
  // 上海 09:00 的墙上时间读作 UTC 09:00，与 Strava start_date_local_raw 同口径
  assert.equal(start, Date.UTC(2026, 9, 14, 9, 0, 0))
  assert.equal(formatLocalDate(start), '2026-10-14')
})

test('手机 FIT：GPS 半圆坐标换算成度，设备距离流对齐', () => {
  const bytes = createSyntheticFit({ start: shanghaiStart, points: gpsPoints() })
  const fit = readPhoneFit(bytes)

  assert.equal(fit.hasGps, true)
  assert.equal(fit.points.length, 4)
  assert.ok(Math.abs(fit.points[0].lat - 31.2304) < 1e-5)
  assert.ok(Math.abs(fit.points[0].lng - 121.4737) < 1e-5)
  assert.deepEqual(fit.points.map(point => point.time), [0, 1, 2, 3])
  assert.deepEqual(fit.points.map(point => point.distance), [0, 140, 280, 420])
})

test('手机 FIT：室内无 GPS 时没有轨迹点', () => {
  const bytes = createSyntheticFit({ start: shanghaiStart, sport: 'training', points: [] })
  const fit = readPhoneFit(bytes)

  assert.equal(fit.hasGps, false)
  assert.deepEqual(fit.points, [])
  assert.ok(fit.session)
  assert.equal(fit.session.kind, 'other')
  assert.equal(fit.session.displayType, '训练')
})

test('手机 FIT：距离流缺失时按坐标累计球面距离', () => {
  const bytes = createSyntheticFit({
    start: shanghaiStart,
    points: [
      { lat: 31.2304, lng: 121.4737, distanceMeters: 0 },
      { lat: 31.2314, lng: 121.4747, distanceMeters: 0 },
      { lat: 31.2324, lng: 121.4757, distanceMeters: 0 },
    ],
  })

  const fit = readPhoneFit(bytes)
  assert.equal(fit.points[0].distance, 0)
  assert.ok(fit.points[2].distance > 100)
})

test('手机 FIT：WorkOutDoors 重导出只改导出时间/序列号时 identity 不变', () => {
  const first = createSyntheticFit({ start: shanghaiStart, exportedAt: new Date('2026-10-15T00:00:00Z'), serialNumber: 100 })
  const second = createSyntheticFit({ start: shanghaiStart, exportedAt: new Date('2026-10-16T00:00:00Z'), serialNumber: 101 })

  const firstIdentity = identifyFitFile(first)
  const secondIdentity = identifyFitFile(second)
  assert.notEqual(firstIdentity.sha256, secondIdentity.sha256)
  assert.equal(firstIdentity.activityId, secondIdentity.activityId)
  assert.equal(firstIdentity.dedupMode, 'workoutdoors-content')
})

test('手机 FIT：未知导出器退回 file 模式，不按时间合并', () => {
  const first = createSyntheticFit({ start: shanghaiStart, productName: 'AnotherExporter', serialNumber: 100 })
  const second = createSyntheticFit({ start: shanghaiStart, productName: 'AnotherExporter', serialNumber: 101 })

  assert.equal(identifyFitFile(first).dedupMode, 'file')
  assert.notEqual(identifyFitFile(first).activityId, identifyFitFile(second).activityId)
})

test('手机 FIT：损坏文件报错而不是产出半条记录', () => {
  assert.throws(() => readPhoneFit(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])), /FIT/)
})

test('展示时区可配置，默认 Asia/Shanghai', () => {
  assert.equal(resolveDisplayTimeZone({}), 'Asia/Shanghai')
  assert.equal(resolveDisplayTimeZone({ R2_SYNC_TIMEZONE: 'UTC' }), 'UTC')
  const start = zonedWallClockEpoch(new Date('2026-10-14T01:00:00Z'), 'UTC')
  assert.equal(start, Date.UTC(2026, 9, 14, 1, 0, 0))
  assert.throws(() => zonedWallClockEpoch(new Date(), 'Not/AZone'), /无效的展示时区/)
})

test('FIT sport 映射到站点分组', () => {
  assert.deepEqual(mapFitSport('running'), { sportType: 'Run', displayType: '跑步', kind: 'run' })
  assert.deepEqual(mapFitSport('cycling'), { sportType: 'Ride', displayType: '骑行', kind: 'ride' })
  assert.deepEqual(mapFitSport('hiking'), { sportType: 'Hike', displayType: '远足', kind: 'hike' })
  assert.deepEqual(mapFitSport('training'), { sportType: 'Workout', displayType: '训练', kind: 'other' })
  assert.equal(mapFitSport(undefined).sportType, 'Workout')
})

test('parseFitTrack：没有位置字段的 record 不产生轨迹点', () => {
  const messages = { recordMesgs: [{ timestamp: shanghaiStart, distance: 1 }] }
  assert.deepEqual(parseFitTrack(messages), { points: [], hasGps: false })
})
