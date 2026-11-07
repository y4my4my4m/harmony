// Journey: a profile names the account by its full fediverse handle, @user@domain, local accounts
// included, and copies it: the profile page and the profile card each have Copy handle beside
// the handle, the card's menu a Copy handle item. A toast names what was copied. The DM search
// lists the same handle.
//
// E2E instance_config domain and VITE_DOMAIN are localhost.

import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
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
const REMOTE_DOMAIN = 'copy.example'
let reader: SpecUser
let ada: SpecUser
let server: SeededServer
const remote = { id: randomUUID(), username: `far${Date.now().toString(36)}` }

test.beforeAll(async () => {
  reader = await createUser(admin, 'pch')
  ada = await createUser(admin, 'pca')
  server = await seedServer(admin, ada, `Copy handle ${ada.username}`)
  await addMember(admin, reader, server.id)
  const actor = `https://${REMOTE_DOMAIN}/users/${remote.username}`
  const { error } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Far Away',
    domain: REMOTE_DOMAIN,
    is_local: false,
    federated_id: actor,
    inbox_url: `${actor}/inbox`,
    outbox_url: `${actor}/outbox`,
  })
  if (error) throw new Error(`remote profile: ${error.message}`)
})

test.afterAll(async () => {
  await admin.from('profiles').delete().eq('id', remote.id)
  for (const user of [reader, ada]) if (user) await deleteUser(admin, user)
})

async function stubClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __copied: string[] }
    w.__copied = []
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { w.__copied.push(text) } })
  })
}

const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)

test('the profile page shows and copies the full handle, local and remote', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, reader)

  await page.goto(`/@${ada.username}`)
  await dismissAnnouncements(page)
  const handle = page.getByTestId('profile-handle')
  await expect(handle).toHaveText(`@${ada.username}@localhost`, { timeout: 30000 })
  await stubClipboard(page)
  await page.locator('.name-handle-section .user-handle').getByTestId('copy-handle').click()
  expect(await copied(page)).toEqual([`@${ada.username}@localhost`])
  await expect(page.getByText(`Copied @${ada.username}@localhost`)).toBeVisible()

  await page.goto(`/@${remote.username}@${REMOTE_DOMAIN}`)
  await expect(handle).toHaveText(`@${remote.username}@${REMOTE_DOMAIN}`, { timeout: 30000 })
  await stubClipboard(page)
  await page.locator('.name-handle-section .user-handle').getByTestId('copy-handle').click()
  expect(await copied(page)).toEqual([`@${remote.username}@${REMOTE_DOMAIN}`])
})

test('the profile card shows the full handle and copies it from the button and the menu', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)
  await page.locator('.user-sidebar .user-item').filter({ hasText: ada.displayName }).first().click()
  const modal = page.locator('.profile-modal-content')
  await expect(modal).toBeVisible({ timeout: 15000 })
  await expect(modal.getByTestId('profile-modal-handle')).toHaveText(`@${ada.username}@localhost`)

  await stubClipboard(page)
  await modal.getByTestId('copy-handle').click()
  expect(await copied(page)).toEqual([`@${ada.username}@localhost`])

  await modal.getByRole('button', { name: 'More actions' }).click()
  await modal.getByTestId('profile-menu-copy-handle').click()
  expect(await copied(page)).toEqual([`@${ada.username}@localhost`, `@${ada.username}@localhost`])
})

test('the DM search lists accounts by their full handle', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, reader)
  await page.goto('/dm')
  await dismissAnnouncements(page)
  await page.locator('[data-testid="dm-new-conversation"]').click()
  const input = page.locator('.user-search-section .search-input')
  await input.fill(remote.username)
  await expect(page.locator('.search-result-item').filter({ hasText: remote.username }).locator('.username'))
    .toHaveText(`@${remote.username}@${REMOTE_DOMAIN}`, { timeout: 30000 })
  await input.fill(ada.username)
  await expect(page.locator('.search-result-item').filter({ hasText: ada.username }).locator('.username'))
    .toHaveText(`@${ada.username}@localhost`, { timeout: 30000 })
})
