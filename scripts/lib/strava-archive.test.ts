import type { ArchiveSource, ArchiveStorage, ArchiveStorageObject, RetryPolicy } from './strava-archive'
import type { TrainingActivitiesPage, TrainingActivity } from './strava-web'
import assert from 'node:assert/strict'
// 与 Worker 测试一致，直接用 Node 内置测试运行器：tsx --test scripts/lib/strava-archive.test.ts
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { archiveIndexKey, archiveStrava, detectOriginalFormat, sha256Hex } from './strava-archive'
import { StravaRequestError, StravaSessionExpiredError } from './strava-web'

const testRetry: RetryPolicy = { attempts: 3, baseDelayMs: 1, sleep: async () => {} }
const encoder = new TextEncoder()
const decoder = new TextDecoder()

type Activity = TrainingActivity & Record<string, unknown>
type Stubbed<T> = T | Error | (() => T)

interface StoredOriginal {
  status: 'stored' | 'unavailable'
  key?: string
  sha256?: string
  bytes?: number
  format?: string
  compression?: string | null
  reason?: string
}

interface StoredStreams {
  status: 'stored' | 'unavailable'
  key?: string
  sha256?: string
  reason?: string
}

interface StoredActivity extends Record<string, unknown> {
  id: number
  name: string
  private: boolean
}

interface StoredManifest {
  version: number
  activity: StoredActivity
  original: StoredOriginal
  streams: StoredStreams
}

interface StoredIndex {
  version: number
  total: number
  activityIds: number[]
  complete: boolean
  unavailableOriginals: number
  failedIds: number[]
}

interface StoredStreamFile {
  latlng: number[][]
  time: number[] | null
  distance: number[] | null
  altitude: number[] | null
  raw: { heartrate?: { data: number[] } }
}

function activity(id: number, overrides: Record<string, unknown> = {}): Activity {
  return {
    id,
    name: `活动${id}`,
    sport_type: 'Ride',
    display_type: '骑行',
    start_date: '2026-10-11 17:32:05 UTC+8',
    start_date_local_raw: 1760000000000 + id,
    distance_raw: 12345,
    moving_time_raw: 3600,
    elapsed_time_raw: 4000,
    elevation_gain_raw: 120,
    has_latlng: true,
    private: false,
    visibility: 'everyone',
    location_city: 'fixture-city',
    static_map: 'fixture-extra-field',
    ...overrides,
  }
}

function pageOf(models: Activity[], total: number, page = 1): TrainingActivitiesPage {
  return { models, page, perPage: 20, total }
}

function fitBytes(payloadLength = 20): Uint8Array {
  const bytes = new Uint8Array(12 + payloadLength)
  bytes[0] = 14
  bytes.set(encoder.encode('.FIT'), 8)
  return bytes
}

function gpxBytes(): Uint8Array {
  return encoder.encode('<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="fixture"><trk></trk></gpx>')
}

function tcxBytes(): Uint8Array {
  return encoder.encode('<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"></TrainingCenterDatabase>')
}

function streamPayload(): Record<string, unknown> {
  return {
    time: { data: [0, 5, 10] },
    distance: { data: [0, 20, 41] },
    latlng: { data: [[31.2, 121.4], [31.21, 121.41], [31.22, 121.42]] },
    altitude: { data: [5, 6, 7] },
    heartrate: { data: [100, 102, 104] },
  }
}

interface MemoryStorage extends ArchiveStorage {
  objects: Map<string, Uint8Array>
  operations: string[]
}

function createMemoryStorage(seed: Record<string, Uint8Array> = {}, failOn: (key: string) => boolean = () => false): MemoryStorage {
  const objects = new Map<string, Uint8Array>(Object.entries(seed))
  const operations: string[] = []

  return {
    objects,
    operations,
    async put(key, body) {
      operations.push(`put:${key}`)
      if (failOn(key)) {
        throw new Error('fixture storage down')
      }

      objects.set(key, body)
    },
    async get(key) {
      operations.push(`get:${key}`)
      return objects.get(key) ?? null
    },
    async list(prefix) {
      operations.push(`list:${prefix}`)
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]): ArchiveStorageObject => ({ key, size: value.length }))
    },
  }
}

function resolveStub<T>(value: Stubbed<T> | undefined, fallback: T): T {
  if (value === undefined) {
    return fallback
  }

  if (value instanceof Error) {
    throw value
  }

  if (typeof value === 'function') {
    return (value as () => T)()
  }

  return value
}

