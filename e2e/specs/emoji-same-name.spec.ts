// Journey: two servers each have a custom emoji of the same name. In the composer, the one
// picked from the autocomplete list or from the emoji picker is the one inserted (the second
// as `:name~1:`), drawn in the input with the caret after it, and the one sent. The thread
// panel's and the post composer's pickers insert at the caret too. A custom emoji named like a
// default one is listed after it: the default inserts its character, the custom one
// `:name~1:`, and each is the one sent.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const URL_HOME = 'https://emoji.e2e.test/same-home.png'
const URL_AWAY = 'https://emoji.e2e.test/same-away.png'

const admin = adminClient()
let user: SpecUser
let home: SeededServer
let away: SeededServer
let name: string
const emojiIds: string[] = []

test.beforeAll(async () => {
  user = await createUser(admin, 'esame')
  home = await seedServer(admin, user, `Home ${user.username.slice(-6)}`)
  away = await seedServer(admin, user, `Away ${user.username.slice(-6)}`)
  await addMember(admin, user, away.id)
  name = `same${user.username.slice(-6)}`
  for (const [server, url] of [[home, URL_HOME], [away, URL_AWAY]] as const) {
    const { data, error } = await admin.from('emojis')
      .insert({ name, url, server_id: server.id, scope: 'server', uploader: user.id })
      .select('id').single()
    if (error || !data) throw new Error(`emoji: ${error?.message}`)
    emojiIds.push(data.id)
  }
})

test.beforeAll(async () => {
  const { data, error } = await admin.from('emojis')
    .insert({ name: 'thumbs_up', url: 'https://emoji.e2e.test/custom-thumbs.png', server_id: home.id, scope: 'server', uploader: user.id })
    .select('id').single()
  if (error || !data) throw new Error(`emoji: ${error?.message}`)
  emojiIds.push(data.id)
})

test.afterAll(async () => {
  if (emojiIds.length) await admin.from('emojis').delete().in('id', emojiIds)
  await deleteUser(admin, user)
})

const composer = (page: Page) => page.locator('[data-region="composer"]')
const editor = (page: Page) => composer(page).locator('[contenteditable="true"]').first()
const editorEmoji = (page: Page) => editor(page).locator('.editor-emoji img')

async function open(page: Page) {
  await page.route('https://emoji.e2e.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  await signIn(page, user)
  await openChannel(page, home.id, home.generalChannelId)
  await dismissAnnouncements(page)
  await expect(editor(page)).toBeVisible({ timeout: 30000 })
}

/** The caret is at the end of the editor's text. */
async function caretAtEnd(page: Page, target = editor(page)): Promise<boolean> {
  return target.evaluate((el) => {
    const selection = el.ownerDocument.getSelection()
    if (!selection || selection.rangeCount === 0) return false
    const range = document.createRange()
    range.selectNodeContents(el)
    range.setEnd(selection.getRangeAt(0).endContainer, selection.getRangeAt(0).endOffset)
    const before = range.cloneContents()
    const all = document.createRange()
    all.selectNodeContents(el)
    const whole = all.cloneContents()
    const count = (f: DocumentFragment) => (f.textContent ?? '').length + f.querySelectorAll('.editor-emoji').length
    return count(before) === count(whole)
  })
}

/** Sends the draft; the stored emoji part's id and the image the message shows. */
async function send(page: Page, marker: string): Promise<{ storedId: unknown; shown: string | null }> {
  await page.keyboard.type(` ${marker}`)
  await page.keyboard.press('Enter')
  const row = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: marker }).last()
  await expect(row).toBeVisible({ timeout: 30000 })
  await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  const id = await row.getAttribute('data-message-id')
  const { data } = await admin.from('messages').select('content').eq('id', id!).single()
  const part = (data!.content as Array<{ type: string; id?: string; emoji?: { id?: string } }>)
    .find((p) => p.type === 'emoji' || p.type === 'custom_emoji')
  return {
    storedId: part?.id ?? part?.emoji?.id,
    shown: await row.locator(`img[alt*="${name}"]`).first().getAttribute('src'),
  }
}

test('the autocomplete inserts the emoji picked, not the first of its name', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  await editor(page).click()
  await page.keyboard.type(`:${name}`)
  const options = page.locator('[role="option"]').filter({ hasText: name })
  await expect(options).toHaveCount(2, { timeout: 15000 })
  const awayOption = options.filter({ hasText: away.name })
  await expect(awayOption).toHaveCount(1)
  await awayOption.click()

  await expect(editorEmoji(page)).toHaveCount(1)
  await expect(editorEmoji(page)).toHaveAttribute('src', URL_AWAY)
  expect(await send(page, 'via-autocomplete')).toEqual({ storedId: emojiIds[1], shown: URL_AWAY })
})

