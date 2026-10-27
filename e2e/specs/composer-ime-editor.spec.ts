// Journeys: the chat composer and input methods (Japanese, Chinese, Korean).
// - A composition typed into a draft holding markdown keeps only the committed text. The
//   editor re-rendered the draft on every composition update; each update was then inserted
//   again beside the text of the last ("**a** nににhにほ…日本").
// - The same at phone width, a composition per word.
// - The Enter that commits a composition in WebKit (Safari, the macOS and iOS apps) arrives
//   after compositionend with isComposing false and keyCode 229: it does not send.
// - Enter of an open composition in the edit box commits it; the edit stays open.
// - Arrow keys of an open composition pick its candidates; the suggestion list keeps its
//   selection.
//
// Compositions are driven through the Chrome DevTools Protocol (Input.imeSetComposition,
// Input.insertText), as an input method drives the page. WebKit's key order is dispatched as
// WebKit sends it.

import { test, expect, devices, type Page } from '@playwright/test'
import {
  addChannel,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer
let channel = ''

test.beforeAll(async () => {
  user = await createUser(admin, 'ime')
  server = await seedServer(admin, user, `IME ${user.username}`)
  await addChannel(admin, server, 'zatsudan')
})

// Each test writes to a channel of its own: tests of this file run side by side.
test.beforeEach(async ({ page: _page }, info) => {
  channel = await addChannel(admin, server, `t${info.testId.slice(0, 6)}${info.repeatEachIndex}${info.retry}`)
})
test.afterAll(async () => { await deleteUser(admin, user) })

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

/** Composes `steps` one update at a time, then commits `committed`. */
async function compose(page: Page, steps: string[], committed: string) {
  const cdp = await page.context().newCDPSession(page)
  for (const step of steps) {
    await cdp.send('Input.imeSetComposition', { text: step, selectionStart: step.length, selectionEnd: step.length })
    await page.waitForTimeout(40)
  }
  await cdp.send('Input.insertText', { text: committed })
  await cdp.detach()
}

/** keydown as WebKit dispatches the Enter that commits a composition. */
const webkitCommitEnter = (page: Page, selector: string) => page.evaluate((sel) => {
  const el = document.querySelector(sel) as HTMLElement
  el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
  el.dispatchEvent(new CompositionEvent('compositionend', { data: 'かんじ', bubbles: true }))
  const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: false })
  Object.defineProperty(enter, 'keyCode', { value: 229 })
  el.dispatchEvent(enter)
}, selector)

const composingKey = (page: Page, selector: string, key: string) => page.evaluate(({ sel, key }) => {
  const el = document.querySelector(sel) as HTMLElement
  const event = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, isComposing: true })
  Object.defineProperty(event, 'keyCode', { value: 229 })
  el.dispatchEvent(event)
}, { sel: selector, key })

const COMPOSER = '[data-testid="message-input"] .rich-text-editor'

test('a composition in a draft holding markdown keeps only the committed text', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'compositions are driven through the Chrome DevTools Protocol')
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  await editor(page).click()
  await page.keyboard.type('**a** ', { delay: 10 })
  await compose(page, ['n', 'に', 'にh', 'にほ', 'にほn', 'にほん'], '日本')
  await expect(editor(page)).toHaveText('**a** 日本')
  await expect(editor(page).locator('.editor-bold-content')).toHaveText('a')
  const before = await count()
  await page.keyboard.press('Enter')
  await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(before)
  expect(await lastText()).toBe('**a** 日本')
})

test("WebKit's Enter that commits a composition does not send", async ({ page }) => {
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  await editor(page).click()
  await page.keyboard.insertText('漢字')
  const before = await count()
  await webkitCommitEnter(page, COMPOSER)
  await page.waitForTimeout(1000)
  expect(await count()).toBe(before)
  await expect(editor(page)).toHaveText('漢字')
  // The next, ordinary Enter sends.
  await page.keyboard.press('Enter')
  await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(before)
  expect(await lastText()).toBe('漢字')
})

test('Enter of a composition in the edit box commits it and the edit stays open', async ({ page }) => {
  await admin.from('messages').insert({
    channel_id: channel, user_id: user.id, content: [{ type: 'text', text: 'へんしゅう前' }],
  })
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  await expect(page.locator('.message-item').filter({ hasText: 'へんしゅう前' })).toBeVisible({ timeout: 30000 })
  await editor(page).click()
  await page.keyboard.press('ArrowUp')
  const box = page.locator('.edit-container .rich-text-editor')
  await expect(box).toHaveText('へんしゅう前')
  await composingKey(page, '.edit-container .rich-text-editor', 'Enter')
  await webkitCommitEnter(page, '.edit-container .rich-text-editor')
  await page.waitForTimeout(500)
  await expect(box).toBeVisible()
  await composingKey(page, '.edit-container .rich-text-editor', 'Escape')
  await expect(box).toBeVisible()
})

test('arrow keys of a composition leave the suggestion list alone', async ({ page }) => {
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  await editor(page).click()
  await page.keyboard.type('#', { delay: 10 })
  const options = page.locator('#auto-suggest-listbox [role="option"]')
  await expect(options.nth(1)).toBeVisible({ timeout: 10000 })
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
  await composingKey(page, COMPOSER, 'ArrowDown')
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
  await composingKey(page, COMPOSER, 'Enter')
  await expect(editor(page)).toHaveText('#')
  // Outside a composition the arrows move the selection.
  await page.keyboard.press('ArrowDown')
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
})

test.describe('phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('words composed one at a time beside markdown keep their letters', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'compositions are driven through the Chrome DevTools Protocol')
    await signIn(page, user)
    await page.goto(`/chat/${server.id}/${channel}`)
    await dismissAnnouncements(page)
    await editor(page).tap()
    await page.keyboard.type('*x* ', { delay: 10 })
    await compose(page, ['h', 'he', 'hel', 'hell', 'hello'], 'hello')
    await compose(page, [' w', ' wo', ' wor'], ' world')
    await expect(editor(page)).toHaveText('*x* hello world')
    await expect(editor(page).locator('.editor-italic-content')).toHaveText('x')
  })
})