interface FakeSource {
  source: ArchiveSource
  calls: { pages: number[], originals: number[], streams: number[] }
}

function createFakeSource(
  pages: TrainingActivitiesPage[],
  originals: Map<number, Stubbed<Uint8Array | null>>,
  streams: Map<number, Stubbed<Record<string, unknown> | null>>,
): FakeSource {
  const calls = { pages: [] as number[], originals: [] as number[], streams: [] as number[] }

  return {
    calls,
    source: {
      async fetchActivitiesPage(page) {
        calls.pages.push(page)
        return pages[page - 1] ?? { models: [], page, perPage: 20, total: pages[0]?.total ?? 0 }
      },
      async fetchOriginal(activityId) {
        calls.originals.push(activityId)
        return resolveStub(originals.get(activityId), null)
      },
      async fetchStreams(activityId) {
        calls.streams.push(activityId)
        return resolveStub(streams.get(activityId), null)
      },
    },
  }
}

function originalMap(ids: number[], value: Uint8Array = fitBytes()): Map<number, Stubbed<Uint8Array | null>> {
  return new Map(ids.map(id => [id, value]))
}

function streamsMap(ids: number[], value: Record<string, unknown> = streamPayload()): Map<number, Stubbed<Record<string, unknown> | null>> {
  return new Map(ids.map(id => [id, value]))
}

function parseJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T
}

function requireKey(value: string | undefined): string {
  assert.ok(value, '缺少对象 key')
  return value
}

function objectAt(storage: MemoryStorage, key: string | undefined): Uint8Array {
  const required = requireKey(key)
  const value = storage.objects.get(required)
  assert.ok(value, `缺少对象 ${required}`)
  return value
}

function indexOfOperation(storage: MemoryStorage, fragment: string): number {
  return storage.operations.findIndex(operation => operation.endsWith(fragment))
}

test('分页拉全后归档全部活动并写出 complete 索引', async () => {
  const first = Array.from({ length: 20 }, (_, index) => activity(index + 1, { private: index % 2 === 0 }))
  const second = [activity(21), activity(22), activity(23)]
  const ids = [...first, ...second].map(item => item.id)
  const fake = createFakeSource([pageOf(first, 23, 1), pageOf(second, 23, 2)], originalMap(ids), streamsMap(ids))
  const storage = createMemoryStorage()

  const summary = await archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null })

  assert.deepEqual(fake.calls.pages, [1, 2])
  assert.equal(summary.scanComplete, true)
  assert.equal(summary.complete, true)
  assert.equal(summary.discovered, 23)
  assert.equal(summary.processed, 23)
  assert.equal(summary.failedIds.length, 0)
  assert.equal(summary.indexWritten, true)

  const index = parseJson<StoredIndex>(objectAt(storage, archiveIndexKey))
  assert.equal(index.version, 1)
  assert.equal(index.total, 23)
  assert.deepEqual(index.activityIds, ids)
  assert.equal(index.complete, true)
  assert.equal(index.unavailableOriginals, 0)
  assert.deepEqual(index.failedIds, [])

  const manifest = parseJson<StoredManifest>(objectAt(storage, 'strava/v1/activities/3/manifest.json'))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.activity.id, 3)
  assert.equal(manifest.activity.private, true) // 私密活动同样归档
  assert.equal(manifest.activity.name, '活动3')
  assert.equal(manifest.activity.location_city, 'fixture-city')
  assert.equal(manifest.activity.static_map, 'fixture-extra-field')

  const originalBytes = objectAt(storage, manifest.original.key)
  assert.equal(manifest.original.format, 'fit')
  assert.equal(manifest.original.compression, null)
  assert.equal(manifest.original.bytes, originalBytes.length)
  assert.equal(manifest.original.sha256, sha256Hex(originalBytes))
  assert.deepEqual(originalBytes, fitBytes())

  const streams = parseJson<StoredStreamFile>(objectAt(storage, manifest.streams.key))
  assert.deepEqual(streams.latlng, [[31.2, 121.4], [31.21, 121.41], [31.22, 121.42]])
  assert.deepEqual(streams.time, [0, 5, 10])
  assert.deepEqual(streams.raw.heartrate?.data, [100, 102, 104])
  assert.equal(manifest.streams.sha256, sha256Hex(objectAt(storage, manifest.streams.key)))

  // manifest 必须排在原件与 streams 之后发布
  const originalPut = indexOfOperation(storage, 'activities/3/original.fit')
  const streamsPut = indexOfOperation(storage, 'activities/3/streams.json')
  const manifestPut = indexOfOperation(storage, 'activities/3/manifest.json')
  assert.ok(originalPut >= 0 && streamsPut >= 0)
  assert.ok(manifestPut > originalPut && manifestPut > streamsPut)
})

