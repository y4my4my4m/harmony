// Journey: a channel opened at the "New messages" divider follows the end when the landing
// shows it. A short channel lands on the divider and the end at once, and messages that
// arrive afterwards keep the view at the bottom without a manual scroll.
//
// No realtime in the stack: an arrival is inserted with the admin client and handed to the
// chat store through addMessageToCache, the entry point the realtime INSERT handler calls.

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

const admin = adminClient()
let author: SpecUser
let reader: SpecUser
let server: SeededServer
let lobbyId: string
let authorClient: SupabaseClient

test.beforeAll(async () => {
  author = await createUser(admin, 'dfa')
  reader = await createUser(admin, 'dfb')
  server = await seedServer(admin, author, `Follow ${author.username}`)
  await addMember(admin, reader, server.id)
  lobbyId = await addChannel(admin, server, 'lobby')
  authorClient = await userClient(author)
})

test.afterAll(async () => {
  await deleteUser(admin, author)
  await deleteUser(admin, reader)
})

const list = (page: Page) => page.locator('[data-testid="message-list"]')
const distanceFromBottom = (page: Page) =>
  list(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)

async function post(content: unknown[]) {
  const { error } = await authorClient
    .from('messages')
    .insert({ channel_id: server.generalChannelId, user_id: author.id, content })
  if (error) throw new Error(`post: ${error.message}`)
}

/** Inserts a row and delivers it to the open view the way the realtime handler does. */
async function arrive(page: Page, text: string): Promise<void> {
  const { data, error } = await admin
    .from('messages')
    .insert({ channel_id: server.generalChannelId, user_id: author.id, content: [{ type: 'text', text }] })
    .select('*')
    .single()
  if (error || !data) throw new Error(`insert: ${error?.message}`)
  await page.evaluate((row) => {
    const app = (document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { addMessageToCache: (m: unknown) => void }> } } } } }).__vue_app__
    const chat = app.config.globalProperties.$pinia._s.get('chat')!
    chat.addMessageToCache({ ...row, created_at: new Date(row.created_at), updated_at: row.updated_at ? new Date(row.updated_at) : undefined })
  }, data)
}

test('a short channel opened at the divider follows messages that arrive', async ({ page }) => {
  test.setTimeout(180_000)
  await post([{ type: 'text', text: 'read before' }])
  await signIn(page, reader)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(list(page).getByText('read before')).toBeVisible({ timeout: 30000 })
  await page.waitForTimeout(1500)

  await post([{ type: 'text', text: 'new while away' }])

  // Unread counts load with the lobby; opening #general from the sidebar captures the divider.
  const counted = page.waitForResponse((r) => r.url().includes('/rpc/get_unread_counts'), { timeout: 30000 })
  await page.goto(`/chat/${server.id}/${lobbyId}`)
  await counted
  await page
    .locator(`.channel-sidebar .channel-wrapper[data-channel-id="${server.generalChannelId}"] .channel-item`)
    .click()
  await expect(list(page).locator('.new-messages-divider')).toBeVisible({ timeout: 30000 })
  // Past the landing retries and the catch-up window that follows an open.
  await page.waitForTimeout(3000)
  expect(await distanceFromBottom(page)).toBeLessThanOrEqual(1)

  // Enough arrivals to overflow the view; each keeps the newest in view.
  for (let i = 0; i < 12; i++) {
    const text = `arrival ${i} ` + 'words to fill the line '.repeat(3)
    await arrive(page, text)
    await expect(list(page).getByText(text)).toBeInViewport({ timeout: 10000 })
  }
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1)
})
