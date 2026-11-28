// Journey: Admin statistics from one snapshot (20261124600003_admin_instance_stats.sql).
//
// An admin opens Admin -> Overview: the page asks admin_instance_stats once and counts nothing
// itself (no request carries Prefer: count=exact); the cards show the snapshot's figures and when
// it was computed. Refresh recomputes a snapshot older than a minute and reads a younger one. The
// Federation and Users tabs read the same snapshot: their only exact counts are their lists' page
// totals. Suspending and unsuspending an account moves the Users tab's Suspended count at once, and
// the move stays when Overview and Users open again on a snapshot computed before it.

import { test, expect, type Page, type Request } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()

let staff: SpecUser
let member: SpecUser

test.beforeAll(async () => {
  staff = await createUser(admin, 'statadm')
  const { error } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (error) throw new Error(`promote admin: ${error.message}`)
  member = await createUser(admin, 'statmem')
})

test.afterAll(async () => {
  await deleteUser(admin, member)
  await deleteUser(admin, staff)
})

interface Recorded { method: string; url: string; prefer: string; body: string | null }

/** Every PostgREST request the page makes from now on. */
function recordRest(page: Page): Recorded[] {
  const seen: Recorded[] = []
  page.on('request', (request: Request) => {
    if (!request.url().includes('/rest/v1/')) return
    seen.push({
      method: request.method(),
      url: decodeURIComponent(request.url()),
      prefer: request.headers()['prefer'] ?? '',
      body: request.postData(),
    })
  })
  return seen
}

const statsRequests = (seen: Recorded[]) => seen.filter((r) => r.url.includes('/rest/v1/rpc/admin_instance_stats'))
// The app shell counts the signed-in account's followers on every page; it is not the panel's.
const shellCount = (r: Recorded) => r.method === 'HEAD' && /\/rest\/v1\/follows\?select=\*&following_id=eq\./.test(r.url)
const exactCounts = (seen: Recorded[]) => seen.filter((r) => r.prefer.includes('count=exact') && !shellCount(r))

async function backdateSnapshot(seconds: number) {
  const { data, error } = await admin.from('admin_instance_stats').select('computed_at').eq('id', true).single()
  if (error || !data) throw new Error(`read snapshot: ${error?.message}`)
  const at = new Date(new Date(data.computed_at).getTime() - seconds * 1000).toISOString()
  const { error: updateError } = await admin.from('admin_instance_stats').update({ computed_at: at }).eq('id', true)
  if (updateError) throw new Error(`backdate snapshot: ${updateError.message}`)
}

test('Overview reads one snapshot and Refresh recomputes it', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, staff)

  const seen = recordRest(page)
  const firstStats = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/admin_instance_stats'))
  await page.goto('/admin')
  const snapshot = await (await firstStats).json()
  await expect(page.getByTestId('admin-stats-updated')).toHaveText(/^Updated (just now|\d+ minutes? ago)$/, { timeout: 20000 })
  await page.waitForLoadState('networkidle')

  expect(statsRequests(seen).map((r) => r.body)).toEqual(['{"p_refresh":false}'])
  expect(exactCounts(seen)).toEqual([])
  expect(seen.filter((r) => /rpc\/get_db_(size|connection_count)/.test(r.url))).toEqual([])

  expect(snapshot.users_total).toBeGreaterThan(0)
  await expect(page.getByTestId('admin-stat-users')).toHaveText(String(snapshot.users_total))
  await expect(page.getByTestId('admin-stat-servers')).toHaveText(String(snapshot.servers_total))
  await expect(page.getByTestId('admin-stat-instances')).toHaveText(String(snapshot.instances_total))
  await expect(page.getByTestId('admin-stat-posts')).toHaveText(String(snapshot.posts_total))
  await expect(page.locator('.overview-module')).toContainText(`${snapshot.servers_active_30d} active in the last 30 days`)
  await expect(page.locator('.overview-module')).toContainText(`+${snapshot.users_new_24h} in the last 24 hours`)
  await expect(page.locator('.health-module')).toContainText(`${snapshot.db_connections} connections`)
  await expect(page.getByTestId('admin-db-size')).toHaveText(/^\d+(\.\d)? (MB|GB)$/)

  // Refresh recomputes a snapshot older than a minute. Other specs add and remove rows on the
  // shared stack, so the figures are checked against the new snapshot, not a delta.
  await backdateSnapshot(120)

  const refreshed = page.waitForResponse((r) =>
    r.url().includes('/rest/v1/rpc/admin_instance_stats') && r.request().postData() === '{"p_refresh":true}')
  await page.locator('.admin-header .refresh-btn').click()
  const after = await (await refreshed).json()
  expect(new Date(after.computed_at).getTime()).toBeGreaterThan(new Date(snapshot.computed_at).getTime())
  expect(after.age_seconds).toBeLessThan(5)
  await expect(page.getByTestId('admin-stat-users')).toHaveText(String(after.users_total))
  await expect(page.getByTestId('admin-stats-updated')).toHaveText('Updated just now')

  // Within a minute Refresh reads the stored snapshot.
  const again = page.waitForResponse((r) =>
    r.url().includes('/rest/v1/rpc/admin_instance_stats') && r.request().postData() === '{"p_refresh":true}')
  await page.locator('.admin-header .refresh-btn').click()
  expect((await (await again).json()).computed_at).toBe(after.computed_at)
})