test('分页不足 total 时保留旧索引且不标完整', async () => {
  const models = Array.from({ length: 20 }, (_, index) => activity(index + 1))
  const storage = createMemoryStorage()
  const previousIndex = encoder.encode('{"version":1,"total":0,"activityIds":[],"complete":false,"unavailableOriginals":0,"failedIds":[]}')
  storage.objects.set(archiveIndexKey, previousIndex)

  const fake = createFakeSource([pageOf(models, 60, 1), pageOf([activity(21)], 60, 2)], originalMap([...models.map(item => item.id), 21]), streamsMap([...models.map(item => item.id), 21]))
  const summary = await archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null })

  assert.equal(summary.scanComplete, false)
  assert.equal(summary.indexWritten, false)
  assert.equal(summary.complete, false)
  assert.deepEqual(storage.objects.get(archiveIndexKey), previousIndex)
})

test('total 在扫描中变化时按最新值判断完整性', async () => {
  const first = Array.from({ length: 20 }, (_, index) => activity(index + 1))
  const ids = first.map(item => item.id)
  const storage = createMemoryStorage()
  const fake = createFakeSource(
    [pageOf(first, 21, 1), pageOf([activity(21)], 22, 2)],
    originalMap([...ids, 21]),
    streamsMap([...ids, 21]),
  )

  const summary = await archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null })

  assert.equal(summary.total, 22)
  assert.equal(summary.discovered, 21)
  assert.equal(summary.scanComplete, false)
  assert.equal(summary.indexWritten, false)
})

test('原件明确 404 记 unavailable，不阻断 complete', async () => {
  const ids = [1, 2]
  const originals = new Map<number, Stubbed<Uint8Array | null>>([[1, fitBytes()], [2, null]])
  const fake = createFakeSource([pageOf([activity(1), activity(2)], 2)], originals, streamsMap(ids))
  const storage = createMemoryStorage()

  const summary = await archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null })

  const manifest = parseJson<StoredManifest>(objectAt(storage, 'strava/v1/activities/2/manifest.json'))
  assert.equal(manifest.original.status, 'unavailable')
  assert.equal(manifest.original.reason, 'export-unavailable')
  assert.equal(manifest.streams.status, 'stored')
  assert.equal(summary.originalUnavailable, 1)
  assert.equal(summary.failedIds.length, 0)
  assert.equal(summary.complete, true)

  const index = parseJson<StoredIndex>(objectAt(storage, archiveIndexKey))
  assert.equal(index.complete, true)
  assert.equal(index.unavailableOriginals, 1)
  assert.deepEqual(index.failedIds, [])
})

test('401/403 授权失败中止整轮，不写成 unavailable 也不写索引', async () => {
  const originals = new Map<number, Stubbed<Uint8Array | null>>([[1, new StravaSessionExpiredError('cookie 已失效')]])
  const fake = createFakeSource([pageOf([activity(1), activity(2)], 2)], originals, streamsMap([1, 2]))
  const storage = createMemoryStorage()

  await assert.rejects(
    () => archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null }),
    /cookie 已失效/,
  )

  assert.equal(fake.calls.originals.length, 1)
  assert.equal(storage.objects.has('strava/v1/activities/1/manifest.json'), false)
  assert.equal(storage.objects.has(archiveIndexKey), false)
})

test('5xx 低频重试耗尽后记失败，索引不标 complete', async () => {
  const originals = new Map<number, Stubbed<Uint8Array | null>>([[1, new StravaRequestError('请求失败（HTTP 500）', 500)]])
  const fake = createFakeSource([pageOf([activity(1)], 1)], originals, streamsMap([1]))
  const storage = createMemoryStorage()

  const summary = await archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null })

  assert.equal(fake.calls.originals.length, 3)
  assert.deepEqual(summary.failedIds, [1])
  assert.equal(summary.complete, false)
  assert.equal(summary.indexWritten, true)
  assert.equal(storage.objects.has('strava/v1/activities/1/manifest.json'), false)

  const index = parseJson<StoredIndex>(objectAt(storage, archiveIndexKey))
  assert.equal(index.complete, false)
  assert.deepEqual(index.failedIds, [1])
})

