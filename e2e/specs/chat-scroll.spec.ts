// Journey: the message list holds its position. At the bottom it keeps the
// newest message in view while the composer grows, sending from history
// returns to the bottom, and older history loads above the view without
// moving what is on screen. Jump to present returns to the newest message,
// from history and from a jump to an old message.
//
// No realtime in the e2e stack: every arrival here is the user's own send.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer
let oldestId: string

// Three pages of history at the client's page size of 20.
const SEEDED = 60

test.beforeAll(async () => {
  user = await createUser(admin, 'scroll')
  server = await seedServer(admin, user, `Scroll ${user.username}`)
  const base = Date.now() - 60 * 60 * 1000
  const rows = Array.from({ length: SEEDED }, (_, i) => ({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text: `seed ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(1 + (i % 5)) }],
    created_at: new Date(base + i * 30_000).toISOString(),
  }))
  const { data, error } = await admin.from('messages').insert(rows).select('id, created_at')
  if (error || !data) throw new Error(`seed messages: ${error?.message}`)
  oldestId = [...data].sort((a, b) => a.created_at.localeCompare(b.created_at))[0].id
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const list = (page: Page) => page.locator('[data-testid="message-list"]')
const editor = (page: Page) => page.locator('[data-testid="message-input"] .rich-text-editor')
const distanceFromBottom = (page: Page) =>
  list(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
const jumpToPresent = (page: Page) => page.getByTestId('jump-to-present')

/** Seed numbers of the rows the chat store holds, in list order; other rows are left out. */
const loadedSeeds = (page: Page) => page.evaluate(() => {
  const app = (document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { messages: Array<{ content: Array<{ text?: string }> }> }> } } } } }).__vue_app__
  const chat = app.config.globalProperties.$pinia._s.get('chat')!
  return chat.messages
    .map((m) => Number(/^seed (\d+):/.exec(m.content?.[0]?.text ?? '')?.[1] ?? NaN))
    .filter((n) => !Number.isNaN(n))
})

test('the list holds its position', async ({ page }) => {
  test.setTimeout(180_000)

  await signIn(page, user)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(list(page).getByText(`seed ${SEEDED - 1}:`)).toBeVisible({ timeout: 30000 })
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1)

  await test.step('a growing composer keeps the newest message in view', async () => {
    await editor(page).click()
    for (let i = 0; i < 5; i++) {
      await page.keyboard.insertText(`draft line ${i}`)
      await page.keyboard.press('Shift+Enter')
    }
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1)
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Backspace')
  })

  await test.step('sending from history returns to the bottom', async () => {
    await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight - el.clientHeight - 800 })
    await expect.poll(() => distanceFromBottom(page)).toBeGreaterThan(500)
    const text = `sent from history ${Date.now()}`
    await editor(page).click()
    await editor(page).pressSequentially(text, { delay: 5 })
    await page.keyboard.press('Enter')
    await expect(list(page).getByText(text)).toBeInViewport({ timeout: 15000 })
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1)
  })

  await test.step('older history loads above without moving the view', async () => {
    // Park outside the 400 px prefetch zone, then step into it.
    await list(page).evaluate((el) => { el.scrollTop = 450 })
    await page.waitForTimeout(500)
    const anchor = await list(page).evaluate((el) => {
      const box = el.getBoundingClientRect()
      const mid = box.top + box.height / 2
      let best: Element | null = null
      let bestDistance = Infinity
      for (const item of el.querySelectorAll('.message-item[data-message-id]')) {
        const d = Math.abs(item.getBoundingClientRect().top - mid)
        if (d < bestDistance) { bestDistance = d; best = item }
      }
      const seeds = [...el.querySelectorAll('.message-item')]
        .map((item) => Number(/seed (\d+):/.exec(item.textContent ?? '')?.[1] ?? NaN))
        .filter((n) => !Number.isNaN(n))
      el.scrollTop -= 200
      return {
        id: best!.getAttribute('data-message-id')!,
        top: best!.getBoundingClientRect().top - box.top,
        oldest: Math.min(...seeds),
      }
    })
    expect(anchor.oldest).toBeGreaterThan(0)
    // The newest message of the page before the oldest one loaded.
    await expect(list(page).getByText(`seed ${anchor.oldest - 1}:`)).toBeAttached({ timeout: 15000 })
    await page.waitForTimeout(1000)
    const top = await list(page).evaluate((el, id) => {
      const item = el.querySelector(`[data-message-id="${id}"]`)!
      return item.getBoundingClientRect().top - el.getBoundingClientRect().top
    }, anchor.id)
    expect(Math.abs(top - anchor.top)).toBeLessThanOrEqual(1)
  })

  await test.step('jump to present returns from more than a viewport up', async () => {
    await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight - 2.5 * el.clientHeight })
    await expect(jumpToPresent(page)).toBeVisible()
    await expect(jumpToPresent(page)).toHaveAttribute('aria-label', 'Jump to present')
    await jumpToPresent(page).click()
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1)
    await expect(jumpToPresent(page)).toBeHidden()
  })

  // The jump opens the seeds from the oldest message on. Three pages of history
  // leave the end of them in reach: the pages after them load in order up to the
  // newest, and the list ends at the present again.
  await test.step('jump to present after a jump to the oldest message', async () => {
    await page.goto(`/chat/${server.id}/${server.generalChannelId}?messageId=${oldestId}`)
    await expect(list(page).getByText('seed 0:')).toBeVisible({ timeout: 30000 })
    await expect(list(page).getByText('seed 1:')).toBeAttached()
    await expect(async () => {
      await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
      await expect(list(page).getByText(`seed ${SEEDED - 1}:`)).toBeAttached({ timeout: 1000 })
    }).toPass({ timeout: 30000 })
    await expect(page.getByTestId('history-bar')).toBeHidden({ timeout: 10000 })
    expect(await loadedSeeds(page)).toEqual(Array.from({ length: SEEDED }, (_, i) => i))

    await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight - 2.5 * el.clientHeight })
    await expect(jumpToPresent(page)).toBeVisible()
    await jumpToPresent(page).click()
    await expect(list(page).getByText(`seed ${SEEDED - 1}:`)).toBeInViewport({ timeout: 15000 })
    await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1)
    await expect(jumpToPresent(page)).toBeHidden()
  })
})
