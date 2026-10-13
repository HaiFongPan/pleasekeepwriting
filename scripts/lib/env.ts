/**
 * 极简 .env 读取/回写，避免依赖 Node 的 --env-file 与 shell 注入方式。
 * .env 已在 .gitignore 中，凭据不会进入仓库。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** 解析 .env 文本为键值对，忽略注释与空行 */
function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }

    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    const quoted = (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    if (quoted && value.length >= 2) {
      value = value.slice(1, -1)
    }

    result[key] = value
  }

  return result
}

/**
 * 读取仓库根目录的 .env，只在变量未设置时填充，避免覆盖 shell 注入的同名变量。
 * @returns .env 的绝对路径，不存在时返回 null
 */
export function loadDotEnv(file = '.env'): string | null {
  const filePath = path.resolve(process.cwd(), file)
  if (!fs.existsSync(filePath)) {
    return null
  }

  for (const [key, value] of Object.entries(parseDotEnv(fs.readFileSync(filePath, 'utf8')))) {
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }

  return filePath
}

/** 确认 .env 已被 gitignore，避免把凭据写进会被提交的文件 */
function assertIgnored(filePath: string) {
  const gitignorePath = path.resolve(process.cwd(), '.gitignore')
  const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : ''
  const ignored = content.split(/\r?\n/).some(line => line.trim() === '.env' || line.trim() === '/.env')

  if (!ignored) {
    throw new Error(`${path.basename(filePath)} 未被 .gitignore 忽略，拒绝写入凭据。`)
  }
}

/** 写入或替换 .env 中的某个变量，返回 .env 路径 */
export function upsertDotEnv(key: string, value: string, file = '.env'): string {
  const filePath = path.resolve(process.cwd(), file)
  assertIgnored(filePath)

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
  const lines = existing ? existing.split(/\r?\n/) : []
  const pattern = new RegExp(`^\\s*${key}\\s*=`)
  let replaced = false
  const next = lines.map((line) => {
    if (replaced || !pattern.test(line)) {
      return line
    }

    replaced = true
    return `${key}=${value}`
  })

  if (!replaced) {
    while (next.length > 0 && next[next.length - 1].trim() === '') {
      next.pop()
    }

    next.push(`${key}=${value}`, '')
  }

  fs.writeFileSync(filePath, next.join('\n'), 'utf8')
  return filePath
}

/** 只展示首尾字符，用于日志确认身份而不泄露凭据 */
export function maskSecret(value: string): string {
  if (value.length <= 8) {
    return '***'
  }

  return `${value.slice(0, 4)}***${value.slice(-2)}`
}

/** 读取必填环境变量，缺失时给出可执行的修复提示 */
export function requireEnv(name: string, hint: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`缺少环境变量 ${name}。${hint}`)
  }

  return value
}
