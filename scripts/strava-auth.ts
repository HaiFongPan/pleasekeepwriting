/**
 * 一次性 OAuth 授权：拿 Strava refresh token。
 *
 * 现状：本账号的 API 应用处于 Inactive（403 Application/Status/Inactive，Strava 2025 年后要求
 * 持有应用的账号有订阅），官方 API 路线暂时走不通，实际同步见 scripts/sync-strava.ts 与
 * scripts/lib/strava-web.ts。本脚本保留给 API 路线恢复后的重新授权使用。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import process from 'node:process'
import { loadDotEnv, maskSecret, requireEnv, upsertDotEnv } from './lib/env'
import { stravaOauthUrl } from './lib/strava-api'

const port = Number.parseInt(process.env.STRAVA_AUTH_PORT ?? '8787', 10)
const timeoutMs = Number.parseInt(process.env.STRAVA_AUTH_TIMEOUT_MS ?? '300000', 10)
const redirectUri = `http://127.0.0.1:${port}/callback`
const scope = 'activity:read'

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_at?: number
  scope?: string
  athlete?: { id?: number, firstname?: string, lastname?: string }
  message?: string
}

function respond(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>Strava 授权</title><body style="font:16px/1.6 system-ui;padding:3rem;max-width:32rem;margin:auto">${body}</body>`)
}

async function exchangeCode(code: string, clientId: string, clientSecret: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
  })

  const response = await fetch(stravaOauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const payload = await response.json() as TokenResponse
  if (!response.ok || !payload.refresh_token) {
    throw new Error(`授权码换取 token 失败（HTTP ${response.status}）：${payload.message ?? '未返回 refresh_token'}`)
  }

  return payload
}

function openBrowser(url: string) {
  if (process.platform !== 'darwin') {
    return
  }

  try {
    execFile('open', [url], () => {})
  }
  catch {
    // 打开失败不影响流程，用户可手动复制链接
  }
}

async function main() {
  loadDotEnv()
  const clientId = requireEnv('STRAVA_CLIENT_ID', '在 Strava 应用设置页可以找到。')
  const clientSecret = requireEnv('STRAVA_CLIENT_SECRET', '只在本地 .env 或 shell 环境里配置，不要提交。')

  const state = randomBytes(12).toString('hex')
  const authorizeUrl = new URL('https://www.strava.com/oauth/authorize')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('approval_prompt', 'auto')
  authorizeUrl.searchParams.set('scope', scope)
  authorizeUrl.searchParams.set('state', state)

  console.log('即将打开 Strava 授权页；若浏览器没有自动打开，请手动访问：')
  console.log(authorizeUrl.toString())
  console.log(`回调地址：${redirectUri}\nscope：${scope}（只要读取公开/关注者可见的活动，不含 Only Me）`)

  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', redirectUri)
      if (url.pathname !== '/callback') {
        respond(res, 404, 'Not found')
        return
      }

      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')

      if (error || returnedState !== state || !code) {
        respond(res, 400, `授权失败：${error ?? 'state 不匹配或缺少 code'}，可以关掉这个页面重试。`)
        server.close()
        reject(new Error(`授权失败：${error ?? 'state 不匹配或缺少 code'}`))
        return
      }

      try {
        const tokens = await exchangeCode(code, clientId, clientSecret)
        const refreshToken = tokens.refresh_token as string
        let saved: string | null = null
        try {
          saved = upsertDotEnv('STRAVA_REFRESH_TOKEN', refreshToken)
        }
        catch (writeError) {
          console.warn(`警告：无法写入 .env（${writeError instanceof Error ? writeError.message : String(writeError)}）`)
        }

        respond(res, 200, `<h2>授权成功</h2><p>运动员 ID：${tokens.athlete?.id ?? '未知'}，已授予 scope：${tokens.scope ?? scope}。</p><p>可以关闭本页面，回到终端继续。</p>`)
        console.log(`\n授权成功。运动员 ID：${tokens.athlete?.id ?? '未知'}，scope：${tokens.scope ?? scope}`)
        if (saved) {
          console.log(`refresh token（${maskSecret(refreshToken)}）已写入 ${saved}`)
        }
        else {
          console.log(`未能写入 .env，请手动把下面的值保存到环境变量 STRAVA_REFRESH_TOKEN：\n${refreshToken}`)
        }

        server.close()
        resolve()
      }
      catch (exchangeError) {
        respond(res, 500, `换取 token 失败：${exchangeError instanceof Error ? exchangeError.message : String(exchangeError)}`)
        server.close()
        reject(exchangeError)
      }
    })

    const timer = setTimeout(() => {
      server.close()
      reject(new Error(`等待授权超时（${Math.round(timeoutMs / 1000)} 秒）。`))
    }, timeoutMs)

    server.on('close', () => clearTimeout(timer))
    server.listen(port, '127.0.0.1', () => openBrowser(authorizeUrl.toString()))
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
