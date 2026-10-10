// Journey: replies of remote posts. Opening a remote post fetches its replies from the
// origin and shows them in place; timelines show the reply count, which opens the post.
//
// The federation backend's /fetch-replies and /fetch-replies/status are answered here, as
// the backend answers them (e2e/federation/cases/remoteReplies.ts runs the real crawl), and
// the replies a crawl stores are inserted through the service role when the scripted status
// reports the crawl done. Every other /api/federation request is answered 404, so no
// developer backend on the dev server's proxy target is reached. Contexts block service
// workers: page.route() does not see requests a service worker makes. The last test lets
// the worker run and checks it leaves a slow POST alone.

import crypto from 'node:crypto'
import { test, expect, type Page, type Route } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
const ORIGIN = 'replies.example'
let reader: SpecUser
let author: { id: string; username: string; actor: string }
let replier: { id: string; username: string; actor: string }

function tag(): string {
  return crypto.randomBytes(4).toString('hex')
}

async function remoteAccount(name: string) {
  const username = `${name}${tag()}`
  const actor = `https://${ORIGIN}/users/${username}`
  const { data, error } = await admin
    .from('profiles')
    .insert({ username, display_name: `Remote ${username}`, domain: ORIGIN, federated_id: actor, is_local: false })
    .select('id')
    .single()
  if (error || !data) throw new Error(`remote account ${username}: ${error?.message}`)
  return { id: data.id as string, username, actor }
}

/**
 * Inserts posts as the service role. A public post is entered on every local profile's
 * public timeline (create_comprehensive_timeline_entries); a parallel spec deleting its
 * users meanwhile fails the insert with 23503, and the insert is repeated.
 */
async function insertPosts(rows: Record<string, unknown>[]): Promise<string[]> {
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await admin.from('posts').insert(rows).select('id')
    if (!error && data) return data.map((row) => row.id as string)
    if (error?.code !== '23503' || attempt >= 4) throw new Error(`posts: ${error?.message}`)
  }
}

/** A remote post as federation stores one; `fetchedAgoMs` sets replies_fetched_at that long ago. */
async function remotePost(text: string, fetchedAgoMs?: number): Promise<{ id: string; apId: string }> {
  const apId = `${author.actor}/statuses/${tag()}`
  const [id] = await insertPosts([{
    author_id: author.id,
    content: [{ type: 'text', text }],
    visibility: 'public',
    is_local: false,
    ap_id: apId,
    url: apId,
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    replies_fetched_at: fetchedAgoMs === undefined ? null : new Date(Date.now() - fetchedAgoMs).toISOString(),
  }])
  return { id, apId }
}

/** Replies stored as a crawl stores them. */
async function storeReplies(parentId: string, texts: string[]): Promise<void> {
  await insertPosts(texts.map((text) => ({
    author_id: replier.id,
    content: [{ type: 'text', text }],
    visibility: 'public',
    is_local: false,
    ap_id: `${replier.actor}/statuses/${tag()}`,
    in_reply_to: parentId,
  })))
}

const crawl = (extra: Record<string, unknown>) => ({
  outcome: 'ok', found: 0, stored: 0, existing: 0, skipped: 0, pages: 1, truncated: false, complete: true, ...extra,
})

interface FederationScript {
  /** Answer to POST /fetch-replies: status code and body. */
  replies?: (body: any) => Promise<{ status?: number; headers?: Record<string, string>; body: unknown }>
  status?: () => Promise<unknown>
}

/** Answers the page's /api/federation requests; returns the POST /fetch-replies bodies. */
async function scriptFederation(page: Page, script: FederationScript): Promise<any[]> {
  const starts: any[] = []
  await page.route('**/api/federation/**', async (route: Route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api\/federation/, '')
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/fetch-replies' && request.method() === 'POST' && script.replies) {
      const body = request.postDataJSON()
      starts.push(body)
      const answer = await script.replies(body)
      return json(answer.body, answer.status ?? 200, answer.headers ?? {})
    }
    if (path === '/fetch-replies/status' && script.status) return json(await script.status())
    if (path === '/fetch-reactions-batch') return json({ results: {} })
    return json({ error: 'not available in this journey' }, 404)
  })
  return starts
}

