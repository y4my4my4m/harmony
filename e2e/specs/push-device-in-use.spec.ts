// Journey: under "Only when I'm away" (on by default), push waits while any of the user's
// devices is in use (has_active_session, read by the federation backend before every push).
// A computer that runs Harmony in the background and shows its own system notifications stays
// in use without viewing anything; a phone in the background does not, and neither does a
// closed page.
//
// Hiding is emulated in the page: visibilityState reads 'hidden' and visibilitychange fires,
// as when a window is minimized or the app goes to the background. What the app then reports
// is read back from device_view_contexts. The headless shell has no notification permission;
// the bundled build runs as the full browser in headless mode.

import { test, expect, devices, type Browser, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

test.use(process.env.PW_BUNDLED ? { channel: 'chromium' } : {})

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'pushinuse')
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

async function rows(): Promise<string[]> {
  const { data, error } = await admin
    .from('device_view_contexts')
    .select('view_type')
    .eq('user_id', user.id)
    .gt('last_active_at', new Date(Date.now() - 150_000).toISOString())
  if (error) throw new Error(`device_view_contexts: ${error.message}`)
  return (data ?? []).map((r: { view_type: string }) => r.view_type).sort()
}

async function inUse(): Promise<boolean> {
  const { data, error } = await admin.rpc('has_active_session', { p_user_id: user.id })
  if (error) throw new Error(`has_active_session: ${error.message}`)
  return data === true
}

const reported = (page: Page, viewType: string) => page.waitForRequest(
  (r) => r.url().includes('/rpc/sync_view_context_from_presence')
    && (r.postDataJSON() as { p_view_type?: string } | null)?.p_view_type === viewType,
  { timeout: 15000 },
)

async function hide(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

async function device(browser: Browser, options: Parameters<Browser['newContext']>[0]): Promise<Page> {
  const context = await browser.newContext({ ...options, permissions: ['notifications'] })
  const page = await context.newPage()
  await signIn(page, user)
  return page
}

test('a computer in the background holds push; a phone in the background and a closed page do not', async ({ browser }) => {
  test.setTimeout(150_000)
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']

  const phone = await device(browser, { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })
  await test.step('a phone in the background is away at once', async () => {
    await expect.poll(rows, { timeout: 15000 }).toEqual(['home'])
    const away = reported(phone, 'away')
    await hide(phone)
    await away
    await expect.poll(rows, { timeout: 15000 }).toEqual(['away'])
    expect(await inUse()).toBe(false)
  })

  const desktop = await device(browser, { ...devices['Desktop Chrome'] })
  await test.step('a computer shown on screen is in use', async () => {
    expect(await desktop.evaluate(() => Notification.permission)).toBe('granted')
    await expect.poll(rows, { timeout: 15000 }).toEqual(['away', 'home'])
    expect(await inUse()).toBe(true)
  })

  await test.step('in the background it stays in use, viewing nothing', async () => {
    const background = reported(desktop, 'background')
    await hide(desktop)
    await background
    await expect.poll(rows, { timeout: 15000 }).toEqual(['away', 'background'])
    expect(await inUse()).toBe(true)
  })

  await test.step('closed, it is away', async () => {
    const away = reported(desktop, 'away')
    await desktop.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
    await away
    await expect.poll(rows, { timeout: 15000 }).toEqual(['away', 'away'])
    expect(await inUse()).toBe(false)
  })

  await phone.context().close()
  await desktop.context().close()
})
