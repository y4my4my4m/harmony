// Journey: search reaches the whole history of an end-to-end encrypted conversation.
//
// Ava's device encrypts 324 messages to a direct conversation with Ben; the rows are stored an
// hour apart from 2025-03-01 on, the target first, so it sits 323 messages before the newest.
// Four rows carry a forged session id: their signatures fail and no device can read them. Ben
// opens the conversation on a device with an empty index and searches. The stack runs no
// realtime: nothing arrives while the journey runs.

import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  signIn,
  type SpecUser,
} from './harness'
import { setUpEncryption } from './encryption'

const admin = adminClient()

const TOTAL = 324
const TARGET = 'the zebraphone invoice is in the blue folder'
const JAPANESE = '来週の金曜日に東京タワーで会いましょう'
const JAPANESE_AT = 6
const FORGED = [40, 41, 42, 43]
const START = Date.UTC(2025, 2, 1, 9)
const HOUR = 3600_000

let ava: SpecUser
let ben: SpecUser
let conversationId = ''
let targetId = ''
let benContext: BrowserContext

/** A crawl page: the search's keyset read of the conversation's rows. */
const isCrawlPage = (url: URL) =>
  url.pathname.endsWith('/rest/v1/messages') && url.searchParams.get('order') === 'created_at.desc,id.desc'

const crawlRequest = (request: Request) => isCrawlPage(new URL(request.url()))

const searchDialog = (page: Page) => page.getByRole('dialog', { name: 'Search messages' })
const results = (page: Page) => searchDialog(page).locator('.search-result')
const status = (page: Page) => page.getByTestId('encrypted-search-progress')

async function openConversation(page: Page): Promise<void> {
  await page.goto(`/dm/${conversationId}`)
  await dismissAnnouncements(page)
  await expect(messageList(page).locator('.message-item').filter({ hasText: `filler ${TOTAL - 1} ` })).toBeVisible({ timeout: 60000 })
}

async function search(page: Page, text: string): Promise<void> {
  if (!(await searchDialog(page).isVisible())) await page.locator('.search-btn').click()
  const input = searchDialog(page).locator('.search-query-input')
  await expect(input).toBeVisible({ timeout: 10000 })
  await input.fill(text)
  await input.press('Enter')
}

const searchIndexes = (page: Page) => page.evaluate(async () =>
  (await indexedDB.databases()).map(d => d.name ?? '').filter(n => n.startsWith('harmony_search_index_')))

const text = (i: number) =>
  i === 0 ? TARGET : i === JAPANESE_AT ? JAPANESE : `filler ${i} about the weekly deployment status`

