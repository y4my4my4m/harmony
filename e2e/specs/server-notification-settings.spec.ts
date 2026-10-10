// Journey: a member sets a server's notification level and a channel override in the
// Notification Settings modal; another member's messages then raise notifications, or not,
// as those settings say. The channel header menu reads the same settings.
//
// The stack runs no realtime: the reader reloads to fetch notifications. The reader stays in
// #lobby while messages land in #general, so view-context suppression does not apply.
// The author posts through PostgREST with their own session, as the composer would.

import { test, expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
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

function env(...names: string[]): string {
  for (const name of names) if (process.env[name]) return process.env[name]!
  throw new Error(`none of ${names.join(', ')} is set - run: npm run e2e:up`)
}

test.beforeAll(async () => {
  author = await createUser(admin, 'nsa')
  reader = await createUser(admin, 'nsb')
  server = await seedServer(admin, author, `Notify ${author.username}`)
  await addMember(admin, reader, server.id)

  const { data: general } = await admin
    .from('channels')
    .select('category')
    .eq('id', server.generalChannelId)
    .single()
  const { data: lobby, error } = await admin
    .from('channels')
    .insert({ server_id: server.id, name: 'lobby', type: 0, category: general?.category ?? null })
    .select('id')
    .single()
  if (error || !lobby) throw new Error(`lobby channel: ${error?.message}`)
  lobbyId = lobby.id

  authorClient = createClient(
    env('E2E_SUPABASE_URL', 'TEST_SUPABASE_URL'),
    env('E2E_SUPABASE_ANON_KEY', 'TEST_SUPABASE_ANON_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
  const { error: signInError } = await authorClient.auth.signInWithPassword({
    email: author.email,
    password: author.password,
  })
  if (signInError) throw new Error(`author sign-in: ${signInError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, author)
  await deleteUser(admin, reader)
})

async function post(text: string): Promise<void> {
  const { error } = await authorClient.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: author.id,
    content: [{ type: 'text', text }],
  })
  if (error) throw new Error(`post: ${error.message}`)
}

/** The reader's channel_message notifications in #general. */
async function channelMessageCount(): Promise<number> {
  const { count, error } = await admin
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', reader.id)
    .eq('type', 'channel_message')
  if (error) throw new Error(`notifications: ${error.message}`)
  return count ?? 0
}

const generalRow = (page: Page) =>
  page.locator(`.channel-sidebar .channel-wrapper[data-channel-id="${server.generalChannelId}"] .channel-item`)

/** A full load of #lobby, which refetches notifications and reports the view. */
async function openLobby(page: Page): Promise<void> {
  const reported = page.waitForRequest(
    (r) => r.url().includes('/rpc/sync_view_context_from_presence') && (r.postData() ?? '').includes(lobbyId),
    { timeout: 30000 },
  )
  await page.goto(`/chat/${server.id}/${lobbyId}`)
  await dismissAnnouncements(page)
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 30000 })
  await expect(generalRow(page)).toBeVisible({ timeout: 30000 })
  await reported
}

async function openSettings(page: Page) {
  await page.locator('.channel-sidebar .server-name').click()
  await page.locator('[data-testid="server-notification-settings"]').click()
  const modal = page.locator('[data-testid="notification-settings-modal"]')
  await expect(modal).toBeVisible({ timeout: 15000 })
  return modal
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="ns-done"]').click()
  await expect(page.locator('[data-testid="notification-settings-modal"]')).toBeHidden()
}

/** Waits until the save the last control sent has landed. */
async function settled(page: Page, rpc: string, action: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((r) => r.url().includes(`/rpc/${rpc}`) && r.request().method() === 'POST')
  await action()
  expect((await response).ok()).toBe(true)
}

test('server level and channel override decide which messages notify', async ({ page }) => {
  test.setTimeout(240_000)

  await test.step('sign in and sit in #lobby', async () => {
    await signIn(page, reader)
    await openLobby(page)
  })

  await test.step('the modal opens on the server default', async () => {
    const modal = await openSettings(page)
    await expect(modal.locator('[data-testid="ns-level-mentions"]')).toBeChecked()
    await expect(modal.locator('[data-testid="ns-override-table"]')).toHaveCount(0)
    await closeSettings(page)
  })

  await test.step('at Only @mentions a plain message marks #general unread without a badge', async () => {
    await post('before any setting')
    await openLobby(page)
    await expect(generalRow(page)).toHaveClass(/channel-unread/, { timeout: 30000 })
    await expect(generalRow(page).locator('.notification-badge')).toHaveCount(0)
    expect(await channelMessageCount()).toBe(0)
  })

  await test.step('set the server to All messages', async () => {
    const modal = await openSettings(page)
    await settled(page, 'update_server_notification_settings', () =>
      modal.locator('[data-testid="ns-level-all"]').check())
    await expect(modal.locator('[data-testid="ns-level-all"]')).toBeChecked()
    await closeSettings(page)
  })

  await test.step('a plain message now notifies', async () => {
    await post('hello at all messages')
    await openLobby(page)
    await expect(generalRow(page).locator('.notification-badge')).toHaveText('1', { timeout: 30000 })
    expect(await channelMessageCount()).toBe(1)
  })

  await test.step('override #general to Nothing', async () => {
    const modal = await openSettings(page)
    await modal.locator('[data-testid="ns-override-picker"]').selectOption(`channel:${server.generalChannelId}`)
    const row = modal.locator(`[data-testid="ns-override-row"][data-target-id="${server.generalChannelId}"]`)
    await expect(row).toBeVisible()
    await settled(page, 'update_channel_notification_override', () =>
      row.locator('[data-testid="ns-override-none"]').check())
    await closeSettings(page)
  })

  await test.step('the overridden channel stays silent', async () => {
    await post('hello while overridden')
    await openLobby(page)
    await expect(generalRow(page).locator('.notification-badge')).toHaveText('1', { timeout: 30000 })
    expect(await channelMessageCount()).toBe(1)
  })

  await test.step('the override shows in the modal and in the channel menu', async () => {
    const modal = await openSettings(page)
    await expect(
      modal.locator(`[data-testid="ns-override-row"][data-target-id="${server.generalChannelId}"] [data-testid="ns-override-none"]`),
    ).toBeChecked()
    await closeSettings(page)

    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    await page.locator('.chat-header .more-btn').click()
    await expect(page.locator('[data-testid="channel-level-none"]')).toHaveClass(/item-active/)
  })

  await test.step('the channel menu returns #general to the server level', async () => {
    await settled(page, 'update_channel_notification_override', () =>
      page.locator('[data-testid="channel-level-default"]').click())
    await openLobby(page)
    const modal = await openSettings(page)
    await expect(modal.locator('[data-testid="ns-override-table"]')).toHaveCount(0)
    await closeSettings(page)

    await post('hello after the override')
    await openLobby(page)
    await expect.poll(channelMessageCount, { timeout: 15000 }).toBe(2)
  })
})

test('mute the server for an hour and suppress mentions', async ({ page }) => {
  test.setTimeout(180_000)

  await signIn(page, reader)
  await openLobby(page)

  await test.step('mute for one hour and suppress @everyone', async () => {
    const modal = await openSettings(page)
    await modal.locator('[data-testid="ns-mute-duration"]').selectOption('h1')
    await settled(page, 'update_server_notification_settings', () =>
      modal.locator('[data-testid="ns-mute-toggle"]').click())
    await expect(modal.locator('[data-testid="ns-muted-until"]')).toBeVisible()
    await settled(page, 'update_server_notification_settings', () =>
      modal.locator('[data-testid="ns-suppress-everyone"]').click())
    await closeSettings(page)
  })

  await test.step('the settings survive a reload', async () => {
    await openLobby(page)
    const modal = await openSettings(page)
    await expect(modal.locator('[data-testid="ns-mute-toggle"]')).toHaveAttribute('aria-checked', 'true')
    await expect(modal.locator('[data-testid="ns-muted-until"]')).toBeVisible()
    await expect(modal.locator('[data-testid="ns-suppress-everyone"]')).toHaveAttribute('aria-checked', 'true')
    await expect(modal.locator('[data-testid="ns-suppress-roles"]')).toHaveAttribute('aria-checked', 'false')
    await closeSettings(page)
  })

  await test.step('a muted server raises no message notifications', async () => {
    const before = await channelMessageCount()
    await post('while the server is muted')
    await openLobby(page)
    expect(await channelMessageCount()).toBe(before)
    await expect(generalRow(page)).toHaveClass(/channel-unread/, { timeout: 30000 })
  })

  await test.step('unmute', async () => {
    const modal = await openSettings(page)
    await settled(page, 'update_server_notification_settings', () =>
      modal.locator('[data-testid="ns-mute-toggle"]').click())
    await expect(modal.locator('[data-testid="ns-muted-until"]')).toHaveCount(0)
    await closeSettings(page)
  })
})
