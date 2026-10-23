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
const REMOTE_AUTHOR = { id: 'strypey', username: 'strypey', domain: 'mastodon.test', is_local: false, federated_id: 'https://mastodon.test/users/strypey' }
const REMOTE_POSTS: Record<string, any> = {
  'p-remote': { visibility: 'public', ap_id: 'https://mastodon.test/users/strypey/statuses/1', author: REMOTE_AUTHOR },
}
let listRows: any[] = []
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
/** get_post_emoji_reactions rows by post id. */
const REACTIONS: Record<string, any[]> = {
  'p-public': [
    { emoji_id: null, emoji_name: null, emoji_url: null, custom_emoji_content: '🔥', reaction_count: 2 },
    { emoji_id: 'e1', emoji_name: 'blobcat', emoji_url: 'https://harmony.test/emojis/blobcat.png', custom_emoji_content: null, reaction_count: 1 },
    { emoji_id: null, emoji_name: null, emoji_url: 'https://misskey.test/emoji/neko.webp', custom_emoji_content: ':neko@misskey.test:', reaction_count: 4 },
    { emoji_id: null, emoji_name: null, emoji_url: null, custom_emoji_content: '❤️', reaction_count: 3 },
  ],
}
const rpc = vi.fn(async (name: string, args: any) => {
  if (name === 'get_post_emoji_reactions') return { data: REACTIONS[args.p_post_id] ?? [], error: null }
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
      data: table === 'posts' && id && (POSTS[id] || REMOTE_POSTS[id])
        ? { id, ap_id: null, author_id: 'author', created_at: '2026-01-01T00:00:00Z', content: [{ type: 'text', text: id }],
            media_attachments: [], author: AUTHOR, ...POSTS[id], ...REMOTE_POSTS[id] }
        : null,
      error: null,
    }),
    then: (resolve: any) => resolve({ data: listRows, count: listRows.length, error: null }),
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
  listRows = []
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

  it('carries its reaction counts, image emojis by Emoji tag and hearts left to the likes', async () => {
    const res = await ap('/posts/p-public')
    expect(res.body['harmony:reactions']).toEqual([
      { content: '🔥', count: 2 },
      { content: ':blobcat:', count: 1, tag: { type: 'Emoji', name: ':blobcat:', icon: { type: 'Image', url: 'https://harmony.test/emojis/blobcat.png' } } },
      { content: ':neko:', count: 4, tag: { type: 'Emoji', name: ':neko:', icon: { type: 'Image', url: 'https://misskey.test/emoji/neko.webp' } } },
    ])
    expect(res.body['@context'][1].harmony).toBe('https://mony.lol/ns#')
    expect((await ap('/posts/p-unlisted')).body['harmony:reactions']).toEqual([])
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

describe('shares collection', () => {
  it.each(cells)('$postId shares for $caller', async ({ postId, caller, url }) => {
    signer.url = url
    const res = await ap(`/posts/${postId}/shares`)
    expect(res.status).toBe(expected[postId][caller])
    if (res.status === 200) expect(res.body).toMatchObject({ type: 'OrderedCollection', totalItems: 0 })
  })
})

describe('objects this instance does not own', () => {
  it('sends a remote post to its origin instead of serving it under a local author', async () => {
    const res = await ap('/posts/p-remote')
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://mastodon.test/users/strypey/statuses/1')
    expect(res.headers.vary).toMatch(/Accept/)
  })

  it('lists replies by id, never as Notes re-attributed to this host', async () => {
    listRows = [
      { id: 'r1', ap_id: 'https://mastodon.test/users/strypey/statuses/2' },
      { id: 'r2', ap_id: null },
    ]
    const res = await ap('/posts/p-public/replies?page=1')
    expect(res.body.orderedItems).toEqual([
      'https://mastodon.test/users/strypey/statuses/2',
      'https://harmony.test/posts/r2',
    ])
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
