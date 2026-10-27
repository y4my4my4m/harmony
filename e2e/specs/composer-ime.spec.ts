// Journey: Japanese IME input in the post composer and the chat composer. Composition is
// driven through CDP (Input.imeSetComposition, then Input.insertText to commit), the way a
// Japanese IME feeds Chromium: the preedit grows (て, てす, てすと), Enter converts and
// commits (テスト). The Enter keydown arrives while the composition is open (isComposing).
//
// The composers rebuild their DOM to draw markdown markers. Rebuilt mid-composition, the
// IME loses its preedit: the browser commits it, every later update lands beside it
// (*x* ててすてすとテスト), and the committing Enter, no longer composing, sends the chat
// message. Text without markers is a control.

import { test, expect, type CDPSession, type Page } from '@playwright/test'
import {
  adminClient,
  composer,
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

test.beforeAll(async () => {
  user = await createUser(admin, 'imejp')
  server = await seedServer(admin, user, `IME ${user.username.slice(-6)}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

/** Composes `steps` as preedit, then commits `commit` with Enter. */
async function compose(page: Page, cdp: CDPSession, steps: string[], commit: string) {
  for (const s of steps) {
    await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length })
    await page.waitForTimeout(50)
  }
  // The IME consumes Enter: a keydown with no character, then the commit.
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
  await cdp.send('Input.insertText', { text: commit })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await page.waitForTimeout(150)
}

/** compositionstart events on `selector` since the call. */
async function countCompositionStarts(page: Page, selector: string) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)!
    ;(window as unknown as { __starts: number }).__starts = 0
    el.addEventListener('compositionstart', () => { (window as unknown as { __starts: number }).__starts++ }, true)
  }, selector)
  return () => page.evaluate(() => (window as unknown as { __starts: number }).__starts)
}

const messageCount = async () => {
  const { count } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('channel_id', server.generalChannelId)
    .eq('user_id', user.id)
  return count ?? 0
}

test('a Japanese composition in the post composer converts in place after markdown', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await page.goto('/social/home')
  await dismissAnnouncements(page)
  await page.getByRole('button', { name: 'New post' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create a post' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  const editor = dialog.locator('.rich-text-editor')
  await editor.click()
  const cdp = await page.context().newCDPSession(page)

  await test.step('plain text: the conversion replaces the reading', async () => {
    await compose(page, cdp, ['に', 'にほ', 'にほん', '日本'], '日本')
    await expect(editor).toHaveText('日本')
  })

  await test.step('after a markdown marker: one composition, no doubled reading', async () => {
    await page.keyboard.type(' *x* ')
    const starts = await countCompositionStarts(page, '[role="dialog"] .rich-text-editor')
    await compose(page, cdp, ['て', 'てす', 'てすと'], 'テスト')
    await expect(editor).toHaveText('日本 *x* テスト')
    expect(await starts()).toBe(1)
  })

  await test.step('the dialog stays open: Enter during the composition posts nothing', async () => {
    await expect(dialog).toBeVisible()
    const { count } = await admin.from('posts').select('id', { count: 'exact', head: true }).eq('author_id', user.id)
    expect(count ?? 0).toBe(0)
  })
})

test('a Japanese composition in the chat composer: Enter converts, it does not send', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  const editor = composer(page)
  await editor.click()
  const cdp = await page.context().newCDPSession(page)

  await test.step('after a markdown marker the conversion stays in the composer', async () => {
    await page.keyboard.type('*x* ')
    await compose(page, cdp, ['て', 'てす', 'てすと'], 'テスト')
    await expect(editor).toHaveText('*x* テスト')
    await page.waitForTimeout(500)
    expect(await messageCount()).toBe(0)
  })

  await test.step('the committing Enter WebKit sends after compositionend (keyCode 229) does not send', async () => {
    await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 })
    await cdp.send('Input.insertText', { text: '火' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await expect(editor).toHaveText('*x* テスト火')
    await page.waitForTimeout(500)
    expect(await messageCount()).toBe(0)
  })

  await test.step('a plain Enter afterwards sends the text as composed', async () => {
    await page.keyboard.press('Enter')
    await expect.poll(messageCount, { timeout: 15000 }).toBe(1)
    const { data } = await admin.from('messages').select('content').eq('channel_id', server.generalChannelId).eq('user_id', user.id).single()
    expect(JSON.stringify(data?.content)).toContain('テスト火')
    expect(JSON.stringify(data?.content)).not.toContain('てす')
  })
})
