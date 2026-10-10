// Journey: members who manage channels without owning the server delete a
// channel from its context menu, and it stays deleted after a reload. A plain
// member's menu offers no delete.
//
// A DELETE refused by RLS matches no row and reports success; the reload and the
// row count are what show the channel gone.

import { test, expect } from '@playwright/test'
import {
  addChannel,
  addMember,
  adminClient,
  assignRole,
  channelRow,
  createUser,
  deleteChannelFromMenu,
  deleteUser,
  grantRole,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let administrator: SpecUser
let channelManager: SpecUser
let member: SpecUser
let server: SeededServer
const channels = { byAdmin: 'scratch-admin', byManager: 'scratch-manager', kept: 'scratch-kept' }

test.beforeAll(async () => {
  owner = await createUser(admin, 'cmo')
  administrator = await createUser(admin, 'cma')
  channelManager = await createUser(admin, 'cmm')
  member = await createUser(admin, 'cmp')
  server = await seedServer(admin, owner, `Channels ${owner.username}`)
  for (const user of [administrator, channelManager, member])
    await addMember(admin, user, server.id)

  const { data: adminRole, error } = await admin
    .from('server_roles')
    .select('id')
    .eq('server_id', server.id)
    .eq('is_admin', true)
    .single()
  if (error || !adminRole) throw new Error(`Admin role: ${error?.message}`)
  await assignRole(admin, server.id, administrator, adminRole.id)
  await grantRole(admin, server.id, channelManager, {
    name: 'Channel Managers',
    position: 10,
    permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'MANAGE_CHANNELS'],
  })

  for (const name of Object.values(channels)) await addChannel(admin, server, name)
})

test.afterAll(async () => {
  for (const user of [owner, administrator, channelManager, member]) await deleteUser(admin, user)
})

async function channelExists(name: string): Promise<boolean> {
  const { data } = await admin
    .from('channels')
    .select('id')
    .eq('server_id', server.id)
    .eq('name', name)
  return (data ?? []).length > 0
}

for (const [who, name] of [
  ['an Admin role holder', channels.byAdmin],
  ['a Manage Channels holder', channels.byManager],
] as const) {
  test(`${who} deletes a channel and it stays deleted`, async ({ page }) => {
    test.setTimeout(120_000)
    const actor = name === channels.byAdmin ? administrator : channelManager

    await signIn(page, actor)
    await openChannel(page, server.id, server.generalChannelId)
    await expect(channelRow(page, name)).toBeVisible({ timeout: 30000 })

    const deleted = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/channels') && r.request().method() === 'DELETE',
    )
    await deleteChannelFromMenu(page, name)
    expect((await deleted).ok()).toBe(true)
    await expect(channelRow(page, name)).toHaveCount(0)
    await expect(page.locator('.Vue-Toastification__toast--error')).toHaveCount(0)

    await page.reload()
    await expect(channelRow(page, channels.kept)).toBeVisible({ timeout: 30000 })
    await expect(channelRow(page, name)).toHaveCount(0)
    expect(await channelExists(name)).toBe(false)
  })
}

test('a plain member is offered no delete', async ({ page }) => {
  test.setTimeout(120_000)

  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)
  await channelRow(page, channels.kept).click({ button: 'right' })
  const menu = page.locator('.context-menu')
  await expect(menu.locator('.context-menu-item').filter({ hasText: 'Copy' })).toBeVisible({
    timeout: 10000,
  })
  await expect(
    menu.locator('.context-menu-item').filter({ hasText: 'Delete channel' }),
  ).toHaveCount(0)
  expect(await channelExists(channels.kept)).toBe(true)
})
