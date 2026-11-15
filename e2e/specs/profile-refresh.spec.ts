// Journey: a remote account's profile menu offers Refresh profile, which reads the account from
// its instance now (/api/federation/lookup-user with forceRefresh). The route here stands in for
// the federation backend: a forced read stores the account as its instance serves it and answers
// with it. The backend's forced read and its re-read of copies older than a day are covered by
// the round trip (e2e/federation/cases/remoteInteractions.ts) and lookupEmojiRead.test.ts.
//
//   - Refresh shows the account as its instance serves it now, header included, and says so;
//   - an instance that cannot be reached leaves the profile as it was and says why;
//   - a local account's menu has no Refresh.

import { randomUUID } from 'node:crypto'
import { test, expect, type Page, type Route } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
const stamp = Date.now().toString(36)
const remote = { id: randomUUID(), username: `mirror${stamp}`, domain: `bird-${stamp}.e2e.test` }
const handle = `${remote.username}@${remote.domain}`
let reader: SpecUser
let neighbour: SpecUser

test.beforeAll(async () => {
  reader = await createUser(admin, 'pref')
  neighbour = await createUser(admin, 'prefn')
  const actor = `https://${remote.domain}/users/${remote.username}`
  const now = new Date().toISOString()
  const { error } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    domain: remote.domain,
    display_name: 'Mirror before',
    is_local: false,
    federated_id: actor,
    inbox_url: `${actor}/inbox`,
    last_synced_at: now,
    remote_counts_fetched_at: now,
  })
  if (error) throw new Error(`remote profile: ${error.message}`)
})

test.afterAll(async () => {
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, reader)
  await deleteUser(admin, neighbour)
})

/**
 * /lookup-user as the backend answers it: the stored row, or after a forced read the account as
 * its instance serves it (`servedName`), or 504 when the instance is unreachable.
 */
async function routeLookups(page: Page, instance: { reachable: boolean; servedName: string }) {
  const forced: string[] = []
  await page.route('**/api/federation/lookup-user', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { handle?: string; forceRefresh?: boolean }
    const forceRefresh = body.forceRefresh === true
    if (forceRefresh) forced.push(String(body.handle ?? '').replace(/^@/, ''))
    if (forceRefresh && !instance.reachable) {
      await route.fulfill({ status: 504, json: { error: 'Remote server took too long to respond' } })
      return
    }
    if (forceRefresh) {
      const { error } = await admin.from('profiles')
        .update({ display_name: instance.servedName, last_synced_at: new Date().toISOString() })
        .eq('id', remote.id)
      if (error) throw new Error(`forced read: ${error.message}`)
    }
    const { data, error } = await admin.from('profiles').select('*').eq('id', remote.id).single()
    if (error) throw new Error(`stored row: ${error.message}`)
    await route.fulfill({
      json: { success: true, user: data, cached: !forceRefresh, refreshed: forceRefresh, refreshing: false, backfilling: false },
    })
  })
  return forced
}

async function openRemoteProfile(page: Page) {
  await page.goto(`/social/profile/@${handle}`)
  await dismissAnnouncements(page)
  await expect(page.getByTestId('profile-follow-btn')).toBeVisible({ timeout: 30_000 })
}

async function refresh(page: Page) {
  await page.getByTestId('profile-more-btn').click()
  const menu = page.getByTestId('profile-menu')
  const item = menu.getByTestId('profile-menu-refresh')
  await expect(item).toHaveText('Refresh profile')
  await item.click()
  await expect(menu).toBeHidden()
}

test('Refresh reads a remote account from its instance now', async ({ page }) => {
  test.setTimeout(90_000)
  await admin.from('profiles').update({ display_name: 'Mirror before' }).eq('id', remote.id)
  const forced = await routeLookups(page, { reachable: true, servedName: 'Mirror after' })
  await signIn(page, reader)
  await openRemoteProfile(page)
  const name = page.locator('h1.display-name')
  await expect(name).toHaveText('Mirror before')

  await refresh(page)

  await expect(page.getByText('Profile refreshed')).toBeVisible()
  await expect(name).toHaveText('Mirror after')
  expect(forced).toEqual([handle])
})

test('an unreachable instance leaves the profile as it was', async ({ page }) => {
  test.setTimeout(90_000)
  await admin.from('profiles').update({ display_name: 'Mirror kept' }).eq('id', remote.id)
  const forced = await routeLookups(page, { reachable: false, servedName: 'Mirror never shown' })
  await signIn(page, reader)
  await openRemoteProfile(page)
  const name = page.locator('h1.display-name')
  await expect(name).toHaveText('Mirror kept')

  await refresh(page)

  await expect(page.getByText(`Couldn't reach ${remote.domain} to refresh this profile`)).toBeVisible()
  await expect(name).toHaveText('Mirror kept')
  await expect(page.getByTestId('profile-handle')).toContainText(handle)
  expect(forced).toEqual([handle])
})

test('a local account\'s menu has no Refresh', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, reader)
  await page.goto(`/social/profile/@${neighbour.username}`)
  await dismissAnnouncements(page)
  await expect(page.getByTestId('profile-follow-btn')).toBeVisible({ timeout: 30_000 })

  await page.getByTestId('profile-more-btn').click()
  const menu = page.getByTestId('profile-menu')
  await expect(menu.getByTestId('profile-menu-copy-link')).toBeVisible()
  await expect(menu.getByTestId('profile-menu-refresh')).toHaveCount(0)
})
