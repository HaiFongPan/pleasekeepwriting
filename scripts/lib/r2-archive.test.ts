import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { activityIdFromManifestKey, checkArchiveReadiness, isPublicArchivedActivity, maybeGunzip, parseArchiveIndex, parseJsonBytes, parseManifest, parseStreamsObject } from './r2-archive'
import { createSyntheticFit } from './r2-fit-fixture'

function manifestValue(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    activity: {
      id: 20590816780,
      name: 'Wednesday Afternoon Run',
      sport_type: 'Run',
      display_type: '跑步',
      start_date: '2026-10-14 09:00:00 UTC+8',
      start_date_local_raw: 1791978000,
      distance_raw: 5015.96,
      moving_time_raw: 2077,
      elapsed_time_raw: 2254,
      elevation_gain_raw: 24.15,
      has_latlng: true,
      private: false,
      visibility: 'everyone',
      extra_source_field: 'kept',
    },
    original: { status: 'stored', key: 'strava/v1/activities/20590816780/original.fit.gz', sha256: 'abc', bytes: 100, format: 'fit', compression: 'gzip' },
    streams: { status: 'stored', key: 'strava/v1/activities/20590816780/streams.json', sha256: 'def' },
    ...overrides,
  }
}

test('manifest 解析保留额外源字段并标准化必需字段', () => {
  const parsed = parseManifest(manifestValue())
  assert.equal(parsed.activity.id, 20590816780)
  assert.equal(parsed.activity.name, 'Wednesday Afternoon Run')
  assert.equal(parsed.activity.extra_source_field, 'kept')
  assert.equal(parsed.original.format, 'fit')
  assert.equal(parsed.original.compression, 'gzip')
  assert.equal(parsed.streams.status, 'stored')
})

test('manifest 私密字段缺失时按私密处理（fail closed）', () => {
  const value = manifestValue()
  delete (value.activity as Record<string, unknown>).private
  delete (value.activity as Record<string, unknown>).visibility
  const parsed = parseManifest(value)
  assert.equal(parsed.activity.private, true)
  assert.equal(isPublicArchivedActivity(parsed.activity), false)
})

test('公开判定：private / Only Me / followers 都不公开', () => {
  const base = parseManifest(manifestValue()).activity
  assert.equal(isPublicArchivedActivity(base), true)
  assert.equal(isPublicArchivedActivity({ ...base, private: true }), false)
  assert.equal(isPublicArchivedActivity({ ...base, visibility: 'Only Me' }), false)
  assert.equal(isPublicArchivedActivity({ ...base, visibility: 'followers_only' }), false)
  assert.equal(isPublicArchivedActivity({ ...base, visibility: null }), true)
})

test('manifest 结构错误时抛出可读错误，且不包含对象键或 ID', () => {
  const value = manifestValue({ original: { status: 'stored' } })
  assert.throws(() => parseManifest(value), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /manifest\.original\.key/)
    assert.doesNotMatch(error.message, /20590816780/)
    return true
  })
})

test('manifest 状态非法（401/403/5xx 不得伪装 unavailable）', () => {
  assert.throws(() => parseManifest(manifestValue({ original: { status: 'pending' } })), /stored\/unavailable/)
  assert.throws(() => parseManifest(manifestValue({ streams: { status: 'error' } })), /stored\/unavailable/)
})

test('归档索引：解析两种 unavailableOriginals 写法', () => {
  const withIds = parseArchiveIndex({ version: 1, total: 2, activityIds: [1, 2], complete: true, failedIds: [], unavailableOriginals: [2] })
  assert.deepEqual(withIds.unavailableOriginalIds, [2])
  assert.equal(withIds.unavailableOriginalCount, 1)

  const withCount = parseArchiveIndex({ version: 1, total: 2, activityIds: [1, 2], complete: true, failedIds: [], unavailableOriginals: 1 })
  assert.deepEqual(withCount.unavailableOriginalIds, [])
  assert.equal(withCount.unavailableOriginalCount, 1)
})

test('归档就绪：complete、failedIds、total 一致与实际 manifest 集合缺一不可', () => {
  const index = parseArchiveIndex({ version: 1, total: 3, activityIds: [1, 2, 3], complete: true, failedIds: [], unavailableOriginals: 0 })
  assert.equal(checkArchiveReadiness(index, new Set([1, 2, 3])).ready, true)

  assert.equal(checkArchiveReadiness(index, new Set([1, 2])).ready, false)
  assert.equal(checkArchiveReadiness(index, new Set([1, 2, 3, 4])).ready, false)
  assert.equal(checkArchiveReadiness({ ...index, complete: false }, new Set([1, 2, 3])).ready, false)
  assert.equal(checkArchiveReadiness({ ...index, failedIds: [3] }, new Set([1, 2, 3])).ready, false)

  const mismatch = parseArchiveIndex({ version: 1, total: 4, activityIds: [1, 2, 3], complete: true, failedIds: [], unavailableOriginals: 0 })
  assert.equal(checkArchiveReadiness(mismatch, new Set([1, 2, 3])).ready, false)

  const duplicated = parseArchiveIndex({ version: 1, total: 3, activityIds: [1, 1, 3], complete: true, failedIds: [], unavailableOriginals: 0 })
  assert.equal(checkArchiveReadiness(duplicated, new Set([1, 3])).ready, false)
})

test('manifest 对象键解析：只接受数值 Strava ID 布局', () => {
  assert.equal(activityIdFromManifestKey('strava/v1/activities/123/manifest.json'), 123)
  assert.equal(activityIdFromManifestKey('strava/v1/activities/abc/manifest.json'), null)
  assert.equal(activityIdFromManifestKey('strava/v1/activities/123/streams.json'), null)
})

test('streams 解析：latlng/time/distance/altitude 对齐要求', () => {
  const streams = parseStreamsObject({ latlng: [[31.2, 121.4], [31.3, 121.5]], time: [0, 1], distance: [0, 10], altitude: [5, 6] })
  assert.deepEqual(streams.latlng[0], [31.2, 121.4])
  assert.equal(streams.time?.length, 2)
  assert.equal(streams.distance?.[1], 10)

  assert.throws(() => parseStreamsObject({ latlng: [[31.2]], time: [0] }), /latlng/)
  assert.throws(() => parseStreamsObject({ latlng: [], time: [0, Number.NaN] }), /time/)
  assert.deepEqual(parseStreamsObject({ latlng: [] }), { latlng: [], time: null, distance: null, altitude: null })
})

test('对象字节解析：gzip JSON 也能读取，坏数据报错不泄露内容', () => {
  const value = { hello: 'world' }
  const bytes = new Uint8Array(gzipSync(Buffer.from(JSON.stringify(value))))
  assert.deepEqual(parseJsonBytes(bytes, 'manifest'), value)
  assert.throws(() => parseJsonBytes(new Uint8Array([1, 2, 3]), 'streams'), /streams 不是合法 JSON/)

  const fit = createSyntheticFit()
  assert.equal(maybeGunzip(bytes).length, gzipSync(Buffer.from(JSON.stringify(value))).byteLength)
  assert.equal(maybeGunzip(fit), fit)
})
