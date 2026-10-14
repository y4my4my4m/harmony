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

// The relay page loads https://www.youtube.com/iframe_api; this stand-in records the video it
// was asked for and answers like the IFrame API: ready, then playing, or error 150 (the
// uploader disabled embedding) for BLOCKED.
const BLOCKED = 'blockedVid0'
const IFRAME_API_STUB = `
window.YT = { Player: function (id, opts) {
  var t = 0, playing = false;
  window.top.postMessage({ ytStub: opts.videoId }, '*');
  this.playVideo = function () { playing = true; opts.events.onStateChange({ data: 1 }); };
  this.pauseVideo = function () { playing = false; opts.events.onStateChange({ data: 2 }); };
  this.seekTo = function (s) { t = s; };
  this.setVolume = function () {};
  this.setPlaybackRate = function () {};
  this.getCurrentTime = function () { if (playing) t += 0.25; return t; };
  this.getDuration = function () { return 120; };
  this.destroy = function () {};
  var self = this;
  setTimeout(function () {
    if (opts.videoId === '${BLOCKED}') { opts.events.onError({ data: 150 }); return; }
    opts.events.onReady({});
    if (opts.playerVars.autoplay) self.playVideo();
  }, 50);
} };
window.onYouTubeIframeAPIReady();
`

test('a YouTube link plays in the shared player; the stage takes reactions and ends it for everyone', async ({ page }) => {
  test.setTimeout(120_000)
  await page.context().route('https://www.youtube.com/iframe_api', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: IFRAME_API_STUB }))
  const asked: string[] = []
  await page.exposeFunction('__ytAsked', (id: string) => asked.push(id))
  await page.addInitScript(() => {
    window.addEventListener('message', (e) => {
      if (e.data && typeof e.data.ytStub === 'string') (window as unknown as { __ytAsked: (id: string) => void }).__ytAsked(e.data.ytStub)
    })
  })

  await signIn(page, host)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, host)
  await page.evaluate(() => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { $patch: (fn: (s: Record<string, any>) => void) => void }> } } } }
    }
    root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')!.$patch((s) => { s.connectionMode = 'livekit' })
  })

  await test.step('a pasted link starts the video in the relay player', async () => {
    await page.getByTestId('activity-button').first().click()
    await page.getByTestId('activity-link').fill('https://www.youtube.com/watch?v=rFrPz1WkBvk&si=share123')
    await page.getByTestId('activity-start').click()
    await expect.poll(() => asked, { timeout: 15000 }).toContain('rFrPz1WkBvk')
    await page.getByTestId('activity-open').click()
    await expect(page.getByTestId('activity-stage')).toBeVisible()
    await expect(page.getByTestId('activity-error')).toHaveCount(0)
  })

  await test.step('the stage has a react button with the reaction picker', async () => {
    await page.getByTestId('activity-react').click()
    await expect(page.getByRole('dialog', { name: 'Reactions' })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  await test.step('a video that refuses embedding says so and links to YouTube', async () => {
    await page.getByTestId('activity-queue-toggle').click()
    await page.getByTestId('activity-queue-add').click()
    await page.getByTestId('activity-link').fill(`https://www.youtube.com/watch?v=${BLOCKED}`)
    await page.getByTestId('activity-play-now').click()
    const notice = page.getByTestId('activity-error')
    await expect(notice).toContainText("This can't play here.", { timeout: 15000 })
    await expect(notice.getByRole('link', { name: 'Open on YouTube' })).toHaveAttribute('href', `https://www.youtube.com/watch?v=${BLOCKED}`)
  })

  await test.step('End for everyone, named in the stage header, ends it', async () => {
    await page.getByTestId('activity-stage').getByRole('button', { name: 'End for everyone' }).click()
    await expect(page.getByTestId('activity-stage')).toHaveCount(0)
    await expect(page.getByTestId('activity-dock-card')).toHaveCount(0)
  })
})
