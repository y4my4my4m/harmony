// Journey: a new report reaches whoever can act on it (20261111600001_report_alerts.sql).
//
// An account report: an instance moderator finds "New report to review" in the bell, opens the
// instance queue from it and sees the Reports tab's count. A report about a message in a server:
// the server's owner finds "New report in <server>" and lands on the server's Reports section with
// its count. With "Notify me about new reports" off, the next report notifies nobody.
//
// Reports go through create_report as the reporter's own client. Instance staff see every
// instance's pending report, so the instance count is asserted as present, not exact.

import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
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
const tag = Date.now().toString(36)
let staff: SpecUser
let owner: SpecUser
let reporter: SpecUser
let target: SpecUser
let server: SeededServer
let messageId = ''

const report = async (args: Record<string, unknown>) => {
  const client = await userClient(reporter)
  const { data, error } = await client.rpc('create_report', args)
  if (error) throw new Error(`create_report: ${error.message}`)
  return data as string
}
const alertsFor = async (user: SpecUser, reason: string) =>
  ((await admin.from('notifications').select('id').eq('user_id', user.id).eq('type', 'report_created')
    .eq('data->>reason', reason)).data ?? []).length

async function openBellItem(page: Page, text: string) {
  await page.locator('[data-testid="notification-bell"]').click()
  const panel = page.locator('[data-testid="notification-panel"]')
  await expect(panel).toBeVisible({ timeout: 15000 })
  const item = panel.locator('[data-testid="notification-item"][data-type="report_created"]').filter({ hasText: text })
  await expect(item).toHaveCount(1, { timeout: 30000 })
  return item
}

test.beforeAll(async () => {
  staff = await createUser(admin, 'rastaff')
  owner = await createUser(admin, 'raowner')
  reporter = await createUser(admin, 'rarep')
  target = await createUser(admin, 'ratgt')
  const promoted = await admin.from('profiles').update({ is_moderator: true }).eq('id', staff.id)
  if (promoted.error) throw new Error(promoted.error.message)
  server = await seedServer(admin, owner, `Alerts ${tag}`)
  await addMember(admin, reporter, server.id)
  await addMember(admin, target, server.id)
  // A member of a server: the user panel with the bell shows beside its channels.
  await addMember(admin, staff, server.id)
  const { data, error } = await admin.from('messages').insert({
    channel_id: server.generalChannelId, user_id: target.id, content: [{ type: 'text', text: 'reported here' }],
  }).select('id').single()
  if (error || !data) throw new Error(`message: ${error?.message}`)
  messageId = data.id
})

test.afterAll(async () => {
  await admin.from('reports').delete().eq('reporter_id', reporter?.id ?? '')
  await admin.from('servers').delete().eq('id', server?.id ?? '')
  for (const u of [staff, owner, reporter, target]) await deleteUser(admin, u)
})

test('an instance moderator hears of an account report and can turn it off', async ({ page }) => {
  test.setTimeout(180_000)
  const reason = `spam-${tag}`

  await report({ p_report_type: 'user', p_reported_user_id: target.id, p_reason: reason })
  await signIn(page, staff)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('the bell names the report, not the reporter, and opens the queue', async () => {
    const item = await openBellItem(page, `An account was reported: ${reason}.`)
    await expect(item).toContainText('New report to review')
    await expect(item).not.toContainText(reporter.username)
    await item.click()
    await page.waitForURL(/\/admin\?tab=reports/, { timeout: 30000 })
    await dismissAnnouncements(page)
    await expect(page.getByTestId('admin-tab-reports-badge')).toBeVisible({ timeout: 30000 })
  })

  await test.step('"Notify me about new reports" off: the next report notifies nobody', async () => {
    const toggle = page.getByTestId('report-alerts-toggle').getByRole('switch')
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30000 })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await expect.poll(async () => (await admin.from('notification_preferences').select('moderation_reports')
      .eq('user_id', staff.id).maybeSingle()).data?.moderation_reports, { timeout: 15000 }).toBe(false)

    const quiet = `quiet-${tag}`
    await report({ p_report_type: 'user', p_reported_user_id: owner.id, p_reason: quiet })
    expect(await alertsFor(staff, quiet)).toBe(0)
    expect(await alertsFor(staff, reason)).toBe(1)
  })
})

test('a server\'s owner hears of a report about a message in it', async ({ page }) => {
  test.setTimeout(180_000)
  const reason = `abuse-${tag}`

  await report({ p_report_type: 'message', p_reported_message_id: messageId, p_reason: reason })
  expect(await alertsFor(staff, reason)).toBe(0)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)

  await test.step('the bell names the server and opens its Reports section with the count', async () => {
    const item = await openBellItem(page, `A message was reported: ${reason}.`)
    await expect(item).toContainText(`New report in Alerts ${tag}`)
    await item.click()
    await page.waitForURL(new RegExp(`/server/${server.id}\\?section=reports`), { timeout: 30000 })
    await expect(page.getByTestId('server-reports-badge')).toHaveText('1', { timeout: 30000 })
    await expect(page.locator('.reports-module')).toContainText('1 pending')
  })
})
