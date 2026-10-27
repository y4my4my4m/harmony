// Journey: under "Only when I'm away" (on by default), push waits while any of the user's
// devices is in use (has_active_session, read by the federation backend before every push).
// A computer that runs Harmony in the background and shows its own system notifications stays
// in use without viewing anything; a phone in the background does not, nor a computer with
// Harmony's desktop notifications turned off, nor a closed page. Signing out leaves the device
// away: pointer movement while sign-out completes does not report it in use again.
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
let quiet: SpecUser
let leaver: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'pushinuse')
  quiet = await createUser(admin, 'pushquiet')
  leaver = await createUser(admin, 'pushleave')
  const { error } = await admin
    .from('notification_preferences')
    .update({ desktop_notifications: false })
    .eq('user_id', quiet.id)
  if (error) throw new Error(`preferences: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
  await deleteUser(admin, quiet)
  await deleteUser(admin, leaver)
})

async function rows(who: SpecUser = user): Promise<string[]> {
  const { data, error } = await admin
    .from('device_view_contexts')
    .select('view_type')
    .eq('user_id', who.id)
    .gt('last_active_at', new Date(Date.now() - 150_000).toISOString())
  if (error) throw new Error(`device_view_contexts: ${error.message}`)
  return (data ?? []).map((r: { view_type: string }) => r.view_type).sort()
}

async function inUse(who: SpecUser = user): Promise<boolean> {
  const { data, error } = await admin.rpc('has_active_session', { p_user_id: who.id })
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

async function device(browser: Browser, options: Parameters<Browser['newContext']>[0], who: SpecUser = user): Promise<Page> {
  const context = await browser.newContext({ ...options, permissions: ['notifications'] })
  const page = await context.newPage()
  await signIn(page, who)
  return page
}

type AppRoot = { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, any> } } } } }

const desktopNotifications = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('#app') as unknown as AppRoot
  return root.__vue_app__.config.globalProperties.$pinia._s.get('notification')?.preferences?.desktop_notifications
})

const signOut = (page: Page) => page.evaluate(() => {
  const root = document.querySelector('#app') as unknown as AppRoot
  void root.__vue_app__.config.globalProperties.$pinia._s.get('auth').logout()
})

/** p_view_type of every view report the page sends from now on. */
function reports(page: Page): string[] {
  const seen: string[] = []
  page.on('request', (r) => {
    if (!r.url().includes('/rpc/sync_view_context_from_presence')) return
    const type = (r.postDataJSON() as { p_view_type?: string } | null)?.p_view_type
    if (type) seen.push(type)
  })
  return seen
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
    // Until the preferences load, no desktop notification would show.
    await expect.poll(() => desktopNotifications(desktop), { timeout: 15000 }).toBe(true)
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

test('a computer with desktop notifications off is away in the background', async ({ browser }) => {
  test.setTimeout(120_000)
  const desktop = await device(browser, { ...devices['Desktop Chrome'] }, quiet)
  expect(await desktop.evaluate(() => Notification.permission)).toBe('granted')
  await expect.poll(() => rows(quiet), { timeout: 15000 }).toEqual(['home'])
  await expect.poll(() => desktopNotifications(desktop), { timeout: 15000 }).toBe(false)

  const seen = reports(desktop)
  const away = reported(desktop, 'away')
  await hide(desktop)
  await away
  await desktop.waitForTimeout(1500)
  expect(seen).toEqual(['away'])
  await expect.poll(() => rows(quiet), { timeout: 15000 }).toEqual(['away'])
  expect(await inUse(quiet)).toBe(false)
  await desktop.context().close()
})

test('signing out stays away while the pointer moves', async ({ browser }) => {
  test.setTimeout(120_000)
  const desktop = await device(browser, { ...devices['Desktop Chrome'] }, leaver)
  await expect.poll(() => rows(leaver), { timeout: 15000 }).toEqual(['home'])

  // The 'away' write lands; its answer is held, and sign-out with it, so the session stays
  // valid while the pointer moves. Sign-out waits at most 2 s on it.
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await desktop.route('**/rpc/sync_view_context_from_presence', async (route) => {
    if ((route.request().postDataJSON() as { p_view_type?: string } | null)?.p_view_type !== 'away') {
      await route.fallback()
      return
    }
    const response = await route.fetch()
    await held
    await route.fulfill({ response })
  })

  const seen = reports(desktop)
  const away = reported(desktop, 'away')
  await signOut(desktop)
  await away
  await expect.poll(() => rows(leaver), { timeout: 5000 }).toEqual(['away'])
  for (let i = 0; i < 6; i++) await desktop.mouse.move(100 + i * 40, 200 + i * 20)
  await desktop.keyboard.press('Shift')
  await desktop.waitForTimeout(500)
  release()

  await expect(desktop).toHaveURL(/\/login/, { timeout: 15000 })
  expect(seen).toEqual(['away'])
  await expect.poll(() => rows(leaver), { timeout: 15000 }).toEqual(['away'])
  expect(await inUse(leaver)).toBe(false)
  await desktop.context().close()
})
