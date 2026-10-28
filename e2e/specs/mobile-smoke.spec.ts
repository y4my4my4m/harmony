// Journey: the 1.7.2-1.7.4 chat and social changes on a phone (Pixel 7 viewport, touch).
// - A tapped composer takes no focus ring (the ring marks keyboard focus).
// - A long press opens the floating message actions; the synthetic contextmenu that
//   follows does not open the full message menu at the row's edge.
// - The composer's emoji picker opens as a dialog and closes.
// - Reply prefills the thread's accounts and keeps a narrower parent visibility.
// - A tap in the composer's text only moves the caret, keyboard up or down, composer focused or
//   not: Chromium's handling of the tap opens its spelling menu on a misspelled word, with the
//   keyboard down instead of the keyboard (utils/tapToCaret.ts). Only the second tap of a double
//   tap is the platform's. The keyboard is stood in for by shrinking the visual viewport as
//   Gboard does; the menu and the keyboard themselves need a device (e2e/android).
// - Enter inserts a line break at the caret, at the end of the text too (the browser's
//   insertLineBreak keeps the placeholder <br> a trailing break needs).

import { test, expect, devices, type Page } from '@playwright/test'
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

const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

const admin = adminClient()
let me: SpecUser
let author: SpecUser
let server: SeededServer
let unlistedPostId = ''

test.beforeAll(async () => {
  me = await createUser(admin, 'mob')
  author = await createUser(admin, 'moba')
  server = await seedServer(admin, me, `Phone ${me.username}`)
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: me.id,
    content: [{ type: 'text', text: 'long press me on a phone' }],
  })
  if (error) throw new Error(`message: ${error.message}`)
  const { data, error: postError } = await admin
    .from('posts')
    .insert({
      author_id: author.id,
      visibility: 'unlisted',
      is_local: true,
      content: [{ type: 'text', text: 'quiet phone note' }],
    })
    .select('id')
    .single()
  if (postError) throw new Error(`post: ${postError.message}`)
  unlistedPostId = data!.id
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [me?.id, author?.id].filter(Boolean))
  await deleteUser(admin, me)
  await deleteUser(admin, author)
})

const list = (page: Page) => page.locator('[data-testid="message-list"]')
const editor = (page: Page) => page.locator('[data-testid="message-input"] .rich-text-editor')

test('chat on a phone: composer, long press and emoji picker', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, me)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  const row = list(page).locator('.message-item').filter({ hasText: 'long press me on a phone' })
  await expect(row).toBeVisible({ timeout: 30000 })

  await test.step('a tapped composer shows no focus ring', async () => {
    await editor(page).tap()
    await expect(editor(page)).toBeFocused()
    await expect(editor(page)).toHaveCSS('outline-style', 'none')
    await editor(page).blur()
  })

  await test.step('a long press opens the floating actions, not the full menu', async () => {
    const box = (await row.boundingBox())!
    const touch = { identifier: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
    await row.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] })
    await page.waitForTimeout(900)
    await row.dispatchEvent('contextmenu', { clientX: touch.clientX, clientY: touch.clientY, button: 2 })
    await row.dispatchEvent('touchend', { touches: [], changedTouches: [touch], targetTouches: [] })
    await expect(page.getByRole('toolbar', { name: 'Message actions' })).toBeVisible({ timeout: 5000 })
    await expect(page.getByRole('menu', { name: 'Message options' })).toHaveCount(0)
  })

  await test.step('the emoji picker opens as a dialog and closes', async () => {
    await page.locator('[data-testid="message-input"]').getByRole('button', { name: 'Emoji picker' }).tap()
    const picker = page.getByRole('dialog', { name: 'GIFs, stickers and emoji' })
    await expect(picker).toBeVisible({ timeout: 10000 })
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()
  })
})

