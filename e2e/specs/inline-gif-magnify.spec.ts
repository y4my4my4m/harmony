// Journey: the /gif strip over the composer magnifies like the macOS Dock. A pointer resting on the
// strip grows the result under it to full size with its own aspect, neighbours grow less, the row
// spreads around it and the magnified tiles keep the strip's bottom edge. The strip's own layout does
// not move, the pointer stays on the result in focus as it slides along, and a click sends the result
// under it. Up from the composer moves focus into the strip, Left/Right move the magnification,
// Escape returns to the composer, Enter sends. A touch long-press magnifies and its release sends
// nothing. Reduced motion drops the easing. Only results held in focus fetch their full rendition.
// The composer's GIF picker, whose tiles are large enough to read, keeps its plain tiles.
//
// The GIF proxy (/api/federation/gifs) is answered here; media comes from media.gif.test with
// thumbnails under /thumb/ and full renditions under /full/.

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

const admin = adminClient()
let user: SpecUser
// One server per test: a GIF one test sends must not load in another's chat history.
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'gifmag')
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

// Width x height per index; the result in focus takes its own aspect.
const SIZES: [number, number][] = [[480, 270], [400, 400], [480, 360], [480, 270], [360, 480], [480, 270], [480, 300], [400, 300]]
const size = (i: number) => SIZES[i % SIZES.length]

const svg = (i: number, label: string) => {
  const [w, h] = size(i)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#345"/><text x="50%" y="50%" text-anchor="middle" font-size="${w / 10}" fill="#fff">${label} ${i}</text></svg>`
}

const gif = (i: number) => ({
  kind: 'gif',
  id: `g${i}`,
  title: `caption ${i}`,
  media_formats: {
    gif: { url: `https://media.gif.test/full/${i}.svg` },
    gifpreview: { url: `https://media.gif.test/thumb/${i}.svg` },
    mp4: { url: `https://media.gif.test/full/${i}.svg` },
    webm: { url: `https://media.gif.test/full/${i}.svg` },
  },
})

/** Routes the proxy and media; returns the indices whose full rendition was requested. */
async function mockGifs(page: Page): Promise<Set<number>> {
  const full = new Set<number>()
  await page.route('**/api/federation/gifs/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: Array.from({ length: 16 }, (_, i) => gif(i)), page: 1, hasNext: false }) }),
  )
  await page.route('https://media.gif.test/**', (route) => {
    const m = route.request().url().match(/\/(full|thumb)\/(\d+)\.svg/)
    const i = Number(m?.[2] ?? 0)
    if (m?.[1] === 'full') full.add(i)
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg(i, m?.[1] === 'full' ? 'FULL' : 'thumb') })
  })
  return full
}

const dock = (page: Page) => page.getByTestId('gif-dock')
const focusTile = (page: Page) => page.locator('.gif-dock-tile.focus')
const lensTile = (page: Page, i: number) => page.locator(`[data-dock-tile="g${i}"]`)
const strip = (page: Page) => page.locator('.inline-gif-picker')
const stripTiles = (page: Page) => page.locator('.inline-gif-item')

async function start(page: Page): Promise<Set<number>> {
  server = await seedServer(admin, user, `Gif magnify ${Math.random().toString(36).slice(2, 8)}`)
  await page.setViewportSize({ width: 1280, height: 800 })
  const full = await mockGifs(page)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  return full
}

async function openStrip(page: Page) {
  await composer(page).click()
  await page.keyboard.type('/gif')
  await expect(page.locator('#auto-suggest-listbox')).toBeVisible({ timeout: 10000 })
  await page.keyboard.press('Enter')
  await expect(stripTiles(page)).toHaveCount(16, { timeout: 15000 })
}

async function pointAt(page: Page, i: number, dx = 0) {
  const b = (await stripTiles(page).nth(i).boundingBox())!
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 4 })
}

/** The result in focus is `i`, at full size with its aspect, on the strip's bottom edge. */
async function expectFocus(page: Page, i: number) {
  await expect(focusTile(page)).toHaveAttribute('data-dock-tile', `g${i}`)
  // Settled: the transition to full size has run.
  await expect.poll(async () => (await focusTile(page).boundingBox())!.height, { timeout: 3000 }).toBeGreaterThan(150)
  await page.waitForTimeout(200)
  const b = (await focusTile(page).boundingBox())!
  const [w, h] = size(i)
  expect(b.width / b.height).toBeCloseTo(w / h, 1)
  expect(Math.max(b.width, b.height)).toBeGreaterThan(260)
  const tile = (await stripTiles(page).nth(i).boundingBox())!
  expect(Math.abs(b.y + b.height - (tile.y + tile.height))).toBeLessThan(1.5)
  return b
}

/** The channel holds a message whose file is result `i`. */
async function expectSent(i: number) {
  await expect
    .poll(async () => {
      const { data } = await admin.from('messages').select('content').eq('channel_id', server.generalChannelId)
      return JSON.stringify(data ?? [])
    }, { timeout: 15000 })
    .toContain(`media.gif.test/full/${i}.svg`)
}

