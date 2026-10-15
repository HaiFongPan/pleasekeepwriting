import { archiveKey, archiveMetadata, identifyFit, InvalidFitError } from './identity.mjs'

export const MAX_BYTES = 10 * 1024 * 1024
const BODY_TIMEOUT_MS = 30_000

class UploadError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function json(status, body) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(status === 429 ? { 'Retry-After': '60' } : {}),
      ...(status === 405 ? { Allow: 'POST' } : {}),
    },
  })
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

async function authorize(request, env) {
  if (!env.UPLOAD_TOKEN || env.UPLOAD_TOKEN.length < 32) {
    throw new UploadError(503, '上传服务尚未配置')
  }
  const allowed = await env.REQUEST_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' })
  if (!allowed.success)
    throw new UploadError(429, '请求过于频繁，请稍后重试')

  // 比较固定长度摘要，避免按令牌前缀提前返回。
  const encoder = new TextEncoder()
  const actual = await sha256(encoder.encode(request.headers.get('Authorization') || ''))
  const expected = await sha256(encoder.encode(`Bearer ${env.UPLOAD_TOKEN}`))
  let difference = 0
  for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i]
  if (difference !== 0)
    throw new UploadError(401, '上传令牌无效')

  const quota = await env.UPLOAD_LIMITER.limit({ key: 'phone-upload' })
  if (!quota.success)
    throw new UploadError(429, '上传过于频繁，请一分钟后重试')
}

function validateHeaders(request) {
  const encoding = request.headers.get('Content-Encoding')
  const contentType = request.headers.get('Content-Type') || ''
  if ((encoding && encoding !== 'identity') || contentType.toLowerCase().startsWith('multipart/')) {
    throw new UploadError(415, '请直接发送 FIT 文件内容，不要压缩或包装成表单')
  }
  const length = request.headers.get('Content-Length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
    throw new UploadError(413, '文件不能超过 10 MiB')
  }
}

async function readBody(request) {
  if (!request.body)
    throw new UploadError(422, '请选择 FIT 文件')
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new UploadError(408, '上传超时，请重试')), BODY_TIMEOUT_MS)
  })
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout])
      if (done)
        break
      size += value.byteLength
      if (size > MAX_BYTES)
        throw new UploadError(413, '文件不能超过 10 MiB')
      chunks.push(value)
    }
  }
  finally {
    clearTimeout(timer)
    // 不等待尚未发送完的请求体，超限时及时释放接收端。
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function store(request, env) {
  await authorize(request, env)
  validateHeaders(request)
  const bytes = await readBody(request)
  const identity = identifyFit(bytes)
  const key = archiveKey(identity)
  const stored = await env.ARCHIVE.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: archiveMetadata(identity),
  })
  // 并发竞争失败时读取赢家，返回实际保留原件的摘要，不能返回来件冒充原件。
  const archive = stored ?? await env.ARCHIVE.head(key)
  if (!archive?.customMetadata?.sha256 || archive.customMetadata.activityid !== identity.activityId) {
    throw new UploadError(503, '暂时无法确认归档结果，请稍后重试')
  }
  return json(stored ? 201 : 200, {
    status: stored ? 'stored' : 'exists',
    message: stored ? '已保存到私有运动档案' : '相同运动内容已归档，无需重复保存',
    sha256: identity.sha256,
    activityId: identity.activityId,
    archiveSha256: archive.customMetadata.sha256,
    dedupMode: identity.dedupMode,
    bytes: bytes.byteLength,
    archiveBytes: archive.size,
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/v1/workouts')
      return json(404, { error: '接口不存在' })
    if (request.method !== 'POST')
      return json(405, { error: '仅支持 POST 上传文件' })
    try {
      return await store(request, env)
    }
    catch (error) {
      if (error instanceof InvalidFitError)
        return json(422, { error: 'FIT 文件不完整或无法解析，请重新导出' })
      if (error instanceof UploadError)
        return json(error.status, { error: error.message })
      // 不向调用者或日志输出令牌、原文件、底层异常及存储配置。
      return json(503, { error: '暂时无法保存，请稍后重试' })
    }
  },
}