test('a reply on a phone keeps the post visibility and mentions its author', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, me)
  await page.goto(`/social/post/${unlistedPostId}`)
  await dismissAnnouncements(page)
  const post = page.locator('article[aria-current="true"]')
  await expect(post).toBeVisible({ timeout: 90_000 })
  await post.getByRole('button', { name: /^Reply to / }).first().tap()
  await expect(page.locator('[data-testid="compose-visibility"]').last()).toHaveAccessibleName('Visibility: Unlisted', { timeout: 15000 })
  await expect
    .poll(async () => (await page.locator('[data-testid="compose-post"] .rich-text-editor').last().innerText()).replace(/\u00a0/g, ' '))
    .toBe(`@${author.username} `)
})

test('sending on a phone keeps the keyboard up: the composer keeps focus after Send', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, me)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(list(page)).toBeVisible({ timeout: 30000 })

  for (const text of ['first from the phone', 'second without reopening the keyboard']) {
    await editor(page).tap()
    await page.keyboard.type(text)
    await page.getByTestId('message-send-btn').tap()
    await expect(list(page).locator('.message-item').filter({ hasText: text })).toBeVisible({ timeout: 15000 })
    // The soft keyboard stays up while the field it types into keeps focus, as in Discord.
    await expect(editor(page)).toBeFocused()
  }
})

test('Enter on a phone breaks the line where the caret is, at the end of the text too', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, me)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(list(page)).toBeVisible({ timeout: 30000 })

  await editor(page).tap()
  for (const [i, ch] of ['a', 'b', 'c', 'd'].entries()) {
    if (i > 0) await page.keyboard.press('Enter')
    await page.keyboard.type(ch)
  }
  await expect.poll(() => editor(page).innerText()).toBe('a\nb\nc\nd')

  const written = page.waitForResponse((r) => r.url().includes('/rest/v1/messages') && r.request().method() === 'POST')
  await page.getByTestId('message-send-btn').tap()
  await written
  const { data, error } = await admin
    .from('messages')
    .select('content')
    .eq('channel_id', server.generalChannelId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
  expect(error).toBeNull()
  const text = (data!.content as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text).join('')
  expect(text).toBe('a\nb\nc\nd')
})

test('a tap in an earlier word moves the caret, keyboard up or down; only a double tap is the platform\'s', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, me)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  await expect(list(page)).toBeVisible({ timeout: 30000 })

  await editor(page).tap()
  await page.keyboard.type('this is a misspeled word')
  // Gboard up on a Pixel 7: 388 CSS px of the screen are not in the visual viewport.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, get: () => screen.availHeight - 388 })
    const w = window as unknown as { __clicks: number; __lastDefaultPrevented?: boolean }
    w.__clicks = 0
    const editorEl = document.querySelector('[data-testid="message-input"] .rich-text-editor')!
    editorEl.addEventListener('click', () => { w.__clicks++ })
    // Whether the last touchend reached the platform: read after the editor's own handler.
    editorEl.addEventListener('touchend', (e) => { setTimeout(() => { w.__lastDefaultPrevented = e.defaultPrevented }) })
  })
  const point = (from: number, to: number) => editor(page).evaluate((el, [a, b]) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const node = walker.nextNode()!
    const range = document.createRange()
    range.setStart(node, a)
    range.setEnd(node, b)
    const box = range.getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }, [from, to])
  const caret = () => page.evaluate(() => getSelection()!.anchorOffset)
  const clicks = () => page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)

  const inWord = await point(13, 15)
  await page.touchscreen.tap(inWord.x, inWord.y)
  // The caret was at the end (24) before the tap: wait for it to land in "misspeled" (10-19). The
  // text can reflow between measuring and tapping (the web font), so the exact offset varies.
  await expect.poll(caret).toBeLessThanOrEqual(19)
  expect(await caret()).toBeGreaterThanOrEqual(10)
  expect(await clicks()).toBe(0)
  await expect(editor(page)).toBeFocused()

  await page.keyboard.type('X')
  // Typing lands at the tapped point, inside the word.
  await expect(editor(page)).toContainText(/ mi[a-z]*X[a-z]*d word/)

  // A second single tap in the same word still only moves the caret: on some phones the spelling
  // menu took the keyboard down with it.
  const again = await point(11, 12)
  await page.waitForTimeout(500)
  await page.touchscreen.tap(again.x, again.y)
  await expect.poll(caret).toBeLessThanOrEqual(13)
  expect(await caret()).toBeGreaterThanOrEqual(10)
  expect(await clicks()).toBe(0)

  // A double tap: its second tap is the platform's, which opens the menu on a misspelling.
  await page.waitForTimeout(500)
  await page.evaluate(([x, y]) => {
    const target = document.querySelector('[data-testid="message-input"] .rich-text-editor')!
    const at = (type: string) => {
      const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y })
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true, touches: type === 'touchstart' ? [touch] : [], changedTouches: [touch],
      }))
    }
    // Two taps 150 ms apart, as touchscreen.tap() cannot space them reliably.
    at('touchstart'); at('touchend')
    return new Promise<void>((done) => setTimeout(() => { at('touchstart'); at('touchend'); done() }, 150))
  }, [again.x, again.y])
  await expect.poll(() => page.evaluate(() => (window as unknown as { __lastDefaultPrevented?: boolean }).__lastDefaultPrevented)).toBe(false)

  // Keyboard down: the tap is kept from Chromium too, which would open the menu instead of the
  // keyboard; the composer's focus within the tap raises the keyboard.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, get: () => screen.availHeight - 76 })
  })
  const first = await point(1, 2)
  const before = await clicks()
  await page.waitForTimeout(500)
  await page.touchscreen.tap(first.x, first.y)
  await expect.poll(caret).toBeLessThanOrEqual(2)
  expect(await clicks()).toBe(before)
  await expect(editor(page)).toBeFocused()
})

