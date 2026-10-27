// Journeys: the chat composer in WebKit, the engine of the iOS app, the macOS app and every
// iOS browser (the WebKit subset of composer-*.spec.ts).
// - The Enter that commits a composition arrives after compositionend with isComposing false
//   and keyCode 229, as WebKit sends it: it does not send.
// - [label](url) typed in the composer shows as a link while typing and is sent as a link
//   showing its label.
// - A URL pasted over selected text links the text.
// - A rendered draft wraps between words; Hebrew text turns the composer right-to-left.
// - On an iPhone, Enter adds a line and the send button sends.
//
// WebKit here has no input method and no software keyboard: compositions and pastes are
// dispatched as the page receives them.

import { test, expect, devices, type Page } from '@playwright/test'
import {
  addChannel,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let me: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  me = await createUser(admin, 'iosc')
  server = await seedServer(admin, me, `iOS composer ${me.username}`)
})
test.afterAll(async () => { await deleteUser(admin, me) })

// Each test writes to a channel of its own.
let channel = ''
test.beforeEach(async ({ page: _page }, info) => {
  channel = await addChannel(admin, server, `t${info.testId.slice(0, 6)}${info.repeatEachIndex}${info.retry}`)
})

const COMPOSER = '[data-testid="message-input"] .rich-text-editor'
const editor = (page: Page) => page.locator(COMPOSER)

async function count(): Promise<number> {
  const { count: n } = await admin.from('messages').select('id', { count: 'exact', head: true })
    .eq('channel_id', channel)
  return n ?? 0
}

async function lastContent(): Promise<unknown> {
  const { data } = await admin.from('messages').select('content').eq('channel_id', channel)
    .eq('user_id', me.id).order('created_at', { ascending: false }).limit(1).single()
  return data!.content
}

const pasteText = (page: Page, text: string) => page.evaluate(({ sel, text }) => {
  const el = document.querySelector(sel) as HTMLElement
  const data = new DataTransfer()
  data.setData('text/plain', text)
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
}, { sel: COMPOSER, text })

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test("the composition's committing Enter does not send; the next Enter does", async ({ page }) => {
    await signIn(page, me)
    await openChannel(page, server.id, channel)
    await editor(page).click()
    await page.keyboard.insertText('変換')
    const before = await count()
    await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement
      el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
      el.dispatchEvent(new CompositionEvent('compositionend', { data: '変換', bubbles: true }))
      const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
      Object.defineProperty(enter, 'keyCode', { value: 229 })
      el.dispatchEvent(enter)
    }, COMPOSER)
    await page.waitForTimeout(1000)
    expect(await count()).toBe(before)
    await page.keyboard.press('Enter')
    await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(before)
  })

  test('a masked link is typed, pasted over a selection, and sent with its label', async ({ page }) => {
    await signIn(page, me)
    await openChannel(page, server.id, channel)
    await editor(page).click()
    await page.keyboard.type('see [notes](https://example.com/notes) and the map', { delay: 10 })
    await expect(editor(page).locator('.editor-link-label')).toHaveText('notes')
    for (let i = 0; i < 'the map'.length; i++) await page.keyboard.press('Shift+ArrowLeft')
    await pasteText(page, 'https://example.com/map')
    await expect(editor(page)).toHaveText('see [notes](https://example.com/notes) and [the map](https://example.com/map)')
    const before = await count()
    await page.keyboard.press('Enter')
    await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(before)
    expect(await lastContent()).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'url', url: 'https://example.com/notes', preview: true, label: 'notes' },
      { type: 'text', text: ' and ' },
      { type: 'url', url: 'https://example.com/map', preview: true, label: 'the map' },
    ])
    const links = messageList(page).locator('.message-item').filter({ hasText: 'see' }).last().locator('a.url-link')
    await expect(links).toHaveText(['notes', 'the map'])
  })

  test('a rendered draft wraps between words; Hebrew turns it right-to-left', async ({ page }) => {
    await signIn(page, me)
    await openChannel(page, server.id, channel)
    await editor(page).click()
    await page.keyboard.type('*a* ' + 'wordy '.repeat(40), { delay: 0 })
    await expect(editor(page).locator('.editor-italic-content')).toHaveText('a')
    const broken = await editor(page).evaluate((root) => {
      let n = 0
      const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const re = /wordy/g
        let m: RegExpExecArray | null
        while ((m = re.exec((node as Text).data))) {
          const r = root.ownerDocument.createRange()
          r.setStart(node, m.index)
          r.setEnd(node, m.index + 5)
          if (Array.from(r.getClientRects()).filter((x) => x.width > 0).length > 1) n++
        }
      }
      return n
    })
    expect(broken).toBe(0)
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.keyboard.type('שלום', { delay: 10 })
    expect(await editor(page).evaluate((el) => getComputedStyle(el).direction)).toBe('rtl')
  })
})

test.describe('iPhone', () => {
  const { userAgent } = devices['iPhone 15 Pro']
  test.use({ viewport: { width: 393, height: 852 }, userAgent, deviceScaleFactor: 3, isMobile: true, hasTouch: true })

  test('Enter adds a line; the send button sends a masked link', async ({ page }) => {
    await signIn(page, me)
    await page.goto(`/chat/${server.id}/${channel}`)
    await dismissAnnouncements(page)
    await editor(page).tap()
    await page.keyboard.type('two lines', { delay: 10 })
    await page.keyboard.press('Enter')
    await page.keyboard.type('[and a link](https://example.com/l)', { delay: 10 })
    await expect(editor(page).locator('.editor-link-label')).toHaveText('and a link')
    const before = await count()
    await page.locator('[data-testid="message-send-btn"]').tap()
    await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(before)
    expect(await lastContent()).toEqual([
      { type: 'text', text: 'two lines\n' },
      { type: 'url', url: 'https://example.com/l', preview: true, label: 'and a link' },
    ])
  })
})
