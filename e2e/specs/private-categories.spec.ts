// Journey: private categories. A category header, and the category row itself, reach only those
// who see a channel in it; channel managers see every category, those members cannot see marked.
// Edit category and Create category carry a Private toggle with roles and members; the template
// syncs onto the category's synced channels, a new channel in the category inherits it, and a
// channel edited apart says "Not synced with <category>" with Sync now restoring the template.
//
// The stack has no realtime: each viewer loads the page after the change it checks.

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  channelRow,
  createUser,
  deleteUser,
  grantRole,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'
import { animationsSettled } from './a11y-keyboard'

const admin = adminClient()
const users: SpecUser[] = []
const contexts: BrowserContext[] = []

let owner: SpecUser
let member: SpecUser
let insider: SpecUser
let manager: SpecUser

test.beforeAll(async () => {
  owner = await createUser(admin, 'pco')
  member = await createUser(admin, 'pcm')
  insider = await createUser(admin, 'pci')
  manager = await createUser(admin, 'pcg')
  users.push(owner, member, insider, manager)
})

test.afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close()
})

test.afterAll(async () => {
  for (const user of users) await deleteUser(admin, user)
})

interface Setup {
  server: SeededServer
  insidersRoleId: string
  everyoneRoleId: string
}

/** A server of owner's with member, insider (role Insiders) and manager (MANAGE_CHANNELS). */
async function setupServer(name: string): Promise<Setup> {
  const server = await seedServer(admin, owner, `${name} ${owner.username}`)
  for (const user of [member, insider, manager]) await addMember(admin, user, server.id)
  const insidersRoleId = await grantRole(admin, server.id, insider, { name: 'Insiders', position: 1, permissions: [] })
  await grantRole(admin, server.id, manager, { name: 'Managers', position: 2, permissions: ['MANAGE_CHANNELS'] })
  const { data: everyone } = await admin.from('server_roles').select('id').eq('server_id', server.id).eq('is_default', true).single()
  return { server, insidersRoleId, everyoneRoleId: everyone!.id }
}

async function addCategory(server: SeededServer, name: string, order: number): Promise<string> {
  const client = await userClient(owner)
  const { data, error } = await client.from('channel_categories').insert({ server_id: server.id, name, order }).select('id').single()
  expect(error).toBeNull()
  return data!.id
}

async function createChannelAsOwner(server: SeededServer, name: string, category: string, priv = false): Promise<string> {
  const client = await userClient(owner)
  const { data, error } = await client.rpc('create_channel', {
    p_server_id: server.id, p_name: name, p_type: 0, p_category: category, p_private: priv, p_allowed_role_ids: [],
  })
  expect(error).toBeNull()
  return (data as { id: string }).id
}

/** A channel's overrides as "<role>:<allow>/<deny>", @everyone named "everyone". */
async function overridesOf(channelId: string): Promise<string[]> {
  const { data, error } = await admin
    .from('channel_permission_overrides')
    .select('allow_permissions, deny_permissions, server_roles(name, is_default)')
    .eq('channel_id', channelId)
  expect(error).toBeNull()
  return (data ?? [])
    .map((o: any) => `${o.server_roles?.is_default ? 'everyone' : o.server_roles?.name}:${o.allow_permissions}/${o.deny_permissions}`)
    .sort()
}

async function channelId(server: SeededServer, name: string): Promise<string> {
  const { data } = await admin.from('channels').select('id').eq('server_id', server.id).eq('name', name).single()
  return data!.id
}

const headerNames = (page: Page) => page.locator('.channel-sidebar .category-name')
const header = (page: Page, name: string) =>
  page.locator('.channel-sidebar .category-header').filter({
    has: page.locator('.category-name').getByText(name, { exact: true }),
  })

/** `user`'s view of the server in a context of its own, closed with the test. */
async function viewAs(browser: Browser, user: SpecUser, server: SeededServer): Promise<Page> {
  const context = await browser.newContext()
  contexts.push(context)
  const page = await context.newPage()
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  return page
}

test('a member who sees no channel of a category gets neither its header nor its row', async ({ page }) => {
  test.setTimeout(120_000)
  const { server } = await setupServer('Hidden headers')
  const staff = await addCategory(server, 'Staff', 2)
  await addCategory(server, 'Public', 3)
  await createChannelAsOwner(server, 'staff-chat', staff, true)

  const bodies: string[] = []
  page.on('response', async (response) => {
    if (!response.url().includes('/rest/v1/channel_categories')) return
    bodies.push(await response.text().catch(() => ''))
  })
  await signIn(page, member)
  await openChannel(page, server.id, server.generalChannelId)

  await expect(headerNames(page)).toHaveText(['Text Channels', 'Voice Channels'], { timeout: 15000 })
  await expect(channelRow(page, 'staff-chat')).toHaveCount(0)
  expect(bodies.length).toBeGreaterThan(0)
  for (const body of bodies) {
    expect(body).not.toContain('Staff')
    expect(body).not.toContain('Public')
  }
})

