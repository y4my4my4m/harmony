// Journey: find another user's profile and follow them. Follow in the profile
// card flips at once and holds until the write lands.
//
// The follower count is profiles.followers_count, maintained by a trigger on
// follows; the profile view reads it on load, so the count is re-read after a
// reload rather than watched in place.
//
// /social/profile/:handle resolves through profiles.username + profiles.domain,
// with the domain taken from VITE_DOMAIN. Unset or mismatched, every profile
// renders "Profile not found".

import { test, expect, type Page, type Route } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let follower: SpecUser
let target: SpecUser
let cardFollower: SpecUser
let cardTarget: SpecUser
let server: SeededServer

test.beforeAll(async () => {
  follower = await createUser(admin, 'fola')
  target = await createUser(admin, 'folb')
  cardFollower = await createUser(admin, 'folc')
  cardTarget = await createUser(admin, 'fold')
  server = await seedServer(admin, cardFollower, `Follow ${cardFollower.username}`)
  await addMember(admin, cardTarget, server.id)
})

test.afterAll(async () => {
  for (const user of [follower, target, cardFollower, cardTarget]) await deleteUser(admin, user)
})

test('following a user moves their follower count from zero to one', async ({ page }) => {
  test.setTimeout(180_000)

  const followButton = page.locator('[data-testid="profile-follow-btn"]')
  // The hover label ("Unfollow") shares the button; assert the resting label.
  const followLabel = followButton.locator('.follow-label')
  const followersCount = page
    .locator('.tab-btn')
    .filter({ hasText: 'Followers' })
    .locator('.tab-count')

  await test.step('open a profile nobody follows', async () => {
    await signIn(page, follower)
    await page.goto(`/social/profile/${target.username}`)

    await expect(page.locator('.name-handle-section .user-handle')).toContainText(
      target.username,
      { timeout: 30000 },
    )
    await expect(followersCount).toHaveText('0', { timeout: 30000 })
    await expect(followLabel).toHaveText('Follow', { timeout: 30000 })
  })

  await test.step('follow them', async () => {
    await followButton.click()
    await expect(followLabel).toHaveText('Following', { timeout: 30000 })
  })

  await test.step('the follower count reads 1', async () => {
    await page.reload()
    await expect(followersCount).toHaveText('1', { timeout: 30000 })
    await expect(followLabel).toHaveText('Following', { timeout: 30000 })
  })

  await test.step('the follow survives for the follower too', async () => {
    await page.goto(`/social/profile/${follower.username}`)
    await expect(
      page.locator('.tab-btn').filter({ hasText: 'Following' }).locator('.tab-count'),
    ).toHaveText('1', { timeout: 30000 })
  })
})

async function openProfileCard(page: Page, user: SpecUser) {
  await page
    .locator('.user-sidebar .user-item')
    .filter({ hasText: user.displayName })
    .first()
    .click()
  const card = page.locator('.profile-modal-content')
  await expect(card).toBeVisible({ timeout: 15000 })
  return card
}

test('Follow in the profile card responds before the write returns', async ({ page }) => {
  test.setTimeout(180_000)

  await signIn(page, cardFollower)
  await openChannel(page, server.id, server.generalChannelId)
  const card = await openProfileCard(page, cardTarget)
  const followButton = card
    .locator('.primary-action-btn')
    .filter({ hasText: /^\s*(Follow|Unfollow)\s*$/ })
  await expect(followButton).toHaveText('Follow', { timeout: 15000 })

  // The follows insert is held until the optimistic state has been read.
  let release: () => void = () => {}
  const held = new Promise<Route>((resolve) => {
    void page.route('**/rest/v1/follows*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      resolve(route)
      await new Promise<void>((r) => {
        release = r
      })
      await route.continue()
    })
  })

  await test.step('the button flips at once and blocks a second click', async () => {
    await followButton.click()
    await held
    await expect(followButton).toHaveText('Unfollow')
    await expect(followButton).toBeDisabled()
    await expect(followButton).toHaveAttribute('aria-busy', 'true')
  })

  await test.step('the write lands and the button settles', async () => {
    const inserted = page.waitForResponse(
      (r) => r.url().includes('/rest/v1/follows') && r.request().method() === 'POST',
    )
    release()
    expect((await inserted).ok()).toBe(true)
    await expect(followButton).toBeEnabled()
    await expect(followButton).toHaveText('Unfollow')
    await page.unroute('**/rest/v1/follows*')
  })

  await test.step('the follow is stored and shown after a reload', async () => {
    const { data } = await admin
      .from('follows')
      .select('status')
      .eq('follower_id', cardFollower.id)
      .eq('following_id', cardTarget.id)
    expect(data).toEqual([{ status: 'accepted' }])

    await page.reload()
    const reopened = await openProfileCard(page, cardTarget)
    await expect(
      reopened.locator('.primary-action-btn').filter({ hasText: /^\s*(Follow|Unfollow)\s*$/ }),
    ).toHaveText('Unfollow', { timeout: 15000 })
  })
})
