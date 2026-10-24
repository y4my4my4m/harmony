// Journey, Android app: a local author's profile opens from a post. The app names no instance
// at build time; the instance picker keeps the domain /instance-info reports, and a bare handle
// resolves against it. Before 1.9.0 the domain was the unset VITE_DOMAIN: "Profile not found".
//
// Runs on an emulator or device with the debug APK, not in CI: HARMONY_ANDROID=1, an adb device,
// the e2e stack up (npm run e2e:up). The proxy below stands in for nginx: /api/federation/* goes
// to the federation backend without its prefix. adb reverse carries the proxy's port and the
// stack's gateway to the device, whose app reaches both as localhost.
//
//   HARMONY_ANDROID=1 HARMONY_APK=<path to app-universal-debug.apk> npx playwright test --project=android

import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { test, expect, _android as android, type AndroidDevice, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, type SpecUser } from '../specs/harness'
import { startBackend, type Backend } from '../specs/backend'

const PKG = 'online.knowmad.harmony'
const PROXY_PORT = 18990
const GATEWAY_PORT = Number(new URL(process.env.E2E_SUPABASE_URL || 'http://localhost:54480').port)

test.skip(!process.env.HARMONY_ANDROID, 'set HARMONY_ANDROID=1 with an emulator or device attached')

const admin = adminClient()
let backend: Backend
let proxy: http.Server
let device: AndroidDevice
let author: SpecUser
let reader: SpecUser
let postId = ''

const adb = (...args: string[]) => execFileSync('adb', args, { encoding: 'utf8' })

test.beforeAll(async () => {
  test.setTimeout(600_000)
  author = await createUser(admin, 'nap')
  reader = await createUser(admin, 'nar')
  const { data, error } = await admin.from('posts').insert({
    author_id: author.id, is_local: true, visibility: 'public', content: [{ type: 'text', text: 'a post from the app' }],
  }).select('id').single()
  if (error) throw new Error(`post: ${error.message}`)
  postId = data!.id

  backend = await startBackend()
  proxy = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy')
    if (!url.pathname.startsWith('/api/federation/')) {
      res.writeHead(404).end()
      return
    }
    const target = new URL(`${url.pathname.replace(/^\/api\/federation/, '')}${url.search}`, backend.url)
    const upstream = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => res.writeHead(502).end())
    req.pipe(upstream)
  })
  await new Promise<void>((resolve) => proxy.listen(PROXY_PORT, '127.0.0.1', resolve))

  ;[device] = await android.devices()
  if (!device) throw new Error('no adb device')
  adb('reverse', `tcp:${PROXY_PORT}`, `tcp:${PROXY_PORT}`)
  adb('reverse', `tcp:${GATEWAY_PORT}`, `tcp:${GATEWAY_PORT}`)
  if (process.env.HARMONY_APK) await device.installApk(process.env.HARMONY_APK)
  await device.shell(`pm clear ${PKG}`)
  // The app asks for notifications after sign-in; the system dialog would cover the page.
  await device.shell(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`)
})

test.afterAll(async () => {
  await device?.shell(`am force-stop ${PKG}`).catch(() => {})
  await device?.close().catch(() => {})
  await new Promise<void>((resolve) => proxy?.close(() => resolve()) ?? resolve())
  await backend?.stop()
  if (author) await admin.from('posts').delete().eq('author_id', author.id)
  await deleteUser(admin, author)
  await deleteUser(admin, reader)
})

async function appPage(): Promise<Page> {
  await device.shell(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`)
  const webview = await device.webView({ pkg: PKG }, { timeout: 60_000 })
  return webview.page()
}

test('a local author\'s profile opens from a post in the app', async () => {
  test.setTimeout(300_000)
  const page = await appPage()

  await test.step('the instance picker keeps the domain the instance reports', async () => {
    const picker = page.getByTestId('instance-picker')
    await expect(picker).toBeVisible({ timeout: 60_000 })
    await picker.locator('input').fill(`localhost:${PROXY_PORT}`)
    await picker.getByRole('button').last().click()
    await expect(page.locator('[data-testid="auth-email"]')).toBeVisible({ timeout: 60_000 })
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('harmony.instance') || 'null'))
    expect(stored).toMatchObject({ origin: `http://localhost:${PROXY_PORT}`, domain: 'localhost' })
  })

  await test.step('sign in', async () => {
    await page.locator('[data-testid="auth-email"]').fill(reader.email)
    await page.locator('[data-testid="auth-password"]').fill(reader.password)
    await page.locator('[data-testid="auth-submit"]').click()
    await page.waitForURL(/\/chat/, { timeout: 60_000 })
  })

  await test.step('the author\'s name on the post opens their profile', async () => {
    const origin = new URL(page.url()).origin
    await page.goto(`${origin}/social/post/${postId}`)
    const post = page.locator('article[aria-current="true"]')
    await expect(post).toContainText('a post from the app', { timeout: 60_000 })
    await post.locator('.author-info').first().click()
    await page.waitForURL(new RegExp(`/social/profile/${author.username}$`), { timeout: 30_000 })
    await expect(page.getByText('Profile not found')).toHaveCount(0)
    await expect(page.getByText(author.displayName).first()).toBeVisible({ timeout: 30_000 })
  })
})
