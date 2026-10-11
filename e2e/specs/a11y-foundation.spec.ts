// Journey: the accessibility foundation of the app shell, as a keyboard and
// screen-reader user meets it.
//
// Skip link and landmarks, F6 region cycling, document.title and the route
// announcement, a modal dialog (focus in, Tab trap, Escape closing only the
// topmost of two, focus back to the opener), named switches in settings, toast
// live-region roles, a closed mobile drawer kept out of reach, and axe on the
// main screens (exclusions: e2e/specs/a11y.ts AXE_EXCLUSIONS).

import { test, expect, type Page } from '@playwright/test'
import {
  addChannel,
  addMember,
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'a11yo')
  member = await createUser(admin, 'a11ym')
  server = await seedServer(admin, owner, `A11y Hub ${owner.username}`)
  await addMember(admin, member, server.id)
  await addChannel(admin, server, 'random')
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Unread notifications prefix the title: "(2) #general – ...".
const UNREAD = '(?:\\(\\d+\\) )?'

/** The landmark (aria-label) or tag holding the focused element. */
async function focusedRegion(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement
    const region = el?.closest('nav, main, aside, header, section[aria-label]')
    if (!region) return null
    return region.getAttribute('aria-label') ?? region.tagName.toLowerCase()
  })
}

async function focusInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel)
    return !!root && !!document.activeElement && root.contains(document.activeElement)
  }, selector)
}

test('skip link, landmarks and F6 region cycling', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('the first Tab stop is a visible skip link that lands in main', async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: 'Skip to content' })
    await expect(skip).toBeFocused()
    await expect(skip).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('main#main-content')).toBeFocused()
  })

  await test.step('the shell exposes named landmarks and one main', async () => {
    await expect(page.getByRole('navigation', { name: 'Servers' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Channels' })).toBeVisible()
    await expect(page.getByRole('main')).toHaveCount(1)
    await expect(page.getByRole('complementary', { name: 'Members' })).toBeVisible()
    await expect(page.getByRole('region', { name: 'Your account' })).toBeVisible()
  })

  await test.step('F6 and Shift+F6 move between regions', async () => {
    await page.keyboard.press('F6')
    expect(await focusedRegion(page)).toBe('Members')
    await page.keyboard.press('F6')
    expect(await focusedRegion(page)).toBe('Your account')
    await page.keyboard.press('F6')
    expect(await focusedRegion(page)).toBe('Servers')
    // The current server, not the region box.
    await expect(page.locator(`[data-rail-kind="server"][data-rail-id="${server.id}"]`)).toBeFocused()
    await page.keyboard.press('Shift+F6')
    expect(await focusedRegion(page)).toBe('Your account')
  })
})

test('route changes set document.title and are announced', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(page).toHaveTitle(new RegExp(`^${UNREAD}#general – ${escapeRe(server.name)} – `), { timeout: 15000 })

  await channelRow(page, 'random').click()
  await expect(page).toHaveTitle(new RegExp(`^${UNREAD}#random – ${escapeRe(server.name)} – `), { timeout: 15000 })
  await expect(page.getByTestId('live-announcer-polite')).toHaveText(`#random – ${server.name}`, { timeout: 5000 })

  await page.locator('[data-region="user"]').getByRole('button', { name: 'Settings' }).click()
  await page.waitForURL(/\/settings/)
  await expect(page).toHaveTitle(new RegExp(`^${UNREAD}User settings – `), { timeout: 15000 })
})

test('modal dialog: focus in, Tab trap, topmost-only Escape, focus back to the opener', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const serverName = page.locator('.channel-sidebar .server-name')
  const invite = page.getByRole('dialog', { name: 'Invite people' })

  await test.step('the invite dialog opens from the keyboard and takes focus', async () => {
    await serverName.focus()
    await page.keyboard.press('Enter')
    const item = page.getByRole('menuitem', { name: 'Get invite link' })
    await item.focus()
    await page.keyboard.press('Enter')
    await expect(invite).toBeVisible({ timeout: 15000 })
    await expect(invite).toHaveAttribute('aria-modal', 'true')
    await expect.poll(() => focusInside(page, '[role="dialog"]')).toBe(true)
  })

  await test.step('Tab and Shift+Tab stay inside the dialog', async () => {
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      expect(await focusInside(page, '[role="dialog"]')).toBe(true)
    }
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Shift+Tab')
      expect(await focusInside(page, '[role="dialog"]')).toBe(true)
    }
  })

  await expectNoAxeViolations(page, { include: '[role="dialog"]', label: 'invite dialog' })

  const search = page.getByRole('dialog', { name: 'Search messages' })

  await test.step('a second dialog opens on top; Escape closes only it', async () => {
    await page.evaluate(() => document.activeElement?.setAttribute('data-test-opener', ''))
    await page.keyboard.press('Control+k')
    await expect(search).toBeVisible({ timeout: 10000 })
    await expect.poll(() => focusInside(page, '.message-search-modal')).toBe(true)
    // The lower dialog is out of reach while the upper one is open.
    expect(await page.locator('[data-test-opener]').evaluate((el) => !!el.closest('[inert]'))).toBe(true)

    await page.keyboard.press('Escape')
    // An open suggestion list in the search field takes the first Escape.
    if (await search.isVisible()) await page.keyboard.press('Escape')
    await expect(search).toBeHidden()
    await expect(invite).toBeVisible()
    await expect(page.locator('[data-test-opener]')).toBeFocused()
  })

  await test.step('Escape closes the invite dialog and focus returns to the server menu button', async () => {
    await page.keyboard.press('Escape')
    await expect(invite).toBeHidden()
    await expect(serverName).toBeFocused()
  })
})

