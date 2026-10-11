// Journey: the user and server settings views with a keyboard and a screen reader.
//
// One h1 per view; section navigation is a named <nav> whose current item has
// aria-current="page"; choosing a section moves focus to that section's h2.
// Under the full-screen user settings the server rail and the user panel are
// inert. On a phone the section list is a drawer: inert while closed, modal
// while open, Escape closes it without leaving settings. Escape on server
// settings with unsaved edits asks before discarding them. axe runs on every
// user and server settings section.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'
import { animationsSettled, tabTo } from './a11y-keyboard'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'a11yset')
  // Server names cap at 28 characters in the editor; a longer seeded name takes no typing.
  server = await seedServer(admin, owner, `Hub ${owner.username.slice(-8)}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

const focusedHeading = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement
    return el && /^H[1-6]$/.test(el.tagName) ? `${el.tagName}:${el.textContent?.trim()}` : null
  })

/** Landmarks in Chrome's accessibility tree that are not ignored, as "role:name". */
async function exposedLandmarks(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page)
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
    nodes: Array<{ ignored: boolean; role?: { value: string }; name?: { value: string } }>
  }
  await cdp.detach()
  return nodes
    .filter((n) => !n.ignored && n.role && ['navigation', 'complementary', 'main', 'region'].includes(n.role.value))
    .map((n) => `${n.role!.value}:${n.name?.value ?? ''}`)
}

async function openUserSettings(page: Page, section = 'account') {
  await page.goto(`/settings/${section}`)
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible({ timeout: 30000 })
}

test('user settings: h1, named nav with aria-current, focus moves to the section heading', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openUserSettings(page)
  const nav = page.getByRole('navigation', { name: 'Settings sections' })

  await test.step('one h1 names the view', async () => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('User settings')
  })

  await test.step('the current section is marked in the nav', async () => {
    await expect(nav.getByRole('button', { name: 'My account' })).toHaveAttribute('aria-current', 'page')
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
  })

  await test.step('Enter on a section focuses its h2 and moves aria-current', async () => {
    const appearance = nav.getByRole('button', { name: 'Appearance' })
    await tabTo(page, appearance)
    await page.keyboard.press('Enter')
    await expect.poll(() => focusedHeading(page)).toBe('H2:Appearance')
    await expect(appearance).toHaveAttribute('aria-current', 'page')
    await expect(nav.getByRole('button', { name: 'My account' })).not.toHaveAttribute('aria-current', 'page')
    await expect(page).toHaveURL(/\/settings\/appearance/)

    await tabTo(page, nav.getByRole('button', { name: 'Notifications' }), { backwards: true, max: 60 })
    await page.keyboard.press('Enter')
    await expect.poll(() => focusedHeading(page)).toMatch(/^H2:Notification/)
  })

  await test.step('the server rail and the user panel are out of reach behind the full-screen view', async () => {
    await expect(page.locator('#app-server-rail')).toHaveAttribute('inert', '')
    await expect(page.locator('[data-region="user"]')).toHaveAttribute('inert', '')
    expect(await exposedLandmarks(page)).not.toContain('navigation:Servers')
    expect(await exposedLandmarks(page)).toContain('navigation:Settings sections')
  })

  await test.step('leaving settings gives the rail back', async () => {
    await page.keyboard.press('Escape')
    await page.waitForURL((url) => !url.pathname.startsWith('/settings'), { timeout: 15000 })
    await expect(page.locator('#app-server-rail')).not.toHaveAttribute('inert', '')
  })
})

test('user settings on a phone: the section drawer is inert when closed and modal when open', async ({ browser }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await signIn(page, owner)
  await page.goto('/settings')
  const sidebar = page.locator('#user-settings-sidebar')
  const toggle = page.locator('.mobile-nav').getByRole('button', { name: 'Settings sections' })

  await test.step('entering settings opens the drawer with focus on the current section', async () => {
    await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 30000 })
    await expect(toggle).toHaveAttribute('aria-controls', 'user-settings-sidebar')
    await expect(sidebar).not.toHaveAttribute('inert', '')
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#user-settings-sidebar'))).toBe(true)
    expect(await page.locator('.settings-main').evaluate((el) => !!el.closest('[inert]'))).toBe(true)
  })

  await test.step('Escape closes the drawer, not settings', async () => {
    await page.keyboard.press('Escape')
    await expect(sidebar).toHaveAttribute('inert', '')
    await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page).toHaveURL(/\/settings/)
  })

  await test.step('the toggle reopens it; picking a section closes it and focuses the heading', async () => {
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const privacy = sidebar.getByRole('button', { name: 'Privacy & safety' })
    await privacy.focus()
    await page.keyboard.press('Enter')
    await expect(sidebar).toHaveAttribute('inert', '')
    await expect.poll(() => focusedHeading(page)).toMatch(/^H2:/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy & safety')
  })

  await context.close()
})

test('server settings: nav focus, and Escape with unsaved edits asks before discarding', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}`)
  const nav = page.getByRole('navigation', { name: 'Settings sections' })
  await expect(nav).toBeVisible({ timeout: 30000 })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Server settings')
  await expect(nav.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')

  await test.step('Enter on a section focuses its heading', async () => {
    const roles = nav.getByRole('button', { name: 'Roles' })
    await tabTo(page, roles)
    await page.keyboard.press('Enter')
    await expect.poll(() => focusedHeading(page)).toMatch(/^H2:Roles/)
    await expect(roles).toHaveAttribute('aria-current', 'page')
    await nav.getByRole('button', { name: 'Overview' }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => focusedHeading(page)).toMatch(/^H2:/)
  })

  const name = page.getByRole('textbox', { name: /server name/i })
  const prompt = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })

  await test.step('Escape with an unsaved name opens a confirmation instead of leaving', async () => {
    await name.focus()
    await page.keyboard.press('End')
    await page.keyboard.type(' renamed')
    await page.keyboard.press('Escape')
    await expect(prompt).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/server/${server.id}`))
  })

  await test.step('Escape in the confirmation keeps the edit and the view', async () => {
    await page.keyboard.press('Escape')
    await expect(prompt).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/server/${server.id}`))
    await expect(name).toHaveValue(/ renamed$/)
  })

  await test.step('confirming discards and returns to the server', async () => {
    await name.focus()
    await page.keyboard.press('Escape')
    await expect(prompt).toBeVisible()
    await prompt.getByRole('button', { name: 'Discard changes' }).click()
    await page.waitForURL(new RegExp(`/chat/${server.id}`), { timeout: 15000 })
  })
})

