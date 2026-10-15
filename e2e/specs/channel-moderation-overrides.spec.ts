// Journey: channel permission overrides decide who removes other members' messages; timeouts
// follow the role hierarchy; ADD_REACTIONS and ATTACH_FILES hold for members.
//
// - A helper whose role has Manage Messages only through #cleanup's override deletes another
//   member's message there from the message menu, and gets no Delete on that member's message in
//   #general, where the database refuses it too.
// - A moderator with Manage Messages server-wide has Delete in #general and none in #quiet, whose
//   override denies it to the moderator role.
// - A moderator with Timeout Members cannot time out a member ranked above them; the owner can.
// - #quiet denies ADD_REACTIONS and ATTACH_FILES to @everyone: a member's new reaction is refused
//   with a notice, joining an existing reaction works, and an uploaded attachment is refused there
//   and accepted in #general.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addChannel,
  addMember,
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

const admin = adminClient()

// Bit positions in permission_bit_names().
const ATTACH_FILES = 2 ** 17
const ADD_REACTIONS = 2 ** 18
const MANAGE_MESSAGES = 2 ** 21
const TIMEOUT_MEMBERS = 2 ** 11

let owner: SpecUser
let helper: SpecUser
let author: SpecUser
let moderator: SpecUser
let senior: SpecUser
let server: SeededServer
let cleanupId: string
let quietId: string
let cleanupMessageId: string
let generalMessageId: string
let quietMessageId: string

async function role(name: string, position: number, permissions: number, members: SpecUser[]): Promise<string> {
  const { data, error } = await admin
    .from('server_roles')
    .insert({ server_id: server.id, name, position, permissions })
    .select('id')
    .single()
  if (error || !data) throw new Error(`role ${name}: ${error?.message}`)
  for (const member of members) {
    const { error: assignError } = await admin
      .from('user_roles')
      .insert({ user_id: member.id, role_id: data.id, server_id: server.id })
    if (assignError) throw new Error(`assign ${name}: ${assignError.message}`)
  }
  return data.id
}

async function override(channelId: string, roleId: string, allow: number, deny: number): Promise<void> {
  const { error } = await admin.from('channel_permission_overrides').insert({
    channel_id: channelId,
    target_type: 'role',
    role_id: roleId,
    allow_permissions: allow,
    deny_permissions: deny,
  })
  if (error) throw new Error(`override: ${error.message}`)
}

async function post(user: SpecUser, channelId: string, content: unknown[]): Promise<string> {
  const client = await userClient(user)
  const { data, error } = await client
    .from('messages')
    .insert({ channel_id: channelId, user_id: user.id, content })
    .select('id')
    .single()
  if (error || !data) throw new Error(`post: ${error?.message}`)
  return data.id
}

const rowOf = (page: Page, text: string) => messageList(page).getByRole('article').filter({ hasText: text })
const messageMenu = (page: Page) => page.getByRole('menu', { name: 'Message options' })

/**
 * Resolves once the viewer's permissions in `channelId` have been answered. RoleService caches
 * the answer for the session, so the wait starts before sign-in, which may open the channel.
 */
function channelPermissionsLoaded(page: Page, channelId: string) {
  return page.waitForResponse(
    (response) => response.url().includes('/rest/v1/rpc/get_user_permissions')
      && (response.request().postData() ?? '').includes(channelId),
    { timeout: 120000 },
  )
}

