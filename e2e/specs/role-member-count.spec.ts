// Journey: a role's member count in the Roles rail stays its number of members through every
// edit of the role list. Saving a role's name, colour and permissions, moving it, creating
// and deleting another role leave it as it was; adding and removing a member move it by one.
// The PATCH that saves a role answers the server_roles row, which carries no member count.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addMember,
  assignRole,
  createUser,
  deleteUser,
  grantRole,
  seedServer,
  type SeededServer,
  type SpecUser,
  signIn,
} from './harness'

const admin = adminClient()
let owner: SpecUser
const members: SpecUser[] = []
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'rmcown')
  for (const tag of ['rmca', 'rmcb', 'rmcc']) members.push(await createUser(admin, tag))
  server = await seedServer(admin, owner, `Counts ${owner.username.slice(-6)}`)
  for (const member of members) await addMember(admin, member, server.id)
  const helpers = await grantRole(admin, server.id, members[0], { name: 'Helpers', position: 5, permissions: ['VIEW_CHANNEL'] })
  await assignRole(admin, server.id, members[1], helpers)
  await grantRole(admin, server.id, members[2], { name: 'Greeters', position: 4, permissions: ['VIEW_CHANNEL'] })
})

test.afterAll(async () => {
  for (const user of [...members, owner]) await deleteUser(admin, user)
})

const pill = (page: Page, name: string) =>
  page
    .locator('.role-rail .role-pill')
    .filter({ has: page.locator('.role-pill-name', { hasText: new RegExp(`^${name}$`) }) })
const count = (page: Page, name: string) => pill(page, name).locator('.role-pill-count')
const nameInput = (page: Page) =>
  page.locator('.role-editor .form-group').filter({ hasText: 'Role name' }).locator('input')
const tab = (page: Page, name: string) => page.locator('.editor-tabs .tab-btn').filter({ hasText: name })

async function save(page: Page): Promise<Record<string, unknown>> {
  const patched = page.waitForResponse(
    (r) => r.url().includes('/rest/v1/server_roles') && r.request().method() === 'PATCH',
  )
  await page.locator('.editor-footer .save-btn').click()
  const response = await patched
  expect(response.ok()).toBe(true)
  const body = await response.json()
  return Array.isArray(body) ? body[0] : body
}

test('role member counts survive saving, moving, creating and deleting roles', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=roles`)
  await expect(pill(page, 'Helpers')).toBeVisible({ timeout: 30000 })
  await expect(count(page, 'Helpers')).toHaveText('2')
  await expect(count(page, 'Greeters')).toHaveText('1')

  await test.step('rename, recolour and grant a permission: the count stays', async () => {
    await pill(page, 'Helpers').click()
    await nameInput(page).fill('Mentors')
    const hex = page.locator('.role-editor').getByTestId('color-hex')
    await hex.fill('#2E7D32')
    await hex.press('Enter')
    await tab(page, 'Permissions').click()
    await page
      .locator('.perm-row')
      .filter({ has: page.locator('.perm-row-label', { hasText: 'Add Reactions' }) })
      .locator('.toggle-switch')
      .click()
    const row = await save(page)
    expect(row.name).toBe('Mentors')
    expect(row).not.toHaveProperty('member_count')
    await expect(pill(page, 'Mentors')).toBeVisible()
    await expect(count(page, 'Mentors')).toHaveText('2')
    await expect(pill(page, 'Mentors').locator('.sr-only').last()).toHaveText('2 members')
    await expect(count(page, 'Greeters')).toHaveText('1')
  })

  await test.step('move it below Greeters: the counts stay', async () => {
    const moved = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/server_roles') && r.request().method() === 'PATCH',
    )
    await pill(page, 'Mentors').focus()
    await page.keyboard.press('Alt+ArrowDown')
    expect((await moved).ok()).toBe(true)
    await expect(page.locator('.role-rail .role-pill-name').filter({ hasText: /^(Mentors|Greeters)$/ })).toHaveText(['Greeters', 'Mentors'])
    await expect(count(page, 'Mentors')).toHaveText('2')
    await expect(count(page, 'Greeters')).toHaveText('1')
  })

  await test.step('create a role, save it, delete it: it reads 0 and the others stay', async () => {
    await page.locator('.create-role-btn').click()
    await expect(pill(page, 'New Role')).toBeVisible()
    await expect(count(page, 'New Role')).toHaveText('0')
    await nameInput(page).fill('Temp')
    await save(page)
    await expect(count(page, 'Temp')).toHaveText('0')
    await expect(count(page, 'Mentors')).toHaveText('2')
    await page.locator('.role-editor').getByRole('button', { name: 'Delete role' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(pill(page, 'Temp')).toHaveCount(0)
    await expect(count(page, 'Mentors')).toHaveText('2')
    await expect(count(page, 'Greeters')).toHaveText('1')
  })

  await test.step('adding and removing a member moves the count by one', async () => {
    await pill(page, 'Greeters').click()
    await tab(page, 'Members').click()
    await page.getByPlaceholder('Search server members...').fill(members[0].username.slice(0, 10))
    await page.getByRole('button', { name: new RegExp(`^Add .*${members[0].displayName}.* to Greeters$`) }).click()
    await expect(count(page, 'Greeters')).toHaveText('2')
    await page.getByRole('button', { name: new RegExp(`^Remove .*${members[2].displayName}.* from Greeters$`) }).click()
    await expect(count(page, 'Greeters')).toHaveText('1')
    await expect(count(page, 'Mentors')).toHaveText('2')
  })

  await test.step('a reload reads the same counts', async () => {
    await page.reload()
    await expect(count(page, 'Mentors')).toHaveText('2', { timeout: 30000 })
    await expect(count(page, 'Greeters')).toHaveText('1')
  })
})