test.describe.serial('encrypted conversation search', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000)
    ava = await createUser(admin, 'esava')
    ben = await createUser(admin, 'esben')

    const { data, error } = await admin.from('conversations').insert({ type: 'direct', created_by: ava.id }).select('id').single()
    if (error || !data) throw new Error(`conversation: ${error?.message}`)
    conversationId = data.id as string
    await admin.from('conversation_participants').insert([
      { conversation_id: conversationId, user_id: ava.id },
      { conversation_id: conversationId, user_id: ben.id },
    ])
    const { error: encError } = await admin
      .from('conversation_encryption_settings')
      .insert({ conversation_id: conversationId, encryption_enabled: true })
    if (encError) throw new Error(`conversation encryption: ${encError.message}`)

    benContext = await browser.newContext()
    const benPage = await benContext.newPage()
    await signIn(benPage, ben)
    await setUpEncryption(benPage, ben)
    await benPage.close()

    const avaContext = await browser.newContext()
    const avaPage = await avaContext.newPage()
    await signIn(avaPage, ava)
    await setUpEncryption(avaPage, ava)
    const payloads = await avaPage.evaluate(async ({ room, recipients, texts }) => {
      const served = performance.getEntriesByType('resource').map((e) => e.name)
        .find((name) => name.includes('/src/services/encryption/MegolmMessageEncryptionService.ts'))
      const url = served ?? '/src/services/encryption/MegolmMessageEncryptionService.ts'
      const service = (await import(/* @vite-ignore */ url)).megolmMessageEncryptionService as any
      const out: Array<{ content: unknown; encryption_metadata: unknown }> = []
      for (const t of texts) out.push(await service.encryptMessage([{ type: 'text', text: t }], room, recipients))
      return out
    }, { room: conversationId, recipients: [ava.id, ben.id], texts: Array.from({ length: TOTAL }, (_, i) => text(i)) })
    await avaContext.close()

    const rows = payloads.map((p, i) => ({
      conversation_id: conversationId,
      user_id: ava.id,
      content: p.content,
      encrypted: true,
      encryption_metadata: FORGED.includes(i)
        ? { ...(p.encryption_metadata as Record<string, unknown>), session_id: crypto.randomUUID() }
        : p.encryption_metadata,
      created_at: new Date(START + i * HOUR).toISOString(),
    }))
    const ids: string[] = []
    for (let i = 0; i < rows.length; i += 100) {
      const { data: inserted, error: insertError } = await admin.from('messages').insert(rows.slice(i, i + 100)).select('id')
      if (insertError) throw new Error(`messages: ${insertError.message}`)
      ids.push(...(inserted ?? []).map(r => r.id as string))
    }
    expect(ids).toHaveLength(TOTAL)
    const { data: first } = await admin.from('messages').select('id').eq('conversation_id', conversationId)
      .order('created_at', { ascending: true }).limit(1).single()
    targetId = first!.id as string
  })

  test.afterAll(async () => {
    await benContext?.close().catch(() => {})
    await deleteUser(admin, ava)
    await deleteUser(admin, ben)
  })

  test('the search pages back through encrypted history and finds a message 323 back', async () => {
    test.setTimeout(300_000)
    const page = await benContext.newPage()
    await openConversation(page)
    await expect(messageList(page).locator('.message-item').filter({ hasText: TARGET })).toHaveCount(0)

    const pages: string[] = []
    page.on('request', (r) => { if (crawlRequest(r)) pages.push(r.url()) })

    await test.step('the target is found once the crawl reaches it', async () => {
      await search(page, 'zebraph')
      await expect(results(page).filter({ hasText: TARGET })).toHaveCount(1, { timeout: 120000 })
      await expect(status(page)).toHaveText('Searched every encrypted message you can read.', { timeout: 120000 })
      // 324 rows: four pages of 100, the last short.
      expect(pages.length).toBe(4)
      await expect(searchDialog(page).getByTestId('encrypted-search-unreadable'))
        .toHaveText(`${FORGED.length} messages this device can't read`)
      await expect(searchDialog(page).locator('.search-count')).toHaveText('1 result')
    })

    await test.step('the result carries the lock and opens with the keyboard', async () => {
      const result = results(page).filter({ hasText: TARGET })
      await expect(result.locator('[title="End-to-end encrypted"]')).toHaveCount(1)
      await result.focus()
      await page.keyboard.press('Enter')
      // Enter opens the message once: the search does not open again on the button focus returns to.
      await expect(searchDialog(page)).toBeHidden()
      const row = messageList(page).locator(`[data-message-id="${targetId}"]`)
      await expect(row).toBeInViewport({ timeout: 30000 })
      await expect(row).toContainText(TARGET)
      await expect(row).toHaveClass(/highlighted/)
    })
    await page.close()
  })

  test('a second search is answered from the index on this device', async () => {
    test.setTimeout(180_000)
    const page = await benContext.newPage()
    let blocked = 0
    await page.route(isCrawlPage, (route) => {
      blocked++
      return route.abort()
    })
    await openConversation(page)
    expect(await searchIndexes(page)).toEqual([`harmony_search_index_${ben.id}`])

    await search(page, 'zebraphone')
    await expect(results(page).filter({ hasText: TARGET })).toHaveCount(1, { timeout: 15000 })
    // The crawl's one look for newer messages failed; the result came from the index.
    await expect.poll(() => blocked, { timeout: 15000 }).toBeGreaterThan(0)
    await page.close()
  })

  test('a Japanese query matches inside a sentence', async () => {
    test.setTimeout(180_000)
    const page = await benContext.newPage()
    await openConversation(page)
    await search(page, '東京タワー')
    await expect(results(page).filter({ hasText: JAPANESE })).toHaveCount(1, { timeout: 30000 })
    await expect(searchDialog(page).locator('.search-count')).toHaveText('1 result')

    await search(page, '東京ドーム')
    await expect(status(page)).toHaveText('Searched every encrypted message you can read.', { timeout: 30000 })
    await expect(results(page)).toHaveCount(0)
    await page.close()
  })

  test('without the index and without history pages the message is not found (control)', async () => {
    test.setTimeout(180_000)
    const page = await benContext.newPage()
    await page.route(isCrawlPage, route => route.abort())
    await openConversation(page)
    await page.evaluate((name) => new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
    }), `harmony_search_index_${ben.id}`)

    await search(page, 'zebraphone')
    await expect(page.getByTestId('encrypted-search-older')).toHaveText('Retry', { timeout: 60000 })
    await expect(status(page)).toHaveText('Older encrypted messages could not be loaded.')
    await expect(results(page)).toHaveCount(0)
    await page.close()
  })

  test('signing out deletes the index', async () => {
    test.setTimeout(180_000)
    const page = await benContext.newPage()
    await openConversation(page)
    await search(page, 'filler')
    await expect(status(page)).toHaveText('Searched every encrypted message you can read.', { timeout: 120000 })
    await page.keyboard.press('Escape')
    await expect.poll(() => searchIndexes(page)).toEqual([`harmony_search_index_${ben.id}`])

    await page.goto('/logout')
    await page.getByTestId('logout-confirm-btn').click()
    await expect(page).toHaveURL(/login|\/$/, { timeout: 30000 })
    await expect.poll(() => searchIndexes(page), { timeout: 30000 }).toEqual([])
    await page.close()
  })
})
