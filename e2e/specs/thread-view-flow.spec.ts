// Journey: a thread reads as one scrolling conversation. The starter message sits at the top of
// the list's own scroll, in the side panel and in the full view, so a long thread opens at its
// latest reply with the whole height for replies, and the starter scrolls away. The thread menu
// goes back to the first message and shows the starter in its channel. A short thread shows the
// starter and its replies together, with no gap under the reply count.

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
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
let owner: SpecUser
let server: SeededServer
let parentId = ''
let longThreadId = ''
let shortThreadId = ''
let shortParentId = ''
const marker = Date.now().toString(36).slice(-6)
const parentText = `Starter ${marker} ` + 'a long first message with enough words to take several lines. '.repeat(6)
const shortParentText = `Short starter ${marker}`

async function postMessage(text: string, minutesAgo: number, threadId?: string): Promise<string> {
  const { data, error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: owner.id,
    content: [{ type: 'text', text }],
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    ...(threadId ? { thread_id: threadId } : {}),
  }).select('id').single()
  if (error) throw new Error(`message: ${error.message}`)
  return data.id as string
}

async function startThread(messageId: string, name: string): Promise<string> {
  const client = await userClient(owner)
  const { data, error } = await client.rpc('create_thread', {
    p_message_id: messageId, p_name: name, p_auto_archive_duration: 1440,
  })
  if (error || !data) throw new Error(`thread: ${error?.message}`)
  return data as string
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'tvf')
  server = await seedServer(admin, owner, `Flow ${owner.username.slice(-6)}`)
  parentId = await postMessage(parentText, 300)
  longThreadId = await startThread(parentId, `Long ${marker}`)
  for (let i = 0; i < 40; i++) {
    await postMessage(`reply ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(1 + (i % 4)), 200 - i, longThreadId)
  }
  shortParentId = await postMessage(shortParentText, 100)
  shortThreadId = await startThread(shortParentId, `Short ${marker}`)
  await postMessage(`short reply ${marker}`, 90, shortThreadId)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, owner)
})

const distanceFromBottom = (list: Locator) =>
  list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)

async function openPanel(page: Page, messageText: string): Promise<Locator> {
  await openChannel(page, server.id, server.generalChannelId)
  const row = page.locator('[data-testid="message-list"]').getByRole('article').filter({ hasText: messageText }).first()
  await expect(row).toBeVisible({ timeout: 30000 })
  await row.locator('.thread-indicator').click()
  const panel = page.locator('.thread-panel')
  await expect(panel).toBeVisible({ timeout: 15000 })
  return panel
}

async function expectLayout(scope: Locator) {
  const list = scope.locator('[data-testid="message-list"]')
  const start = list.getByTestId('message-list-start')

  await test.step('the starter sits inside the list scroll, above the rows', async () => {
    await expect(start.getByTestId('thread-parent-message')).toContainText(`Starter ${marker}`, { timeout: 30000 })
    await expect(list.getByRole('article').filter({ hasText: 'reply 39:' })).toBeVisible({ timeout: 30000 })
    await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(1)
    await expect(start.getByTestId('thread-parent-message')).not.toBeInViewport()
  })

  await test.step('Go to first message shows the starter; the rows sit below it', async () => {
    await scope.getByRole('button', { name: /thread options/i }).click()
    await scope.getByTestId('thread-go-to-start').click()
    await expect(start.getByTestId('thread-parent-message')).toBeInViewport()
    await expect(start.getByTestId('thread-parent-message')).toBeFocused()
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0)

    const geometry = await list.evaluate((el) => {
      const startBox = el.querySelector('[data-testid="message-list-start"]')!.getBoundingClientRect()
      const rows = [...el.querySelectorAll('[role="listitem"]')].map((r) => r.getBoundingClientRect())
      const first = rows.reduce((a, b) => (a.top < b.top ? a : b))
      return { startBottom: startBox.bottom, firstRowTop: first.top }
    })
    expect(geometry.firstRowTop).toBeGreaterThanOrEqual(geometry.startBottom - 1)
    expect(geometry.firstRowTop - geometry.startBottom).toBeLessThan(40)
  })

  await test.step('the view stays at the top, and returns to the latest reply', async () => {
    await scope.page().waitForTimeout(800)
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0)
    await scope.getByTestId('jump-to-present').click()
    await expect.poll(() => distanceFromBottom(list)).toBeLessThanOrEqual(1)
  })
}

test('a long thread in the side panel scrolls its starter away and goes back to it', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  const panel = await openPanel(page, `Starter ${marker}`)
  await expectLayout(panel)
})

test('a long thread in the full view does the same', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await page.goto(`/chat/${server.id}/thread/${longThreadId}`)
  await expectLayout(page.locator('.thread-full-view'))
})

test('a short thread shows starter and replies together, with no gap under the count', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, owner)
  const panel = await openPanel(page, shortParentText)
  const list = panel.locator('[data-testid="message-list"]')
  await expect(list.getByTestId('thread-parent-message')).toBeInViewport({ timeout: 30000 })
  const reply = list.getByRole('article').filter({ hasText: `short reply ${marker}` })
  await expect(reply).toBeInViewport({ timeout: 30000 })

  const gap = await list.evaluate((el) => {
    const count = el.querySelector('.reply-count')!.getBoundingClientRect()
    const row = el.querySelector('[role="listitem"]')!.getBoundingClientRect()
    return row.top - count.bottom
  })
  expect(gap).toBeLessThan(24)

  expect(await list.evaluate((el) => el.closest('.thread-messages')!.scrollHeight <= el.closest('.thread-messages')!.clientHeight)).toBe(true)
})

test('Show in channel opens the starter in its channel', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, owner)
  const panel = await openPanel(page, shortParentText)
  await panel.getByRole('button', { name: /thread options/i }).click()
  await panel.getByTestId('thread-show-in-channel').click()
  await expect(page.locator('.thread-panel')).toHaveCount(0)
  await expect(page.locator(`[data-message-id="${shortParentId}"]`)).toBeInViewport({ timeout: 30000 })
})
