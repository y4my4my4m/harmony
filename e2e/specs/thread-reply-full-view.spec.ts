// Journey: the thread composers show whom a reply answers. A reply to a thread message from a
// member of another instance, or from a local member, names its author above the composer in
// the side panel and in the full thread view; the stored reply points at that message. The
// thread side panel opens the full thread view, also for a thread the sidebar no longer lists.

import crypto from 'node:crypto'
import { test, expect, type Page, type Locator } from '@playwright/test'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
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
let member: SpecUser
let server: SeededServer
const remote = { id: crypto.randomUUID(), username: `trf${Date.now().toString(36)}`, displayName: 'Remote Replier' }
const threadName = `Reply bar ${Date.now().toString(36).slice(-5)}`
const idleName = `Idle thread ${Date.now().toString(36).slice(-5)}`
let threadId: string
let idleThreadId: string
const remoteText = `from afar ${crypto.randomUUID().slice(0, 6)}`
const localText = `from here ${crypto.randomUUID().slice(0, 6)}`

async function createThread(name: string): Promise<string> {
  const client = await userClient(owner)
  const { data, error } = await client.rpc('create_channel_thread', {
    p_channel_id: server.generalChannelId, p_name: name, p_auto_archive_duration: 1440,
  })
  if (error || !data) throw new Error(`thread ${name}: ${error?.message}`)
  return data as string
}

async function seedThreadMessage(id: string, userId: string, text: string, minutesAgo: number): Promise<void> {
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    thread_id: id,
    user_id: userId,
    content: [{ type: 'text', text }],
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  })
  if (error) throw new Error(`message ${text}: ${error.message}`)
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'trfo')
  member = await createUser(admin, 'trfm')
  server = await seedServer(admin, owner, `Threads ${owner.username.slice(-6)}`)
  const fed = await admin.from('servers').update({ federation_enabled: true }).eq('id', server.id)
  if (fed.error) throw new Error(fed.error.message)
  await addMember(admin, member, server.id)
  const { error: profileError } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: remote.displayName,
    domain: DOMAIN,
    is_local: false,
    federated_id: `https://${DOMAIN}/users/${remote.username}`,
    inbox_url: `https://${DOMAIN}/users/${remote.username}/inbox`,
  })
  if (profileError) throw new Error(`remote profile: ${profileError.message}`)
  const { error: memberError } = await admin.from('user_servers').insert({
    server_id: server.id, user_id: remote.id, status: 'accepted', member_instance: DOMAIN,
  })
  if (memberError) throw new Error(`remote membership: ${memberError.message}`)

  threadId = await createThread(threadName)
  await seedThreadMessage(threadId, remote.id, remoteText, 3)
  await seedThreadMessage(threadId, member.id, localText, 2)

  idleThreadId = await createThread(idleName)
  await seedThreadMessage(idleThreadId, member.id, `idle ${crypto.randomUUID().slice(0, 6)}`, 3 * 24 * 60)
  const old = new Date(Date.now() - 3 * 24 * 3600_000).toISOString()
  const idle = await admin.from('threads').update({ last_message_at: old, created_at: old }).eq('id', idleThreadId)
  if (idle.error) throw new Error(`idle thread: ${idle.error.message}`)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

/** The row whose own body holds `text`; a reply to it holds the text in its reply preview. */
const rowIn = (scope: Locator, text: string) =>
  scope.locator('[data-testid="message-list"]').getByRole('article')
    .filter({ has: scope.page().locator('[id^="msg-body-"]', { hasText: text }) })

async function openThreadPanel(page: Page, name: string): Promise<Locator> {
  await page.locator('.chat-header .threads-btn').click()
  const modal = page.locator('.threads-modal')
  await expect(modal).toBeVisible({ timeout: 15000 })
  await modal.locator('.thread-item').filter({ has: page.locator('.thread-name', { hasText: name }) }).click()
  const panel = page.locator('.thread-panel')
  await expect(panel.locator('.thread-info h3')).toHaveText(name, { timeout: 15000 })
  return panel
}

