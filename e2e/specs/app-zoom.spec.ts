// Journey: Appearance → Zoom level at 150% in a browser, where the app zooms with CSS zoom.
// Full-screen views fill the window rather than 1.5 windows: user settings keeps its close
// button and its unsaved-changes bar on screen and scrolls to its last row, and the chat
// keeps its composer on screen. A message's context menu opens at the pointer and the emoji
// picker stays inside the window.

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
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
  user = await createUser(admin, 'zoom')
  server = await seedServer(admin, user, `Zoom ${user.username}`)
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: 'a message to right-click' }],
  })
  if (error) throw new Error(`message: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

async function expectOnScreen(page: Page, locator: Locator) {
  const box = await locator.boundingBox()
  const { width, height } = page.viewportSize()!
  expect(box, 'element has a box').not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5)
  expect(box!.y + box!.height).toBeLessThanOrEqual(height + 0.5)
}

test('at 150% zoom settings, chat and popovers stay inside the window', async ({ page }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)

  await test.step('settings: close button, save bar and last row are reachable', async () => {
    await page.goto('/settings/appearance')
    await dismissAnnouncements(page)
    const zoomIn = page.locator('[data-testid="zoom-in"]')
    await expect(zoomIn).toBeVisible({ timeout: 30000 })
    for (let i = 0; i < 5; i++) await zoomIn.click()
    await expect(page.locator('[data-testid="zoom-value"]')).toHaveText('150%')

    await expectOnScreen(page, page.locator('.settings-close'))
    const save = page.getByRole('button', { name: 'Save changes' })
    await expect(save).toBeVisible()
    await expectOnScreen(page, save)

    const content = page.locator('.settings-content')
    await content.evaluate((el) => { el.scrollTop = el.scrollHeight })
    const atEnd = await content.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1)
    expect(atEnd).toBe(true)
    await expectOnScreen(page, content)

    await save.click()
    await expect(save).toBeHidden({ timeout: 15000 })
  })

  await test.step('chat: the composer is on screen', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await expect(page.locator('html')).toHaveCSS('zoom', '1.5')
    await expectOnScreen(page, composer(page))
  })

  await test.step('a message context menu opens at the pointer', async () => {
    const message = messageList(page).locator('.message-item').filter({ hasText: 'a message to right-click' })
    const box = (await message.boundingBox())!
    const x = Math.round(box.x + 120)
    const y = Math.round(box.y + box.height / 2)
    await page.mouse.click(x, y, { button: 'right' })
    const menu = page.getByRole('menu').first()
    await expect(menu).toBeVisible({ timeout: 10000 })
    await expectOnScreen(page, menu)
    // A menu taller than the room below the pointer is clamped to the window and
    // still spans the pointer's row.
    const m = (await menu.boundingBox())!
    const nearX = Math.min(Math.abs(m.x - x), Math.abs(m.x + m.width - x))
    expect(nearX).toBeLessThanOrEqual(6)
    expect(m.y).toBeLessThanOrEqual(y + 6)
    expect(m.y + m.height).toBeGreaterThanOrEqual(y - 6)
    await page.keyboard.press('Escape')
  })

  await test.step('the emoji picker opens inside the window', async () => {
    await page.locator('[data-testid="message-input"] button[aria-label*="moji" i]').first().click()
    const picker = page.locator('.media-picker-popup').first()
    await expect(picker).toBeVisible({ timeout: 10000 })
    await expectOnScreen(page, picker)
    await page.keyboard.press('Escape')
  })
})
