// Journey: the @ suggestions take what a display name holds. Typing kana, committed or still in
// the input method's composition, with the ASCII @ or the full-width ＠ of a Japanese input mode,
// finds the member; a name with a space is found across the space. Picking inserts the username,
// and the sent message holds a real mention.

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
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let kana: SpecUser
let spaced: SpecUser
let server: SeededServer
const KANA_NAME = 'ひらがなさん'
const SPACED_NAME = 'Eugen Rochko'

const suggestions = (page: Page) => page.locator('#auto-suggest-listbox .suggest-item')

test.beforeAll(async () => {
  owner = await createUser(admin, 'cum')
  kana = await createUser(admin, 'cuk')
  spaced = await createUser(admin, 'cus')
  for (const [user, name] of [[kana, KANA_NAME], [spaced, SPACED_NAME]] as const) {
    const { error } = await admin.from('profiles').update({ display_name: name }).eq('id', user.id)
    if (error) throw new Error(error.message)
  }
  server = await seedServer(admin, owner, `Mention ${owner.username.slice(-6)}`)
  await addMember(admin, kana, server.id)
  await addMember(admin, spaced, server.id)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  for (const user of [owner, kana, spaced]) await deleteUser(admin, user)
})

async function open(page: Page) {
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  // The list reads the member cache, filled with the member sidebar.
  await expect(page.getByText(KANA_NAME).first()).toBeVisible({ timeout: 30000 })
  await composer(page).click()
}

async function clear(page: Page) {
  await composer(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
}

test('kana finds a member and the pick sends a real mention', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  await page.keyboard.insertText('@ひらが')
  await expect(suggestions(page).filter({ hasText: KANA_NAME })).toBeVisible({ timeout: 15000 })
  await page.keyboard.press('Enter')
  await expect(composer(page)).toContainText(`@`)
  await page.keyboard.press('Enter')

  await expect.poll(async () => {
    const { data } = await admin.from('messages').select('content').eq('channel_id', server.generalChannelId).eq('user_id', owner.id).order('created_at', { ascending: false }).limit(1)
    return (data?.[0]?.content as Array<{ type: string; userId?: string }> | undefined)?.find((p) => p.type === 'mention')?.userId
  }, { timeout: 30000 }).toBe(kana.id)
})

test('the full-width @ of a Japanese input mode opens the list', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  await page.keyboard.insertText('＠ひら')
  await expect(suggestions(page).filter({ hasText: KANA_NAME })).toBeVisible({ timeout: 15000 })
  await page.keyboard.press('Tab')
  await expect(composer(page)).not.toContainText('＠')
  await clear(page)
})

test('text still in composition finds the member, and Enter commits it', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const cdp = await page.context().newCDPSession(page)
  await page.keyboard.insertText('@')
  await cdp.send('Input.imeSetComposition', { text: 'ひらが', selectionStart: 3, selectionEnd: 3 })
  await expect(suggestions(page).filter({ hasText: KANA_NAME })).toBeVisible({ timeout: 15000 })
  await cdp.send('Input.insertText', { text: 'ひらが' })
  await expect(suggestions(page).filter({ hasText: KANA_NAME })).toBeVisible()
  await clear(page)
})

test('a display name is found across its space, and the pick replaces all of it', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  await page.keyboard.insertText('hello @Eugen Ro')
  await expect(suggestions(page).filter({ hasText: SPACED_NAME })).toBeVisible({ timeout: 15000 })
  await page.keyboard.press('Enter')
  await expect(composer(page)).not.toContainText('Eugen Ro')
  await clear(page)
})

test('text after a typed name that matches nobody opens no list and Enter sends', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page)
  const text = `@nobodyhere hello ${Date.now().toString(36)}`
  await composer(page).pressSequentially(text, { delay: 5 })
  await expect(suggestions(page)).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(messageList(page).locator('.message-item').filter({ hasText: text.split(' ').pop()! })).toBeVisible({ timeout: 30000 })
})
