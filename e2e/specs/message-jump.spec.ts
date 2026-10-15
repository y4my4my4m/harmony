// Journey: a search result or a reply far up the history opens the messages
// around it, as Discord's does. The rows around the target replace the list,
// detached from the present: the bar at the bottom says so, scrolling down loads
// the following messages in order until the newest, and Jump to present returns
// to the newest page. The view takes the target out of the URL, so the same
// result opened twice jumps twice.
//
// No realtime in the stack: every arrival here is the user's own send.

import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import {
  adminClient,
  composer,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  seedServer,
  sendMessage,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer

const SEEDED = 300
const SEARCH_SEQ = 150
const REPLY_SEQ = 290
const REPLIED_SEQ = 60
const word = `quokka${Date.now().toString(36)}`
const ids: string[] = []

const text = (i: number) =>
  `seq ${i}: ` + (i === SEARCH_SEQ ? `${word} ` : '') + 'lorem ipsum dolor sit amet '.repeat(1 + (i % 4))

test.beforeAll(async () => {
  user = await createUser(admin, 'jump')
  server = await seedServer(admin, user, `Jump ${user.username}`)
  // The owner posts: automod spares the owner's bursts. created_at orders the rows.
  const base = Date.now() - 2 * 24 * 3600_000
  for (let i = 0; i < SEEDED; i++) ids.push(randomUUID())
  const rows = ids.map((id, i) => ({
    id,
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: text(i) }],
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
const historyBar = (page: Page) => page.getByTestId('history-bar')
const distanceFromBottom = (page: Page) =>
  messageList(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)

/** Sequence numbers of the rows the chat store holds, in list order. */
const loadedSeqs = (page: Page) => page.evaluate(() => {
  const app = (document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { messages: Array<{ content: Array<{ text?: string }> }> }> } } } } }).__vue_app__
  const chat = app.config.globalProperties.$pinia._s.get('chat')!
  return chat.messages.map((m) => Number(/^seq (\d+):/.exec(m.content?.[0]?.text ?? '')?.[1] ?? NaN))
})

/** Sequence numbers of the rows in the viewport, top to bottom. */
const visibleSeqs = (page: Page) => messageList(page).evaluate((el) => {
  const view = el.getBoundingClientRect()
  return [...el.querySelectorAll('.message-item[data-message-id]')]
    .map((item) => ({ box: item.getBoundingClientRect(), text: item.textContent ?? '' }))
    .filter(({ box }) => box.bottom > view.top && box.top < view.bottom)
    .sort((a, b) => a.box.top - b.box.top)
    .map(({ text }) => Number(/seq (\d+):/.exec(text)?.[1] ?? NaN))
})

const expectContiguous = (seqs: number[]) => {
  const run = seqs.filter((n) => !Number.isNaN(n))
  expect(run.length).toBeGreaterThan(0)
  expect(run).toEqual(Array.from({ length: run.length }, (_, k) => run[0] + k))
}

