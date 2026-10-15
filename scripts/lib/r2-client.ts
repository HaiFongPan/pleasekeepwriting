/**
 * 只读 R2 客户端（S3 API）。
 *
 * 只用四个只读凭据：R2_ENDPOINT / R2_BUCKET / R2_READ_ACCESS_KEY_ID /
 * R2_READ_SECRET_ACCESS_KEY。本模块不写任何对象；日志与错误信息里不出现
 * 凭据、对象键或对象内容，出错时只保留错误名与 HTTP 状态码。
 */

import process from 'node:process'
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

export interface R2Config {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export interface R2ObjectInfo {
  key: string
  etag: string
  size: number
}

export interface R2Object {
  bytes: Uint8Array
  etag: string
}

/** 只读对象存储的最小接口，测试里用内存实现替换 */
export interface R2Reader {
  /** 分页列出某个前缀下的全部对象（键 + etag + 大小） */
  list: (prefix: string) => Promise<R2ObjectInfo[]>
  /** 读取对象；明确 404 时返回 null，其余错误抛出 */
  get: (key: string) => Promise<R2Object | null>
}

export class R2RequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'R2RequestError'
  }
}

/** 读取必填的只读凭据，缺失时只报告变量名，不打印取值 */
export function readR2Config(env: NodeJS.ProcessEnv = process.env): R2Config {
  return {
    endpoint: requireEnv(env, 'R2_ENDPOINT'),
    bucket: requireEnv(env, 'R2_BUCKET'),
    accessKeyId: requireEnv(env, 'R2_READ_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv(env, 'R2_READ_SECRET_ACCESS_KEY'),
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(`缺少环境变量 ${name}（需要 R2 只读凭据）`)
  }

  return value
}

export function normalizeEtag(etag: string | undefined): string {
  return (etag ?? '').replaceAll('"', '')
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  const candidate = error as { name?: string, $metadata?: { httpStatusCode?: number } }
  return candidate.name === 'NoSuchKey'
    || candidate.name === 'NotFound'
    || candidate.$metadata?.httpStatusCode === 404
}

function toR2Error(error: unknown): R2RequestError {
  const name = error instanceof Error ? error.name : 'UnknownError'
  const status = typeof error === 'object' && error !== null
    ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    : undefined

  return new R2RequestError(`R2 请求失败（${name}${status ? ` / HTTP ${status}` : ''}）`)
}

/** 创建只读客户端。不会自动读取 .env，调用方先调用 loadDotEnv()。 */
export function createR2Reader(config: R2Config): R2Reader {
  const client: S3Client = new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })

  return {
    async list(prefix) {
      const objects: R2ObjectInfo[] = []
      let continuationToken: string | undefined

      try {
        do {
          const page = await client.send(new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }))

          for (const item of page.Contents ?? []) {
            if (!item.Key) {
              continue
            }

            objects.push({ key: item.Key, etag: normalizeEtag(item.ETag), size: item.Size ?? 0 })
          }

          continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
        } while (continuationToken)
      }
      catch (error) {
        throw toR2Error(error)
      }

      return objects
    },

    async get(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
        if (!response.Body) {
          throw new R2RequestError('R2 返回了空对象')
        }

        const bytes = await response.Body.transformToByteArray()
        return { bytes, etag: normalizeEtag(response.ETag) }
      }
      catch (error) {
        if (isNotFoundError(error)) {
          return null
        }

        if (error instanceof R2RequestError) {
          throw error
        }

        throw toR2Error(error)
      }
    },
  }
}