async function isDeleted(messageId: string): Promise<boolean> {
  const { data } = await admin.from('messages').select('is_deleted').eq('id', messageId).single()
  return data?.is_deleted === true
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'cmoown')
  helper = await createUser(admin, 'cmohlp')
  author = await createUser(admin, 'cmoaut')
  moderator = await createUser(admin, 'cmomod')
  senior = await createUser(admin, 'cmosen')
  server = await seedServer(admin, owner, `Moderation ${owner.username}`)
  for (const member of [helper, author, moderator, senior]) await addMember(admin, member, server.id)
  cleanupId = await addChannel(admin, server, 'cleanup')
  quietId = await addChannel(admin, server, 'quiet')

  const helpers = await role('Helpers', 1, 0, [helper])
  const mods = await role('Mods', 5, MANAGE_MESSAGES | TIMEOUT_MEMBERS, [moderator])
  await role('Seniors', 10, 0, [senior])
  const { data: everyone } = await admin
    .from('server_roles')
    .select('id')
    .eq('server_id', server.id)
    .eq('is_default', true)
    .single()
  await override(cleanupId, helpers, MANAGE_MESSAGES, 0)
  await override(quietId, mods, 0, MANAGE_MESSAGES)
  await override(quietId, everyone!.id, 0, ADD_REACTIONS | ATTACH_FILES)

  cleanupMessageId = await post(author, cleanupId, [{ type: 'text', text: 'Spam in cleanup' }])
  generalMessageId = await post(author, server.generalChannelId, [{ type: 'text', text: 'Hello from general' }])
  quietMessageId = await post(owner, quietId, [{ type: 'text', text: 'Quiet announcement' }])
  await post(author, quietId, [{ type: 'text', text: 'Author in quiet' }])
})

test.afterAll(async () => {
  for (const user of [owner, helper, author, moderator, senior]) await deleteUser(admin, user)
})

