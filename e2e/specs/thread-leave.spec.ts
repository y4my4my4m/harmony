// Journey: leaving a thread from the sidebar's right-click menu. A member leaves: the membership
// goes, the menu says so, and the thread drops off that account's sidebar, also after a reload. It
// stays in View all threads, from where it opens. Posting in it brings it back. Someone who never
// joined still sees an active thread in the sidebar, and the menu offers Join thread.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  addMember,
  createUser,
  deleteUser,
  dismissAnnouncements,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
const marker = Date.now().toString(36).slice(-6)
const THREAD = `Leave me ${marker}`
let owner: SpecUser
let member: SpecUser
let bystander: SpecUser
let server: SeededServer
let threadId = ''

const row = (page: Page) => page.locator('[data-nav-kind="thread"]').filter({ hasText: THREAD })
const menu = (page: Page) => page.getByRole('menu', { name: THREAD })

async function membership(user: SpecUser) {
  const { data } = await admin.from('thread_members').select('user_id').eq('thread_id', threadId).eq('user_id', user.id)
  return data?.length ?? 0
}

async function open(page: Page, user: SpecUser) {
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  owner = await createUser(admin, 'tlo')
  member = await createUser(admin, 'tlm')
  bystander = await createUser(admin, 'tlb')
  server = await seedServer(admin, owner, `Leave ${marker}`)
  await addMember(admin, member, server.id)
  await addMember(admin, bystander, server.id)
  const client = await userClient(owner)
  const made = await client.rpc('create_channel_thread', { p_channel_id: server.generalChannelId, p_name: THREAD, p_auto_archive_duration: 1440 })
  if (made.error) throw new Error(made.error.message)
  threadId = made.data as string
  const posted = await admin.from('messages').insert({
    channel_id: server.generalChannelId, thread_id: threadId, user_id: member.id,
    content: [{ type: 'text', text: `in the thread ${marker}` }],
  })
  if (posted.error) throw new Error(posted.error.message)
  expect(await membership(member)).toBe(1)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  for (const user of [owner, member, bystander]) await deleteUser(admin, user)
})

test('Leave thread leaves, and the thread drops off the sidebar', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, member)
  await expect(row(page)).toBeVisible({ timeout: 30000 })
  await row(page).click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Leave thread' }).click()

  await expect(page.getByText(`You left ${THREAD}`)).toBeVisible({ timeout: 15000 })
  await expect.poll(() => membership(member), { timeout: 15000 }).toBe(0)
  await expect(row(page)).toHaveCount(0)

  await page.reload()
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 30000 })
  await page.waitForTimeout(1500)
  await expect(row(page)).toHaveCount(0)
})

test('it stays in View all threads and opens from there, offering Join', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, member)
  await page.locator('.chat-header .threads-btn').click()
  const modal = page.locator('.threads-modal')
  const item = modal.locator('.thread-item').filter({ has: page.locator('.thread-name', { hasText: THREAD }) })
  await expect(item).toBeVisible({ timeout: 15000 })
  await item.click()
  const panel = page.locator('.thread-panel')
  await expect(panel.locator('.thread-info h3')).toHaveText(THREAD, { timeout: 15000 })
  await panel.getByRole('button', { name: 'Thread options' }).click()
  await expect(panel.getByRole('menuitem', { name: 'Join thread' })).toBeVisible({ timeout: 15000 })
})

test('posting in it brings it back', async ({ page }) => {
  test.setTimeout(120_000)
  const posted = await admin.from('messages').insert({
    channel_id: server.generalChannelId, thread_id: threadId, user_id: member.id,
    content: [{ type: 'text', text: `back again ${marker}` }],
  })
  if (posted.error) throw new Error(posted.error.message)
  await open(page, member)
  await expect(row(page)).toBeVisible({ timeout: 30000 })
  await row(page).click({ button: 'right' })
  await expect(menu(page).getByRole('menuitem', { name: 'Leave thread' })).toBeVisible()
})

test('the sidebar list waits on no separate membership read', async ({ page }) => {
  test.setTimeout(120_000)
  await page.route('**/rest/v1/thread_members*', () => {})
  await open(page, bystander)
  await expect(row(page)).toBeVisible({ timeout: 30000 })
})

test('someone who never joined sees it, and the menu offers Join', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, bystander)
  await expect(row(page)).toBeVisible({ timeout: 30000 })
  await row(page).click({ button: 'right' })
  await menu(page).getByRole('menuitem', { name: 'Join thread' }).click()
  await expect.poll(() => membership(bystander), { timeout: 15000 }).toBe(1)
  await expect(row(page)).toBeVisible()
  await row(page).click({ button: 'right' })
  await expect(menu(page).getByRole('menuitem', { name: 'Leave thread' })).toBeVisible()
})
