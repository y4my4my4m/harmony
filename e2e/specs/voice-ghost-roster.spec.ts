// Journey: nobody stays listed in a voice channel after leaving it, and an old call is not
// resumed.
//
// A viewer's roster of a server's voice channels is read from voice_channel_participants when
// the server is opened, when its Realtime topic (re)joins, when the tab is shown again and when
// the network returns. Before 1.9.4 it came from Realtime broadcasts alone: a viewer that was on
// another server or offline when a member left, or a member whose closing page never sent its
// user-left, kept the member listed until reload. The stack has no realtime, so every roster
// shown here was read from the database.
//
// A saved call is resumed on app start only when it was last seen connected within 3 hours;
// before, any call joined in the last 24 hours was.
//
// LiveKit posts its webhooks to the backend: a member whose own row delete never lands (a
// device switched off) is removed when LiveKit reports the participant gone.

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { startBackend, type Backend } from './backend'
import { startLiveKit, writeSpeechWav, type LiveKit } from './livekit'

const speech = writeSpeechWav()

test.describe.configure({ mode: 'serial' })
test.use({
  serviceWorkers: 'block',
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${speech}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
})

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000

const admin = adminClient()
let liveKit: LiveKit
let backend: Backend
let alice: SpecUser
let bob: SpecUser
let server: SeededServer
let elsewhere: SeededServer
let lounge: string

test.beforeAll(async () => {
  test.setTimeout(180_000)
  // The backend takes LiveKit's keys; LiveKit takes the backend's webhook URL.
  const first = await startLiveKit()
  backend = await startBackend(first.env)
  first.stop()
  liveKit = await startLiveKit({ webhookUrl: `${backend.url}/api/livekit/webhook` })

  alice = await createUser(admin, 'vgra')
  bob = await createUser(admin, 'vgrb')
  server = await seedServer(admin, alice, `Voice Ghosts ${alice.username}`)
  elsewhere = await seedServer(admin, bob, `Elsewhere ${bob.username}`)
  await addMember(admin, bob, server.id)

  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const { data, error } = await admin
    .from('channels')
    .insert({ server_id: server.id, name: 'lounge', type: 1, category: general?.category ?? null })
    .select('id')
    .single()
  if (error || !data) throw new Error(`voice channel: ${error?.message}`)
  lounge = data.id
})

test.afterAll(async () => {
  if (server) await admin.from('servers').delete().eq('id', server.id)
  if (elsewhere) await admin.from('servers').delete().eq('id', elsewhere.id)
  await deleteUser(admin, alice)
  await deleteUser(admin, bob)
  await backend?.stop()
  liveKit?.stop()
})

async function openIn(context: BrowserContext, user: SpecUser, signedIn = false): Promise<Page> {
  const page = await context.newPage()
  await backend.route(page)
  if (!signedIn) await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  return page
}

async function openAs(browser: Browser, user: SpecUser): Promise<Page> {
  return openIn(await browser.newContext(), user)
}

/** Clicks the voice channel until the dock appears: a click during the sidebar's first render can be lost. */
async function joinLounge(page: Page): Promise<void> {
  const dock = page.locator('[data-testid="dock-mute"]')
  await expect(async () => {
    if (!(await dock.isVisible())) await page.locator(`[data-nav-kind="channel"][data-nav-id="${lounge}"]`).click()
    await expect(dock).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 45_000 })
}

async function seatsOf(user: SpecUser): Promise<string[]> {
  const { data, error } = await admin.from('voice_channel_participants').select('channel_id').eq('user_id', user.id)
  if (error) throw new Error(`seats: ${error.message}`)
  return (data ?? []).map((r) => r.channel_id as string)
}

const listed = (page: Page, user: SpecUser) =>
  page.locator(`.channel-wrapper[data-channel-id="${lounge}"]`).getByTestId(`voice-roster-${user.id}`)

const railEntry = (page: Page, serverId: string) =>
  page.getByRole('navigation', { name: 'Servers' }).locator(`[data-rail-kind="server"][data-rail-id="${serverId}"]`)

async function seated(user: SpecUser): Promise<void> {
  await expect.poll(() => seatsOf(user), { timeout: 30_000 }).toEqual([lounge])
}

async function unseated(user: SpecUser): Promise<void> {
  await expect.poll(() => seatsOf(user), { timeout: 30_000 }).toEqual([])
}