test('5xx 重试一次后成功则照常归档', async () => {
  let attempt = 0
  const originals = new Map<number, Stubbed<Uint8Array | null>>([[1, () => {
    attempt++
    if (attempt < 2) {
      throw new StravaRequestError('请求失败（HTTP 502）', 502)
    }

    return fitBytes()
  }]])
  const fake = createFakeSource([pageOf([activity(1)], 1)], originals, streamsMap([1]))
  const storage = createMemoryStorage()

  const summary = await archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null })

  assert.equal(attempt, 2)
  assert.deepEqual(summary.failedIds, [])
  assert.equal(summary.complete, true)
  assert.ok(storage.objects.has('strava/v1/activities/1/manifest.json'))
})

test('按内容识别 gzip/FIT/GPX/TCX', () => {
  assert.deepEqual(detectOriginalFormat(new Uint8Array(0)), { format: 'unknown', compression: null })
  assert.deepEqual(detectOriginalFormat(fitBytes()), { format: 'fit', compression: null })
  assert.deepEqual(detectOriginalFormat(new Uint8Array(gzipSync(fitBytes()))), { format: 'fit', compression: 'gzip' })
  assert.deepEqual(detectOriginalFormat(gpxBytes()), { format: 'gpx', compression: null })
  assert.deepEqual(detectOriginalFormat(new Uint8Array(gzipSync(tcxBytes()))), { format: 'tcx', compression: 'gzip' })
  assert.deepEqual(detectOriginalFormat(encoder.encode('这不是轨迹文件')), { format: 'unknown', compression: null })
})

test('gzip 原件保存原始字节并记录解压后的格式', async () => {
  const gzipped = new Uint8Array(gzipSync(fitBytes()))
  const fake = createFakeSource([pageOf([activity(1)], 1)], originalMap([1], gzipped), streamsMap([1]))
  const storage = createMemoryStorage()

  await archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null })

  const manifest = parseJson<StoredManifest>(objectAt(storage, 'strava/v1/activities/1/manifest.json'))
  assert.equal(manifest.original.format, 'fit')
  assert.equal(manifest.original.compression, 'gzip')
  assert.equal(manifest.original.key, 'strava/v1/activities/1/original.fit')
  assert.equal(manifest.original.bytes, gzipped.length)
  assert.equal(manifest.original.sha256, sha256Hex(gzipped))
  assert.deepEqual(objectAt(storage, manifest.original.key), gzipped)
})

test('未知格式的原件落到 original.bin', async () => {
  const payload = encoder.encode('binary-ish payload')
  const fake = createFakeSource([pageOf([activity(1)], 1)], originalMap([1], payload), streamsMap([1]))
  const storage = createMemoryStorage()

  await archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null })

  const manifest = parseJson<StoredManifest>(objectAt(storage, 'strava/v1/activities/1/manifest.json'))
  assert.equal(manifest.original.format, 'unknown')
  assert.equal(manifest.original.compression, null)
  assert.equal(manifest.original.key, 'strava/v1/activities/1/original.bin')
})

test('streams 没有可用流时记 unavailable', async () => {
  const streams = new Map<number, Stubbed<Record<string, unknown> | null>>([[1, null], [2, {}]])
  const fake = createFakeSource([pageOf([activity(1), activity(2)], 2)], originalMap([1, 2]), streams)
  const storage = createMemoryStorage()

  const summary = await archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null })

  const withoutStreams = parseJson<StoredManifest>(objectAt(storage, 'strava/v1/activities/1/manifest.json'))
  const emptyStreams = parseJson<StoredManifest>(objectAt(storage, 'strava/v1/activities/2/manifest.json'))
  assert.equal(withoutStreams.streams.status, 'unavailable')
  assert.equal(withoutStreams.streams.reason, 'http-404')
  assert.equal(emptyStreams.streams.status, 'unavailable')
  assert.equal(emptyStreams.streams.reason, 'no-streams')
  assert.equal(summary.streamsUnavailable, 2)
  assert.equal(summary.complete, true)
})

