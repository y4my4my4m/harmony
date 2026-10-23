// Journey: a role's new colour shows on its members' names in chat without a reload. The
// owner recolours a role in Server settings and returns to the channel; the author name of
// their message takes the new colour. The page is never reloaded (a window marker survives).
//
// The stack runs no realtime: the role write through Roles is what refreshes the colours here.
// Painters sits above the seeded Admin role (position 999, #e74c3c), so its colour is the name's.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  grantRole,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let roleId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'rcolor')
  server = await seedServer(admin, owner, `Colours ${owner.username.slice(-6)}`)
  roleId = await grantRole(admin, server.id, owner, { name: 'Painters', position: 1000, permissions: ['VIEW_CHANNEL'] })
  const { error: roleError } = await admin.from('server_roles').update({ color: '#E91E63' }).eq('id', roleId)
  if (roleError) throw new Error(`role colour: ${roleError.message}`)
  const { error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: owner.id,
    content: [{ type: 'text', text: 'colour me' }],
  })
  if (error) throw new Error(`message: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

const authorName = (page: Page) =>
  page.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'colour me' }).locator('.username').first()
const nameColor = (page: Page) => authorName(page).evaluate((el) => getComputedStyle(el).color)

test('a recoloured role shows in chat without a reload', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
  await expect(authorName(page)).toBeVisible({ timeout: 30000 })
  await expect.poll(() => nameColor(page), { timeout: 15000 }).toBe('rgb(233, 30, 99)')
  await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true })

  await test.step('recolour Painters in Server settings', async () => {
    await page.locator('.channel-sidebar .server-name').click()
    await page.getByRole('menuitem', { name: 'Server settings' }).click()
    await page.locator('#server-settings-sidebar').getByRole('button', { name: 'Roles' }).click()
    await page.locator('.role-rail .role-pill').filter({ hasText: 'Painters' }).click()
    const hex = page.locator('.role-editor').getByTestId('color-hex')
    await hex.fill('#2E7D32')
    await hex.press('Enter')
    const saved = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/server_roles') && r.request().method() === 'PATCH', { timeout: 15000 })
    await page.locator('.editor-footer .save-btn').click()
    expect((await saved).ok()).toBe(true)
    const { data } = await admin.from('server_roles').select('color').eq('id', roleId).single()
    expect((data as { color: string }).color.toUpperCase()).toBe('#2E7D32')
  })

  await test.step('back in the channel, the name has the new colour', async () => {
    await page.getByRole('button', { name: 'Back', exact: true }).last().click()
    await expect(authorName(page)).toBeVisible({ timeout: 30000 })
    await expect.poll(() => nameColor(page), { timeout: 10000 }).toBe('rgb(46, 125, 50)')
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true)
  })
})
