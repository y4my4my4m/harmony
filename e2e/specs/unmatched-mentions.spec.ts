// Journey: a typed @handle that names no local account is plain text.
//
// - In the composer its pill turns back into the text typed once the lookup answers; a
//   member's pill stays.
// - Sent, it is stored inside the text around it and pings nobody; the member typed beside
//   it is a mention and is notified. An edit that adds one stores it the same way.
// - A message stored with such a handle as a mention part (`unresolved-<user>`) shows it as
//   text; an unknown remote handle stays a mention.

import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  composer,
  createUser,
  deleteUser,
  instanceDomain,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

test.describe.configure({ mode: 'serial' })

const admin = adminClient()
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const NOBODY = `zq${RUN}x`

let owner: SpecUser
let member: SpecUser
let server: SeededServer

async function mentionsOf(user: SpecUser, messageId: string): Promise<number> {
  const { data, error } = await admin
    .from('notifications')
    .select('id')
    .eq('user_id', user.id)
    .eq('type', 'mention')
    .eq('data->>message_id', messageId)
  if (error) throw new Error(`notifications: ${error.message}`)
  return data?.length ?? 0
}

async function storedContent(messageId: string): Promise<Array<Record<string, any>>> {
  const { data, error } = await admin.from('messages').select('content').eq('id', messageId).single()
  if (error) throw new Error(`message: ${error.message}`)
  return data.content as Array<Record<string, any>>
}

const textOf = (content: Array<Record<string, any>>) =>
  content.filter((p) => p.type === 'text').map((p) => p.text).join('')

const rowOf = (page: Page, text: string) => messageList(page).locator('.message-item').filter({ hasText: text }).last()

async function sendAndWait(page: Page, marker: string): Promise<string> {
  await expect(page.getByRole('option')).toHaveCount(0, { timeout: 15000 })
  await page.keyboard.press('Enter')
  const posted = rowOf(page, marker)
  await expect(posted).toBeVisible({ timeout: 30000 })
  await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
  return (await posted.getAttribute('data-message-id')) ?? ''
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'umo')
  member = await createUser(admin, 'umm')
  server = await seedServer(admin, owner, `Unmatched ${owner.username.slice(-6)}`)
  await addMember(admin, member, server.id)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

test('a typed handle of no account is text in the composer and the message, and pings nobody', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  const marker = `meet ${RUN}`
  let id = ''

  // The composer redraws its text, and draws pills, on a picked suggestion and on markdown
  // markers; `**ok**` makes it redraw while the handles of no account are complete.
  await test.step('the composer keeps the picked member a pill and the rest text', async () => {
    await composer(page).click()
    await composer(page).pressSequentially(`@${member.username}`, { delay: 20 })
    await page.getByRole('option', { name: `${member.displayName}, member, @${member.username}` }).click()
    await expect(composer(page).locator('.editor-mention')).toHaveCount(1, { timeout: 15000 })
    await page.keyboard.type(`${marker} at @5:32, not @${NOBODY} **ok**`, { delay: 10 })
    await expect(composer(page)).toContainText(`at @5:32, not @${NOBODY} `)
    await expect(composer(page).locator('.editor-mention')).toHaveCount(1, { timeout: 15000 })
    await expect(composer(page).locator('.editor-mention')).toHaveAttribute('data-username', member.username)
  })

  await test.step('sent, only the member is a mention and is notified', async () => {
    id = await sendAndWait(page, marker)
    const content = await storedContent(id)
    expect(content.filter((p) => p.type === 'mention').map((p) => p.userId)).toEqual([member.id])
    expect(textOf(content)).toBe(` ${marker} at @5:32, not @${NOBODY} **ok**`)
    await expect.poll(() => mentionsOf(member, id), { timeout: 15000 }).toBe(1)
  })

  await test.step('the message shows one pill and the text as typed', async () => {
    const row = rowOf(page, marker)
    await expect(row.locator('.mention')).toHaveCount(1)
    await expect(row).toContainText(`at @5:32, not @${NOBODY} ok`)
  })

  await test.step('an edit that adds a handle of no account stores it as text', async () => {
    const row = rowOf(page, marker)
    await row.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Message options' })
    await menu.getByRole('menuitem', { name: 'Edit message' }).focus()
    await page.keyboard.press('Enter')
    const editor = row.getByRole('textbox', { name: 'Edit message' })
    await expect(editor).toBeFocused()
    await page.keyboard.press('ControlOrMeta+End')
    // Enter saves an edit only with no @ query open: five words follow the handle.
    await page.keyboard.type(` cc @${NOBODY}y and then some more`)
    await page.keyboard.press('Enter')
    await expect.poll(async () => textOf(await storedContent(id)), { timeout: 15000 }).toContain(`cc @${NOBODY}y and then some more`)
    const content = await storedContent(id)
    expect(content.filter((p) => p.type === 'mention').map((p) => p.userId)).toEqual([member.id])
    await expect(rowOf(page, marker).locator('.mention')).toHaveCount(1)
  })
})

test('a stored mention of no account shows as text; an unknown remote handle stays a pill', async ({ page }) => {
  test.setTimeout(120_000)
  const domain = await instanceDomain(admin)
  const marker = `old ${RUN}`
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: owner.id,
    content: [
      { type: 'text', text: `${marker} ` },
      { type: 'mention', userId: `unresolved-ghost${RUN}`, username: `ghost${RUN}`, domain, isLocal: true },
      { type: 'text', text: ' and ' },
      { type: 'mention', userId: 'unresolved-kai@spacify.cloud', username: 'kai', domain: 'spacify.cloud', isLocal: false },
    ],
  })
  if (error) throw new Error(`seed: ${error.message}`)

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const row = rowOf(page, marker)
  await expect(row).toBeVisible({ timeout: 30000 })
  await expect(row).toContainText(`${marker} @ghost${RUN} and`)
  await expect(row.locator('.mention')).toHaveCount(1)
  await expect(row.locator('.mention')).toContainText('kai')
})
