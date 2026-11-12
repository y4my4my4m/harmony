// Journey: which threads the channel sidebar lists. By default every active thread shows. When the
// owner picks "Joined threads only" in server settings, a member sees only threads they're in,
// plus the one they have open; the rest stay in View all threads. An @mention in a thread reply
// adds the mentioned member, so the thread then shows in their sidebar. Switching the server back
// to the instance default lists every thread again.

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
const THREAD = `Sidebar mode ${marker}`
let owner: SpecUser
let member: SpecUser
let bystander: SpecUser
let server: SeededServer
let threadId = ''

const row = (page: Page) => page.locator('[data-nav-kind="thread"]').filter({ hasText: THREAD })
const card = (page: Page) => page.getByTestId('thread-sidebar')

async function membership(user: SpecUser) {
  const { data } = await admin.from('thread_members').select('user_id').eq('thread_id', threadId).eq('user_id', user.id)
  return data?.length ?? 0
}

async function open(page: Page, user: SpecUser) {
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await dismissAnnouncements(page)
}

async function chooseMode(page: Page, label: string) {
  await signIn(page, owner)
  await page.goto(`/server/${server.id}?section=overview`)
  await expect(card(page)).toBeVisible({ timeout: 30000 })
  await card(page).getByRole('radio', { name: label }).check()
  await expect(card(page).getByRole('radio', { name: label })).toBeChecked()
}

async function storedSetting() {
  const { data } = await admin.from('server_settings').select('thread_sidebar').eq('server_id', server.id).maybeSingle()
  return data?.thread_sidebar ?? null
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  owner = await createUser(admin, 'tso')
  member = await createUser(admin, 'tsm')
  bystander = await createUser(admin, 'tsb')
  server = await seedServer(admin, owner, `Sidebar ${marker}`)
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
  expect(await membership(bystander)).toBe(0)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  for (const user of [owner, member, bystander]) await deleteUser(admin, user)
})

test('by default someone who never joined sees the thread', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, bystander)
  await expect(row(page)).toBeVisible({ timeout: 30000 })
})

test('the owner picks Joined threads only in server settings', async ({ page }) => {
  test.setTimeout(120_000)
  await chooseMode(page, 'Joined threads only')
  await expect.poll(storedSetting, { timeout: 15000 }).toBe('joined')
})

test('in joined mode a member sees their thread and the bystander does not', async ({ browser }) => {
  test.setTimeout(180_000)
  const memberPage = await (await browser.newContext()).newPage()
  await open(memberPage, member)
  await expect(row(memberPage)).toBeVisible({ timeout: 30000 })

  const page = await (await browser.newContext()).newPage()
  await open(page, bystander)
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 30000 })
  await page.waitForTimeout(1500)
  await expect(row(page)).toHaveCount(0)
})

test('a thread opened from View all threads shows while open and drops off after', async ({ page }) => {
  test.setTimeout(120_000)
  await open(page, bystander)
  await page.locator('.chat-header .threads-btn').click()
  const modal = page.locator('.threads-modal')
  const item = modal.locator('.thread-item').filter({ has: page.locator('.thread-name', { hasText: THREAD }) })
  await expect(item).toBeVisible({ timeout: 15000 })
  await item.click()
  await expect(page.locator('.thread-panel .thread-info h3')).toHaveText(THREAD, { timeout: 15000 })
  await expect(row(page)).toBeVisible({ timeout: 15000 })

  await openChannel(page, server.id, server.generalChannelId)
  await page.waitForTimeout(1500)
  await expect(row(page)).toHaveCount(0)
  expect(await membership(bystander)).toBe(0)
})

test('an @mention in a thread reply adds the bystander, and the thread shows for them', async ({ page }) => {
  test.setTimeout(120_000)
  const posted = await admin.from('messages').insert({
    channel_id: server.generalChannelId, thread_id: threadId, user_id: member.id,
    content: [
      { type: 'text', text: 'look here ' },
      { type: 'mention', userId: bystander.id, username: bystander.username },
    ],
  })
  if (posted.error) throw new Error(posted.error.message)
  await expect.poll(() => membership(bystander), { timeout: 15000 }).toBe(1)

  // No notification check here: the bystander was just viewing this channel, and a recipient
  // viewing the channel gets none (send_notification). pgTAP 281 checks its thread id.

  await open(page, bystander)
  await expect(row(page)).toBeVisible({ timeout: 30000 })
})

test('switching back to the instance default lists every thread again', async ({ browser }) => {
  test.setTimeout(180_000)
  const ownerPage = await (await browser.newContext()).newPage()
  await chooseMode(ownerPage, 'Instance default (All active threads)')
  await expect.poll(storedSetting, { timeout: 15000 }).toBe(null)

  const leaver = await userClient(bystander)
  const left = await leaver.rpc('leave_thread', { p_thread_id: threadId })
  if (left.error) throw new Error(left.error.message)
  const { error } = await admin.from('thread_departures').delete().eq('thread_id', threadId).eq('user_id', bystander.id)
  if (error) throw new Error(error.message)

  const page = await (await browser.newContext()).newPage()
  await open(page, bystander)
  await expect(row(page)).toBeVisible({ timeout: 30000 })
})
