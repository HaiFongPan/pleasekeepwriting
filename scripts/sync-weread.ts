/**
 * 同步微信读书已读书目。
 *
 * 用法：在项目外通过 shell 配置 WEREAD_API_KEY（或兼容变量 WEREAD_TOKEN），
 * 然后运行 `pnpm sync-weread`。凭据只从进程环境读取，不接受命令行参数，也不会写入文件。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const gatewayUrl = 'https://i.weread.qq.com/api/agent/gateway'
const skillVersion = '1.0.4'
const outputPath = 'src/data/weread-books.json'
const requestConcurrency = 5

interface GatewayError {
  errcode?: number
}

interface ShelfBook {
  bookId: string
  title: string
  author: string
  cover: string
  deepLink: string
  finishReading?: number
  readUpdateTime?: number
}

interface ShelfResponse extends GatewayError {
  books?: ShelfBook[]
}

interface ProgressResponse extends GatewayError {
  book?: {
    finishTime?: number
  }
}

interface ReviewResponse extends GatewayError {
  reviews?: Array<{
    review?: {
      type?: number
      star?: number
    }
  }>
}

interface WereadBook {
  bookId: string
  title: string
  author: string
  cover: string
  finishedAt: string | null
  rating: number | null
  deepLink: string
}

function getToken(): string {
  const token = process.env.WEREAD_API_KEY || process.env.WEREAD_TOKEN

  if (!token) {
    throw new Error('缺少微信读书凭据。请在项目外设置 WEREAD_API_KEY（或 WEREAD_TOKEN）后重试。')
  }

  return token
}

async function callApi<T extends GatewayError>(token: string, apiName: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(gatewayUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_name: apiName,
      skill_version: skillVersion,
      ...params,
    }),
  })

  if (!response.ok) {
    throw new Error(`${apiName} 请求失败（HTTP ${response.status}）`)
  }

  const result = await response.json() as T
  if (typeof result.errcode === 'number' && result.errcode !== 0) {
    throw new Error(`${apiName} 请求失败（errcode ${result.errcode}）`)
  }

  return result
}

function formatShanghaiDate(timestamp?: number): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return null
  }

  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp * 1000))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))

  return `${values.year}-${values.month}-${values.day}`
}

function getRating(response: ReviewResponse): number | null {
  const star = response.reviews
    ?.map(item => item.review)
    .find(review => review?.type === 4 && review.star != null)
    ?.star

  if (star == null || star < 20 || star > 100 || star % 20 !== 0) {
    return null
  }

  return star / 20
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await worker(items[index])
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker))
  return results
}

async function syncBook(token: string, book: ShelfBook): Promise<WereadBook> {
  let finishedAt = formatShanghaiDate(book.readUpdateTime)
  let rating: number | null = null

  try {
    const progress = await callApi<ProgressResponse>(token, '/book/getprogress', { bookId: book.bookId })
    finishedAt = formatShanghaiDate(progress.book?.finishTime) ?? finishedAt
  }
  catch (error) {
    console.warn(`警告：${book.title}（${book.bookId}）完成时间同步失败，已回退到书架更新时间：${String(error)}`)
  }

  try {
    const reviews = await callApi<ReviewResponse>(token, '/review/list/mine', {
      bookid: book.bookId,
      count: 2000,
      synckey: 0,
    })
    rating = getRating(reviews)
  }
  catch (error) {
    console.warn(`警告：${book.title}（${book.bookId}）评分同步失败，已按无评分处理：${String(error)}`)
  }

  return {
    bookId: String(book.bookId),
    title: book.title,
    author: book.author,
    cover: book.cover,
    finishedAt,
    rating,
    deepLink: book.deepLink,
  }
}

async function writeJsonAtomically(filePath: string, contents: string) {
  const directory = path.dirname(filePath)
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.tmp`)

  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(temporaryPath, contents, 'utf8')
  await fs.rename(temporaryPath, filePath)
}

async function main() {
  const token = getToken()
  const shelf = await callApi<ShelfResponse>(token, '/shelf/sync')
  const finishedBooks = (shelf.books ?? []).filter(book => book.finishReading === 1)

  if (finishedBooks.length === 0) {
    throw new Error('微信读书书架中没有找到已读完的书，未覆盖现有数据。')
  }

  const books = await mapWithConcurrency(finishedBooks, requestConcurrency, book => syncBook(token, book))
  books.sort((left, right) => {
    const byFinishedAt = (right.finishedAt ?? '').localeCompare(left.finishedAt ?? '')
    return byFinishedAt || left.bookId.localeCompare(right.bookId)
  })

  const output = {
    generatedAt: new Date().toISOString(),
    books,
  }
  await writeJsonAtomically(outputPath, `${JSON.stringify(output, null, 2)}\n`)

  const ratings = books.filter(book => book.rating != null).length
  const missingDates = books.filter(book => book.finishedAt == null).length
  console.log(`已同步 ${books.length} 本已读书目，其中 ${ratings} 本有评分，${missingDates} 本缺少完成时间。`)
  console.log(`数据已写入 ${outputPath}。`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
