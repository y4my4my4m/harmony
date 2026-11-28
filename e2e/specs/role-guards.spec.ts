// Journey: what the database refuses around self-assignable roles and role menus (1.9.8).
//
// Covered: a member without Manage Roles posting a role_menu part through the API, and its author
// editing one (20261125100001_role_menu_guard.sql), while /rolemenu and deleting the message work as
// before; the 61st role pick of a minute (account_role_picks_per_minute, 20261124100001), whose chip
// goes back; a role with powers refused as the role for new members, and not given when one is stored
// (20261116400001_self_assignable_roles.sql).

import { test, expect, type Page } from '@playwright/test'
import {
  addChannel,
  addMember,
  adminClient,
  composer,
  createUser,
  deleteUser,
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
let owner: SpecUser
let alice: SpecUser
let bob: SpecUser
let server: SeededServer
const roleIds: Record<string, string> = {}

const menu = (title: string) => [
  { type: 'role_menu', serverId: server.id, group: null, title },
  { type: 'text', text: title },
]

async function holds(user: SpecUser, roleName: string): Promise<boolean> {
  const { data } = await admin.from('user_roles').select('id').eq('user_id', user.id).eq('role_id', roleIds[roleName])
  return (data ?? []).length > 0
}

const card = (page: Page, title: string) =>
  messageList(page).locator('[data-testid="role-menu-card"]').filter({ hasText: title })

test.beforeAll(async () => {
  owner = await createUser(admin, 'rgo')
  alice = await createUser(admin, 'rga')
  bob = await createUser(admin, 'rgb')
  server = await seedServer(admin, owner, `Role guards ${owner.username}`)
  await addMember(admin, alice, server.id)
  const rows = [
    { name: 'Blue', position: 1, permissions: '0', self_assignable: true, self_assign_group: 'Colours' },
    { name: 'Newcomer', position: 2, permissions: '0', self_assignable: false, self_assign_group: null },
    { name: 'Mods', position: 10, permissions: String(permissionMask(['VIEW_CHANNEL', 'MANAGE_MESSAGES'])), self_assignable: false, self_assign_group: null },
  ]
  const { data, error } = await admin.from('server_roles').insert(rows.map((r) => ({ server_id: server.id, ...r }))).select('id, name')
  if (error || !data) throw new Error(`roles: ${error?.message}`)
  for (const r of data as Array<{ id: string; name: string }>) roleIds[r.name] = r.id
})

test.afterAll(async () => {
  await deleteUser(admin, bob)
  await deleteUser(admin, alice)
  await deleteUser(admin, owner)
})

test('a role menu is posted with Manage Roles and stays as posted', async ({ page }) => {
  test.setTimeout(150_000)
  const channelId = await addChannel(admin, server, 'menus')
  await signIn(page, owner)
  await openChannel(page, server.id, channelId)
  await composer(page).click()
  await composer(page).pressSequentially('/rolemenu', { delay: 20 })
  await page.keyboard.press('Enter')
  await page.locator('[data-testid="role-menu-title"]').fill('Pick a colour')
  await page.locator('[data-testid="role-menu-post"]').click()
  await expect(card(page, 'Pick a colour')).toBeVisible({ timeout: 30000 })
  // The card shows before its row is stored.
  const stored = async () => (await admin.from('messages').select('id, content').eq('channel_id', channelId).maybeSingle()).data
  await expect.poll(async () => (await stored()) !== null, { timeout: 15000 }).toBe(true)
  const posted = await stored()

  await test.step('a member without the permission cannot post one through the API', async () => {
    const client = await userClient(alice)
    const { error } = await client.from('messages').insert({ channel_id: channelId, user_id: alice.id, content: menu('Free roles') })
    expect(error).toMatchObject({ code: '42501', message: 'Missing permission: MANAGE_ROLES' })
    const { error: text } = await client.from('messages').insert({ channel_id: channelId, user_id: alice.id, content: [{ type: 'text', text: 'hello' }] })
    expect(text).toBeNull()
  })

  await test.step('its author cannot rewrite it, nor turn a message into one', async () => {
    const client = await userClient(owner)
    const { error } = await client.from('messages').update({ content: menu('Something else') }).eq('id', posted!.id)
    expect(error).toMatchObject({ code: '42501', message: 'ROLE_MENU_IMMUTABLE: a role menu message cannot be edited' })
    const { data: plain } = await client.from('messages')
      .insert({ channel_id: channelId, user_id: owner.id, content: [{ type: 'text', text: 'plain' }] }).select('id').single()
    const { error: smuggled } = await client.from('messages').update({ content: menu('Smuggled') }).eq('id', plain!.id)
    expect(smuggled?.message).toContain('ROLE_MENU_IMMUTABLE')
    const { data: now } = await admin.from('messages').select('content').eq('id', posted!.id).single()
    expect(now?.content).toEqual(posted!.content)
    await expect(messageList(page).locator('[data-testid="role-menu-card"]')).toHaveCount(1)
  })

  await test.step('its author deletes it', async () => {
    await card(page, 'Pick a colour').click({ button: 'right' })
    await page.getByRole('menu', { name: 'Message options' }).getByRole('menuitem', { name: 'Delete message' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(messageList(page).locator('[data-testid="role-menu-card"]')).toHaveCount(0, { timeout: 15000 })
    await expect.poll(async () => {
      const { data } = await admin.from('messages').select('is_deleted').eq('id', posted!.id).single()
      return data?.is_deleted
    }).toBe(true)
  })
})

test('the 61st role pick of a minute is refused and the chip goes back', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, alice)
  await openChannel(page, server.id, server.generalChannelId)
  await page.locator('.channel-sidebar .server-name').click()
  await page.locator('[data-testid="server-pick-roles"]').click()
  const chip = page.locator('[data-testid="role-picker"]').locator(`[data-testid="role-chip-${roleIds.Blue}"]`)
  await expect(chip).toHaveAttribute('aria-checked', 'false', { timeout: 15000 })

  const client = await userClient(alice)
  for (let i = 0; i < 60; i++) {
    const { error } = await client.rpc('set_my_self_assignable_role', { p_role_id: roleIds.Blue, p_on: i % 2 === 0 })
    expect(error).toBeNull()
  }
  expect(await holds(alice, 'Blue')).toBe(false)

  const answered = page.waitForResponse((r) => r.url().includes('/rpc/set_my_self_assignable_role'))
  await chip.click()
  const refusal = await (await answered).json()
  expect(refusal.message).toMatch(/^ANTISPAM_RATE_LIMITED:\d+$/)
  expect(JSON.parse(refusal.details)).toEqual({ kind: 'role_pick', limit: 60, window_seconds: 60 })
  await expect(page.locator('.Vue-Toastification__toast--error')).toBeVisible({ timeout: 15000 })
  await expect(chip).toHaveAttribute('aria-checked', 'false')
  expect(await holds(alice, 'Blue')).toBe(false)
})

test('a role with powers is not the role for new members', async () => {
  const client = await userClient(owner)
  const { error } = await client.rpc('set_server_join_role', { p_server_id: server.id, p_role_id: roleIds.Mods })
  expect(error).toMatchObject({ message: 'ROLE_NOT_OPEN', details: 'ROLE_GRANTS_PERMISSIONS' })
  const { error: chosen } = await client.rpc('set_server_join_role', { p_server_id: server.id, p_role_id: roleIds.Newcomer })
  expect(chosen).toBeNull()

  // Stored by another writer, as a server template stores one.
  const { error: stored } = await admin.from('server_settings').update({ default_role_id: roleIds.Mods }).eq('server_id', server.id)
  expect(stored).toBeNull()
  await admin.from('servers').update({ public: true }).eq('id', server.id)
  const joining = await userClient(bob)
  const { error: joined } = await joining.rpc('join_public_server', { p_server_id: server.id })
  expect(joined).toBeNull()
  const { data: member } = await admin.from('user_servers').select('status').eq('server_id', server.id).eq('user_id', bob.id).single()
  expect(member?.status).toBe('accepted')
  expect(await holds(bob, 'Mods')).toBe(false)
})
