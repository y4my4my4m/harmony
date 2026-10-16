// Journey: message views listen to Realtime Broadcast only. Channel, DM and thread views hold
// no postgres_changes subscription on messages, and a thread reply reaches an open thread
// through its 'thread-messages-<thread id>' topic, which broadcast_message_event fills.
//
// The stack runs no Realtime server: the step hands the payload broadcast_message_event
// would send to the thread subscription's own message_event handler.

import { randomUUID } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
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
let member: SpecUser
let server: SeededServer
const threadId = randomUUID()
const parentId = randomUUID()
const name = `Broadcast ${Date.now().toString(36)}`

test.beforeAll(async () => {
  owner = await createUser(admin, 'rbo')
  member = await createUser(admin, 'rbm')
  server = await seedServer(admin, owner, `Broadcast ${owner.username}`)
  await addMember(admin, member, server.id)
  const { error: messageError } = await admin.from('messages').insert({
    id: parentId, channel_id: server.generalChannelId, user_id: owner.id, content: [{ type: 'text', text: 'thread parent' }],
  })
  if (messageError) throw new Error(`parent: ${messageError.message}`)
  const { error: threadError } = await admin.from('threads').insert({
    id: threadId, channel_id: server.generalChannelId, parent_message_id: parentId, name, created_by: owner.id,
  })
  if (threadError) throw new Error(`thread: ${threadError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
})

/** The page's RealtimeConnectionManager subscriptions: name, kind, and the table for CDC kinds. */
const subscriptions = (page: Page) => page.evaluate(async () => {
  const served = performance.getEntriesByType('resource').map((e) => e.name)
    .find((n) => n.includes('/src/services/RealtimeConnectionManager.ts'))
  const mod = await import(/* @vite-ignore */ served ?? '/src/services/RealtimeConnectionManager.ts')
  const subs = (mod.realtimeConnectionManager as any).subscriptions as Map<string, any>
  return [...subs.entries()].map(([key, sub]) => ({
    name: key,
    kind: sub.configType as string,
    tables: [sub.config?.table, ...(sub.config?.tables ?? []).map((t: any) => t.table)].filter(Boolean) as string[],
  }))
})

test('message views use Broadcast only; a thread reply arrives on the thread topic', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)

  const panel = page.locator('.thread-panel')
  await test.step('open the thread', async () => {
    await page.locator('.chat-header .threads-btn').click()
    const modal = page.locator('.threads-modal')
    await expect(modal).toBeVisible({ timeout: 15000 })
    await modal.locator('.thread-item').filter({ has: page.locator('.thread-name', { hasText: name }) }).click()
    await expect(panel.locator('.thread-info h3')).toHaveText(name, { timeout: 15000 })
  })

  await test.step('no view subscribes to postgres_changes on messages', async () => {
    await expect.poll(async () => (await subscriptions(page)).map((s) => s.name), { timeout: 15000 })
      .toEqual(expect.arrayContaining([`channel-messages-${server.generalChannelId}`, `thread-messages-${threadId}`]))
    const subs = await subscriptions(page)
    expect(subs.filter((s) => s.tables.includes('messages')), JSON.stringify(subs)).toEqual([])
    expect(subs.find((s) => s.name === `thread-messages-${threadId}`)?.kind).toBe('broadcast')
    expect(subs.find((s) => s.name === `channel-messages-${server.generalChannelId}`)?.kind).toBe('broadcast')
  })

  await test.step('a reply delivered on the thread topic shows without a reload', async () => {
    const text = `broadcast reply ${Date.now()}`
    const { data: row, error } = await admin.from('messages').insert({
      channel_id: server.generalChannelId, thread_id: threadId, user_id: owner.id, content: [{ type: 'text', text }],
    }).select('*').single()
    if (error || !row) throw new Error(`reply: ${error?.message}`)

    await page.evaluate(async ({ topic, row }) => {
      const served = performance.getEntriesByType('resource').map((e) => e.name)
        .find((n) => n.includes('/src/services/RealtimeConnectionManager.ts'))
      const mod = await import(/* @vite-ignore */ served ?? '/src/services/RealtimeConnectionManager.ts')
      const sub = (mod.realtimeConnectionManager as any).subscriptions.get(topic)
      const handler = sub.config.broadcasts.find((b: any) => b.event === 'message_event').handler
      await handler({ op: 'INSERT', new: row, old: null })
    }, { topic: `thread-messages-${threadId}`, row })

    await expect(panel.locator('[data-testid="message-list"]').getByText(text)).toBeVisible({ timeout: 15000 })
  })
})
