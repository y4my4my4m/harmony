// Journey: signup review and bulk suspension (20261109500001_signup_review.sql).
//
// Staff open Admin > Signups: accounts show an email domain, never an address; accounts on one
// domain and accounts that joined one server within an hour form groups. A moderator selects a
// group that holds a staff account: the dialog names who changes, who is left out and which
// servers stay open, and waits for a reason. Afterwards a held token answers session_revoked,
// sign-in is refused with the reason, the activity log has one row per account, and the owned
// server still takes messages. Unsuspending lets them sign in again. Non-staff are refused by the
// server. A member reports an account for username hoarding; staff read that reason.

import { test, expect, type Page } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'

const admin = adminClient()
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const domain = `hoard${tag}.example`
const REASON = `hoarding names ${tag}`
const RELEASE = `false positive ${tag}`

test.describe.configure({ mode: 'default' })

let staffAdmin: SpecUser
let staffMod: SpecUser
let member: SpecUser
let bystander: SpecUser
let hoarders: SpecUser[] = []
let server: SeededServer

async function useDomain(user: SpecUser, name: string): Promise<SpecUser> {
  const email = `${user.username}@${name}`
  const { error } = await admin.auth.admin.updateUserById(user.id, { email, email_confirm: true })
  if (error) throw new Error(`email ${user.username}: ${error.message}`)
  return { ...user, email }
}

test.beforeAll(async () => {
  staffAdmin = await createUser(admin, 'srvadm')
  staffMod = await useDomain(await createUser(admin, 'srvmod'), domain)
  await admin.from('profiles').update({ is_admin: true }).eq('id', staffAdmin.id)
  await admin.from('profiles').update({ is_moderator: true }).eq('id', staffMod.id)
  member = await createUser(admin, 'srvmem')
  bystander = await createUser(admin, 'srvby')
  hoarders = []
  for (let i = 0; i < 4; i++) hoarders.push(await useDomain(await createUser(admin, `srvh${i}`), domain))
  server = await seedServer(admin, hoarders[0], `Hall ${tag}`)
  for (const user of hoarders.slice(1)) await addMember(admin, user, server.id)
  await addMember(admin, member, server.id)
})

test.afterAll(async () => {
  for (const user of [staffAdmin, staffMod, member, bystander, ...hoarders]) await deleteUser(admin, user)
})

async function openSignups(page: Page) {
  await page.goto('/admin?tab=signups')
  await dismissAnnouncements(page)
  const panel = page.getByTestId('recent-signups')
  await expect(panel.getByTestId('signup-row').first()).toBeVisible({ timeout: 30000 })
  return panel
}

const groupCard = (panel: ReturnType<Page['getByTestId']>, key: string) =>
  panel.locator(`[data-testid="signup-group"][data-group-key="${key}"]`)

test('staff read signups by email domain, never by address', async ({ page }) => {
  await signIn(page, staffAdmin)
  const panel = await openSignups(page)

  const row = panel.locator(`[data-username="${hoarders[1].username}"]`)
  await expect(row.getByTestId('signup-domain')).toHaveText(domain)
  await expect(panel).not.toContainText(hoarders[1].email)
  await expect(page.locator('body')).not.toContainText(`@${domain}`)

  const byDomain = groupCard(panel, domain)
  await expect(byDomain).toContainText('5 accounts')
  await expect(byDomain).toContainText('0 earlier accounts')

  const byServer = groupCard(panel, server.id)
  await expect(byServer).toContainText(`Hall ${tag}`)
  await expect(byServer).toContainText('Joined within an hour')

  await byDomain.getByTestId('signup-group-show').click()
  await expect(panel.getByTestId('signup-group-filter')).toContainText(domain)
  await expect(panel.getByTestId('signup-row')).toHaveCount(5)
  await expect(panel.locator(`[data-username="${member.username}"]`)).toHaveCount(0)
  await expect(panel.locator(`[data-username="${staffMod.username}"]`).getByTestId('signup-select')).toBeDisabled()

  await expect(panel.getByTestId('signup-daily')).toBeVisible()
  await expectNoAxeViolations(page, { include: '[data-testid="recent-signups"]', label: 'signups desktop' })
})

test('an admin reaches the sign-up limits from the tab', async ({ page }) => {
  await signIn(page, staffAdmin)
  const panel = await openSignups(page)
  await panel.getByTestId('signups-limits-link').click()
  await expect(page.getByTestId('instance-invites')).toBeVisible({ timeout: 30000 })
  await expect(page).toHaveURL(/tab=invites/)
  await expect(page.getByRole('tab', { name: 'Invites' })).toHaveAttribute('aria-selected', 'true')

  await page.getByTestId('signup-limits-review-link').click()
  await expect(page).toHaveURL(/tab=signups/)
  await expect(page.getByTestId('recent-signups')).toBeVisible({ timeout: 30000 })
})

