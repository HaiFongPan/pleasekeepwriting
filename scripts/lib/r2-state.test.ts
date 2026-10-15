import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { parseSyncState, stateContentEquals } from './r2-state'

function validState() {
  return {
    version: 1 as const,
    parser: 1,
    renderer: 4,
    generatedAt: '2026-10-14T00:00:00.000Z',
    timezone: 'Asia/Shanghai',
    archive: { key: 'strava/v1/archive-index.json', etag: 'e1', sha256: 'h1', version: 1, complete: true, total: 1, failed: 0, unavailableOriginals: 0 },
    manifests: {
      1: {
        etag: 'm1',
        sha256: 'ms1',
        original: { status: 'stored', format: 'fit', sha256: 'o1', key: 'strava/v1/activities/1/original.fit' },
        streams: { status: 'stored', key: 'strava/v1/activities/1/streams.json' },
      },
    },
    historyFitIdentities: {},
    phones: {
      ['a'.repeat(64)]: { etag: 'p1', sha256: 'ps1', dedupMode: 'workoutdoors-content', wod: null, start: 1, distance: 1, kind: 'run', hasGps: true, track: false, trackSynced: true },
    },
    totals: { historyPublic: 1, historyPrivate: 0, phone: 1 },
  }
}

test('状态解析：合法结构往返，内容比较忽略 generatedAt', () => {
  const state = parseSyncState(validState())
  assert.ok(state)
  assert.equal(state.manifests['1'].original.sha256, 'o1')
  assert.equal(state.phones['a'.repeat(64)].start, 1)

  const later = { ...state, generatedAt: '2026-10-15T00:00:00.000Z' }
  assert.equal(stateContentEquals(state, later), true)
  const changed = { ...state, totals: { historyPublic: 2, historyPrivate: 0, phone: 1 } }
  assert.equal(stateContentEquals(state, changed), false)
})

test('状态解析：版本不符或手机条目缺字段时返回 null，触发全量重建', () => {
  assert.equal(parseSyncState({ ...validState(), version: 2 }), null)
  const broken = validState()
  broken.phones = { ['a'.repeat(64)]: { etag: 'p1', sha256: 'ps1', dedupMode: 'file', wod: null } }
  assert.equal(parseSyncState(broken), null)
  assert.equal(parseSyncState(null), null)
})

test('状态解析：无 session 的手机对象可以只有 skipped 标记', () => {
  const value = validState()
  value.phones = { ['b'.repeat(64)]: { etag: 'p2', sha256: 'ps2', dedupMode: 'file', wod: null, skipped: 'no-session' } }
  assert.ok(parseSyncState(value))
})
