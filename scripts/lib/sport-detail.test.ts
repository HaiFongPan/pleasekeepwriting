import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { buildDetailFile } from './sport-detail'

function line(count: number) {
  const time: number[] = []
  const distance: number[] = []
  const latlng: Array<{ lat: number, lng: number }> = []
  for (let index = 0; index < count; index++) {
    time.push(index * 10)
    distance.push(index * 30)
    latlng.push({ lat: 30 + index * 0.0003, lng: 120 })
  }

  return { time, distance, latlng }
}

test('详情曲线：有距离时按距离等距抽样，段内取均值', () => {
  const { time, distance } = line(101)
  const file = buildDetailFile({
    time,
    distance,
    heartrate: time.map((_, index) => 120 + index * 0.5),
    altitude: time.map(() => 10),
  }, { kind: 'ride', samples: 10 })

  assert.ok(file)
  assert.equal(file.axis, 'distance')
  assert.equal(file.d?.length, 10)
  assert.equal(file.d?.[9], 3000)
  assert.equal(file.t[9], 1000)
  // 匀速 3 m/s
  assert.ok(file.spd?.every(value => value === 3))
  assert.ok(file.alt?.every(value => value === 10))
  // 心率单调递增，均值也应单调
  const hr = file.hr as number[]
  assert.ok(hr.every((value, index) => index === 0 || value >= hr[index - 1]))
  assert.equal(file.xy, undefined)
})

test('详情曲线：停下的时间不计入移动时间，也不拉低速度', () => {
  const time = [0, 10, 20, 30, 330, 340, 350, 360, 370, 380, 390, 400]
  const distance = [0, 30, 60, 90, 90, 120, 150, 180, 210, 240, 270, 300]
  const file = buildDetailFile({ time, distance }, { kind: 'run', samples: 4 })

  assert.ok(file)
  assert.equal(file.t[file.t.length - 1], 100)
  assert.ok(file.spd?.every(value => value === 3))
})

test('详情曲线：没有距离（HIIT）按移动时间抽样，不输出速度', () => {
  const time = Array.from({ length: 60 }, (_, index) => index * 5)
  const file = buildDetailFile({
    time,
    distance: time.map(() => 3),
    heartrate: time.map(() => 150),
  }, { kind: 'other', samples: 12 })

  assert.ok(file)
  assert.equal(file.axis, 'time')
  assert.equal(file.d, undefined)
  assert.equal(file.spd, undefined)
  assert.equal(file.t[11], 295)
  assert.ok(file.hr?.every(value => value === 150))
})

test('详情曲线：隐私圈外的点才有路线坐标，圈内为 null', () => {
  const { time, distance, latlng } = line(100)
  const frame = { from: 20, to: 79, project: (point: { lat: number }) => [Math.round((point.lat - 30) * 1e4), 0] as [number, number] }
  const file = buildDetailFile({ time, distance, latlng }, { kind: 'run', frame, samples: 10 })

  assert.ok(file?.xy)
  assert.equal(file.xy[0], null)
  assert.equal(file.xy[9], null)
  assert.ok(file.xy.slice(2, 8).every(point => point != null))
})

test('详情曲线：跑步步频换算成双脚，覆盖率太低的通道丢弃', () => {
  const { time, distance } = line(50)
  const file = buildDetailFile({
    time,
    distance,
    cadence: time.map(() => 85),
    heartrate: time.map((_, index) => (index < 5 ? 140 : null)),
  }, { kind: 'run', samples: 10 })

  assert.ok(file)
  assert.ok(file.cad?.every(value => value === 170))
  assert.equal(file.hr, undefined)
})

test('详情曲线：点太少或时间流异常时不生成', () => {
  assert.equal(buildDetailFile({ time: [0, 1, 2] }, { kind: 'run' }), null)
  assert.equal(buildDetailFile({ time: Array.from({ length: 20 }, () => Number.NaN) }, { kind: 'run' }), null)
})
