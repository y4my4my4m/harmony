import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// FEP-7888: a local post's Note carries `context`, the OrderedCollection of its thread at
// /posts/<root>/context; a reply in a thread rooted at a remote post carries the context that
// root named; an inbound Note's context is kept on the post.

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
const signer = vi.hoisted(() => ({ actor: null as string | null }))
vi.mock('../activitypub/groupAccess.js', async () => {
  const actual = await vi.importActual<any>('../activitypub/groupAccess.js')
  return { ...actual, verifiedSigner: async () => signer.actor }
})

const rows: Record<string, any[]> = {}

/** The `or` filter the context route builds: the root, or a public reply in its thread. */
function threadFilter(expr: string): (row: any) => boolean {
  const m = /^id\.eq\.([0-9a-f-]+),and\(conversation_root_id\.eq\.([0-9a-f-]+),visibility\.in\.\(([^)]*)\)\)$/.exec(expr)
  if (!m) throw new Error(`unexpected or(): ${expr}`)
  const visibilities = m[3].split(',')
  return (row) => row.id === m[1] || (row.conversation_root_id === m[2] && visibilities.includes(row.visibility))
}

function query(table: string) {
  const filters: Array<(row: any) => boolean> = []
  let head = false
  let range: [number, number] | null = null
  const all = () => (rows[table] ?? []).filter((r) => filters.every((f) => f(r)))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
  const q: any = {
    select: (_cols?: string, opts?: { head?: boolean }) => { head = !!opts?.head; return q },
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
    is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
    or: (expr: string) => (filters.push(threadFilter(expr)), q),
    order: () => q,
    limit: () => q,
    range: (from: number, to: number) => { range = [from, to]; return q },
    maybeSingle: async () => ({ data: all()[0] ?? null, error: null }),
    single: async () => ({ data: all()[0] ?? null, error: null }),
    then: (resolve: any) => {
      const data = all()
      return resolve({ data: head ? null : range ? data.slice(range[0], range[1] + 1) : data, count: data.length, error: null })
    },
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from: (t: string) => query(t), rpc: async () => ({ data: false, error: null }) }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { postToNote, threadContextUrl } = await import('../activitypub/converters/toActivityPub.js')
const { buildLocalNote } = await import('../listeners/FederationHandlers.js')
const { noteContext } = await import('../activitypub/converters/fromActivityPub.js')
const { default: outboxRouter } = await import('../activitypub/OutboxHandler.js')

const ROOT = 'f0220000-0000-0000-0000-000000000001'
const REMOTE_ROOT = 'f0220000-0000-0000-0000-000000000002'
const ALICE = { id: 'alice-id', username: 'alice', domain: 'harmony.test', is_local: true, federated_id: 'https://harmony.test/users/alice' }
const at = (n: number) => `2026-10-01T00:00:${String(n).padStart(2, '0')}Z`
const post = (id: string, extra: Record<string, unknown> = {}) => ({
  id, ap_id: null, author_id: ALICE.id, author: ALICE, is_local: true, is_deleted: false, visibility: 'public',
  conversation_root_id: null, in_reply_to: null, created_at: at(0), content: [{ type: 'text', text: 'hi' }],
  media_attachments: [], metadata: {}, ...extra,
})
const reply = (n: number, extra: Record<string, unknown> = {}) =>
  post(`f0220000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`, { conversation_root_id: ROOT, in_reply_to: ROOT, created_at: at(n), ...extra })

beforeEach(() => {
  signer.actor = null
  rows.profiles = [ALICE]
  rows.posts = [post(ROOT)]
})

const ap = (path: string) => supertest(express().use('/', outboxRouter)).get(path).set('Accept', 'application/activity+json')

describe('Note context', () => {
  it('names the thread of a root post and of a reply by its root', () => {
    expect(postToNote(post(ROOT), ALICE).context).toBe(`https://harmony.test/posts/${ROOT}/context`)
    expect(postToNote(reply(1), ALICE).context).toBe(threadContextUrl(ROOT))
    expect(postToNote(post(ROOT, { visibility: 'followers' }), ALICE).context).toBe(threadContextUrl(ROOT))
  })

  it('is absent from a direct post', () => {
    expect(postToNote(post(ROOT, { visibility: 'direct' }), ALICE).context).toBeUndefined()
  })

  it('carries the context a remote root named', async () => {
    rows.posts.push(post(REMOTE_ROOT, { is_local: false, metadata: { ap_context: 'https://mastodon.test/contexts/42' } }))
    const note = await buildLocalNote(reply(1, { conversation_root_id: REMOTE_ROOT, in_reply_to: REMOTE_ROOT }), ALICE)
    expect(note.context).toBe('https://mastodon.test/contexts/42')
  })

  it('names this instance\'s collection for a remote root that named none', async () => {
    rows.posts.push(post(REMOTE_ROOT, { is_local: false, metadata: {} }))
    const note = await buildLocalNote(reply(1, { conversation_root_id: REMOTE_ROOT, in_reply_to: REMOTE_ROOT }), ALICE)
    expect(note.context).toBe(threadContextUrl(REMOTE_ROOT))
  })

  it('is kept from an inbound Note, as a reference or an embedded collection', () => {
    expect(noteContext({ context: 'https://m.test/contexts/1' })).toBe('https://m.test/contexts/1')
    expect(noteContext({ context: { id: 'https://m.test/contexts/2', type: 'OrderedCollection' } })).toBe('https://m.test/contexts/2')
    expect(noteContext({ context: 'tag:m.test,2026:objectId=1' })).toBeNull()
    expect(noteContext({})).toBeNull()
  })
})

describe('GET /posts/:id/context', () => {
  it('is an OrderedCollection owned by the root\'s author, counting the root and its public replies', async () => {
    rows.posts.push(reply(1), reply(2, { visibility: 'unlisted' }), reply(3, { visibility: 'followers' }), reply(4, { is_deleted: true }))
    const res = await ap(`/posts/${ROOT}/context`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/activity+json')
    expect(res.body).toEqual({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: threadContextUrl(ROOT),
      type: 'OrderedCollection',
      attributedTo: ALICE.federated_id,
      totalItems: 3,
      first: `${threadContextUrl(ROOT)}?page=1`,
    })
  })

  it('pages the thread oldest first, 20 to a page, as ids', async () => {
    for (let n = 1; n <= 24; n++) rows.posts.push(reply(n, n === 5 ? { ap_id: 'https://harmony.test/posts/custom' } : {}))
    const first = await ap(`/posts/${ROOT}/context?page=1`)
    expect(first.body).toMatchObject({ type: 'OrderedCollectionPage', partOf: threadContextUrl(ROOT), totalItems: 25, next: `${threadContextUrl(ROOT)}?page=2` })
    expect(first.body.orderedItems).toHaveLength(20)
    expect(first.body.orderedItems[0]).toBe(`https://harmony.test/posts/${ROOT}`)
    expect(first.body.orderedItems[5]).toBe('https://harmony.test/posts/custom')

    const second = await ap(`/posts/${ROOT}/context?page=2`)
    expect(second.body.orderedItems).toHaveLength(5)
    expect(second.body.next).toBeUndefined()
    expect(second.body.prev).toBe(`${threadContextUrl(ROOT)}?page=1`)
  })

  it('is 404 for a reply, a deleted root, an unknown id and a root the request may not read', async () => {
    rows.posts.push(reply(1))
    rows.posts.push(post('f0220000-0000-0000-0000-000000000003', { is_deleted: true }))
    rows.posts.push(post('f0220000-0000-0000-0000-000000000004', { visibility: 'followers' }))
    for (const id of [reply(1).id, 'f0220000-0000-0000-0000-000000000003', 'f0220000-0000-0000-0000-0000000000ff', 'f0220000-0000-0000-0000-000000000004', 'not-a-uuid']) {
      expect((await ap(`/posts/${id}/context`)).status).toBe(404)
    }
  })
})