/** A full page load of the Vite dev build, which a loaded machine stretches past 30 s. */
const APP_LOAD_MS = 60_000

const fetchingRow = (page: Page) => page.locator('[data-testid="remote-replies-fetching"]')
const statusRow = (page: Page) => page.locator('.remote-replies-status')

test.beforeAll(async () => {
  reader = await createUser(admin, 'rrep')
  author = await remoteAccount('rauthor')
  replier = await remoteAccount('rreplier')
})

test.afterAll(async () => {
  await deleteUser(admin, reader)
  await admin.from('profiles').delete().in('id', [author?.id, replier?.id].filter(Boolean))
})

test('opening a remote post fetches its replies and shows them without a reload', async ({ page }) => {
  test.setTimeout(180_000)
  const post = await remotePost(`remote root ${tag()}`)
  const replyText = `crawled reply ${tag()}`
  let statusReads = 0

  const starts = await scriptFederation(page, {
    replies: async () => ({ body: { success: true, status: 'started', result: null, replies_count: 0 } }),
    status: async () => {
      statusReads += 1
      if (statusReads < 2) return { success: true, status: 'running', result: null }
      await storeReplies(post.id, [`${replyText} one`, `${replyText} two`])
      return { success: true, status: 'done', result: crawl({ found: 2, stored: 2 }), replies_count: 2 }
    },
  })

  await test.step('the post detail shows a placeholder while the origin is read', async () => {
    await signIn(page, reader)
    await page.goto(`/social/post/${post.id}`)
    await expect(fetchingRow(page)).toBeVisible({ timeout: APP_LOAD_MS })
    await expect(fetchingRow(page)).toContainText(`Fetching replies from ${ORIGIN}`)
    await page.evaluate(() => { (window as any).__sameDocument = true })
  })

  await test.step('the replies appear in the thread once the crawl ends', async () => {
    await expect(page.getByText(`${replyText} one`)).toBeVisible({ timeout: APP_LOAD_MS })
    await expect(page.getByText(`${replyText} two`)).toBeVisible()
    await expect(fetchingRow(page)).toBeHidden()
    expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true)
  })

  expect(starts).toHaveLength(1)
  expect(starts[0]).toMatchObject({ post_ap_id: post.apId, post_id: post.id, async: true, force: false })
  expect(statusReads).toBe(2)
})

test('a rate-limited fetch says when to retry, and an unreachable origin says so', async ({ page }) => {
  test.setTimeout(180_000)
  const post = await remotePost(`remote limited ${tag()}`)
  let attempt = 0
  const starts = await scriptFederation(page, {
    replies: async () => {
      attempt += 1
      return attempt === 1
        ? { status: 429, headers: { 'Retry-After': '30' }, body: { error: 'Too Many Requests', retryAfter: 30 } }
        : { body: { success: true, status: 'done', result: crawl({ outcome: 'unavailable', complete: false }) } }
    },
  })

  await signIn(page, reader)
  await page.goto(`/social/post/${post.id}`)
  await expect(statusRow(page)).toContainText('Too many requests. Try again in 30 seconds.', { timeout: APP_LOAD_MS })

  await statusRow(page).getByRole('button', { name: 'Retry' }).click()
  await expect(statusRow(page)).toContainText(`Couldn't reach ${ORIGIN}.`, { timeout: 15000 })
  expect(starts.map((s) => s.force)).toEqual([false, true])
})

