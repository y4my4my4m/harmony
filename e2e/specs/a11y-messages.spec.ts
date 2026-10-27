// Journey: the message side of chat for a keyboard-only, screen-reader user.
//
// Messages are a labelled list of articles named author, reply target, content,
// time and state; arrows move between them; Enter or Shift+F10 opens the message
// menu; reply, react and delete work from it with focus landing on the composer,
// the message or its neighbour. Reactions are toggle buttons that say their count
// and whether the viewer is among them. The emoji pickers are dialogs with a
// labelled search and a grid of named buttons. Images render their description as
// alt text and open by keyboard. Arriving messages are announced through the
// polite live region. axe runs on each of these screens.
//
// The stack has no realtime:
// - image descriptions are rendered from message rows written as the member
//   (proving the message guards accept `altText` on a file part); the composer
//   half is checked up to the attachment's description, and the send path is
//   covered by unit tests (MessageInput.altText, useOutbox.altText);
// - an arriving message is inserted with the admin client and handed to the chat
//   store through addMessageToCache, the entry point the realtime INSERT handler
//   calls.

import { test, expect, type Page } from '@playwright/test'
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
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'
import { announced, recordAnnouncements } from './a11y-keyboard'

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer

// 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const MEDIA_ORIGIN = 'http://localhost:5192'
const mediaUrl = (name: string) => `${MEDIA_ORIGIN}/e2e-media/${name}`

const SUNSET = 'A red sunset over the harbour, two cranes in silhouette'
const CAT = 'A grey cat asleep on a keyboard'

async function post(user: SpecUser, content: unknown[], extra: Record<string, unknown> = {}): Promise<string> {
  const client = await userClient(user)
  const { data, error } = await client
    .from('messages')
    .insert({ channel_id: server.generalChannelId, user_id: user.id, content, ...extra })
    .select('id')
    .single()
  if (error || !data) throw new Error(`post: ${error?.message}`)
  return data.id
}

const rows = (page: Page) => messageList(page).getByRole('article')
const rowOf = (page: Page, text: string) => rows(page).filter({ hasText: text })
const announcer = (page: Page) => page.getByTestId('live-announcer-polite')

