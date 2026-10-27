// Journey: the KLIPY credit over a sent Klipy clip or GIF sits in the top-left corner of the
// media, shown while the media is pointed at. On a clip it stays clear of the player's
// controls along the bottom edge (play, scrub bar, time) and of the buttons in the top-right
// corner (favorite, pop out).
//
// Klipy's attribution guidelines (docs.klipy.com/attribution) make the watermark optional
// and set no position.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Locator, type Page } from '@playwright/test'
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

const admin = adminClient()
let user: SpecUser
let server: SeededServer
const ids = { clip: '', gif: '' }

/** A Klipy media URL as the picker sends it (utils/klipyAttribution.buildGifMessageUrl). */
function klipyMessageUrl(media: string, item: string, kind?: string): string {
  const url = new URL(media)
  const params = new URLSearchParams({ item })
  if (kind) params.set('kind', kind)
  url.hash = `harmony-klipy=${params}`
  return url.toString()
}

const CLIP_URL = klipyMessageUrl('https://static.klipy.test/ii/abc/de/fg/cat-falls.mp4', 'https://klipy.com/clips/cat-falls', 'clip')
const GIF_URL = klipyMessageUrl('https://static.klipy.test/ii/abc/de/fg/cat-waves.gif', 'https://klipy.com/gifs/cat-waves')
const CLIP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/clip-6s.webm'))
const GIF_BODY = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#0ea5e9"/></svg>'

async function post(label: string, part: Record<string, unknown>, at: number): Promise<string> {
  const { data, error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: `${label} ` }, part],
    created_at: new Date(at).toISOString(),
  }).select('id').single()
  if (error || !data) throw new Error(`message ${label}: ${error?.message}`)
  return data.id
}

test.beforeAll(async () => {
  user = await createUser(admin, 'klipy')
  server = await seedServer(admin, user, `Klipy ${user.username}`)
  const t0 = Date.now() - 60_000
  ids.clip = await post('clip', { type: 'file', fileType: 'video', url: CLIP_URL }, t0)
  ids.gif = await post('gif', { type: 'file', fileType: 'image', url: GIF_URL }, t0 + 1000)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

async function serveMedia(page: Page) {
  await page.route('https://static.klipy.test/**/*.mp4', (route) =>
    route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP, headers: { 'Accept-Ranges': 'bytes' } }))
  await page.route('https://static.klipy.test/**/*.gif', (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: GIF_BODY }))
}

const row = (page: Page, id: string) => messageList(page).locator(`.message-item[data-message-id="${id}"]`)

type Box = { x: number; y: number; width: number; height: number }
const box = async (l: Locator): Promise<Box> => {
  const b = await l.boundingBox()
  if (!b) throw new Error('no box')
  return b
}
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

test('the KLIPY credit sits top-left, clear of a clip\'s controls', async ({ page }) => {
  test.setTimeout(120_000)
  await serveMedia(page)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('on a clip it stays off the scrub bar and the control dock', async () => {
    const frame = row(page, ids.clip).locator('.video-container .media-frame')
    await expect(frame.locator('video')).toBeVisible({ timeout: 30000 })
    await expect.poll(() => frame.locator('video').evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15000 }).toBeGreaterThan(0)
    await frame.hover()
    const credit = frame.locator('a.klipy-watermark')
    await expect(credit).toHaveAttribute('href', 'https://klipy.com/clips/cat-falls')
    await expect.poll(() => credit.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.5)
    const dock = frame.locator('.hv-dock')
    await expect(dock).toBeVisible()
    await expect.poll(() => dock.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1)

    const creditBox = await box(credit)
    const frameBox = await box(frame)
    expect(overlaps(creditBox, await box(dock))).toBe(false)
    expect(overlaps(creditBox, await box(frame.getByTestId('video-seek')))).toBe(false)
    expect(creditBox.x - frameBox.x).toBeLessThanOrEqual(12)
    expect(creditBox.y - frameBox.y).toBeLessThanOrEqual(12)
    expect(overlaps(creditBox, await box(frame.locator('.gif-favorite-button')))).toBe(false)
    const popOut = frame.locator('.floating-video-popout')
    if (await popOut.count()) expect(overlaps(creditBox, await box(popOut))).toBe(false)
  })

  await test.step('on a GIF it sits in the same corner, clear of the favorite button', async () => {
    const frame = row(page, ids.gif).locator('.image-container .media-frame')
    await expect(frame.locator('img.content-image')).toBeVisible({ timeout: 15000 })
    await frame.hover()
    const credit = frame.locator('a.klipy-watermark')
    await expect(credit).toHaveAttribute('href', 'https://klipy.com/gifs/cat-waves')
    await expect.poll(() => credit.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.5)
    const creditBox = await box(credit)
    const frameBox = await box(frame)
    expect(creditBox.x - frameBox.x).toBeLessThanOrEqual(12)
    expect(creditBox.y - frameBox.y).toBeLessThanOrEqual(12)
    expect(overlaps(creditBox, await box(frame.locator('.gif-favorite-button')))).toBe(false)
  })
})