test('a member whose page closed while the viewer was on another server is gone when the viewer comes back', async ({ browser }) => {
  test.setTimeout(150_000)
  const a = await openAs(browser, alice)
  await joinLounge(a)
  await seated(alice)

  const b = await openAs(browser, bob)
  await expect(listed(b, alice)).toBeVisible({ timeout: 15_000 })

  await railEntry(b, elsewhere.id).click()
  await b.waitForURL(new RegExp(elsewhere.id), { timeout: 20_000 })

  await a.close()
  await unseated(alice)

  await railEntry(b, server.id).click()
  await b.waitForURL(new RegExp(server.id), { timeout: 20_000 })
  await expect(b.locator(`.channel-wrapper[data-channel-id="${lounge}"]`)).toBeVisible({ timeout: 15_000 })
  await expect(listed(b, alice)).toHaveCount(0, { timeout: 10_000 })

  await a.context().close()
  await b.context().close()
})

test('a member who left while the viewer was offline is gone when the network returns', async ({ browser }) => {
  test.setTimeout(150_000)
  const a = await openAs(browser, alice)
  await joinLounge(a)
  await seated(alice)

  const b = await openAs(browser, bob)
  await expect(listed(b, alice)).toBeVisible({ timeout: 15_000 })

  await b.context().setOffline(true)
  await a.locator('[data-testid="dock-leave"]').click()
  await unseated(alice)
  await b.waitForTimeout(1_000)
  await expect(listed(b, alice)).toBeVisible()

  await b.context().setOffline(false)
  await expect(listed(b, alice)).toHaveCount(0, { timeout: 15_000 })

  await a.context().close()
  await b.context().close()
})

test('a member whose row delete never lands is removed when LiveKit reports them gone', async ({ browser }) => {
  test.setTimeout(150_000)
  const a = await openAs(browser, alice)
  // The page's own DELETE never reaches the database, as from a device switched off.
  await a.route('**/rest/v1/voice_channel_participants**', (route) =>
    route.request().method() === 'DELETE' ? route.abort() : route.fallback())
  await joinLounge(a)
  await seated(alice)

  const b = await openAs(browser, bob)
  await expect(listed(b, alice)).toBeVisible({ timeout: 15_000 })

  await a.context().close()
  await unseated(alice)

  await b.context().setOffline(true)
  await b.context().setOffline(false)
  await expect(listed(b, alice)).toHaveCount(0, { timeout: 15_000 })

  await b.context().close()
})

test('a call last seen connected over 3 hours ago is not resumed on app start; one within 3 hours is', async ({ browser }) => {
  test.setTimeout(150_000)
  const context = await browser.newContext()
  const dock = (page: Page) => page.locator('[data-testid="dock-mute"]')

  const SAVED = /voiceChannelState$|active-voice-session$/
  const savedCalls = (page: Page) => page.evaluate((pattern) =>
    Object.fromEntries(Object.keys(localStorage).filter((k) => new RegExp(pattern).test(k)).map((k) => [k, localStorage.getItem(k)!])),
  SAVED.source)
  // The saved call as the connected page wrote it, both stamps (voiceChannelState's join time,
  // active-voice-session's heartbeat) moved back. A closing page may clear it before it dies.
  const restoreSavedCall = (page: Page, saved: Record<string, string>, ago: number) =>
    page.addInitScript(({ saved, agoMs }) => {
      for (const [key, raw] of Object.entries(saved)) {
        localStorage.setItem(key, JSON.stringify({ ...JSON.parse(raw), timestamp: Date.now() - agoMs }))
      }
    }, { saved, agoMs: ago })

  const first = await openIn(context, alice)
  await joinLounge(first)
  await seated(alice)
  // Written once the call connects.
  await expect.poll(async () => Object.keys(await savedCalls(first)).length, { timeout: 30_000 }).toBe(2)
  const saved = await savedCalls(first)
  await first.close()
  await unseated(alice)

  await test.step('2 h 59 min: rejoined', async () => {
    const page = await context.newPage()
    await backend.route(page)
    await restoreSavedCall(page, saved, 3 * HOUR - MINUTE)
    await openChannel(page, server.id, server.generalChannelId)
    await expect(dock(page)).toBeVisible({ timeout: 30_000 })
    await seated(alice)
    await page.close()
    await unseated(alice)
  })

  await test.step('3 h 01 min: not rejoined, and the saved call is forgotten', async () => {
    const page = await context.newPage()
    await backend.route(page)
    await restoreSavedCall(page, saved, 3 * HOUR + MINUTE)
    await openChannel(page, server.id, server.generalChannelId)
    await expect.poll(async () => Object.keys(await savedCalls(page)), { timeout: 15_000 }).toEqual([])
    await page.waitForTimeout(3_000)
    await expect(dock(page)).toHaveCount(0)
    expect(await seatsOf(alice)).toEqual([])
  })

  await context.close()
})
