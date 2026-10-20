import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// WebFinger by handle and by actor or profile URL; a deleted post's Tombstone; the Create and
// Announce activities served at the ids their deliveries and the outbox carry.

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
vi.mock('../activitypub/deletedActors.js', () => ({
  deletedActorByUsername: async (name: string) => (name === 'gone' ? { actor_uri: 'https://harmony.test/users/gone' } : null),
}))
vi.mock('../activitypub/groupAccess.js', async () => {
  const actual = await vi.importActual<any>('../activitypub/groupAccess.js')
  return { ...actual, verifiedSigner: async () => null }
})

const SERVER = 'f0170000-0000-0000-0000-000000000001'
const ALICE = { id: 'alice-id', username: 'alice', display_name: 'Alice', domain: 'harmony.test', is_local: true }
const rows: Record<string, any[]> = {}

function matches(row: any, f: Array<[string, string, unknown]>): boolean {
  return f.every(([op, col, val]) => {
    const v = col.split('->').reduce((o, k) => o?.[k], row)
    if (op === 'eq') return v === val
    if (op === 'ilike') return String(v ?? '').toLowerCase() === String(val).replace(/\\_/g, '_').toLowerCase()
    if (op === 'is') return (v ?? null) === val
    if (op === 'in') return (val as unknown[]).includes(v)
    return true
  })
}

function query(table: string) {
  const f: Array<[string, string, unknown]> = []
  const rowsOf = () => (rows[table] ?? []).filter((r) => matches(r, f))
  const q: any = {
    select: () => q,
    eq: (c: string, v: unknown) => (f.push(['eq', c, v]), q),
    ilike: (c: string, v: unknown) => (f.push(['ilike', c, v]), q),
    is: (c: string, v: unknown) => (f.push(['is', c, v]), q),
    in: (c: string, v: unknown) => (f.push(['in', c, v]), q),
    not: () => q,
    order: () => q,
    limit: () => q,
    range: () => q,
    lt: () => q,
    maybeSingle: async () => ({ data: rowsOf()[0] ?? null, error: null }),
    single: async () => ({ data: rowsOf()[0] ?? null, error: null }),
    then: (resolve: any) => resolve({ data: rowsOf(), error: null }),
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (t: string) => query(t),
    rpc: async () => ({ data: true, error: null }),
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: p } }) }) },
  }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { default: webfingerRouter } = await import('../activitypub/WebFingerService.js')
const { default: outboxRouter } = await import('../activitypub/OutboxHandler.js')
const { createPostActivity } = await import('../listeners/FederationHandlers.js')

function app() {
  const a = express()
  a.use('/', webfingerRouter)
  a.use('/', outboxRouter)
  return a
}
const finger = (resource: string) => supertest(app()).get('/.well-known/webfinger').query({ resource })
const ap = (path: string) => supertest(app()).get(path).set('Accept', 'application/activity+json')

const post = (id: string, extra: Record<string, unknown> = {}) => ({
  id, ap_id: `https://harmony.test/posts/${id}`, author_id: ALICE.id, is_local: true, is_deleted: false,
  visibility: 'public', created_at: '2026-10-01T00:00:00Z', content: [{ type: 'text', text: 'hi' }],
  media_attachments: [], metadata: {}, author: ALICE, ...extra,
})
const ORIGINAL = 'f0170000-0000-0000-0000-0000000000a1'
const BOOST = 'f0170000-0000-0000-0000-0000000000a2'
const FOLLOWERS_ONLY = 'f0170000-0000-0000-0000-0000000000a3'
const DELETED = 'f0170000-0000-0000-0000-0000000000a4'

beforeEach(() => {
  rows.profiles = [{ ...ALICE, deleted_at: null }]
  rows.servers = [{ id: SERVER, slug: 'lounge', is_local_server: true, federation_enabled: true, public: true }]
  rows.posts = [
    post(ORIGINAL),
    post(BOOST, { ap_id: `https://harmony.test/activities/${BOOST}`, metadata: { reblog_of: ORIGINAL }, content: [] }),
    post(FOLLOWERS_ONLY, { visibility: 'followers' }),
    post(DELETED, { is_deleted: true, deleted_at: '2026-10-02T03:04:05Z' }),
  ]
})

