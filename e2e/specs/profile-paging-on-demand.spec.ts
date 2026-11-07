// Journey: a profile reads one page of posts on open and the next page only as the reader
// nears the end of the list, by scrolling or with Load more. The profile column scrolls
// the feed; the feed's rows are windowed against that scroller, so rows below the fold are
// neither rendered nor taken as a request for more. A remote account's outbox is imported
// only on such a request, never on open. An import that reaches the outbox's end ends the
// list without an error; one that fails is sent again twice before the error and Retry show.
//
// The federation backend is absent from this stack: page.route answers the outbox import
// request and counts it.

import { randomUUID } from 'node:crypto'
import { test, expect, type Page, type Request } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
const LOCAL_POSTS = 66
const REMOTE_POSTS = 3
const DOMAIN = 'ondemand.example'
let viewer: SpecUser
let lou: SpecUser
const remy = { id: randomUUID(), username: `remy${Date.now().toString(36)}` }
const solo = { id: randomUUID(), username: `solo${Date.now().toString(36)}` }

const localLabel = (n: number) => `lou post ${String(n).padStart(2, '0')}`
const remoteLabel = (n: number) => `remy post ${n}`

async function insertPosts(rows: Record<string, unknown>[]) {
  const { error } = await admin.from('posts').insert(rows)
  if (error) throw new Error(`posts: ${error.message}`)
}

test.beforeAll(async () => {
  viewer = await createUser(admin, 'ppdv')
  lou = await createUser(admin, 'ppdl')
  const now = Date.now()
  await insertPosts(
    Array.from({ length: LOCAL_POSTS }, (_, i) => ({
      author_id: lou.id,
      visibility: 'public',
      is_local: true,
      content: [{ type: 'text', text: localLabel(i + 1) }],
      created_at: new Date(now - (i + 1) * 60_000).toISOString(),
    })),
  )

  const remoteProfile = (who: { id: string; username: string }, displayName: string) => {
    const actor = `https://${DOMAIN}/users/${who.username}`
    return {
      id: who.id,
      username: who.username,
      display_name: displayName,
      domain: DOMAIN,
      is_local: false,
      federated_id: actor,
      inbox_url: `${actor}/inbox`,
      outbox_url: `${actor}/outbox`,
    }
  }
  const { error } = await admin.from('profiles').insert([remoteProfile(remy, 'Remy'), remoteProfile(solo, 'Solo')])
  if (error) throw new Error(`remote profiles: ${error.message}`)
  await insertPosts(
    Array.from({ length: REMOTE_POSTS }, (_, i) => ({
      author_id: remy.id,
      ap_id: `https://${DOMAIN}/users/${remy.username}/statuses/${i + 1}`,
      is_local: false,
      visibility: 'public',
      content: [{ type: 'text', text: remoteLabel(i + 1) }],
      created_at: new Date(now - (i + 1) * 60_000).toISOString(),
    })),
  )
  await insertPosts([{
    author_id: solo.id,
    ap_id: `https://${DOMAIN}/users/${solo.username}/statuses/1`,
    is_local: false,
    visibility: 'public',
    content: [{ type: 'text', text: 'solo post' }],
    created_at: new Date(now - 60_000).toISOString(),
  }])
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [lou?.id, remy.id, solo.id].filter(Boolean))
  await admin.from('profiles').delete().in('id', [remy.id, solo.id])
  await deleteUser(admin, viewer)
  await deleteUser(admin, lou)
})

/** GET pages of an author's post list, as UserProfileView reads them. */
function countPostPages(page: Page, authorId: string): () => number {
  let pages = 0
  page.on('request', (request: Request) => {
    const url = decodeURIComponent(request.url())
    if (request.method() === 'GET' && url.includes('/rest/v1/posts?') && url.includes(`author_id=eq.${authorId}`) && url.includes('limit=20')) pages++
  })
  return () => pages
}

/**
 * Answers outbox import requests with `statuses` in turn, the last one repeated; a 200 is the
 * end of the outbox. Returns the count of requests answered.
 */
async function answerOutboxImports(page: Page, statuses: number[]): Promise<() => number> {
  let imports = 0
  await page.route('**/api/federation/fetch-posts', async (route) => {
    const status = statuses[Math.min(imports, statuses.length - 1)]
    imports++
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(status === 200
        ? { success: true, has_more: false, oldest_id: null, next_page: 'none' }
        : { error: 'Remote outbox could not be read' }),
    })
  })
  return () => imports
}

