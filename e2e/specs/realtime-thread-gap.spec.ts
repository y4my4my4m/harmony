// Journey: a reply sent while Realtime held an open thread's topic closed shows once the topic is
// joined again, in the thread panel and on the full thread route, without reopening the thread.
//
// Realtime here is FakeRealtime: the e2e stack runs none. It closes the thread topic as a real
// Realtime does on an expired token; the reply goes to the database meanwhile, so no transport
// delivers it and only the gap fill on the rejoin can show it.

import { randomUUID } from 'node:crypto'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { FakeRealtime } from './fakeRealtime'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
const threadId = randomUUID()
const parentId = randomUUID()
const name = `Gap ${Date.now().toString(36)}`
const topic = `realtime:thread-messages-${threadId}`

test.beforeAll(async () => {
  owner = await createUser(admin, 'rtgap')
  server = await seedServer(admin, owner, `Gap ${owner.username}`)
  const { error: parentError } = await admin.from('messages').insert({
    id: parentId, channel_id: server.generalChannelId, user_id: owner.id, content: [{ type: 'text', text: 'gap parent' }],
  })
  if (parentError) throw new Error(`parent: ${parentError.message}`)
  const { error: threadError } = await admin.from('threads').insert({
    id: threadId, channel_id: server.generalChannelId, parent_message_id: parentId, name, created_by: owner.id,
  })
  if (threadError) throw new Error(`thread: ${threadError.message}`)
  await reply('first reply')
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

async function reply(text: string): Promise<void> {
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId, thread_id: threadId, user_id: owner.id, content: [{ type: 'text', text }],
  })
  if (error) throw new Error(`reply: ${error.message}`)
}

/** Closes the joined thread topic, adds a reply meanwhile, and waits for the rejoin to show it. */
async function replyDuringClose(page: Page, fake: FakeRealtime, list: Locator, text: string): Promise<void> {
  await expect.poll(() => fake.joined.has(topic), { timeout: 30_000 }).toBe(true)
  const joinsBefore = fake.joinsOf(topic).length
  fake.closeChannel(topic)
  await reply(text)
  await expect.poll(() => fake.joinsOf(topic).length, { timeout: 30_000 }).toBeGreaterThan(joinsBefore)
  await expect(list.getByText(text)).toBeVisible({ timeout: 15_000 })
}

test('a reply sent while the thread topic was closed shows in the thread panel', async ({ page }) => {
  test.setTimeout(120_000)
  const fake = await FakeRealtime.attach(page)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const panel = page.locator('.thread-panel')
  await page.locator('.chat-header .threads-btn').click()
  const modal = page.locator('.threads-modal')
  await expect(modal).toBeVisible({ timeout: 15_000 })
  await modal.locator('.thread-item').filter({ has: page.locator('.thread-name', { hasText: name }) }).click()
  await expect(panel.locator('.thread-info h3')).toHaveText(name, { timeout: 15_000 })
  const list = panel.locator('[data-testid="message-list"]')
  await expect(list.getByText('first reply')).toBeVisible({ timeout: 15_000 })

  await replyDuringClose(page, fake, list, `panel gap ${Date.now()}`)
})

test('a reply sent while the thread topic was closed shows on the full thread route', async ({ page }) => {
  test.setTimeout(120_000)
  const fake = await FakeRealtime.attach(page)
  await signIn(page, owner)
  await page.goto(`/chat/${server.id}/thread/${threadId}`)

  const list = page.locator('.thread-full-view [data-testid="message-list"]')
  await expect(list.getByText('first reply')).toBeVisible({ timeout: 30_000 })

  await replyDuringClose(page, fake, list, `route gap ${Date.now()}`)
})
