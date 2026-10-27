// Journey: /gif opens the inline GIF strip over the composer; the strip scrolls sideways
// and a vertical mouse wheel over it scrolls it. At either end the wheel is left to the
// page (the event is not cancelled), so it scrolls whatever is around the strip.
//
// The GIF proxy (/api/federation/gifs) is answered here with 20 GIFs, wider than the strip.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'gifwh')
  server = await seedServer(admin, user, `Gifs ${user.username.slice(-6)}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const gif = (i: number) => {
  const url = `https://media.gif.test/${i}.gif`
  return { kind: 'gif', id: `g${i}`, title: `gif ${i}`, media_formats: { gif: { url }, gifpreview: { url }, mp4: { url }, webm: { url } } }
}

/** Wheel at the strip's centre; returns whether the page saw the event cancelled. */
async function wheel(page: Page, dy: number): Promise<boolean> {
  const strip = page.locator('.inline-gif-grid')
  const b = (await strip.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.evaluate(() => { (window as unknown as { __wheel: boolean | null }).__wheel = null })
  await page.mouse.wheel(0, dy)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wheel: boolean | null }).__wheel)).not.toBeNull()
  return page.evaluate(() => (window as unknown as { __wheel: boolean }).__wheel)
}

test('the mouse wheel scrolls the inline GIF strip and passes through at its ends', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.route('**/api/federation/gifs/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => gif(i)), page: 1, hasNext: false }) }),
  )
  await page.route('https://media.gif.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await page.evaluate(() => {
    window.addEventListener('wheel', (e) => { (window as unknown as { __wheel: boolean }).__wheel = e.defaultPrevented })
  })

  const strip = page.locator('.inline-gif-grid')
  const scrollLeft = () => strip.evaluate((el) => el.scrollLeft)
  const maxScroll = () => strip.evaluate((el) => el.scrollWidth - el.clientWidth)

  await test.step('/gif opens the strip, wider than its box', async () => {
    await composer(page).click()
    await page.keyboard.type('/gif')
    await expect(page.locator('#auto-suggest-listbox')).toBeVisible({ timeout: 10000 })
    await page.keyboard.press('Enter')
    await expect(strip.locator('.inline-gif-item')).toHaveCount(20, { timeout: 15000 })
    expect(await maxScroll()).toBeGreaterThan(300)
    expect(await scrollLeft()).toBe(0)
  })

  await test.step('at the start a wheel up is left to the page', async () => {
    expect(await wheel(page, -100)).toBe(false)
    expect(await scrollLeft()).toBe(0)
  })

  await test.step('a wheel down scrolls the strip sideways', async () => {
    expect(await wheel(page, 200)).toBe(true)
    await expect.poll(scrollLeft).toBeGreaterThan(100)
  })

  await test.step('at the end the wheel is left to the page', async () => {
    const max = await maxScroll()
    for (let i = 0; i < 30 && (await scrollLeft()) < max - 1; i++) await wheel(page, 400)
    expect(await scrollLeft()).toBeGreaterThanOrEqual(max - 1)
    expect(await wheel(page, 100)).toBe(false)
  })

  await test.step('a wheel up scrolls it back', async () => {
    const before = await scrollLeft()
    expect(await wheel(page, -200)).toBe(true)
    await expect.poll(scrollLeft).toBeLessThan(before)
  })
})