describe('WebFinger', () => {
  const profileLink = {
    rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: 'https://harmony.test/social/profile/alice',
  }

  it('lists the profile page among the aliases and links of an account', async () => {
    const res = await finger('acct:alice@harmony.test')
    expect(res.status).toBe(200)
    expect(res.body.subject).toBe('acct:alice@harmony.test')
    expect(res.body.aliases).toEqual(['https://harmony.test/users/alice', 'https://harmony.test/social/profile/alice'])
    expect(res.body.links).toContainEqual(profileLink)
  })

  it.each(['https://harmony.test/users/alice', 'https://harmony.test/social/profile/alice', 'https://harmony.test/users/alice/'])(
    'resolves the account by its URL %s', async (resource) => {
      const res = await finger(resource)
      expect(res.status).toBe(200)
      expect(res.body.subject).toBe('acct:alice@harmony.test')
      expect(res.body.links[0]).toMatchObject({ rel: 'self', href: 'https://harmony.test/users/alice' })
      expect(res.body.links.filter((l: any) => l.properties?.['https://www.w3.org/ns/activitystreams#type'] === 'Group')).toEqual([])
    })

  it('resolves a public chat server by its Group URL', async () => {
    const res = await finger(`https://harmony.test/servers/${SERVER}`)
    expect(res.status).toBe(200)
    expect(res.body.subject).toBe('acct:lounge@harmony.test')
    expect(res.body.links).toEqual([{
      rel: 'self', type: 'application/activity+json', href: `https://harmony.test/servers/${SERVER}`,
      properties: { 'https://www.w3.org/ns/activitystreams#type': 'Group' },
    }])
  })

  it('answers the instance actor by its URL', async () => {
    const res = await finger('https://harmony.test/users/instance.actor')
    expect(res.body.subject).toBe('acct:instance.actor@harmony.test')
  })

  it('answers 404 for another domain or path, 400 for a malformed resource, 410 for a deleted account', async () => {
    expect((await finger('https://elsewhere.test/users/alice')).status).toBe(404)
    expect((await finger('https://harmony.test/posts/1')).status).toBe(404)
    expect((await finger('https://harmony.test/users/nobody')).status).toBe(404)
    expect((await finger('https://harmony.test/users/a%25b')).status).toBe(404)
    expect((await finger('not a resource')).status).toBe(400)
    expect((await finger('ftp://harmony.test/users/alice')).status).toBe(400)
    expect((await finger('https://harmony.test/users/gone')).status).toBe(410)
  })
})

describe('deleted post', () => {
  it('answers 410 with a Tombstone that has a context, formerType and deleted', async () => {
    const res = await ap(`/posts/${DELETED}`)
    expect(res.status).toBe(410)
    expect(res.headers['content-type']).toMatch(/application\/activity\+json/)
    expect(res.body).toEqual({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `https://harmony.test/posts/${DELETED}`,
      type: 'Tombstone',
      formerType: 'Note',
      deleted: '2026-10-02T03:04:05.000Z',
    })
  })
})

describe('activity ids', () => {
  it('serve the Create a delivery carries, under the same id', async () => {
    const delivered = await createPostActivity(post(ORIGINAL), ALICE)
    expect(delivered.id).toBe(`https://harmony.test/users/alice/activities/${ORIGINAL}`)
    const res = await ap(`/users/alice/activities/${ORIGINAL}`)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(delivered.id)
    expect(res.body.type).toBe('Create')
    expect(res.body.object.id).toBe(`https://harmony.test/posts/${ORIGINAL}`)
  })

  it('serve the Announce of a boost', async () => {
    const res = await ap(`/activities/${BOOST}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: `https://harmony.test/activities/${BOOST}`, type: 'Announce', object: `https://harmony.test/posts/${ORIGINAL}` })
  })

  it('answer 404 for another author, a boost as a Create, a non-public or deleted post', async () => {
    expect((await ap(`/users/bob/activities/${ORIGINAL}`)).status).toBe(404)
    expect((await ap(`/users/alice/activities/${BOOST}`)).status).toBe(404)
    expect((await ap(`/activities/${ORIGINAL}`)).status).toBe(404)
    expect((await ap(`/users/alice/activities/${FOLLOWERS_ONLY}`)).status).toBe(404)
    expect((await ap(`/users/alice/activities/${DELETED}`)).status).toBe(404)
    expect((await ap('/users/alice/activities/not-a-uuid')).status).toBe(404)
  })

  it('the outbox lists each Create under the id deliveries carry', async () => {
    const res = await ap('/users/alice/outbox?page=1')
    const create = res.body.orderedItems.find((i: any) => i.type === 'Create')
    expect(create.id).toBe(`https://harmony.test/users/alice/activities/${ORIGINAL}`)
    const announce = res.body.orderedItems.find((i: any) => i.type === 'Announce')
    expect(announce.id).toBe(`https://harmony.test/activities/${BOOST}`)
  })
})