const profilePosts = (page: Page) => page.locator('.posts-tab .posts-container [data-testid="post-item"]')
const profileScroller = (page: Page) => page.locator('.user-profile-view')

test('a local profile reads one page on open and more as the reader scrolls', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, viewer)
  const pages = countPostPages(page, lou.id)
  await page.goto(`/social/profile/${lou.username}`)
  await expect(profilePosts(page).filter({ hasText: localLabel(1) })).toBeVisible({ timeout: 90_000 })

  // Left untouched, the profile stays on its first page.
  await page.waitForTimeout(3000)
  expect(pages()).toBe(1)
  await expect(profilePosts(page).filter({ hasText: localLabel(21) })).toHaveCount(0)
  expect(await profilePosts(page).count()).toBeLessThan(20)
  await expect(page.getByTestId('feed-footer')).not.toContainText("Couldn't load more posts")

  // Scrolling to the end reads the following pages, down to the oldest post.
  const oldest = profilePosts(page).filter({ hasText: localLabel(LOCAL_POSTS) })
  await expect(async () => {
    await profileScroller(page).evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }))
    await expect(oldest).toBeVisible({ timeout: 2000 })
  }).toPass({ timeout: 90_000, intervals: [500, 1000, 1000] })
  expect(pages()).toBeGreaterThanOrEqual(4)
  // The first post is out of the window by now.
  await expect(profilePosts(page).filter({ hasText: localLabel(1) })).toHaveCount(0)
})

const LOAD_FAILED = "Couldn't load more posts"

async function openRemoteProfile(page: Page, who: { username: string }, firstPost: string, count: number) {
  await page.goto(`/social/profile/@${who.username}@${DOMAIN}`)
  await expect(profilePosts(page).filter({ hasText: firstPost })).toBeVisible({ timeout: 90_000 })
  await expect(profilePosts(page)).toHaveCount(count)
}

test('a remote profile imports its outbox only when more is asked for, and ends quietly at its end', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, viewer)
  const imports = await answerOutboxImports(page, [200])
  await openRemoteProfile(page, remy, remoteLabel(1), REMOTE_POSTS)

  await page.waitForTimeout(4000)
  expect(imports()).toBe(0)
  const footer = page.getByTestId('feed-footer')
  await expect(footer.getByTestId('feed-load-more')).toBeVisible()

  await footer.getByTestId('feed-load-more').click()
  await expect.poll(imports, { timeout: 15000 }).toBe(1)
  await expect(footer).toHaveCount(0, { timeout: 15000 })
  await expect(page.getByText(LOAD_FAILED)).toHaveCount(0)
  await expect(profilePosts(page)).toHaveCount(REMOTE_POSTS)
  expect(imports()).toBe(1)
})

test('a remote profile with one post ends without an error', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, viewer)
  const imports = await answerOutboxImports(page, [200])
  await openRemoteProfile(page, solo, 'solo post', 1)

  await page.getByTestId('feed-footer').getByTestId('feed-load-more').click()
  await expect.poll(imports, { timeout: 15000 }).toBe(1)
  await expect(page.getByTestId('feed-footer')).toHaveCount(0, { timeout: 15000 })
  await expect(page.getByText(LOAD_FAILED)).toHaveCount(0)
})

test('a failed outbox import is sent again before the error shows', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, viewer)

  await test.step('a 503 answered by a 200 on the next attempt shows no error', async () => {
    const imports = await answerOutboxImports(page, [503, 200])
    await openRemoteProfile(page, remy, remoteLabel(1), REMOTE_POSTS)
    await page.getByTestId('feed-footer').getByTestId('feed-load-more').click()
    await expect.poll(imports, { timeout: 15000 }).toBe(2)
    await expect(page.getByTestId('feed-footer')).toHaveCount(0, { timeout: 15000 })
    await expect(page.getByText(LOAD_FAILED)).toHaveCount(0)
  })

  await test.step('three 503s show the error and Retry, after exactly three requests', async () => {
    await page.unrouteAll({ behavior: 'wait' })
    const imports = await answerOutboxImports(page, [503])
    await openRemoteProfile(page, remy, remoteLabel(1), REMOTE_POSTS)
    const footer = page.getByTestId('feed-footer')
    await footer.getByTestId('feed-load-more').click()
    await expect(footer).toContainText(LOAD_FAILED, { timeout: 15000 })
    await expect(footer.getByRole('button', { name: 'Retry' })).toBeVisible()
    expect(imports()).toBe(3)
    await page.waitForTimeout(3000)
    expect(imports()).toBe(3)
  })
})
