// Journey: a channel opens at its newest message when its unread messages load after the
// open. Reopened within the cache window, a channel shows its cached rows at once and
// fetches what was posted since; the view landed on the "New messages" line of the cached
// rows and stayed there while the fetched rows filled in below it, thousands of pixels
// above the end. A catch-up of more than one page also left the rows between the cache
// and that page unloaded.
//
// The view now opens at the end, as Discord's does; the bar at the top names the unread
// messages and jumps to the line, as does Shift+PageUp.
//
// No realtime in the stack: the messages are posted while another channel is open.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addChannel,
  addMember,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let reader: SpecUser
let author: SpecUser
let server: SeededServer
let otherId: string

const line = (tag: string, i: number) => `${tag} ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(1 + (i % 4))

/** `n` messages after the channel's newest, half a second apart. Automod spares the owner. */
async function post(n: number, tag: string, startAt?: number) {
  let base = startAt
  if (base === undefined) {
    const { data } = await admin.from('messages').select('created_at').eq('channel_id', server.generalChannelId)
      .order('created_at', { ascending: false }).limit(1).single()
    base = Date.parse(data!.created_at) + 1000
  }
  const rows = Array.from({ length: n }, (_, i) => ({
    channel_id: server.generalChannelId,
    user_id: author.id,
    content: [{ type: 'text', text: line(tag, i) }],
    created_at: new Date(base! + i * 500).toISOString(),
  }))
  const { error } = await admin.from('messages').insert(rows)
  if (error) throw new Error(`post ${tag}: ${error.message}`)
}

test.beforeAll(async () => {
  reader = await createUser(admin, 'cor')
  author = await createUser(admin, 'coa')
  server = await seedServer(admin, author, `Open ${reader.username}`)
  await addMember(admin, reader, server.id)
  otherId = await addChannel(admin, server, 'other')
  await post(30, 'old', Date.now() - 24 * 3600_000)
})

test.afterAll(async () => {
  await deleteUser(admin, reader)
  await deleteUser(admin, author)
})

const list = (page: Page) => page.locator('[data-testid="message-list"]')
const distanceFromBottom = (page: Page) => list(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
const channelItem = (page: Page, id: string) => page.locator(`.channel-sidebar .channel-wrapper[data-channel-id="${id}"] .channel-item`)

/** Texts of the rows the chat store holds, oldest first. */
const loadedTags = (page: Page) => page.evaluate(() => {
  const app = (document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { messages: Array<{ content: Array<{ text?: string }> }> }> } } } } }).__vue_app__
  const chat = app.config.globalProperties.$pinia._s.get('chat')!
  return chat.messages.map((m) => /^(\w+ \d+):/.exec(m.content?.[0]?.text ?? '')?.[1] ?? '')
})

test('a channel opens at its newest message when its unread messages load after the open', async ({ page }) => {
  test.setTimeout(240_000)

  await test.step('read the channel, then open another', async () => {
    await signIn(page, reader)
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    await expect(list(page).getByText(line('old', 29))).toBeInViewport({ timeout: 30000 })
    await page.waitForTimeout(1500)
    await channelItem(page, otherId).click()
    await page.waitForURL(new RegExp(otherId))
  })

  await test.step('a few posted meanwhile: the reopened channel ends on them', async () => {
    await post(15, 'mid')
    await channelItem(page, server.generalChannelId).click()
    await expect(list(page).getByText(line('mid', 14))).toBeInViewport({ timeout: 15000 })
    await page.waitForTimeout(3000)
    expect(await distanceFromBottom(page)).toBeLessThanOrEqual(1)
    await channelItem(page, otherId).click()
    await page.waitForURL(new RegExp(otherId))
  })

  await test.step('more than a page posted meanwhile: the reopened channel ends on the newest', async () => {
    await post(60, 'late')
    await channelItem(page, server.generalChannelId).click()
    await expect(list(page).getByText(line('late', 59))).toBeInViewport({ timeout: 15000 })
    // Past the landing retries and the catch-up window that follows an open.
    await page.waitForTimeout(3000)
    expect(await distanceFromBottom(page)).toBeLessThanOrEqual(1)
  })

  await test.step('the bar above names the unread messages and jumps to the line', async () => {
    const bar = page.getByTestId('unread-bar')
    const divider = list(page).locator('.new-messages-divider')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('new messages since')
    // Attached to the list's top edge: no message text shows above it.
    const gap = await bar.evaluate((el) => el.getBoundingClientRect().top - el.closest('.message-display')!.getBoundingClientRect().top)
    expect(Math.abs(gap)).toBeLessThanOrEqual(1)
    await bar.getByRole('button', { name: /new messages since/ }).click()
    await expect(divider).toBeInViewport({ timeout: 10000 })
    await expect(bar).toBeHidden()
    // The jump re-seats the line while rows above it measure.
    await page.waitForTimeout(1000)

    // Shift+PageUp from the composer, as in Discord.
    await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(bar).toBeVisible()
    await page.locator('[data-testid="message-input"] .rich-text-editor').click()
    await page.keyboard.press('Shift+PageUp')
    await expect(divider).toBeInViewport({ timeout: 10000 })
    await page.waitForTimeout(1000)

    await list(page).evaluate((el) => { el.scrollTop = el.scrollHeight })
    await bar.getByRole('button', { name: 'Mark as read' }).click()
    await expect(bar).toBeHidden()
    await expect(divider).toHaveCount(0)
  })

  await test.step('history above the newest page loads without a hole', async () => {
    await expect(async () => {
      await list(page).evaluate((el) => { el.scrollTop = 0 })
      expect(await loadedTags(page)).toContain('mid 14')
    }).toPass({ timeout: 60000, intervals: [500, 1000, 1000] })
    const tags = await loadedTags(page)
    const late = tags.filter((t) => t.startsWith('late '))
    expect(late).toEqual(Array.from({ length: 60 }, (_, i) => `late ${i}`))
    expect(tags.indexOf('late 0')).toBe(tags.indexOf('mid 14') + 1)
  })
})
