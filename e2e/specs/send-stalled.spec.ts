// Journey: a send whose insert gets no answer turns failed after a bounded wait, with Retry
// and Delete, and is stored at most once. The stalled request is not cancelled, so the server
// may still store it later: that late message becomes the row when nothing else was sent,
// and is deleted when Retry already stored the message or the row was deleted. Retry first
// looks the message up by its client_nonce, so an insert stored without an answer is not
// sent twice.
//
// The insert is held with page.route and never answered until a step releases it, as a hung
// connection or an overloaded API leaves it. The stack runs no realtime, so the late answer
// to the held request is the client's only news of it.

import { test, expect, type Page, type Route } from '@playwright/test'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer

// The client's wait (SEND_STALL_MS, 15 s) plus margin.
const STALL_SEEN_MS = 30_000

test.beforeAll(async () => {
  owner = await createUser(admin, 'stall')
  server = await seedServer(admin, owner, `Stall ${owner.username}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

/** Holds the first message insert whose body carries `text`; later ones pass. */
async function holdFirstInsert(page: Page, text: string): Promise<{ held: () => Route | null; inserts: () => number }> {
  let held: Route | null = null
  let inserts = 0
  await page.route('**/rest/v1/messages*', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST' || !(request.postData() ?? '').includes(text)) return route.continue()
    inserts++
    if (held) return route.continue()
    held = route
  })
  return { held: () => held, inserts: () => inserts }
}

async function typeAndSend(page: Page, text: string) {
  await composer(page).click()
  await composer(page).pressSequentially(text, { delay: 10 })
  await page.keyboard.press('Enter')
}

/** Stored, undeleted rows of the channel whose first part is `text`. */
async function storedCount(text: string): Promise<number> {
  const { count, error } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('channel_id', server.generalChannelId)
    .eq('is_deleted', false)
    .eq('content->0->>text', text)
  if (error) throw new Error(`count: ${error.message}`)
  return count ?? 0
}

const rowsWith = (page: Page, text: string) => messageList(page).locator('.message-item').filter({ hasText: text })

test('a stalled send fails with Retry and Delete; Retry stores it once', async ({ page }) => {
  test.setTimeout(150_000)
  const text = `stalled retry ${owner.username}`
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const hold = await holdFirstInsert(page, text)

  await typeAndSend(page, text)
  const row = rowsWith(page, text)
  await expect(row).toHaveClass(/is-sending/, { timeout: 10000 })

  await test.step('an unsent row offers no actions that need the stored message', async () => {
    await row.hover()
    await expect(row.locator('[data-testid="msg-action-delete"]')).toHaveCount(0)
    await expect(row.locator('[data-testid="msg-action-more"]')).toHaveCount(0)
    await expect(row.locator('[data-testid="msg-action-reply"]')).toHaveCount(0)
  })

  await test.step('the wait ends in the failed state', async () => {
    await expect(row.locator('.failed-message-bar')).toBeVisible({ timeout: STALL_SEEN_MS })
    await expect(row).toHaveClass(/is-failed/)
    await expect(row.locator('.failed-message-bar .retry-btn')).toBeVisible()
    await expect(row.locator('.failed-message-bar .discard-btn')).toBeVisible()
    expect(hold.inserts()).toBe(1)
  })

  await test.step('Retry sends it, and it is stored once', async () => {
    await row.locator('.failed-message-bar .retry-btn').click()
    await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    await expect(row.locator('.failed-message-bar')).toHaveCount(0)
    await expect(rowsWith(page, text)).toHaveCount(1)
    expect(await storedCount(text)).toBe(1)
  })
})

test('an insert answered after the wait becomes the message, with nothing sent again', async ({ page }) => {
  test.setTimeout(150_000)
  const text = `stalled late ${owner.username}`
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const hold = await holdFirstInsert(page, text)

  await typeAndSend(page, text)
  const row = rowsWith(page, text)
  await expect(row.locator('.failed-message-bar')).toBeVisible({ timeout: STALL_SEEN_MS })

  await hold.held()!.continue()
  await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  await expect(row.locator('.failed-message-bar')).toHaveCount(0)
  await expect(rowsWith(page, text)).toHaveCount(1)
  expect(hold.inserts()).toBe(1)
  expect(await storedCount(text)).toBe(1)
})

test('a stalled insert landing after Retry stored the message is deleted', async ({ page }) => {
  test.setTimeout(150_000)
  const text = `stalled twice ${owner.username}`
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const hold = await holdFirstInsert(page, text)

  await typeAndSend(page, text)
  const row = rowsWith(page, text)
  await expect(row.locator('.failed-message-bar')).toBeVisible({ timeout: STALL_SEEN_MS })
  await row.locator('.failed-message-bar .retry-btn').click()
  await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  expect(hold.inserts()).toBe(2)

  const keptId = await row.getAttribute('data-message-id')
  const { data: kept } = await admin.from('messages').select('metadata').eq('id', keptId!).single()
  const nonce = (kept?.metadata as { client_nonce?: string } | null)?.client_nonce
  expect(nonce).toBeTruthy()

  await hold.held()!.continue()
  // The late copy is stored, then deleted; the kept one stays.
  const copies = async () => {
    const { data } = await admin
      .from('messages')
      .select('id, is_deleted')
      .eq('channel_id', server.generalChannelId)
      .eq('metadata->>client_nonce', nonce!)
    return (data ?? []).map((m) => `${m.id === keptId ? 'kept' : 'late'}:${m.is_deleted ? 'deleted' : 'live'}`).sort()
  }
  await expect.poll(copies, { timeout: 30000 }).toEqual(['kept:live', 'late:deleted'])
  expect(await storedCount(text)).toBe(1)
  await expect(rowsWith(page, text)).toHaveCount(1)
})

test('a stalled send deleted from its failed row is deleted when it lands', async ({ page }) => {
  test.setTimeout(150_000)
  const text = `stalled deleted ${owner.username}`
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const hold = await holdFirstInsert(page, text)

  await typeAndSend(page, text)
  const row = rowsWith(page, text)
  await expect(row.locator('.failed-message-bar')).toBeVisible({ timeout: STALL_SEEN_MS })
  await row.locator('.failed-message-bar .discard-btn').click()
  await expect(rowsWith(page, text)).toHaveCount(0)

  const deleted = page.waitForRequest((r) => r.method() === 'PATCH' && r.url().includes('/rest/v1/messages'), { timeout: 30000 })
  await hold.held()!.continue()
  await deleted
  await expect.poll(() => storedCount(text), { timeout: 30000 }).toBe(0)
  await expect(rowsWith(page, text)).toHaveCount(0)
})

test('Retry finds a stalled send the server stored and does not send it again', async ({ page }) => {
  test.setTimeout(150_000)
  const text = `stalled stored ${owner.username}`
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const hold = await holdFirstInsert(page, text)

  await typeAndSend(page, text)
  const row = rowsWith(page, text)
  await expect(row.locator('.failed-message-bar')).toBeVisible({ timeout: STALL_SEEN_MS })
  // The server stores the held insert; its answer never reaches the page.
  const stored = await hold.held()!.fetch()
  expect(stored.ok()).toBe(true)
  expect(await storedCount(text)).toBe(1)

  await row.locator('.failed-message-bar .retry-btn').click()
  await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  await expect(row.locator('.failed-message-bar')).toHaveCount(0)
  expect(hold.inserts()).toBe(1)
  expect(await storedCount(text)).toBe(1)
  await expect(rowsWith(page, text)).toHaveCount(1)
})
