// Journey: clearing a channel's description in Edit channel stores no description. The
// header drops the old topic at once and after a reload.

import { test, expect, type Page } from '@playwright/test'
import {
  addChannel,
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let topicId: string
const OLD = 'Old topic that should go away'

test.beforeAll(async () => {
  owner = await createUser(admin, 'chdesc')
  server = await seedServer(admin, owner, `Topics ${owner.username.slice(-6)}`)
  topicId = await addChannel(admin, server, 'topical')
  const { error } = await admin.from('channels').update({ description: OLD }).eq('id', topicId)
  if (error) throw new Error(`description: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

const headerTopic = (page: Page) => page.locator('.chat-header .channel-description')

async function storedDescription(): Promise<string | null> {
  const { data } = await admin.from('channels').select('description').eq('id', topicId).single()
  return (data as { description: string | null }).description
}

test('clearing the description in Edit channel removes it', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, topicId)
  await expect(headerTopic(page)).toHaveText(OLD, { timeout: 15000 })

  await channelRow(page, 'topical').click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit channel' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit channel' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  const description = dialog.locator('#channel-description')
  await expect(description).toHaveValue(OLD)
  await description.fill('')

  const patched = page.waitForResponse((r) => r.url().includes('/rest/v1/channels') && r.request().method() === 'PATCH')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  const body = (await patched).request().postDataJSON() as Record<string, unknown>
  expect(body).toHaveProperty('description', null)
  await expect(dialog).toBeHidden()

  await expect.poll(storedDescription).toBeNull()
  await expect(headerTopic(page)).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.chat-header')).toBeVisible({ timeout: 30000 })
  await expect(headerTopic(page)).toHaveCount(0)
})
