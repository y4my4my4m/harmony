// Journey: unsaved role edits stay with their role.
// - A role renamed and left for another keeps the rename and its unsaved mark; selecting
//   it again shows the rename.
// - The edit survives a switch to another Server settings section and back.
// - Leaving Server settings with it asks first; Escape in the prompt keeps it. Once saved,
//   leaving asks nothing.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  grantRole,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let helpersId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'rdraft')
  server = await seedServer(admin, owner, `Drafts ${owner.username.slice(-6)}`)
  helpersId = await grantRole(admin, server.id, owner, { name: 'Helpers', position: 5, permissions: ['VIEW_CHANNEL'] })
  await grantRole(admin, server.id, owner, { name: 'Greeters', position: 4, permissions: ['VIEW_CHANNEL'] })
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

const pill = (page: Page, name: string) =>
  page
    .locator('.role-rail .role-pill')
    .filter({ has: page.locator('.role-pill-name', { hasText: new RegExp(`^${name}$`) }) })
const nameInput = (page: Page) =>
  page.locator('.role-editor .form-group').filter({ hasText: 'Role name' }).locator('input')
const editorTitle = (page: Page) => page.locator('.role-editor h3')
const nav = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' })
const prompt = (page: Page) => page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })

async function storedName(): Promise<string> {
  const { data } = await admin.from('server_roles').select('name').eq('id', helpersId).single()
  return (data as { name: string }).name
}

test('a role edit survives switching role and section, and leaving asks first', async ({ page }) => {
  test.setTimeout(150_000)
  const renamed = 'Moderators (unsaved)'
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=roles`)
  await expect(pill(page, 'Helpers')).toBeVisible({ timeout: 30000 })

  await test.step('rename Helpers; its pill is marked unsaved', async () => {
    await pill(page, 'Helpers').click()
    await expect(editorTitle(page)).toHaveText('Helpers')
    await nameInput(page).fill(renamed)
    await expect(pill(page, 'Helpers').locator('.role-pill-dot')).toBeVisible()
  })

  await test.step('another role and back: the rename and the mark stay', async () => {
    await pill(page, 'Greeters').click()
    await expect(editorTitle(page)).toHaveText('Greeters')
    await expect(nameInput(page)).toHaveValue('Greeters')
    await expect(pill(page, 'Helpers').locator('.role-pill-dot')).toBeVisible()
    await expect(pill(page, 'Greeters').locator('.role-pill-dot')).toHaveCount(0)
    await pill(page, 'Helpers').click()
    await expect(nameInput(page)).toHaveValue(renamed)
  })

  await test.step('Overview and back to Roles: the rename stays', async () => {
    await nav(page).getByRole('button', { name: 'Overview' }).click()
    await expect(nameInput(page)).toHaveCount(0)
    await nav(page).getByRole('button', { name: 'Roles' }).click()
    await expect(editorTitle(page)).toHaveText('Helpers')
    await expect(nameInput(page)).toHaveValue(renamed)
  })

  await test.step('the back arrow asks; Escape in the prompt keeps the edit and Settings', async () => {
    await page.getByRole('button', { name: 'Back to chat' }).click()
    await expect(prompt(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(prompt(page)).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/server/${server.id}`))
    await expect(nameInput(page)).toHaveValue(renamed)
  })

  await test.step('saved, the mark goes and leaving asks nothing', async () => {
    const patched = page.waitForResponse((r) => r.url().includes('/rest/v1/server_roles') && r.request().method() === 'PATCH')
    await page.locator('.editor-footer .save-btn').click()
    expect((await patched).ok()).toBe(true)
    await expect.poll(storedName).toBe(renamed)
    await expect(page.locator('.role-pill-dot')).toHaveCount(0)
    await page.getByRole('button', { name: 'Back to chat' }).click()
    await expect(page).toHaveURL(new RegExp(`/chat/${server.id}/${server.generalChannelId}$`), { timeout: 15000 })
    await expect(prompt(page)).toHaveCount(0)
  })
})
