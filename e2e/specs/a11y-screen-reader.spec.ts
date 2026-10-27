// Journey: chat as a screen-reader user on the keyboard (issue #174).
//
// - The composer's name is spoken once: its placeholder is drawn by ::before
//   with empty alternative text, so the accessibility tree holds no copy of it.
// - No field's placeholder repeats its label.
// - A message's name reads author, its own text, the message it replies to,
//   then time of day, state and date ("9:05 AM, October 21, 2026"). Every row
//   ends with its own date; the timestamp in the row reads as the time of day
//   and keeps the full date in its title.
// - Up/Down/Home/End move between messages from any control inside a row, and
//   Escape on such a control returns to its row.
// - A message's actions and its reactions are toolbars: one Tab stop each,
//   Left/Right between their buttons, Up/Down and Home/End left to the list.

import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  addMember,
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
import { expectNoAxeViolations } from './a11y'
import { tabTo } from './a11y-keyboard'

test.use({ timezoneId: 'UTC', locale: 'en-US' })

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer

const QUESTION = 'Is the new build out yet?'
const ANSWER = 'Yes, it went up this morning'
const NOTES = 'Release notes are linked here'
const THANKS = 'Thanks, reading them now'

async function post(author: SpecUser, text: string, at: string, extra: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await admin
    .from('messages')
    .insert({ channel_id: server.generalChannelId, user_id: author.id, content: [{ type: 'text', text }], created_at: at, ...extra })
    .select('id')
    .single()
  if (error || !data) throw new Error(`post: ${error?.message}`)
  return data.id
}

const rows = (page: Page) => messageList(page).getByRole('article')
const rowOf = (page: Page, text: string) => rows(page).filter({ hasText: text })

/** Text a screen reader reads for an element: aria-hidden subtrees left out. */
const spokenText = (el: Locator) =>
  el.evaluate((root) => {
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
      if (!(node instanceof Element) || node.getAttribute('aria-hidden') === 'true') return ''
      return Array.from(node.childNodes).map(walk).join('')
    }
    return walk(root).replace(/\s+/g, ' ').trim()
  })

/**
 * The browser's accessibility tree for the element `selector` matches: its role and
 * name, and the text of every node below it, from Chromium's own tree (CDP).
 */
async function axSubtree(page: Page, selector: string): Promise<{ role: string; name: string; texts: string[] }> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable')
    await cdp.send('Accessibility.enable')
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })
    const self = nodes[0]
    const texts: string[] = []
    const visit = async (id: string) => {
      const { nodes: children } = await cdp.send('Accessibility.getChildAXNodes', { id })
      for (const child of children) {
        const value = child.name?.value
        if (typeof value === 'string' && value.trim()) texts.push(value.trim())
        await visit(child.nodeId)
      }
    }
    await visit(self.nodeId)
    return { role: String(self.role?.value ?? ''), name: String(self.name?.value ?? ''), texts }
  } finally {
    await cdp.detach()
  }
}

