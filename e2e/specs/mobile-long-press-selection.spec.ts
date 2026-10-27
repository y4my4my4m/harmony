// Journey: on a phone a long press on a message opens the action bar and starts no text
// selection, as Discord's long press opens its action sheet: the system selection handles
// and copy menu would land on the bar. Message text is not selectable in the phone layout
// (a triple tap's worth of mouse selection selects nothing); Copy text is in the bar's More
// menu. The inline editor of an edited message stays selectable, and on a desktop message
// text still selects.
//
// Headless Chromium's touch emulation starts no selection on a long press, so the
// selection is attempted with the mouse: text that cannot be selected by mouse cannot be
// by touch either.

import { test, expect, devices, type Page } from '@playwright/test'
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
const TEXT = 'hold this sentence down to act on it'

test.beforeAll(async () => {
  user = await createUser(admin, 'lpsel')
  server = await seedServer(admin, user, `Hold ${user.username.slice(-6)}`)
  const { error } = await admin
    .from('messages')
    .insert({ channel_id: server.generalChannelId, user_id: user.id, content: [{ type: 'text', text: TEXT }] })
  if (error) throw new Error(`message: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const row = (page: Page) => page.locator('[data-testid="message-list"] .message-item').filter({ hasText: TEXT })
const words = (page: Page) => row(page).getByText(TEXT)
const selection = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? '')

async function tripleClickText(page: Page) {
  const b = (await words(page).boundingBox())!
  await page.mouse.click(b.x + 20, b.y + b.height / 2, { clickCount: 3 })
}

test.describe('phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('a long press opens the action bar and no text selection', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, user)
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    await expect(row(page)).toBeVisible({ timeout: 30000 })

    await test.step('message text is not selectable', async () => {
      await expect(words(page)).toHaveCSS('user-select', 'none')
      await tripleClickText(page)
      expect(await selection(page)).toBe('')
    })

    const bar = page.getByRole('group', { name: 'Message actions' })
    await test.step('a long press opens the bar with nothing selected', async () => {
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
      const b = (await words(page).boundingBox())!
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.synthesizeTapGesture', { x: b.x + 30, y: b.y + b.height / 2, duration: 900, tapCount: 1, gestureSourceType: 'touch' })
      await expect(bar).toBeVisible({ timeout: 5000 })
      expect(await selection(page)).toBe('')
    })

    await test.step('Copy text is in the bar’s More menu', async () => {
      await bar.getByTestId('msg-action-more').tap()
      await expect(page.getByRole('menuitem', { name: 'Copy text' })).toBeVisible({ timeout: 5000 })
      await page.keyboard.press('Escape')
    })

    await test.step('the inline editor of an edited message stays selectable', async () => {
      const b = (await words(page).boundingBox())!
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.synthesizeTapGesture', { x: b.x + 30, y: b.y + b.height / 2, duration: 900, tapCount: 1, gestureSourceType: 'touch' })
      await expect(bar).toBeVisible({ timeout: 5000 })
      await bar.getByTestId('msg-action-edit').tap()
      const editor = row(page).locator('.rich-text-editor')
      await expect(editor).toBeVisible({ timeout: 5000 })
      await expect(editor).toHaveCSS('user-select', 'text')
    })
  })
})

test('on a desktop message text still selects', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await expect(row(page)).toBeVisible({ timeout: 30000 })
  await expect(words(page)).toHaveCSS('user-select', 'text')
  await tripleClickText(page)
  expect(await selection(page)).toContain('hold this sentence')
})
