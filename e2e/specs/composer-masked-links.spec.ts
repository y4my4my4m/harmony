// Journeys: masked links in chat (1.9.1).
// - `[label](url)` typed in the composer shows as a link while typing, is stored as a url part
//   with a label, and renders as the label with the destination in its title.
// - A URL pasted over selected text links the text to it; Ctrl+Z takes the link back off.
// - Editing shows the link as typed and keeps the label.
// - A reply's preview of it reads the label and the host.
// - A label naming another host renders the real URL; a url part without a label (every
//   client before 1.9.1) renders as before.
// - A label shows exactly the text the host check read: bidi marks are gone (RLM turned
//   "com.paypal" into "paypal.com" on screen), the label is isolated from the text around it,
//   look-alike hosts and hosts mid-sentence show the URL, a host-shaped name gains the
//   destination host, and a destination that is not http(s) shows no label.
// - On a phone the same text sent with the send button gives the same link.

import { test, expect, devices, type Page } from '@playwright/test'
import {
  addChannel,
  addMember,
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
let user: SpecUser
let friend: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  user = await createUser(admin, 'mlk')
  friend = await createUser(admin, 'mlkf')
  server = await seedServer(admin, user, `Links ${user.username}`)
  await addMember(admin, friend, server.id)
})
test.afterAll(async () => {
  await deleteUser(admin, user)
  await deleteUser(admin, friend)
})

const editor = (page: Page) => page.locator('[data-testid="message-input"] .rich-text-editor')

type Part = { type: string; text?: string; url?: string; label?: string; preview?: boolean }

// Each test writes to a channel of its own: tests of this file run side by side.
let channel = ''
test.beforeEach(async ({ page: _page }, info) => {
  channel = await addChannel(admin, server, `t${info.testId.slice(0, 6)}${info.repeatEachIndex}${info.retry}`)
})

async function lastContent(author = user): Promise<Part[]> {
  const { data } = await admin.from('messages').select('content').eq('channel_id', channel)
    .eq('user_id', author.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data?.content ?? []) as Part[]
}

async function count(): Promise<number> {
  const { count: n } = await admin.from('messages').select('id', { count: 'exact', head: true })
    .eq('channel_id', channel)
  return n ?? 0
}

async function sendWithEnter(page: Page) {
  const before = await count()
  await page.keyboard.press('Enter')
  await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(before)
  await expect(editor(page)).toHaveText('')
}

const row = (page: Page, text: string) => messageList(page).locator('.message-item').filter({ hasText: text }).last()

test('a masked link typed in the composer is stored with its label and shows the label', async ({ page }) => {
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  await editor(page).click()
  await page.keyboard.type('read [the docs](https://example.com/docs) now', { delay: 10 })
  await expect(editor(page).locator('.editor-link-label')).toHaveText('the docs')
  await expect(editor(page).locator('.editor-link-url')).toHaveText('https://example.com/docs')
  await sendWithEnter(page)

  expect(await lastContent()).toEqual([
    { type: 'text', text: 'read ' },
    { type: 'url', url: 'https://example.com/docs', preview: true, label: 'the docs' },
    { type: 'text', text: ' now' },
  ])
  const link = row(page, 'read').locator('a.url-link')
  await expect(link).toHaveText('the docs')
  await expect(link).toHaveAttribute('href', 'https://example.com/docs')
  await expect(link).toHaveAttribute('title', 'https://example.com/docs')
  await expect(row(page, 'read')).toContainText('read the docs now')
})

test('a URL pasted over selected text links the text; undo takes it back off', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium\'s; ios-composer.spec.ts pastes in WebKit')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  await editor(page).click()
  await page.keyboard.type('see the guide', { delay: 10 })
  for (let i = 0; i < 'the guide'.length; i++) await page.keyboard.press('Shift+ArrowLeft')
  await page.evaluate(() => navigator.clipboard.writeText('https://example.com/guide'))
  await page.keyboard.press('Control+v')
  await expect(editor(page).locator('.editor-link-label')).toHaveText('the guide')
  await expect(editor(page)).toHaveText('see [the guide](https://example.com/guide)')

  await page.keyboard.press('Control+z')
  await expect(editor(page)).toHaveText('see the guide')
  await page.keyboard.press('Control+y')
  await expect(editor(page)).toHaveText('see [the guide](https://example.com/guide)')
  // The caret sits after the link: typing continues the sentence.
  await page.keyboard.type(' first', { delay: 10 })
  await sendWithEnter(page)

  expect(await lastContent()).toEqual([
    { type: 'text', text: 'see ' },
    { type: 'url', url: 'https://example.com/guide', preview: true, label: 'the guide' },
    { type: 'text', text: ' first' },
  ])
})

