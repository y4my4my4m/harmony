import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// /@<name> and /@<name>/<post id> answer ActivityPub and HTML at one URL: the routers mounted
// in server.ts order (outboxRouter, publicPagesRouter, actorRouter). ActivityPub gets the actor
// and the Note, a browser the public page.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony', VERSION: 'test', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/rateLimit.js', () => {
  const pass = (_req: any, _res: any, next: any) => next()
  return { discoveryLimiter: pass, reactionsLimiter: pass, repliesLimiter: pass, repliesStatusLimiter: pass, publicPageLimiter: pass }
})
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: vi.fn(() => false) },
}))
vi.mock('../activitypub/deletedActors.js', () => ({
  deletedActorByUsername: async () => null,
  deletedActorByProfile: async () => null,
  actorTombstone: () => ({}),
}))
vi.mock('../utils/emojiResolvers.js', async () => {
  const actual = await vi.importActual<any>('../utils/emojiResolvers.js')
  return { ...actual, resolveLocalProfileEmojis: vi.fn(async () => {}) }
})

const POST_ID = '0b0e0000-0000-4000-8000-000000000001'
const ALICE = {
  id: 'a11ce000-0000-4000-8000-000000000001', username: 'alice', display_name: 'Alice', bio: 'Hi',
  avatar_url: null, banner_url: null, domain: 'harmony.test', is_local: true, deleted_at: null,
  federated_id: 'https://harmony.test/users/alice', public_key: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----',
  federation_metadata: {}, profile_fields: [], created_at: '2026-01-01T00:00:00Z',
}
const POST = {
  id: POST_ID, ap_id: null, author_id: ALICE.id, visibility: 'public', is_deleted: false, is_local: true,
  created_at: '2026-10-01T12:00:00Z', content: [{ type: 'text', text: 'hello' }], media_attachments: [], metadata: {},
}

type Row = Record<string, any>
const tables: Record<string, Row[]> = { profiles: [ALICE], posts: [POST] }

function fakeSupabase() {
  return {
    rpc: vi.fn(async (name: string) => {
      if (name === 'public_profile_page') {
        return { data: { enabled: true, instance: { name: 'Harmony' }, account: { ...ALICE, discoverable: true }, pinned: [], posts: [], next: null }, error: null }
      }
      return { data: null, error: null }
    }),
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      const run = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
      const withAuthor = (row: Row | undefined) =>
        row && table === 'posts' ? { ...row, author: tables.profiles.find((p) => p.id === row.author_id) } : row ?? null
      const builder: any = {
        select() { return builder },
        update() { return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        in() { return builder },
        is() { return builder },
        not() { return builder },
        order() { return builder },
        limit() { return builder },
        maybeSingle() { return Promise.resolve({ data: withAuthor(run()[0]), error: null }) },
        single() { return Promise.resolve({ data: withAuthor(run()[0]), error: null }) },
        then(resolve: any) { return resolve({ data: run().map(withAuthor), error: null }) },
      }
      return builder
    },
  }
}
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => fakeSupabase(),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { default: outboxRouter } = await import('../activitypub/OutboxHandler.js')
const { default: publicPagesRouter } = await import('../publicPages/routes.js')
const { default: actorRouter } = await import('../activitypub/ActorService.js')

function app() {
  const a = express()
  a.use('/', outboxRouter)
  a.use('/', publicPagesRouter)
  a.use('/', actorRouter)
  return a
}

const AP = 'application/activity+json'
const HTML = 'text/html,application/xhtml+xml'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('/@:username', () => {
  it('answers ActivityPub with the actor, whose url is this page', async () => {
    const res = await supertest(app()).get('/@alice').set('Accept', AP)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/activity\+json/)
    expect(res.body.id).toBe('https://harmony.test/users/alice')
    expect(res.body.url).toBe('https://harmony.test/@alice')
  })

  it('answers a browser with the public page', async () => {
    const res = await supertest(app()).get('/@alice').set('Accept', HTML)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.text).toContain('data-testid="public-profile"')
  })

  it('answers ActivityPub for an unknown or malformed name 404', async () => {
    expect((await supertest(app()).get('/@nobody').set('Accept', AP)).status).toBe(404)
    expect((await supertest(app()).get('/@bad.name').set('Accept', AP)).status).toBe(404)
  })
})

describe('/@:username/:postId', () => {
  it('answers ActivityPub with the Note, whose url is this page', async () => {
    const res = await supertest(app()).get(`/@alice/${POST_ID}`).set('Accept', AP)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(`https://harmony.test/posts/${POST_ID}`)
    expect(res.body.url).toBe(`https://harmony.test/@alice/${POST_ID}`)
  })

  it('answers ActivityPub under another account or a malformed id 404', async () => {
    expect((await supertest(app()).get(`/@mallory/${POST_ID}`).set('Accept', AP)).status).toBe(404)
    expect((await supertest(app()).get('/@alice/not-a-uuid').set('Accept', AP)).status).toBe(404)
  })

  it('serves the Note at its id /posts/:postId too', async () => {
    const res = await supertest(app()).get(`/posts/${POST_ID}`).set('Accept', AP)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(`https://harmony.test/posts/${POST_ID}`)
  })
})