test('Federation tab reads the snapshot and counts nothing itself', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, staff)

  const seen = recordRest(page)
  const firstStats = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/admin_instance_stats'))
  await page.goto('/admin?tab=federation')
  const snapshot = await (await firstStats).json()
  await expect(page.getByTestId('federation-stat-total')).toHaveText(String(snapshot.instances_total), { timeout: 20000 })
  await expect(page.locator('.federation-module')).toContainText(`${snapshot.endpoints_total}Total endpoints`)
  await page.waitForLoadState('networkidle')

  expect(statsRequests(seen)).toHaveLength(1)
  // The instance list's page total (Prefer: count=exact on the page itself) is its only exact count.
  expect(exactCounts(seen).map((r) => `${r.method} ${r.url.replace(/^.*\/rest\/v1\//, '').split('?')[0]}`))
    .toEqual(['GET federated_instances'])
  expect(seen.filter((r) => r.method === 'HEAD')).toEqual(seen.filter(shellCount))
})

test('Users tab reads its filter counts from the snapshot and moves them on suspension', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, staff)

  const seen = recordRest(page)
  const firstStats = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/admin_instance_stats'))
  await page.goto('/admin?tab=users')
  const snapshot = await (await firstStats).json()
  const filter = (key: string) => page.getByTestId(`user-filter-${key}`)
  await expect(filter('all')).toHaveText(`All users (${snapshot.users_total})`, { timeout: 20000 })
  await expect(filter('local')).toHaveText(`Local (${snapshot.users_local})`)
  await expect(filter('federated')).toHaveText(`Federated (${snapshot.users_federated})`)
  await expect(filter('suspended')).toHaveText(`Suspended (${snapshot.users_suspended})`)
  await page.waitForLoadState('networkidle')

  expect(statsRequests(seen)).toHaveLength(1)
  // The user list's page total (Prefer: count=exact on the page itself) is its only exact count.
  expect([...new Set(exactCounts(seen).map((r) => `${r.method} ${r.url.replace(/^.*\/rest\/v1\//, '').split('?')[0]}`))])
    .toEqual(['GET profiles'])
  expect(seen.filter((r) => r.method === 'HEAD')).toEqual(seen.filter(shellCount))

  const users = page.locator('.users-module')
  await users.getByPlaceholder('Search users…').fill(member.username)
  const row = users.locator('.user-item').filter({ hasText: member.username })
  await expect(row).toHaveCount(1, { timeout: 15000 })

  await row.locator('.suspend-btn').click()
  const suspendDialog = page.getByRole('alertdialog', { name: 'Suspend user' })
  await suspendDialog.getByLabel('Reason').fill('stats journey')
  await suspendDialog.getByRole('button', { name: 'Suspend' }).click()
  await expect(row.getByText('Suspended', { exact: true })).toBeVisible()
  await expect(filter('suspended')).toHaveText(`Suspended (${snapshot.users_suspended + 1})`)
  expect(statsRequests(seen)).toHaveLength(1)

  // Opening Overview, then Users again, reads the snapshot anew. Another spec may have it recomputed:
  // its own figure then holds the suspension.
  const onTab = async (name: string) => {
    const answer = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/admin_instance_stats'))
    await page.getByRole('tab', { name, exact: true }).click()
    return (await answer).json()
  }
  await onTab('Overview')
  await expect(page.getByTestId('admin-stat-users')).toBeVisible()
  const reread = await onTab('Users')
  const suspended = reread.computed_at === snapshot.computed_at ? snapshot.users_suspended + 1 : reread.users_suspended
  await expect(filter('suspended')).toHaveText(`Suspended (${suspended})`)
  await users.getByPlaceholder('Search users…').fill(member.username)
  await expect(row.getByText('Suspended', { exact: true })).toBeVisible({ timeout: 15000 })

  await row.locator('.unsuspend-btn').click()
  await page.getByRole('alertdialog', { name: 'Unsuspend user' }).getByRole('button', { name: 'Unsuspend' }).click()
  await expect(row.getByText('Suspended', { exact: true })).toHaveCount(0)
  await expect(filter('suspended')).toHaveText(`Suspended (${suspended - 1})`)
  await expect(filter('all')).toHaveText(`All users (${reread.users_total})`)
  expect(statsRequests(seen)).toHaveLength(3)
})
