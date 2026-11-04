// Journey: a voice message uploads without the transfers box.
//
// The voice message's row in the chat shows its own sending progress; the floating transfers
// box (TransfersIndicator) lists other uploads, never a recording, on this page or any other.
// A file attachment still shows in the box once the user leaves the page that started it.
//
// The microphone is an oscillator behind a replaced getUserMedia. Uploads into message_media are
// held at the network until the step has looked, so each one is in flight for longer than the
// box's show delay (TRANSFER_SHOW_DELAY_MS, 600 ms).

import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

test.use({ serviceWorkers: 'block' })

const MEDIA_POST = '**/storage/v1/object/message_media/**'
const TUS = '**/storage/v1/upload/resumable**'

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'vmxfer')
  server = await seedServer(admin, user, `Voice uploads ${user.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

/** Holds every message_media upload until the returned release is called. */
async function holdUploads(page: Page): Promise<{ held: () => number; release: () => Promise<void> }> {
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => { open = resolve })
  let count = 0
  const handler = async (route: Route) => {
    if (route.request().method() === 'GET' || route.request().method() === 'HEAD') return route.fallback()
    count += 1
    await gate
    await route.fallback()
  }
  await page.route(MEDIA_POST, handler)
  await page.route(TUS, handler)
  return {
    held: () => count,
    release: async () => {
      open()
      await page.unroute(MEDIA_POST, handler)
      await page.unroute(TUS, handler)
    },
  }
}

async function fakeMicrophone(page: Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const dest = ctx.createMediaStreamDestination()
      osc.connect(dest)
      osc.start()
      return dest.stream
    }
  })
}

async function recordAndSend(page: Page, scope: Page | Locator = page) {
  await scope.getByRole('button', { name: 'Record voice message' }).click()
  const send = scope.locator('.voice-recorder .send-btn')
  await expect(send).toBeVisible()
  await page.waitForTimeout(1200)
  await send.click()
}

const box = (page: Page) => page.getByTestId('transfers-indicator')

/** In-app navigation to Drive: the page, its uploads and its outbox live on. */
async function leaveForDrive(page: Page) {
  await page.evaluate(() => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $router: { push(path: string): Promise<unknown> } } } }
    }
    return root.__vue_app__.config.globalProperties.$router.push('/drive')
  })
  await expect(page).toHaveURL(/\/drive/)
}

async function voiceMessages(): Promise<number> {
  const { data: rows } = await admin
    .from('messages')
    .select('id')
    .eq('channel_id', server.generalChannelId)
    .not('metadata->voice_message', 'is', null)
  return rows?.length ?? 0
}

test('a voice message never shows the transfers box; a file attachment still does', async ({ page }) => {
  test.setTimeout(150_000)
  await fakeMicrophone(page)
  await signIn(page, user)
  // Drive's modules load once here, not while an upload is held.
  await page.goto('/drive')
  await expect(page.getByTestId('drive-file-input')).toBeAttached({ timeout: 30000 })
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('on the chat page: the row shows its progress, the box stays away', async () => {
    const hold = await holdUploads(page)
    await recordAndSend(page)
    await expect.poll(hold.held, { timeout: 15000 }).toBeGreaterThan(0)
    const pending = messageList(page).locator('.message-item').filter({ has: page.getByRole('group', { name: 'Voice message' }) }).last()
    await expect(pending).toBeVisible()
    await expect(pending.getByRole('progressbar')).toBeVisible()
    // Twice the show delay.
    await page.waitForTimeout(1200)
    await expect(box(page)).toHaveCount(0)
    await hold.release()
    await expect(pending).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    await expect(box(page)).toHaveCount(0)
  })

  await test.step('away from the chat while it uploads: still no box', async () => {
    const hold = await holdUploads(page)
    await recordAndSend(page)
    await expect.poll(hold.held, { timeout: 15000 }).toBeGreaterThan(0)
    await leaveForDrive(page)
    await page.waitForTimeout(1200)
    await expect(box(page)).toHaveCount(0)
    await hold.release()
    // Sent from the outbox while the chat is not shown.
    await expect.poll(voiceMessages, { timeout: 30000 }).toBe(2)
    await expect(box(page)).toHaveCount(0)
    await openChannel(page, server.id, server.generalChannelId)
  })

  await test.step('a thread reply recorded, then the page left: no box', async () => {
    await page.locator('.chat-header .threads-btn').click()
    const modal = page.locator('.threads-modal')
    await expect(modal).toBeVisible({ timeout: 15000 })
    await modal.locator('.new-thread-btn').click()
    await modal.locator('#new-thread-name').fill('Voice notes')
    await modal.locator('.new-thread-submit').click()
    const panel = page.locator('.thread-panel')
    await expect(panel).toBeVisible({ timeout: 15000 })
    const hold = await holdUploads(page)
    await recordAndSend(page, panel)
    await expect.poll(hold.held, { timeout: 15000 }).toBeGreaterThan(0)
    await leaveForDrive(page)
    await page.waitForTimeout(1200)
    await expect(box(page)).toHaveCount(0)
    await hold.release()
    await openChannel(page, server.id, server.generalChannelId)
  })

  await test.step('a file attachment left behind is listed in the box', async () => {
    const hold = await holdUploads(page)
    await page.getByTestId('composer-file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(`notes ${Date.now()}\n`) })
    await expect.poll(hold.held, { timeout: 15000 }).toBeGreaterThan(0)
    await leaveForDrive(page)
    await expect(box(page).getByTestId('transfer-item').filter({ hasText: 'notes.txt' })).toBeVisible({ timeout: 10000 })
    await hold.release()
  })

})
