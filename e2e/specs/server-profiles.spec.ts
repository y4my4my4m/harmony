// Journey: a member sets a nickname and avatar for one server. The channel shows
// them, a DM keeps the account profile, and a moderator's reset clears the avatar
// but leaves the nickname.
//
// CHANGE_NICKNAME comes from the server's @everyone role, so the member edits their own
// profile without a grant. The moderator holds MANAGE_NICKNAMES through a role above the plain member's; a third user owns the server.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  grantRole,
  messageList,
  seedServer,
  addMember,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

let owner: SpecUser
let member: SpecUser
let moderator: SpecUser
let friend: SpecUser
let server: SeededServer
let dmId = ''
const channelText = 'hello from the server'
const dmText = 'hello from the dm'

test.beforeAll(async () => {
  owner = await createUser(admin, 'spo')
  member = await createUser(admin, 'spm')
  moderator = await createUser(admin, 'spmod')
  friend = await createUser(admin, 'spf')
  server = await seedServer(admin, owner, `Profiles ${owner.username}`)
  await addMember(admin, member, server.id)
  await addMember(admin, moderator, server.id)
  await grantRole(admin, server.id, moderator, {
    name: 'Nick mod',
    position: 5,
    permissions: ['VIEW_CHANNEL', 'MANAGE_NICKNAMES'],
  })

  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: member.id,
    content: [{ type: 'text', text: channelText }],
  })
  if (error) throw new Error(`channel message: ${error.message}`)

  const { data, error: convError } = await admin
    .from('conversations')
    .insert({ type: 'direct', created_by: member.id })
    .select('id')
    .single()
  if (convError || !data) throw new Error(`conversation: ${convError?.message}`)
  dmId = data.id
  await admin.from('conversation_participants').insert([
    { conversation_id: dmId, user_id: member.id },
    { conversation_id: dmId, user_id: friend.id },
  ])
  await admin
    .from('messages')
    .insert({ conversation_id: dmId, user_id: member.id, content: [{ type: 'text', text: dmText }] })
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
  await deleteUser(admin, moderator)
  await deleteUser(admin, friend)
})

const fileInSrc = (file: string) => new RegExp(file.split('.').map((part) => part.replace(/\W/g, '.')).join('\\.'))

const messageRow = (page: Page, text: string) =>
  messageList(page).locator('.message-item').filter({ hasText: text })

async function storedProfile() {
  const { data, error } = await admin
    .from('user_servers')
    .select('nickname, avatar_url')
    .eq('server_id', server.id)
    .eq('user_id', member.id)
    .single()
  if (error || !data) throw new Error(`user_servers: ${error?.message}`)
  return data
}

test('server nickname and avatar show in the server, not in DMs, and a reset keeps the nickname', async ({ browser }) => {
  test.setTimeout(240_000)

  const context = await browser.newContext()
  const page = await context.newPage()
  let avatarFile = ''

  await test.step('set a nickname and avatar from the server menu', async () => {
    await signIn(page, member)
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    await expect(messageList(page)).toBeVisible({ timeout: 30000 })

    await page.locator(`[data-rail-kind="server"][data-rail-id="${server.id}"]`).click({ button: 'right' })
    await page.locator('[data-action="edit-server-profile"]').click()
    await expect(page).toHaveURL(/\/settings\/server-profiles\?server=/, { timeout: 30000 })
    await expect(page.getByTestId('server-profiles')).toBeVisible({ timeout: 30000 })
    await expect(page.getByTestId('server-picker')).toHaveValue(server.id)

    await page.getByTestId('field-avatar').setInputFiles({ name: 'server-avatar.png', mimeType: 'image/png', buffer: PNG })
    await expect.poll(async () => (await storedProfile()).avatar_url, { timeout: 30000 }).toBeTruthy()

    await page.getByTestId('field-nickname').fill('Ally')
    await page.getByTestId('save-server-profile').click()
    await expect.poll(async () => (await storedProfile()).nickname, { timeout: 30000 }).toBe('Ally')

    const url = (await storedProfile()).avatar_url as string
    avatarFile = url.split('/').pop()!.split('?')[0]
    expect(avatarFile).not.toBe('')
  })

  await test.step('the channel shows the nickname and server avatar', async () => {
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    const row = messageRow(page, channelText)
    await expect(row).toBeVisible({ timeout: 30000 })
    await expect(row.locator('.username')).toContainText('Ally')
    await expect(row.locator('.username')).not.toContainText(member.displayName)
    await expect(row.locator('.message-avatar img')).toHaveAttribute('src', fileInSrc(avatarFile), {
      timeout: 30000,
    })
  })

  await test.step('a DM keeps the account name and avatar', async () => {
    await page.goto(`/dm/${dmId}`)
    await dismissAnnouncements(page)
    const row = messageRow(page, dmText)
    await expect(row).toBeVisible({ timeout: 30000 })
    await expect(row.locator('.username')).toContainText(member.displayName)
    await expect(row.locator('.username')).not.toContainText('Ally')
    await expect(row.locator('.message-avatar img')).not.toHaveAttribute('src', fileInSrc(avatarFile))
  })

  await test.step('a moderator resets the server profile: avatar reverts, nickname stays', async () => {
    const modContext = await browser.newContext()
    const modPage = await modContext.newPage()
    await signIn(modPage, moderator)
    await modPage.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(modPage)
    await expect(messageList(modPage)).toBeVisible({ timeout: 30000 })

    const memberItem = modPage.locator('.user-sidebar .user-item').filter({ hasText: 'Ally' })
    await expect(memberItem).toBeVisible({ timeout: 30000 })
    await memberItem.click({ button: 'right' })
    await modPage.getByTestId('user-menu-reset-server-profile').click()
    const dialog = modPage.getByRole('alertdialog', { name: 'Reset server profile' })
    await expect(dialog).toBeVisible({ timeout: 30000 })
    await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect.poll(async () => (await storedProfile()).avatar_url, { timeout: 30000 }).toBeNull()
    await modContext.close()

    const stored = await storedProfile()
    expect(stored.avatar_url).toBeNull()
    expect(stored.nickname).toBe('Ally')

    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await dismissAnnouncements(page)
    const row = messageRow(page, channelText)
    await expect(row).toBeVisible({ timeout: 30000 })
    await expect(row.locator('.username')).toContainText('Ally')
    await expect(row.locator('.message-avatar img')).not.toHaveAttribute('src', fileInSrc(avatarFile))
  })

  await context.close()
})
