// Journey: an image above the view that finishes loading leaves the messages in view where
// they are, also when the view is a little above the end of the list. The image row grows
// by more than the distance to the end, and the scroll correction for it is not cut short
// by the list height that follows the rows one render later.
//
// The image request is held with page.route and answered once the view is in place.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page, type Route } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  type SeededServer,
  type SpecUser,
  signIn,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
const AFTER = 14

const here = path.dirname(fileURLToPath(import.meta.url))
const imageBytes = fs.readFileSync(path.resolve(here, '../../public/discord-bridge-bot.webp'))
const imageUrl = new URL('/held-chat-image.webp', process.env.BASE_URL || 'http://localhost:5173').href

test.beforeAll(async () => {
  owner = await createUser(admin, 'imga')
  server = await seedServer(admin, owner, `Image anchor ${owner.username}`)
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
  const { error: imageError } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: owner.id,
    content: [
      { type: 'text', text: 'the slow picture' },
      { type: 'file', url: imageUrl, fileType: 'image', mimeType: 'image/webp', fileName: 'held.webp' },
    ],
    created_at: at(60),
  })
  if (imageError) throw new Error(`image message: ${imageError.message}`)
  const { error } = await admin.from('messages').insert(
    Array.from({ length: AFTER }, (_, i) => ({
      channel_id: server.generalChannelId,
      user_id: owner.id,
      content: [{ type: 'text', text: `after picture ${String(i + 1).padStart(2, '0')}` }],
      created_at: at(50 - i),
    })),
  )
  if (error) throw new Error(`messages: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

const scroller = (page: Page) => page.locator('[data-testid="message-list"]')

/** Row of the image message and of the first message after it, in scroller coordinates. */
const layout = (page: Page) =>
  scroller(page).evaluate((el) => {
    const box = el.getBoundingClientRect()
    const rows = Array.from(el.querySelectorAll<HTMLElement>('.message-item'))
    const image = rows.find((r) => r.innerText.includes('the slow picture'))
    const firstInView = rows.find((r) => r.getBoundingClientRect().top >= box.top && r.innerText.includes('after picture'))
    return {
      imageTop: image ? image.getBoundingClientRect().top - box.top : null,
      imageBottom: image ? image.getBoundingClientRect().bottom - box.top : null,
      imageHeight: image ? image.getBoundingClientRect().height : null,
      anchor: firstInView ? /after picture \d+/.exec(firstInView.innerText)?.[0] ?? null : null,
      anchorTop: firstInView ? firstInView.getBoundingClientRect().top - box.top : null,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      distance: el.scrollHeight - el.clientHeight - el.scrollTop,
    }
  })

const topOf = (page: Page, text: string) =>
  scroller(page).evaluate((el, wanted) => {
    const row = Array.from(el.querySelectorAll<HTMLElement>('.message-item')).find((r) => r.innerText.includes(wanted))
    return row ? row.getBoundingClientRect().top - el.getBoundingClientRect().top : null
  }, text)

test('an image loading above the view near the end leaves the messages in view in place', async ({ page }) => {
  test.setTimeout(150_000)
  let held: Route | null = null
  await page.route('**/held-chat-image.webp*', (route) => { held = route })

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(messageList(page).getByText(`after picture ${String(AFTER).padStart(2, '0')}`)).toBeVisible({ timeout: 30000 })
  await expect.poll(() => held !== null, { timeout: 15000 }).toBe(true)
  // A freshly opened channel follows its end for 2.5 s (MessageDisplay openFollowBottomUntil);
  // the reader scrolls up after that.
  await page.waitForTimeout(3000)

  // Content below the image row is the viewport plus 80 px: with the image row just above the
  // top of the view, the view sits 80 px above the end. A scroll made while the list still
  // follows its end is undone by it; the placement is repeated until it holds.
  await expect(async () => {
    const now = await layout(page)
    const below = now.scrollTop + now.clientHeight + now.distance - (now.scrollTop + now.imageBottom!)
    const height = Math.round(page.viewportSize()!.height + (below - 80 - now.clientHeight))
    if (Math.abs(height - page.viewportSize()!.height) > 1) {
      await page.setViewportSize({ width: page.viewportSize()!.width, height })
      await page.waitForTimeout(300)
    }
    await scroller(page).evaluate((el) => {
      const box = el.getBoundingClientRect()
      const image = Array.from(el.querySelectorAll<HTMLElement>('.message-item')).find((r) => r.innerText.includes('the slow picture'))!
      el.scrollTop += image.getBoundingClientRect().bottom - box.top + 2
    })
    await page.waitForTimeout(500)
    const placed = await layout(page)
    expect(placed.imageBottom!).toBeLessThanOrEqual(0)
    expect(placed.distance).toBeGreaterThan(30)
    expect(placed.distance).toBeLessThan(130)
  }).toPass({ timeout: 30000, intervals: [500, 1000] })
  const before = await layout(page)
  expect(before.anchor).not.toBeNull()

  await held!.fulfill({ status: 200, contentType: 'image/webp', body: imageBytes })
  await expect.poll(async () => (await layout(page)).imageHeight, { timeout: 15000 }).toBeGreaterThan(before.imageHeight! + 40)
  await page.waitForTimeout(500)
  const after = await topOf(page, before.anchor!)
  expect(Math.abs(after! - before.anchorTop!)).toBeLessThanOrEqual(1)
})
