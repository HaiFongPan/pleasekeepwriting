import assert from 'node:assert/strict'
// eslint-disable-next-line test/no-import-node-test
import test from 'node:test'
import { fetchOriginalFile, StravaSessionExpiredError } from './strava-web'

test('导出跳回同一活动页时记录原件不可用，不误报 Cookie 失效', async (context) => {
  const response = new Response('<!doctype html><html>activity</html>')
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: 'https://www.strava.com/activities/123' },
  })
  context.mock.method(globalThis, 'fetch', async () => response)
  assert.equal(await fetchOriginalFile(123), null)
})

test('导出跳到登录页仍然中止，不能标成无原件', async (context) => {
  const response = new Response('<!doctype html><html>login</html>')
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: 'https://www.strava.com/login' },
  })
  context.mock.method(globalThis, 'fetch', async () => response)
  await assert.rejects(fetchOriginalFile(123), StravaSessionExpiredError)
})
