import type { SportActivitiesData, SportActivity, SportRenderParams } from '../../src/types/strava'
import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { historyActivityFromManifest, mergeDataset, phoneActivityFromFit } from './r2-dataset'

const params: SportRenderParams = {
  renderer: 4,
  viewBox: [100, 62],
  padding: 6,
  trimStartMeters: 200,
  minRetainRatio: 0.5,
  minTrimMeters: 50,
  simplifyTolerance: 5,
  maxPoints: 200,
  showMap: false,
  showLocationNames: false,
}

function history(id: number, start: number, distance = 5000): SportActivity {
  return {
    id,
    sportType: 'Run',
    displayType: '跑步',
    name: null,
    kind: 'run',
    start,
    date: '2026-10-14',
    distance,
    movingTime: 2077,
    elapsedTime: 2254,
    calories: 343,
    caloriesSynced: true,
    elevation: 24,
    hasGps: true,
    track: true,
    trackSynced: true,
  }
}

function dataset(activities: SportActivity[], generatedAt = '2026-01-01T00:00:00.000Z'): SportActivitiesData {
  return {
    generatedAt,
    source: { provider: 'strava', athleteId: null },
    params,
    summary: {
      activityCount: activities.length,
      trackCount: activities.filter(activity => activity.track).length,
      calorieMissing: activities.filter(activity => activity.calories == null).length,
      firstActivityAt: activities[activities.length - 1]?.date ?? null,
      lastActivityAt: activities[0]?.date ?? null,
    },
    activities,
  }
}

test('历史记录映射：manifest 更新展示字段，旧卡路里与轨迹标记不丢失', () => {
  const previous = { ...history(1, 1000), calories: 400, caloriesSynced: true, track: true, trackSynced: true }
  const record = historyActivityFromManifest({
    id: 1,
    name: 'Renamed Run',
    sport_type: 'Run',
    display_type: '跑步',
    start_date: '2026-10-14 09:00:00 UTC+8',
    start_date_local_raw: 1000,
    distance_raw: 6000,
    moving_time_raw: 2100,
    elapsed_time_raw: 2200,
    elevation_gain_raw: null,
    has_latlng: true,
    private: false,
    visibility: 'everyone',
  }, previous)

  assert.equal(record.name, 'Renamed Run')
  assert.equal(record.distance, 6000)
  assert.equal(record.calories, 400)
  assert.equal(record.elevation, 24)
  assert.equal(record.track, true)
  assert.equal(record.trackSynced, true)
})

test('手机记录：字符串 ID 不截断，显式标注设备计时口径与来源', () => {
  const id = 'a751dada2f268d8395ac25f923cbbf50f1b86e2ef239832ed2f648d5a82adfaf'
  const record = phoneActivityFromFit({
    activityId: id,
    start: 1000,
    sportType: 'Run',
    displayType: '跑步',
    kind: 'run',
    distance: 5000,
    movingTime: 1800,
    elapsedTime: 1900,
    calories: 300,
    elevation: 10,
    hasGps: true,
    track: true,
    trackSynced: true,
  })

  assert.equal(record.id, id)
  assert.equal(record.timeSource, 'device-timer')
  assert.equal(record.origin, 'phone')
  assert.equal(record.movingTime, 1800)
})

test('合并：旧数值 ID 保留，归档缺失的历史只保留并告警', () => {
  const previous = dataset([history(2, 2000), history(1, 1000)])
  const merged = mergeDataset({
    params,
    previous,
    history: [historyActivityFromManifest(manifestActivity(2), previous.activities[0])],
    manifestIds: new Set([2, 3]),
    privateIds: new Set(),
    phones: [],
    phoneIds: new Set(),
  })

  assert.deepEqual(merged.data.activities.map(activity => activity.id), [2, 1])
  assert.deepEqual(merged.warnings.missingHistoryIds, [1])
})

test('合并：归档明确私密时移除对应公开活动', () => {
  const previous = dataset([history(2, 2000), history(1, 1000)])
  const merged = mergeDataset({
    params,
    previous,
    history: [historyActivityFromManifest(manifestActivity(2), previous.activities[0])],
    manifestIds: new Set([1, 2]),
    privateIds: new Set([1]),
    phones: [],
    phoneIds: new Set(),
  })

  assert.deepEqual(merged.data.activities.map(activity => activity.id), [2])
  assert.deepEqual(merged.warnings.removedPrivateIds, [1])
  assert.deepEqual(merged.warnings.missingHistoryIds, [])
})

test('合并：手机记录与历史同 ID 空间不冲突；对象消失时移除记录', () => {
  const phone = phoneActivityFromFit({
    activityId: 'f'.repeat(64),
    start: 3000,
    sportType: 'Walk',
    displayType: '健走',
    kind: 'walk',
    distance: 1000,
    movingTime: 600,
    elapsedTime: 700,
    calories: null,
    elevation: null,
    hasGps: false,
    track: false,
    trackSynced: true,
  })
  const previous = dataset([history(1, 1000), { ...phone, id: 'e'.repeat(64) }])
  const merged = mergeDataset({
    params,
    previous,
    history: [historyActivityFromManifest(manifestActivity(1), previous.activities[0])],
    manifestIds: new Set([1]),
    privateIds: new Set(),
    phones: [phone],
    phoneIds: new Set([phone.id as string]),
  })

  assert.deepEqual(merged.data.activities.map(activity => activity.id), [phone.id, 1])
  assert.deepEqual(merged.warnings.removedPhoneIds, ['e'.repeat(64)])
})

test('合并：数据与参数未变时沿用旧 generatedAt，保证空增量零 diff', () => {
  const previous = dataset([history(1, 1000)])
  const merged = mergeDataset({
    params,
    previous,
    history: [historyActivityFromManifest(manifestActivity(1), previous.activities[0])],
    manifestIds: new Set([1]),
    privateIds: new Set(),
    phones: [],
    phoneIds: new Set(),
  })

  assert.equal(merged.data.generatedAt, previous.generatedAt)
  assert.equal(JSON.stringify({ ...merged.data, generatedAt: '' }), JSON.stringify({ ...previous, generatedAt: '' }))
})

function manifestActivity(id: number) {
  return {
    id,
    name: null,
    sport_type: 'Run',
    display_type: '跑步',
    start_date: '2026-10-14 09:00:00 UTC+8',
    start_date_local_raw: id * 1000,
    distance_raw: 5000,
    moving_time_raw: 2077,
    elapsed_time_raw: 2254,
    elevation_gain_raw: 24,
    has_latlng: true,
    private: false,
    visibility: 'everyone',
  }
}