test('the per-day table shows a day with only refused signups', async ({ page }) => {
  const day = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10)
  await admin.from('signup_refusal_counts').upsert({ day, reason: 'blocked_domain', refusals: 3, would_refuse: 4 })
  try {
    await signIn(page, staffAdmin)
    const panel = await openSignups(page)
    await panel.getByTestId('signups-window-30').click()
    const row = panel.getByTestId('signup-daily').locator('tr', { hasText: day })
    await expect(row.locator('td').nth(0)).toHaveText('0')
    await expect(row.locator('td').nth(5)).toHaveText('3')
    await expect(row.locator('td').nth(6)).toHaveText('4')
  } finally {
    await admin.from('signup_refusal_counts').delete().eq('day', day).eq('reason', 'blocked_domain')
  }
})

test('the tab fits a phone', async ({ page }) => {
  await signIn(page, staffAdmin)
  await page.setViewportSize({ width: 375, height: 800 })
  const panel = await openSignups(page)
  await expect(panel.getByTestId('signup-row').first()).toBeVisible()
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="recent-signups"]') as HTMLElement
    return el.scrollWidth - el.clientWidth
  })
  expect(overflow).toBeLessThanOrEqual(0)
})

test('the server refuses non-staff', async () => {
  const client = await userClient(member)
  for (const call of [
    client.rpc('staff_recent_signups', {}),
    client.rpc('staff_signup_groups', {}),
    client.rpc('staff_signup_daily', {}),
    client.rpc('staff_bulk_suspend_preview', { p_profile_ids: [hoarders[1].id], p_suspended: true }),
    client.rpc('staff_bulk_set_suspended', { p_profile_ids: [hoarders[1].id], p_suspended: true, p_reason: 'x' }),
  ]) {
    const { error } = await call
    expect(error?.code).toBe('42501')
  }
  const { data } = await admin.from('profiles').select('is_suspended').eq('id', hoarders[1].id).single()
  expect(data?.is_suspended).toBe(false)
})

test('a moderator suspends a group with one reason; staff are left out', async ({ page }) => {
  const heldClient = await userClient(hoarders[1])
  expect((await heldClient.from('profiles').select('id').eq('id', hoarders[1].id)).error).toBeNull()

  await signIn(page, staffMod)
  const panel = await openSignups(page)
  await expect(panel.getByTestId('signups-limits-link')).toHaveCount(0)
  const byDomain = groupCard(panel, domain)
  await byDomain.getByTestId('signup-group-select').click()
  await expect(panel.getByTestId('signup-selection')).toContainText('5 selected')
  await panel.getByTestId('signup-bulk-suspend').click()

  const dialog = page.getByTestId('bulk-suspend-dialog')
  const affected = dialog.getByTestId('bulk-affected')
  for (const user of hoarders) await expect(affected).toContainText(user.username)
  await expect(affected).not.toContainText(staffMod.username)
  await expect(dialog.getByTestId('bulk-skipped')).toContainText(staffMod.username)
  await expect(dialog.getByTestId('bulk-skipped')).toContainText('Your own account')
  await expect(dialog.getByTestId('bulk-owned')).toContainText(`Hall ${tag}`)
  await expect(dialog.getByTestId('bulk-consequences')).toContainText('Nothing is sent to other instances')
  await expectNoAxeViolations(page, { include: '[data-testid="bulk-suspend-dialog"]', label: 'bulk dialog' })

  const confirm = page.getByTestId('bulk-confirm')
  await expect(confirm).toBeDisabled()
  await dialog.getByTestId('bulk-reason').fill(REASON)
  await expect(confirm).toHaveText('Suspend 4 accounts')
  await confirm.click()
  await expect(dialog).toHaveCount(0)

  const row = panel.locator(`[data-username="${hoarders[0].username}"]`)
  await expect(row).toContainText('Suspended')
  await expect(row).toContainText(REASON)

  const { data: rows } = await admin.from('profiles')
    .select('id, is_suspended, suspension_reason')
    .in('id', [...hoarders.map((u) => u.id), staffMod.id])
  for (const user of hoarders) {
    expect(rows?.find((r) => r.id === user.id)).toMatchObject({ is_suspended: true, suspension_reason: REASON })
  }
  expect(rows?.find((r) => r.id === staffMod.id)?.is_suspended).toBe(false)

  const { data: log } = await admin.from('admin_audit_log')
    .select('admin_id, action_type, target_id, action_details')
    .eq('action_type', 'user_suspend')
    .in('target_id', hoarders.map((u) => u.id))
  expect(log).toHaveLength(4)
  for (const entry of log ?? []) {
    expect(entry.admin_id).toBe(staffMod.id)
    expect(entry.action_details).toMatchObject({ reason: REASON, bulk: true })
  }
  expect(new Set(log?.map((e) => e.action_details.batch_id)).size).toBe(1)

  const refused = await heldClient.from('profiles').select('id').eq('id', hoarders[1].id)
  expect(refused.error?.message).toBe('session_revoked')
})

