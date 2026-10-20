import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'
import express from 'express'
import supertest from 'supertest'

// OStatus remote follow: every local account's WebFinger carries the
// http://ostatus.org/schema/1.0/subscribe template of /authorize_interaction, and
// /lookup-user resolves the actor a URL names, which that page offers to follow.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', VERSION: 'test', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(),
  validateExternalHostname: vi.fn(),
  validateExternalUrl: vi.fn((url: string) => {
    if (new URL(url).hostname === '127.0.0.1') throw new Error('internal')
  }),
}))
vi.mock('../middleware/rateLimit.js', () => {
  const pass = (_req: any, _res: any, next: any) => next()
  return { discoveryLimiter: pass, reactionsLimiter: pass, repliesLimiter: pass, repliesStatusLimiter: pass }
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
const instanceKey = vi.hoisted(() => ({ privateKey: '' }))
vi.mock('../activitypub/InstanceActor.js', () => ({
  INSTANCE_ACTOR_USERNAME: 'instance.actor',
  instanceActorUrl: () => 'https://harmony.test/users/instance.actor',
  isInstanceActorUsername: (name: string) => name === 'instance.actor',
  signAsInstanceActor: vi.fn(async (url: string, method: string, body: unknown) => {
    const { SignatureService } = await import('../activitypub/SignatureService.js')
    return SignatureService.signWithKey(url, method, body, 'https://harmony.test/users/instance.actor#main-key', instanceKey.privateKey)
  }),
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let nextId = 1

function fakeSupabase() {
  return {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      const run = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
      const builder: any = {
        select() { return builder },
        upsert(row: Row, opts?: { onConflict?: string }) {
          const key = opts?.onConflict ?? 'id'
          const rows = (tables[table] ??= [])
          let stored = rows.find((r) => r[key] === row[key])
          if (stored) Object.assign(stored, row)
          else rows.push(stored = { id: `row-${nextId++}`, ...row })
          const result = { data: stored, error: null }
          return { select: () => ({ single: () => Promise.resolve(result) }), then: (resolve: any) => resolve(result) }
        },
        update() { return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        is(col: string, val: any) { filters.push((row) => (row[col] ?? null) === val); return builder },
        ilike(col: string, pattern: string) {
          const re = new RegExp(`^${pattern.replace(/\\_/g, '_').split('%').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
          filters.push((row) => re.test(String(row[col] ?? '')))
          return builder
        },
        limit() { return builder },
        order() { return builder },
        maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }) },
        single() { return Promise.resolve({ data: run()[0] ?? null, error: null }) },
        then(resolve: any) { return resolve({ data: run(), error: null }) },
      }
      return builder
    },
  }
}
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => fakeSupabase(),
  getSupabaseClientWithAuth: () => fakeSupabase(),
}))

const { safeFetch } = await import('../utils/ssrfProtection.js')
const { default: webfingerRouter, SUBSCRIBE_REL } = await import('../activitypub/WebFingerService.js')
const actorRouter = (await import('../activitypub/ActorService.js')).default

const pair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const COMMUNITY = 'https://lemmy.test/c/tech'
const POST = 'https://lemmy.test/post/7'
const OTHER = 'https://lemmy.test/c/other'
const ap = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/activity+json' } })
const groupDoc = {
  '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
  id: COMMUNITY,
  type: 'Group',
  preferredUsername: 'tech',
  name: 'Technology',
  inbox: `${COMMUNITY}/inbox`,
  followers: `${COMMUNITY}/followers`,
  endpoints: { sharedInbox: 'https://lemmy.test/inbox' },
  publicKey: { id: `${COMMUNITY}#main-key`, owner: COMMUNITY, publicKeyPem: 'TECH-KEY' },
}
let fetched: string[]

function remote(webfingerHref = COMMUNITY) {
  vi.mocked(safeFetch).mockImplementation(async (url: string) => {
    fetched.push(url)
    if (url === COMMUNITY) return ap(groupDoc)
    if (url === OTHER) return ap({ ...groupDoc, id: OTHER, inbox: `${OTHER}/inbox`, publicKey: { ...groupDoc.publicKey, id: `${OTHER}#main-key`, owner: OTHER } })
    if (url === POST) return ap({ id: POST, type: 'Page', attributedTo: 'https://lemmy.test/u/ann', name: 'A post' })
    if (url === `https://lemmy.test/.well-known/webfinger?resource=${encodeURIComponent('acct:tech@lemmy.test')}`) {
      return new Response(JSON.stringify({
        subject: 'acct:tech@lemmy.test',
        links: [{ rel: 'self', type: 'application/activity+json', href: webfingerHref }],
      }), { status: 200, headers: { 'content-type': 'application/jrd+json' } })
    }
    return new Response('', { status: 404 })
  })
}

function app() {
  const a = express()
  a.use(express.json())
  a.use(webfingerRouter)
  a.use(actorRouter)
  return a
}
const finger = (resource: string) => supertest(app()).get('/.well-known/webfinger').query({ resource })
const lookupUrl = (url: string) => supertest(app()).post('/lookup-user').send({ url })

beforeEach(() => {
  nextId = 1
  fetched = []
  instanceKey.privateKey = pair.privateKey
  tables = {
    profiles: [{ id: 'alice-id', username: 'alice', domain: 'harmony.test', is_local: true, deleted_at: null }],
    servers: [{ id: 'f0200000-0000-0000-0000-000000000001', slug: 'lounge', is_local_server: true, federation_enabled: true, public: true }],
  }
  vi.mocked(safeFetch).mockReset()
  remote()
})

describe('WebFinger subscribe template', () => {
  const subscribe = { rel: SUBSCRIBE_REL, template: 'https://harmony.test/authorize_interaction?uri={uri}' }

  it('is a link of every local account, by handle and by actor URL', async () => {
    for (const resource of ['acct:alice@harmony.test', 'https://harmony.test/users/alice']) {
      const res = await finger(resource)
      expect(res.status).toBe(200)
      expect(res.body.links).toContainEqual(subscribe)
    }
    expect(SUBSCRIBE_REL).toBe('http://ostatus.org/schema/1.0/subscribe')
  })

  it('is absent from a chat server and from the instance actor', async () => {
    const server = await finger('acct:lounge@harmony.test')
    expect(server.status).toBe(200)
    expect(server.body.links.map((l: any) => l.rel)).toEqual(['self'])

    const instance = await finger('acct:instance.actor@harmony.test')
    expect(instance.body.links.map((l: any) => l.rel)).toEqual(['self'])
  })
})

describe('lookup-user by URL', () => {
  it('stores and answers the Group a community URL serves, confirmed through its account', async () => {
    const res = await lookupUrl(COMMUNITY)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, cached: false, user: { username: 'tech', domain: 'lemmy.test', federated_id: COMMUNITY } })
    expect(tables.profiles.filter((p) => p.federated_id === COMMUNITY)).toHaveLength(1)
    expect(fetched).toContain(`https://lemmy.test/.well-known/webfinger?resource=${encodeURIComponent('acct:tech@lemmy.test')}`)
  })

  it('answers a stored actor by its id without fetching', async () => {
    tables.profiles.push({ id: 'tech-id', username: 'tech', domain: 'lemmy.test', is_local: false, federated_id: COMMUNITY })
    const res = await lookupUrl(COMMUNITY)
    expect(res.body).toMatchObject({ success: true, cached: true, user: { id: 'tech-id' } })
    expect(fetched).toEqual([])
  })

  it('answers a local account by its actor or profile page URL', async () => {
    for (const url of ['https://harmony.test/users/alice', 'https://harmony.test/social/profile/alice', 'https://harmony.test/@alice']) {
      const res = await lookupUrl(url)
      expect(res.status).toBe(200)
      expect(res.body.user.id).toBe('alice-id')
    }
    expect(fetched).toEqual([])
  })

  it('is 404 not_actor for a URL that serves a post', async () => {
    const res = await lookupUrl(POST)
    expect(res.status).toBe(404)
    expect(res.body.kind).toBe('not_actor')
    expect(tables.profiles).toHaveLength(1)
  })

  it('is 404 not_actor for a local post URL', async () => {
    const res = await lookupUrl('https://harmony.test/posts/f0200000-0000-0000-0000-0000000000a1')
    expect(res.status).toBe(404)
    expect(res.body.kind).toBe('not_actor')
  })

  it('refuses an actor whose account names another actor', async () => {
    remote(OTHER)
    const res = await lookupUrl(COMMUNITY)
    expect(res.status).toBe(502)
    expect(tables.profiles.some((p) => p.federated_id === COMMUNITY)).toBe(false)
  })

  it('refuses an internal address', async () => {
    const res = await lookupUrl('http://127.0.0.1/users/x')
    expect(res.status).toBe(400)
    expect(fetched).toEqual([])
  })
})