test('the emoji picker inserts the emoji picked, drawn, with the caret after it', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  await editor(page).click()
  await page.keyboard.type('before ')
  await composer(page).getByRole('button', { name: /emoji/i }).last().click()
  const picker = page.locator('.media-picker-popup').first()
  await expect(picker).toBeVisible({ timeout: 15000 })
  const section = picker.locator('.emoji-section, [class*="lazy-emoji"]').filter({
    has: page.locator('.section-title-collapsible', { hasText: away.name }),
  })
  await section.locator('.emoji-item').first().click()

  await expect(editorEmoji(page)).toHaveCount(1)
  await expect(editorEmoji(page)).toHaveAttribute('src', URL_AWAY)
  await expect.poll(() => caretAtEnd(page)).toBe(true)
  expect(await send(page, 'via-picker')).toEqual({ storedId: emojiIds[1], shown: URL_AWAY })
})

/** Picks the away server's emoji in the open emoji picker. */
async function pickAway(page: Page) {
  const picker = page.locator('.media-picker-popup').first()
  await expect(picker).toBeVisible({ timeout: 15000 })
  await picker.locator('.emoji-section, [class*="lazy-emoji"]').filter({
    has: page.locator('.section-title-collapsible', { hasText: away.name }),
  }).locator('.emoji-item').first().click()
}

test('the thread panel and the post composer insert a picked emoji at the caret', async ({ page }) => {
  test.setTimeout(150_000)
  await open(page)

  await test.step('thread panel', async () => {
    await page.locator('.chat-header .threads-btn').click()
    const modal = page.locator('.threads-modal')
    await expect(modal).toBeVisible({ timeout: 15000 })
    await modal.locator('.new-thread-btn').click()
    await modal.locator('#new-thread-name').fill('Emoji thread')
    await modal.locator('.new-thread-submit').click()
    const panel = page.locator('.thread-panel')
    await expect(panel).toBeVisible({ timeout: 15000 })
    const threadEditor = panel.locator('[data-testid="message-input"] .rich-text-editor')
    await threadEditor.click()
    await page.keyboard.type('in thread ')
    await panel.locator('[data-testid="message-input"]').getByRole('button', { name: /emoji/i }).last().click()
    await pickAway(page)
    await expect(threadEditor.locator('.editor-emoji img')).toHaveAttribute('src', URL_AWAY)
    await expect(threadEditor).toContainText('in thread')
    await expect.poll(() => caretAtEnd(page, threadEditor)).toBe(true)
  })

  await test.step('post composer', async () => {
    await page.goto('/social/home')
    await dismissAnnouncements(page)
    await page.getByRole('button', { name: 'New post' }).click()
    const dialog = page.getByRole('dialog', { name: 'Create a post' })
    await expect(dialog).toBeVisible({ timeout: 15000 })
    const postEditor = dialog.locator('.rich-text-editor')
    await postEditor.click()
    await page.keyboard.type('in a post ')
    await dialog.getByRole('button', { name: 'Add emoji' }).click()
    await pickAway(page)
    await expect(postEditor.locator('.editor-emoji img')).toHaveAttribute('src', URL_AWAY)
    await expect.poll(() => caretAtEnd(page, postEditor)).toBe(true)
    await page.keyboard.type('after')
    await expect(postEditor).toContainText('after')
    expect(await postEditor.evaluate((el) => (el.textContent ?? '').replace(/\u00a0/g, ' ').trim())).toBe('in a post after')
  })
})

test('a custom emoji named like a default one is listed after it, as name~1, and each is the one sent', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)

  const pick = async (which: 'default' | 'custom', marker: string) => {
    await editor(page).click()
    await page.keyboard.type(':thumbs_up')
    const options = page.locator('[role="option"]').filter({ hasText: 'thumbs_up' })
    await expect(options).toHaveCount(2, { timeout: 15000 })
    await expect(options.nth(1)).toContainText(home.name)
    await options.nth(which === 'default' ? 0 : 1).click()
    if (which === 'custom') await expect(editorEmoji(page)).toHaveAttribute('alt', ':thumbs_up~1:')
    await page.keyboard.type(marker)
    await page.keyboard.press('Enter')
    const row = page.locator('[data-testid="message-list"] .message-item').filter({ hasText: marker }).last()
    await expect(row).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    const { data } = await admin.from('messages').select('content').eq('id', (await row.getAttribute('data-message-id'))!).single()
    return JSON.stringify(data!.content)
  }

  const sentDefault = await pick('default', 'default-pick')
  expect(sentDefault).toContain('👍')
  expect(sentDefault).not.toContain('custom-thumbs')

  const sentCustom = await pick('custom', 'custom-pick')
  expect(sentCustom).toContain(emojiIds[2])
})
