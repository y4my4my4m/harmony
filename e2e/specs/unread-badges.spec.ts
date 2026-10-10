// Journey: unread state as a reader sees it across loads. Opening a channel
// reads it, clears its unread mark and marks its notifications read. A reply in
// a thread of that channel leaves the channel read; a message in the channel
// itself marks it unread again.
//
// No realtime: the reader reloads #lobby, which refetches get_unread_counts. The
// author writes through PostgREST with their own session, as the composer does.
// The reader's server level is All messages, so a channel message also raises a
// channel_message notification.

import { test, expect, type Page } from '@playwright/test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  addChannel,
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

test.describe.configure({ mode: 'serial' })

const admin = adminClient()
let author: SpecUser
let reader: SpecUser
let server: SeededServer
let lobbyId: string
let authorClient: SupabaseClient

test.beforeAll(async () => {
  author = await createUser(admin, 'unra')
  reader = await createUser(admin, 'unrb')
  server = await seedServer(admin, author, `Unread ${author.username}`)
  await addMember(admin, reader, server.id)
  lobbyId = await addChannel(admin, server, 'lobby')
  authorClient = await userClient(author)

  const readerClient = await userClient(reader)
  const { error } = await readerClient.rpc('update_server_notification_settings', {
    p_server_id: server.id,
    p_changes: { level: 'all' },
  })
  if (error) throw new Error(`notification level: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, author)
  await deleteUser(admin, reader)
})

async function post(text: string, threadId?: string): Promise<void> {
  const { error } = await authorClient.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: author.id,
    content: [{ type: 'text', text }],
    ...(threadId ? { thread_id: threadId } : {}),
  })
  if (error) throw new Error(`post: ${error.message}`)
}

async function unreadNotifications(): Promise<number> {
  const { count } = await admin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', reader.id)
    .eq('type', 'channel_message')
    .eq('is_read', false)
  return count ?? 0
}

const generalRow = (page: Page) =>
  page.locator(
    `.channel-sidebar .channel-wrapper[data-channel-id="${server.generalChannelId}"] .channel-item`,
  )

/** A full load of #lobby; returns once unread counts have been fetched. */
async function openLobby(page: Page): Promise<void> {
  const counted = page.waitForResponse((r) => r.url().includes('/rpc/get_unread_counts'), {
    timeout: 30000,
  })
  await page.goto(`/chat/${server.id}/${lobbyId}`)
  await dismissAnnouncements(page)
  expect((await counted).ok()).toBe(true)
  await expect(generalRow(page)).toBeVisible({ timeout: 30000 })
}

/** Opens #general from the sidebar and waits for its read to land. */
async function readGeneral(page: Page, text: string): Promise<void> {
  const read = page.waitForResponse(
    (r) =>
      r.url().includes('/rpc/mark_channel_as_read') &&
      (r.request().postData() ?? '').includes(server.generalChannelId),
    { timeout: 30000 },
  )
  await generalRow(page).click()
  await expect(page.locator('[data-testid="message-list"]').getByText(text)).toBeVisible({
    timeout: 30000,
  })
  expect((await read).ok()).toBe(true)
}

test('opening a channel clears its unread mark and its notifications', async ({ page }) => {
  test.setTimeout(150_000)

  await post('first news')
  await expect.poll(unreadNotifications, { timeout: 15000 }).toBe(1)

  await signIn(page, reader)

  await test.step('#general is unread with a badge', async () => {
    await openLobby(page)
    await expect(generalRow(page)).toHaveClass(/channel-unread/)
    await expect(generalRow(page).locator('.notification-badge')).toHaveText('1')
  })

  await test.step('reading it clears the mark and the notification', async () => {
    await readGeneral(page, 'first news')
    await expect.poll(unreadNotifications, { timeout: 15000 }).toBe(0)
  })

  await test.step('it stays read after a reload', async () => {
    await openLobby(page)
    await expect(generalRow(page)).not.toHaveClass(/channel-unread/)
    await expect(generalRow(page).locator('.notification-badge')).toHaveCount(0)
  })
})

test('a thread reply leaves its channel read; a channel message does not', async ({ page }) => {
  test.setTimeout(150_000)

  const threadName = `side talk ${author.username.slice(-4)}`
  const { data: threadId, error } = await authorClient.rpc('create_channel_thread', {
    p_channel_id: server.generalChannelId,
    p_name: threadName,
  })
  if (error || !threadId) throw new Error(`thread: ${error?.message}`)

  await post('before the reply')

  await signIn(page, reader)

  await test.step('read #general, thread notice included', async () => {
    await openLobby(page)
    await expect(generalRow(page)).toHaveClass(/channel-unread/)
    await readGeneral(page, 'before the reply')
    await openLobby(page)
    await expect(generalRow(page)).not.toHaveClass(/channel-unread/)
  })

  await test.step('a reply in the thread leaves #general read', async () => {
    await post('reply inside the thread', threadId as string)
    await openLobby(page)
    await expect(generalRow(page)).not.toHaveClass(/channel-unread/)
    await expect(generalRow(page).locator('.notification-badge')).toHaveCount(0)
  })

  await test.step('a message in #general itself marks it unread', async () => {
    await post('back in the channel')
    await openLobby(page)
    await expect(generalRow(page)).toHaveClass(/channel-unread/)
  })
})
