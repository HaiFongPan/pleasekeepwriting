import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { canonicalValue, identifyFit } from '../src/identity.mjs'
import { createTestFit } from './fixture.mjs'

test('WorkOutDoors 重新导出的时间和序列号不改变运动标识', () => {
  const first = identifyFit(createTestFit())
  const second = identifyFit(createTestFit({ exportedAt: new Date('2026-10-16T00:00:00Z'), serialNumber: 101 }))
  assert.notEqual(first.sha256, second.sha256)
  assert.equal(first.activityId, second.activityId)
  assert.equal(first.dedupMode, 'workoutdoors-content')
})

test('真实采样、时间、暂停、圈段、汇总、传感器及开发者信息变化不会被合并', () => {
  const first = identifyFit(createTestFit())
  for (const options of [
    { start: new Date('2026-10-13T00:00:00Z') },
    { heartRate: 101 },
    { eventType: 'stop' },
    { distance: 1001 },
    { sessionDistance: 1002 },
    { sensorSerial: 201 },
    { sensorTime: new Date('2026-10-13T00:00:00Z') },
    { developerVersion: 2 },
    { records: 2 },
  ]) {
    assert.notEqual(first.activityId, identifyFit(createTestFit(options)).activityId, JSON.stringify(options))
  }
})

test('未知导出器与缺少活动汇总的文件保守按字节去重', () => {
  for (const options of [{ productName: 'AnotherExporter' }, { includeSession: false }]) {
    const first = identifyFit(createTestFit(options))
    const second = identifyFit(createTestFit({ ...options, serialNumber: 101 }))
    assert.equal(first.dedupMode, 'file')
    assert.notEqual(first.activityId, second.activityId)
  }
})

test('规范化只排序对象字段，不改变数组顺序、时间或未知字段', () => {
  assert.equal(canonicalValue({ a: 1, b: 2 }), canonicalValue({ b: 2, a: 1 }))
  assert.notEqual(canonicalValue([1, 2]), canonicalValue([2, 1]))
  assert.notEqual(canonicalValue({ timestamp: 100 }), canonicalValue({ timestamp: 101 }))
  assert.notEqual(canonicalValue({ unknown: 1 }), canonicalValue({ unknown: 2 }))
  assert.notEqual(canonicalValue(new Uint8Array([1, 2])), canonicalValue([1, 2]))
})

test('解码预算超限保守回退，避免内存无限膨胀或误合并', () => {
  const fit = createTestFit({ records: 20_010 })
  assert.equal(identifyFit(fit).dedupMode, 'file')
})