test('a channel manager sees every header, marked when members cannot see it', async ({ page }) => {
  test.setTimeout(120_000)
  const { server } = await setupServer('Manager headers')
  const staff = await addCategory(server, 'Staff', 2)
  await addCategory(server, 'Public', 3)
  await createChannelAsOwner(server, 'staff-chat', staff, true)

  await signIn(page, manager)
  await openChannel(page, server.id, server.generalChannelId)

  await expect(headerNames(page)).toHaveText(['Text Channels', 'Voice Channels', 'Staff', 'Public'], { timeout: 15000 })
  for (const name of ['Staff', 'Public']) {
    await expect(header(page, name)).toHaveAttribute('data-hidden-from-members', 'true')
    await expect(header(page, name).locator('.category-lock')).toHaveAttribute('title', "Members can't see this category")
  }
  await expect(header(page, 'Text Channels')).not.toHaveAttribute('data-hidden-from-members', /.*/)
  await expect(header(page, 'Text Channels').locator('.category-lock')).toHaveCount(0)
})

test('making a category private hides it and its channels from @everyone and shows them to an allowed role', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const { server } = await setupServer('Private edit')
  const lounge = await addCategory(server, 'Lounge', 2)
  const loungeChat = await createChannelAsOwner(server, 'lounge-chat', lounge)

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await header(page, 'Lounge').click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit category' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit category' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  const toggle = dialog.getByRole('switch', { name: 'Private category' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 15000 })
  await toggle.click()
  await dialog.getByRole('checkbox', { name: 'Insiders' }).check()
  await animationsSettled(page)
  await expectNoAxeViolations(page, { include: '[data-testid="category-edit-dialog"]', label: 'edit category dialog' })
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(dialog).toBeHidden({ timeout: 15000 })
  await expect(page.locator('.Vue-Toastification__toast')).toContainText('Permissions saved and synced to 1 channel.')

  await expect.poll(() => overridesOf(loungeChat), { timeout: 15000 }).toEqual(['Insiders:2/0', 'everyone:0/2'])
  await expect(header(page, 'Lounge')).toHaveAttribute('data-private', 'true')

  const memberPage = await viewAs(browser, member, server)
  await expect(headerNames(memberPage)).toHaveText(['Text Channels', 'Voice Channels'], { timeout: 15000 })
  await expect(channelRow(memberPage, 'lounge-chat')).toHaveCount(0)

  const insiderPage = await viewAs(browser, insider, server)
  await expect(headerNames(insiderPage)).toHaveText(['Text Channels', 'Voice Channels', 'Lounge'], { timeout: 15000 })
  await expect(header(insiderPage, 'Lounge')).toHaveAttribute('data-private', 'true')
  await expect(channelRow(insiderPage, 'lounge-chat')).toHaveCount(1)
})

test('a channel created in a private category is private', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const { server } = await setupServer('Private create')

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await page.locator('.channel-sidebar .server-name').click()
  await page.locator('.server-dropdown li').filter({ hasText: 'Create category' }).click()
  const create = page.getByRole('dialog', { name: 'Create category' })
  await create.locator('input.modern-input').fill('Vault')
  await create.getByRole('switch', { name: 'Private category' }).click()
  await create.getByRole('checkbox', { name: 'Insiders' }).check()
  await create.locator('button').filter({ hasText: 'Create category' }).click()
  await expect(create).toBeHidden({ timeout: 30000 })
  await expect(header(page, 'Vault')).toHaveAttribute('data-private', 'true', { timeout: 15000 })

  await header(page, 'Vault').click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Create channel' }).click()
  const modal = page.getByRole('dialog', { name: 'Create channel' })
  await expect(modal).toBeVisible({ timeout: 15000 })
  await expect(modal).toContainText('Vault is private: this channel starts with its permissions.')
  await modal.locator('input.modern-input').fill('vault-notes')
  const created = page.waitForResponse((r) => r.url().includes('/rpc/create_channel'))
  await modal.locator('button').filter({ hasText: 'Create channel' }).click()
  expect((await created).status()).toBe(200)
  await expect(modal).toBeHidden({ timeout: 15000 })

  const notes = await channelId(server, 'vault-notes')
  expect(await overridesOf(notes)).toEqual(['Insiders:2/0', 'everyone:0/2'])
  expect((await admin.rpc('channel_permissions_synced', { p_channel_id: notes })).data).toBe(true)

  await page.reload()
  await expect(channelRow(page, 'vault-notes').locator('.channel-lock')).toHaveAttribute('title', 'Private channel', { timeout: 15000 })

  const memberPage = await viewAs(browser, member, server)
  await expect(headerNames(memberPage)).toHaveText(['Text Channels', 'Voice Channels'], { timeout: 15000 })
  await expect(channelRow(memberPage, 'vault-notes')).toHaveCount(0)

  const insiderPage = await viewAs(browser, insider, server)
  await expect(channelRow(insiderPage, 'vault-notes')).toHaveCount(1, { timeout: 15000 })
})

