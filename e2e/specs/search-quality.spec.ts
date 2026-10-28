// Journey: server message search matches the last word as a prefix, ignores accents and
// character width, finds Japanese and Korean inside longer text, falls back to similar words
// for a typo and says so (a near word, not one sharing a prefix), and marks the matched text in
// each result. Each case has a query beside it that must find nothing.

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

const MESSAGES = [
  'Harmony release notes',
  'Café crème at the Straße',
  '東京都庁へ行きます',
  '会議の設定を変更しました',
  '하모니는 좋아요',
  'the who played live',
  'who is the drummer',
  'ｶﾞｲﾄﾞ ＡＢＣ',
  'meet me',
  'meeting at noon',
]

test.beforeAll(async () => {
  user = await createUser(admin, 'searchq')
  server = await seedServer(admin, user, `Search ${user.username}`)
  // The owner posts: automod spares the owner's bursts.
  const base = Date.now() - 3600_000
  const { error } = await admin.from('messages').insert(MESSAGES.map((text, i) => ({
    channel_id: server.generalChannelId,
    user_id: user.id,
    content: [{ type: 'text', text }],
    created_at: new Date(base + i * 60_000).toISOString(),
  })))
  if (error) throw new Error(`seed messages: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const results = (page: Page) => page.locator('.search-results .search-result')
const notice = (page: Page) => page.locator('.search-similar')

async function search(page: Page, query: string) {
  const input = page.locator('.search-query-input')
  await input.fill(query)
  const answered = page.waitForResponse(r => r.url().includes('/rpc/search_messages'), { timeout: 15000 })
  await input.press('Enter')
  await answered
  await expect(page.locator('.search-count')).not.toHaveText(/Searching/, { timeout: 15000 })
}

/** Text of every range in the search-match highlight. */
const marked = (page: Page) => page.evaluate(() => {
  const registry = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
  return [...(registry?.get('search-match') ?? [])].map(r => r.toString()).sort()
})

async function expectFound(page: Page, query: string, texts: string[], marks: string[]) {
  await search(page, query)
  await expect(results(page)).toHaveCount(texts.length, { timeout: 15000 })
  for (const text of texts) await expect(results(page).filter({ hasText: text })).toHaveCount(1)
  await expect.poll(() => marked(page)).toEqual([...marks].sort())
}

async function expectNone(page: Page, query: string) {
  await search(page, query)
  await expect(page.locator('.search-body')).toContainText('No results', { timeout: 15000 })
  await expect(results(page)).toHaveCount(0)
}

async function openSearch(page: Page) {
  await signIn(page, user)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await page.locator('.search-btn').click()
  await expect(page.locator('.search-query-input')).toBeVisible({ timeout: 10000 })
}

test('the last word matches as a prefix', async ({ page }) => {
  await openSearch(page)
  await expectFound(page, 'harmo', ['Harmony release notes'], ['Harmo'])
  await expectFound(page, 'release harmo', ['Harmony release notes'], ['Harmo', 'release'])
  await expectNone(page, '"harmo"')
})

test('accents, case and character width fold', async ({ page }) => {
  await openSearch(page)
  await expectFound(page, 'cafe', ['Café crème at the Straße'], ['Café'])
  await expectFound(page, 'strasse', ['Café crème at the Straße'], ['Straße'])
  await expectFound(page, 'ガイド', ['ｶﾞｲﾄﾞ ＡＢＣ'], ['ｶﾞｲﾄﾞ'])
  await expectFound(page, 'abc', ['ｶﾞｲﾄﾞ ＡＢＣ'], ['ＡＢＣ'])
})

test('a phrase of english stop words matches in order', async ({ page }) => {
  await openSearch(page)
  await expectFound(page, '"the who"', ['the who played live'], ['the', 'who'])
  await expectNone(page, '"who the"')
})

test('Japanese and Korean match inside longer text, marked', async ({ page }) => {
  await openSearch(page)
  await expectFound(page, '都', ['東京都庁へ行きます'], ['都'])
  await expectFound(page, '東京都庁', ['東京都庁へ行きます'], ['東京都庁'])
  await expectFound(page, '設定', ['会議の設定を変更しました'], ['設定'])
  await expectFound(page, '하모니', ['하모니는 좋아요'], ['하모니'])
  await expectNone(page, '京東')
  await expectNone(page, '모하')
})

test('a typo falls back to similar words and says so', async ({ page }) => {
  await openSearch(page)
  await search(page, 'harmoyn')
  await expect(results(page).filter({ hasText: 'Harmony release notes' })).toHaveCount(1, { timeout: 15000 })
  await expect(notice(page)).toHaveText('No exact matches. Showing similar results.')
  await expect.poll(() => marked(page)).toEqual([])
  await expectNone(page, 'harmoyn -release')
  await expect(notice(page)).toHaveCount(0)
  await expectFound(page, 'harmony', ['Harmony release notes'], ['Harmony'])
  await expect(notice(page)).toHaveCount(0)
})

test('a typo needs a near word, not one sharing its first letters', async ({ page }) => {
  await openSearch(page)
  await search(page, 'meetnig')
  await expect(results(page)).toHaveCount(1, { timeout: 15000 })
  await expect(results(page).filter({ hasText: 'meeting at noon' })).toHaveCount(1)
  await expect(notice(page)).toHaveText('No exact matches. Showing similar results.')
  await expectNone(page, 'thw')
  await expect(notice(page)).toHaveCount(0)
})
