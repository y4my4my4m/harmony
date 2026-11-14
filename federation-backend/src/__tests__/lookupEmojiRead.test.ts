import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'
import express from 'express'
import supertest from 'supertest'

// lookup-user answers a stored remote profile from its row. It reads the actor again before
// answering when the row shows :shortcodes: and no read has recorded the emoji lists; a read
// records both lists, empty ones included, so a profile without custom emoji is read once.
// A row last read over a day ago is answered as stored and read again in the background, at
// most once an hour per actor; forceRefresh reads it now.

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

/** In-memory Supabase double for the profile queries lookup-user makes. */
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
          if (stored) Object.assign(stored, row)
          else rows.push(stored = { id: `row-${nextId++}`, ...row })
          const result = { data: stored, error: null }
          return {
            select: () => ({ single: () => Promise.resolve(result), then: (resolve: any) => resolve(result) }),
            then: (resolve: any) => resolve(result),
          }
        },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        is(col: string, val: any) { filters.push((row) => (row[col] ?? null) === val); return builder },
        ilike() { filters.push(() => false); return builder },
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
const actorModule = await import('../activitypub/ActorService.js')
const actorRouter = actorModule.default
const { needsEmojiRead, profileStale, resetStaleProfileReads, PROFILE_STALE_MS } = actorModule

const ACTOR = 'https://bridge.test/users/hltvorg'
const BIO_WITH_URL = '<p>The home of competitive Counter-Strike | <a href="https://t.co/aaWhFcbJRO">https://t.co/aaWhFcbJRO</a><br>SoMe Partner: @thunderpickco</p>'
const instancePair = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

let actorDoc: Record<string, any>
let actorGets: number

const wf = `https://bridge.test/.well-known/webfinger?resource=${encodeURIComponent('acct:hltvorg@bridge.test')}`

function remote() {
  vi.mocked(safeFetch).mockImplementation(async (url: string) => {
    if (url === ACTOR) {
      actorGets++
      return new Response(JSON.stringify(actorDoc), { status: 200, headers: { 'content-type': 'application/activity+json' } })
    }
    if (url === wf) {
      return new Response(JSON.stringify({
        subject: 'acct:hltvorg@bridge.test',
        links: [{ rel: 'self', type: 'application/activity+json', href: ACTOR }],
      }), { status: 200, headers: { 'content-type': 'application/jrd+json' } })
    }
    return new Response('', { status: 404 })
  })
}

function app() {
  const a = express()
  a.use(express.json())
  a.use(actorRouter)
  return a
}

const lookup = (forceRefresh = false) =>
  supertest(app()).post('/lookup-user').send({ handle: 'hltvorg@bridge.test', forceRefresh })

/** A row as an earlier lookup stored it, read a minute ago: no emoji lists recorded. */
function storedRow(fields: Row): Row {
  const row = {
    id: 'stored', username: 'hltvorg', domain: 'bridge.test', federated_id: ACTOR, is_local: false,
    display_name: 'HLTV.org', bio: BIO_WITH_URL, federation_metadata: null,
    last_synced_at: new Date(Date.now() - 60_000).toISOString(), ...fields,
  }
  tables.profiles.push(row)
  return row
}

beforeEach(() => {
  nextId = 1
  tables = { profiles: [] }
  actorGets = 0
  resetStaleProfileReads()
  instanceKey.privateKey = instancePair.privateKey
  actorDoc = {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
    id: ACTOR,
    type: 'Service',
    preferredUsername: 'hltvorg',
    name: 'HLTV.org',
    summary: BIO_WITH_URL,
    inbox: `${ACTOR}/inbox`,
    endpoints: { sharedInbox: 'https://bridge.test/inbox' },
    publicKey: { id: `${ACTOR}#main-key`, owner: ACTOR, publicKeyPem: 'BRIDGE-KEY' },
  }
  vi.mocked(safeFetch).mockReset()
  remote()
})

describe('lookup-user emoji reads', () => {
  it('reads an actor without custom emoji once, then answers from the row', async () => {
    const first = await lookup()
    expect(first.status).toBe(200)
    expect(first.body.cached).toBe(false)
    expect(tables.profiles[0].federation_metadata).toMatchObject({ bio_emojis: [], display_name_emojis: [] })

    for (let i = 0; i < 3; i++) {
      const again = await lookup()
      expect(again.body).toMatchObject({ success: true, cached: true, user: { federated_id: ACTOR } })
    }
    expect(actorGets).toBe(1)
  })

  it('answers a row without recorded emoji from the row when its text holds no shortcode', async () => {
    storedRow({})

    const res = await lookup()

    expect(res.body.cached).toBe(true)
    expect(actorGets).toBe(0)
  })

  it('reads a row without recorded emoji once when its bio holds a shortcode', async () => {
    storedRow({ bio: '<p>gg :blobcat: wp</p>' })
    actorDoc.summary = '<p>gg :blobcat: wp</p>'
    actorDoc.tag = [{ type: 'Emoji', name: ':blobcat:', icon: { type: 'Image', url: 'https://bridge.test/emoji/blobcat.png' } }]

    const first = await lookup()
    expect(first.body.cached).toBe(false)
    expect(tables.profiles).toHaveLength(1)
    expect(tables.profiles[0].federation_metadata.bio_emojis).toEqual([
      { name: 'blobcat', url: 'https://bridge.test/emoji/blobcat.png' },
    ])

    const second = await lookup()
    expect(second.body.cached).toBe(true)
    expect(actorGets).toBe(1)
  })

  it('stops reading once a read records empty lists for shortcode-like text', async () => {
    storedRow({ bio: '<p>doors 19:30:00 sharp</p>' })
    actorDoc.summary = '<p>doors 19:30:00 sharp</p>'

    await lookup()
    await lookup()
    await lookup()

    expect(actorGets).toBe(1)
  })

  it('stores the shared inbox the actor names', async () => {
    await lookup()

    expect(tables.profiles[0].shared_inbox_url).toBe('https://bridge.test/inbox')
  })

  it('keeps metadata keys of other writers, including a JSON-encoded row, and records ap_published', async () => {
    storedRow({ federation_metadata: JSON.stringify({ ap_published: '2020-01-01T00:00:00.000Z', bio_emojis: [{ name: 'old', url: 'https://bridge.test/old.png' }], pinned_note: 'x' }) })
    actorDoc.published = '2009-06-02T20:12:29Z'

    const res = await lookup(true)

    expect(res.status).toBe(200)
    expect(tables.profiles[0].federation_metadata).toEqual({
      pinned_note: 'x',
      ap_published: '2009-06-02T20:12:29.000Z',
      bio_emojis: [],
      display_name_emojis: [],
    })
  })
})

