// Journey: Settings > Notifications > Test push shows a system notification while the page that
// sent it is focused. The service worker leaves every other push to a focused window, which
// shows the realtime event itself; a test push has no realtime event.
//
// The browser's push service is replaced: PushManager hands out a fixed subscription and the
// federation push routes are answered here. POST /push/test delivers the payload the backend
// sends (testPushPayload) to the app's real service worker through the DevTools protocol, as a
// push service would. The headless shell has no notification permission; the bundled build
// runs as the full browser in headless mode.

import { test, expect, type CDPSession, type Page, type Route } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'
import { testPushPayload } from '../../federation-backend/src/services/pushPolicy'

test.use({
  permissions: ['notifications'],
  ...(process.env.PW_BUNDLED ? { channel: 'chromium' } : {}),
})

const admin = adminClient()
let user: SpecUser

const ENDPOINT = `https://push.e2e.test/sub/${randomBytes(8).toString('hex')}`
const VAPID_KEY = Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url')

test.beforeAll(async () => {
  user = await createUser(admin, 'pushtest')
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

/** One browser subscription, created on subscribe(). */
async function fakePushManager(page: Page) {
  await page.addInitScript(({ endpoint }) => {
    let subscribed = false
    const sub = {
      endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true, applicationServerKey: null },
      getKey: () => new ArrayBuffer(0),
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'BPe2e', auth: 'e2e-auth' } }),
      unsubscribe: async () => { subscribed = false; return true },
    }
    PushManager.prototype.getSubscription = async function () { return subscribed ? (sub as unknown as PushSubscription) : null }
    PushManager.prototype.subscribe = async function () { subscribed = true; return sub as unknown as PushSubscription }
  }, { endpoint: ENDPOINT })
}

interface PushService {
  tests: number
  deliver(payload: unknown): Promise<void>
}

/** Answers /api/federation/push/*; a test delivers to the service worker. */
async function fakePushRoutes(page: Page, cdp: CDPSession, origin: string, registrationId: () => string): Promise<PushService> {
  let registered = false
  const service: PushService = {
    tests: 0,
    async deliver(payload) {
      await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: registrationId(), data: JSON.stringify(payload) })
    },
  }
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

  await page.context().route('**/api/federation/push/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^.*\/api\/federation\/push/, '')
    if (path === '/vapid-key') return json(route, { publicKey: VAPID_KEY })
    if (path === '/status') return json(route, { available: true, configured: true, fcm: false, fcmProject: null, relay: false, unifiedpush: true })
    if (path === '/subscriptions') {
      return json(route, {
        subscriptions: registered
          ? [{ id: 'sub-1', endpoint: ENDPOINT, transport: 'webpush', user_agent: 'e2e', created_at: new Date().toISOString(), failure_count: 0 }]
          : [],
      })
    }
    if (path === '/subscribe' && request.method() === 'POST') {
      expect(request.postDataJSON().subscription.endpoint).toBe(ENDPOINT)
      registered = true
      return json(route, { success: true, message: 'Subscription saved' })
    }
    if (path === '/test' && request.method() === 'POST') {
      expect(request.postDataJSON()).toEqual({ endpoint: ENDPOINT })
      service.tests++
      await service.deliver(testPushPayload())
      return json(route, { success: true, sent: 1, failed: 0, message: 'Test notification sent to this device' })
    }
    return json(route, { error: 'not found' }, 404)
  })
  return service
}

/** Titles of the notifications this origin shows. */
const shownTitles = (page: Page) => page.evaluate(async () =>
  (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => n.title))

test('Test push shows a notification while Settings is open and focused', async ({ page, context, baseURL }) => {
  test.setTimeout(120_000)
  const origin = new URL(baseURL!).origin

  const cdp = await context.newCDPSession(page)
  let registrationId = ''
  cdp.on('ServiceWorker.workerRegistrationUpdated', (event) => {
    const ours = event.registrations.find((r) => r.scopeURL === `${origin}/` && !r.isDeleted)
    if (ours) registrationId = ours.registrationId
  })
  await cdp.send('ServiceWorker.enable')

  await fakePushManager(page)
  const push = await fakePushRoutes(page, cdp, origin, () => registrationId)

  await signIn(page, user)
  await page.goto('/settings/notifications')
  await dismissAnnouncements(page)
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await expect.poll(() => registrationId, { timeout: 15000 }).not.toBe('')

  await test.step('push is turned on for this browser', async () => {
    await page.getByRole('button', { name: 'Turn on for this device' }).click()
    await expect(page.getByRole('button', { name: 'Turn off for this device' })).toBeVisible({ timeout: 15000 })
  })

  await test.step('"Only when I\'m away" is on for a new account and says what it does', async () => {
    await expect(page.getByRole('switch', { name: 'Only when I’m away' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText('While you use Harmony on one of your devices, your other devices get no push.')).toBeVisible()
  })

  await test.step('a test push from the focused page is shown', async () => {
    expect(await page.evaluate(() => document.hasFocus())).toBe(true)
    await page.getByRole('button', { name: 'Test push' }).click()
    await expect(page.locator('.Vue-Toastification__toast').filter({ hasText: 'Test push notification sent' })).toBeVisible({ timeout: 15000 })
    expect(push.tests).toBe(1)
    await expect.poll(() => shownTitles(page), { timeout: 10000 }).toContain('Test notification')
  })

  await test.step('any other push is still left to the focused page', async () => {
    await push.deliver({
      title: 'Alice sent you a message',
      body: 'hi',
      type: 'dm',
      tag: 'harmony-dm-conv-e2e',
      data: { notification_id: '00000000-0000-4000-8000-0000000000e2', type: 'dm', url: '/dm/e2e', conversation_id: 'e2e' },
    })
    await page.waitForTimeout(1500)
    expect(await shownTitles(page)).not.toContain('Alice sent you a message')
  })
})
