// Journey: Flux's horizontal layout (server dock and user capsule across the top, the
// channel strip under them) can sit at the bottom of the window instead: Appearance →
// Skins → Flux → "Bar at the bottom". With it on, at 1280px, the dock and the capsule run
// along the bottom edge, the channel strip sits on them and the composer above the strip.
// What opens from the bar opens upward: the status menu, the server menu, a dock tooltip.
// The option needs the horizontal layout: with that off it is disabled. Skins without the
// bar do not offer it.

import { test, expect, type Locator, type Page } from '@playwright/test'
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
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'fxbot')
  server = await seedServer(admin, user, `Flux ${user.username.slice(-6)}`)
  await admin.from('messages').insert({ channel_id: server.generalChannelId, user_id: user.id, content: [{ type: 'text', text: 'hello from the top' }] })
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

const rect = async (locator: Locator) => {
  const b = await locator.boundingBox()
  expect(b).toBeTruthy()
  return b!
}

/** The menu is what a pointer at its centre hits: nothing paints over it. */
const expectOnTop = async (menu: Locator) => {
  await expect.poll(() => menu.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  })).toBe(true)
}

const skinCard = (page: Page, name: string) =>
  page.locator('.skin-card').filter({ has: page.locator('.skin-card-name', { hasText: new RegExp(`^\\s*${name}\\b`) }) })
const optionRow = (page: Page, id: string) => page.locator(`[data-skin-option="${id}"]`)

test('Flux puts its bar at the bottom of the window, menus opening upward', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)

  await test.step('Appearance offers the option under Flux only, disabled without the horizontal layout', async () => {
    await page.goto('/settings/appearance')
    await dismissAnnouncements(page)
    await skinCard(page, 'Skyglass').click()
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'skyglass')
    await expect(optionRow(page, 'dock-bottom')).toHaveCount(0)

    await skinCard(page, 'Flux').click()
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'flux')
    const bottom = optionRow(page, 'dock-bottom').getByRole('switch', { name: 'Bar at the bottom' })
    await expect(bottom).toHaveAttribute('aria-checked', 'false')
    const dock = optionRow(page, 'dock').getByRole('switch')
    await dock.click()
    await expect(dock).toHaveAttribute('aria-checked', 'false')
    await expect(bottom).toHaveAttribute('aria-disabled', 'true')
    // A disabled switch stays focusable; a click on it changes nothing.
    await bottom.click({ force: true })
    await expect(bottom).toHaveAttribute('aria-checked', 'false')
    await dock.click()
    await expect(bottom).not.toHaveAttribute('aria-disabled', 'true')
    await bottom.click()
    await expect(bottom).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-skin-dock-bottom', 'on')
    await saveAppearance(page)
  })

  const rail = page.locator('[data-region="rail"]')
  const strip = page.locator('[data-region="nav"]')
  const capsule = page.locator('[data-region="user"]')
  const prompt = page.locator('[data-region="composer"]')

  await test.step('after a reload the dock and capsule are on the bottom edge, the strip over them, the composer over the strip', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 30000 })
    await expect(page.locator('html')).toHaveAttribute('data-skin-dock-bottom', 'on')
    const view = page.viewportSize()!
    const r = await rect(rail)
    const s = await rect(strip)
    const c = await rect(capsule)
    const p = await rect(prompt)
    expect(view.height - (r.y + r.height)).toBeLessThan(24)
    expect(view.height - (c.y + c.height)).toBeLessThan(24)
    expect(s.y + s.height).toBeLessThanOrEqual(r.y)
    expect(p.y + p.height).toBeLessThanOrEqual(s.y)
    expect(r.y).toBeGreaterThan(view.height / 2)
    await expect(page.locator('.message-item').filter({ hasText: 'hello from the top' })).toBeVisible()
  })

  await test.step('the status menu opens above the capsule', async () => {
    await capsule.locator('.user-status-container').click()
    const menu = capsule.locator('.status-dropdown')
    await expect(menu).toBeVisible()
    const m = await rect(menu)
    const c = await rect(capsule.locator('.user-profile'))
    expect(m.y + m.height).toBeLessThanOrEqual(c.y + 1)
    expect(m.y).toBeGreaterThanOrEqual(0)
    await expectOnTop(menu)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
  })

  await test.step('the server menu opens above the channel strip', async () => {
    await strip.locator('.server-header .server-name').click()
    const menu = strip.locator('.server-dropdown')
    await expect(menu).toBeVisible()
    const m = await rect(menu)
    const s = await rect(strip)
    expect(m.y + m.height).toBeLessThanOrEqual(s.y + 1)
    expect(m.y).toBeGreaterThanOrEqual(0)
    await expectOnTop(menu)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
  })

  await test.step('a channel tab’s context menu opens upward from the pointer, inside the window', async () => {
    const tab = strip.locator('.channel-item').first()
    const t = await rect(tab)
    const at = { x: t.x + t.width / 2, y: t.y + t.height / 2 }
    await page.mouse.click(at.x, at.y, { button: 'right' })
    const menu = page.getByRole('menu').first()
    await expect(menu).toBeVisible()
    await page.waitForTimeout(300)
    const m = await rect(menu)
    expect(m.y + m.height).toBeLessThanOrEqual(at.y + 1)
    expect(m.y).toBeGreaterThanOrEqual(0)
    await expectOnTop(menu)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
  })

  await test.step('a dock tooltip shows above its icon', async () => {
    const icon = rail.locator('.rail-entry').first()
    await icon.hover()
    const tip = page.locator('.sidebar-tooltip').first()
    await expect(tip).toBeVisible({ timeout: 5000 })
    const t = await rect(tip)
    const i = await rect(icon)
    expect(t.y + t.height).toBeLessThanOrEqual(i.y + 1)
  })

  await test.step('with the option off the bar is back at the top', async () => {
    await page.goto('/settings/appearance')
    const bottom = optionRow(page, 'dock-bottom').getByRole('switch', { name: 'Bar at the bottom' })
    await bottom.click()
    await expect(page.locator('html')).toHaveAttribute('data-skin-dock-bottom', 'off')
    await saveAppearance(page)
    await openChannel(page, server.id, server.generalChannelId)
    const r = await rect(rail)
    expect(r.y).toBeLessThan(40)
    await strip.locator('.server-header .server-name').click()
    const menu = strip.locator('.server-dropdown')
    await expect(menu).toBeVisible()
    expect((await rect(menu)).y).toBeGreaterThanOrEqual((await rect(strip)).y)
    await expectOnTop(menu)
  })
})
