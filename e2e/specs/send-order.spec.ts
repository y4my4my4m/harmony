// Journey: a burst of sends is stored, and shown to the sender, in the order it was typed,
// however the requests race. messages.created_at is the server clock when an insert arrives;
// the first insert is held 1.5 s at the network, as a slow request from far away would be,
// while the next two are typed and sent.

import { test, expect, type Page, type Route } from '@playwright/test'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  sendMessage,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let partner: SpecUser
let server: SeededServer
let conversationId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'ordo')
  partner = await createUser(admin, 'ordp')
  server = await seedServer(admin, owner, `Send order ${owner.username}`)
  const { data, error } = await admin
    .from('conversations')
    .insert({ type: 'direct', created_by: owner.id })
    .select('id')
    .single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  conversationId = data.id
  await admin.from('conversation_participants').insert([
    { conversation_id: conversationId, user_id: owner.id },
    { conversation_id: conversationId, user_id: partner.id },
  ])
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, partner)
})

const HOLD_MS = 1500

/** Holds the next message insert HOLD_MS before letting it through; the rest pass at once. */
async function holdFirstInsert(page: Page): Promise<void> {
  let held = false
  await page.route('**/rest/v1/messages*', async (route: Route) => {
    if (route.request().method() !== 'POST' || held) return route.continue()
    held = true
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS))
    await route.continue()
  })
}

async function sendBurst(page: Page, texts: string[]): Promise<void> {
  for (const text of texts) {
    await composer(page).click()
    await composer(page).pressSequentially(text, { delay: 5 })
    await page.keyboard.press('Enter')
  }
  for (const text of texts) {
    const row = messageList(page).locator('.message-item').filter({ hasText: text })
    await expect(row).toHaveCount(1, { timeout: 30000 })
    await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  }
}

/** Texts of the rows the list shows among `texts`, top to bottom. */
async function shownOrder(page: Page, texts: string[]): Promise<string[]> {
  const items = await messageList(page).locator('.message-item').allInnerTexts()
  return items.map((item) => texts.find((t) => item.includes(t))).filter((t): t is string => !!t)
}

async function storedOrder(column: 'channel_id' | 'conversation_id', id: string, texts: string[]): Promise<string[]> {
  const { data, error } = await admin
    .from('messages')
    .select('content, created_at')
    .eq(column, id)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`stored rows: ${error.message}`)
  return (data ?? [])
    .map((row) => JSON.stringify(row.content))
    .map((content) => texts.find((t) => content.includes(t)))
    .filter((t): t is string => !!t)
}

test('a burst in a channel is stored and shown in typed order while the first insert is slow', async ({ page }) => {
  test.setTimeout(120_000)
  const texts = ['one', 'two', 'three'].map((n) => `${n} ${owner.username}`)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await sendMessage(page, `warm-up ${owner.username}`)

  await holdFirstInsert(page)
  await sendBurst(page, texts)

  expect(await storedOrder('channel_id', server.generalChannelId, texts)).toEqual(texts)
  expect(await shownOrder(page, texts)).toEqual(texts)
})

test('a burst in a DM is stored and shown in typed order while the first insert is slow', async ({ page }) => {
  test.setTimeout(120_000)
  const texts = ['uno', 'dos', 'tres'].map((n) => `${n} ${owner.username}`)
  await signIn(page, owner)
  await page.goto(`/dm/${conversationId}`)
  await expect(messageList(page)).toBeVisible({ timeout: 30000 })
  await sendMessage(page, `dm warm-up ${owner.username}`)

  await holdFirstInsert(page)
  await sendBurst(page, texts)

  expect(await storedOrder('conversation_id', conversationId, texts)).toEqual(texts)
  expect(await shownOrder(page, texts)).toEqual(texts)
})

test('a burst of thread replies is stored and shown in typed order, none dropped', async ({ page }) => {
  test.setTimeout(150_000)
  const texts = ['ichi', 'ni', 'san'].map((n) => `${n} ${owner.username}`)
  const panel = page.locator('.thread-panel')
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await page.locator('.chat-header .threads-btn').click()
  const modal = page.locator('.threads-modal')
  await expect(modal).toBeVisible({ timeout: 15000 })
  await modal.locator('.new-thread-btn').click()
  await modal.locator('#new-thread-name').fill(`Order ${owner.username.slice(-4)}`)
  const created = page.waitForResponse((r) => r.url().includes('/rpc/create_channel_thread'))
  await modal.locator('.new-thread-submit').click()
  const threadId = (await (await created).json()) as string
  await expect(panel).toBeVisible({ timeout: 15000 })

  await holdFirstInsert(page)
  const input = panel.locator('[data-testid="message-input"] .rich-text-editor')
  for (const text of texts) {
    await input.click()
    await input.pressSequentially(text, { delay: 5 })
    await page.keyboard.press('Enter')
  }
  const list = panel.locator('[data-testid="message-list"]')
  for (const text of texts) {
    const row = list.locator('.message-item').filter({ hasText: text })
    await expect(row).toHaveCount(1, { timeout: 30000 })
    await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  }

  const { data, error } = await admin
    .from('messages')
    .select('content, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`stored replies: ${error.message}`)
  const stored = (data ?? []).map((row) => texts.find((t) => JSON.stringify(row.content).includes(t))).filter(Boolean)
  expect(stored).toEqual(texts)
  const items = await list.locator('.message-item').allInnerTexts()
  expect(items.map((item) => texts.find((t) => item.includes(t))).filter(Boolean)).toEqual(texts)
})