test('settings switches have accessible names', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  for (const section of ['appearance', 'notifications', 'advanced']) {
    await page.goto(`/settings/${section}`)
    const switches = page.getByRole('switch')
    await expect(switches.first()).toBeVisible({ timeout: 20000 })
    const count = await switches.count()
    expect(count).toBeGreaterThan(1)
    for (let i = 0; i < count; i++) {
      await expect(switches.nth(i)).toHaveAccessibleName(/\S/)
    }
    await expectNoAxeViolations(page, {
      rules: ['button-name', 'aria-toggle-field-name', 'label', 'select-name'],
      label: `settings/${section} names`,
    })
  }
})

test('toasts: polite status for success, alert for errors', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const railItem = page.locator(`[data-rail-kind="server"][data-rail-id="${server.id}"]`)

  async function copyServerId() {
    await railItem.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: server.name })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Copy server ID' }).click()
  }

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => {} })
  })
  await copyServerId()
  const ok = page.locator('.Vue-Toastification__toast--success').filter({ hasText: 'Server ID copied' })
  await expect(ok).toBeVisible()
  await expect(ok.getByRole('status')).toHaveText('Server ID copied')
  await expect(ok.getByRole('alert')).toHaveCount(0)

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async () => {
        throw new Error('denied')
      },
    })
  })
  await copyServerId()
  const failed = page.locator('.Vue-Toastification__toast--error').filter({ hasText: "Couldn't copy the server ID" })
  await expect(failed).toBeVisible()
  await expect(failed.getByRole('alert')).toHaveText("Couldn't copy the server ID")
  await expect(failed.getByRole('button', { name: 'Dismiss notification' })).toBeVisible()

  // An open modal never makes the toast host inert.
  expect(await page.evaluate(() => document.querySelector('.Vue-Toastification__container')?.closest('[data-a11y-persistent]') != null)).toBe(true)
})

test('mobile: a closed drawer is inert; the open drawer is modal and Escape returns focus', async ({ browser }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const rail = page.locator('#app-server-rail')
  const channels = page.locator('#app-channel-panel')
  const members = page.locator('#app-member-panel')
  const hamburger = page.locator('.chat-header-container').getByRole('button', { name: 'Navigation menu' })

  await test.step('closed drawers are inert and hidden', async () => {
    for (const panel of [rail, channels, members]) {
      await expect(panel).toHaveAttribute('inert', '')
      await expect(panel).toHaveAttribute('aria-hidden', 'true')
    }
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false')
    await expect(hamburger).toHaveAttribute('aria-controls', /app-server-rail/)
  })

  await test.step('opening moves focus in and makes the page inert', async () => {
    await hamburger.focus()
    await page.keyboard.press('Enter')
    await expect(rail).not.toHaveAttribute('inert', '')
    await expect(channels).not.toHaveAttribute('aria-hidden', 'true')
    await expect.poll(() => page.evaluate(() => {
      const el = document.activeElement
      return !!el && !!(el.closest('#app-server-rail') || el.closest('#app-channel-panel'))
    })).toBe(true)
    expect(await page.locator('#main-content').evaluate((el) => !!el.closest('[inert]'))).toBe(true)
  })

  await test.step('Escape closes and focus returns to the menu button', async () => {
    await page.keyboard.press('Escape')
    await expect(rail).toHaveAttribute('inert', '')
    await expect(hamburger).toBeFocused()
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false')
  })

  await context.close()
})

test('axe: chat and settings screens in light and dark themes', async ({ browser }) => {
  test.setTimeout(180_000)
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme })
    const page = await context.newPage()
    await signIn(page, owner)
    await openChannel(page, server.id, server.generalChannelId)
    await page.waitForTimeout(1500)
    await expectNoAxeViolations(page, { label: `chat (${colorScheme})` })
    await page.goto('/settings/appearance')
    await expect(page.getByRole('switch').first()).toBeVisible({ timeout: 20000 })
    await expectNoAxeViolations(page, { label: `settings/appearance (${colorScheme})` })
    await page.goto('/settings/keybinds')
    await expect(page.getByRole('heading', { name: 'Navigation' })).toBeVisible({ timeout: 20000 })
    await expectNoAxeViolations(page, { label: `settings/keybinds (${colorScheme})` })
    await context.close()
  }
})
