// Journey: the session of a tab ends, or becomes another account's, outside that tab's own sign-out.
//
// A refresh GoTrue refuses fires SIGNED_OUT while auth-js holds its lock, which every request waits
// for: the app returns to sign-in and signs in again in the same page, and a second tab of the browser,
// which shares the lock, keeps working. Another account signed in elsewhere in the browser takes the
// tab over where it stands: nothing of the first account is left in it, and no sign-in page comes
// between.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let alice: SpecUser
let bob: SpecUser
let alices: SeededServer
let bobs: SeededServer

test.beforeAll(async () => {
  alice = await createUser(admin, 'seea')
  bob = await createUser(admin, 'seeb')
  alices = await seedServer(admin, alice, `Alpha ${alice.username}`)
  bobs = await seedServer(admin, bob, `Beta ${bob.username}`)
})

test.afterAll(async () => {
  for (const server of [alices, bobs]) if (server) await admin.from('servers').delete().eq('id', server.id)
  for (const user of [alice, bob]) await deleteUser(admin, user)
})

/** auth-js's storage key, which names its BroadcastChannel too. */
const authKey = (page: Page) => page.evaluate(() => Object.keys(localStorage).find((key) => /^sb-.*-auth-token$/.test(key))!)
const markPage = (page: Page) => page.evaluate(() => { (window as unknown as { __samePage?: boolean }).__samePage = true })
const samePage = (page: Page) => page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage === true)
const accountPanel = (page: Page) => page.getByRole('region', { name: 'Your account' })
const serverIcon = (page: Page, server: SeededServer) => page.locator(`[data-rail-kind="server"][data-rail-id="${server.id}"]`)

async function signInHere(page: Page, user: SpecUser): Promise<void> {
  await page.locator('[data-testid="auth-email"]').fill(user.email)
  await page.locator('[data-testid="auth-password"]').fill(user.password)
  await page.locator('[data-testid="auth-submit"]').click()
  await page.waitForURL(/\/chat/, { timeout: 30_000 })
  await dismissAnnouncements(page)
}

test('a refresh the server refuses returns to sign-in, and neither tab hangs', async ({ context, page }) => {
  test.setTimeout(150_000)
  await signIn(page, alice)
  await openChannel(page, alices.id, alices.generalChannelId)
  const second = await context.newPage()
  await openChannel(second, alices.id, alices.generalChannelId)
  for (const tab of [page, second]) await markPage(tab)

  await test.step('the stored token has expired and its refresh is refused, as the tab is shown', async () => {
    await context.route('**/auth/v1/token?grant_type=refresh_token', (route) => route.fulfill({
      status: 400, json: { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' },
    }))
    const key = await authKey(page)
    await page.evaluate((key) => {
      const stored = JSON.parse(localStorage.getItem(key)!)
      localStorage.setItem(key, JSON.stringify({ ...stored, expires_at: Math.floor(Date.now() / 1000) - 60 }))
      window.dispatchEvent(new Event('visibilitychange'))
    }, key)
    for (const tab of [page, second]) {
      await expect(tab).toHaveURL(/\/login/, { timeout: 20_000 })
      await expect(tab.locator('[data-testid="auth-email"]')).toBeVisible()
      expect(await samePage(tab)).toBe(true)
    }
    await context.unroute('**/auth/v1/token?grant_type=refresh_token')
  })

  await test.step('both tabs sign in again without a reload, and load what they show', async () => {
    await signInHere(page, alice)
    await expect(serverIcon(page, alices)).toBeVisible({ timeout: 30_000 })
    await expect(accountPanel(page)).toContainText(alice.displayName, { timeout: 30_000 })
    expect(await samePage(page)).toBe(true)
    // The second tab hears of it, and follows.
    await expect(second).toHaveURL(/\/chat/, { timeout: 30_000 })
    await expect(serverIcon(second, alices)).toBeVisible({ timeout: 30_000 })
    expect(await samePage(second)).toBe(true)
  })
  await second.close()
})

test('another account signed in elsewhere in the browser takes the tab, with nothing of the first left in it', async ({ context, page }) => {
  test.setTimeout(150_000)
  await signIn(page, alice)
  await openChannel(page, alices.id, alices.generalChannelId)
  await expect(serverIcon(page, alices)).toBeVisible({ timeout: 30_000 })
  await expect(accountPanel(page)).toContainText(alice.displayName, { timeout: 30_000 })
  await markPage(page)
  const urls: string[] = []
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) urls.push(frame.url()) })

  // What auth-js of the other tab does on a sign-in: the session is stored and announced.
  const { data } = await (await userClient(bob)).auth.getSession()
  const key = await authKey(page)
  const other = await context.newPage()
  await other.goto('/robots.txt')
  await other.evaluate(({ key, session }) => {
    localStorage.setItem(key, JSON.stringify(session))
    new BroadcastChannel(key).postMessage({ event: 'SIGNED_IN', session })
  }, { key, session: data.session })

  await expect(accountPanel(page)).toContainText(bob.displayName, { timeout: 30_000 })
  await expect(serverIcon(page, bobs)).toBeVisible({ timeout: 30_000 })
  await expect(serverIcon(page, alices)).toHaveCount(0)
  await expect(page.getByText(alice.displayName)).toHaveCount(0)
  expect(await samePage(page)).toBe(true)
  expect(urls.filter((url) => /\/login/.test(url))).toEqual([])

  // The account in this tab is Bob's throughout: his server opens, and what he posts is his.
  await serverIcon(page, bobs).click()
  await expect(messageList(page)).toBeVisible({ timeout: 30_000 })
  await sendMessage(page, 'hello from the other account')
  const { data: rows, error } = await admin.from('messages').select('user_id, content').eq('channel_id', bobs.generalChannelId).eq('is_system', false)
  if (error) throw new Error(error.message)
  expect(rows.filter((row) => JSON.stringify(row.content).includes('hello from the other account')).map((row) => row.user_id)).toEqual([bob.id])
  await other.close()
})
