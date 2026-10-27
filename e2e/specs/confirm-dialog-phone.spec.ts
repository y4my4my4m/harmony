// Journey: the app's confirm dialog (here Clear all in the notification panel) lays its
// buttons out as the other dialogs do. On a desktop both sit at the right of the footer,
// the confirm last. On a phone they stack full width across the footer, the confirm on
// top, as the dialogs whose footer is a column (KickBanModal, design-system .modal-footer).
// The button group was a flex item of the footer row at its content width, so on a phone
// the stack was as narrow as its widest label and stood at the right edge.

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

test.beforeAll(async () => {
  reader = await createUser(admin, 'cfmph')
  server = await seedServer(admin, reader, `Confirm ${reader.username.slice(-6)}`)
  follower = await createUser(admin, 'cfmpf')
  const client = await userClient(follower)
  const { error } = await client.from('follows').insert({ follower_id: follower.id, following_id: reader.id, status: 'accepted' })
  if (error) throw new Error(`follow: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, follower)
  await deleteUser(admin, reader)
})

const confirmDialog = (page: Page) =>
  page.locator('.modal-container').filter({ hasText: "Clear all notifications? This can't be undone." })

async function boxes(dialog: Locator) {
  const footer = (await dialog.locator('.modal-footer').boundingBox())!
  const confirm = (await dialog.getByRole('button', { name: 'Clear all' }).boundingBox())!
  const cancel = (await dialog.getByRole('button', { name: 'Cancel' }).boundingBox())!
  return { footer, confirm, cancel }
}

test('on a desktop the buttons sit at the right of the footer, confirm last', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await page.locator('[data-testid="notification-bell"]').click()
  await page.locator('[data-testid="notification-clear-all"]').click()
  const dialog = confirmDialog(page)
  await expect(dialog).toBeVisible({ timeout: 10000 })
  const { footer, confirm, cancel } = await boxes(dialog)
  expect(Math.abs(confirm.y - cancel.y)).toBeLessThan(2)
  expect(cancel.x + cancel.width).toBeLessThan(confirm.x)
  // The footer's right padding is 32px (--space-8).
  expect(footer.x + footer.width - (confirm.x + confirm.width)).toBeLessThan(40)
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
    const dialog = confirmDialog(page)
    await expect(dialog).toBeVisible({ timeout: 10000 })

    const { footer, confirm, cancel } = await boxes(dialog)
    expect(confirm.y + confirm.height).toBeLessThanOrEqual(cancel.y + 1)
    for (const button of [confirm, cancel]) {
      // The footer's side padding on a phone is 24px each (--space-6).
      expect(button.width).toBeGreaterThan(footer.width - 2 * 24 - 2)
      expect(Math.abs(button.x - (footer.x + 24))).toBeLessThan(2)
    }
  })
})