test('a channel Allow grants Manage Messages in that channel only', async ({ page }) => {
  test.setTimeout(150_000)
  const generalLoaded = channelPermissionsLoaded(page, server.generalChannelId)
  await signIn(page, helper)

  await test.step('#cleanup: Delete is in the menu of another member\'s message and removes it', async () => {
    await openChannel(page, server.id, cleanupId)
    const row = rowOf(page, 'Spam in cleanup')
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.click({ button: 'right' })
    const remove = messageMenu(page).getByRole('menuitem', { name: 'Delete message' })
    await expect(remove).toBeVisible({ timeout: 15000 })
    await remove.click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(rowOf(page, 'Spam in cleanup')).toHaveCount(0, { timeout: 15000 })
    await expect.poll(() => isDeleted(cleanupMessageId), { timeout: 15000 }).toBe(true)
  })

  await test.step('#general: no Delete on that member\'s message, and the database refuses it', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await generalLoaded
    const row = rowOf(page, 'Hello from general')
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.hover()
    await expect(row.getByTestId('msg-action-delete')).toHaveCount(0)
    await row.click({ button: 'right' })
    await expect(messageMenu(page)).toBeVisible()
    await expect(messageMenu(page).getByRole('menuitem', { name: 'Reply' })).toBeVisible()
    await expect(messageMenu(page).getByRole('menuitem', { name: 'Delete message' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    const client = await userClient(helper)
    const { data, error } = await client
      .from('messages')
      .update({ content: [{ type: 'text', text: '[deleted]' }], is_deleted: true })
      .eq('id', generalMessageId)
      .select('id')
    expect(error).toBeNull()
    expect(data).toEqual([])
    expect(await isDeleted(generalMessageId)).toBe(false)
  })
})

test('a channel Deny removes a server-wide Manage Messages there', async ({ page }) => {
  test.setTimeout(150_000)
  const quietLoaded = channelPermissionsLoaded(page, quietId)
  await signIn(page, moderator)

  await test.step('#general: the moderator has Delete', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    const row = rowOf(page, 'Hello from general')
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.click({ button: 'right' })
    await expect(messageMenu(page).getByRole('menuitem', { name: 'Delete message' })).toBeVisible({ timeout: 15000 })
    await page.keyboard.press('Escape')
  })

  await test.step('#quiet: none, and the database refuses it', async () => {
    await openChannel(page, server.id, quietId)
    await quietLoaded
    const row = rowOf(page, 'Author in quiet')
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.click({ button: 'right' })
    await expect(messageMenu(page).getByRole('menuitem', { name: 'Reply' })).toBeVisible()
    await expect(messageMenu(page).getByRole('menuitem', { name: 'Delete message' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    const client = await userClient(moderator)
    const { data } = await client
      .from('messages')
      .update({ content: [{ type: 'text', text: '[deleted]' }], is_deleted: true })
      .eq('id', quietMessageId)
      .select('id')
    expect(data).toEqual([])
  })
})

test('a timeout on a higher-ranked member is refused', async () => {
  const mod = await userClient(moderator)
  const refused = await mod.rpc('set_server_member_timeout', {
    p_server_id: server.id, p_user_id: senior.id, p_seconds: 60, p_reason: null,
  })
  expect(refused.error?.code).toBe('42501')
  expect(refused.error?.message).toBe('Cannot time out a member with an equal or higher role')

  const lower = await mod.rpc('set_server_member_timeout', {
    p_server_id: server.id, p_user_id: author.id, p_seconds: 60, p_reason: null,
  })
  expect(lower.error).toBeNull()
  expect((await mod.rpc('set_server_member_timeout', {
    p_server_id: server.id, p_user_id: author.id, p_seconds: 0, p_reason: null,
  })).error).toBeNull()

  const ownerClient = await userClient(owner)
  expect((await ownerClient.rpc('set_server_member_timeout', {
    p_server_id: server.id, p_user_id: senior.id, p_seconds: 60, p_reason: null,
  })).error).toBeNull()
  expect((await ownerClient.rpc('set_server_member_timeout', {
    p_server_id: server.id, p_user_id: senior.id, p_seconds: 0, p_reason: null,
  })).error).toBeNull()
})

test('ADD_REACTIONS and ATTACH_FILES hold in a channel that denies them', async ({ page }) => {
  test.setTimeout(150_000)
  const ownerClient = await userClient(owner)
  const { error: ownerReaction } = await ownerClient
    .from('reactions')
    .insert({ message_id: quietMessageId, user_id: owner.id, custom_emoji_content: '🦀' })
  expect(ownerReaction).toBeNull()

  await signIn(page, author)

  await test.step('a new reaction from the menu is refused with a notice', async () => {
    await openChannel(page, server.id, quietId)
    const row = rowOf(page, 'Quiet announcement')
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.click({ button: 'right' })
    const quick = messageMenu(page).locator('.quick-reaction-btn:not(.more-btn)').first()
    await expect(quick).toBeVisible()
    await quick.click()
    await expect(page.getByText('You can only join existing reactions in this channel.')).toBeVisible({ timeout: 15000 })
    const { data } = await admin.from('reactions').select('custom_emoji_content').eq('message_id', quietMessageId)
    expect(data?.map((r) => r.custom_emoji_content)).toEqual(['🦀'])
  })

  await test.step('joining an existing reaction works', async () => {
    const client = await userClient(author)
    const { error } = await client
      .from('reactions')
      .insert({ message_id: quietMessageId, user_id: author.id, custom_emoji_content: '🦀' })
    expect(error).toBeNull()
  })

  await test.step('an uploaded attachment is refused in #quiet and accepted in #general', async () => {
    const client = await userClient(author)
    const upload = (channelId: string) => [
      { type: 'text', text: 'see attached' },
      { type: 'file', url: '', fileType: 'image', path: `c/${channelId}/${author.id}/${Date.now()}.png` },
    ]
    const refused = await client.from('messages').insert({ channel_id: quietId, user_id: author.id, content: upload(quietId) })
    expect(refused.error?.code).toBe('42501')
    expect(refused.error?.message).toBe('Missing permission: ATTACH_FILES')
    const accepted = await client
      .from('messages')
      .insert({ channel_id: server.generalChannelId, user_id: author.id, content: upload(server.generalChannelId) })
    expect(accepted.error).toBeNull()
  })
})
