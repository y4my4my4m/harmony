// Journey: the media viewer. A chat video opens in it from its player and keeps its
// position both ways; the viewer and an inline player go true fullscreen and leave it;
// previous and next step through one message's images and videos; on a phone, swipes step
// through and close the viewer, Back closes it, a double tap and a pinch zoom an image, a
// pinch on a clip does nothing, and turning the phone keeps the playing video where it was.
//
// Media are fixtures served at fixed URLs: the 6 s VP9/Opus WebM clip and generated SVG
// pictures (Playwright's Chromium has no H.264).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, devices, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const FIXTURES = 'https://fixtures.harmony.test'
const CLIP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/clip-6s.webm'))

const picture = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="${fill}"/><circle cx="400" cy="300" r="120" fill="#fff"/></svg>`
const PICTURES: Record<string, string> = { 'a.svg': '#0ea5e9', 'b.svg': '#f97316', 'c.svg': '#22c55e', 'd.svg': '#a855f7' }

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'mview')
  server = await seedServer(admin, user, `Viewer ${user.username}`)
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
  const file = (name: string, fileType: 'image' | 'video') => ({ type: 'file', fileType, url: `${FIXTURES}/${name}`, fileName: name })
  const { error } = await admin.from('messages').insert([
    {
      channel_id: server.generalChannelId,
      user_id: user.id,
      content: [{ type: 'text', text: 'older pictures ' }, file('c.svg', 'image'), file('d.svg', 'image')],
      created_at: at(30),
    },
    {
      channel_id: server.generalChannelId,
      user_id: user.id,
      content: [{ type: 'text', text: 'two pictures and a clip ' }, file('a.svg', 'image'), file('b.svg', 'image'), file('clip-b.webm', 'video')],
      created_at: at(20),
    },
    {
      channel_id: server.generalChannelId,
      user_id: user.id,
      content: [{ type: 'text', text: 'clip ' }, file('clip-6s.webm', 'video')],
      created_at: at(10),
    },
  ])
  if (error) throw new Error(`messages: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

