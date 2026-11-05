// Journey: Discord's message shortcuts on a focused row, and the row name's reactions part.
//
// With a message row focused: E edits an own message, R replies, + opens the reaction
// picker, P pins or unpins, Backspace/Delete deletes (Shift skips the confirmation), C
// copies the text, T opens the thread panel. Each key acts only where the viewer may take
// that action, never from the composer, a control inside the row, or with Ctrl/Alt held.
// Results with no focus change are announced through the polite live region. Settings >
// Keybinds lists the keys.
//
// The row name reads author, content, reactions, the message replied to, then time and
// state. The reactions part is the reaction buttons' own labels; a custom emoji is its
// :name:. The reactions part is visually hidden: the row renders the same pixels with and
// without it.
//
// The stack has no realtime: rows are seeded before the page loads; reactions and pins
// made in the page update the stores directly.

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  composer,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { announced, recordAnnouncements } from './a11y-keyboard'

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer
let emojiName = ''
let emojiId = ''
const id: Record<string, string> = {}

const TEXT = {
  alpha: 'Alpha from the member',
  bravo: 'Bravo from the owner',
  echo: 'Echo with reactions',
  foxtrot: 'Foxtrot replies',
  charlie: 'Charlie to delete',
  delta: 'Delta to delete at once',
  golf: 'Golf without reactions',
} as const

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(120_000)
  owner = await createUser(admin, 'mskow')
  member = await createUser(admin, 'mskmb')
  server = await seedServer(admin, owner, `Shortcuts ${owner.username}`)
  await addMember(admin, member, server.id)

  emojiName = `partyblob${owner.username.slice(-6)}`
  const { data: emoji, error: emojiError } = await admin.from('emojis')
    .insert({ name: emojiName, url: `https://emoji.e2e.test/${emojiName}.png`, server_id: server.id, scope: 'server', uploader: owner.id })
    .select('id').single()
  if (emojiError || !emoji) throw new Error(`emoji: ${emojiError?.message}`)
  emojiId = emoji.id

  // created_at decides the order; seeded as admin, automod sees no burst.
  const start = Date.now() - 10 * 60_000
  const seed = async (key: keyof typeof TEXT, author: SpecUser, offset: number, extra: Record<string, unknown> = {}) => {
    const { data, error } = await admin.from('messages').insert({
      channel_id: server.generalChannelId,
      user_id: author.id,
      content: [{ type: 'text', text: TEXT[key] }],
      created_at: new Date(start + offset * 1000).toISOString(),
      ...extra,
    }).select('id').single()
    if (error || !data) throw new Error(`message ${key}: ${error?.message}`)
    id[key] = data.id
  }
  await seed('alpha', member, 0)
  await seed('bravo', owner, 1)
  await seed('echo', member, 2)
  await seed('foxtrot', member, 3, { reply_to: id.alpha })
  await seed('charlie', owner, 4)
  await seed('delta', owner, 5)
  await seed('golf', member, 6)

  const { error: reactionError } = await admin.from('reactions').insert([
    { message_id: id.echo, user_id: member.id, custom_emoji_content: '👍' },
    { message_id: id.echo, user_id: owner.id, custom_emoji_content: '👍' },
    { message_id: id.echo, user_id: member.id, emoji_id: emojiId },
    { message_id: id.foxtrot, user_id: member.id, custom_emoji_content: '❤️' },
  ])
  if (reactionError) throw new Error(`reactions: ${reactionError.message}`)
})

