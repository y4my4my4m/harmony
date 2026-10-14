// Journey: watch together. In a voice call, the host starts a video from their Drive through
// the call dock; a second member in the call gets the same video at the host's position,
// follows play and pause, and loses it when the host stops. The voice channel row shows what
// is playing.
//
// The stack has no LiveKit and no realtime: the voice store is set as a joined call leaves it
// (soundboard-instant-play.spec.ts does the same), participant rows are written directly, and
// the guest follows by the store's polling fallback, every 3 s while realtime is down.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const CLIP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/clip-6s.webm'))

const admin = adminClient()
let host: SpecUser
let guest: SpecUser
let server: SeededServer
let voiceId: string

test.beforeAll(async () => {
  host = await createUser(admin, 'acth')
  guest = await createUser(admin, 'actg')
  server = await seedServer(admin, host, `Movie night ${host.username}`)
  await addMember(admin, guest, server.id)
  const { data, error } = await admin.from('channels').insert({ server_id: server.id, name: 'cinema', type: 1 }).select('id').single()
  if (error || !data) throw new Error(`voice channel: ${error?.message}`)
  voiceId = data.id
  for (const user of [host, guest]) {
    const { error: joinError } = await admin.from('voice_channel_participants').insert({ channel_id: voiceId, user_id: user.id, server_id: server.id })
    if (joinError) throw new Error(`participant: ${joinError.message}`)
  }
})

test.afterAll(async () => {
  await deleteUser(admin, guest)
  await deleteUser(admin, host)
})

async function enterVoice(page: Page, user: SpecUser) {
  await page.evaluate(({ serverId, channelId, userId }) => {
    type Store = { $patch: (fn: (state: Record<string, any>) => void) => void }
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
    }
    const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    if (!voice) throw new Error('voice store not created')
    voice.$patch((state) => {
      state.isConnected = true
      state.currentServerId = serverId
      state.currentChannelId = channelId
      state.currentChannelName = 'cinema'
      state.localState.userId = userId
    })
  }, { serverId: server.id, channelId: voiceId, userId: user.id })
}

const media = (page: Page) => page.getByTestId('activity-media')
const mediaState = (page: Page) => media(page).evaluate((el: HTMLMediaElement) => ({ paused: el.paused, time: el.currentTime }))

test('a Drive video plays for everyone in the call and follows the host', async ({ page, browser }) => {
  test.setTimeout(180_000)
  await signIn(page, host)

  await test.step('the host has a video in Drive', async () => {
    await page.getByTestId('rail-drive').click()
    await expect(page.getByTestId('drive-view')).toBeVisible({ timeout: 30000 })
    await dismissAnnouncements(page)
    await page.getByTestId('drive-file-input').setInputFiles({ name: 'clip-6s.webm', mimeType: 'video/webm', buffer: CLIP })
    await expect(page.getByTestId('drive-file').filter({ hasText: 'clip-6s.webm' })).toBeVisible({ timeout: 30000 })
  })

  const context = await browser.newContext()
  try {
    const other = await context.newPage()
    await signIn(other, guest)
    await openChannel(other, server.id, server.generalChannelId)
    await enterVoice(other, guest)
    // A click gives the guest's page the user activation that unmuted playback needs.
    await other.getByTestId('message-list').click()

    await openChannel(page, server.id, server.generalChannelId)
    await enterVoice(page, host)

    await test.step('the host starts the video from the call dock and pauses it', async () => {
      await page.getByTestId('activity-button').first().click()
      await page.getByTestId('activity-launcher').getByTestId('activity-from-drive').click()
      await page.getByTestId('drive-picker').getByTestId('drive-picker-file').filter({ hasText: 'clip-6s.webm' }).click()
      await page.getByTestId('drive-picker-confirm').click()
      const card = page.getByTestId('activity-dock-card')
      await expect(card).toContainText('clip-6s.webm', { timeout: 15000 })
      await expect.poll(async () => (await mediaState(page)).paused, { timeout: 15000 }).toBe(false)
      await card.getByTestId('activity-play').click()
      await expect.poll(async () => (await mediaState(page)).paused).toBe(true)
    })

    await test.step('the guest gets it paused at the host position, and the channel row says so', async () => {
      await expect(other.getByTestId('activity-dock-card')).toContainText('clip-6s.webm', { timeout: 15000 })
      await expect(other.getByTestId('voice-activity-line')).toBeVisible()
      const hostAt = (await mediaState(page)).time
      await expect.poll(async () => {
        const s = await mediaState(other)
        return s.paused && Math.abs(s.time - hostAt) < 0.75
      }, { timeout: 15000 }).toBe(true)
    })

    await test.step('play from the host plays for the guest', async () => {
      await page.getByTestId('activity-dock-card').getByTestId('activity-play').click()
      await expect.poll(async () => (await mediaState(other)).paused, { timeout: 10000 }).toBe(false)
    })

    await test.step('stop from the host ends it for the guest', async () => {
      await page.getByTestId('activity-dock-card').getByTestId('activity-stop').click()
      await expect(page.getByTestId('activity-dock-card')).toHaveCount(0)
      await expect(other.getByTestId('activity-dock-card')).toHaveCount(0, { timeout: 10000 })
      await expect(other.getByTestId('voice-activity-line')).toHaveCount(0)
    })
  } finally {
    await context.close()
  }
})
