// Journey: the owner creates, renames and deletes a channel and creates a role
// through the UI, then reads each change in Server Settings > Audit log. A
// plain member has no Audit log section and get_server_audit_log refuses them.
//
// Every change is made as the owner's session: service_role writes are logged
// as System, so seeding them would not show the owner as the actor.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addMember,
  channelRow,
  createUser,
  deleteChannelFromMenu,
  deleteUser,
  openChannel,
  openCreateChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  owner = await createUser(admin, 'auda')
  member = await createUser(admin, 'audb')
  server = await seedServer(admin, owner, `Audit ${owner.username}`)
  await addMember(admin, member, server.id)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
  await deleteUser(admin, member)
})

const navItem = (page: Page, label: string) =>
  page.locator('.server-settings-sidebar .nav-item').filter({ hasText: label })

test('channel and role changes appear in the audit log', async ({ page }) => {
  test.setTimeout(180_000)

  const created = `audit-${owner.username.slice(-5)}`
  const renamed = `${created}-renamed`

  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('create a channel', async () => {
    const modal = await openCreateChannel(page)
    await modal.locator('input.modern-input').fill(created)
    await modal.locator('button').filter({ hasText: 'Create Channel' }).click()
    await expect(modal).toBeHidden({ timeout: 30000 })
    await expect(channelRow(page, created)).toBeVisible({ timeout: 30000 })
  })

  await test.step('rename it', async () => {
    await channelRow(page, created).click({ button: 'right' })
    await page
      .locator('.context-menu .context-menu-item')
      .filter({ hasText: 'Edit channel' })
      .click()
    const modal = page.locator('.modal-container').filter({ hasText: 'Edit channel' })
    await expect(modal).toBeVisible({ timeout: 10000 })
    await modal.locator('#channel-name').fill(renamed)
    await modal.getByRole('button', { name: 'Save changes' }).click()
    await expect(modal).toBeHidden({ timeout: 30000 })
    await expect(channelRow(page, renamed)).toBeVisible({ timeout: 30000 })
  })

  await test.step('delete it', async () => {
    await deleteChannelFromMenu(page, renamed)
    await expect(channelRow(page, renamed)).toHaveCount(0)
  })

  await test.step('create a role', async () => {
    await page.goto(`/server/${server.id}?section=roles`)
    await settingsLoaded(page)
    const createdRole = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/server_roles') && r.request().method() === 'POST',
    )
    await page.locator('.create-role-btn').click()
    expect((await createdRole).ok()).toBe(true)
    await expect(
      page.locator('.role-rail .role-pill-name').filter({ hasText: 'New Role' }),
    ).toBeVisible()
  })

  await test.step('the audit log lists each change by the owner', async () => {
    await navItem(page, 'Audit log').click()
    const entries = page.locator('[data-test="audit-entry"]')
    await expect(entries.first()).toBeVisible({ timeout: 30000 })

    const entry = (text: string) =>
      entries.filter({ has: page.locator('.audit-line', { hasText: text }) })
    const actor = owner.displayName
    await expect(entry(`${actor} created channel #${created}`)).toHaveCount(1)
    await expect(entry(`${actor} deleted channel #${renamed}`)).toHaveCount(1)
    await expect(entry(`${actor} created role New Role`)).toHaveCount(1)

    const rename = entry(`${actor} updated channel #${renamed}`)
    await expect(rename).toHaveCount(1)
    await expect(rename.locator('.audit-field')).toHaveText(['Name'])
    await expect(rename.locator('.audit-old')).toHaveText([created])
    await expect(rename.locator('.audit-new')).toHaveText([renamed])
  })

  await test.step('the kind filter narrows the list', async () => {
    await page.locator('[data-test="kind-filter"]').selectOption('role')
    const entries = page.locator('[data-test="audit-entry"]')
    await expect(entries.filter({ hasText: 'created role New Role' })).toHaveCount(1)
    await expect(entries.filter({ hasText: 'channel' })).toHaveCount(0)
  })
})

test('a plain member cannot open the audit log', async ({ page }) => {
  test.setTimeout(120_000)

  await test.step('get_server_audit_log refuses them', async () => {
    const client = await userClient(member)
    const { error } = await client.rpc('get_server_audit_log', {
      p_server_id: server.id,
      p_before: null,
      p_limit: 50,
      p_action: null,
      p_actor_id: null,
    })
    expect(error?.code).toBe('42501')
  })

  await test.step('Server Settings offers no Audit log, even when asked for it', async () => {
    await signIn(page, member)
    await page.goto(`/server/${server.id}?section=audit-log`)
    await settingsLoaded(page)
    await expect(navItem(page, 'Roles')).toBeVisible({ timeout: 30000 })
    await expect(navItem(page, 'Audit log')).toHaveCount(0)
    await expect(page.locator('.audit-log')).toHaveCount(0)
  })
})

async function settingsLoaded(page: Page): Promise<void> {
  await expect(page.locator('.server-settings-sidebar')).toBeVisible({ timeout: 30000 })
}