test('the pointer magnifies the /gif strip like the Dock; a click sends the result under it', async ({ page }) => {
  test.setTimeout(120_000)
  const full = await start(page)
  await openStrip(page)

  await test.step('nothing magnifies and no full rendition loads up front', async () => {
    await expect(dock(page)).toHaveCount(0)
    expect([...full]).toEqual([])
  })

  const stripBefore = (await strip(page).boundingBox())!
  const tilesBefore = await stripTiles(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left))

  await test.step('resting on a result grows it, its neighbours less, the far ones not at all', async () => {
    await pointAt(page, 3)
    const focus = await expectFocus(page, 3)
    const near = (await lensTile(page, 2).boundingBox())!
    const far = (await lensTile(page, 0).boundingBox())!
    expect(near.height).toBeGreaterThan(90)
    expect(near.height).toBeLessThan(focus.height)
    expect(far.height).toBeLessThan(90)
    // Spread: neighbours sit beside the focus, not under it.
    expect(near.x + near.width).toBeLessThanOrEqual(focus.x + 1)
    await expect.poll(() => [...full]).toEqual([3])
  })

  await test.step('the strip itself does not move', async () => {
    expect(await strip(page).boundingBox()).toEqual(stripBefore)
    expect(await stripTiles(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().left))).toEqual(tilesBefore)
  })

  await test.step('sliding along the strip moves the magnification, the pointer stays on the focus', async () => {
    const b = (await stripTiles(page).nth(3).boundingBox())!
    const y = b.y + b.height / 2
    for (let x = b.x + b.width / 2; x < b.x + b.width / 2 + 2 * 92; x += 23) {
      await page.mouse.move(x, y)
      await page.waitForTimeout(60)
      const f = (await focusTile(page).boundingBox())!
      expect(x).toBeGreaterThanOrEqual(f.x - 1)
      expect(x).toBeLessThanOrEqual(f.x + f.width + 1)
    }
    await expectFocus(page, 5)
  })

  await test.step('leaving the strip ends it', async () => {
    await page.mouse.move(640, 150)
    await expect(dock(page)).toHaveCount(0)
    await expect(page.locator('.inline-gif-grid')).not.toHaveClass(/docked/)
  })

  await test.step('results never held in focus fetched nothing full-size', async () => {
    expect([...full].every((i) => i >= 3 && i <= 5)).toBe(true)
  })

  await test.step('a click sends the magnified result under the pointer', async () => {
    await pointAt(page, 2)
    await expectFocus(page, 2)
    await page.mouse.down()
    await page.mouse.up()
    await expect(strip(page)).toHaveCount(0)
    await expect(dock(page)).toHaveCount(0)
    await expectSent(2)
  })
})

test('the keyboard moves the magnification through /gif results', async ({ page }) => {
  test.setTimeout(120_000)
  const full = await start(page)
  await openStrip(page)
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-gif-tile') ?? null)

  await test.step('Up from the composer focuses the first result and magnifies it', async () => {
    await page.keyboard.press('ArrowUp')
    expect(await focused()).toBe('g0')
    await expectFocus(page, 0)
    await expect(focusTile(page)).toHaveClass(/keyboard/)
  })

  await test.step('Right moves focus and magnification', async () => {
    await page.keyboard.press('ArrowRight')
    expect(await focused()).toBe('g1')
    await expectFocus(page, 1)
  })

  await test.step('Escape returns to the composer and ends it', async () => {
    await page.keyboard.press('Escape')
    await expect(dock(page)).toHaveCount(0)
    await expect(composer(page)).toBeFocused()
    await expect(stripTiles(page)).toHaveCount(16)
  })

  await test.step('Up resumes at the last result', async () => {
    await page.keyboard.press('ArrowUp')
    expect(await focused()).toBe('g1')
    await expectFocus(page, 1)
    expect([...full].every((i) => i <= 1)).toBe(true)
  })

  await test.step('Enter sends the focused result', async () => {
    await page.keyboard.press('Enter')
    await expect(strip(page)).toHaveCount(0)
    await expectSent(1)
  })
})

test('reduced motion drops the easing', async ({ page }) => {
  test.setTimeout(120_000)
  await start(page)
  await openStrip(page)
  // Longest transition on the focused tile, in seconds. Keyboard moves ease; the app's reduced
  // motion leaves at most 0.01 ms.
  const longest = () =>
    focusTile(page).evaluate((el) => Math.max(...getComputedStyle(el).transitionDuration.split(',').map((d) => parseFloat(d))))

  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await expectFocus(page, 1)
  expect(await longest()).toBeGreaterThan(0.05)
  await page.keyboard.press('Escape')
  await expect(dock(page)).toHaveCount(0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  await expectFocus(page, 2)
  expect(await longest()).toBeLessThan(0.001)
})

test('a touch long-press magnifies a result and its release sends nothing', async ({ page }) => {
  test.setTimeout(120_000)
  await start(page)
  await openStrip(page)
  const count = async () => (await admin.from('messages').select('id', { count: 'exact', head: true }).eq('channel_id', server.generalChannelId)).count
  const before = await count()

  const b = (await stripTiles(page).nth(5).boundingBox())!
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2 }] })
  await expectFocus(page, 5)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect(dock(page)).toHaveCount(0)

  await page.waitForTimeout(1500)
  await expect(stripTiles(page)).toHaveCount(16)
  expect(await count()).toBe(before)
})

test('the GIF picker keeps its plain tiles', async ({ page }) => {
  test.setTimeout(120_000)
  await start(page)
  await page.locator('[data-testid="composer-gif"]').click()
  const picker = page.getByTestId('media-picker')
  await expect(picker.locator('.gif-item').first()).toBeVisible({ timeout: 15000 })
  await picker.locator('.gif-item').nth(1).hover()
  await page.waitForTimeout(800)
  await expect(dock(page)).toHaveCount(0)
})