test('the suspended cannot sign in, and their server stays open', async ({ page }) => {
  await page.goto('/login')
  await page.locator('[data-testid="auth-email"]').fill(hoarders[1].email)
  await page.locator('[data-testid="auth-password"]').fill(hoarders[1].password)
  await page.locator('[data-testid="auth-submit"]').click()
  await expect(page.getByText(REASON)).toBeVisible({ timeout: 30000 })

  const { data } = await admin.from('servers').select('owner, suspended_at').eq('id', server.id).single()
  expect(data).toEqual({ owner: hoarders[0].id, suspended_at: null })

  const client = await userClient(member)
  const sent = await client.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: member.id,
    content: [{ type: 'text', text: `still open ${tag}` }],
  })
  expect(sent.error).toBeNull()
})

test('an admin reads the batch in the activity log and unsuspends it', async ({ page }) => {
  await signIn(page, staffAdmin)
  await page.goto('/admin?tab=overview')
  await dismissAnnouncements(page)
  await expect(page.getByText(new RegExp(`Suspended.*${hoarders[0].username}`)).first()).toBeVisible({ timeout: 30000 })

  const panel = await openSignups(page)
  await panel.getByTestId('signups-status-suspended').click()
  await expect(panel.locator(`[data-username="${member.username}"]`)).toHaveCount(0)
  await groupCard(panel, domain).getByTestId('signup-group-select').click()
  await panel.getByTestId('signup-bulk-unsuspend').click()

  const dialog = page.getByTestId('bulk-suspend-dialog')
  await expect(dialog.getByTestId('bulk-affected')).toContainText(hoarders[2].username)
  await expect(dialog.getByTestId('bulk-skipped')).toContainText('Instance staff')
  await expect(dialog.getByTestId('bulk-consequences')).toContainText('are not restored')
  await dialog.getByTestId('bulk-reason').fill(RELEASE)
  await page.getByTestId('bulk-confirm').click()
  await expect(dialog).toHaveCount(0)

  const { data } = await admin.from('profiles').select('is_suspended, suspension_reason').in('id', hoarders.map((u) => u.id))
  expect(data).toHaveLength(4)
  for (const row of data ?? []) expect(row).toEqual({ is_suspended: false, suspension_reason: null })
  const { count } = await admin.from('admin_audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('action_type', 'user_unsuspend')
    .contains('action_details', { reason: RELEASE })
  expect(count).toBe(4)
})

test('an unsuspended account signs in again', async ({ page }) => {
  await signIn(page, hoarders[1])
  await expect(page).toHaveURL(/\/chat/)
})

test('a member reports username hoarding and staff read the reason', async ({ browser, page }) => {
  await signIn(page, bystander)
  await page.goto(`/@${hoarders[2].username}`)
  await dismissAnnouncements(page)
  await page.getByTestId('profile-more-btn').click()
  await page.getByTestId('profile-menu-report').click()
  const dialog = page.getByRole('dialog', { name: 'Report' })
  await dialog.getByRole('radio', { name: 'Username hoarding or account trading' }).check()
  await dialog.getByRole('button', { name: 'Submit report' }).click()
  await expect(page.getByText('Report submitted')).toBeVisible()

  const { data: report } = await admin.from('reports')
    .select('reason, category')
    .eq('reporter_id', bystander.id)
    .eq('reported_user_id', hoarders[2].id)
    .single()
  expect(report).toEqual({ reason: 'username_hoarding', category: 'violation' })

  const context = await browser.newContext({ serviceWorkers: 'block' })
  const staffPage = await context.newPage()
  await signIn(staffPage, staffAdmin)
  await staffPage.goto('/admin?tab=reports')
  await dismissAnnouncements(staffPage)
  await expect(staffPage.getByText('Username hoarding or account trading').first()).toBeVisible({ timeout: 30000 })
  await context.close()
})
