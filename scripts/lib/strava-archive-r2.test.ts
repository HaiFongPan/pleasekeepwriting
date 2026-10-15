import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { loadR2ConfigFile, r2ConfigFromEnv } from './strava-archive-r2'

const configKeys = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_UPLOAD_ACCESS_KEY_ID', 'R2_UPLOAD_SECRET_ACCESS_KEY'] as const

function withConfigEnv<T>(values: Partial<Record<typeof configKeys[number], string>>, run: () => T): T {
  const saved = new Map(configKeys.map(key => [key, process.env[key]]))
  for (const key of configKeys) {
    delete process.env[key]
  }

  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value
  }

  try {
    return run()
  }
  finally {
    for (const key of configKeys) {
      const previous = saved.get(key)
      if (previous === undefined) {
        delete process.env[key]
      }
      else {
        process.env[key] = previous
      }
    }
  }
}

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-config-test-'))
  try {
    return run(dir)
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('R2_CONFIG_FILE 支持 dotenv 配置文件', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'workout-r2.env')
    fs.writeFileSync(file, [
      '# 注释与空行会被忽略',
      'R2_ENDPOINT=https://account.r2.cloudflarestorage.com',
      'R2_BUCKET=fixture-bucket',
      'R2_UPLOAD_ACCESS_KEY_ID=fixture-upload-id',
      'R2_UPLOAD_SECRET_ACCESS_KEY=fixture-upload-secret',
      '',
    ].join('\n'))

    withConfigEnv({}, () => {
      assert.equal(loadR2ConfigFile(file), file)
      assert.deepEqual(r2ConfigFromEnv(), {
        endpoint: 'https://account.r2.cloudflarestorage.com',
        bucket: 'fixture-bucket',
        accessKeyId: 'fixture-upload-id',
        secretAccessKey: 'fixture-upload-secret',
      })
    })
  })
})

test('R2_CONFIG_FILE 支持 JSON，且不覆盖已设置的环境变量', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'workout-r2.json')
    fs.writeFileSync(file, JSON.stringify({
      R2_ENDPOINT: 'https://file.r2.cloudflarestorage.com',
      R2_BUCKET: 'file-bucket',
      R2_UPLOAD_ACCESS_KEY_ID: 'file-id',
      R2_UPLOAD_SECRET_ACCESS_KEY: 'file-secret',
    }))

    withConfigEnv({ R2_ENDPOINT: 'https://shell.r2.cloudflarestorage.com' }, () => {
      loadR2ConfigFile(file)
      assert.deepEqual(r2ConfigFromEnv(), {
        endpoint: 'https://shell.r2.cloudflarestorage.com',
        bucket: 'file-bucket',
        accessKeyId: 'file-id',
        secretAccessKey: 'file-secret',
      })
    })
  })
})

test('缺失的 R2 变量在报错里点名', () => {
  withConfigEnv({}, () => {
    assert.throws(() => r2ConfigFromEnv(), /R2_ENDPOINT/)
  })

  withConfigEnv({
    R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
    R2_BUCKET: 'fixture-bucket',
    R2_UPLOAD_ACCESS_KEY_ID: 'fixture-upload-id',
  }, () => {
    assert.throws(() => r2ConfigFromEnv(), /R2_UPLOAD_SECRET_ACCESS_KEY/)
  })
})

test('非法的 R2_ENDPOINT 被拒绝', () => {
  withConfigEnv({
    R2_ENDPOINT: 'not a url',
    R2_BUCKET: 'fixture-bucket',
    R2_UPLOAD_ACCESS_KEY_ID: 'fixture-upload-id',
    R2_UPLOAD_SECRET_ACCESS_KEY: 'fixture-upload-secret',
  }, () => {
    assert.throws(() => r2ConfigFromEnv(), /R2_ENDPOINT/)
  })
})

test('R2_CONFIG_FILE 不存在时报错不打印内容', () => {
  withTempDir((dir) => {
    assert.throws(() => loadR2ConfigFile(path.join(dir, 'missing.env')), /不存在/)
  })
})