test('axe: every user settings section', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page, owner)
  await openUserSettings(page)
  const nav = page.getByRole('navigation', { name: 'Settings sections' })
  const sections = await nav.locator('.nav-list button').allTextContents()
  expect(sections.length).toBeGreaterThan(8)
  for (const label of sections.map((s) => s.trim())) {
    await nav.getByRole('button', { name: label, exact: false }).first().click()
    await expect.poll(() => focusedHeading(page), { timeout: 20000 }).toMatch(/^H2:/)
    await page.waitForTimeout(500)
    // VoiceSettingsInline belongs to the voice area; the rest of the page is checked.
    await animationsSettled(page)
    await expectNoAxeViolations(page, { label: `user settings › ${label}`, exclude: ['.voice-settings-inline'] })
  }
})

test('axe: every server settings section', async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}`)
  const nav = page.getByRole('navigation', { name: 'Settings sections' })
  await expect(nav).toBeVisible({ timeout: 30000 })
  const sections = await nav.locator('.nav-list button').allTextContents()
  expect(sections.length).toBeGreaterThan(8)
  for (const label of sections.map((s) => s.trim())) {
    await nav.getByRole('button', { name: label, exact: true }).click()
    await expect.poll(() => focusedHeading(page), { timeout: 20000 }).toMatch(/^H2:/)
    await page.waitForTimeout(500)
    await animationsSettled(page)
    await expectNoAxeViolations(page, { label: `server settings › ${label}` })
  }
})
