// Journey: Clear all in the notification panel asks in the app's own dialog,
// not the browser's: cancelling keeps every notification, confirming removes
// them, and they stay gone after a reload.
//
// The notifications are real: two users follow the reader, and the follows
// trigger writes a 'follow' notification for each. The reader owns a server: the
// bell sits in the channel sidebar's user panel, which the no-servers splash lacks.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let reader: SpecUser
let followers: SpecUser[] = []
let server: SeededServer

async function notificationCount(): Promise<number> {
  const { count } = await admin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', reader.id)
  return count ?? 0
}

test.beforeAll(async () => {
  reader = await createUser(admin, 'clra')
  server = await seedServer(admin, reader, `Inbox ${reader.username}`)
  followers = [await createUser(admin, 'clrb'), await createUser(admin, 'clrc')]
  for (const follower of followers) {
    const client = await userClient(follower)
    const { error } = await client
      .from('follows')
      .insert({ follower_id: follower.id, following_id: reader.id, status: 'accepted' })
    if (error) throw new Error(`follow by ${follower.username}: ${error.message}`)
  }
  await expect.poll(notificationCount, { timeout: 15000 }).toBe(2)
})

test.afterAll(async () => {
  await deleteUser(admin, reader)
  for (const follower of followers) await deleteUser(admin, follower)
})

async function openPanel(page: Page) {
  await page.locator('[data-testid="notification-bell"]').click()
  const panel = page.locator('[data-testid="notification-panel"]')
  await expect(panel).toBeVisible({ timeout: 15000 })
  return panel
}

test('Clear all confirms in the app dialog and empties the inbox', async ({ page }) => {
  test.setTimeout(150_000)

  const nativeDialogs: string[] = []
  page.on('dialog', async (dialog) => {
    nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`)
    await dialog.dismiss()
  })

  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)
  const items = page.locator('[data-testid="notification-item"]')
  const confirmDialog = page
    .locator('.modal-container')
    .filter({ hasText: "Clear all notifications? This can't be undone." })

  await test.step('the panel lists both follows', async () => {
    await openPanel(page)
    await expect(items).toHaveCount(2, { timeout: 30000 })
  })

  await test.step('Cancel in the app dialog keeps them', async () => {
    await page.locator('[data-testid="notification-clear-all"]').click()
    await expect(confirmDialog).toBeVisible({ timeout: 10000 })
    await confirmDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirmDialog).toBeHidden()
    await expect(items).toHaveCount(2)
    expect(await notificationCount()).toBe(2)
  })

  await test.step('Clear all in the app dialog removes them', async () => {
    await page.locator('[data-testid="notification-clear-all"]').click()
    await expect(confirmDialog).toBeVisible({ timeout: 10000 })
    const deleted = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/notifications') && r.request().method() === 'DELETE',
    )
    await confirmDialog.getByRole('button', { name: 'Clear all' }).click()
    expect((await deleted).ok()).toBe(true)
    await expect(confirmDialog).toBeHidden()
    await expect(items).toHaveCount(0)
    await expect.poll(notificationCount).toBe(0)
  })

  await test.step('the inbox stays empty after a reload', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await expect(page.locator('[data-testid="notification-bell"] .notification-badge')).toHaveCount(
      0,
    )
    await openPanel(page)
    await expect(page.locator('[data-testid="notification-list"]')).toHaveAttribute(
      'aria-busy',
      'false',
      { timeout: 30000 },
    )
    await expect(items).toHaveCount(0)
  })

  expect(nativeDialogs).toEqual([])
})
