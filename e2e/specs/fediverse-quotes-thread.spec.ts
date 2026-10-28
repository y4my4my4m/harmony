// Journeys: remote posts in a thread and a feed, as a Mastodon 4.5 conversation reaches Harmony.
//
// A remote reply that also quotes another post (FEP-044f) reads as the reply with the quoted
// post under it, not as a boost card, and its "RE: <link>" fallback line is gone. A quote
// whose post was never fetched links to it. Replying to a remote post that names the reader
// by actor URL leaves the reader out of the prefill. A feed with more to load keeps its
// Load more button below the last post.
//
// Rows are seeded through the service role, as the federation backend stores them.

import crypto from 'node:crypto'
import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, instanceDomain, signIn, type SpecUser } from './harness'

const admin = adminClient()
let reader: SpecUser
let author: SpecUser
const remote = { id: crypto.randomUUID(), username: `strypey${Date.now().toString(36)}` }
const domain = 'mastodon.e2e.test'
const marker = Date.now().toString(36)
const QUOTED = `https://holos.e2e.test/users/doesnm/statuses/${marker}`
const MISSING = `https://gone.e2e.test/notes/${marker}`

let rootId = ''
let mentionPostId = ''

const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()

async function insertPosts(rows: Record<string, unknown>[]): Promise<string[]> {
  const { data, error } = await admin.from('posts').insert(rows).select('id')
  if (error) throw new Error(`posts: ${error.message}`)
  return (data ?? []).map((r) => r.id as string)
}

test.beforeAll(async () => {
  reader = await createUser(admin, 'qtr')
  author = await createUser(admin, 'qta')
  const host = await instanceDomain(admin)

  const { error: profileError } = await admin.from('profiles').insert({
    id: remote.id,
    username: remote.username,
    display_name: 'Strypey',
    domain,
    is_local: false,
    federated_id: `https://${domain}/users/${remote.username}`,
    inbox_url: `https://${domain}/users/${remote.username}/inbox`,
  })
  if (profileError) throw new Error(`remote profile: ${profileError.message}`)

  ;[rootId] = await insertPosts([{
    author_id: reader.id, visibility: 'public', is_local: true, created_at: at(600),
    content: [{ type: 'text', text: `root ${marker}` }],
  }])

  const remotePost = (slug: string, secondsAgo: number, fields: Record<string, unknown>) => ({
    author_id: remote.id,
    visibility: 'unlisted',
    is_local: false,
    ap_id: `https://${domain}/users/${remote.username}/statuses/${slug}-${marker}`,
    created_at: at(secondsAgo),
    in_reply_to: rootId,
    conversation_root_id: rootId,
    ...fields,
  })
  ;[, , mentionPostId] = await insertPosts([
    remotePost('quote', 300, {
      content: [
        { type: 'text', text: 'RE: ' },
        { type: 'url', url: QUOTED },
        { type: 'text', text: ` \nreply with a quote ${marker}` },
      ],
      metadata: { is_quote: true, quote_ap_url: QUOTED, reblog_of: crypto.randomUUID() },
      reblog: { id: crypto.randomUUID(), content: [{ type: 'text', text: `the quoted words ${marker}` }], created_at: at(9000), visibility: 'public' },
      reblog_author: { id: crypto.randomUUID(), username: 'doesnm', display_name: 'doesnm', domain: 'holos.e2e.test', is_local: false },
    }),
    remotePost('missing', 200, {
      content: [{ type: 'text', text: `quote of a post never fetched ${marker}` }],
      metadata: { is_quote: true, quote_ap_url: MISSING },
    }),
    remotePost('mention', 100, {
      in_reply_to: null,
      conversation_root_id: null,
      visibility: 'public',
      content: [
        { type: 'mention', userId: `https://${host}/users/${reader.username}`, username: reader.username, domain: host, isLocal: true },
        { type: 'text', text: ` naming you ${marker}` },
      ],
    }),
  ])
})

test.afterAll(async () => {
  await admin.from('posts').delete().in('author_id', [reader?.id, author?.id, remote.id].filter(Boolean))
  await admin.from('profiles').delete().eq('id', remote.id)
  await deleteUser(admin, reader)
  await deleteUser(admin, author)
})

test('a remote reply that quotes a post reads as the reply with the quote under it', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)
  await page.goto(`/social/post/${rootId}`)
  await expect(page.locator('article[aria-current="true"]')).toBeVisible({ timeout: 90_000 })

  const quoting = page.locator('article').filter({ hasText: `reply with a quote ${marker}` })
  await expect(quoting).toBeVisible({ timeout: 30_000 })
  await expect(quoting.locator('.quoted-post')).toContainText(`the quoted words ${marker}`)
  await expect(quoting.locator('.quote-comment')).not.toContainText('RE:')
  await expect(page.getByText('Boosted from another instance')).toHaveCount(0)

  const unfetched = page.locator('article').filter({ hasText: `quote of a post never fetched ${marker}` })
  await expect(unfetched.getByRole('link', { name: 'View quoted post' })).toHaveAttribute('href', MISSING)
})

test('replying to a remote post that names the reader leaves the reader out', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)
  await page.goto(`/social/post/${mentionPostId}`)
  const post = page.locator('article[aria-current="true"]')
  await expect(post).toBeVisible({ timeout: 90_000 })

  await post.getByRole('button', { name: /^Reply to / }).first().click()
  const editor = page.locator('[data-testid="compose-post"] .rich-text-editor').last()
  await expect(editor).toBeFocused({ timeout: 15000 })
  await expect
    .poll(async () => (await editor.innerText()).replace(/\u00a0/g, ' '))
    .toBe(`@${remote.username}@${domain} `)
})

test('Load more sits below the last post of a feed with more to load', async ({ page }) => {
  test.setTimeout(180_000)
  const { error: followError } = await admin
    .from('follows')
    .insert({ follower_id: reader.id, following_id: author.id, status: 'accepted' })
  if (followError) throw new Error(`follow: ${followError.message}`)
  await insertPosts(Array.from({ length: 25 }, (_, i) => ({
    author_id: author.id, visibility: 'public', is_local: true, created_at: at(1000 + i * 60),
    content: [{ type: 'text', text: `feed post ${i + 1} ${marker}` }],
  })))

  await page.setViewportSize({ width: 1280, height: 720 })
  await signIn(page, reader)
  await page.goto('/social/home')
  const footer = page.getByTestId('feed-footer')
  await expect(page.getByTestId('feed-load-more')).toBeVisible({ timeout: 90_000 })
  const layout = await footer.evaluate((el) => {
    const list = el.parentElement!.querySelector('.posts-list') as HTMLElement
    return { footerTop: el.offsetTop, listBottom: list.offsetTop + parseFloat(list.style.height), viewport: el.parentElement!.clientHeight }
  })
  expect(layout.listBottom).toBeGreaterThan(layout.viewport)
  expect(layout.footerTop).toBeGreaterThanOrEqual(layout.listBottom - 1)
})
