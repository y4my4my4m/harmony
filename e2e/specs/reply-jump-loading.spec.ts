// Journey: clicking the reply preview of a reply to an old message, one outside the loaded
// rows, answers at once: the list scrolls toward its top, where a loading placeholder shows
// while the messages around the target load, then lands on the target and highlights it.
// The message requests are held until the placeholder and the scroll have been seen.
// A jump whose target cannot load returns the list to where it was read, at the end or at the
// same offset. A target from a blocked account, or one reported and hidden, is loaded: the jump
// lands on its placeholder.
//
// The owner posts: automod spares the owner's bursts. created_at orders the rows.

import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  addChannel,
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let user: SpecUser
let blocked: SpecUser
let server: SeededServer
let placeholderChannelId: string

const SEEDED = 300
const REPLY_SEQ = 290
const REPLIED_SEQ = 60
const ids: string[] = []
const PLACEHOLDER_ROWS = 45
const BLOCKED_SEQ = 15
const REPORTED_SEQ = 20
const BLOCKED_REPLY_SEQ = 42
const REPORTED_REPLY_SEQ = 43
const placeholderIds: string[] = []

test.beforeAll(async () => {
  user = await createUser(admin, 'rjload')
  server = await seedServer(admin, user, `Reply jump ${user.username.slice(-6)}`)
  const base = Date.now() - 2 * 24 * 3600_000
  for (let i = 0; i < SEEDED; i++) ids.push(randomUUID())
  const rows = ids.map((id, i) => ({
    id,
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: `seq ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(1 + (i % 4)) }],
    created_at: new Date(base + i * 60_000).toISOString(),
    ...(i === REPLY_SEQ ? { reply_to: ids[REPLIED_SEQ] } : {}),
  }))
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await admin.from('messages').insert(rows.slice(i, i + 100))
    if (error) throw new Error(`seed messages: ${error.message}`)
  }

  // One page of rows: a blocked account's message, and the owner's own one reported and hidden,
  // each answered near the end.
  blocked = await createUser(admin, 'rjblk')
  await addMember(admin, blocked, server.id)
  const block = await admin.from('user_blocks').insert({ blocker_id: user.id, blocked_user_id: blocked.id })
  if (block.error) throw new Error(`block: ${block.error.message}`)
  placeholderChannelId = await addChannel(admin, server, 'placeholders')
  for (let i = 0; i < PLACEHOLDER_ROWS; i++) placeholderIds.push(randomUUID())
  const placeholderRows = placeholderIds.map((id, i) => ({
    id,
    channel_id: placeholderChannelId,
    user_id: i === BLOCKED_SEQ ? blocked.id : user.id,
    content: [{ type: 'text', text: `row ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(1 + (i % 4)) }],
    created_at: new Date(base + i * 60_000).toISOString(),
    ...(i === BLOCKED_REPLY_SEQ ? { reply_to: placeholderIds[BLOCKED_SEQ] } : {}),
    ...(i === REPORTED_REPLY_SEQ ? { reply_to: placeholderIds[REPORTED_SEQ] } : {}),
  }))
  const { error } = await admin.from('messages').insert(placeholderRows)
  if (error) throw new Error(`seed placeholder rows: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
  await deleteUser(admin, blocked)
})

const row = (page: Page, i: number) => messageList(page).locator(`.message-item[data-message-id="${ids[i]}"]`)
const scrollTop = (page: Page) => messageList(page).evaluate((el) => el.scrollTop)

test('a reply to an old message shows a placeholder at once and lands when it loads', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(row(page, SEEDED - 1)).toBeVisible({ timeout: 30000 })
  await expect(row(page, REPLY_SEQ)).toBeVisible()
  await expect(row(page, REPLIED_SEQ)).toHaveCount(0)

  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/rest/v1/messages*', async (route) => {
    if (route.request().method() === 'GET') await held
    await route.fallback()
  })

  const before = await scrollTop(page)
  expect(before).toBeGreaterThan(400)
  const placeholder = page.getByTestId('jump-loading')

  await test.step('the click answers at once: placeholder, and the list moves toward its top', async () => {
    await row(page, REPLY_SEQ).locator('.reply-reference').click()
    await expect.poll(() => scrollTop(page), { timeout: 2000 }).toBeLessThan(50)
    await expect(placeholder).toBeInViewport()
    await expect(placeholder).toHaveRole('status')
    await expect(placeholder).toContainText('Loading the message')
    await expect(row(page, REPLIED_SEQ)).toHaveCount(0)
  })

  await test.step('the placeholder stays while the messages are held', async () => {
    await page.waitForTimeout(800)
    await expect(placeholder).toBeVisible()
  })

  await test.step('the target lands highlighted once the messages arrive', async () => {
    release()
    await expect(row(page, REPLIED_SEQ)).toBeInViewport({ timeout: 15000 })
    await expect(row(page, REPLIED_SEQ)).toHaveClass(/highlighted/)
    await expect(placeholder).toHaveCount(0)
  })

  await test.step('back at the present, the same reply jumps again', async () => {
    await page.unroute('**/rest/v1/messages*')
    await page.getByTestId('history-jump-present').click()
    await expect(row(page, SEEDED - 1)).toBeInViewport({ timeout: 15000 })
    await expect(row(page, REPLY_SEQ)).toBeVisible()
    // The target is outside the newest page again: the placeholder shows until it lands.
    const seen = page.waitForSelector('[data-testid="jump-loading"]', { timeout: 5000 })
    await row(page, REPLY_SEQ).locator('.reply-reference').click()
    await seen
    await expect(row(page, REPLIED_SEQ)).toBeInViewport({ timeout: 15000 })
    await expect(placeholder).toHaveCount(0)
  })
})

async function openGeneral(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(row(page, SEEDED - 1)).toBeVisible({ timeout: 30000 })
  await expect(row(page, REPLY_SEQ)).toBeVisible()
  await expect(row(page, REPLIED_SEQ)).toHaveCount(0)
}

/** Fails the message reads once the list has reached its top: the target cannot load. */
async function failMessageReads(page: Page): Promise<() => void> {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/rest/v1/messages*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await held
    await route.fulfill({ status: 500, json: { message: 'unavailable' } })
  })
  return release
}

const bottomGap = (page: Page) => messageList(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)

test('a jump that cannot load returns a list read at its end to its end', async ({ page }) => {
  test.setTimeout(120_000)
  await openGeneral(page)
  await expect.poll(() => bottomGap(page)).toBeLessThan(5)
  const release = await failMessageReads(page)

  await row(page, REPLY_SEQ).locator('.reply-reference').click()
  await expect.poll(() => scrollTop(page), { timeout: 2000 }).toBeLessThan(50)
  release()

  await expect(page.getByText('That message couldn\'t be loaded.')).toBeVisible({ timeout: 10000 })
  await expect.poll(() => bottomGap(page), { timeout: 5000 }).toBeLessThan(5)
  await expect(row(page, SEEDED - 1)).toBeInViewport()
  await expect(page.getByTestId('jump-loading')).toHaveCount(0)
})

test('a jump that cannot load returns a list read mid-way to the same place', async ({ page }) => {
  test.setTimeout(120_000)
  await openGeneral(page)
  await messageList(page).evaluate((el) => { el.scrollTop -= 250 })
  await expect.poll(() => bottomGap(page)).toBeGreaterThan(200)
  await expect(row(page, REPLY_SEQ).locator('.reply-reference')).toBeInViewport()
  const before = await scrollTop(page)
  const release = await failMessageReads(page)

  await row(page, REPLY_SEQ).locator('.reply-reference').click()
  await expect.poll(() => scrollTop(page), { timeout: 2000 }).toBeLessThan(50)
  release()

  await expect(page.getByText('That message couldn\'t be loaded.')).toBeVisible({ timeout: 10000 })
  await expect.poll(async () => Math.abs((await scrollTop(page)) - before), { timeout: 5000 }).toBeLessThan(3)
  await expect(row(page, REPLY_SEQ)).toBeInViewport()
})

const placeholderRow = (page: Page, i: number) => messageList(page).locator(`.message-item[data-message-id="${placeholderIds[i]}"]`)

test('a reply to a blocked or hidden message lands on its placeholder', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await signIn(page, user)
  // Reported messages are hidden from this browser's own list.
  await page.evaluate((id) => localStorage.setItem('harmony_reported_messages', JSON.stringify([id])), placeholderIds[REPORTED_SEQ])
  await page.goto(`/chat/${server.id}/${placeholderChannelId}`)
  await dismissAnnouncements(page)
  await expect(placeholderRow(page, PLACEHOLDER_ROWS - 1)).toBeVisible({ timeout: 30000 })
  const blockedGroup = messageList(page).locator(`[data-row-key="blocked-${placeholderIds[BLOCKED_SEQ]}"]`)
  const reportedRow = messageList(page).locator(`[data-row-key="reported-${placeholderIds[REPORTED_SEQ]}"]`)
  // The block is known before the click: the target is a placeholder, not a message row.
  await expect.poll(() => page.evaluate((id) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { blockedUsers?: Set<string> }> } } } }
    }
    return root.__vue_app__.config.globalProperties.$pinia._s.get('activitypub')?.blockedUsers?.has(id) ?? false
  }, blocked.id), { timeout: 15000 }).toBe(true)

  await test.step('the blocked account\'s message: the list lands on the blocked placeholder', async () => {
    await placeholderRow(page, BLOCKED_REPLY_SEQ).locator('.reply-reference').click()
    await expect(blockedGroup).toBeInViewport({ timeout: 5000 })
    await page.waitForTimeout(1200)
    await expect(blockedGroup).toBeInViewport()
    await expect(placeholderRow(page, BLOCKED_SEQ)).toHaveCount(0)
    expect(await scrollTop(page)).toBeGreaterThan(100)
    await expect(page.getByTestId('jump-loading')).toHaveCount(0)
  })

  await test.step('the hidden reported message: the list lands on its placeholder', async () => {
    await messageList(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(placeholderRow(page, REPORTED_REPLY_SEQ)).toBeInViewport({ timeout: 5000 })
    await placeholderRow(page, REPORTED_REPLY_SEQ).locator('.reply-reference').click()
    await expect(reportedRow).toBeInViewport({ timeout: 5000 })
    await page.waitForTimeout(1200)
    await expect(reportedRow).toBeInViewport()
    await expect(placeholderRow(page, REPORTED_SEQ)).toHaveCount(0)
    expect(await scrollTop(page)).toBeGreaterThan(100)
  })
})