test('a jump far up the history opens the messages around it', async ({ page }) => {
  test.setTimeout(240_000)

  await signIn(page, user)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(row(page, SEEDED - 1)).toBeVisible({ timeout: 30000 })

  await test.step('a reply to an old message opens the messages around it', async () => {
    await row(page, REPLY_SEQ).locator('.reply-reference').click()
    await expect(row(page, REPLIED_SEQ)).toBeInViewport({ timeout: 15000 })
    await expect(row(page, REPLIED_SEQ)).toHaveClass(/highlighted/)
    await expect(historyBar(page)).toBeVisible()
    await expect(historyBar(page)).toContainText("You're viewing older messages")
    await expect(row(page, SEEDED - 1)).toHaveCount(0)
    expect(await page.getByTestId('jump-to-present').count()).toBe(0)
    const seqs = await loadedSeqs(page)
    expectContiguous(seqs)
    expect(seqs).toContain(REPLIED_SEQ - 20)
    expect(seqs).toContain(REPLIED_SEQ + 20)
    expect(seqs).not.toContain(SEEDED - 1)
  })

  await test.step('jump to present lands on the newest message and sends append again', async () => {
    await page.getByTestId('history-jump-present').click()
    await expect(row(page, SEEDED - 1)).toBeInViewport({ timeout: 15000 })
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1)
    await expect(historyBar(page)).toBeHidden()
    expect(await loadedSeqs(page)).not.toContain(REPLIED_SEQ)
    const sent = await sendMessage(page, `after the present ${Date.now()}`)
    await expect(sent).toBeInViewport()
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1)
  })

  await test.step('a search result far up the history opens the messages around it', async () => {
    await page.locator('.search-btn').click()
    const input = page.locator('.search-query-input')
    await expect(input).toBeVisible({ timeout: 10000 })
    await input.fill(word)
    await input.press('Enter')
    const result = page.locator('.search-result').filter({ hasText: word })
    await expect(result).toHaveCount(1, { timeout: 15000 })
    await result.click()

    await expect(row(page, SEARCH_SEQ)).toBeInViewport({ timeout: 15000 })
    await expect(row(page, SEARCH_SEQ)).toHaveClass(/highlighted/)
    await expect(historyBar(page)).toBeVisible()
    await expect(row(page, SEEDED - 1)).toHaveCount(0)
    expectContiguous(await loadedSeqs(page))
    await expect(async () => expectContiguous(await visibleSeqs(page))).toPass({ timeout: 10000 })
  })

  await test.step('scrolling up loads the messages before them in order, without moving the view', async () => {
    // Settled past the landing re-seats and the prefetch that follows it.
    await page.waitForTimeout(1500)
    const first = (await loadedSeqs(page))[0]
    expect(first).toBeGreaterThan(0)
    // Park outside the 400 px prefetch zone, then step into it.
    await messageList(page).evaluate((el) => { el.scrollTop = 450 })
    await page.waitForTimeout(500)
    const anchor = await messageList(page).evaluate((el) => {
      const box = el.getBoundingClientRect()
      const mid = box.top + box.height / 2
      let best: Element | null = null
      let bestDistance = Infinity
      for (const item of el.querySelectorAll('.message-item[data-message-id]')) {
        const d = Math.abs(item.getBoundingClientRect().top - mid)
        if (d < bestDistance) { bestDistance = d; best = item }
      }
      el.scrollTop -= 200
      return { id: best!.getAttribute('data-message-id')!, top: best!.getBoundingClientRect().top - box.top }
    })
    await expect.poll(async () => (await loadedSeqs(page))[0], { timeout: 15000 }).toBeLessThan(first)
    await page.waitForTimeout(1000)
    const top = await messageList(page).evaluate((el, id) => {
      const item = el.querySelector(`[data-message-id="${id}"]`)!
      return item.getBoundingClientRect().top - el.getBoundingClientRect().top
    }, anchor.id)
    expect(Math.abs(top - anchor.top)).toBeLessThanOrEqual(1)
    expectContiguous(await loadedSeqs(page))
  })

  await test.step('scrolling down loads the messages after them in order up to the newest', async () => {
    let previousLast = -1
    await expect(async () => {
      await messageList(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
      const seqs = await loadedSeqs(page)
      expectContiguous(seqs)
      expectContiguous(await visibleSeqs(page))
      const last = seqs.filter((n) => !Number.isNaN(n)).at(-1)!
      expect(last).toBeGreaterThanOrEqual(previousLast)
      previousLast = last
      expect(last).toBe(SEEDED - 1)
    }).toPass({ timeout: 90000, intervals: [500, 1000, 1000] })
    await expect(historyBar(page)).toBeHidden({ timeout: 10000 })
    await expect(row(page, SEEDED - 1)).toBeAttached()
  })

  await test.step('back at the present, a send appends at the end', async () => {
    await messageList(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1)
    const sent = await sendMessage(page, `after scrolling down ${Date.now()}`)
    await expect(sent).toBeInViewport()
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1)
  })

  await test.step('a send from older messages returns to the present', async () => {
    expect(await loadedSeqs(page)).not.toContain(REPLIED_SEQ)
    await row(page, REPLY_SEQ).locator('.reply-reference').click()
    await expect(row(page, REPLIED_SEQ)).toBeInViewport({ timeout: 15000 })
    await expect(historyBar(page)).toBeVisible()
    const text = `sent from older messages ${Date.now()}`
    await composer(page).click()
    await composer(page).pressSequentially(text, { delay: 5 })
    await page.keyboard.press('Enter')
    const sent = messageList(page).locator('.message-item').filter({ hasText: text })
    await expect(sent).toBeInViewport({ timeout: 15000 })
    await expect(historyBar(page)).toBeHidden()
    await expect(row(page, SEEDED - 1)).toBeAttached()
    await expect(row(page, REPLIED_SEQ)).toHaveCount(0)
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1)
  })

  await test.step('the same search result opened again jumps again', async () => {
    await expect(page).not.toHaveURL(/messageId=/)
    await page.locator('.search-btn').click()
    const input = page.locator('.search-query-input')
    await expect(input).toBeVisible({ timeout: 10000 })
    await input.fill(word)
    await input.press('Enter')
    const result = page.locator('.search-result').filter({ hasText: word })
    await expect(result).toHaveCount(1, { timeout: 15000 })
    await result.click()
    await expect(row(page, SEARCH_SEQ)).toBeInViewport({ timeout: 15000 })
    await expect(row(page, SEARCH_SEQ)).toHaveClass(/highlighted/)
    await expect(historyBar(page)).toBeVisible()
    await expect(page).not.toHaveURL(/messageId=/)
  })
})
