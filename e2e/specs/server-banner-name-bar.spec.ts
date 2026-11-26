// Journey: the server name bar over the sidebar banner ("Show the banner above the channel
// list" in Server settings). Over the banner the bar is a black scrim that fades out down to a
// transparent 1px bottom border; its last pixel row continues the banner, with no dark line
// across the art, at rest and on hover, in the dark and light themes, in the phone drawer and
// under a skin that widens the border to 2px. The banner spans the sidebar's width, so the
// art centres under the name. With the banner turned off the list shows no banner and the
// bar is solid with its theme border.
//
// A scrim tiled from the padding box repeats its top row, 0.55 black (0.7 on hover), in the
// border row. The check compares the bar's last pixel row with the row above it, column by
// column, on the rendered screenshot.

import { test, expect, type Browser, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
const users: SpecUser[] = []
let owner: SpecUser
let server: SeededServer
let plain: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'bnbo')
  server = await seedServer(admin, owner, `Banner bar ${owner.username}`)
  plain = await seedServer(admin, owner, `Plain bar ${owner.username}`)
  for (const [id, on] of [[server.id, true], [plain.id, false]] as const) {
    // A bright, full-bleed image: a dark line reads against it at once.
    const { error } = await admin.from('servers').update({ banner: '/backgrounds/404/1.webp', sidebar_banner: on }).eq('id', id)
    if (error) throw new Error(`banner: ${error.message}`)
  }
})

test.afterAll(async () => {
  for (const user of users) await deleteUser(admin, user)
  await deleteUser(admin, owner)
})

interface Viewer {
  theme: 'dark' | 'light'
  skin?: string
  phone?: boolean
}

async function openAs(browser: Browser, serverRow: SeededServer, viewer: Viewer): Promise<Page> {
  const user = await createUser(admin, 'bnbv')
  users.push(user)
  await addMember(admin, user, serverRow.id)
  const appearance: Record<string, unknown> = { theme: viewer.theme, savedAt: 1 }
  if (viewer.skin) appearance.activeSkinId = viewer.skin
  const { error } = await admin.from('profiles').update({ appearance_settings: appearance }).eq('id', user.id)
  if (error) throw new Error(`appearance: ${error.message}`)

  const context = await browser.newContext(viewer.phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await signIn(page, user)
  await page.goto(`/chat/${serverRow.id}/${serverRow.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', viewer.theme, { timeout: 15000 })
  if (viewer.skin) await expect(page.locator('html')).toHaveAttribute('data-skin', viewer.skin, { timeout: 15000 })
  if (viewer.phone) {
    await page.locator('.chat-header-container').getByRole('button', { name: 'Navigation menu' }).click()
    await expect(page.locator('#app-channel-panel')).not.toHaveAttribute('aria-hidden', 'true')
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
    // The pointer stays off the rail, whose tooltips overlap the bar.
    await page.mouse.move(380, 800)
  }
  return page
}

const nameBar = (page: Page) => page.locator('.channel-sidebar .server-name')
const header = (page: Page) => page.locator('.channel-sidebar .server-header')
const banner = (page: Page) => page.getByTestId('server-sidebar-banner')

/**
 * Share of the bar's columns whose last pixel row is darker than 0.8 of the row above.
 * Columns darker than 40 above are skipped: a ratio there says nothing.
 */
async function lineShare(page: Page): Promise<number> {
  const box = (await nameBar(page).boundingBox())!
  const clip = { x: Math.round(box.x), y: Math.round(box.y + box.height) - 2, width: Math.floor(box.width), height: 2 }
  const png = await page.screenshot({ clip })
  return page.evaluate(async (b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    const luma = (x: number, y: number) => {
      const i = (y * width + x) * 4
      return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    }
    let measured = 0
    let dark = 0
    for (let x = 0; x < width; x++) {
      const above = luma(x, height - 2)
      if (above < 40) continue
      measured++
      if (luma(x, height - 1) < above * 0.8) dark++
    }
    return measured === 0 ? 1 : dark / measured
  }, png.toString('base64'))
}

async function expectNoLine(page: Page) {
  await expect(banner(page).locator('img')).toBeVisible({ timeout: 30000 })
  await expect(header(page)).toHaveClass(/over-banner/)
  // Edges in the art darken about 5% of columns; the line darkens nearly all of them.
  await expect.poll(() => lineShare(page), { timeout: 10000 }).toBeLessThan(0.25)
}

async function expectBannerSpansBar(page: Page) {
  const bar = (await nameBar(page).boundingBox())!
  const art = (await banner(page).boundingBox())!
  expect(Math.abs(art.x - bar.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(art.width - bar.width)).toBeLessThanOrEqual(1)
  expect(art.height).toBeGreaterThanOrEqual(112)
}

test('the name bar over the server banner draws no line across it', async ({ browser }) => {
  test.setTimeout(240_000)

  for (const viewer of [
    { theme: 'dark' },
    { theme: 'light' },
    { theme: 'dark', phone: true },
    { theme: 'light', phone: true },
    // Paper draws the bar's bottom border 2px wide.
    { theme: 'dark', skin: 'paper' },
  ] satisfies Viewer[]) {
    const label = `${viewer.theme}${viewer.phone ? ', phone drawer' : ''}${viewer.skin ? `, ${viewer.skin} skin` : ''}`
    const page = await openAs(browser, server, viewer)
    try {
      await test.step(`${label}: no line under the name`, async () => {
        await expectNoLine(page)
      })
      await test.step(`${label}: the banner spans the bar`, async () => {
        await expectBannerSpansBar(page)
      })
      if (!viewer.phone) {
        await test.step(`${label}: none on hover`, async () => {
          await nameBar(page).hover()
          await expectNoLine(page)
        })
      }
    } finally {
      await page.context().close()
    }
  }
})

test('with the banner turned off the name bar is solid with its border', async ({ browser }) => {
  test.setTimeout(120_000)

  for (const theme of ['dark', 'light'] as const) {
    const page = await openAs(browser, plain, { theme })
    try {
      await test.step(`${theme}: no banner, a solid bar`, async () => {
        await expect(page.locator('.channel-sidebar .channel-item').first()).toBeVisible({ timeout: 30000 })
        await expect(banner(page)).toHaveCount(0)
        await expect(header(page)).not.toHaveClass(/has-banner|over-banner/)
        const bar = await nameBar(page).evaluate((el) => {
          const style = getComputedStyle(el)
          const solid = (c: string) => !/rgba\(.*,\s*0\)$/.test(c) && c !== 'transparent'
          return {
            image: style.backgroundImage,
            fill: solid(style.backgroundColor),
            border: style.borderBottomWidth === '1px' && solid(style.borderBottomColor),
            height: el.getBoundingClientRect().height,
          }
        })
        expect(bar).toEqual({ image: 'none', fill: true, border: true, height: 47 })
      })
    } finally {
      await page.context().close()
    }
  }
})
