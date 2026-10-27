// Journey: hovering an emoji in the composer's picker or the reaction picker grows its glyph
// inside its own 36px cell and shows it large, with its name, in the bar under the grid. No
// cell, neighbour or the bar moves, and the pointer keeps hitting the emoji under it. A phone
// has no hover: nothing grows there. The composer's mic, GIF and emoji buttons share one box,
// glyph size and colour.

import { test, expect, devices, type Locator, type Page } from '@playwright/test'
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

const admin = adminClient()
let user: SpecUser
let server: SeededServer
const TEXT = 'react to this one'

test.beforeAll(async () => {
  user = await createUser(admin, 'emjpv')
  server = await seedServer(admin, user, `Preview ${user.username.slice(-6)}`)
  const { error } = await admin
    .from('messages')
    .insert({ channel_id: server.generalChannelId, user_id: user.id, content: [{ type: 'text', text: TEXT }] })
  if (error) throw new Error(`message: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

type Box = { x: number; y: number; width: number; height: number }

const box = (l: Locator): Promise<Box> =>
  l.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })

/** Every running transition and animation has ended. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 5000 })
}

function expectSameBox(a: Box, b: Box): void {
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(a[k] - b[k])).toBeLessThan(0.5)
}

const composer = (page: Page) => page.locator('[data-testid="message-input"]')

async function searchGrid(picker: Locator): Promise<Locator> {
  await picker.getByRole('textbox', { name: 'Search emoji' }).fill('grinning')
  const items = picker.locator('.emoji-item')
  await expect(items.nth(1)).toBeVisible({ timeout: 10000 })
  return items
}

/** The hovered cell grows its glyph in place and the bar previews it; nothing else moves. */
async function expectHoverPreview(page: Page, picker: Locator): Promise<void> {
  const items = await searchGrid(picker)
  const first = items.nth(0)
  const second = items.nth(1)
  const bar = picker.getByTestId('emoji-preview-bar')
  await settled(page)
  const before = { first: await box(first), second: await box(second), bar: await box(bar), glyph: await box(first.locator('> *').first()) }
  expect(before.bar.height).toBeCloseTo(48, 0)

  await first.hover()
  await settled(page)
  const preview = bar.getByTestId('emoji-preview-glyph')
  await expect(preview).toBeVisible()
  await expect(bar).toContainText(/:grinning[a-z_]*:/)
  const previewBox = await box(preview)
  expect(previewBox.width).toBeCloseTo(32, 0)

  expectSameBox(await box(first), before.first)
  expectSameBox(await box(second), before.second)
  expectSameBox(await box(bar), before.bar)
  const grown = await box(first.locator('> *').first())
  expect(grown.width).toBeGreaterThan(before.glyph.width * 1.2)
  // The grown glyph stays inside its own button.
  expect(grown.x).toBeGreaterThanOrEqual(before.first.x - 0.5)
  expect(grown.x + grown.width).toBeLessThanOrEqual(before.first.x + before.first.width + 0.5)

  // The neighbour's centre still hits the neighbour, so moving there previews it.
  const hit = await second.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.emoji-item') === el
  })
  expect(hit).toBe(true)
  const firstName = await bar.textContent()
  await second.hover()
  await expect(bar).not.toHaveText(firstName ?? '')
  await expect(preview).toBeVisible()

  // Leaving the grid clears the preview.
  await picker.getByRole('textbox', { name: 'Search emoji' }).hover()
  await expect(preview).toBeHidden()
}

test('composer picker: hover grows the emoji in its cell and previews it large', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await composer(page).getByRole('button', { name: 'Emoji picker' }).click()
  const picker = page.getByRole('dialog', { name: 'GIFs, stickers and emoji' })
  await expect(picker).toBeVisible()
  await expectHoverPreview(page, picker)
})

test('reaction picker: the same preview', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  const row = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: TEXT })
  await expect(row).toBeVisible({ timeout: 30000 })
  await row.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Add reaction', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Add reaction' })
  await expect(picker).toBeVisible()
  await expectHoverPreview(page, picker)
})

test('composer: mic, GIF and emoji share one box, glyph size and colour', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  const mic = composer(page).getByRole('button', { name: 'Record voice message' })
  const gif = composer(page).getByTestId('composer-gif')
  const emoji = composer(page).getByTestId('composer-emoji')
  await expect(mic).toBeVisible({ timeout: 20000 })

  for (const button of [mic, gif, emoji]) {
    const b = await box(button)
    expect(b.width).toBeCloseTo(32, 0)
    expect(b.height).toBeCloseTo(32, 0)
    const glyph = await box(button.locator('svg, .spriteContainer').first())
    expect(glyph.width).toBeCloseTo(24, 0)
    expect(glyph.height).toBeCloseTo(24, 0)
  }
  // One row: the three centres share a line.
  const centres = await Promise.all([mic, gif, emoji].map(async (b) => { const r = await box(b); return r.y + r.height / 2 }))
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThan(1)

  const colour = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color)
  const rest = await colour(gif)
  expect(await colour(mic)).toBe(rest)
  await gif.hover()
  await settled(page)
  expect(await colour(gif)).not.toBe(rest)
  expect(await gif.locator('svg').evaluate((el) => getComputedStyle(el).transform)).not.toBe('none')
})

test.describe('phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('no hover growth in the picker; 40px composer buttons', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, user)
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)

    const mic = composer(page).getByRole('button', { name: 'Record voice message' })
    const gif = composer(page).getByTestId('composer-gif')
    await expect(mic).toBeVisible({ timeout: 20000 })
    for (const button of [mic, gif]) {
      const b = await box(button)
      expect(b.width).toBeCloseTo(40, 0)
      expect(b.height).toBeCloseTo(40, 0)
      const glyph = await box(button.locator('svg').first())
      expect(glyph.width).toBeCloseTo(24, 0)
    }

    await composer(page).getByTestId('composer-emoji').tap()
    const picker = page.getByRole('dialog', { name: 'GIFs, stickers and emoji' })
    await expect(picker).toBeVisible()
    const items = await searchGrid(picker)
    await settled(page)
    await expect(picker.getByTestId('emoji-preview-bar')).toHaveCSS('height', '36px')
    await items.nth(0).hover()
    await settled(page)
    expect(await items.nth(0).locator('> *').first().evaluate((el) => getComputedStyle(el).transform)).toBe('none')
  })
})