test('断点续跑：已有 manifest 时跳过大文件，只刷新训练元信息', async () => {
  const first = createFakeSource([pageOf([activity(1), activity(2)], 2)], originalMap([1, 2]), streamsMap([1, 2]))
  const storage = createMemoryStorage()
  await archiveStrava({ source: first.source, storage, retry: testRetry }, { limit: null })

  const second = createFakeSource([pageOf([activity(1, { name: '改名后的活动' }), activity(2)], 2)], originalMap([1, 2]), streamsMap([1, 2]))
  const summary = await archiveStrava({ source: second.source, storage, retry: testRetry }, { limit: null })

  assert.deepEqual(second.calls.originals, [])
  assert.deepEqual(second.calls.streams, [])
  assert.equal(summary.originalReused, 2)
  assert.equal(summary.streamsReused, 2)
  assert.equal(summary.refreshed, 2)
  assert.equal(summary.complete, true)

  const manifest = parseJson<StoredManifest>(objectAt(storage, 'strava/v1/activities/1/manifest.json'))
  assert.equal(manifest.activity.name, '改名后的活动')
})

test('断点续跑：对象缺失时重新拉取并校验大小', async () => {
  const first = createFakeSource([pageOf([activity(1), activity(2)], 2)], originalMap([1, 2]), streamsMap([1, 2]))
  const storage = createMemoryStorage()
  await archiveStrava({ source: first.source, storage, retry: testRetry }, { limit: null })

  const manifestBefore = parseJson<StoredManifest>(objectAt(storage, 'strava/v1/activities/1/manifest.json'))
  const originalKey = requireKey(manifestBefore.original.key)
  storage.objects.delete(originalKey)

  const second = createFakeSource([pageOf([activity(1), activity(2)], 2)], originalMap([1, 2]), streamsMap([1, 2]))
  const summary = await archiveStrava({ source: second.source, storage, retry: testRetry }, { limit: null })

  assert.deepEqual(second.calls.originals, [1])
  assert.deepEqual(second.calls.streams, [])
  assert.equal(summary.originalStored, 1)
  assert.equal(summary.originalReused, 1)
  assert.equal(storage.objects.has(originalKey), true)
})

test('--limit 部分执行不写索引，重跑可续传', async () => {
  const ids = [1, 2, 3, 4, 5]
  const storage = createMemoryStorage()

  const run1 = createFakeSource([pageOf(ids.map(id => activity(id)), 5)], originalMap(ids, fitBytes()), streamsMap(ids))
  const summary1 = await archiveStrava({ source: run1.source, storage, retry: testRetry }, { limit: 2 })
  assert.equal(summary1.limited, true)
  assert.equal(summary1.indexWritten, false)
  assert.deepEqual(run1.calls.originals, [1, 2])
  assert.equal(storage.objects.has('strava/v1/activities/3/manifest.json'), false)
  assert.equal(storage.objects.has(archiveIndexKey), false)

  const run2 = createFakeSource([pageOf(ids.map(id => activity(id)), 5)], originalMap(ids, fitBytes()), streamsMap(ids))
  const summary2 = await archiveStrava({ source: run2.source, storage, retry: testRetry }, { limit: 2 })
  assert.equal(summary2.limited, true)
  assert.equal(summary2.indexWritten, false)
  assert.deepEqual(run2.calls.originals, [3, 4])
  assert.equal(storage.objects.has('strava/v1/activities/5/manifest.json'), false)

  const run3 = createFakeSource([pageOf(ids.map(id => activity(id)), 5)], originalMap(ids, fitBytes()), streamsMap(ids))
  const summary3 = await archiveStrava({ source: run3.source, storage, retry: testRetry }, { limit: null })
  assert.equal(summary3.limited, false)
  assert.equal(summary3.indexWritten, true)
  assert.equal(summary3.complete, true)
  assert.deepEqual(run3.calls.originals, [5])

  const index = parseJson<StoredIndex>(objectAt(storage, archiveIndexKey))
  assert.deepEqual(index.activityIds, ids)
  for (const id of ids) {
    assert.equal(storage.objects.has(`strava/v1/activities/${id}/manifest.json`), true)
  }
})

