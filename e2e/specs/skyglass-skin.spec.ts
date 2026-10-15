// Journey: Appearance → Skins → Skyglass, saved. After a reload the drawn sky is the page
// backdrop (Painted wallpaper is off by default); the channel column and the main pane form one
// window with a single rounded corner (the main pane has none of its own) and their header bars
// end on the same line; the rail buttons are glass orbs. The composer's emoji picker opens above
// the composer, not offset by the window's blur layer. Drive draws the same window and gel
// buttons. Painted wallpaper on paints the meadow and replaces the drawn sky; the dark theme
// swaps in the aurora lagoon.

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
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'skyglass')
  server = await seedServer(admin, user, `Skyglass ${user.username}`)
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

const bottom = async (page: Page, selector: string) => {
  const box = await page.locator(selector).first().boundingBox()
  expect(box, selector).toBeTruthy()
  return box!.y + box!.height
}

test('Skyglass draws one window corner, aligned headers, glass controls and the optional meadow', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)

  await test.step('pick Skyglass in Appearance and save', async () => {
    await page.goto('/settings/appearance')
    await dismissAnnouncements(page)
    const card = page.locator('.skin-card').filter({ has: page.locator('.skin-card-name', { hasText: /^\s*Skyglass\b/ }) })
    await expect(card).toBeVisible({ timeout: 30000 })
    await card.click()
    await expect(card).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'skyglass')
    await saveAppearance(page)
  })

  await test.step('after a reload the drawn sky is the backdrop and the chat is one window', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 30000 })

    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-skin', 'skyglass')
    await expect(html).toHaveAttribute('data-theme-type', 'light')
    await expect(html).toHaveAttribute('data-skin-wallpaper', 'off')
    await expect(page.locator('body')).not.toHaveCSS('background-image', /\.webp/)
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body, '::before').backgroundImage)).toContain('radial-gradient')

    await expect(page.locator('[data-region="workspace"]')).toHaveCSS('border-top-left-radius', '18px')
    await expect(page.locator('[data-region="nav"]')).toHaveCSS('border-top-left-radius', '18px')
    await expect(page.locator('[data-region="main"]')).toHaveCSS('border-top-left-radius', '0px')
    expect(await bottom(page, '.server-header')).toBeCloseTo(await bottom(page, '.chat-header'), 0)

    await expect(page.locator('.dm-button').first()).toHaveCSS('background-image', /linear-gradient/)
  })

  await test.step('the emoji picker opens above the composer', async () => {
    await composer(page).click()
    await page.locator('[data-region="composer"]').getByRole('button', { name: /emoji/i }).last().click()
    const popup = page.locator('.media-picker-popup').first()
    await expect(popup).toBeVisible({ timeout: 10000 })
    // The popup slides in; its box settles after the transition.
    const bar = await page.locator('[data-region="composer"]').first().boundingBox()
    expect(bar).toBeTruthy()
    await expect.poll(async () => {
      const pop = await popup.boundingBox()
      return pop ? pop.y >= 0 && pop.y + pop.height <= bar!.y + 1 : false
    }, { timeout: 5000 }).toBe(true)
    await page.keyboard.press('Escape')
  })

  await test.step('Drive is the same window with gel buttons', async () => {
    await page.goto('/drive')
    await dismissAnnouncements(page)
    const view = page.locator('.drive-view')
    await expect(view).toBeVisible({ timeout: 30000 })
    await expect(view).toHaveCSS('border-top-left-radius', '18px')
    await expect(page.locator('.drive-view__main')).toHaveCSS('border-top-left-radius', '0px')
    await expect(page.locator('.drive-btn--primary').first()).toHaveCSS('background-image', /radial-gradient.*linear-gradient/)
  })

  await test.step('Painted wallpaper on paints the meadow over the drawn sky', async () => {
    await page.goto('/settings/appearance')
    await dismissAnnouncements(page)
    const meadow = page.waitForResponse((r) => r.url().endsWith('/assets/skins/skyglass/meadow.webp') && r.ok(), { timeout: 30000 })
    const toggle = page.getByRole('switch', { name: 'Painted wallpaper' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 30000 })
    await toggle.click()
    await expect(page.locator('html')).toHaveAttribute('data-skin-wallpaper', 'on')
    await expect(page.locator('body')).toHaveCSS('background-image', /\/assets\/skins\/skyglass\/meadow\.webp/)
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body, '::before').content)).toBe('none')
    await meadow
    await saveAppearance(page)
  })

  await test.step('the dark theme swaps in the lagoon', async () => {
    await page.getByTestId('theme-option-dark').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'dark')
    await expect(page.locator('body')).toHaveCSS('background-image', /\/assets\/skins\/skyglass\/lagoon\.webp/)
    await saveAppearance(page)
  })
})
