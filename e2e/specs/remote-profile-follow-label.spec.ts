// Journey: remote profiles name what following does and why no posts show.
//
// A Shoot account (a chat server: every actor approves followers, a follow is a friendship)
// offers "Send friend request"; its server serves no outbox, so the posts tab says the
// server publishes none instead of "hasn't posted anything yet". A locked account on any
// other server offers "Request to follow".
//
// Profiles and the instance row are seeded through the service role, as federation stores
// them; the federation backend is absent from this stack.

import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
const stamp = Date.now().toString(36)
const SHOOT_DOMAIN = `understars-${stamp}.e2e.test`
const SHOOT_HOST = `chat.${SHOOT_DOMAIN}`
const LOCKED_DOMAIN = `locked-${stamp}.e2e.test`
const shoot = { id: randomUUID(), username: `doesnm${stamp}` }
const locked = { id: randomUUID(), username: `quiet${stamp}` }
let viewer: SpecUser

test.beforeAll(async () => {
  viewer = await createUser(admin, 'rfl')
  const readAt = new Date().toISOString()
  const { error } = await admin.from('profiles').insert([
    {
      id: shoot.id,
      username: shoot.username,
      display_name: shoot.username,
      domain: SHOOT_DOMAIN,
      is_local: false,
      federated_id: `https://${SHOOT_HOST}/users/${shoot.username}`,
      inbox_url: `https://${SHOOT_HOST}/users/${shoot.username}/inbox`,
      manually_approves_followers: true,
      // Outbox answered 404: the total is withheld.
      remote_posts_count: null,
      remote_followers_count: 0,
      remote_following_count: 0,
      remote_counts_fetched_at: readAt,
    },
    {
      id: locked.id,
      username: locked.username,
      display_name: 'Quiet',
      domain: LOCKED_DOMAIN,
      is_local: false,
      federated_id: `https://${LOCKED_DOMAIN}/users/${locked.username}`,
      inbox_url: `https://${LOCKED_DOMAIN}/users/${locked.username}/inbox`,
      manually_approves_followers: true,
      remote_posts_count: 0,
      remote_followers_count: 3,
      remote_following_count: 2,
      remote_counts_fetched_at: readAt,
    },
  ])
  if (error) throw new Error(`remote profiles: ${error.message}`)
  const { error: instanceError } = await admin.from('federated_instances').insert({ domain: SHOOT_HOST, software: 'shoot' })
  if (instanceError) throw new Error(`instance: ${instanceError.message}`)
})

test.afterAll(async () => {
  await admin.from('profiles').delete().in('id', [shoot.id, locked.id])
  await admin.from('federated_instances').delete().eq('domain', SHOOT_HOST)
  await deleteUser(admin, viewer)
})

test('a Shoot account offers a friend request and says its server publishes no posts', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, viewer)

  const follow = page.locator('[data-testid="profile-follow-btn"]')
  const posts = page.locator('.posts-tab')

  await test.step('Shoot account', async () => {
    await page.goto(`/social/profile/@${shoot.username}@${SHOOT_DOMAIN}`)
    await expect(page.locator('.name-handle-section .user-handle')).toContainText(shoot.username, { timeout: 30000 })
    await expect(follow.locator('.follow-label')).toHaveText('Send friend request', { timeout: 15000 })
    await expect(follow).toHaveAttribute('aria-label', `Send friend request to @${shoot.username}`)
    await expect(posts.getByText('No public posts')).toBeVisible({ timeout: 30000 })
    await expect(posts.getByText(`${SHOOT_DOMAIN} doesn't publish this account's posts.`, { exact: false })).toBeVisible()
  })

  await test.step('locked account on another server', async () => {
    await page.goto(`/social/profile/@${locked.username}@${LOCKED_DOMAIN}`)
    await expect(page.locator('.name-handle-section .user-handle')).toContainText(locked.username, { timeout: 30000 })
    await expect(follow.locator('.follow-label')).toHaveText('Request to follow', { timeout: 15000 })
    await expect(follow).toHaveAttribute('aria-label', `Request to follow @${locked.username}`)
    await expect(posts.getByText("Quiet hasn't posted anything yet.")).toBeVisible({ timeout: 30000 })
    await expect(posts.getByText('No public posts')).toHaveCount(0)
  })
})
