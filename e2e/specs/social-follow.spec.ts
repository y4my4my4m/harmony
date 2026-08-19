// Journey: find another user's profile and follow them.
//
// The follower count is profiles.followers_count, maintained by a trigger on
// follows; the profile view reads it on load, so the count is re-read after a
// reload rather than watched in place.
//
// /social/profile/:handle resolves through profiles.username + profiles.domain,
// with the domain taken from VITE_DOMAIN. Unset or mismatched, every profile
// renders "Profile not found".

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let follower: SpecUser
let target: SpecUser

test.beforeAll(async () => {
  follower = await createUser(admin, 'fola')
  target = await createUser(admin, 'folb')
})

test.afterAll(async () => {
  await deleteUser(admin, follower)
  await deleteUser(admin, target)
})

test('following a user moves their follower count from zero to one', async ({ page }) => {
  test.setTimeout(180_000)

  const followButton = page.locator('.primary-action-btn.follow-btn')
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
    await expect(followButton).toHaveText('Follow', { timeout: 30000 })
  })

  await test.step('follow them', async () => {
    await followButton.click()
    await expect(followButton).toHaveText('Following', { timeout: 30000 })
  })

  await test.step('the follower count reads 1', async () => {
    await page.reload()
    await expect(followersCount).toHaveText('1', { timeout: 30000 })
    await expect(followButton).toHaveText('Following', { timeout: 30000 })
  })

  await test.step('the follow survives for the follower too', async () => {
    await page.goto(`/social/profile/${follower.username}`)
    await expect(
      page.locator('.tab-btn').filter({ hasText: 'Following' }).locator('.tab-count'),
    ).toHaveText('1', { timeout: 30000 })
  })
})
