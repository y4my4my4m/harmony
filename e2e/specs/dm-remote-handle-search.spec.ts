// Journey: the DM sidebar and the social feed's search find an account of an instance this one
// has never met, through one search (activityPubService.searchUsersResolvingHandle).
//
// search_federated_users reads stored profiles only. A complete remote handle that matches
// none is looked up through /api/federation/lookup-user, which stores the profile; the
// search then lists it. The route here stands in for the federation backend: it stores the
// profile as the backend does after WebFinger and answers with it. The backend's own handle
// lookup is covered by the round trip (e2e/federation/cases/outboundFederation.ts).
//
//   - a name, or a handle of an unfinished host, sends no lookup;
//   - the complete handle sends one lookup and lists the account, which opens a conversation;
//   - an unresolved handle shows no result and is not looked up again within a minute.

import crypto from 'node:crypto'
import { test, expect, type Page, type Route } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
const marker = Date.now().toString(36)
const remoteDomain = 'far.e2e.example'
const remote = { id: crypto.randomUUID(), username: `faraway${marker}` }
const social = { id: crypto.randomUUID(), username: `elsewhere${marker}` }
const ghost = `ghost${marker}@nowhere.e2e.example`
let sender: SpecUser

test.beforeAll(async () => {
  sender = await createUser(admin, 'dmrh')
})

test.afterAll(async () => {
  await admin.from('profiles').delete().in('id', [remote.id, social.id])
  await deleteUser(admin, sender)
})

async function routeLookups(page: Page, account: { id: string; username: string }): Promise<string[]> {
  const handles: string[] = []
  const actor = `https://${remoteDomain}/users/${account.username}`
  await page.route('**/api/federation/lookup-user', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { handle?: string }
    const handle = String(body.handle ?? '').replace(/^@/, '').toLowerCase()
    handles.push(handle)
    if (handle !== `${account.username}@${remoteDomain}`) {
      await route.fulfill({ status: 404, json: { error: 'User not found' } })
      return
    }
    const { data, error } = await admin.from('profiles').upsert({
      id: account.id,
      username: account.username,
      display_name: 'Faraway Account',
      domain: remoteDomain,
      is_local: false,
      federated_id: actor,
      inbox_url: `${actor}/inbox`,
      remote_counts_fetched_at: new Date().toISOString(),
    }).select('*').single()
    if (error) throw new Error(`remote profile: ${error.message}`)
    await route.fulfill({ json: { success: true, user: data, cached: false } })
  })
  return handles
}

async function search(page: Page, query: string) {
  const input = page.locator('.user-search-section .search-input')
  await input.fill(query)
}

test('the DM sidebar looks up a remote handle this instance has not met', async ({ page }) => {
  test.setTimeout(180_000)
  const lookups = await routeLookups(page, remote)
  const results = page.locator('.search-result-item')

  await test.step('the stored search answers names; nothing is looked up', async () => {
    const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true }).eq('id', remote.id)
    expect(count).toBe(0)

    await signIn(page, sender)
    await page.goto('/dm')
    await dismissAnnouncements(page)
    await expect(page.locator('[data-testid="dm-sidebar"]')).toBeVisible({ timeout: 30000 })
    await page.locator('[data-testid="dm-new-conversation"]').click()

    await search(page, remote.username)
    await expect(page.locator('.user-search-section')).toContainText(/no users found/i, { timeout: 30000 })
    await search(page, `${remote.username}@far`)
    await expect(page.locator('.user-search-section')).toContainText(/no users found/i, { timeout: 30000 })
    expect(lookups).toEqual([])
  })

  await test.step('the complete handle is looked up once and listed', async () => {
    await search(page, `@${remote.username}@${remoteDomain}`)
    const row = results.filter({ hasText: remote.username })
    await expect(row).toHaveCount(1, { timeout: 30000 })
    await expect(results).toHaveCount(1)
    await expect(row.locator('.username')).toHaveText(`@${remote.username}@${remoteDomain}`)
    expect(lookups).toEqual([`${remote.username}@${remoteDomain}`])
  })

  await test.step('the stored profile now answers without a lookup', async () => {
    await search(page, '')
    await search(page, `${remote.username}@${remoteDomain}`)
    await expect(results.filter({ hasText: remote.username })).toHaveCount(1, { timeout: 30000 })
    await search(page, '')
    await search(page, `@${remote.username}@${remoteDomain}`)
    await expect(results.filter({ hasText: remote.username })).toHaveCount(1, { timeout: 30000 })
    expect(lookups).toHaveLength(1)
  })

  await test.step('the account opens a conversation', async () => {
    await results.filter({ hasText: remote.username }).click()
    await page.waitForURL(/\/dm\/[0-9a-f-]{36}/, { timeout: 30000 })
  })

  await test.step('an unresolved handle lists nobody and is not looked up again at once', async () => {
    await page.goto('/dm')
    await dismissAnnouncements(page)
    await page.locator('[data-testid="dm-new-conversation"]').click()
    await search(page, ghost)
    await expect(page.locator('.user-search-section')).toContainText(/no users found/i, { timeout: 30000 })
    await expect.poll(() => lookups.filter((h) => h === ghost).length, { timeout: 30000 }).toBe(1)

    await search(page, '')
    await search(page, ghost)
    await expect(page.locator('.user-search-section')).toContainText(/no users found/i, { timeout: 30000 })
    await page.waitForTimeout(1500)
    expect(lookups.filter((h) => h === ghost)).toHaveLength(1)
  })
})

test('the social feed search looks up a remote handle through the same search', async ({ page }) => {
  test.setTimeout(120_000)
  const lookups = await routeLookups(page, social)
  await signIn(page, sender)
  await page.goto('/social')
  await dismissAnnouncements(page)
  await page.locator('.mony-header-container').getByRole('button', { name: 'Search' }).click()
  const dialog = page.getByTestId('user-search-dialog')
  await expect(dialog).toBeVisible({ timeout: 30000 })
  await dialog.getByTestId('user-search-input').fill(`@${social.username}@${remoteDomain}`)
  await expect(dialog.locator('.results-list [role="listitem"]').filter({ hasText: social.username }))
    .toHaveCount(1, { timeout: 30000 })
  expect(lookups).toEqual([`${social.username}@${remoteDomain}`])
})