test('after the reaction picker, a tap on a word of the draft focuses the composer there and keeps the tap from Chromium', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, me)
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await dismissAnnouncements(page)
  const row = list(page).locator('.message-item').filter({ hasText: 'long press me on a phone' })
  await expect(row).toBeVisible({ timeout: 30000 })

  await editor(page).tap()
  await page.keyboard.type('this is a misspeled word')
  await page.evaluate(() => {
    const w = window as unknown as { __clicks: number }
    w.__clicks = 0
    document.querySelector('[data-testid="message-input"] .rich-text-editor')!.addEventListener('click', () => { w.__clicks++ })
  })

  // Long press, React, a search typed in the picker, the first result picked.
  const box = (await row.boundingBox())!
  const touch = { identifier: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
  await row.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch], targetTouches: [touch] })
  await page.waitForTimeout(900)
  await row.dispatchEvent('contextmenu', { clientX: touch.clientX, clientY: touch.clientY, button: 2 })
  await row.dispatchEvent('touchend', { touches: [], changedTouches: [touch], targetTouches: [] })
  await page.getByRole('toolbar', { name: 'Message actions' }).getByTestId('msg-action-react').tap()
  const search = page.locator('.emoji-popup .search-input')
  await expect(search).toBeFocused({ timeout: 10000 })
  await page.keyboard.type('smile')
  await page.locator('.emoji-popup .emoji-item').first().tap()
  await expect(page.locator('.emoji-popup')).toHaveCount(0)
  // The picker hands focus back to its opener and its search's keyboard goes down.
  await expect(editor(page)).not.toBeFocused()
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, get: () => screen.availHeight - 76 })
  })

  const word = await editor(page).evaluate((el) => {
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!
    const range = document.createRange()
    range.setStart(node, 13)
    range.setEnd(node, 15)
    const rect = range.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  await page.waitForTimeout(500)
  await page.touchscreen.tap(word.x, word.y)
  await expect(editor(page)).toBeFocused()
  await expect.poll(() => page.evaluate(() => getSelection()!.anchorOffset)).toBeLessThanOrEqual(19)
  expect(await page.evaluate(() => getSelection()!.anchorOffset)).toBeGreaterThanOrEqual(10)
  expect(await page.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(0)
  await page.keyboard.type('X')
  await expect(editor(page)).toContainText(/ mi[a-z]*X[a-z]*d word/)
})
