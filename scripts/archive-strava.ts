/**
 * 把 Strava 历史全量归档到私有 R2（共享协议 v1）。
 *
 * 用法（仓库根目录）：
 *   R2_CONFIG_FILE=~/.config/workout-r2.env pnpm exec tsx scripts/archive-strava.ts
 *   R2_CONFIG_FILE=~/.config/workout-r2.env pnpm exec tsx scripts/archive-strava.ts --limit 5
 *   R2_CONFIG_FILE=~/.config/workout-r2.env pnpm exec tsx scripts/archive-strava.ts --verify
 *
 * 凭据：
 *   - Strava：.env 或环境变量里的 STRAVA_COOKIE_STRAVA4_SESSION（浏览器登录态）；
 *   - R2：R2_ENDPOINT / R2_BUCKET / R2_UPLOAD_ACCESS_KEY_ID / R2_UPLOAD_SECRET_ACCESS_KEY，
 *     或 R2_CONFIG_FILE 指向的本机配置文件（dotenv 或 JSON，逐个变量填充）。
 *
 * 行为：
 *   - 逐页拉完训练日志（含私密活动），每条写 manifest + 原件 + 完整 streams；
 *   - 断点续跑：已有 manifest 且对象还在时跳过大文件，只刷新训练元信息；
 *   - 明确 404 记 unavailable；401/403/429 直接中止整轮；5xx 低频重试后仍失败计入 failedIds；
 *   - 只有整轮扫描完整、全部活动都有 manifest 且无失败时才把索引标 complete；
 *   - --limit N 只做 N 次真实归档（刷新元信息不计入），属于部分执行，不会更新索引；
 *   - --verify 复用已有对象前重新读回并按 manifest 的 sha256 逐字节校验。
 *
 * 终端只输出数量、状态与活动编号，不输出运动名称、地点或凭据。
 */

import type { ArchiveRunSummary } from './lib/strava-archive'
import process from 'node:process'
import { loadDotEnv } from './lib/env'
import { archiveIndexKey, archiveStrava } from './lib/strava-archive'
import { createR2ArchiveStorage, loadR2ConfigFile, r2ConfigFromEnv } from './lib/strava-archive-r2'
import { fetchAllStreams, fetchOriginalFile, fetchTrainingActivities, requireCookie } from './lib/strava-web'

interface CliOptions {
  limit: number | null
  verify: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { limit: null, verify: argv.includes('--verify') }
  const index = argv.indexOf('--limit')
  if (index < 0) {
    return options
  }

  const raw = argv[index + 1]
  const limit = Number.parseInt(raw ?? '', 10)
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('--limit 需要一个正整数，例如 --limit 5。')
  }

  options.limit = limit
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  loadDotEnv()

  const configFile = process.env.R2_CONFIG_FILE?.trim()
  if (configFile) {
    loadR2ConfigFile(configFile)
  }

  requireCookie()
  const storage = await createR2ArchiveStorage(r2ConfigFromEnv())

  let summary: ArchiveRunSummary
  try {
    summary = await archiveStrava({
      source: {
        fetchActivitiesPage: fetchTrainingActivities,
        fetchOriginal: fetchOriginalFile,
        fetchStreams: fetchAllStreams,
      },
      storage,
      log: line => console.log(line),
    }, options)
  }
  finally {
    storage.dispose()
  }

  console.log('\n归档结果：')
  console.log(`  模式：${options.verify ? '--verify（复用对象前逐字节校验 sha256）' : '默认'}`)
  console.log(`  训练日志：扫描 ${summary.pages} 页，发现 ${summary.discovered} 条（接口声明 ${summary.total} 条）${summary.scanComplete ? '' : '，未扫完'}`)
  console.log(`  本次处理 ${summary.processed} 条${summary.limited ? `（--limit ${options.limit}）` : ''}，仅刷新元信息 ${summary.refreshed} 条`)
  console.log(`  原件：新写 ${summary.originalStored}，不可用 ${summary.originalUnavailable}，复用 ${summary.originalReused}`)
  console.log(`  轨迹流：新写 ${summary.streamsStored}，不可用/无流 ${summary.streamsUnavailable}，复用 ${summary.streamsReused}`)
  if (summary.failedIds.length > 0) {
    console.log(`  失败 ${summary.failedIds.length} 条：#${summary.failedIds.join(' #')}（重跑本脚本会自动续传）`)
  }
  else {
    console.log('  失败 0 条')
  }

  if (summary.indexWritten) {
    console.log(`  索引已更新：${archiveIndexKey}（total=${summary.discovered} complete=${summary.complete}）`)
  }
  else {
    console.log('  未更新索引（部分执行或未扫完，留待下一轮）')
  }

  if (!summary.scanComplete || summary.failedIds.length > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
