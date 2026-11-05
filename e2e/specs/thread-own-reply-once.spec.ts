// Journey: the sender's own thread reply shows once, in the thread side panel and in the full
// thread view, whichever of the insert response and the reply's realtime INSERT reaches the page
// first, in a server with local members only and in one with a member from another instance. A
// later metadata update and a delete apply to that one row. Neither thread view shows the
// channel's "Welcome to #channel" start line. A channel message sent the same way is the
// comparison.
//
// The stack runs no Realtime server. The reply's insert is held at the route: the stored row, as
// broadcast_message_event sends it, goes to the view's message_event handler before or after the
// response is released.

import crypto from 'node:crypto'
import { test, expect, type Page, type Locator, type Route } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
const DOMAIN = 'remote.e2e.test'
let owner: SpecUser
const remote = { id: crypto.randomUUID(), username: `tor${Date.now().toString(36)}` }

interface Setup {
  server: SeededServer
  threadId: string
  threadName: string
}
const local = {} as Setup
const federated = {} as Setup

async function thread(server: SeededServer, authorId: string, threadName: string): Promise<string> {
  const { data: parent, error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId, user_id: authorId, content: [{ type: 'text', text: `${threadName} starter` }],
  }).select('id').single()
  if (error || !parent) throw new Error(`parent: ${error?.message}`)
  const client = await userClient(owner)
  const { data: created, error: threadError } = await client.rpc('create_thread', {
    p_message_id: parent.id, p_name: threadName, p_auto_archive_duration: 1440,
  })
  if (threadError) throw new Error(`thread: ${threadError.message}`)
  return created as string
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'tro')

  local.server = await seedServer(admin, owner, `Local ${owner.username}`)
  local.threadName = `Local talk ${owner.username.slice(-4)}`
  local.threadId = await thread(local.server, owner.id, local.threadName)

  federated.server = await seedServer(admin, owner, `Federated ${owner.username}`)
  const fed = await admin.from('servers').update({ federation_enabled: true }).eq('id', federated.server.id)
  if (fed.error) throw new Error(fed.error.message)
  const { error: profileError } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Remote starter',
    domain: DOMAIN,
    is_local: false,
    federated_id: `https://${DOMAIN}/users/${remote.username}`,
    inbox_url: `https://${DOMAIN}/users/${remote.username}/inbox`,
  })
  if (profileError) throw new Error(`remote profile: ${profileError.message}`)
  const { error: memberError } = await admin.from('user_servers').insert({
    server_id: federated.server.id, user_id: remote.id, status: 'accepted', member_instance: DOMAIN,
  })
  if (memberError) throw new Error(`remote membership: ${memberError.message}`)
  federated.threadName = `Remote talk ${owner.username.slice(-4)}`
  federated.threadId = await thread(federated.server, remote.id, federated.threadName)
})

test.afterAll(async () => {
  await admin.from('servers').delete().in('id', [local.server?.id, federated.server?.id].filter(Boolean))
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, owner)
})

/** The row broadcast_message_event sends for a stored message (20261019100001). */
const broadcastRow = (row: Record<string, any>) => ({
  id: row.id,
  created_at: row.created_at,
  updated_at: row.updated_at,
  user_id: row.user_id,
  bot_id: row.bot_id,
  channel_id: row.channel_id,
  conversation_id: row.conversation_id,
  thread_id: row.thread_id,
  reply_to: row.reply_to,
  content: row.content,
  is_deleted: row.is_deleted,
  is_system: row.is_system,
  is_pinned: row.is_pinned,
  encrypted: row.encrypted,
  encryption_metadata: row.encryption_metadata,
  megolm_session_id: row.megolm_session_id,
  metadata: row.metadata ?? {},
})

/** Hands a message_event payload to the page's subscription on `topic`. */
async function deliver(page: Page, topic: string, op: 'INSERT' | 'UPDATE', row: Record<string, any>) {
  await page.evaluate(async ({ topic, payload }) => {
    const served = performance.getEntriesByType('resource').map((e) => e.name)
      .find((n) => n.includes('/src/services/RealtimeConnectionManager.ts'))
    const mod = await import(/* @vite-ignore */ served ?? '/src/services/RealtimeConnectionManager.ts')
    const sub = (mod.realtimeConnectionManager as any).subscriptions.get(topic)
    if (!sub) throw new Error(`no subscription on ${topic}`)
    const handler = sub.config.broadcasts.find((b: any) => b.event === 'message_event').handler
    await handler(payload)
  }, { topic, payload: { op, new: broadcastRow(row), old: null } })
}

