import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { computeWodSignature, decidePhoneDedup, findHistoryCandidates, isStravaRewrittenWodCandidate, verifyStravaRewrittenWod } from './r2-dedup'
import { createSyntheticFit } from './r2-fit-fixture'

const start = new Date('2026-10-14T01:00:00Z')

function wodPoints(overrides: Record<number, number> = {}, altitudeOverrides: Record<number, number> = {}) {
  return Array.from({ length: 12 }, (_, index) => ({
    lat: 31.23 + index * 0.001,
    lng: 121.47 + index * 0.001,
    distanceMeters: index * 100 + (overrides[index] ?? 0),
    altitudeMeters: altitudeOverrides[index] ?? 10 + index,
  }))
}

/** 手机里的 WOD 原件 */
function createPhoneWod(points = wodPoints()) {
  return createSyntheticFit({ start, points, manufacturer: 'development', productName: 'WorkOutDoors', creatorManufacturer: 'development' })
}

/** Strava 改写后的下载件：改头 + 补 product + 若干 record 距离 +0.24m */
function createStravaRewrittenWod(points = wodPoints({ 1: 0.24, 3: 0.24, 5: 0.24 })) {
  return createSyntheticFit({
    start,
    points,
    exportedAt: new Date('2026-10-20T00:00:00Z'),
    serialNumber: 999,
    manufacturer: 'strava',
    productName: 'WorkOutDoors',
    product: 163,
    creatorManufacturer: 'strava',
  })
}

test('Strava 改写的 WOD：除允许改写外全相同 + 逐条 distance ≤1m 才判定同一活动', () => {
  const phone = computeWodSignature(createPhoneWod())
  const strava = computeWodSignature(createStravaRewrittenWod())
  assert.ok(phone)
  assert.ok(strava)

  assert.equal(phone.signature, strava.signature)
  assert.equal(phone.recordCount, strava.recordCount)
  assert.equal(phone.distanceCount, strava.distanceCount)
  assert.equal(strava.distanceSumRaw - phone.distanceSumRaw, 3 * 24)
  assert.equal(isStravaRewrittenWodCandidate(phone, strava), true)
  assert.equal(verifyStravaRewrittenWod(createPhoneWod(), createStravaRewrittenWod()), true)
  // 方向必须正确：手机侧是 development，历史侧是 strava
  assert.equal(verifyStravaRewrittenWod(createStravaRewrittenWod(), createPhoneWod()), false)
})

test('Strava 改写核验：亚米级累计距离误差不产生重复记录', () => {
  const changed = createStravaRewrittenWod(wodPoints({ 1: -0.9, 3: -0.45, 5: 0.01 }))
  assert.equal(verifyStravaRewrittenWod(createPhoneWod(), changed), true)
})

test('Strava 改写核验：其他 record 字段不同即拒绝', () => {
  const changed = createStravaRewrittenWod(wodPoints({ 1: 0.24 }, { 2: 999 }))
  assert.notEqual(computeWodSignature(createPhoneWod())?.signature, computeWodSignature(changed)?.signature)
  assert.equal(verifyStravaRewrittenWod(createPhoneWod(), changed), false)
})

test('Strava 改写核验：单条 distance 超过 1m 即拒绝，不静默合并', () => {
  const changed = createStravaRewrittenWod(wodPoints({ 1: 1.01 }))
  const phone = computeWodSignature(createPhoneWod())
  const strava = computeWodSignature(changed)
  assert.ok(phone)
  assert.ok(strava)
  // 归一化签名相同、总差仍在预算内，但逐条核验必须失败
  assert.equal(phone.signature, strava.signature)
  assert.equal(isStravaRewrittenWodCandidate(phone, strava), true)
  assert.equal(verifyStravaRewrittenWod(createPhoneWod(), changed), false)
})

test('Strava 改写核验：非 WOD 来源不进入严格合并', () => {
  const phone = computeWodSignature(createSyntheticFit({ start, points: wodPoints(), productName: 'AnotherExporter' }))
  const strava = computeWodSignature(createStravaRewrittenWod())
  assert.ok(phone)
  assert.ok(strava)
  assert.equal(isStravaRewrittenWodCandidate(phone, strava), false)
})