describe('lookup-user on a stored copy older than a day', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

  it('answers the stored row at once and reads the actor in the background', async () => {
    storedRow({ last_synced_at: daysAgo(2), display_name: 'Old name' })
    actorDoc.name = 'New name'

    const res = await lookup()

    expect(res.body).toMatchObject({ cached: true, refreshing: true, user: { display_name: 'Old name' } })
    await vi.waitFor(() => expect(tables.profiles[0].display_name).toBe('New name'))
    expect(actorGets).toBe(1)
    expect(Date.now() - Date.parse(tables.profiles[0].last_synced_at)).toBeLessThan(60_000)

    const next = await lookup()
    expect(next.body).toMatchObject({ cached: true, refreshing: false, user: { display_name: 'New name' } })
    expect(actorGets).toBe(1)
  })

  it('reads a row that was never read from its actor', async () => {
    storedRow({ last_synced_at: null })

    const res = await lookup()

    expect(res.body).toMatchObject({ cached: true, refreshing: true })
    await vi.waitFor(() => expect(actorGets).toBe(1))
  })

  it('tries an unreachable instance once an hour, answering the stored row each time', async () => {
    storedRow({ last_synced_at: daysAgo(3) })
    vi.mocked(safeFetch).mockImplementation(async (url: string) => {
      if (url === ACTOR) actorGets++
      return new Response('', { status: 503 })
    })

    const first = await lookup()
    expect(first.body).toMatchObject({ success: true, cached: true, refreshing: true })
    await vi.waitFor(() => expect(vi.mocked(safeFetch)).toHaveBeenCalled())
    const calls = vi.mocked(safeFetch).mock.calls.length

    for (let i = 0; i < 3; i++) {
      const again = await lookup()
      expect(again.body).toMatchObject({ success: true, cached: true, refreshing: false })
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(vi.mocked(safeFetch).mock.calls.length).toBe(calls)
  })

  it('answers the stored row when the emoji read fails', async () => {
    storedRow({ bio: '<p>gg :blobcat: wp</p>' })
    vi.mocked(safeFetch).mockImplementation(async () => new Response('', { status: 503 }))

    const res = await lookup()

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, cached: true, user: { id: 'stored' } })
  })

  it('refreshes on demand whatever the age of the stored copy', async () => {
    storedRow({ display_name: 'Old name' })
    actorDoc.name = 'New name'

    const res = await lookup(true)

    expect(res.body).toMatchObject({ cached: false, refreshed: true, user: { display_name: 'New name' } })
    expect(actorGets).toBe(1)
  })
})

describe('profileStale', () => {
  const now = Date.parse('2026-11-11T00:00:00Z')
  it.each([
    ['read an hour ago', { last_synced_at: new Date(now - 3_600_000).toISOString() }, false],
    ['read just over a day ago', { last_synced_at: new Date(now - PROFILE_STALE_MS - 1000).toISOString() }, true],
    ['never read', { last_synced_at: null }, true],
    ['unparseable date', { last_synced_at: 'yesterday' }, true],
    ['local account', { is_local: true, last_synced_at: null }, false],
  ])('%s', (_name, profile, expected) => {
    expect(profileStale(profile, now)).toBe(expected)
  })
})

describe('needsEmojiRead', () => {
  it.each([
    ['URL in bio', { bio: 'https://example.test:8443/path' }, false],
    ['shortcode in name', { display_name: 'Ada :verified:' }, true],
    ['Misskey shortcode', { bio: ':blob-cat+1:' }, true],
    ['shortcode with recorded empty lists', { bio: ':blobcat:', federation_metadata: { bio_emojis: [], display_name_emojis: [] } }, false],
    ['shortcode with JSON-encoded lists', { bio: ':blobcat:', federation_metadata: '{"bio_emojis":[{"name":"blobcat","url":"u"}]}' }, false],
    ['shortcode with metadata lacking lists', { bio: ':blobcat:', federation_metadata: { ap_published: '2020-01-01T00:00:00Z' } }, true],
    ['unparseable metadata', { bio: ':blobcat:', federation_metadata: '{' }, true],
  ])('%s', (_name, profile, expected) => {
    expect(needsEmojiRead(profile)).toBe(expected)
  })
})