test('editing a masked link shows it as typed and keeps the label', async ({ page }) => {
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  await editor(page).click()
  await page.keyboard.type('edit [old label](https://example.com/e) here', { delay: 10 })
  await sendWithEnter(page)
  await expect(row(page, 'edit').locator('a.url-link')).toHaveText('old label')

  await editor(page).click()
  await page.keyboard.press('ArrowUp')
  const box = page.locator('.edit-container .rich-text-editor')
  await expect(box).toHaveText('edit [old label](https://example.com/e) here')
  await expect(box.locator('.editor-link-label')).toHaveText('old label')
  await box.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('edit [new label](https://example.com/e) here', { delay: 10 })
  await page.keyboard.press('Enter')
  await expect(row(page, 'edit').locator('a.url-link')).toHaveText('new label')
  await expect.poll(async () => (await lastContent()).find((p) => p.type === 'url')?.label).toBe('new label')
})

test("a reply's preview reads the label and host", async ({ page }) => {
  await admin.from('messages').insert({
    channel_id: channel,
    user_id: user.id,
    content: [
      { type: 'text', text: 'the plan is in ' },
      { type: 'url', url: 'https://docs.example.com/plan', preview: false, label: 'this doc' },
    ],
  })
  await signIn(page, friend)
  await openChannel(page, server.id, channel)
  const target = row(page, 'the plan is in')
  await target.hover()
  await target.getByRole('button', { name: /reply/i }).first().click()
  await page.keyboard.type('on it', { delay: 10 })
  const before = await count()
  await page.keyboard.press('Enter')
  await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(before)
  await expect(row(page, 'on it').locator('.reply-preview')).toHaveText('the plan is in this doc (docs.example.com)')
})

test('a label naming another host shows the real URL; a link without a label shows as before', async ({ page }) => {
  await admin.from('messages').insert([
    {
      channel_id: channel,
      user_id: friend.id,
      content: [{ type: 'text', text: 'honest ' }, { type: 'url', url: 'https://shop.example.com/x', preview: false, label: 'shop.example.com' }],
    },
    {
      channel_id: channel,
      user_id: friend.id,
      content: [{ type: 'text', text: 'deceptive ' }, { type: 'url', url: 'https://evil.example/login', preview: false, label: 'https://paypal.com/login' }],
    },
    {
      channel_id: channel,
      user_id: friend.id,
      content: [{ type: 'text', text: 'plain ' }, { type: 'url', url: 'https://example.org/p', preview: false }],
    },
  ])
  await signIn(page, user)
  await openChannel(page, server.id, channel)
  await expect(row(page, 'honest').locator('a.url-link')).toHaveText('shop.example.com')
  await expect(row(page, 'deceptive').locator('a.url-link')).toHaveText('https://evil.example/login')
  await expect(row(page, 'deceptive')).not.toContainText('paypal')
  await expect(row(page, 'plain').locator('a.url-link')).toHaveText('https://example.org/p')
  await expect(row(page, 'plain').locator('a.url-link')).not.toHaveAttribute('title', /.+/)
})