test.afterAll(async () => {
  await admin.from('emojis').delete().eq('id', emojiId)
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

/** The row whose own content has `text`; a reply's preview of it does not count. */
const rowOf = (page: Page, text: string) =>
  messageList(page).getByRole('article').filter({ has: page.locator('[id^="msg-body-"]', { hasText: text }) })
const announcer = (page: Page) => page.getByTestId('live-announcer-polite')
const replyBar = (page: Page) => page.locator('[data-testid="message-input"] .replyBar')
const picker = (page: Page) => page.getByRole('dialog', { name: 'Add reaction' })
const threadPanel = (page: Page) => page.locator('.thread-panel[role="dialog"]')
const confirmDialog = (page: Page) => page.getByRole('alertdialog')

async function isPinned(messageId: string): Promise<boolean> {
  const { data } = await admin.from('messages').select('is_pinned').eq('id', messageId).single()
  return data?.is_pinned === true
}

/** Deletion marks the row (CoreMessageService.deleteMessage). */
async function isDeleted(messageId: string): Promise<boolean> {
  const { data } = await admin.from('messages').select('is_deleted').eq('id', messageId).single()
  return data?.is_deleted === true
}

async function accessibleName(locator: Locator): Promise<string> {
  return locator.evaluate((el) =>
    (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => document.getElementById(part)?.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean)
      .join(' '),
  )
}

/** Positions of each pattern in `text`, in order; -1 for a pattern not found. */
function positions(text: string, patterns: RegExp[]): number[] {
  return patterns.map((p) => text.search(p))
}

const TIME = /\d{1,2}:\d{2}/

/** Settles hover and focus so two screenshots of the same pixels compare equal. */
async function neutral(page: Page): Promise<void> {
  await page.mouse.move(2, 2)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

test('message shortcuts act on the focused row', async ({ page, context, baseURL }) => {
  test.setTimeout(180_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(rowOf(page, TEXT.golf)).toBeVisible({ timeout: 30000 })
  await recordAnnouncements(page)

  await test.step('typing in the composer triggers none of them', async () => {
    await composer(page).click()
    await page.keyboard.type('erp+ct')
    await expect(composer(page)).toHaveText('erp+ct')
    await expect(replyBar(page)).toHaveCount(0)
    await expect(picker(page)).toHaveCount(0)
    await expect(threadPanel(page)).toHaveCount(0)
    await expect(messageList(page).getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace')
    await expect(composer(page)).toHaveText('')
    await expect(confirmDialog(page)).toHaveCount(0)
    expect(await isPinned(id.golf)).toBe(false)
  })

  await test.step('E edits an own message; focus returns to the row on Escape', async () => {
    const row = rowOf(page, TEXT.bravo)
    await row.focus()
    await page.keyboard.press('e')
    const editor = row.getByRole('textbox', { name: 'Edit message' })
    await expect(editor).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(row).toBeFocused()
  })

  await test.step('E on another member\'s message does nothing', async () => {
    const row = rowOf(page, TEXT.alpha)
    await row.focus()
    await page.keyboard.press('e')
    await page.waitForTimeout(300)
    await expect(messageList(page).getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
    await expect(row).toBeFocused()
  })

  await test.step('R replies: focus moves to the composer with the reply bar, which is announced', async () => {
    await rowOf(page, TEXT.alpha).focus()
    await page.keyboard.press('r')
    await expect(composer(page)).toBeFocused()
    await expect(replyBar(page)).toContainText(`Replying to ${member.displayName}`)
    await expect(announcer(page)).toHaveText(`Replying to ${member.displayName}`)
    await page.keyboard.press('Escape')
    await expect(replyBar(page)).toHaveCount(0)
  })

  await test.step('a key on a control inside the row, or with Alt or Ctrl held, does nothing', async () => {
    const row = rowOf(page, TEXT.echo)
    await row.focus()
    const pill = row.getByRole('button', { name: /^thumbs up/ })
    await pill.focus()
    await page.keyboard.press('r')
    await page.keyboard.press('p')
    await expect(pill).toBeFocused()
    await expect(replyBar(page)).toHaveCount(0)
    await row.focus()
    await page.keyboard.press('Alt+r')
    await page.keyboard.press('Alt+p')
    await page.keyboard.press('Control+Backspace')
    await page.waitForTimeout(500)
    await expect(replyBar(page)).toHaveCount(0)
    await expect(confirmDialog(page)).toHaveCount(0)
    await expect(row).toBeFocused()
    expect(await isPinned(id.echo)).toBe(false)
  })

  await test.step('+ opens the reaction picker for the row; the reaction lands and focus returns', async () => {
    const row = rowOf(page, TEXT.alpha)
    await row.focus()
    await page.keyboard.press('+')
    await expect(picker(page)).toBeVisible()
    await expect(picker(page).getByRole('textbox', { name: 'Search emoji' })).toBeFocused()
    await page.keyboard.type('grinning')
    await expect(announcer(page)).toHaveText(/\d+ emoji found/, { timeout: 10000 })
    await page.keyboard.press('Enter')
    await expect(picker(page)).toBeHidden()
    await expect(row.getByRole('button', { name: /including you$/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(row).toBeFocused()
  })

  await test.step('P pins and unpins, announced; the row name says pinned', async () => {
    const row = rowOf(page, TEXT.alpha)
    await row.focus()
    await page.keyboard.press('p')
    await expect(announcer(page)).toHaveText('Message pinned', { timeout: 10000 })
    await expect.poll(() => isPinned(id.alpha), { timeout: 15000 }).toBe(true)
    await expect(row).toHaveAccessibleName(/pinned/)
    await expect(row).toBeFocused()
    await page.waitForTimeout(300)
    await page.keyboard.press('p')
    await expect(announcer(page)).toHaveText('Message unpinned', { timeout: 10000 })
    await expect.poll(() => isPinned(id.alpha), { timeout: 15000 }).toBe(false)
  })

  await test.step('C copies the text, announced', async () => {
    const row = rowOf(page, TEXT.bravo)
    await row.focus()
    await page.keyboard.press('c')
    await expect(announcer(page)).toHaveText('Message text copied', { timeout: 10000 })
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TEXT.bravo)
    await expect(row).toBeFocused()
  })

  await test.step('T opens the thread panel for the row; Escape returns to the row', async () => {
    const row = rowOf(page, TEXT.bravo)
    await row.focus()
    await page.keyboard.press('t')
    await expect(threadPanel(page)).toBeVisible()
    await expect(threadPanel(page)).toContainText(TEXT.bravo)
    await page.keyboard.press('Escape')
    await expect(threadPanel(page)).toHaveCount(0)
    await expect(row).toBeFocused()
  })

  await test.step('Backspace asks first; Delete with Shift deletes at once; both announced', async () => {
    await rowOf(page, TEXT.charlie).focus()
    await page.keyboard.press('Backspace')
    await expect(confirmDialog(page)).toBeVisible()
    await confirmDialog(page).getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(rowOf(page, TEXT.charlie)).toHaveCount(0, { timeout: 15000 })
    await expect(rowOf(page, TEXT.delta)).toBeFocused()
    await expect(announcer(page)).toHaveText(/Message deleted/, { timeout: 10000 })
    await expect.poll(() => isDeleted(id.charlie), { timeout: 15000 }).toBe(true)

    // useAnnouncer drops a text identical to one spoken within the last second.
    await page.waitForTimeout(1100)
    const heard = (await announced(page)).length
    await page.keyboard.press('Shift+Delete')
    await expect(rowOf(page, TEXT.delta)).toHaveCount(0, { timeout: 15000 })
    await expect(confirmDialog(page)).toHaveCount(0)
    await expect(rowOf(page, TEXT.golf)).toBeFocused()
    await expect.poll(() => isDeleted(id.delta), { timeout: 15000 }).toBe(true)
    await expect.poll(async () => (await announced(page)).slice(heard).some((text) => text.includes('Message deleted')), { timeout: 10000 }).toBe(true)
  })
})

test('a member\'s shortcuts skip what they may not do', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)
  const row = rowOf(page, TEXT.bravo)
  await expect(row).toBeVisible({ timeout: 30000 })

  await row.focus()
  await page.keyboard.press('e')
  await page.keyboard.press('p')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Shift+Delete')
  await page.waitForTimeout(800)
  await expect(messageList(page).getByRole('textbox', { name: 'Edit message' })).toHaveCount(0)
  await expect(confirmDialog(page)).toHaveCount(0)
  await expect(row).toBeFocused()
  expect(await isPinned(id.bravo)).toBe(false)
  expect(await isDeleted(id.bravo)).toBe(false)

  // R and + stay available on any message.
  await page.keyboard.press('r')
  await expect(composer(page)).toBeFocused()
  await expect(replyBar(page)).toContainText(`Replying to ${owner.displayName}`)
  await page.keyboard.press('Escape')
})

test('the row name reads content, reactions, the reply, then the time', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const echo = rowOf(page, TEXT.echo)
  await expect(echo).toBeVisible({ timeout: 30000 })

  await test.step('reactions follow the content and precede the time; a custom emoji is its :name:', async () => {
    await expect(echo).toHaveAccessibleName(/Reactions: /, { timeout: 15000 })
    const name = await accessibleName(echo)
    const [content, reactions, time] = positions(name, [new RegExp(TEXT.echo), /Reactions: /, TIME])
    expect(content).toBeGreaterThanOrEqual(0)
    expect(reactions).toBeGreaterThan(content)
    expect(time).toBeGreaterThan(reactions)
    // The same words as the pills.
    const thumbs = await echo.getByRole('button', { name: /^thumbs up/ }).getAttribute('aria-label')
    const custom = await echo.getByRole('button', { name: new RegExp(`^:${emojiName}:`) }).getAttribute('aria-label')
    expect(thumbs).toBe('thumbs up, 2 reactions, including you')
    expect(name).toContain(thumbs!)
    expect(name).toContain(custom!)
    expect(name).not.toContain('emoji.e2e.test')
  })

  await test.step('on a reply, reactions come before the message replied to', async () => {
    const foxtrot = rowOf(page, TEXT.foxtrot)
    await expect(foxtrot).toHaveAccessibleName(/Reactions: /)
    const name = await accessibleName(foxtrot)
    const [content, reactions, reply, time] = positions(name, [new RegExp(TEXT.foxtrot), /Reactions: /, /Replying to/, TIME])
    expect(content).toBeGreaterThanOrEqual(0)
    expect(reactions).toBeGreaterThan(content)
    expect(reply).toBeGreaterThan(reactions)
    expect(time).toBeGreaterThan(reply)
  })

  await test.step('a message without reactions has no reactions part', async () => {
    await expect(rowOf(page, TEXT.golf)).not.toHaveAccessibleName(/Reactions/)
  })

  await test.step('the name follows reactions as they change', async () => {
    const golf = rowOf(page, TEXT.golf)
    await golf.focus()
    await golf.getByRole('button', { name: 'Add reaction', exact: true }).first().click()
    await expect(picker(page)).toBeVisible()
    await page.keyboard.type('grinning')
    await expect(announcer(page)).toHaveText(/\d+ emoji found/, { timeout: 10000 })
    await page.keyboard.press('Enter')
    await expect(golf).toHaveAccessibleName(/Reactions: grinning face, 1 reaction, including you/, { timeout: 10000 })
    await page.waitForTimeout(400)
    await golf.getByRole('button', { name: /^grinning face/ }).click()
    await expect(golf).not.toHaveAccessibleName(/Reactions/, { timeout: 10000 })
  })

  await test.step('the reactions part is visually hidden: the row renders the same pixels without it', async () => {
    const summary = page.locator(`#msg-reactions-${id.echo}`)
    await expect(summary).toHaveCSS('position', 'absolute')
    await expect(summary).toHaveCSS('width', '1px')
    await expect(summary).toHaveCSS('height', '1px')
    await expect(summary).toHaveCSS('overflow', 'hidden')
    await neutral(page)
    const box = await echo.boundingBox()
    const before = await echo.screenshot({ animations: 'disabled' })
    await summary.evaluate((el) => { (el as HTMLElement).style.display = 'none' })
    await neutral(page)
    const without = await echo.screenshot({ animations: 'disabled' })
    expect(await echo.boundingBox()).toEqual(box)
    await summary.evaluate((el) => { (el as HTMLElement).style.display = '' })
    expect(without.equals(before)).toBe(true)
  })

  await test.step('a shortcut with no visible result leaves the row\'s pixels as they were', async () => {
    const bravo = rowOf(page, TEXT.bravo)
    await neutral(page)
    const before = await bravo.screenshot({ animations: 'disabled' })
    await bravo.focus()
    await page.keyboard.press('c')
    await expect(announcer(page)).toHaveText(/Message text copied|Could not copy/, { timeout: 10000 })
    await neutral(page)
    const after = await bravo.screenshot({ animations: 'disabled' })
    expect(after.equals(before)).toBe(true)
  })
})

test('Settings > Keybinds lists the message keys', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, member)
  await page.goto('/settings/keybinds')
  await expect(page.getByRole('heading', { name: 'Message list' })).toBeVisible({ timeout: 20000 })
  const keys = page.getByTestId('kbd-help-messages')
  for (const [key, action] of [
    ['E', 'Edit your message'],
    ['R', 'Reply'],
    ['+', 'Add a reaction'],
    ['P', 'Pin or unpin'],
    ['Backspace / Delete', 'Delete; with Shift, without asking first'],
    ['C', 'Copy the text'],
    ['T', 'Create or open a thread'],
  ]) {
    const row = keys.locator('.kbd-nav-help__row').filter({ has: page.locator('kbd', { hasText: new RegExp(`^${key.replace(/[+/]/g, '\\$&')}$`) }) })
    await expect(row).toContainText(action)
  }
})
