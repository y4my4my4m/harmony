// Journey: a profile reads one page of posts on open and the next page only as the reader
// nears the end of the list, by scrolling or with Load more. The profile column scrolls
// the feed; the feed's rows are windowed against that scroller, so rows below the fold are
// neither rendered nor taken as a request for more. A remote account's outbox is imported
// only on such a request, never on open.
//
// The federation backend is absent from this stack: the outbox import request is counted,
// and fails.

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

const localLabel = (n: number) => `lou post ${String(n).padStart(2, '0')}`
const remoteLabel = (n: number) => `remy post ${n}`

/**
 * create_comprehensive_timeline_entries fans a public post out to every local profile,
 * which races a profile another spec deletes meanwhile (timeline_entries_user_id_fkey);
 * the insert is atomic and is retried.
 */
async function insertPosts(rows: Record<string, unknown>[]) {
  for (let attempt = 0; ; attempt++) {
    const { error } = await admin.from('posts').insert(rows)
    if (!error) return
    if (attempt < 4 && error.message.includes('timeline_entries_user_id_fkey')) continue
    throw new Error(`posts: ${error.message}`)
  }
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

  const actor = `https://${DOMAIN}/users/${remy.username}`
  const { error } = await admin.from('profiles').insert({
    id: remy.id,
    username: remy.username,
    display_name: 'Remy',
    domain: DOMAIN,
    is_local: false,
    federated_id: actor,
    inbox_url: `${actor}/inbox`,
    outbox_url: `${actor}/outbox`,
  })
  if (error) throw new Error(`remote profile: ${error.message}`)
  await insertPosts(
    Array.from({ length: REMOTE_POSTS }, (_, i) => ({
      author_id: remy.id,
      ap_id: `${actor}/statuses/${i + 1}`,
      is_local: false,
      visibility: 'public',
      content: [{ type: 'text', text: remoteLabel(i + 1) }],
      created_at: new Date(now - (i + 1) * 60_000).toISOString(),
    })),
  )
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [lou?.id, remy.id].filter(Boolean))
  await admin.from('profiles').delete().eq('id', remy.id)
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

function countOutboxImports(page: Page): () => number {
  let imports = 0
  page.on('request', (request: Request) => {
    if (request.method() === 'POST' && request.url().includes('/api/federation/fetch-posts')) imports++
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

test('a remote profile imports its outbox only when more is asked for', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, viewer)
  const imports = countOutboxImports(page)
  await page.goto(`/social/profile/@${remy.username}@${DOMAIN}`)
  await expect(profilePosts(page).filter({ hasText: remoteLabel(1) })).toBeVisible({ timeout: 90_000 })
  await expect(profilePosts(page)).toHaveCount(REMOTE_POSTS)

  await page.waitForTimeout(4000)
  expect(imports()).toBe(0)
  const footer = page.getByTestId('feed-footer')
  await expect(footer.getByTestId('feed-load-more')).toBeVisible()

  await footer.getByTestId('feed-load-more').click()
  await expect.poll(imports, { timeout: 15000 }).toBe(1)
})
