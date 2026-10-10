import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'
import express from 'express'
import supertest from 'supertest'

// A split-domain instance (Mastodon LOCAL_DOMAIN understars.test, WEB_DOMAIN
// chat.understars.test) in authorized fetch mode: its actor answers an
// unsigned GET with 400 Missing signature. Its accounts are one profile row,
// keyed by actor id and named by the account domain, however they are reached.

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
  validateExternalUrl: vi.fn(),
}))
vi.mock('../middleware/rateLimit.js', () => {
  const pass = (_req: any, _res: any, next: any) => next()
  return { discoveryLimiter: pass, reactionsLimiter: pass, repliesLimiter: pass, repliesStatusLimiter: pass }
})
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: vi.fn(() => false) },
}))
const instanceKey = vi.hoisted(() => ({ privateKey: '' }))
vi.mock('../activitypub/InstanceActor.js', () => ({
  signAsInstanceActor: vi.fn(async (url: string, method: string, body: unknown) => {
    const { SignatureService } = await import('../activitypub/SignatureService.js')
    return SignatureService.signWithKey(url, method, body, 'https://harmony.test/users/instance.actor#main-key', instanceKey.privateKey)
  }),
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let nextId = 1

/** In-memory Supabase double for the profile queries these paths make. */
function fakeSupabase() {
  return {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let op: 'select' | 'update' = 'select'
      let patch: Row = {}
      let cap = Infinity
      const run = () => {
        const matched = (tables[table] ?? []).filter((row) => filters.every((f) => f(row))).slice(0, cap)
        if (op === 'update') matched.forEach((row) => Object.assign(row, patch))
        return matched
      }
      const builder: any = {
        select() { return builder },
        update(p: Row) { op = 'update'; patch = p; return builder },
        upsert(row: Row, opts?: { onConflict?: string }) {
          const key = opts?.onConflict?.split(',') ?? ['id']
          const rows = (tables[table] ??= [])
          let stored = rows.find((r) => key.every((k) => r[k] === row[k]))
          const clash = rows.find((r) => r !== stored && r.username === row.username && r.domain === row.domain
            && row.username !== undefined)
          const result = clash
            ? { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "profiles_username_domain_key"' } }
            : (() => {
                if (stored) Object.assign(stored, row)
                else rows.push(stored = { id: `row-${nextId++}`, ...row })
                return { data: stored, error: null }
              })()
          return {
            select: () => ({ single: () => Promise.resolve(result), then: (resolve: any) => resolve(result) }),
            then: (resolve: any) => resolve(result),
          }
        },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        ilike(col: string, pattern: string) {
          const re = new RegExp(`^${pattern.split('%').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
          filters.push((row) => re.test(String(row[col] ?? '')))
          return builder
        },
        limit(n: number) { cap = n; return builder },
        order() { return builder },
        maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }) },
        single() {
          const rows = run()
          return Promise.resolve(rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } })
        },
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
const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const actorRouter = (await import('../activitypub/ActorService.js')).default

const P = ActivityProcessor as any
const ACTOR = 'https://chat.understars.test/users/doesnm'
const instancePair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const actorDoc = {
  '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
  id: ACTOR,
  type: 'Person',
  preferredUsername: 'doesnm',
  name: 'doesnm',
  inbox: `${ACTOR}/inbox`,
  endpoints: { sharedInbox: 'https://chat.understars.test/inbox' },
  publicKey: { id: `${ACTOR}#main-key`, owner: ACTOR, publicKeyPem: 'DOESNM-KEY' },
}

const wf = (domain: string, acct: string) =>
  `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${acct}`)}`
const jrd = (subject: string) => new Response(JSON.stringify({
  subject,
  links: [{ rel: 'self', type: 'application/activity+json', href: ACTOR }],
}), { status: 200, headers: { 'content-type': 'application/jrd+json' } })

let webfingerUp: boolean
let actorGets: Array<{ signature?: string }>

/** Verifies a signed GET against the instance actor key, as the remote does. */
function signedByInstanceActor(url: string, headers: Record<string, string>): boolean {
  if (!headers?.Signature?.includes('keyId="https://harmony.test/users/instance.actor#main-key"')) return false
  const sig = /signature="([^"]+)"/.exec(headers.Signature)?.[1] ?? ''
  const target = new URL(url)
  const signingString = `(request-target): get ${target.pathname}${target.search}\nhost: ${headers.Host}\ndate: ${headers.Date}`
  return crypto.createVerify('SHA256').update(signingString).verify(instancePair.publicKey, sig, 'base64')
}

function remote() {
  vi.mocked(safeFetch).mockImplementation(async (url: string, init: any) => {
    if (url === ACTOR) {
      actorGets.push({ signature: init?.headers?.Signature })
      if (!signedByInstanceActor(url, init?.headers)) {
        return new Response('{"code":400,"message":"Missing signature"}', { status: 400 })
      }
      return new Response(JSON.stringify(actorDoc), { status: 200, headers: { 'content-type': 'application/activity+json' } })
    }
    if (webfingerUp && url === wf('chat.understars.test', 'doesnm@chat.understars.test')) return jrd('acct:doesnm@understars.test')
    if (webfingerUp && url === wf('understars.test', 'doesnm@understars.test')) return jrd('acct:doesnm@understars.test')
    return new Response('', { status: 404 })
  })
}

function app() {
  const a = express()
  a.use(express.json())
  a.use(actorRouter)
  return a
}

beforeEach(() => {
  nextId = 1
  tables = { profiles: [] }
  webfingerUp = true
  actorGets = []
  instanceKey.privateKey = instancePair.privateKey
  vi.mocked(safeFetch).mockReset()
  remote()
})

const lookup = (handle: string, forceRefresh = false) =>
  supertest(app()).post('/lookup-user').send({ handle, forceRefresh })

describe('lookup-user against a split-domain instance requiring signed GETs', () => {
  it('stores the web-domain handle under its account domain, fetched with a signed GET', async () => {
    const res = await lookup('@doesnm@chat.understars.test')

    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ username: 'doesnm', domain: 'understars.test', federated_id: ACTOR })
    expect(tables.profiles).toHaveLength(1)
    expect(actorGets).toHaveLength(1)
    expect(actorGets[0].signature).toContain('instance.actor#main-key')
  })

  it('resolves the account-domain handle to the same row', async () => {
    await lookup('doesnm@chat.understars.test')
    const res = await lookup('doesnm@understars.test', true)

    expect(res.status).toBe(200)
    expect(res.body.user.federated_id).toBe(ACTOR)
    expect(tables.profiles).toHaveLength(1)
    expect(tables.profiles[0].domain).toBe('understars.test')
  })

  it('answers either handle from the stored row without fetching', async () => {
    await lookup('doesnm@understars.test')
    vi.mocked(safeFetch).mockClear()

    for (const handle of ['doesnm@understars.test', 'doesnm@chat.understars.test']) {
      const res = await lookup(handle)
      expect(res.body).toMatchObject({ cached: true, user: { domain: 'understars.test', federated_id: ACTOR } })
    }
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('moves a row stored under the web domain to the account domain instead of adding one', async () => {
    tables.profiles.push({ id: 'old', username: 'doesnm', domain: 'chat.understars.test', federated_id: ACTOR, is_local: false })

    const res = await lookup('doesnm@understars.test')

    expect(res.status).toBe(200)
    expect(tables.profiles).toEqual([expect.objectContaining({ id: 'old', domain: 'understars.test', federated_id: ACTOR })])
  })

  it('keeps a stored account domain when a forced lookup cannot confirm it', async () => {
    tables.profiles.push({ id: 'old', username: 'doesnm', domain: 'understars.test', federated_id: ACTOR, is_local: false })
    vi.mocked(safeFetch).mockImplementation(async (url: string, init: any) => {
      if (url === wf('chat.understars.test', 'doesnm@chat.understars.test')) return jrd('acct:doesnm@understars.test')
      if (url === ACTOR && signedByInstanceActor(url, init?.headers)) {
        return new Response(JSON.stringify(actorDoc), { status: 200, headers: { 'content-type': 'application/activity+json' } })
      }
      return new Response('', { status: 503 })
    })

    const res = await lookup('doesnm@chat.understars.test', true)

    expect(res.status).toBe(200)
    expect(tables.profiles).toEqual([expect.objectContaining({ id: 'old', domain: 'understars.test' })])
  })

  it('keeps the actor on its host when the account domain cannot be confirmed', async () => {
    webfingerUp = false
    vi.mocked(safeFetch).mockImplementation(async (url: string, init: any) => {
      if (url === wf('chat.understars.test', 'doesnm@chat.understars.test')) {
        return new Response(JSON.stringify({
          subject: 'acct:doesnm@chat.understars.test',
          links: [{ rel: 'self', type: 'application/activity+json', href: ACTOR }],
        }), { status: 200, headers: { 'content-type': 'application/jrd+json' } })
      }
      if (url === ACTOR && signedByInstanceActor(url, init?.headers)) {
        return new Response(JSON.stringify(actorDoc), { status: 200, headers: { 'content-type': 'application/activity+json' } })
      }
      return new Response('', { status: 404 })
    })

    const res = await lookup('doesnm@chat.understars.test')

    expect(res.status).toBe(200)
    expect(res.body.user).toMatchObject({ username: 'doesnm', domain: 'chat.understars.test' })
  })
})

describe('ensureRemoteUser for a split-domain actor', () => {
  it('creates the profile under the account domain from a signed actor fetch', async () => {
    const profile = await P.ensureRemoteUser(ACTOR)

    expect(profile?.federated_id).toBe(ACTOR)
    expect(tables.profiles).toEqual([expect.objectContaining({ username: 'doesnm', domain: 'understars.test', public_key: 'DOESNM-KEY' })])
    expect(actorGets.every((g) => g.signature?.includes('instance.actor#main-key'))).toBe(true)
  })

  it('converges a stale row stored under the web domain', async () => {
    tables.profiles.push({
      id: 'old', username: 'doesnm', domain: 'chat.understars.test', federated_id: ACTOR, is_local: false,
      updated_at: new Date(Date.now() - 48 * 3600_000).toISOString(),
    })

    await P.ensureRemoteUser(ACTOR)

    expect(tables.profiles).toEqual([expect.objectContaining({ id: 'old', domain: 'understars.test' })])
  })

  it('keeps the stored account domain when WebFinger is down on refresh', async () => {
    tables.profiles.push({
      id: 'old', username: 'doesnm', domain: 'understars.test', federated_id: ACTOR, is_local: false,
      updated_at: new Date(Date.now() - 48 * 3600_000).toISOString(),
    })
    webfingerUp = false

    await P.ensureRemoteUser(ACTOR, true)

    expect(tables.profiles).toEqual([expect.objectContaining({ id: 'old', domain: 'understars.test', public_key: 'DOESNM-KEY' })])
  })
})
