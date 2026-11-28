// Journey: a channel permission override stays with its role or member.
//
// #cleanup allows Manage Messages to Mods, set by the owner. Mods ranks above Managers, so the
// manager cannot take the role through user_roles. A manager holding Manage Channels and Manage
// Roles, without Manage Messages:
// - cannot repoint that override at their own role or at themselves (42501, row unchanged), and
//   still has no Delete on another member's message in #cleanup;
// - edits the Mods override in place from the channel editor: a Send Messages deny saves and Mods
//   keep Manage Messages.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addChannel,
  addMember,
  channelRow,
  createUser,
  deleteUser,
  grantRole,
  messageList,
  openChannel,
  permissionMask,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()

const MANAGE_MESSAGES = permissionMask(['MANAGE_MESSAGES'])
const SEND_MESSAGES = permissionMask(['SEND_MESSAGES'])

let owner: SpecUser
let manager: SpecUser
let author: SpecUser
let server: SeededServer
let cleanupId: string
let managersRoleId: string
let modsRoleId: string
let overrideId: string

async function overrideRow(): Promise<string> {
  const { data, error } = await admin
    .from('channel_permission_overrides')
    .select('target_type, role_id, user_id, allow_permissions, deny_permissions')
    .eq('id', overrideId)
    .single()
  if (error || !data) throw new Error(`override: ${error?.message}`)
  return [data.target_type, data.role_id, data.user_id, data.allow_permissions, data.deny_permissions].join(' ')
}

/** Resolves once the viewer's permissions in `channelId` have been answered. */
function channelPermissionsLoaded(page: Page, channelId: string) {
  return page.waitForResponse(
    (response) => response.url().includes('/rest/v1/rpc/get_user_permissions')
      && (response.request().postData() ?? '').includes(channelId),
    { timeout: 120000 },
  )
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'cotown')
  manager = await createUser(admin, 'cotmgr')
  author = await createUser(admin, 'cotaut')
  server = await seedServer(admin, owner, `Overrides ${owner.username}`)
  for (const member of [manager, author]) await addMember(admin, member, server.id)
  cleanupId = await addChannel(admin, server, 'cleanup')

  managersRoleId = await grantRole(admin, server.id, manager, {
    name: 'Managers', position: 5, permissions: ['MANAGE_CHANNELS', 'MANAGE_ROLES'],
  })
  const { data: mods, error: modsError } = await admin
    .from('server_roles')
    .insert({ server_id: server.id, name: 'Mods', position: 8, permissions: 0 })
    .select('id')
    .single()
  if (modsError || !mods) throw new Error(`role Mods: ${modsError?.message}`)
  modsRoleId = mods.id

  const { data: row, error: rowError } = await admin
    .from('channel_permission_overrides')
    .insert({ channel_id: cleanupId, target_type: 'role', role_id: modsRoleId, allow_permissions: MANAGE_MESSAGES, deny_permissions: 0 })
    .select('id')
    .single()
  if (rowError || !row) throw new Error(`override: ${rowError?.message}`)
  overrideId = row.id

  const { error: postError } = await admin
    .from('messages')
    .insert({ channel_id: cleanupId, user_id: author.id, content: [{ type: 'text', text: 'Spam in cleanup' }] })
  if (postError) throw new Error(`post: ${postError.message}`)
})

test.afterAll(async () => {
  for (const user of [owner, manager, author]) await deleteUser(admin, user)
})

test('an override is not moved onto the manager\'s role or the manager', async ({ page }) => {
  test.setTimeout(150_000)
  const before = `role ${modsRoleId}  ${MANAGE_MESSAGES} 0`
  expect(await overrideRow()).toBe(before)

  await test.step('the database refuses both moves', async () => {
    const client = await userClient(manager)
    const toRole = await client
      .from('channel_permission_overrides')
      .update({ role_id: managersRoleId })
      .eq('id', overrideId)
      .select('id')
    expect(toRole.error?.code).toBe('42501')
    expect(toRole.error?.message).toBe('an override stays with its target')

    const toMember = await client
      .from('channel_permission_overrides')
      .update({ target_type: 'user', role_id: null, user_id: manager.id })
      .eq('id', overrideId)
      .select('id')
    expect(toMember.error?.code).toBe('42501')
    expect(await overrideRow()).toBe(before)
  })

  await test.step('#cleanup: the manager has no Delete on another member\'s message', async () => {
    const loaded = channelPermissionsLoaded(page, cleanupId)
    await signIn(page, manager)
    await openChannel(page, server.id, cleanupId)
    await loaded
    const row = messageList(page).getByRole('article').filter({ hasText: 'Spam in cleanup' })
    await expect(row).toBeVisible({ timeout: 30000 })
    await row.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Message options' })
    await expect(menu.getByRole('menuitem', { name: 'Reply' })).toBeVisible({ timeout: 15000 })
    await expect(menu.getByRole('menuitem', { name: 'Delete message' })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })
})

test('the manager edits the Mods override in place', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, manager)
  await openChannel(page, server.id, server.generalChannelId)
  await channelRow(page, 'cleanup').locator('.channel-name').getByText('cleanup', { exact: true }).first().click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit channel' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit channel' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  await dialog.getByRole('tab', { name: 'Permissions' }).click()

  await dialog.locator('.perm-role-pill').filter({ hasText: 'Mods' }).click()
  await dialog.getByRole('radiogroup', { name: 'Send Messages' }).getByRole('radio', { name: 'Deny' }).click()
  await dialog.getByRole('button', { name: 'Save permissions' }).click()
  await expect(page.getByText('Channel permissions saved')).toBeVisible({ timeout: 15000 })
  await expect.poll(overrideRow, { timeout: 15000 }).toBe(`role ${modsRoleId}  ${MANAGE_MESSAGES} ${SEND_MESSAGES}`)
})
