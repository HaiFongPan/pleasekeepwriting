/**
 * 归档专用的 R2（S3 兼容）存储适配器与凭据加载。
 *
 * 依赖 @aws-sdk/client-s3：这里用动态 import，让归档核心与测试不装 SDK 也能跑；
 * 真正连 R2 之前才需要它（根依赖由同步链路一并提供）。
 *
 * 凭据来源（只填充尚未设置的变量，不覆盖 shell 注入）：
 *   1. 环境变量 R2_ENDPOINT / R2_BUCKET / R2_UPLOAD_ACCESS_KEY_ID / R2_UPLOAD_SECRET_ACCESS_KEY
 *   2. R2_CONFIG_FILE 指向的本机配置文件（dotenv 或 JSON，不硬编码任何个人路径）
 * 日志与报错只出现变量名，不打印凭据内容。
 */

import type { ArchiveStorage, ArchiveStorageObject } from './strava-archive'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { loadDotEnv, requireEnv } from './env'

export interface R2Config {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * 加载 R2 本机配置文件：.env 风格沿用仓库现有解析，JSON 则逐项填充未设置的环境变量。
 * @returns 配置文件的绝对路径
 */
export function loadR2ConfigFile(file: string): string {
  const filePath = path.resolve(process.cwd(), file)
  if (!fs.existsSync(filePath)) {
    throw new Error(`R2_CONFIG_FILE 指向的文件不存在：${file}`)
  }

  const content = fs.readFileSync(filePath, 'utf8')
  if (content.trimStart().startsWith('{')) {
    let values: Record<string, unknown>
    try {
      values = JSON.parse(content) as Record<string, unknown>
    }
    catch {
      throw new Error('R2_CONFIG_FILE 不是合法的 JSON。')
    }

    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string' && !(key in process.env)) {
        process.env[key] = value
      }
    }
  }
  else {
    loadDotEnv(file)
  }

  return filePath
}

/** 从环境变量读取归档所需的 R2 配置，缺失时给出可执行的提示 */
export function r2ConfigFromEnv(): R2Config {
  const endpoint = requireEnv('R2_ENDPOINT', '可在环境变量或 R2_CONFIG_FILE 里配置。')
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('unsupported protocol')
    }
  }
  catch {
    throw new Error('R2_ENDPOINT 不是合法的 http(s) 地址。')
  }

  return {
    endpoint,
    bucket: requireEnv('R2_BUCKET', '可在环境变量或 R2_CONFIG_FILE 里配置。'),
    accessKeyId: requireEnv('R2_UPLOAD_ACCESS_KEY_ID', '需要具备该 bucket 写权限的 S3 Access Key ID。'),
    secretAccessKey: requireEnv('R2_UPLOAD_SECRET_ACCESS_KEY', '需要具备该 bucket 写权限的 S3 Secret Access Key。'),
  }
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: string, $metadata?: { httpStatusCode?: number } }
  return candidate?.name === 'NoSuchKey'
    || candidate?.name === 'NotFound'
    || candidate?.$metadata?.httpStatusCode === 404
}

/** 创建基于 S3 SDK 的 R2 存储（region=auto，path-style，正是 R2 的用法） */
export async function createR2ArchiveStorage(config: R2Config): Promise<ArchiveStorage & { dispose: () => void }> {
  let sdk: typeof import('@aws-sdk/client-s3')
  try {
    sdk = await import('@aws-sdk/client-s3')
  }
  catch {
    throw new Error('缺少 @aws-sdk/client-s3 依赖，无法读写 R2。')
  }

  const client = new sdk.S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })

  return {
    async put(key, body, contentType) {
      await client.send(new sdk.PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }))
    },

    async get(key) {
      try {
        const result = await client.send(new sdk.GetObjectCommand({ Bucket: config.bucket, Key: key }))
        if (!result.Body) {
          return null
        }

        return new Uint8Array(await result.Body.transformToByteArray())
      }
      catch (error) {
        if (isNotFound(error)) {
          return null
        }

        throw error
      }
    },

    async list(prefix) {
      const objects: ArchiveStorageObject[] = []
      let token: string | undefined

      do {
        const result = await client.send(new sdk.ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }))

        for (const item of result.Contents ?? []) {
          if (item.Key) {
            objects.push({ key: item.Key, size: item.Size ?? 0 })
          }
        }

        token = result.IsTruncated ? result.NextContinuationToken : undefined
      } while (token)

      return objects
    },

    // 一次性脚本用完就释放连接，避免 keep-alive 套接字拖住进程
    dispose() {
      client.destroy()
    },
  }
}