async function serveFixtures(page: Page) {
  await page.route(`${FIXTURES}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1)
    if (name.endsWith('.webm')) {
      return route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP, headers: { 'Accept-Ranges': 'bytes' } })
    }
    const fill = PICTURES[name]
    if (!fill) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: picture(fill) })
  })
}

const row = (page: Page, text: string) => messageList(page).locator('.message-item').filter({ hasText: text })
const viewer = (page: Page) => page.getByRole('dialog', { name: /Media viewer/ })
const position = (page: Page) => viewer(page).locator('.lightbox-position')
const time = (video: Locator) => video.evaluate((el: HTMLVideoElement) => el.currentTime)
const paused = (video: Locator) => video.evaluate((el: HTMLVideoElement) => el.paused)
const fullscreenClass = (page: Page) =>
  page.evaluate(() => (document.fullscreenElement ? document.fullscreenElement.className : null))

async function openGeneral(page: Page) {
  await serveFixtures(page)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
}

test('a chat video opens in the viewer where it was and returns there', async ({ page }) => {
  test.setTimeout(180_000)
  await openGeneral(page)
  const clipRow = row(page, 'clip ').last()
  const inline = clipRow.locator('video')
  const player = clipRow.getByTestId('video-controls')
  await expect(player).toBeVisible({ timeout: 30000 })
  await expect.poll(async () => Number(await player.getByTestId('video-seek').getAttribute('aria-valuemax')), { timeout: 15000 }).toBe(6)

  await test.step('the playing clip moves into the viewer and keeps playing from its place', async () => {
    await player.hover()
    await player.getByTestId('video-play').click()
    await expect.poll(() => time(inline), { timeout: 10000 }).toBeGreaterThan(1)
    const before = await time(inline)
    await player.getByTestId('video-expand').click()
    await expect(viewer(page)).toBeVisible()
    const big = viewer(page).locator('video')
    await expect(viewer(page).getByTestId('video-controls')).toBeVisible()
    expect(await paused(inline)).toBe(true)
    await expect.poll(() => time(big), { timeout: 10000 }).toBeGreaterThan(before)
    await expect.poll(() => paused(big)).toBe(false)
  })

  await test.step("closing hands the viewer's position back to the chat player", async () => {
    const big = viewer(page).locator('video')
    await viewer(page).getByTestId('video-controls').hover()
    await viewer(page).getByTestId('video-play').click()
    await expect.poll(() => paused(big)).toBe(true)
    await big.evaluate((el: HTMLVideoElement) => { el.currentTime = 4.5 })
    await expect.poll(() => time(big)).toBeCloseTo(4.5, 1)
    await page.keyboard.press('Escape')
    await expect(viewer(page)).toBeHidden()
    await expect.poll(() => time(inline)).toBeCloseTo(4.5, 1)
    expect(await paused(inline)).toBe(true)
  })
})

test('the viewer and the chat player go true fullscreen and come back', async ({ page }) => {
  test.setTimeout(180_000)
  await openGeneral(page)

  await test.step('an image fills the screen with the viewer', async () => {
    const pictures = row(page, 'two pictures and a clip')
    await expect(pictures.locator('img.content-image')).toHaveCount(2, { timeout: 30000 })
    await pictures.locator('img.content-image').first().click()
    await expect(viewer(page)).toBeVisible()
    const control = viewer(page).getByTestId('lightbox-fullscreen')
    await expect(control).toHaveAccessibleName('Full screen')
    await control.click()
    await expect.poll(() => fullscreenClass(page)).toContain('media-lightbox-overlay')
    await expect(control).toHaveAccessibleName('Exit full screen')
    await control.click()
    await expect.poll(() => fullscreenClass(page)).toBeNull()
    await expect(viewer(page)).toBeVisible()
  })

  await test.step("the viewer's player fills the screen with the viewer", async () => {
    await viewer(page).getByRole('button', { name: 'Next' }).click()
    await viewer(page).getByRole('button', { name: 'Next' }).click()
    await expect(position(page)).toHaveText('3 of 3')
    const dock = viewer(page).getByTestId('video-controls')
    await dock.hover()
    await dock.getByTestId('video-fullscreen').click()
    await expect.poll(() => fullscreenClass(page)).toContain('media-lightbox-overlay')
    await expect(dock.getByTestId('video-fullscreen')).toHaveAccessibleName('Exit full screen')
    await dock.getByTestId('video-fullscreen').click()
    await expect.poll(() => fullscreenClass(page)).toBeNull()
    await viewer(page).getByRole('button', { name: 'Close' }).click()
    await expect(viewer(page)).toBeHidden()
  })

  await test.step('the chat player fills the screen with itself', async () => {
    const player = row(page, 'clip ').last().getByTestId('video-controls')
    await player.hover()
    await player.getByTestId('video-fullscreen').click()
    await expect.poll(() => fullscreenClass(page)).toContain('hv-host')
    await player.getByTestId('video-fullscreen').click()
    await expect.poll(() => fullscreenClass(page)).toBeNull()
  })
})

test("previous and next step through one message's pictures and clip", async ({ page }) => {
  test.setTimeout(180_000)
  await openGeneral(page)
  const pictures = row(page, 'two pictures and a clip')
  await expect(pictures.locator('img.content-image')).toHaveCount(2, { timeout: 30000 })
  const opener = pictures.getByRole('button', { name: 'View image 1 of 3 full size' })
  await opener.focus()
  await page.keyboard.press('Enter')

  const previous = viewer(page).getByRole('button', { name: 'Previous' })
  const next = viewer(page).getByRole('button', { name: 'Next' })
  await expect(position(page)).toHaveText('1 of 3')
  await expect(viewer(page).locator('img.media-image')).toHaveAttribute('src', `${FIXTURES}/a.svg`)
  await expect(previous).toHaveCount(0)

  await next.click()
  await expect(position(page)).toHaveText('2 of 3')
  await expect(viewer(page).locator('img.media-image')).toHaveAttribute('src', `${FIXTURES}/b.svg`)

  await next.click()
  await expect(position(page)).toHaveText('3 of 3')
  await expect(viewer(page).locator('video')).toHaveAttribute('src', `${FIXTURES}/clip-b.webm`)
  await expect(next).toHaveCount(0)
  await expect(viewer(page)).toBeFocused()

  await page.keyboard.press('ArrowLeft')
  await expect(position(page)).toHaveText('2 of 3')
  await previous.click()
  await expect(position(page)).toHaveText('1 of 3')
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toBeHidden()
  await expect(opener).toBeFocused()
})

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  type Point = { x: number; y: number }

  // Real touch input through CDP: the page sees trusted touch pointer events.
  async function touch(page: Page, paths: Point[][], steps = 10) {
    const cdp = await page.context().newCDPSession(page)
    const at = (i: number) => paths.map((p, id) => {
      const from = p[0]
      const to = p[p.length - 1]
      return { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id }
    })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) })
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(i) })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  }

  async function stageCentre(page: Page): Promise<Point> {
    const box = (await viewer(page).locator('.lightbox-stage').boundingBox())!
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  const imageScale = (page: Page) =>
    viewer(page).locator('img.media-image').evaluate((img) => {
      const match = /scale\(([\d.]+)\)/.exec((img as HTMLElement).style.transform)
      return match ? Number(match[1]) : 1
    })

  test('swipes step through and close the viewer; Back closes it; images zoom', async ({ page }) => {
    test.setTimeout(180_000)
    await openGeneral(page)
    const pictures = row(page, 'two pictures and a clip')
    await expect(pictures.locator('img.content-image')).toHaveCount(2, { timeout: 30000 })
    await pictures.scrollIntoViewIfNeeded()
    await pictures.locator('img.content-image').first().tap()
    await expect(viewer(page)).toBeVisible()
    await expect(position(page)).toHaveText('1 of 3')

    await test.step('a swipe left shows the next item, a swipe right the one before', async () => {
      const c = await stageCentre(page)
      await touch(page, [[{ x: c.x + 140, y: c.y }, { x: c.x - 140, y: c.y }]])
      await expect(position(page)).toHaveText('2 of 3')
      await touch(page, [[{ x: c.x - 140, y: c.y }, { x: c.x + 140, y: c.y }]])
      await expect(position(page)).toHaveText('1 of 3')
    })

    await test.step('a double tap zooms the picture in and out; a pinch zooms it', async () => {
      // The picture sits centred on the stage, which does not move with the slide.
      const { x, y } = await stageCentre(page)
      await page.touchscreen.tap(x, y)
      await page.touchscreen.tap(x, y)
      await expect.poll(() => imageScale(page)).toBeCloseTo(2.5, 1)
      await page.touchscreen.tap(x, y)
      await page.touchscreen.tap(x, y)
      await expect.poll(() => imageScale(page)).toBe(1)
      await touch(page, [
        [{ x: x - 30, y }, { x: x - 130, y }],
        [{ x: x + 30, y }, { x: x + 130, y }],
      ])
      await expect.poll(() => imageScale(page)).toBeGreaterThan(2)
      await page.touchscreen.tap(x, y)
      await page.touchscreen.tap(x, y)
      await expect.poll(() => imageScale(page)).toBe(1)
    })

    await test.step('a pinch on the clip neither steps nor closes', async () => {
      const c = await stageCentre(page)
      await touch(page, [[{ x: c.x + 140, y: c.y }, { x: c.x - 140, y: c.y }]])
      await expect(position(page)).toHaveText('2 of 3')
      await touch(page, [[{ x: c.x + 140, y: c.y }, { x: c.x - 140, y: c.y }]])
      await expect(position(page)).toHaveText('3 of 3')
      // Above the video, clear of its play button.
      const y = c.y - 200
      await touch(page, [
        [{ x: c.x - 30, y }, { x: c.x - 130, y }],
        [{ x: c.x + 30, y }, { x: c.x + 130, y }],
      ])
      await page.waitForTimeout(400)
      await expect(viewer(page)).toBeVisible()
      await expect(position(page)).toHaveText('3 of 3')
      await touch(page, [[{ x: c.x - 140, y: c.y }, { x: c.x + 140, y: c.y }]])
      await expect(position(page)).toHaveText('2 of 3')
      await touch(page, [[{ x: c.x - 140, y: c.y }, { x: c.x + 140, y: c.y }]])
      await expect(position(page)).toHaveText('1 of 3')
    })

    await test.step('a swipe down closes the viewer and stays in the channel', async () => {
      const c = await stageCentre(page)
      await touch(page, [[{ x: c.x, y: c.y - 100 }, { x: c.x, y: c.y + 220 }]])
      await expect(viewer(page)).toBeHidden()
      await expect(page).toHaveURL(new RegExp(`/chat/${server.id}/${server.generalChannelId}`))
    })

    await test.step('Back closes the viewer and stays in the channel', async () => {
      // Chrome yields no click for a tap right after the synthetic swipe; the tap repeats until one opens.
      await expect(async () => {
        await pictures.locator('img.content-image').first().tap()
        await expect(viewer(page)).toBeVisible({ timeout: 1000 })
      }).toPass({ timeout: 15000 })
      await page.goBack()
      await expect(viewer(page)).toBeHidden()
      await page.waitForTimeout(400)
      await expect(page).toHaveURL(new RegExp(`/chat/${server.id}/${server.generalChannelId}`))
      await expect(row(page, 'two pictures and a clip')).toBeVisible()
    })
  })

  test('turning the phone keeps the playing video and its place', async ({ page }) => {
    test.setTimeout(180_000)
    await openGeneral(page)
    const player = row(page, 'clip ').last().getByTestId('video-controls')
    await expect(player).toBeVisible({ timeout: 30000 })
    await player.scrollIntoViewIfNeeded()
    await player.getByTestId('video-expand').tap()
    await expect(viewer(page)).toBeVisible()
    const big = viewer(page).locator('video')
    const dock = viewer(page).getByTestId('video-controls')
    await dock.getByTestId('video-play').tap()
    await expect.poll(() => time(big), { timeout: 10000 }).toBeGreaterThan(1)
    await big.evaluate((el) => { el.dataset.turned = 'before' })
    const before = await time(big)

    await page.setViewportSize({ width: viewport.height, height: viewport.width })
    await expect.poll(() => time(big)).toBeGreaterThan(before)
    expect(await big.evaluate((el) => el.dataset.turned)).toBe('before')
    expect(await paused(big)).toBe(false)
    const box = (await big.boundingBox())!
    expect(box.width).toBeGreaterThan(box.height)
    expect(box.height).toBeLessThanOrEqual(viewport.width)

    await page.setViewportSize(viewport)
    expect(await big.evaluate((el) => el.dataset.turned)).toBe('before')
    expect(await paused(big)).toBe(false)
  })
})
