// Journey: the app's confirm dialog (here Clear all in the notification panel) lays its
// buttons out as the other dialogs do. On a desktop both sit at the right of the footer,
// the confirm last. On a phone they stack full width across the footer, the confirm on
// top, as the dialogs whose footer is a column (KickBanModal, design-system .modal-footer).
// The button group was a flex item of the footer row at its content width, so on a phone
// the stack was as narrow as its widest label and stood at the right edge.
//
// Each test has its own reader, follower and server: the follow is the notification that
// enables Clear all. The dialog is measured once its enter transition has ended, in one
// frame (settledBoxes).

import { test, expect, devices, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let reader: SpecUser
let follower: SpecUser
let server: SeededServer

test.beforeEach(async () => {
  reader = await createUser(admin, 'cfmph')
  server = await seedServer(admin, reader, `Confirm ${reader.username.slice(-6)}`)
  follower = await createUser(admin, 'cfmpf')
  const client = await userClient(follower)
  const { error } = await client.from('follows').insert({ follower_id: follower.id, following_id: reader.id, status: 'accepted' })
  if (error) throw new Error(`follow: ${error.message}`)
})

test.afterEach(async () => {
  await deleteUser(admin, follower)
  await deleteUser(admin, reader)
})

const confirmDialog = (page: Page) =>
  page.locator('.modal-container').filter({ hasText: "Clear all notifications? This can't be undone." })

type Box = { x: number; y: number; width: number; height: number }

/**
 * Footer and button boxes of the open dialog. UnifiedModal enters through a Vue <Transition>:
 * the dialog starts at translateY(32px) scale(0.95) and the overlay fades in; the enter
 * classes stay on the overlay until the fade ends. Boxes read one by one across that change
 * mix the two states (a scaled footer around an unscaled button: 9.25px off at 412px).
 */
async function settledBoxes(page: Page, dialog: Locator): Promise<{ footer: Box; confirm: Box; cancel: Box }> {
  await expect(dialog).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.modal-overlay').filter({ has: dialog })).not.toHaveClass(/modal-enter/, { timeout: 5000 })
  return dialog.evaluate((el) => {
    const box = (node: Element | null | undefined): Box => {
      if (!node) throw new Error('dialog part missing')
      const r = node.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    const button = (label: string) =>
      [...el.querySelectorAll('.modal-footer button')].find((b) => b.textContent?.trim() === label)
    return { footer: box(el.querySelector('.modal-footer')), confirm: box(button('Clear all')), cancel: box(button('Cancel')) }
  })
}

test('on a desktop the buttons sit at the right of the footer, confirm last', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await page.locator('[data-testid="notification-bell"]').click()
  await page.locator('[data-testid="notification-clear-all"]').click()
  const { footer, confirm, cancel } = await settledBoxes(page, confirmDialog(page))
  expect(Math.abs(confirm.y - cancel.y)).toBeLessThan(2)
  expect(cancel.x + cancel.width).toBeLessThan(confirm.x)
  // The footer's right padding is 32px (--space-8).
  expect(Math.abs(footer.x + footer.width - 32 - (confirm.x + confirm.width))).toBeLessThan(2)
  expect(cancel.x - footer.x).toBeGreaterThan(footer.width / 3)
})

test.describe('phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('on a phone the buttons stack full width, confirm on top', async ({ page }) => {
    test.setTimeout(120_000)
    await signIn(page, reader)
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    await page.getByRole('button', { name: 'Navigation menu' }).first().tap()
    await expect(page.locator('.base-layout')).toHaveClass(/sidebar-open/)
    // The phone's user panel opens from its avatar at the foot of the server rail.
    await page.locator('[data-region="rail"] .avatar-wrapper').tap()
    const bell = page.locator('[data-testid="notification-bell"]').first()
    await expect(bell).toBeVisible({ timeout: 10000 })
    await bell.tap()
    await page.locator('[data-testid="notification-clear-all"]').tap()

    const { footer, confirm, cancel } = await settledBoxes(page, confirmDialog(page))
    expect(confirm.y + confirm.height).toBeLessThanOrEqual(cancel.y + 1)
    for (const button of [confirm, cancel]) {
      // The footer's side padding on a phone is 24px each (--space-6).
      expect(Math.abs(button.width - (footer.width - 2 * 24))).toBeLessThan(2)
      expect(Math.abs(button.x - (footer.x + 24))).toBeLessThan(2)
    }
  })
})