type Order = 'event-first' | 'response-first'

/**
 * Holds the next message insert at the route. 'event-first' delivers the stored row on `topic`
 * before the response reaches the page; 'response-first' after the stored row shows in `list`.
 * `stored` resolves to the stored row.
 */
async function raceNextInsert(page: Page, topic: string, order: Order, list: Locator): Promise<{ stored: Promise<Record<string, any>> }> {
  let settle!: (row: Record<string, any>) => void
  let fail!: (error: unknown) => void
  const stored = new Promise<Record<string, any>>((resolve, reject) => { settle = resolve; fail = reject })
  const matches = (url: URL) => url.pathname === '/rest/v1/messages'
  let held = false
  // Unrouted after the insert: `times` would also count the reads the route falls back on.
  const handler = async (route: Route) => {
    if (held || route.request().method() !== 'POST') return route.fallback()
    held = true
    try {
      const response = await route.fetch()
      // A thread reply is read back as an array, a channel message as one object.
      const body = await response.json()
      const row = Array.isArray(body) ? body[0] : body
      if (order === 'event-first') await deliver(page, topic, 'INSERT', row)
      await route.fulfill({ response })
      if (order === 'response-first') {
        await expect(list.locator(`[data-message-id="${row.id}"]`)).toHaveCount(1, { timeout: 15000 })
        await deliver(page, topic, 'INSERT', row)
      }
      settle(row)
    } catch (error) {
      fail(error)
    } finally {
      await page.unroute(matches, handler)
    }
  }
  await page.route(matches, handler)
  // Wrapped: an async function returning a promise would adopt it.
  return { stored }
}

/** Sends `text` from the view's composer with the insert raced against its realtime INSERT. */
async function sendRaced(page: Page, view: Locator, topic: string, order: Order, text: string, by: 'enter' | 'button' = 'enter') {
  const list = view.locator('[data-testid="message-list"]')
  const { stored } = await raceNextInsert(page, topic, order, list)
  const editor = view.locator('[data-testid="message-input"] .rich-text-editor')
  await editor.click()
  await editor.pressSequentially(text, { delay: 5 })
  if (by === 'enter') await page.keyboard.press('Enter')
  else await view.getByTestId('message-send-btn').tap()
  const row = await stored
  await expect(list.locator('.message-item').filter({ hasText: text }).first()).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 15000 })
  return { list, row }
}

/** One row per stored reply, an update lands on it, a delete leaves none. */
async function expectOnce(page: Page, list: Locator, topic: string, row: Record<string, any>, text: string) {
  await expect(list.locator(`[data-message-id="${row.id}"]`)).toHaveCount(1)
  await expect(list.locator('[data-message-id^="temp-"]')).toHaveCount(0)
  await expect(list.getByText(text, { exact: true })).toHaveCount(1)

  await deliver(page, topic, 'UPDATE', { ...row, metadata: { ...(row.metadata ?? {}), ap_id: `https://example.test/notes/${row.id}` } })
  await expect(list.locator(`[data-message-id="${row.id}"]`)).toHaveCount(1)

  const edited = `${text} (edited)`
  await deliver(page, topic, 'UPDATE', { ...row, content: [{ type: 'text', text: edited }], updated_at: new Date().toISOString() })
  await expect(list.locator(`[data-message-id="${row.id}"]`)).toHaveCount(1)
  await expect(list.locator(`[data-message-id="${row.id}"]`)).toContainText(edited)
}

async function expectDeleted(page: Page, list: Locator, topic: string, row: Record<string, any>) {
  await deliver(page, topic, 'UPDATE', { ...row, is_deleted: true })
  await expect(list.locator(`[data-message-id="${row.id}"]`)).toHaveCount(0)
}

async function openThreadPanel(page: Page, setup: Setup): Promise<Locator> {
  await openChannel(page, setup.server.id, setup.server.generalChannelId)
  await page.locator('.chat-header .threads-btn').click()
  const modal = page.locator('.threads-modal')
  await expect(modal).toBeVisible({ timeout: 15000 })
  await modal.locator('.thread-item').filter({ has: page.locator('.thread-name', { hasText: setup.threadName }) }).click()
  const panel = page.locator('.thread-panel')
  await expect(panel.locator('.thread-info h3')).toHaveText(setup.threadName, { timeout: 15000 })
  return panel
}

