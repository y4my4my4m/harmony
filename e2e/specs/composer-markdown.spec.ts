// Journey: markdown typed in the channel composer is sent as typed. The composer renders
// markdown live and restores the caret by text offset; the offset of a point inside a
// fenced block or a multi-line quote was a line off, so Shift+Enter in a `>>>` quote
// scrambled the lines and Ctrl+B in a code block wrapped its fence.
//
// Each case sends and reads the stored message back.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'cmd')
  server = await seedServer(admin, user, `Markdown ${user.username}`)
})
test.afterAll(async () => { await deleteUser(admin, user) })

const editor = (page: Page) => page.locator('[data-testid="message-input"] .rich-text-editor')

async function messageCount(): Promise<number> {
  const { count } = await admin.from('messages').select('id', { count: 'exact', head: true }).eq('channel_id', server.generalChannelId)
  return count ?? 0
}

async function lastMessageText(): Promise<string> {
  const { data } = await admin.from('messages').select('content').eq('channel_id', server.generalChannelId)
    .eq('user_id', user.id).order('created_at', { ascending: false }).limit(1).single()
  return (data!.content as Array<{ type: string; text?: string }>).map((p) => p.type === 'text' ? p.text : `[${p.type}]`).join('')
}

async function send(page: Page): Promise<string> {
  const before = await messageCount()
  await page.keyboard.press('Enter')
  await expect.poll(messageCount, { timeout: 15000 }).toBeGreaterThan(before)
  await expect(editor(page)).toHaveText('')
  return lastMessageText()
}

const type = (page: Page, text: string) => page.keyboard.type(text, { delay: 25 })

test('markdown typed in the composer is sent as typed', async ({ page }) => {
  test.setTimeout(240_000)

  await test.step('open the channel', async () => {
    await signIn(page, user)
    await openChannel(page, server.id, server.generalChannelId)
    await dismissAnnouncements(page)
    await editor(page).click()
  })

  await test.step('Ctrl+B inside a code block leaves the code unchanged', async () => {
    await type(page, '```')
    await page.keyboard.press('Shift+Enter')
    await type(page, 'hello world')
    await page.keyboard.press('Shift+Enter')
    await type(page, '```')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('End')
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Control+b')
    await expect(editor(page).locator('.editor-codeblock-content')).toHaveText('hello world')
    expect(await send(page)).toBe('```\nhello world\n```')
  })

  await test.step('a line inserted in the middle of a code block stays in place', async () => {
    await type(page, '```js')
    await page.keyboard.press('Shift+Enter')
    await type(page, 'const a = 1;')
    await page.keyboard.press('Shift+Enter')
    await type(page, 'const b = 2;')
    await page.keyboard.press('Shift+Enter')
    await type(page, '```')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('End')
    await page.keyboard.press('Shift+Enter')
    await type(page, 'const c = 3;')
    expect(await send(page)).toBe('```js\nconst a = 1;\nconst c = 3;\nconst b = 2;\n```')
  })

  await test.step('a multi-line quote keeps its lines', async () => {
    await type(page, '>>> line one')
    await page.keyboard.press('Shift+Enter')
    await type(page, 'line two')
    await page.keyboard.press('Shift+Enter')
    await type(page, 'line three')
    await expect(editor(page).locator('.editor-blockquote-line')).toHaveCount(3)
    expect(await send(page)).toBe('>>> line one\nline two\nline three')
  })

  await test.step('text after a quote starts on the next line, with no empty line between', async () => {
    await type(page, '> quoted')
    await page.keyboard.press('Shift+Enter')
    await type(page, 'after')
    await expect(editor(page).locator('.editor-blockquote')).toHaveText('> quoted')
    const gap = await editor(page).evaluate((root) => {
      const quote = root.querySelector('.editor-blockquote')!.getBoundingClientRect()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode()) && !(node as Text).data.includes('after'));
      const range = document.createRange()
      range.selectNodeContents(node!)
      return range.getBoundingClientRect().top - quote.bottom
    })
    expect(gap).toBeLessThan(8)
    expect(await send(page)).toBe('> quoted\nafter')
  })

  await test.step('Ctrl+B wraps a plain selection, Ctrl+Z restores it', async () => {
    await type(page, 'make this bold')
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Control+b')
    await expect(editor(page).locator('.editor-bold-content')).toHaveText('bold')
    await page.keyboard.press('Control+z')
    await expect(editor(page).locator('.editor-bold-content')).toHaveCount(0)
    await page.keyboard.press('Control+y')
    await page.keyboard.press('End')
    await type(page, ' ok')
    expect(await send(page)).toBe('make this **bold** ok')
  })

  await test.step('plain lines and an empty line survive Shift+Enter', async () => {
    await type(page, 'first')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.press('Shift+Enter')
    await type(page, '*third*')
    expect(await send(page)).toBe('first\n\n*third*')
  })

  await test.step('a long code line wraps in the composer and in the sent message', async () => {
    const long = 'x'.repeat(400)
    await type(page, '```')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.insertText(long)
    await page.keyboard.press('Shift+Enter')
    await type(page, '```')
    const content = editor(page).locator('.editor-codeblock-content')
    expect(await content.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    expect(await send(page)).toBe('```\n' + long + '\n```')
    const block = page.locator('[data-testid="message-list"] pre.code-block').filter({ hasText: long })
    await expect(block).toBeVisible({ timeout: 15000 })
    const fit = await block.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
      height: el.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(el).lineHeight),
    }))
    expect(fit.scroll).toBeLessThanOrEqual(fit.client)
    expect(fit.height).toBeGreaterThan(fit.line * 2)
  })
})