async function serveMedia(page: Page): Promise<void> {
  await page.route('**/e2e-media/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
}

let secondId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'a11ymo')
  member = await createUser(admin, 'a11ymm')
  server = await seedServer(admin, owner, `Msg A11y ${owner.username}`)
  await addMember(admin, member, server.id)

  await post(member, [{ type: 'text', text: 'Morning everyone' }])
  secondId = await post(member, [{ type: 'text', text: 'Coffee is ready' }])
  await post(member, [
    { type: 'mention', userId: owner.id, username: owner.username },
    { type: 'text', text: ' can you review the plan' },
  ])
  await post(member, [{ type: 'text', text: 'Plot twist: ||the butler did it|| really' }])
  await post(owner, [{ type: 'text', text: 'On it shortly' }])
  await post(owner, [{ type: 'text', text: 'Typo message to delete' }])
  await post(member, [
    { type: 'text', text: 'Harbour photo' },
    { type: 'file', fileType: 'image', url: mediaUrl('IMG_0042.png'), fileName: 'IMG_0042.png', altText: SUNSET },
  ])
  await post(member, [
    { type: 'text', text: 'Two more pictures' },
    { type: 'file', fileType: 'image', url: mediaUrl('cat.png'), fileName: 'cat.png', altText: CAT },
    { type: 'file', fileType: 'image', url: mediaUrl('DSC_0001.png'), fileName: 'DSC_0001.png' },
  ])
  const memberClient = await userClient(member)
  const { error } = await memberClient
    .from('reactions')
    .insert({ message_id: secondId, user_id: member.id, custom_emoji_content: '👍' })
  if (error) throw new Error(`reaction: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

test('messages read in order with author and time; arrows move between them', async ({ page }) => {
  test.setTimeout(150_000)
  await serveMedia(page)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const list = messageList(page).getByRole('list', { name: '#general' })

  await test.step('a labelled list of articles, one per message, named author, content and time', async () => {
    await expect(messageList(page).getByRole('list', { name: 'Messages in #general' })).toBeVisible({ timeout: 30000 })
    await expect(rowOf(page, 'Morning everyone')).toHaveAccessibleName(
      new RegExp(`^${member.displayName}.*Morning everyone.*\\d{1,2}:\\d{2}.*, [A-Z][a-z]+ \\d{1,2}, \\d{4}$`),
    )
    // Grouped under the same header, the second message still names its author and time.
    const second = rowOf(page, 'Coffee is ready')
    await expect(second).toHaveAccessibleName(new RegExp(`^${member.displayName}.*Coffee is ready.*\\d{1,2}:\\d{2}.*, [A-Z][a-z]+ \\d{1,2}, \\d{4}$`))
    await expect(second.locator('.message-header')).toHaveCount(0)
    await expect(rowOf(page, 'can you review the plan')).toHaveAccessibleName(/mentions you/)
    const items = list.getByRole('listitem')
    await expect(items.first()).toHaveAttribute('aria-posinset', '1')
  })

  await test.step('one row is the tab stop: the newest', async () => {
    await expect(rows(page).last()).toHaveAttribute('tabindex', '0')
    await expect(messageList(page).locator('[data-message-row][tabindex="0"]')).toHaveCount(1)
  })

  await test.step('names, mentions and spoilers are buttons; a covered spoiler hides its text', async () => {
    const joined = rows(page).filter({ hasText: `${owner.displayName} joined the server.` }).first()
    await expect(joined.getByRole('button', { name: owner.displayName })).toBeVisible()
    const mention = rowOf(page, 'can you review the plan')
    await expect(mention.getByRole('button', { name: new RegExp(owner.displayName) })).toBeVisible()
    const plot = rowOf(page, 'Plot twist')
    await expect(plot).not.toHaveAccessibleName(/butler/)
    const spoiler = plot.getByRole('button', { name: /^Spoiler, hidden/ })
    await expect(spoiler).toHaveAttribute('aria-expanded', 'false')
    await plot.focus()
    await spoiler.focus()
    await page.keyboard.press('Enter')
    await expect(plot.getByRole('button', { name: /^Spoiler, hidden/ })).toHaveCount(0)
    await expect(plot.locator('.md-spoiler')).toHaveClass(/revealed/)
    await expect(plot).toHaveAccessibleName(/the butler did it/)
    await expect(announcer(page)).toHaveText('Spoiler: the butler did it')
  })

  await test.step('Up, Down, Home and End move focus between messages', async () => {
    await rowOf(page, 'On it shortly').focus()
    await page.keyboard.press('ArrowUp')
    await expect(rowOf(page, 'Plot twist')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(rowOf(page, 'can you review the plan')).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(rowOf(page, 'Coffee is ready')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(rows(page).first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(rows(page).nth(1)).toBeFocused()
    await page.keyboard.press('End')
    await expect(rows(page).last()).toBeFocused()
    // PageUp moves by the rows in view.
    await page.keyboard.press('PageUp')
    await expect(rows(page).last()).not.toBeFocused()
    await expect(rows(page).nth(-2)).not.toBeFocused()
    await page.keyboard.press('End')
    // The focused row becomes the tab stop.
    await page.keyboard.press('ArrowUp')
    await expect(rows(page).nth(-2)).toHaveAttribute('tabindex', '0')
  })

  await test.step('focus shows the action bar with labelled buttons', async () => {
    const row = rowOf(page, 'Coffee is ready')
    await row.focus()
    const bar = row.getByRole('toolbar', { name: 'Message actions' })
    await expect(bar).toBeVisible()
    for (const name of ['Add reaction', 'Reply', 'Create thread', 'More actions']) {
      await expect(bar.getByRole('button', { name, exact: true })).toBeVisible()
    }
  })

  await test.step('Enter opens the message menu; Escape returns focus to the message', async () => {
    const row = rowOf(page, 'Coffee is ready')
    await row.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Message options' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(row).toBeFocused()
  })

  await test.step('a right-click opens the message menu at the pointer', async () => {
    const text = rowOf(page, 'Coffee is ready').getByText('Coffee is ready')
    const box = (await text.boundingBox())!
    const x = Math.round(box.x + box.width - 4)
    const y = Math.round(box.y + box.height / 2)
    await page.mouse.click(x, y, { button: 'right' })
    const menu = page.getByRole('menu', { name: 'Message options' })
    await expect(menu).toBeVisible()
    // Placed at the pointer, unless the viewport edge pushes it back.
    const placed = (await menu.boundingBox())!
    expect(Math.abs(placed.x - x)).toBeLessThanOrEqual(24)
    expect(Math.abs(placed.y - y)).toBeLessThanOrEqual(24)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
  })

  await test.step('a pointer click leaves the action bar to hover', async () => {
    const row = rowOf(page, 'Morning everyone')
    await row.locator('.message-group').click({ position: { x: 300, y: 8 } })
    await page.mouse.move(2, 400)
    await expect(row.getByRole('toolbar', { name: 'Message actions' })).toHaveCount(0)
  })

  await expectNoAxeViolations(page, { label: 'chat with messages' })
})

test('reply, react and delete from the keyboard', async ({ page }) => {
  test.setTimeout(150_000)
  await serveMedia(page)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(rowOf(page, 'Morning everyone')).toBeVisible({ timeout: 30000 })
  const menu = page.getByRole('menu', { name: 'Message options' })

  await test.step('Reply from the menu moves focus to the composer with the reply bar', async () => {
    await rowOf(page, 'Morning everyone').focus()
    await page.keyboard.press('Shift+F10')
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Reply', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(composer(page)).toBeFocused()
    await expect(page.locator('[data-testid="message-input"]')).toContainText(`Replying to ${member.displayName}`)
    await page.keyboard.press('Escape')
  })

  await test.step('after an edit, saved or cancelled, focus returns to the message', async () => {
    const row = rowOf(page, 'On it shortly')
    await row.focus()
    await page.keyboard.press('Enter')
    await menu.getByRole('menuitem', { name: 'Edit message' }).focus()
    await page.keyboard.press('Enter')
    const editor = row.getByRole('textbox', { name: 'Edit message' })
    await expect(editor).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(row).toBeFocused()

    await page.keyboard.press('Enter')
    await menu.getByRole('menuitem', { name: 'Edit message' }).focus()
    await page.keyboard.press('Enter')
    await expect(editor).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.type(', promise')
    await page.keyboard.press('Enter')
    await expect(rowOf(page, 'On it shortly, promise')).toBeFocused({ timeout: 15000 })
    await expect(rowOf(page, 'On it shortly, promise')).toHaveAccessibleName(/edited/)
  })

  await test.step('a reaction is a toggle button that says its count and whether you reacted', async () => {
    const row = rowOf(page, 'Coffee is ready')
    const pill = row.getByRole('button', { name: /^thumbs up, \d+ reactions?/ })
    await expect(pill).toHaveAccessibleName('thumbs up, 1 reaction')
    await expect(pill).toHaveAttribute('aria-pressed', 'false')
    await row.focus()
    await pill.focus()
    const added = page.waitForResponse((r) => r.url().includes('/rest/v1/reactions') && r.request().method() === 'POST')
    await page.keyboard.press('Space')
    await expect(pill).toHaveAttribute('aria-pressed', 'true')
    await expect(pill).toHaveAccessibleName('thumbs up, 2 reactions, including you')
    expect((await added).ok()).toBe(true)
    // The reaction store ignores a second toggle of the same emoji for 100 ms
    // after the first settles.
    await page.waitForTimeout(400)
    await page.keyboard.press('Enter')
    await expect(pill).toHaveAttribute('aria-pressed', 'false')
    await expect(pill).toHaveAccessibleName('thumbs up, 1 reaction')
  })

  await test.step('who reacted opens from the keyboard', async () => {
    const pill = rowOf(page, 'Coffee is ready').getByRole('button', { name: /^thumbs up/ })
    await pill.focus()
    await page.keyboard.press('Shift+F10')
    const dialog = page.getByRole('dialog', { name: 'Reactions' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: new RegExp(member.displayName) })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(pill).toBeFocused()
  })

  await test.step('Add reaction from the menu opens the picker; Enter in the search picks the first result', async () => {
    const row = rowOf(page, 'Morning everyone')
    await row.focus()
    await page.keyboard.press('Enter')
    await menu.getByRole('menuitem', { name: 'Add reaction', exact: true }).focus()
    await page.keyboard.press('Enter')
    const picker = page.getByRole('dialog', { name: 'Add reaction' })
    await expect(picker).toBeVisible()
    const search = picker.getByRole('textbox', { name: 'Search emoji' })
    await expect(search).toBeFocused()
    await expectNoAxeViolations(page, { include: '[data-testid="emoji-popup"]', label: 'reaction picker' })
    await page.keyboard.type('grinning')
    await expect(announcer(page)).toHaveText(/\d+ emoji found/, { timeout: 10000 })
    await page.keyboard.press('Enter')
    await expect(picker).toBeHidden()
    await expect(row.getByRole('button', { name: /including you$/ })).toHaveAttribute('aria-pressed', 'true')
    // Focus returns to the message the menu was opened on.
    await expect(row).toBeFocused()
  })

  await test.step('Delete from the menu, confirmed: focus lands on the next message', async () => {
    const row = rowOf(page, 'Typo message to delete')
    await row.focus()
    await page.keyboard.press('Enter')
    await menu.getByRole('menuitem', { name: 'Delete message' }).focus()
    await page.keyboard.press('Enter')
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(rowOf(page, 'Typo message to delete')).toHaveCount(0, { timeout: 15000 })
    await expect(rowOf(page, 'Harbour photo')).toBeFocused()
    await expect(announcer(page)).toHaveText(/Message deleted/)
  })
})

test('emoji picker from the composer works by keyboard', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  // The picker loads favourites after it opens. Held until focus has moved to a header, the
  // answer must not pull focus back to the search, where Enter picks the first emoji.
  let releaseFavourites!: () => void
  const favouritesHeld = new Promise<void>((resolve) => { releaseFavourites = resolve })
  await page.route('**/rest/v1/emoji_favorites*', async (route) => {
    await favouritesHeld
    await route.continue()
  })

  const trigger = page.locator('[data-testid="message-input"]').getByRole('button', { name: 'Emoji picker' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const picker = page.getByRole('dialog', { name: 'GIFs, stickers and emoji' })
  await expect(picker).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(picker.getByRole('tab', { name: 'Emoji' })).toHaveAttribute('aria-selected', 'true')
  const search = picker.getByRole('textbox', { name: 'Search emoji' })
  await expect(search).toBeFocused()

  await test.step('category headers are disclosure buttons named without their icon', async () => {
    const header = picker.getByRole('button', { name: 'People', exact: true })
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await header.focus()
    const favourites = page.waitForResponse((r) => r.url().includes('/rest/v1/emoji_favorites'))
    releaseFavourites()
    await favourites
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(header).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await expect(picker.locator('.emoji-item').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(header).toHaveAttribute('aria-expanded', 'false')
  })

  await test.step('Down from the search reaches the grid; arrows move between named emoji', async () => {
    await search.focus()
    await page.keyboard.type('heart')
    await expect(announcer(page)).toHaveText(/\d+ emoji found/, { timeout: 10000 })
    await page.keyboard.press('ArrowDown')
    const first = picker.locator('.emoji-item').first()
    await expect(first).toBeFocused()
    const firstName = await first.getAttribute('aria-label')
    expect(firstName).toMatch(/heart/)
    expect(firstName).not.toMatch(/_/)
    await page.keyboard.press('ArrowRight')
    await expect(picker.locator('.emoji-item').nth(1)).toBeFocused()
    // One tab stop for the whole grid: the focused emoji.
    await expect(picker.locator('.emoji-item[tabindex="0"]')).toHaveCount(1)
    await expect(picker.locator('.emoji-item').nth(1)).toHaveAttribute('tabindex', '0')
    await expectNoAxeViolations(page, { include: '[data-testid="media-picker"]', label: 'composer emoji picker' })
  })

  await test.step('Enter inserts the emoji, the picker closes and typing continues in the composer', async () => {
    await page.keyboard.press('Enter')
    await expect(picker).toBeHidden()
    await expect(composer(page)).toBeFocused()
    await expect
      .poll(() => composer(page).evaluate((el) => (el.textContent ?? '').trim().length + el.querySelectorAll('img').length))
      .toBeGreaterThan(0)
  })

  await test.step('Escape closes and focus returns to the trigger', async () => {
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(picker).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })
})

test('image descriptions: rendered as alt text, kept on attachments, lightbox by keyboard', async ({ page }) => {
  test.setTimeout(150_000)
  await serveMedia(page)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('the description is the alt text; the file name never is', async () => {
    const photo = rowOf(page, 'Harbour photo')
    await expect(photo.locator('img.content-image')).toHaveAttribute('alt', SUNSET, { timeout: 30000 })
    await expect(photo).toHaveAccessibleName(new RegExp(SUNSET))
    const gallery = rowOf(page, 'Two more pictures').locator('img.content-image')
    await expect(gallery).toHaveCount(2)
    await expect(gallery.nth(0)).toHaveAttribute('alt', CAT)
    await expect(gallery.nth(1)).toHaveAttribute('alt', 'Image, no description')
    await expect(messageList(page).locator('img[alt*="IMG_0042"], img[alt*="DSC_0001"]')).toHaveCount(0)
  })

  await test.step('the image opens by keyboard in a dialog that carries the description', async () => {
    const photo = rowOf(page, 'Harbour photo')
    await photo.focus()
    const open = photo.getByRole('button', { name: 'View image full size' })
    await open.focus()
    await page.keyboard.press('Enter')
    const viewer = page.getByRole('dialog', { name: /Media viewer/ })
    await expect(viewer).toBeVisible()
    await expect(viewer.getByRole('img', { name: SUNSET })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(viewer).toBeHidden()
    await expect(open).toBeFocused()
  })

  await test.step('the attach button opens its menu from the keyboard', async () => {
    const attach = page.getByRole('button', { name: 'Add an attachment or poll' })
    await attach.focus()
    await page.keyboard.press('Enter')
    const attachMenu = page.getByRole('menu', { name: 'Attach' })
    await expect(attachMenu).toBeVisible()
    await expect(attach).toHaveAttribute('aria-expanded', 'true')
    await expect(attachMenu.getByRole('menuitem', { name: 'Upload file' })).toBeFocused()
    await expectNoAxeViolations(page, { include: '.file-upload-menu', label: 'attach menu' })
    await page.keyboard.press('Escape')
    await expect(attachMenu).toBeHidden()
    await expect(attach).toBeFocused()
  })

  await test.step('an attached image takes a description in a labelled field', async () => {
    await recordAnnouncements(page)
    await page.locator('[data-testid="composer-file-input"]').setInputFiles({
      name: 'holiday.png',
      mimeType: 'image/png',
      buffer: PNG,
    })
    const item = page.locator('[data-testid="file-preview-item"]').filter({ hasText: 'holiday.png' })
    await expect(item).toBeVisible()
    await expect(item).toContainText('Uploaded', { timeout: 15000 })
    await expect.poll(() => announced(page)).toEqual(
      expect.arrayContaining([expect.stringMatching(/1 file attached/), expect.stringMatching(/holiday\.png uploaded/)]),
    )
    const describe = item.getByRole('button', { name: 'Add a description to holiday.png' })
    await describe.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Describe holiday.png' })
    await expect(dialog).toBeVisible()
    const field = dialog.getByRole('textbox', { name: "Describe this for people who can't see it" })
    await expect(field).toBeFocused()
    await expectNoAxeViolations(page, { include: '[data-testid="alt-text-dialog"]', label: 'alt text dialog' })
    await page.keyboard.type('Two kids building a sandcastle')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toBeHidden()
    await expect(item).toContainText('Two kids building a sandcastle')
    await expect(item.getByRole('button', { name: 'Edit the description of holiday.png' })).toBeFocused()
    await expect(announcer(page)).toHaveText(/Description saved for holiday.png/)
    await item.getByRole('button', { name: 'Remove holiday.png' }).click()
  })
})

test('a message arriving in the open channel is announced; your own is not', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(rowOf(page, 'Morning everyone')).toBeVisible({ timeout: 30000 })
  // Past the catch-up window that follows opening a channel.
  await page.waitForTimeout(3000)

  /** Inserts a row and delivers it to the open view the way the realtime handler does. */
  async function arrive(author: SpecUser, text: string): Promise<void> {
    const { data, error } = await admin
      .from('messages')
      .insert({ channel_id: server.generalChannelId, user_id: author.id, content: [{ type: 'text', text }] })
      .select('*')
      .single()
    if (error || !data) throw new Error(`insert: ${error?.message}`)
    await page.evaluate((row) => {
      const app = (document.querySelector('#app') as unknown as { __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, { addMessageToCache: (m: unknown) => void }> } } } } }).__vue_app__
      const chat = app.config.globalProperties.$pinia._s.get('chat')!
      chat.addMessageToCache({ ...row, created_at: new Date(row.created_at), updated_at: row.updated_at ? new Date(row.updated_at) : undefined })
    }, data)
    await expect(rowOf(page, text)).toBeVisible({ timeout: 15000 })
  }

  await test.step('another member\'s message is spoken politely with its author', async () => {
    await arrive(member, 'Lunch at noon?')
    await expect(announcer(page)).toHaveText(`${member.displayName}: Lunch at noon?`, { timeout: 10000 })
  })

  await test.step('your own message from another device is not spoken', async () => {
    await page.waitForTimeout(1200)
    await arrive(owner, 'Sent from my phone')
    await page.waitForTimeout(1500)
    await expect(announcer(page)).not.toHaveText(/Sent from my phone/)
  })

  await test.step('the setting turns it off', async () => {
    await page.goto('/settings/appearance')
    const toggle = page.getByRole('switch', { name: 'Announce new messages' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 20000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await openChannel(page, server.id, server.generalChannelId)
    await expect(rowOf(page, 'Morning everyone')).toBeVisible({ timeout: 30000 })
    await page.waitForTimeout(3000)
    await arrive(member, 'Anyone there?')
    await page.waitForTimeout(1500)
    await expect(announcer(page)).not.toHaveText(/Anyone there/)
    await page.evaluate(() => localStorage.removeItem('harmony.a11y.announceNewMessages'))
  })
})
