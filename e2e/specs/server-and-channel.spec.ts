// Journey: a user with no servers creates one from the splash screen, then
// adds a channel to it and opens that channel.
//
// The channel is created from the category context menu. The same modal opened
// from the server dropdown sends category "" and Postgres rejects it
// (22P02): AdaptiveChannelSidebar.vue coerces the absent category id with
// `c ?? ''`.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let owner: SpecUser

test.beforeAll(async () => {
  owner = await createUser(admin, 'srv')
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

async function createServer(page: Page, name: string): Promise<void> {
  await page.locator('.action-card.create-card').click()
  const modal = page.locator('.modal-container').filter({ hasText: 'Create' })
  await expect(page.locator('[data-testid="create-server-name-input"]')).toBeVisible({
    timeout: 15000,
  })
  await page.locator('[data-testid="create-server-name-input"]').fill(name)
  await page.locator('[data-testid="create-server-btn"]').click()
  await expect(modal).toBeHidden({ timeout: 30000 })
}

test('create a server, add a channel to it and open the channel', async ({ page }) => {
  test.setTimeout(180_000)

  const serverName = `Spec Server ${owner.username}`
  const channelName = `spec-${owner.username.slice(-5)}`

  await test.step('sign in to an account that owns nothing', async () => {
    await signIn(page, owner)
    await expect(page.locator('.action-card.create-card')).toBeVisible({ timeout: 30000 })
  })

  await test.step('create the server from the splash screen', async () => {
    await createServer(page, serverName)

    await expect(page).toHaveURL(
      /\/chat\/[0-9a-f-]{36}\/[0-9a-f-]{36}/,
      { timeout: 30000 },
    )
    await expect(page.locator('.channel-sidebar .server-name')).toHaveText(serverName, {
      timeout: 30000,
    })
    // The insert trigger stocks a new server with these two.
    await expect(page.locator('.channel-sidebar').getByText('general', { exact: true })).toBeVisible()
    await expect(
      page.locator('.channel-sidebar').getByText('voice chat', { exact: true }),
    ).toBeVisible()
  })

  await test.step('add a text channel under TEXT CHANNELS', async () => {
    await page
      .locator('.channel-sidebar .category-name')
      .filter({ hasText: 'TEXT CHANNELS' })
      .first()
      .click({ button: 'right' })

    const menu = page.locator('.context-menu')
    await expect(menu).toBeVisible({ timeout: 10000 })
    await menu.locator('.context-menu-item').filter({ hasText: 'Create Channel' }).click()

    const modal = page.locator('.modal-container').filter({ hasText: 'Create Channel' })
    await expect(modal).toBeVisible({ timeout: 10000 })
    await modal.locator('input.modern-input').fill(channelName)
    await modal.locator('button').filter({ hasText: 'Create Channel' }).click()

    await expect(modal).toBeHidden({ timeout: 30000 })
    await expect(
      page.locator('.channel-sidebar').getByText(channelName, { exact: true }),
    ).toBeVisible({ timeout: 30000 })
  })

  await test.step('open the new channel', async () => {
    const before = page.url()
    await page.locator('.channel-sidebar').getByText(channelName, { exact: true }).click()

    await expect(page).not.toHaveURL(before, { timeout: 30000 })
    await expect(page.locator('[data-testid="message-input"] .rich-text-editor')).toHaveAttribute(
      'data-placeholder',
      new RegExp(channelName),
      { timeout: 30000 },
    )
  })

  await test.step('the server and both channels survive a reload', async () => {
    await page.reload()
    await expect(page.locator('.channel-sidebar .server-name')).toHaveText(serverName, {
      timeout: 30000,
    })
    await expect(
      page.locator('.channel-sidebar').getByText(channelName, { exact: true }),
    ).toBeVisible({ timeout: 30000 })
  })
})