test('a label shows only what the host check read', async ({ page }) => {
  const RLM = '\u200F'
  const insert = (text: string, url: string, label: string, leading = false) => ({
    channel_id: channel,
    user_id: friend.id,
    content: leading
      ? [{ type: 'url', url, preview: false, label }, { type: 'text', text: ` ${text}` }]
      : [{ type: 'text', text: `${text} ` }, { type: 'url', url, preview: false, label }],
  })
  await admin.from('messages').insert([
    insert('bidimark', 'https://evil.example/bidi', `${RLM}com${RLM}.${RLM}paypal`, true),
    insert('cyrillic', 'https://evil.example/cyr', 'paypal.c\u043Em'),
    insert('sentence', 'https://evil.example/sentence', 'log in at paypal.com'),
    insert('dotleader', 'https://evil.example/leader', 'paypal\u2024com'),
    insert('library', 'https://nodejs.org/en', 'Node.js'),
    insert('scheme', 'javascript://google.com/%0aalert(1)', 'google.com'),
  ])
  await signIn(page, user)
  await openChannel(page, server.id, channel)

  await test.step('bidi marks are dropped and the label is laid out on its own', async () => {
    const link = row(page, 'bidimark').locator('a.url-link')
    await expect(link).toHaveText('com.paypal (evil.example)', { timeout: 30000 })
    expect(await link.evaluate((el) => el.textContent?.includes('\u200F'))).toBe(false)
    await expect(link).toHaveCSS('unicode-bidi', 'isolate')
    // On screen "com" stands left of "paypal": nothing reorders the label.
    const order = await link.evaluate((el) => {
      const text = el.firstChild as Text
      const at = (word: string) => {
        const range = document.createRange()
        const i = text.data.indexOf(word)
        range.setStart(text, i)
        range.setEnd(text, i + word.length)
        return range.getBoundingClientRect().left
      }
      return at('com') < at('paypal')
    })
    expect(order).toBe(true)
  })

  await test.step('look-alike and mid-sentence hosts show the URL', async () => {
    await expect(row(page, 'cyrillic').locator('a.url-link')).toHaveText('https://evil.example/cyr')
    await expect(row(page, 'sentence').locator('a.url-link')).toHaveText('https://evil.example/sentence')
    await expect(row(page, 'dotleader').locator('a.url-link')).toHaveText('https://evil.example/leader')
    await expect(row(page, 'sentence')).not.toContainText('paypal')
  })

  await test.step('a host-shaped name gains the destination host', async () => {
    await expect(row(page, 'library').locator('a.url-link')).toHaveText('Node.js (nodejs.org)')
  })

  await test.step('a destination that is not http(s) shows no label', async () => {
    const r = row(page, 'scheme')
    await expect(r.locator('a')).toHaveCount(0)
    await expect(r.locator('.url-link--unsafe')).toHaveText('javascript://google.com/%0aalert(1)')
  })
})

test('a post written with a masked link shows its label', async ({ page }) => {
  await signIn(page, user)
  await page.goto('/social/home')
  await dismissAnnouncements(page)
  await page.getByRole('button', { name: 'New post' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create a post' })
  await expect(dialog.locator('.rich-text-editor')).toBeFocused({ timeout: 15000 })
  await page.keyboard.type(`post ${user.username} [the release notes](https://example.com/notes)`, { delay: 10 })
  await expect(dialog.locator('.editor-link-label')).toHaveText('the release notes')
  await dialog.getByTestId('compose-submit').click()
  await expect(dialog).toBeHidden({ timeout: 30000 })
  await expect.poll(async () => {
    const { data } = await admin.from('posts').select('content').eq('author_id', user.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    return (data?.content as Part[] | undefined)?.find((p) => p.type === 'url') ?? null
  }, { timeout: 30000 }).toEqual({ type: 'url', url: 'https://example.com/notes', preview: true, label: 'the release notes' })
  const shown = page.locator('article').filter({ hasText: `post ${user.username}` }).first().locator('a.url-link')
  await expect(shown).toHaveText('the release notes', { timeout: 30000 })
  await expect(shown).toHaveAttribute('title', 'https://example.com/notes')
})

test.describe('phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('a masked link sent with the send button shows its label', async ({ page }) => {
    await signIn(page, user)
    await page.goto(`/chat/${server.id}/${channel}`)
    await dismissAnnouncements(page)
    await editor(page).tap()
    await page.keyboard.type('phone [map](https://example.com/map)', { delay: 10 })
    await expect(editor(page).locator('.editor-link-label')).toHaveText('map')
    const before = await count()
    await page.locator('[data-testid="message-send-btn"]').tap()
    await expect.poll(count, { timeout: 15000 }).toBeGreaterThan(before)
    expect(await lastContent()).toEqual([
      { type: 'text', text: 'phone ' },
      { type: 'url', url: 'https://example.com/map', preview: true, label: 'map' },
    ])
    await expect(row(page, 'phone').locator('a.url-link')).toHaveText('map')
  })
})
