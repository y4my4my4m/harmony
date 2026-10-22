// Journey: leaving User settings returns to the app, and Back walks it like a phone's
// settings app.
// - In a tab that opened on Settings, ✕ and Escape land on chat, not on the page the tab
//   showed before Harmony.
// - On a phone the section list is the Settings page. A section picked from it is its own
//   history entry: Back returns to the list, Back from the list leaves Settings, and ✕ from
//   a section leaves Settings in one step.

import { test, expect, devices, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let me: SpecUser
let server: SeededServer
const MARKER = 'settings history marker'

test.beforeAll(async () => {
  me = await createUser(admin, 'shist')
  server = await seedServer(admin, me, `History ${me.username}`)
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: me.id,
    content: [{ type: 'text', text: MARKER }],
  })
  if (error) throw new Error(`message: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, me)
})

const settingsNav = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' })

test('a tab opened on Settings closes to chat with ✕ and with Escape', async ({ page, context }) => {
  test.setTimeout(120_000)
  await signIn(page, me)

  const tab = await context.newPage()
  try {
    await test.step('✕', async () => {
      await tab.goto('/settings/notifications')
      await expect(settingsNav(tab)).toBeVisible({ timeout: 30000 })
      await tab.getByRole('button', { name: 'Close settings' }).click()
      await tab.waitForURL(/\/chat(\/|$)/, { timeout: 15000 })
      await expect(messageList(tab)).toBeVisible({ timeout: 30000 })
    })

    await test.step('Escape', async () => {
      await tab.goto('/settings/appearance')
      await expect(settingsNav(tab)).toBeVisible({ timeout: 30000 })
      await tab.locator('body').click({ position: { x: 5, y: 5 } })
      await tab.keyboard.press('Escape')
      await tab.waitForURL(/\/chat(\/|$)/, { timeout: 15000 })
      await expect(messageList(tab)).toBeVisible({ timeout: 30000 })
    })
  } finally {
    await tab.close()
  }
})

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  async function backAndSettle(page: Page) {
    await page.goBack()
    await page.waitForTimeout(400)
  }

  test('Back from a section returns to the list; Back from the list and ✕ from a section leave Settings', async ({ page }) => {
    test.setTimeout(180_000)
    const chatUrl = new RegExp(`/chat/${server.id}/${server.generalChannelId}$`)
    const sidebar = page.locator('#user-settings-sidebar')
    const toggle = page.locator('.mobile-nav').getByRole('button', { name: 'Settings sections' })
    const title = page.getByRole('heading', { level: 1 })

    await signIn(page, me)
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    await expect(messageList(page).getByText(MARKER)).toBeVisible({ timeout: 30000 })

    const openSettings = async () => {
      await page.getByRole('button', { name: 'Navigation menu' }).first().tap()
      await page.locator('.user-profile-section .avatar-wrapper').tap()
      await page.locator('.mobile-profile-overlay [data-action="settings"]').tap()
      await expect(page).toHaveURL(/\/settings$/)
      await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 15000 })
      await expect(title).toHaveText('User settings')
    }

    const pick = async (label: string) => {
      await sidebar.getByRole('button', { name: label }).tap()
      await expect(title).toHaveText(label)
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    }

    await test.step('the gear opens the section list', openSettings)

    await test.step('Back from a section returns to the list, focus on the current section', async () => {
      await pick('Appearance')
      await expect(page).toHaveURL(/\/settings\/appearance$/)
      await backAndSettle(page)
      await expect(page).toHaveURL(/\/settings$/)
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(title).toHaveText('User settings')
      await expect(sidebar).not.toHaveAttribute('inert', '')
      await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#user-settings-sidebar'))).toBe(true)
    })

    await test.step('a second section, the same way back', async () => {
      await pick('Notifications')
      await backAndSettle(page)
      await expect(page).toHaveURL(/\/settings$/)
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    })

    await test.step('Back from the list leaves Settings', async () => {
      await backAndSettle(page)
      await expect(page).toHaveURL(chatUrl)
      await expect(messageList(page).getByText(MARKER)).toBeVisible({ timeout: 30000 })
    })

    await test.step('✕ from a section leaves Settings in one step', async () => {
      await openSettings()
      await pick('Keybindings')
      await page.locator('.mobile-nav').getByRole('button', { name: 'Close settings' }).tap()
      await expect(page).toHaveURL(chatUrl)
      await expect(messageList(page).getByText(MARKER)).toBeVisible({ timeout: 30000 })
    })
  })
})
