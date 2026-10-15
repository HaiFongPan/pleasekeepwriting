import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
// 独立 Worker 使用 Node 内置测试运行器，不依赖 Vitest。
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import worker, { MAX_BYTES } from '../src/index.mjs'
import { createTestFit } from './fixture.mjs'

const token = 'test-only-token-with-at-least-32-characters'

function setup() {
  const objects = new Map()
  const env = {
    UPLOAD_TOKEN: token,
    REQUEST_LIMITER: { limit: async () => ({ success: true }) },
    UPLOAD_LIMITER: { limit: async () => ({ success: true }) },
    ARCHIVE: {
      async put(key, value, options) {
        assert.equal(options.onlyIf.etagDoesNotMatch, '*')
        if (objects.has(key))
          return null
        const archive = { key, size: value.byteLength, customMetadata: options.customMetadata }
        objects.set(key, { value, options, archive })
        return archive
      },
      async head(key) {
        return objects.get(key)?.archive ?? null
      },
    },
  }
  return { env, objects }
}

function request(body = createTestFit(), headers = {}, method = 'POST', path = '/v1/workouts') {
  return new Request(`https://upload.example${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/octet-stream', ...headers },
    ...(method === 'GET' ? {} : { body, duplex: 'half' }),
  })
}

test('合法 FIT 持久保存，按运动内容标识命名，默认不发布', async () => {
  const { env, objects } = setup()
  const fit = createTestFit()
  const response = await worker.fetch(request(fit), env)
  assert.equal(response.status, 201)
  const result = await response.json()
  assert.equal(result.status, 'stored')
  assert.equal(result.sha256, createHash('sha256').update(fit).digest('hex'))
  assert.equal(result.archiveSha256, result.sha256)
  assert.equal(result.dedupMode, 'workoutdoors-content')
  const saved = objects.get(`activities/v1/${result.activityId}.fit`)
  assert.deepEqual(new Uint8Array(saved.value), fit)
  assert.equal(saved.options.customMetadata.publication, 'private')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

test('重复与并发上传只保留一份', async () => {
  const { env, objects } = setup()
  const responses = await Promise.all([worker.fetch(request(), env), worker.fetch(request(), env)])
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 201])
  assert.equal(objects.size, 1)
  assert.equal((await (responses.find(r => r.status === 200)).json()).status, 'exists')
})

test('不同导出原件并发上传同一运动，仅保留赢家原件', async () => {
  const { env, objects } = setup()
  const files = [createTestFit(), createTestFit({ serialNumber: 999, exportedAt: new Date('2026-10-16T00:00:00Z') })]
  const responses = await Promise.all(files.map(file => worker.fetch(request(file), env)))
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 201])
  const results = await Promise.all(responses.map(r => r.json()))
  assert.notEqual(results[0].sha256, results[1].sha256)
  assert.equal(results[0].activityId, results[1].activityId)
  assert.equal(results[0].archiveSha256, results[1].archiveSha256)
  assert.equal(objects.size, 1)
  const saved = [...objects.values()][0]
  assert.equal(results[0].archiveSha256, createHash('sha256').update(saved.value).digest('hex'))
})

test('条件写入失败但归档元信息缺失时不谎报 exists', async () => {
  const { env } = setup()
  env.ARCHIVE.put = async () => null
  assert.equal((await worker.fetch(request(), env)).status, 503)
})

test('未授权或错误令牌不写入', async () => {
  const { env, objects } = setup()
  for (const authorization of ['', 'Bearer wrong', `Basic ${token}`]) {
    const response = await worker.fetch(request(undefined, { Authorization: authorization }), env)
    assert.equal(response.status, 401)
  }
  assert.equal(objects.size, 0)
})

test('未配置令牌时拒绝服务', async () => {
  const { env } = setup()
  delete env.UPLOAD_TOKEN
  assert.equal((await worker.fetch(request(), env)).status, 503)
})

test('仅允许指定路径 POST，不提供下载删除或列举', async () => {
  const { env } = setup()
  assert.equal((await worker.fetch(request(undefined, {}, 'GET'), env)).status, 405)
  assert.equal((await worker.fetch(request(undefined, {}, 'DELETE'), env)).status, 405)
  assert.equal((await worker.fetch(request(undefined, {}, 'POST', '/raw/a.fit'), env)).status, 404)
})

test('拒绝空文件、假 FIT 和 CRC 损坏', async () => {
  const { env, objects } = setup()
  const damaged = createTestFit()
  damaged[damaged.length - 1] ^= 1
  for (const input of [new Uint8Array(), new TextEncoder().encode('not a FIT'), damaged]) {
    assert.equal((await worker.fetch(request(input), env)).status, 422)
  }
  assert.equal(objects.size, 0)
})

test('拒绝压缩体和 multipart，避免把包装当作文件', async () => {
  const { env } = setup()
  for (const headers of [{ 'Content-Type': 'multipart/form-data' }, { 'Content-Encoding': 'gzip' }]) {
    assert.equal((await worker.fetch(request(undefined, headers), env)).status, 415)
  }
})

test('声明超限与未声明长度的流式超限均拒绝', async () => {
  const { env, objects } = setup()
  assert.equal((await worker.fetch(request(undefined, { 'Content-Length': String(MAX_BYTES + 1) }), env)).status, 413)
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(MAX_BYTES))
      c.enqueue(new Uint8Array(1))
      c.close()
    },
  })
  assert.equal((await worker.fetch(request(stream), env)).status, 413)
  assert.equal(objects.size, 0)
})

test('来源和令牌限流均返回 429，未写入', async () => {
  for (const name of ['REQUEST_LIMITER', 'UPLOAD_LIMITER']) {
    const { env, objects } = setup()
    env[name].limit = async () => ({ success: false })
    const response = await worker.fetch(request(), env)
    assert.equal(response.status, 429)
    assert.equal(response.headers.get('Retry-After'), '60')
    assert.equal(objects.size, 0)
  }
})

test('R2 写入失败不报告成功，也不回显内部异常', async () => {
  const { env } = setup()
  env.ARCHIVE.put = async () => {
    throw new Error('sensitive-internal-message')
  }
  const response = await worker.fetch(request(), env)
  assert.equal(response.status, 503)
  assert.ok(!(await response.text()).includes('sensitive-internal-message'))
})