/** Clicks Reply on the row holding `text`; returns the composer's reply bar. */
async function replyTo(page: Page, scope: Locator, text: string): Promise<Locator> {
  const row = rowIn(scope, text)
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.hover()
  await row.getByTestId('msg-action-reply').click()
  const bar = scope.locator('.replyBar')
  await expect(bar).toBeVisible()
  return bar
}

async function expectReplyBar(bar: Locator, name: string): Promise<void> {
  await expect(bar).toContainText(name, { timeout: 15000 })
  await expect(bar).not.toContainText('Deleted User')
  await expect(bar).not.toContainText('Unknown User')
}

async function latestReply(text: string): Promise<{ reply_to: string | null; thread_id: string | null } | null> {
  const { data } = await admin.from('messages').select('reply_to, thread_id')
    .eq('user_id', owner.id).eq('channel_id', server.generalChannelId)
    .filter('content->0->>text', 'eq', text).maybeSingle()
  return data
}

async function messageId(text: string): Promise<string> {
  const { data } = await admin.from('messages').select('id').filter('content->0->>text', 'eq', text).single()
  return data!.id as string
}

async function sendReplyAndCheck(page: Page, scope: Locator, replied: string, text: string): Promise<void> {
  const input = scope.locator('[data-testid="message-input"] [contenteditable="true"]').first()
  await input.click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  const repliedId = await messageId(replied)
  await expect.poll(() => latestReply(text), { timeout: 15000 }).toEqual({ reply_to: repliedId, thread_id: threadId })
  await expect(rowIn(scope, text).locator('.reply-reference')).toContainText(replied.split(' ')[0])
}

test('the side panel names the author of the message replied to', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const panel = await openThreadPanel(page, threadName)

  await test.step('a member of another instance', async () => {
    const bar = await replyTo(page, panel, remoteText)
    await expectReplyBar(bar, remote.displayName)
    await sendReplyAndCheck(page, panel, remoteText, `panel to remote ${crypto.randomUUID().slice(0, 6)}`)
  })

  await test.step('a local member', async () => {
    const bar = await replyTo(page, panel, localText)
    await expectReplyBar(bar, member.displayName)
    await sendReplyAndCheck(page, panel, localText, `panel to local ${crypto.randomUUID().slice(0, 6)}`)
  })
})

test('the full thread view names the author of the message replied to', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await page.locator('.channel-thread-item').filter({ hasText: threadName }).click()
  await page.waitForURL(new RegExp(`/chat/${server.id}/thread/${threadId}$`), { timeout: 15000 })
  const view = page.locator('.thread-full-view')
  await expect(view.locator('.thread-title')).toHaveText(threadName, { timeout: 15000 })

  const bar = await replyTo(page, view, remoteText)
  await expectReplyBar(bar, remote.displayName)
  await sendReplyAndCheck(page, view, remoteText, `full to remote ${crypto.randomUUID().slice(0, 6)}`)
})

test('the side panel opens the full thread view', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('an active thread', async () => {
    const panel = await openThreadPanel(page, threadName)
    await panel.getByTestId('thread-open-full-view').click()
    await page.waitForURL(new RegExp(`/chat/${server.id}/thread/${threadId}$`), { timeout: 15000 })
    await expect(page.locator('.thread-full-view .thread-title')).toHaveText(threadName, { timeout: 15000 })
    await expect(page.locator('.thread-panel')).toHaveCount(0)
  })

  await test.step('a thread past its auto-archive time, absent from the sidebar', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await expect(page.locator('.channel-thread-item').filter({ hasText: threadName })).toHaveCount(1, { timeout: 15000 })
    await expect(page.locator('.channel-thread-item').filter({ hasText: idleName })).toHaveCount(0)
    const panel = await openThreadPanel(page, idleName)
    await panel.getByTestId('thread-open-full-view').click()
    await page.waitForURL(new RegExp(`/chat/${server.id}/thread/${idleThreadId}$`), { timeout: 15000 })
    await expect(page.locator('.thread-full-view .thread-title')).toHaveText(idleName, { timeout: 15000 })
  })
})
