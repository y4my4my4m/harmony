// Journey: links to a channel, thread or message on this instance read as references, with the
// viewer's own access. A thread link and a link to a message in a thread show the channel and the
// thread; a click opens it. A channel message linked from another server shows its channel. A link
// to a place the viewer cannot read stays a plain URL and names nothing.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addMember,
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
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
const marker = Date.now().toString(36).slice(-6)
const threadName = `Thread ${marker}`
let owner: SpecUser
let member: SpecUser
let home: SeededServer
let secret: SeededServer
let threadId = ''
let threadMessageId = ''
let channelMessageId = ''
let secretThreadId = ''

async function insert(channelId: string, userId: string, text: string, threadRef?: string, content?: unknown): Promise<string> {
  const { data, error } = await admin.from('messages').insert({
    channel_id: channelId,
    user_id: userId,
    content: content ?? [{ type: 'text', text }],
    ...(threadRef ? { thread_id: threadRef } : {}),
  }).select('id').single()
  if (error) throw new Error(`message: ${error.message}`)
  return data.id as string
}

const urlPart = (url: string) => ({ type: 'url', url })

test.beforeAll(async () => {
  owner = await createUser(admin, 'clc')
  member = await createUser(admin, 'clm')
  home = await seedServer(admin, owner, `Home ${marker}`)
  secret = await seedServer(admin, owner, `Secret ${marker}`)
  await addMember(admin, member, home.id)

  const client = await userClient(owner)
  const made = await client.rpc('create_channel_thread', { p_channel_id: home.generalChannelId, p_name: threadName, p_auto_archive_duration: 1440 })
  if (made.error) throw new Error(made.error.message)
  threadId = made.data as string
  threadMessageId = await insert(home.generalChannelId, owner.id, `in the thread ${marker}`, threadId)
  channelMessageId = await insert(home.generalChannelId, owner.id, `in the channel ${marker}`)

  const hidden = await client.rpc('create_channel_thread', { p_channel_id: secret.generalChannelId, p_name: `Hidden ${marker}`, p_auto_archive_duration: 1440 })
  if (hidden.error) throw new Error(hidden.error.message)
  secretThreadId = hidden.data as string

  await insert(home.generalChannelId, owner.id, '', undefined, [
    { type: 'text', text: 'thread link ' },
    urlPart(`${BASE_URL}/chat/${home.id}/thread/${threadId}`),
  ])
  await insert(home.generalChannelId, owner.id, '', undefined, [
    { type: 'text', text: 'thread message link ' },
    urlPart(`${BASE_URL}/chat/${home.id}/thread/${threadId}?messageId=${threadMessageId}`),
  ])
  await insert(home.generalChannelId, owner.id, '', undefined, [
    { type: 'text', text: 'hidden link ' },
    urlPart(`${BASE_URL}/chat/${secret.id}/thread/${secretThreadId}`),
  ])
  await insert(home.generalChannelId, owner.id, '', undefined, [
    { type: 'text', text: 'hidden channel link ' },
    urlPart(`${BASE_URL}/chat/${secret.id}/${secret.generalChannelId}`),
  ])
  await insert(secret.generalChannelId, owner.id, '', undefined, [
    { type: 'text', text: 'across servers ' },
    urlPart(`${BASE_URL}/chat/${home.id}/${home.generalChannelId}?messageId=${channelMessageId}`),
  ])
})

test.afterAll(async () => {
  await admin.from('servers').delete().in('id', [home?.id, secret?.id].filter(Boolean))
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

const row = (page: Page, text: string) =>
  messageList(page).locator('.message-item').filter({ hasText: text })

test('a thread link reads as channel and thread, and opens the thread', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, home.id, home.generalChannelId)
  const chip = row(page, 'thread link').first().getByTestId('chat-link')
  await expect(chip).toHaveText(`#general › ${threadName}`, { timeout: 30000 })
  await expect(row(page, 'thread link').first().locator('a.url-link')).toHaveCount(0)
  await chip.click()
  await expect(page).toHaveURL(new RegExp(`/chat/${home.id}/thread/${threadId}$`))
  await expect(page.locator('.thread-full-view .thread-title')).toHaveText(threadName, { timeout: 30000 })
})

test('a link to a message in a thread opens at that message', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, home.id, home.generalChannelId)
  const chip = row(page, 'thread message link').getByTestId('chat-link')
  await expect(chip).toHaveText(`#general › ${threadName}`, { timeout: 30000 })
  await chip.click()
  await expect(page).toHaveURL(new RegExp(`/chat/${home.id}/thread/${threadId}`))
  await expect(page.locator(`[data-message-id="${threadMessageId}"]`)).toBeInViewport({ timeout: 30000 })
})

test('a link to a place the viewer cannot read stays a plain URL', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, member)
  await openChannel(page, home.id, home.generalChannelId)
  await expect(row(page, 'thread link').first().getByTestId('chat-link')).toBeVisible({ timeout: 30000 })
  const hidden = row(page, 'hidden link')
  await expect(hidden.locator('a.url-link')).toBeVisible()
  await expect(hidden.getByTestId('chat-link')).toHaveCount(0)
  await expect(hidden).not.toContainText(`Hidden ${marker}`)
  const hiddenChannel = row(page, 'hidden channel link')
  await expect(hiddenChannel.locator('a.url-link')).toBeVisible()
  await expect(hiddenChannel.getByTestId('chat-link')).toHaveCount(0)
})

test('a message link from another server reads as its channel', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, secret.id, secret.generalChannelId)
  const chip = row(page, 'across servers').getByTestId('chat-link')
  await expect(chip).toHaveText('#general', { timeout: 30000 })
  await chip.click()
  await expect(page).toHaveURL(new RegExp(`/chat/${home.id}/${home.generalChannelId}`))
  await expect(page.locator(`[data-message-id="${channelMessageId}"]`)).toBeInViewport({ timeout: 30000 })
})
