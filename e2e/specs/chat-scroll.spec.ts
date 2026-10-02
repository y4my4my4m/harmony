// Journey: the message list holds its position. At the bottom it keeps the
// newest message in view while the composer grows, sending from history
// returns to the bottom, and older history loads above the view without
// moving what is on screen.
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
  const { error } = await admin.from('messages').insert(rows)
  if (error) throw new Error(`seed messages: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const list = (page: Page) => page.locator('[data-testid="message-list"]')
const editor = (page: Page) => page.locator('[data-testid="message-input"] .rich-text-editor')
const distanceFromBottom = (page: Page) =>
  list(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)

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
})
