// Journey: chat videos play in Harmony's player. An attached clip shows the player chrome
// instead of the browser's controls; play, pause, seeking by pointer and keyboard, mute and
// playback speed act on the video, and the progress bar follows playback. Appearance
// settings switch to the browser's own controls, and back.
//
// The clip is a 6 s VP9/Opus WebM fixture served at a fixed URL (Playwright's Chromium has
// no H.264).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
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

const CLIP_URL = 'https://fixtures.harmony.test/clip-6s.webm'
const CLIP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/clip-6s.webm'))

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'vplayer')
  server = await seedServer(admin, user, `Player ${user.username}`)
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: 'clip ' }, { type: 'file', fileType: 'video', url: CLIP_URL, fileName: 'clip-6s.webm' }],
  })
  if (error) throw new Error(`video message: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

async function serveClip(page: Page) {
  await page.route(CLIP_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP, headers: { 'Accept-Ranges': 'bytes' } }))
}

const row = (page: Page) => page.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'clip ' })
const video = (page: Page) => row(page).locator('video')
const state = (v: Locator) => v.evaluate((el: HTMLVideoElement) => ({
  time: el.currentTime, paused: el.paused, muted: el.muted, rate: el.playbackRate, controls: el.controls,
}))

test("an attached video plays in Harmony's player", async ({ page }) => {
  test.setTimeout(180_000)
  await serveClip(page)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)

  const player = row(page).getByTestId('video-controls')
  const play = player.getByTestId('video-play')
  const seek = player.getByTestId('video-seek')

  await test.step('the player replaces the browser controls', async () => {
    await expect(player).toBeVisible({ timeout: 30000 })
    await expect(player).toHaveAttribute('role', 'group')
    expect((await state(video(page))).controls).toBe(false)
    await expect.poll(async () => Number(await seek.getAttribute('aria-valuemax')), { timeout: 15000 }).toBe(6)
  })

  await test.step('play runs the clip and the progress bar follows it', async () => {
    await player.hover()
    await play.click()
    await expect(play).toHaveAttribute('aria-label', 'Pause')
    await expect.poll(async () => (await state(video(page))).time, { timeout: 10000 }).toBeGreaterThan(1)
    const progress = await seek.evaluate((el) => Number(getComputedStyle(el).getPropertyValue('--p')))
    expect(progress).toBeGreaterThan(0.1)
    await play.click()
    await expect(play).toHaveAttribute('aria-label', 'Play')
    expect((await state(video(page))).paused).toBe(true)
  })

  await test.step('clicking the bar seeks there', async () => {
    const box = (await seek.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect.poll(async () => (await state(video(page))).time).toBeGreaterThan(2.5)
    expect((await state(video(page))).time).toBeLessThan(3.5)
    expect((await state(video(page))).paused).toBe(true)
  })

  await test.step('the keyboard seeks, mutes and toggles playback', async () => {
    await seek.focus()
    await page.keyboard.press('Home')
    await expect.poll(async () => (await state(video(page))).time).toBeLessThan(0.1)
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await state(video(page))).time).toBeGreaterThan(4.9)
    await expect(seek).toHaveAttribute('aria-valuetext', '0:05 of 0:06')
    await page.keyboard.press('m')
    await expect.poll(async () => (await state(video(page))).muted).toBe(true)
    await expect(player.getByTestId('video-mute')).toHaveAttribute('aria-label', 'Unmute')
    await page.keyboard.press('Home')
    await page.keyboard.press('k')
    await expect.poll(async () => (await state(video(page))).paused).toBe(false)
    await page.keyboard.press('k')
    await expect.poll(async () => (await state(video(page))).paused).toBe(true)
  })

  await test.step('the speed button steps the playback rate', async () => {
    await player.getByTestId('video-speed').click()
    await expect.poll(async () => (await state(video(page))).rate).toBe(1.25)
    await expect(player.getByTestId('video-speed')).toHaveText('1.25×')
  })

  // Appearance edits are staged; Save writes profiles.appearance_settings.
  const choosePlayer = async (value: 'native' | 'harmony') => {
    await page.goto('/settings/appearance')
    const select = page.getByTestId('video-player-setting')
    await expect(select).toBeVisible({ timeout: 30000 })
    await select.selectOption(value)
    const saved = page.waitForResponse((r) => r.url().includes('/rest/v1/profiles') && r.request().method() === 'PATCH', { timeout: 15000 })
    await page.getByTestId('appearance-save-bar').getByRole('button', { name: 'Save changes' }).click()
    expect((await saved).ok()).toBe(true)
    const { data } = await admin.from('profiles').select('appearance_settings').eq('id', user.id).single()
    expect((data?.appearance_settings as { videoPlayer?: string } | null)?.videoPlayer).toBe(value)
  }

  await test.step("Appearance switches to the browser's controls and back", async () => {
    await choosePlayer('native')
    await openChannel(page, server.id, server.generalChannelId)
    await expect(video(page)).toBeVisible({ timeout: 30000 })
    await expect(row(page).getByTestId('video-controls')).toHaveCount(0)
    expect((await state(video(page))).controls).toBe(true)

    await choosePlayer('harmony')
    await openChannel(page, server.id, server.generalChannelId)
    await expect(row(page).getByTestId('video-controls')).toBeVisible({ timeout: 30000 })
    expect((await state(video(page))).controls).toBe(false)
  })
})
