// Journey: a quote of the reader's post notifies the reader, and the notification opens the quote.
//
// Two quotes of one post: one by a local account, written as the app writes it
// (activityPubService.createQuoteReblog: a posts row with metadata.is_quote and reblog_of), and
// one from another instance, stored as the federation backend stores an inbound Mastodon quote
// (e2e/federation/cases/notif.ts covers the delivery itself). The database writes the
// notifications.
//
//   - both are in the bell, each reading "<name> quoted your post" with the quote's text;
//   - opening one goes to the quoting post;
//   - the toast of a quote arriving live opens it too;
//   - Settings > Notifications lists Quotes among the Fediverse types.
//
// The reader owns a server: the bell sits in the channel sidebar's user panel. The stack has no
// Realtime: the live notification is handed to the client's user event channel as
// notification:new, the payload broadcast_notification_event sends.

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import {
  adminClient, createUser, deleteUser, openChannel, seedServer, signIn, userClient,
  type SeededServer, type SpecUser,
} from './harness'

const admin = adminClient()
let reader: SpecUser
let quoter: SpecUser
let server: SeededServer
const remote = { id: crypto.randomUUID(), username: `quoter${Date.now().toString(36)}` }
const domain = 'mastodon.e2e.test'
const marker = Date.now().toString(36)
let quotedId = ''

test.beforeAll(async () => {
  reader = await createUser(admin, 'qnr')
  quoter = await createUser(admin, 'qnq')
  server = await seedServer(admin, reader, `Quotes ${reader.username}`)

  const { error: profileError } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Remote Quoter',
    domain,
    is_local: false,
    federated_id: `https://${domain}/users/${remote.username}`,
    inbox_url: `https://${domain}/users/${remote.username}/inbox`,
  })
  if (profileError) throw new Error(`remote profile: ${profileError.message}`)

  const { data, error } = await admin.from('posts')
    .insert({ author_id: reader.id, visibility: 'public', is_local: true, content: [{ type: 'text', text: `quote me ${marker}` }] })
    .select('id').single()
  if (error || !data) throw new Error(`post: ${error?.message}`)
  quotedId = data.id
})

test.afterAll(async () => {
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, reader)
  await deleteUser(admin, quoter)
})

/** A local quote, as the quote composer writes it. */
async function localQuote(text: string): Promise<string> {
  const client = await userClient(quoter)
  const { data, error } = await client.from('posts').insert({
    author_id: quoter.id,
    content: [{ type: 'text', text }],
    visibility: 'public',
    is_local: true,
    is_federated: true,
    ap_id: `https://${domain}/activities/${crypto.randomUUID()}`,
    metadata: { reblog_of: quotedId, is_quote: true },
  }).select('id').single()
  if (error || !data) throw new Error(`local quote: ${error?.message}`)
  return data.id
}

/** An inbound Mastodon quote, as ActivityProcessor stores it. */
async function remoteQuote(text: string): Promise<string> {
  const { data, error } = await admin.from('posts').insert({
    author_id: remote.id,
    visibility: 'public',
    is_local: false,
    ap_id: `https://${domain}/users/${remote.username}/statuses/${crypto.randomUUID()}`,
    content: [{ type: 'text', text }],
    metadata: { is_quote: true, quote_ap_url: `https://example.invalid/posts/${quotedId}`, reblog_of: quotedId },
    reblog: { id: quotedId, content: [{ type: 'text', text: `quote me ${marker}` }], created_at: new Date().toISOString(), visibility: 'public' },
  }).select('id').single()
  if (error || !data) throw new Error(`remote quote: ${error?.message}`)
  return data.id
}

async function quoteNotification(postId: string): Promise<Record<string, unknown>> {
  let row: Record<string, unknown> | null = null
  await expect.poll(async () => {
    const { data } = await admin.from('notifications')
      .select('id, type, data, is_read, is_clicked, created_at, updated_at, user_id, expires_at')
      .eq('user_id', reader.id).eq('type', 'activitypub_quote').eq('data->>post_id', postId).maybeSingle()
    row = data
    return row !== null
  }, { timeout: 15000, message: `a quote notification for ${postId}` }).toBe(true)
  return row!
}

/** What Realtime would deliver on user:<reader>: the module instance the app loaded. */
async function deliver(page: Page, notification: Record<string, unknown>): Promise<void> {
  const run = (dispatch: boolean) => page.evaluate(async ({ notification, dispatch }) => {
    const url = performance.getEntriesByType('resource').map((e) => e.name)
      .find((name) => name.includes('/src/services/UserEventChannel.ts'))
    if (!url) return 0
    const channel = (await import(/* @vite-ignore */ url)).userEventChannel as any
    const handlers = channel.handlers.get('notification:new')?.size ?? 0
    if (dispatch && handlers > 0) channel.dispatch({ type: 'notification:new', notification })
    return handlers
  }, { notification, dispatch })
  await expect.poll(() => run(false), { timeout: 30000, message: 'a notification:new handler' }).toBeGreaterThan(0)
  await run(true)
}

test('a quote of your post notifies you and opens the quote', async ({ page }) => {
  test.setTimeout(150_000)
  const localId = await localQuote(`local words ${marker}`)
  const remoteId = await remoteQuote(`remote words ${marker}`)
  await quoteNotification(localId)
  await quoteNotification(remoteId)

  await signIn(page, reader)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('both quotes are in the bell, naming who quoted and what they wrote', async () => {
    await page.locator('[data-testid="notification-bell"]').click()
    const items = page.locator('[data-testid="notification-panel"] [data-testid="notification-item"][data-type="activitypub_quote"]')
    await expect(items).toHaveCount(2, { timeout: 15000 })
    await expect(items.filter({ hasText: `local words ${marker}` })).toContainText('quoted your post')
    await expect(items.filter({ hasText: `remote words ${marker}` })).toContainText('Remote Quoter')
  })

  await test.step('opening one goes to the quoting post', async () => {
    const item = page.locator('[data-testid="notification-panel"] [data-testid="notification-item"][data-type="activitypub_quote"]')
      .filter({ hasText: `remote words ${marker}` })
    await item.locator('[data-row-hit]').click()
    await expect(page).toHaveURL(new RegExp(`/social/post/${remoteId}$`), { timeout: 15000 })
  })

  await test.step('a quote arriving live shows a toast that opens it', async () => {
    const liveId = await localQuote(`live words ${marker}`)
    await deliver(page, await quoteNotification(liveId))
    const toast = page.locator('[data-testid="notification-toast-activitypub_quote"]')
    await expect(toast).toContainText('quoted your post', { timeout: 10000 })
    await toast.locator('.toast-open').click()
    await expect(page).toHaveURL(new RegExp(`/social/post/${liveId}$`), { timeout: 15000 })
  })

  await test.step('Settings lists Quotes among the Fediverse notification types', async () => {
    await page.goto('/settings/notifications')
    await expect(page.getByRole('switch', { name: 'Fediverse quotes: desktop notifications' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByRole('switch', { name: 'Fediverse quotes: sound' })).toBeVisible()
  })
})
