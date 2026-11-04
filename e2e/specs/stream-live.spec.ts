// Journey: going live and stopping over LiveKit.
//
// The sharer goes live from the dock's Go live panel; the dock's share button then shows the
// live state in the call view's red. The sharer's own stream tile carries Stop streaming, which
// ends the share for everyone. getDisplayMedia returns a canvas: headless Chrome has no screen
// picker.

import { test, expect, type Browser, type Page } from '@playwright/test'
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

const admin = adminClient()
let liveKit: LiveKit
let backend: Backend
let alice: SpecUser
let bob: SpecUser
let server: SeededServer
let lounge: string

test.beforeAll(async () => {
  test.setTimeout(120_000)
  liveKit = await startLiveKit()
  backend = await startBackend(liveKit.env)
  alice = await createUser(admin, 'sla')
  bob = await createUser(admin, 'slb')
  server = await seedServer(admin, alice, `Stream live ${alice.username}`)
  await addMember(admin, bob, server.id)
  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const { data, error } = await admin
    .from('channels')
    .insert({ server_id: server.id, name: 'lounge', type: 1, category: general?.category ?? null })
    .select('id')
    .single()
  if (error || !data) throw new Error(`lounge: ${error?.message}`)
  lounge = data.id
})

test.afterAll(async () => {
  if (server) await admin.from('servers').delete().eq('id', server.id)
  await deleteUser(admin, alice)
  await deleteUser(admin, bob)
  await backend?.stop()
  liveKit?.stop()
})

async function openAs(browser: Browser, user: SpecUser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 1280
      canvas.height = 720
      const ctx = canvas.getContext('2d')!
      let frame = 0
      setInterval(() => {
        ctx.fillStyle = `hsl(${(frame++ * 3) % 360} 60% 40%)`
        ctx.fillRect(0, 0, 1280, 720)
      }, 33)
      return canvas.captureStream(30)
    }
  })
  await backend.route(page)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  return page
}

/** Joins the lounge and waits for the connection to complete. */
async function joinLounge(page: Page): Promise<void> {
  const mute = page.getByTestId('dock-mute')
  await expect(async () => {
    if (!(await mute.isVisible())) await page.locator(`[data-nav-kind="channel"][data-nav-id="${lounge}"]`).click()
    await expect(mute).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 45_000 })
  await expect.poll(() => page.evaluate(() => {
    const voice = (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    return voice.isConnected && !voice.isConnecting
  }), { timeout: 30_000 }).toBe(true)
}

test("the sharer stops from the stream's own tile", async ({ browser }) => {
  test.setTimeout(180_000)
  const a = await openAs(browser, alice)
  const b = await openAs(browser, bob)
  await joinLounge(a)
  await joinLounge(b)

  const share = a.getByTestId('dock-share')
  await test.step('Go live from the dock; the share button shows the live state', async () => {
    const idle = await share.evaluate((el) => getComputedStyle(el).backgroundColor)
    await share.click()
    await a.getByRole('dialog', { name: 'Share your screen' }).getByRole('button', { name: 'Go live' }).click()
    await expect(share).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
    const errorFill = await share.evaluate((el) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--error-fill)'
      el.appendChild(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
    expect(errorFill).not.toBe(idle)
    // The button eases between states.
    await expect.poll(() => share.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(errorFill)
  })

  const ownTile = a.locator(`.voice-tile.is-screen[data-user-id="${alice.id}"]`)
  await test.step("Stop streaming on the sharer's own tile ends the share for everyone", async () => {
    await expect(b.locator(`[data-testid="voice-participant-${alice.id}"]`)).toHaveAttribute('aria-label', /Streaming/, { timeout: 30_000 })
    await a.getByRole('button', { name: 'Open call view' }).click()
    await expect(ownTile).toBeVisible({ timeout: 15_000 })
    await ownTile.hover()
    const stop = ownTile.getByRole('button', { name: 'Stop streaming' })
    await expect(stop).toBeVisible()
    await stop.click()
    await expect(ownTile).toHaveCount(0, { timeout: 15_000 })
    await a.getByRole('dialog', { name: 'lounge' }).getByRole('button', { name: 'Minimize call view' }).click()
    await expect(share).toHaveAttribute('aria-pressed', 'false')
    await expect(b.locator(`[data-testid="voice-participant-${alice.id}"]`)).not.toHaveAttribute('aria-label', /Streaming/, { timeout: 30_000 })
  })

  await test.step("a viewer's tile of someone else's stream has no Stop streaming", async () => {
    await share.click()
    await a.getByRole('dialog', { name: 'Share your screen' }).getByRole('button', { name: 'Go live' }).click()
    await expect(share).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 })
    const view = b.getByRole('dialog', { name: 'lounge' })
    if (!(await view.isVisible())) await b.getByRole('button', { name: 'Open call view' }).click()
    const remote = b.locator(`.voice-tile.is-screen[data-user-id="${alice.id}"]`).first()
    await expect(remote).toBeVisible({ timeout: 30_000 })
    await remote.hover()
    await expect(remote.getByRole('button', { name: 'Stop streaming' })).toHaveCount(0)
  })

  await a.context().close()
  await b.context().close()
})
