import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// Post objects by visibility: /posts/:id, its likes and replies collections, the outbox.
// public.federation_post_access is emulated: remote.test follows the author, other.test
// is the direct post's recipient. Its SQL is covered by db_schema/tests/71_private_user_media.sql.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony' },
  config: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../activitypub/postPageRenderer.js', () => ({
  renderPostPage: () => '<html>post</html>',
  renderOEmbed: () => ({}),
}))

const AUTHOR = { id: 'author', username: 'alice', display_name: 'Alice', domain: 'harmony.test', is_local: true }
const POSTS: Record<string, any> = {
  'p-public': { visibility: 'public' },
  'p-unlisted': { visibility: 'unlisted' },
  'p-followers': { visibility: 'followers' },
  'p-direct': { visibility: 'direct' },
}
const READERS: Record<string, string[]> = {
  'p-followers': ['remote.test'],
  'p-direct': ['other.test'],
}

const filters: Array<{ table: string; column: string; values: unknown }> = []
const rpc = vi.fn(async (name: string, args: any) => {
  if (name !== 'federation_post_access') return { data: null, error: { message: `unexpected ${name}` } }
  const post = POSTS[args.p_post_id]
  if (!post) return { data: false, error: null }
  if (post.visibility === 'public' || post.visibility === 'unlisted') return { data: true, error: null }
  return { data: (READERS[args.p_post_id] ?? []).includes(args.p_domain), error: null }
})

function query(table: string) {
  let id: string | undefined
  const q: any = {
    select: () => q,
    eq: (col: string, val: string) => { if (col === 'id') id = val; return q },
    in: (column: string, values: unknown) => { filters.push({ table, column, values }); return q },
    not: () => q,
    is: () => q,
    lt: () => q,
    gte: () => q,
    lte: () => q,
    order: () => q,
    limit: () => q,
    range: () => q,
    single: () => Promise.resolve(table === 'profiles'
      ? { data: AUTHOR, error: null }
      : { data: null, error: null }),
    maybeSingle: () => Promise.resolve({
      data: table === 'posts' && id && POSTS[id]
        ? { id, ap_id: null, author_id: 'author', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: id }],
            media_attachments: [], author: AUTHOR, ...POSTS[id] }
        : null,
      error: null,
    }),
    then: (resolve: any) => resolve({ data: [], count: 0, error: null }),
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ rpc: (n: string, a: any) => rpc(n, a), from: (t: string) => query(t) }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const signer = { url: null as string | null }
vi.mock('../activitypub/groupAccess.js', async () => {
  const actual = await vi.importActual<any>('../activitypub/groupAccess.js')
  return { ...actual, verifiedSigner: async () => signer.url }
})

const { default: outboxRouter } = await import('../activitypub/OutboxHandler.js')

function app() {
  const a = express()
  a.use('/', outboxRouter)
  return a
}
const ap = (path: string) => supertest(app()).get(path).set('Accept', 'application/activity+json')

beforeEach(() => {
  rpc.mockClear()
  filters.length = 0
  signer.url = null
})

const callers: Array<[string, string | null]> = [
  ['unsigned', null],
  ['a follower instance', 'https://remote.test/users/rm'],
  ['the recipient instance', 'https://other.test/actor'],
  ['a stranger instance', 'https://stranger.test/users/x'],
]
const expected: Record<string, Record<string, number>> = {
  'p-public': { unsigned: 200, 'a follower instance': 200, 'the recipient instance': 200, 'a stranger instance': 200 },
  'p-unlisted': { unsigned: 200, 'a follower instance': 200, 'the recipient instance': 200, 'a stranger instance': 200 },
  'p-followers': { unsigned: 404, 'a follower instance': 200, 'the recipient instance': 404, 'a stranger instance': 404 },
  'p-direct': { unsigned: 404, 'a follower instance': 404, 'the recipient instance': 200, 'a stranger instance': 404 },
}
const cells = Object.keys(POSTS).flatMap((postId) => callers.map(([caller, url]) => ({ postId, caller, url })))

describe('GET /posts/:id as ActivityPub', () => {
  it.each(cells)('$postId for $caller', async ({ postId, caller, url }) => {
    signer.url = url
    const res = await ap(`/posts/${postId}`)
    expect(res.status).toBe(expected[postId][caller])
    if (res.status === 404) {
      expect(res.body).toEqual({ error: 'Post not found' })
      return
    }
    expect(res.body.id).toBe(`https://harmony.test/posts/${postId}`)
    expect(res.headers['cache-control']).toBe(
      POSTS[postId].visibility === 'public' || POSTS[postId].visibility === 'unlisted'
        ? 'public, max-age=300'
        : 'private, no-store')
  })

  it('answers a non-public post exactly as an unknown id', async () => {
    const hidden = await ap('/posts/p-direct')
    const unknown = await ap('/posts/p-missing')
    expect([hidden.status, hidden.body]).toEqual([unknown.status, unknown.body])
  })

  it('serves no HTML page for a non-public post, signed or not', async () => {
    signer.url = 'https://remote.test/users/rm'
    const res = await supertest(app()).get('/posts/p-followers').set('Accept', 'text/html')
    expect(res.status).toBe(404)
  })
})

describe('likes and replies collections', () => {
  it.each(cells)('$postId likes for $caller', async ({ postId, caller, url }) => {
    signer.url = url
    const res = await ap(`/posts/${postId}/likes`)
    expect(res.status).toBe(expected[postId][caller])
  })

  it.each(cells)('$postId replies for $caller', async ({ postId, caller, url }) => {
    signer.url = url
    const res = await ap(`/posts/${postId}/replies?page=1`)
    expect(res.status).toBe(expected[postId][caller])
    if (res.status === 200) {
      expect(filters).toContainEqual({ table: 'posts', column: 'visibility', values: ['public', 'unlisted'] })
    }
  })
})

describe('GET /users/:username/outbox', () => {
  it('counts and lists public and unlisted posts only', async () => {
    const meta = await ap('/users/alice/outbox')
    expect(meta.status).toBe(200)
    const page = await ap('/users/alice/outbox?cursor=start')
    expect(page.status).toBe(200)
    const visibilityFilters = filters.filter((f) => f.table === 'posts' && f.column === 'visibility')
    expect(visibilityFilters).toEqual([
      { table: 'posts', column: 'visibility', values: ['public', 'unlisted'] },
      { table: 'posts', column: 'visibility', values: ['public', 'unlisted'] },
    ])
  })
})