test('an origin with no public replies, and one listing more than are held, say so', async ({ page }) => {
  test.setTimeout(180_000)
  const empty = await remotePost(`remote quiet ${tag()}`)
  const busy = await remotePost(`remote busy ${tag()}`)
  await scriptFederation(page, {
    replies: async (body) => ({
      body: body.post_ap_id === empty.apId
        ? { success: true, status: 'done', result: crawl({ found: 0 }), replies_count: 0 }
        : { success: true, status: 'done', result: crawl({ found: 5, stored: 2, truncated: true, complete: false }), replies_count: 2 },
    }),
  })

  await signIn(page, reader)
  await page.goto(`/social/post/${empty.id}`)
  await expect(statusRow(page)).toContainText(`No public replies on ${ORIGIN}`, { timeout: APP_LOAD_MS })

  await page.goto(`/social/post/${busy.id}`)
  await expect(statusRow(page)).toContainText(`Showing 2 of 5 replies. The rest are on ${ORIGIN}.`, { timeout: APP_LOAD_MS })
  await expect(statusRow(page).getByRole('link', { name: `View on ${ORIGIN}` })).toHaveAttribute('href', busy.apId)
})

test('Refresh replies runs once a minute', async ({ page }) => {
  test.setTimeout(180_000)
  const post = await remotePost(`remote refreshed ${tag()}`, 30_000)
  const starts = await scriptFederation(page, {
    replies: async () => ({ body: { success: true, status: 'done', result: crawl({ found: 0 }), replies_count: 0 } }),
  })

  await signIn(page, reader)
  await page.goto(`/social/post/${post.id}`)
  const main = page.locator('.is-main-post [data-testid="post-item"]')
  await expect(main).toBeVisible({ timeout: APP_LOAD_MS })
  expect(starts).toHaveLength(0)

  // The post menu is teleported to the body.
  const refresh = async () => {
    await main.locator('.menu-button').click()
    await page.locator('[data-testid="post-refresh-replies"]').click()
  }

  await refresh()
  await expect(page.getByText(`No public replies on ${ORIGIN}`).first()).toBeVisible({ timeout: 15000 })
  expect(starts).toHaveLength(1)
  expect(starts[0]).toMatchObject({ post_ap_id: post.apId, force: true, async: true })

  await refresh()
  await expect(page.getByText('Replies were fetched a moment ago').first()).toBeVisible({ timeout: 15000 })
  expect(starts).toHaveLength(1)
})

test('a timeline shows the reply count, which opens the post', async ({ page }) => {
  test.setTimeout(180_000)
  const { error } = await admin.from('follows').insert({ follower_id: reader.id, following_id: author.id, status: 'accepted' })
  if (error) throw new Error(`follow: ${error.message}`)
  const text = `remote discussed ${tag()}`
  const post = await remotePost(text, 30_000)
  await storeReplies(post.id, [`held reply ${tag()}`, `held reply ${tag()}`])

  const starts = await scriptFederation(page, {})
  await signIn(page, reader)
  await page.goto('/social/home')
  const item = page.locator('[data-testid="post-item"]').filter({ hasText: text }).first()
  await expect(item).toBeVisible({ timeout: APP_LOAD_MS })

  const count = item.locator('[data-testid="post-reply-count"]')
  await expect(count).toHaveText('2')
  await count.click()

  await page.waitForURL(new RegExp(`/social/post/${post.id}`), { timeout: 15000 })
  await expect(page.getByText('held reply').first()).toBeVisible({ timeout: APP_LOAD_MS })
  await expect(page.locator('.thread-post')).toHaveCount(3)
  expect(starts).toHaveLength(0)
})

test.describe('with the service worker running', () => {
  test.use({ serviceWorkers: 'allow' })

  test('the service worker leaves a slow POST to the API alone and still times out GETs', async ({ page, context }) => {
    test.setTimeout(180_000)
    await context.route('**/api/federation/sw-probe', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6500))
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })

    await page.goto('/login')
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    // A worker installed by this load controls the next one.
    await expect(async () => {
      await page.reload()
      expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
    }).toPass({ timeout: APP_LOAD_MS })

    const post = await page.evaluate(async () => {
      const response = await fetch('/api/federation/sw-probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      return { status: response.status, body: await response.text() }
    })
    expect(post).toEqual({ status: 200, body: '{"ok":true}' })

    const get = await page.evaluate(async () => (await fetch('/api/federation/sw-probe')).status)
    expect(get).toBe(503)
  })
})
