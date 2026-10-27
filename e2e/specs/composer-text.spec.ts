// Journeys: the chat composer's text.
// - Once the draft renders (markdown, a mention, an emoji), lines wrap between words. Every
//   space became a no-break space, so a line broke inside a word.
// - Arabic or Hebrew text turns the composer right-to-left, and a sent message keeps its
//   punctuation at its end.
// - A paste with Windows line ends is stored with newlines, not "\r\n".
// - Text or a link dropped on the composer goes in where it lands; the drop was cancelled
//   for files and the text discarded.
// - A draft typed just before a reload is there after it; drafts were written 500 ms after
//   the last keystroke and nowhere else.

import { test, expect, type Page } from '@playwright/test'
import {
  addChannel,
  adminClient,
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
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'ctx')
  server = await seedServer(admin, user, `Text ${user.username}`)
})
test.afterAll(async () => { await deleteUser(admin, user) })

// Each test writes to a channel of its own: tests of this file run side by side.
let channel = ''
test.beforeEach(async ({ page: _page }, info) => {
  channel = await addChannel(admin, server, `t${info.testId.slice(0, 6)}${info.repeatEachIndex}${info.retry}`)
})

const editor = (page: Page) => page.locator('[data-testid="message-input"] .rich-text-editor')

async function count(): Promise<number> {
  const { count: n } = await admin.from('messages').select('id', { count: 'exact', head: true })
    .eq('channel_id', channel)
  return n ?? 0
}

async function lastText(): Promise<string> {
  const { data } = await admin.from('messages').select('content').eq('channel_id', channel)
    .eq('user_id', user.id).order('created_at', { ascending: false }).limit(1).single()
  return (data!.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? `[${p.type}]`).join('')
}

async function open(page: Page) {
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  await editor(page).click()
}

test('a rendered draft wraps between words', async ({ page }) => {
  await open(page)
  await page.keyboard.type('*a* ' + 'wordy '.repeat(40), { delay: 0 })
  await expect(editor(page).locator('.editor-italic-content')).toHaveText('a')
  const split = await editor(page).evaluate((root) => {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let words = 0
    let broken = 0
    let node: Node | null
    while ((node = walker.nextNode())) {
      const re = /wordy/g
      let m: RegExpExecArray | null
      while ((m = re.exec((node as Text).data))) {
        words++
        const range = root.ownerDocument.createRange()
        range.setStart(node, m.index)
        range.setEnd(node, m.index + 5)
        if (Array.from(range.getClientRects()).filter((r) => r.width > 0).length > 1) broken++
      }
    }
    return { words, broken }
  })
  expect(split).toEqual({ words: 40, broken: 0 })
})

test('right-to-left text turns the composer and keeps its punctuation at its end', async ({ page }) => {
  await open(page)
  await page.keyboard.type('שלום עולם!', { delay: 10 })
  expect(await editor(page).evaluate((el) => getComputedStyle(el).direction)).toBe('rtl')
  const before = await count()
  await page.keyboard.press('Enter')
  await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(before)
  const shown = messageList(page).locator('.message-item').filter({ hasText: 'שלום' }).last().locator('.text-content')
  await expect(shown).toBeVisible()
  // In a right-to-left paragraph "!" is drawn left of the words it follows.
  const order = await shown.evaluate((el) => {
    const text = el.firstChild as Text
    const at = (i: number) => {
      const r = document.createRange()
      r.setStart(text, i)
      r.setEnd(text, i + 1)
      return r.getBoundingClientRect().left
    }
    const data = text.data
    return { bang: at(data.indexOf('!')), first: at(data.indexOf('ש')) }
  })
  expect(order.bang).toBeLessThan(order.first)
})

test('a paste with Windows line ends is stored with newlines', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="message-input"] .rich-text-editor') as HTMLElement
    // Firefox drops clipboardData passed to the ClipboardEvent constructor.
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? 'one\r\ntwo' : ''), items: [] },
    })
    el.dispatchEvent(paste)
  })
  await expect(editor(page)).toHaveText('onetwo')
  const before = await count()
  await page.keyboard.press('Enter')
  await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(before)
  expect(await lastText()).toBe('one\ntwo')
})

test('text dropped on the composer goes in where it lands', async ({ page }) => {
  await open(page)
  await page.keyboard.type('before after', { delay: 10 })
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="message-input"] .rich-text-editor') as HTMLElement
    const text = el.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 7)
    range.setEnd(text, 7)
    const box = range.getBoundingClientRect()
    const data = new DataTransfer()
    data.setData('text/plain', 'https://example.com/dropped ')
    for (const type of ['dragenter', 'dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true, clientX: box.left, clientY: box.top + box.height / 2 }))
    }
  })
  await expect(editor(page)).toHaveText('before https://example.com/dropped after')
})

test('a draft typed just before a reload is there after it', async ({ page }) => {
  await open(page)
  await page.keyboard.type('kept across reload', { delay: 0 })
  await page.reload()
  await expect(editor(page)).toHaveText('kept across reload', { timeout: 30000 })
})
