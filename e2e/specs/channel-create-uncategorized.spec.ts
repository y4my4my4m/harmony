// Journey: a channel created outside any category, from the server menu and from the server
// rail's menu. Both open the dialog with no category; create_channel takes a uuid category and
// refused the empty string they passed ("invalid input syntax for type uuid"), so every such
// channel failed with "Failed to create channel". Public and private alike land with no category.
// A refusal from the server shows under the form with its reason; the name field stays clear and
// Create stays enabled.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'ccu')
  server = await seedServer(admin, owner, `Uncategorized ${owner.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

async function createIn(page: Page, name: string, priv: boolean) {
  const modal = page.getByRole('dialog', { name: 'Create channel' })
  await expect(modal).toBeVisible({ timeout: 15000 })
  await modal.locator('input.modern-input').fill(name)
  if (priv) await modal.getByRole('switch').last().click()
  const created = page.waitForResponse((r) => r.url().includes('/rpc/create_channel'))
  await modal.locator('button').filter({ hasText: 'Create channel' }).click()
  expect((await created).status()).toBe(200)
  await expect(modal).toBeHidden({ timeout: 15000 })
}

async function stored(name: string) {
  const { data, error } = await admin.from('channels').select('id, category').eq('server_id', server.id).eq('name', name)
  expect(error).toBeNull()
  return data ?? []
}

test('the server menu creates a channel in no category', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await page.locator('.channel-sidebar .server-name').click()
  await page.getByRole('menuitem', { name: 'Create channel' }).click()
  await createIn(page, 'staff-general', false)
  expect(await stored('staff-general')).toEqual([expect.objectContaining({ category: null })])
})

test("the server rail's menu creates a private channel in no category", async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await page.locator(`[data-rail-kind="server"][data-rail-id="${server.id}"]`).click({ button: 'right' })
  await page.locator('.rail-menu-item[data-action="create-channel"]').click()
  await createIn(page, 'staff-private', true)
  expect(await stored('staff-private')).toEqual([expect.objectContaining({ category: null })])
})

test('a refused create names the reason under the form, not on the name', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await page.route('**/rest/v1/rpc/create_channel', (route) => route.fulfill({
    status: 403,
    contentType: 'application/json',
    body: JSON.stringify({ code: '42501', details: null, hint: null, message: 'new row violates row-level security policy for table "channels"' }),
  }))

  await page.locator('.channel-sidebar .server-name').click()
  await page.getByRole('menuitem', { name: 'Create channel' }).click()
  const modal = page.getByRole('dialog', { name: 'Create channel' })
  await modal.locator('input.modern-input').fill('staff-general')
  await modal.locator('button').filter({ hasText: 'Create channel' }).click()

  await expect(modal.getByTestId('create-channel-error')).toHaveText("You can't create channels in this server.")
  await expect(modal.locator('.input-group.has-error')).toHaveCount(0)
  await expect(modal.locator('button').filter({ hasText: 'Create channel' })).toBeEnabled()
})

