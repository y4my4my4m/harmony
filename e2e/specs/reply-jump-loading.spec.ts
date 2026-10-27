// Journey: clicking the reply preview of a reply to an old message, one outside the loaded
// rows, answers at once: the list scrolls toward its top, where a loading placeholder shows
// while the messages around the target load, then lands on the target and highlights it.
// The message requests are held until the placeholder and the scroll have been seen.
//
// The owner posts: automod spares the owner's bursts. created_at orders the rows.

import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
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
let server: SeededServer

const SEEDED = 300
const REPLY_SEQ = 290
const REPLIED_SEQ = 60
const ids: string[] = []

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
})

test.afterAll(async () => {
  await deleteUser(admin, user)
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