test('a channel edited apart says Not synced, and Sync now restores the category permissions', async ({ page }) => {
  test.setTimeout(180_000)
  const { server, insidersRoleId, everyoneRoleId } = await setupServer('Sync now')
  const ops = await addCategory(server, 'Ops', 2)
  const client = await userClient(owner)
  const { error } = await client.rpc('set_category_permissions', {
    p_category_id: ops,
    p_overrides: [
      { target_type: 'role', role_id: everyoneRoleId, allow_permissions: 0, deny_permissions: 2 },
      { target_type: 'role', role_id: insidersRoleId, allow_permissions: 2, deny_permissions: 0 },
    ],
  })
  expect(error).toBeNull()
  const room = await createChannelAsOwner(server, 'ops-room', ops)
  expect(await overridesOf(room)).toEqual(['Insiders:2/0', 'everyone:0/2'])

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await channelRow(page, 'ops-room').locator('.channel-name').getByText('ops-room', { exact: true }).click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item').filter({ hasText: 'Edit channel' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit channel' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  await dialog.getByRole('tab', { name: 'Permissions' }).click()

  const notice = dialog.getByTestId('channel-permission-sync')
  await expect(notice).toHaveAttribute('data-synced', 'true', { timeout: 15000 })
  await expect(notice).toContainText('Synced with Ops')

  await dialog.locator('.perm-role-pill').filter({ hasText: 'Insiders' }).click()
  await dialog.getByRole('radiogroup', { name: 'Send Messages' }).getByRole('radio', { name: 'Deny' }).click()
  await dialog.getByRole('button', { name: 'Save permissions' }).click()
  await expect.poll(() => overridesOf(room), { timeout: 15000 }).toEqual(['Insiders:2/4096', 'everyone:0/2'])

  await expect(notice).toHaveAttribute('data-synced', 'false', { timeout: 15000 })
  await expect(notice).toContainText('Not synced with Ops')
  // The save toast's progress bar runs for its whole timeout.
  await expect(page.locator('.Vue-Toastification__toast')).toHaveCount(0, { timeout: 15000 })
  await animationsSettled(page)
  await expectNoAxeViolations(page, { include: '[data-testid="channel-edit-dialog"]', label: 'channel permissions, not synced' })
  await notice.getByRole('button', { name: 'Sync now' }).click()

  await expect(notice).toHaveAttribute('data-synced', 'true', { timeout: 15000 })
  await expect.poll(() => overridesOf(room), { timeout: 15000 }).toEqual(['Insiders:2/0', 'everyone:0/2'])
  await expect(dialog.getByRole('radiogroup', { name: 'Send Messages' }).getByRole('radio', { name: 'Inherit' }))
    .toHaveAttribute('aria-checked', 'true')
})

test('dragging a channel into a category changes no permission until Sync is chosen', async ({ page }) => {
  test.setTimeout(180_000)
  const { server, insidersRoleId, everyoneRoleId } = await setupServer('Move sync')
  const ops = await addCategory(server, 'Ops', 2)
  const client = await userClient(owner)
  const { error } = await client.rpc('set_category_permissions', {
    p_category_id: ops,
    p_overrides: [
      { target_type: 'role', role_id: everyoneRoleId, allow_permissions: 0, deny_permissions: 2 },
      { target_type: 'role', role_id: insidersRoleId, allow_permissions: 2, deny_permissions: 0 },
    ],
  })
  expect(error).toBeNull()
  await createChannelAsOwner(server, 'ops-room', ops)
  const { data: text } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const loose = await createChannelAsOwner(server, 'loose', text!.category)
  expect(await overridesOf(loose)).toEqual([])

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  const from = (await channelRow(page, 'loose').boundingBox())!
  const to = (await channelRow(page, 'ops-room').boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 8, { steps: 4 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 2, { steps: 4 })
  await page.mouse.up()

  const prompt = page.getByRole('alertdialog', { name: 'Sync permissions?' })
  await expect(prompt).toBeVisible({ timeout: 15000 })
  await expect.poll(async () => (await admin.from('channels').select('category').eq('id', loose).single()).data?.category)
    .toBe(ops)
  expect(await overridesOf(loose)).toEqual([])

  await prompt.getByRole('button', { name: 'Sync permissions' }).click()
  await expect.poll(() => overridesOf(loose), { timeout: 15000 }).toEqual(['Insiders:2/0', 'everyone:0/2'])
  await expect(channelRow(page, 'loose').locator('.channel-lock')).toHaveAttribute('title', 'Private channel')
})