/** Words of a label or placeholder; singular and plural and punctuation do not count. */
function repeatedPlaceholders(page: Page) {
  return page.evaluate(() => {
    const words = (s: string) =>
      s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.replace(/s$/, ''))
    const labelOf = (el: HTMLInputElement | HTMLTextAreaElement) => {
      const ids = el.getAttribute('aria-labelledby')
      if (ids) return ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
      return el.getAttribute('aria-label') || Array.from(el.labels ?? []).map((l) => l.textContent ?? '').join(' ')
    }
    const offenders: string[] = []
    for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[placeholder], textarea[placeholder]'))) {
      if (!el.getClientRects().length) continue
      const placeholder = el.getAttribute('placeholder') ?? ''
      const label = new Set(words(labelOf(el)))
      const said = words(placeholder)
      if (label.size && said.length && said.every((w) => label.has(w))) offenders.push(`"${labelOf(el).trim()}" + "${placeholder}"`)
    }
    return offenders
  })
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'a11ysro')
  member = await createUser(admin, 'a11ysrm')
  server = await seedServer(admin, owner, `SR ${owner.username}`)
  await addMember(admin, member, server.id)

  const question = await post(member, QUESTION, '2026-10-20T15:10:00Z')
  await post(member, 'Asking for the release channel', '2026-10-20T15:12:00Z')
  await post(owner, ANSWER, '2026-10-21T09:05:00Z', { reply_to: question })
  const notes = await post(member, NOTES, '2026-10-21T09:06:00Z')
  await post(member, THANKS, '2026-10-21T09:07:00Z')
  const { error } = await admin
    .from('reactions')
    .insert({ message_id: notes, user_id: member.id, custom_emoji_content: '👍' })
  if (error) throw new Error(`reaction: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

async function openChat(page: Page): Promise<void> {
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(rowOf(page, THANKS)).toBeVisible({ timeout: 30000 })
}

test('the composer is named once; its placeholder is no text in the tree', async ({ page }) => {
  test.setTimeout(120_000)
  await openChat(page)
  await expect(composer(page)).toHaveAttribute('aria-label', 'Message #general')
  const tree = await axSubtree(page, '[data-testid="message-input"] .rich-text-editor')
  expect(tree.role).toBe('textbox')
  expect(tree.name).toBe('Message #general')
  expect(tree.texts).not.toContain('Message #general')
  // Still drawn for sighted users.
  const drawn = await composer(page).evaluate((el) => getComputedStyle(el, '::before').content)
  expect(drawn).toContain('Message #general')
})

test('no field\'s placeholder repeats its label', async ({ page }) => {
  test.setTimeout(150_000)
  await openChat(page)
  const found: string[] = []
  const sweep = async () => { found.push(...(await repeatedPlaceholders(page))) }

  await test.step('members and the reaction picker', async () => {
    await sweep()
    const row = rowOf(page, NOTES)
    await row.focus()
    await row.getByRole('button', { name: 'Add reaction', exact: true }).first().click()
    const picker = page.getByRole('dialog', { name: 'Add reaction' })
    await expect(picker).toBeVisible()
    await sweep()
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()
  })

  await test.step('profile, appearance and Drive', async () => {
    await page.goto('/settings/profile')
    await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible({ timeout: 20000 })
    await sweep()
    await page.goto('/settings/appearance')
    await page.getByTestId('theme-option-custom').click({ timeout: 30000 })
    await expect(page.getByRole('textbox', { name: 'Theme name' })).toBeVisible()
    await sweep()
    await page.goto('/drive')
    await expect(page.getByTestId('drive-search')).toBeVisible({ timeout: 20000 })
    await sweep()
  })

  expect(found).toEqual([])
  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  const search = page.getByTestId('member-search')
  await expect(search).toHaveAccessibleName('Search members', { timeout: 30000 })
  await expect(search).toHaveAttribute('placeholder', 'Name or username')
})

test('a message reads author, its text, the message it replies to, then time before date', async ({ page }) => {
  test.setTimeout(120_000)
  await openChat(page)
  await expect(rowOf(page, ANSWER)).toHaveAccessibleName(
    new RegExp(`^${owner.displayName}.* ${ANSWER} Replying to .*${QUESTION.replace('?', '\\?')} 9:05\\sAM, October 21, 2026$`),
  )
  await expect(rowOf(page, NOTES)).toHaveAccessibleName(new RegExp(`^${member.displayName}.* ${NOTES}.* 9:06\\sAM, October 21, 2026$`))
})

test('every message ends with its own date; its timestamp reads as the time of day', async ({ page }) => {
  test.setTimeout(120_000)
  await openChat(page)
  await expect(rowOf(page, QUESTION).first()).toHaveAccessibleName(/ 3:10\sPM, October 20, 2026$/)
  await expect(rowOf(page, 'Asking for the release channel')).toHaveAccessibleName(/ 3:12\sPM, October 20, 2026$/)
  await expect(rowOf(page, THANKS)).toHaveAccessibleName(/ 9:07\sAM, October 21, 2026$/)
  // A row under a header and a grouped row: each timestamp speaks the time only
  // and keeps the full date in its title.
  for (const text of [QUESTION, 'Asking for the release channel']) {
    const time = rowOf(page, text).first().locator('time').first()
    expect(await spokenText(time)).toMatch(/^\d{1,2}:\d{2}\s[AP]M$/)
    await expect(time).toHaveAttribute('title', /October 20, 2026/)
  }
  // Browse mode reads the date from the day headings.
  await expect(messageList(page).getByRole('heading', { name: 'October 21, 2026' })).toBeVisible()
})

test('arrows and Escape work from wherever focus lands in a message', async ({ page }) => {
  test.setTimeout(120_000)
  await openChat(page)

  await test.step('from the author button, the reply reference and a reaction', async () => {
    const reply = rowOf(page, ANSWER)
    await reply.focus()
    await reply.locator('button.username').focus()
    await page.keyboard.press('ArrowUp')
    await expect(rowOf(page, 'Asking for the release channel')).toBeFocused()

    await reply.focus()
    await reply.getByRole('button', { name: /^Replying to/ }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(rowOf(page, NOTES)).toBeFocused()

    const notes = rowOf(page, NOTES)
    await notes.getByRole('button', { name: /^thumbs up, 1 reaction/ }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(rowOf(page, THANKS)).toBeFocused()
    await notes.getByRole('button', { name: /^thumbs up, 1 reaction/ }).focus()
    await page.keyboard.press('Home')
    await expect(rows(page).first()).toBeFocused()
  })

  await test.step('Escape on a control inside a message returns to the message', async () => {
    const reply = rowOf(page, ANSWER)
    await reply.focus()
    const quote = reply.getByRole('button', { name: /^Replying to/ })
    await quote.focus()
    await page.keyboard.press('Escape')
    await expect(reply).toBeFocused()
  })
})

test('message actions and reactions are toolbars with one Tab stop', async ({ page }) => {
  test.setTimeout(150_000)
  await openChat(page)

  const row = rowOf(page, NOTES)
  await row.focus()
  const bar = row.getByRole('toolbar', { name: 'Message actions' })
  await expect(bar).toBeVisible()
  const react = bar.getByRole('button', { name: 'Add reaction', exact: true })
  const reply = bar.getByRole('button', { name: 'Reply', exact: true })
  const more = bar.getByRole('button', { name: 'More actions', exact: true })

  await test.step('Tab reaches the toolbar once; Left and Right move inside it', async () => {
    await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1)
    await tabTo(page, react, { max: 15 })
    await page.keyboard.press('ArrowRight')
    await expect(reply).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(more).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(react).toBeFocused()
    // Tab leaves the toolbar from any of its buttons.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Tab')
    expect(await bar.evaluate((el) => el.contains(document.activeElement))).toBe(false)
  })

  await test.step('the reactions are a toolbar too', async () => {
    const reactions = row.getByRole('toolbar', { name: 'Reactions' })
    await expect(reactions).toBeVisible()
    await expect(reactions.locator('button[tabindex="0"]')).toHaveCount(1)
    await reactions.getByRole('button', { name: /^thumbs up/ }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(reactions.getByRole('button', { name: 'Add reaction', exact: true })).toBeFocused()
  })

  await test.step('Up and Down from a toolbar button move between messages; End goes to the newest', async () => {
    await row.focus()
    await bar.getByRole('button', { name: 'Reply', exact: true }).focus()
    await page.keyboard.press('ArrowUp')
    await expect(rowOf(page, ANSWER)).toBeFocused()
    await rowOf(page, ANSWER).getByRole('toolbar', { name: 'Message actions' }).getByRole('button', { name: 'Reply', exact: true }).focus()
    await page.keyboard.press('End')
    await expect(rows(page).last()).toBeFocused()
  })

  await expectNoAxeViolations(page, { label: 'chat with toolbars' })
})
