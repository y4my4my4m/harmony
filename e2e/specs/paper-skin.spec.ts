// Journey: Appearance → Skins → Paper, saved. The skin survives a reload: <html> carries
// data-skin="paper" with its option attributes, the desk is newsprint paper, the chat is a
// window with a 2px ink frame on a 6px ink offset, the composer is a framed card on a 3px
// offset, and the bundled display and mono faces load. Create Channel opens as a window: a
// striped title strip over a 2px frame rule, solid while focus is inside, with a working
// close box in the strip. Ink shadows off drops every offset and keeps the frames; Glyph
// wallpaper on paints its static asset behind the messages.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  openCreateChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const PAPER = 'rgb(243, 238, 227)'
const INK = 'rgb(26, 23, 18)'

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'paper')
  server = await seedServer(admin, user, `Paper ${user.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

// The profile write is debounced by a second; a page load before it lands would read the
// previous appearance_settings back from the profile.
async function saveAppearance(page: Page) {
  const bar = page.locator('[data-testid="appearance-save-bar"]')
  await expect(bar).toBeVisible({ timeout: 10000 })
  const stored = page.waitForResponse(
    (r) => r.url().includes('/rest/v1/profiles') && r.request().method() === 'PATCH' && r.ok(),
    { timeout: 15000 },
  )
  await bar.getByRole('button', { name: 'Save changes' }).click()
  await expect(bar).toBeHidden({ timeout: 15000 })
  await stored
}

async function toggleOption(page: Page, label: string, to: 'on' | 'off', attr: string) {
  await page.goto('/settings/appearance')
  await dismissAnnouncements(page)
  const toggle = page.getByRole('switch', { name: label })
  await expect(toggle).toHaveAttribute('aria-checked', to === 'on' ? 'false' : 'true', { timeout: 30000 })
  await toggle.click()
  await expect(page.locator('html')).toHaveAttribute(`data-skin-${attr}`, to)
  await saveAppearance(page)
}

const chatWindow = (page: Page) => page.locator('[data-region="main"]')
const composerCard = (page: Page) => page.locator('[data-region="composer"] .message-container')

/** Computed background-image and height of an element's ::before. */
const stripOf = (el: Element) => {
  const s = getComputedStyle(el, '::before')
  return { image: s.backgroundImage, height: s.height, rule: s.borderBottomWidth }
}

test('the Paper skin applies, persists and draws ink windows, title strips and offsets', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)

  await test.step('pick Paper in Appearance and save', async () => {
    await page.goto('/settings/appearance')
    await dismissAnnouncements(page)
    const card = page.locator('.skin-card').filter({ has: page.locator('.skin-card-name', { hasText: /^\s*Paper\b/ }) })
    await expect(card).toBeVisible({ timeout: 30000 })
    await card.click()
    await expect(card).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'paper')
    await saveAppearance(page)
  })

  await test.step('after a reload the chat is a framed window on the desk', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 30000 })

    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-skin', 'paper')
    await expect(html).toHaveAttribute('data-theme-type', 'light')
    for (const option of ['shadows', 'jelly', 'grain']) {
      await expect(html).toHaveAttribute(`data-skin-${option}`, 'on')
    }
    await expect(html).toHaveAttribute('data-skin-glyphs', 'off')
    await expect(page.locator('#harmony-skin-styles')).toHaveCount(1)

    await expect(page.locator('body')).toHaveCSS('background-color', PAPER)
    await expect(chatWindow(page)).toHaveCSS('border-top-width', '2px')
    await expect(chatWindow(page)).toHaveCSS('border-top-color', INK)
    await expect(chatWindow(page)).toHaveCSS('box-shadow', `${INK} 6px 6px 0px 0px`)

    // A focused composer trades its ink offset for a blue one.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const card = composerCard(page)
    await expect(card).toHaveCSS('border-top-width', '2px')
    await expect(card).toHaveCSS('border-top-color', INK)
    await expect(card).toHaveCSS('box-shadow', `${INK} 3px 3px 0px 0px`)

    const faces = await page.evaluate(async () => [
      (await document.fonts.load('800 20px "Bricolage Grotesque"')).length,
      (await document.fonts.load('500 11px "Martian Mono"')).length,
    ])
    expect(faces[0]).toBeGreaterThan(0)
    expect(faces[1]).toBeGreaterThan(0)
  })

  await test.step('Create Channel opens as a window with a striped strip and a close box in it', async () => {
    const modal = await openCreateChannel(page)
    await expect(modal).toHaveCSS('border-top-color', INK)
    await expect(modal).toHaveCSS('box-shadow', `${INK} 8px 8px 0px 0px`)

    // Focus is inside the dialog: the stripes print in full ink.
    await expect.poll(async () => (await modal.evaluate(stripOf)).image).toContain(INK)
    const strip = await modal.evaluate(stripOf)
    expect(strip).toMatchObject({ height: '32px', rule: '2px' })
    expect(strip.image).toContain('repeating-linear-gradient')

    const close = modal.locator('.modal-header > .close-button')
    const [frame, box] = await Promise.all([modal.boundingBox(), close.boundingBox()])
    expect(frame && box).toBeTruthy()
    expect(box!.y - frame!.y).toBeLessThan(32)
    expect(box!.y + box!.height - frame!.y).toBeLessThanOrEqual(34)
    await close.click()
    await expect(modal).toBeHidden({ timeout: 10000 })
  })

  await test.step('Ink shadows off keeps the frames and drops the offsets', async () => {
    await toggleOption(page, 'Ink shadows', 'off', 'shadows')
    await openChannel(page, server.id, server.generalChannelId)
    await expect(chatWindow(page)).toHaveCSS('border-top-color', INK)
    await expect(chatWindow(page)).toHaveCSS('box-shadow', 'none')
    const card = composerCard(page)
    await expect(card).toHaveCSS('border-top-color', INK)
    await expect(card).toHaveCSS('box-shadow', 'none')
  })

  await test.step('Glyph wallpaper on paints the static asset behind the messages', async () => {
    const asset = page.waitForResponse((r) => r.url().endsWith('/assets/skins/paper/glyphs.svg') && r.ok(), { timeout: 30000 })
    await toggleOption(page, 'Glyph wallpaper', 'on', 'glyphs')
    await openChannel(page, server.id, server.generalChannelId)
    await expect(page.locator('[data-region="messages"]')).toHaveCSS('background-image', /\/assets\/skins\/paper\/glyphs\.svg/)
    await asset
  })
})
