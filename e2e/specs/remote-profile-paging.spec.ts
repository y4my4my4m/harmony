// Journey: a remote profile with more than 100 stored posts, two of them pinned.
// The pinned posts lead the profile, and scrolling pages through every stored
// post to the oldest.
//
// The account has an outbox_url, as every looked-up remote account does. Load more
// reads the stored posts older than the last one listed and imports the outbox only
// once none is left; the federation backend is absent from this stack, so that
// import fails and paging stops there. The posts are seeded through the service
// role, as federation stores them.

import { randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
const DOMAIN = 'pager.example'
const POSTS = 130
const PINNED = [125, 128]
let viewer: SpecUser
const remote = {
  id: randomUUID(),
  username: `pager${Date.now().toString(36)}`,
}

const label = (n: number) => `remote post ${String(n).padStart(3, '0')}`

test.beforeAll(async () => {
  viewer = await createUser(admin, 'rpv')
  const actor = `https://${DOMAIN}/users/${remote.username}`
  const { error } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Pager',
    domain: DOMAIN,
    is_local: false,
    federated_id: actor,
    inbox_url: `${actor}/inbox`,
    outbox_url: `${actor}/outbox`,
  })
  if (error) throw new Error(`remote profile: ${error.message}`)

  // Post 1 is the newest; a minute apart.
  const start = Date.UTC(2026, 8, 1)
  const rows = Array.from({ length: POSTS }, (_, i) => {
    const n = i + 1
    return {
      author_id: remote.id,
      ap_id: `${actor}/statuses/${n}`,
      is_local: false,
      visibility: 'public',
      content: [{ type: 'text', text: label(n) }],
      created_at: new Date(start - n * 60_000).toISOString(),
      is_pinned: PINNED.includes(n),
    }
  })
  for (let i = 0; i < rows.length; i += 50) {
    const { error: postsError } = await admin.from('posts').insert(rows.slice(i, i + 50))
    if (postsError) throw new Error(`remote posts: ${postsError.message}`)
  }
})

test.afterAll(async () => {
  await admin.from('posts').delete().eq('author_id', remote.id)
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, viewer)
})

test('a remote profile shows its pinned posts first and pages past 100 posts', async ({ page }) => {
  test.setTimeout(240_000)

  const posts = page.locator('.posts-tab [data-testid="post-item"]')
  const pinned = page.locator('.pinned-posts-section [data-testid="post-item"]')

  await test.step('open the profile', async () => {
    await signIn(page, viewer)
    await page.goto(`/social/profile/@${remote.username}@${DOMAIN}`)
    await expect(page.locator('.name-handle-section .user-handle')).toContainText(remote.username, { timeout: 30000 })
    await expect(posts.filter({ hasText: label(1) })).toBeVisible({ timeout: 30000 })
  })

  await test.step('the pinned posts lead the profile', async () => {
    await expect(pinned).toHaveCount(PINNED.length, { timeout: 15000 })
    await expect(pinned.nth(0)).toContainText(label(PINNED[0]))
    await expect(pinned.nth(1)).toContainText(label(PINNED[1]))
    await expect(pinned.first()).toHaveClass(/is-pinned/)
    // Above every post of the timeline.
    const firstPinnedTop = (await pinned.first().boundingBox())?.y ?? Infinity
    const newestTop = (await posts.filter({ hasText: label(1) }).boundingBox())?.y ?? -Infinity
    expect(firstPinnedTop).toBeLessThan(newestTop)
  })

  await test.step('scrolling reaches the oldest post, past the first 100', async () => {
    const oldest = page.locator('.posts-container [data-testid="post-item"]').filter({ hasText: label(POSTS) })
    await expect(async () => {
      await page.locator('.user-profile-view').evaluate((el) => el.scrollTo(0, el.scrollHeight))
      await expect(oldest).toBeVisible({ timeout: 2000 })
    }).toPass({ timeout: 120000, intervals: [500, 1000, 1000] })
  })
})
