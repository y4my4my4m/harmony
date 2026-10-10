// Journey: a Manage Roles holder edits a role ranked below their own and grants
// it only permissions they hold; a role above them is read-only. The owner
// saves a change to @everyone's permissions.
//
// Each save is read back from server_roles: a refused UPDATE matches no row,
// and the editor would show the edit as saved until the next load.

import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  grantRole,
  PERMISSION_BITS,
  permissionMask,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let manager: SpecUser
let server: SeededServer
let juniorsId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'rmo')
  manager = await createUser(admin, 'rmm')
  server = await seedServer(admin, owner, `Roles ${owner.username}`)
  await addMember(admin, manager, server.id)
  await grantRole(admin, server.id, manager, {
    name: 'Role Managers',
    position: 10,
    permissions: [
      'VIEW_CHANNEL',
      'SEND_MESSAGES',
      'READ_MESSAGE_HISTORY',
      'CREATE_INVITE',
      'MANAGE_ROLES',
    ],
  })
  const { data, error } = await admin
    .from('server_roles')
    .insert([
      {
        server_id: server.id,
        name: 'Juniors',
        position: 5,
        permissions: permissionMask(['VIEW_CHANNEL']),
      },
      {
        server_id: server.id,
        name: 'Seniors',
        position: 20,
        permissions: permissionMask(['VIEW_CHANNEL']),
      },
    ])
    .select('id, name')
  if (error || !data) throw new Error(`roles: ${error?.message}`)
  juniorsId = data.find((r) => r.name === 'Juniors')!.id
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, manager)
})

const pill = (page: Page, name: string) =>
  page
    .locator('.role-rail .role-pill')
    .filter({ has: page.locator('.role-pill-name', { hasText: new RegExp(`^${name}$`) }) })
const nameInput = (page: Page) =>
  page.locator('.role-editor .form-group').filter({ hasText: 'Role name' }).locator('input')
const permToggle = (page: Page, label: string) =>
  page
    .locator('.perm-row')
    .filter({ has: page.locator('.perm-row-label', { hasText: label }) })
    .locator('.toggle-switch')

async function openRoles(page: Page): Promise<void> {
  await page.goto(`/server/${server.id}?section=roles`)
  await expect(page.locator('.role-rail .role-pill').first()).toBeVisible({ timeout: 30000 })
}

/** Clicks Save changes and waits for the server_roles PATCH. */
async function save(page: Page): Promise<void> {
  const patched = page.waitForResponse(
    (r) => r.url().includes('/rest/v1/server_roles') && r.request().method() === 'PATCH',
  )
  await page.locator('.editor-footer .save-btn').click()
  expect((await patched).ok()).toBe(true)
}

async function role(id: string) {
  const { data } = await admin
    .from('server_roles')
    .select('name, permissions')
    .eq('id', id)
    .single()
  return { name: data?.name as string, permissions: BigInt(data?.permissions ?? 0) }
}

const hasBit = (mask: bigint, name: keyof typeof PERMISSION_BITS) =>
  (mask & (1n << BigInt(PERMISSION_BITS[name]))) !== 0n

test('a Manage Roles holder edits a role below them, not one above', async ({ page }) => {
  test.setTimeout(150_000)
  const renamed = `Juniors ${manager.username.slice(-4)}`

  await signIn(page, manager)
  await openRoles(page)
  await expect(page.locator('.create-role-btn')).toBeVisible()

  await test.step('a role ranked above is read-only', async () => {
    await pill(page, 'Seniors').click()
    await expect(page.locator('.role-editor h3')).toHaveText('Seniors')
    await expect(nameInput(page)).toBeDisabled()
    await expect(page.locator('.editor-footer')).toHaveCount(0)
  })

  await test.step('a role ranked below renames and saves', async () => {
    await pill(page, 'Juniors').click()
    await expect(page.locator('.role-editor h3')).toHaveText('Juniors')
    await expect(nameInput(page)).toBeEnabled()
    await nameInput(page).fill(renamed)
    await save(page)
    expect((await role(juniorsId)).name).toBe(renamed)
  })

  await test.step('only permissions the manager holds can be granted', async () => {
    await page.locator('.editor-tabs .tab-btn').filter({ hasText: 'Permissions' }).click()
    await expect(permToggle(page, 'Ban Members')).toHaveAttribute('aria-disabled', 'true')
    const invite = permToggle(page, 'Create Invite')
    await expect(invite).not.toHaveAttribute('aria-disabled', 'true')
    await expect(invite).toHaveAttribute('aria-checked', 'false')
    await invite.click()
    await expect(invite).toHaveAttribute('aria-checked', 'true')
    await save(page)
    expect(hasBit((await role(juniorsId)).permissions, 'CREATE_INVITE')).toBe(true)
  })

  await test.step('the edits survive a reload', async () => {
    await openRoles(page)
    await expect(pill(page, renamed)).toBeVisible()
    await expect(pill(page, 'Juniors')).toHaveCount(0)
  })
})

test("the owner saves @everyone's permissions", async ({ page }) => {
  test.setTimeout(150_000)

  const { data: everyone } = await admin
    .from('server_roles')
    .select('id')
    .eq('server_id', server.id)
    .eq('is_default', true)
    .single()
  expect(hasBit((await role(everyone!.id)).permissions, 'ADD_REACTIONS')).toBe(true)

  await signIn(page, owner)
  await openRoles(page)
  const defaultPill = page
    .locator('.role-rail .role-pill')
    .filter({ has: page.locator('.role-badge.default') })

  await test.step('turn Add Reactions off and save', async () => {
    await defaultPill.click()
    await page.locator('.editor-tabs .tab-btn').filter({ hasText: 'Permissions' }).click()
    const reactions = permToggle(page, 'Add Reactions')
    await expect(reactions).toHaveAttribute('aria-checked', 'true')
    await reactions.click()
    await expect(reactions).toHaveAttribute('aria-checked', 'false')
    await save(page)
    expect(hasBit((await role(everyone!.id)).permissions, 'ADD_REACTIONS')).toBe(false)
  })

  await test.step('the change survives a reload', async () => {
    await openRoles(page)
    await defaultPill.click()
    await page.locator('.editor-tabs .tab-btn').filter({ hasText: 'Permissions' }).click()
    await expect(permToggle(page, 'Add Reactions')).toHaveAttribute('aria-checked', 'false')
  })
})