test('--verify 重新校验 sha 并修复被破坏的对象', async () => {
  const ids = [1, 2]
  const first = createFakeSource([pageOf(ids.map(id => activity(id)), 2)], originalMap(ids), streamsMap(ids))
  const storage = createMemoryStorage()
  await archiveStrava({ source: first.source, storage, retry: testRetry }, { limit: null })

  // 改成大小不变但内容不同，size 核对不会发现，只有 sha 校验能发现
  const manifest1 = parseJson<StoredManifest>(objectAt(storage, 'strava/v1/activities/1/manifest.json'))
  const manifest2 = parseJson<StoredManifest>(objectAt(storage, 'strava/v1/activities/2/manifest.json'))
  const corruptedStreams = objectAt(storage, manifest1.streams.key).slice()
  corruptedStreams[0] = corruptedStreams[0] ^ 0xFF
  storage.objects.set(requireKey(manifest1.streams.key), corruptedStreams)
  const corruptedOriginal = objectAt(storage, manifest2.original.key).slice()
  corruptedOriginal[0] = corruptedOriginal[0] ^ 0xFF
  storage.objects.set(requireKey(manifest2.original.key), corruptedOriginal)

  const second = createFakeSource([pageOf(ids.map(id => activity(id)), 2)], originalMap(ids), streamsMap(ids))
  const plain = await archiveStrava({ source: second.source, storage, retry: testRetry }, { limit: null })
  assert.deepEqual(second.calls.originals, [])
  assert.deepEqual(second.calls.streams, [])
  assert.equal(plain.complete, true)

  const third = createFakeSource([pageOf(ids.map(id => activity(id)), 2)], originalMap(ids), streamsMap(ids))
  const verified = await archiveStrava({ source: third.source, storage, retry: testRetry }, { limit: null, verify: true })
  assert.deepEqual(third.calls.originals, [2])
  assert.deepEqual(third.calls.streams, [1])
  assert.equal(verified.originalStored, 1)
  assert.equal(verified.streamsStored, 1)
  assert.equal(verified.complete, true)

  const repaired = parseJson<StoredManifest>(objectAt(storage, 'strava/v1/activities/1/manifest.json'))
  const repairedFile = parseJson<StoredStreamFile>(objectAt(storage, requireKey(repaired.streams.key)))
  assert.equal(repaired.streams.sha256, sha256Hex(objectAt(storage, requireKey(repaired.streams.key))))
  // 重新归档后内容与最初一致，sha 回到原值
  assert.strictEqual(repaired.streams.sha256, manifest1.streams.sha256)
  assert.deepEqual(repairedFile.latlng, [[31.2, 121.4], [31.21, 121.41], [31.22, 121.42]])
})

test('--dry-run 只预览：不写对象、不写索引，日志不泄露名称', async () => {
  const fake = createFakeSource([pageOf([activity(1), activity(2)], 2)], originalMap([1, 2]), streamsMap([1, 2]))
  const storage = createMemoryStorage({}, () => true) // 任何写入都会失败
  const logs: string[] = []

  const summary = await archiveStrava(
    { source: fake.source, storage, retry: testRetry, log: line => logs.push(line) },
    { limit: 2, dryRun: true },
  )

  assert.equal(summary.dryRun, true)
  assert.equal(summary.limited, true)
  assert.equal(summary.indexWritten, false)
  assert.equal(summary.complete, false)
  assert.deepEqual(summary.failedIds, [])
  assert.equal(summary.originalStored, 2)
  assert.equal(summary.streamsStored, 2)
  assert.equal(storage.objects.size, 0)

  const output = logs.join('\n')
  assert.match(output, /预览 #1：原件 fit /)
  assert.match(output, /heartrate/)
  assert.ok(!output.includes('活动1') && !output.includes('活动2'))
  assert.ok(!output.includes('fixture-city'))
})

test('--dry-run 扫完也不写索引', async () => {
  const fake = createFakeSource([pageOf([activity(1)], 1)], originalMap([1]), streamsMap([1]))
  const storage = createMemoryStorage({}, () => true)

  const summary = await archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null, dryRun: true })

  assert.equal(summary.scanComplete, true)
  assert.equal(summary.indexWritten, false)
  assert.equal(summary.complete, false)
  assert.equal(storage.objects.size, 0)
})

test('对象写入失败时不发布 manifest 且不标完整', async () => {
  const fake = createFakeSource([pageOf([activity(1)], 1)], originalMap([1]), streamsMap([1]))
  const storage = createMemoryStorage({}, key => key.includes('/original.'))

  const summary = await archiveStrava({ source: fake.source, storage, retry: testRetry }, { limit: null })

  assert.deepEqual(summary.failedIds, [1])
  assert.equal(summary.complete, false)
  assert.equal(storage.objects.has('strava/v1/activities/1/manifest.json'), false)
  assert.deepEqual(fake.calls.streams, [])

  const index = parseJson<StoredIndex>(objectAt(storage, archiveIndexKey))
  assert.equal(index.complete, false)
  assert.deepEqual(index.failedIds, [1])
})