test('候选预筛：只有时间接近且距离接近的同类型活动才值得下载核验', () => {
  const phone = { start: 1000, distance: 5000, kind: 'run' as const }
  const history = [
    { id: 1, start: 1001, distance: 5010, kind: 'run' as const, original: { status: 'stored' as const, format: 'fit' as const } },
    { id: 2, start: 1001, distance: 7000, kind: 'run' as const, original: { status: 'stored' as const, format: 'fit' as const } },
    { id: 3, start: 1001, distance: 5010, kind: 'ride' as const, original: { status: 'stored' as const, format: 'fit' as const } },
    { id: 4, start: 5000, distance: 5010, kind: 'run' as const, original: { status: 'stored' as const, format: 'fit' as const } },
    { id: 5, start: 1001, distance: 5010, kind: 'run' as const, original: { status: 'unavailable' as const } },
  ]

  assert.deepEqual(findHistoryCandidates(phone, history).map(candidate => candidate.id), [1])
})

test('decidePhoneDedup：identity 命中即合并，不再下载原件', async () => {
  const phone = { activityId: 'a'.repeat(64), sha256: 'ff', wod: null, start: 1000, distance: 5000, kind: 'run' as const }
  const candidate = { id: 42, start: 1000, distance: 5000, kind: 'run' as const, original: { status: 'stored' as const, format: 'fit' as const, sha256: 'aa', key: 'k' } }
  let historyBytesCalled = false

  const result = await decidePhoneDedup(phone, [candidate], {
    historyIdentity: async () => ({ sourceSha256: 'aa', activityId: phone.activityId, sha256: 'ff', wod: null }),
    historyBytes: async () => {
      historyBytesCalled = true
      return new Uint8Array()
    },
    phoneBytes: async () => {
      historyBytesCalled = true
      return new Uint8Array()
    },
  })

  assert.deepEqual(result, { matched: true, historyId: 42, mode: 'identity' })
  assert.equal(historyBytesCalled, false)
})

test('decidePhoneDedup：非 FIT 历史只有 sha256 完全一致才抑制，不按时间合并', async () => {
  const phone = { activityId: 'a'.repeat(64), sha256: 'ff', wod: null, start: 1000, distance: 5000, kind: 'run' as const }
  const gpx = { id: 7, start: 1000, distance: 5000, kind: 'run' as const, original: { status: 'stored' as const, format: 'gpx' as const, sha256: 'aa', key: 'k' } }
  const resolvers = {
    historyIdentity: async () => ({ sourceSha256: 'aa', activityId: null, sha256: null, wod: null }),
    historyBytes: async () => {
      throw new Error('不应读取 GPX 原件')
    },
    phoneBytes: async () => {
      throw new Error('不应读取手机原件')
    },
  }

  assert.deepEqual(await decidePhoneDedup(phone, [gpx], resolvers), { matched: false })
  assert.deepEqual(
    await decidePhoneDedup({ ...phone, sha256: 'aa' }, [gpx], resolvers),
    { matched: true, historyId: 7, mode: 'identity' },
  )
})

test('decidePhoneDedup：Strava 改写核验通过才抑制手机记录', async () => {
  const phoneBytes = createPhoneWod()
  const historyBytes = createStravaRewrittenWod()
  const phoneSignature = computeWodSignature(phoneBytes)
  const historySignature = computeWodSignature(historyBytes)
  assert.ok(phoneSignature)
  assert.ok(historySignature)

  const phone = { activityId: 'b'.repeat(64), sha256: 'phone-sha', wod: phoneSignature, start: 1000, distance: 5000, kind: 'run' as const }
  const candidate = { id: 20590816780, start: 1000, distance: 5000, kind: 'run' as const, original: { status: 'stored' as const, format: 'fit' as const, sha256: 'history-sha', key: 'k' } }

  const result = await decidePhoneDedup(phone, [candidate], {
    historyIdentity: async () => ({ sourceSha256: 'history-sha', activityId: null, sha256: null, wod: historySignature }),
    historyBytes: async () => historyBytes,
    phoneBytes: async () => phoneBytes,
  })

  assert.deepEqual(result, { matched: true, historyId: 20590816780, mode: 'strava-rewrite' })
})
