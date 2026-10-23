// Journey: chat videos play in Harmony's player. An attached clip shows the player chrome
// instead of the browser's controls; play, pause, seeking by pointer and keyboard, mute and
// playback speed act on the video, and the progress bar follows playback. Appearance
// settings switch to the browser's own controls, and back. A portrait clip, as narrow as
// chat draws it and narrower, keeps every control inside its frame, and
// its volume slider stands above the mute button on hover. A tier change hides the slider
// after its 200 ms fade; the checks wait for it.
//
// The clips are VP9/Opus WebM fixtures (6 s landscape, 3 s 360x640 portrait) served at fixed
// URLs (Playwright's Chromium has no H.264).

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
const PORTRAIT_URL = 'https://fixtures.harmony.test/clip-portrait-3s.webm'
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures')
const CLIP = fs.readFileSync(path.join(FIXTURES, 'clip-6s.webm'))
const PORTRAIT = fs.readFileSync(path.join(FIXTURES, 'clip-portrait-3s.webm'))

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
  const { error: portraitError } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: 'portrait ' }, { type: 'file', fileType: 'video', url: PORTRAIT_URL, fileName: 'clip-portrait-3s.webm' }],
  })
  if (portraitError) throw new Error(`portrait message: ${portraitError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

async function serveClip(page: Page) {
  await page.route(CLIP_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP, headers: { 'Accept-Ranges': 'bytes' } }))
  await page.route(PORTRAIT_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: PORTRAIT, headers: { 'Accept-Ranges': 'bytes' } }))
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

test('a portrait video keeps its controls in its frame and stands its volume slider', async ({ page }) => {
  test.setTimeout(180_000)
  await serveClip(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)

  const portraitRow = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'portrait ' })
  const player = portraitRow.getByTestId('video-controls')
  const portraitVideo = portraitRow.locator('video')

  /** Every shown control of the dock lies inside the player, which is the video's frame. */
  const controlsInFrame = async () => {
    await player.hover()
    const frame = (await player.boundingBox())!
    const boxes = await player.locator('.hv-dock button, .hv-dock [role="slider"]').evaluateAll((els) =>
      els
        .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
        .map((el) => {
          const r = el.getBoundingClientRect()
          return { name: el.getAttribute('aria-label') ?? '', left: r.left, right: r.right, top: r.top, bottom: r.bottom }
        }))
    expect(boxes.length).toBeGreaterThan(2)
    for (const b of boxes) {
      expect(b.left, b.name).toBeGreaterThanOrEqual(frame.x - 0.5)
      expect(b.right, b.name).toBeLessThanOrEqual(frame.x + frame.width + 0.5)
      expect(b.top, b.name).toBeGreaterThanOrEqual(frame.y - 0.5)
      expect(b.bottom, b.name).toBeLessThanOrEqual(frame.y + frame.height + 0.5)
    }
    return boxes.map((b) => b.name)
  }

  const slider = player.getByRole('slider', { name: 'Volume', includeHidden: true })

  await test.step('the portrait player is narrow and every control fits', async () => {
    await expect(player).toBeVisible({ timeout: 30000 })
    await expect.poll(async () => (await portraitVideo.evaluate((el: HTMLVideoElement) => el.videoHeight)), { timeout: 15000 }).toBe(640)
    await expect(player).toHaveClass(/hv--micro/)
    await expect(slider).toBeHidden()
    const names = await controlsInFrame()
    expect(names).toEqual(['Seek', 'Mute', 'Open in viewer', 'Full screen'])
  })

  await test.step('hovering the mute button stands the volume slider above it', async () => {
    const mute = player.getByTestId('video-mute')
    await mute.hover()
    await expect(slider).toBeVisible()
    await expect(slider).toHaveAttribute('aria-orientation', 'vertical')
    const m = (await mute.boundingBox())!
    const s = (await slider.boundingBox())!
    const frame = (await player.boundingBox())!
    expect(s.y + s.height).toBeLessThanOrEqual(m.y)
    expect(s.height).toBeGreaterThan(s.width * 2)
    expect(s.y).toBeGreaterThanOrEqual(frame.y)

    // Down onto the slider through the bridge, then press near the bottom of the track.
    await page.mouse.move(m.x + m.width / 2, m.y - 4)
    await page.mouse.move(s.x + s.width / 2, s.y + s.height - 16)
    await page.mouse.down()
    await page.mouse.up()
    await expect.poll(async () => portraitVideo.evaluate((el: HTMLVideoElement) => el.volume)).toBeLessThan(0.25)
    await page.mouse.click(s.x + s.width / 2, s.y + 10)
    await expect.poll(async () => portraitVideo.evaluate((el: HTMLVideoElement) => el.volume)).toBeGreaterThan(0.9)
    await expect(slider).toBeVisible()
  })

  await test.step('the narrowest player still fits, expand standing for fullscreen', async () => {
    // A host 124 px wide: the portrait clip at 220 px tall.
    await slider.evaluate((el) => (el as HTMLElement).blur())
    await page.mouse.move(0, 0)
    await portraitVideo.evaluate((el) => { el.style.maxHeight = '220px' })
    await expect(player).toHaveClass(/hv--nano/, { timeout: 10000 })
    await expect(slider).toBeHidden()
    const names = await controlsInFrame()
    expect(names).toEqual(['Seek', 'Mute', 'Open in viewer'])
  })
})
