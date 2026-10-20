// Journey: the 1.7.2-1.7.4 chat and social changes on a phone (Pixel 7 viewport, touch).
// - A tapped composer takes no focus ring (the ring marks keyboard focus).
// - A long press opens the floating message actions; the synthetic contextmenu that
//   follows does not open the full message menu at the row's edge.
// - The composer's emoji picker opens as a dialog and closes.
// - Reply prefills the thread's accounts and keeps a narrower parent visibility.
// - With the keyboard up, tapping back into an earlier word only moves the caret: Chromium's
//   handling of the tap, which opens its spelling menu on a misspelled word, is held back
//   until a second tap in the same word (utils/tapToCaret.ts). The keyboard is stood in for by
//   shrinking the visual viewport as Gboard does; the menu itself needs a device.

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
    await expect(page.getByRole('group', { name: 'Message actions' })).toBeVisible({ timeout: 5000 })
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

test('with the keyboard up, a tap in an earlier word moves the caret; a second tap there is the platform\'s', async ({ page }) => {
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
    const w = window as unknown as { __clicks: number }
    w.__clicks = 0
    document.querySelector('[data-testid="message-input"] .rich-text-editor')!.addEventListener('click', () => { w.__clicks++ })
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
  await expect.poll(caret).toBeGreaterThanOrEqual(13)
  expect(await caret()).toBeLessThanOrEqual(15)
  expect(await clicks()).toBe(0)
  await expect(editor(page)).toBeFocused()

  await page.keyboard.type('X')
  // Typing lands at the tapped point, inside the word.
  await expect(editor(page)).toContainText(/misXspeled|missXpeled|misspXeled/)

  // The caret is in that word now: the next tap there is the platform's own.
  const again = await point(11, 12)
  await page.touchscreen.tap(again.x, again.y)
  await expect.poll(clicks).toBe(1)

  // Keyboard down: every tap is the platform's, so the one that brings the keyboard back does.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, get: () => screen.availHeight - 76 })
  })
  const first = await point(1, 2)
  await page.touchscreen.tap(first.x, first.y)
  await expect.poll(clicks).toBe(2)
})