for (const [label, setup] of [['local members only', local], ['a member from another instance', federated]] as const) {
  test(`own replies show once in the thread side panel; ${label}`, async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page, owner)
    const panel = await openThreadPanel(page, setup)
    const topic = `thread-messages-${setup.threadId}`

    for (const order of ['event-first', 'response-first'] as const) {
      await test.step(`realtime ${order === 'event-first' ? 'before' : 'after'} the insert response`, async () => {
        const text = `panel ${order} ${Date.now().toString(36)}`
        const { list, row } = await sendRaced(page, panel, topic, order, text)
        await expectOnce(page, list, topic, row, text)
        await expectDeleted(page, list, topic, row)
      })
    }

    await test.step('the panel shows the thread, not the channel start', async () => {
      const text = `panel last ${Date.now().toString(36)}`
      const { list } = await sendRaced(page, panel, topic, 'event-first', text)
      await expect(list.getByText(text, { exact: true })).toHaveCount(1)
      await expect(panel.locator('.beginning-indicator')).toHaveCount(0)
      await expect(panel).not.toContainText('Welcome to #general')
    })
  })

  test(`own replies show once in the full thread view; ${label}`, async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page, owner)
    await openChannel(page, setup.server.id, setup.server.generalChannelId)
    await page.locator('.channel-thread-item').filter({ hasText: setup.threadName }).click()
    await page.waitForURL(new RegExp(`/chat/${setup.server.id}/thread/${setup.threadId}$`), { timeout: 15000 })
    const view = page.locator('.thread-full-view')
    await expect(view.locator('.thread-title')).toHaveText(setup.threadName, { timeout: 15000 })
    const topic = `thread-messages-${setup.threadId}`

    for (const order of ['event-first', 'response-first'] as const) {
      await test.step(`realtime ${order === 'event-first' ? 'before' : 'after'} the insert response`, async () => {
        const text = `full ${order} ${Date.now().toString(36)}`
        const { list, row } = await sendRaced(page, view, topic, order, text)
        await expectOnce(page, list, topic, row, text)
      })
    }

    await test.step('the full view shows the thread, not the channel start', async () => {
      await expect(view.locator('[data-testid="message-list"] .message-item').first()).toBeVisible()
      await expect(view.locator('.beginning-indicator')).toHaveCount(0)
      await expect(view).not.toContainText('Welcome to #general')
    })
  })
}

test('comparison: an own channel message shows once whichever transport lands first', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, local.server.id, local.server.generalChannelId)
  const chat = page.locator('body')
  const topic = `channel-messages-${local.server.generalChannelId}`
  for (const order of ['event-first', 'response-first'] as const) {
    await test.step(`realtime ${order === 'event-first' ? 'before' : 'after'} the insert response`, async () => {
      const text = `channel ${order} ${Date.now().toString(36)}`
      const { row } = await sendRaced(page, chat, topic, order, text)
      await expect(messageList(page).locator(`[data-message-id="${row.id}"]`)).toHaveCount(1)
      await expect(messageList(page).getByText(text, { exact: true })).toHaveCount(1)
    })
  }
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })

  test('own replies show once in the thread panel; a member from another instance', async ({ page }) => {
    test.setTimeout(150_000)
    await signIn(page, owner)
    await openChannel(page, federated.server.id, federated.server.generalChannelId)
    await page.getByRole('button', { name: 'More options' }).first().tap()
    await page.getByRole('menuitem', { name: /threads/i }).tap()
    await page.locator('.threads-modal').getByText(federated.threadName).first().tap()
    const panel = page.locator('.thread-panel')
    await expect(panel.locator('.thread-info h3')).toHaveText(federated.threadName, { timeout: 15000 })
    const topic = `thread-messages-${federated.threadId}`

    const text = `phone ${Date.now().toString(36)}`
    const { list, row } = await sendRaced(page, panel, topic, 'event-first', text, 'button')
    await expectOnce(page, list, topic, row, text)
    await expect(panel.locator('.beginning-indicator')).toHaveCount(0)
  })
})
