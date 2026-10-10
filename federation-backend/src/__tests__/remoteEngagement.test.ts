import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// Origin figures written on ingest and refresh, the replies crawl behind /fetch-replies,
// and the profile totals behind /lookup-user. The database double runs no triggers: the
// assertions read the remote_* columns the backend writes, which migration 20261011500001
// turns into the displayed counters.

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
vi.mock('../middleware/rateLimit.js', () => ({
  discoveryLimiter: (_req: any, _res: any, next: any) => next(),
}))
const blocked = vi.hoisted(() => new Set<string>())
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: (host: string) => blocked.has(host) },
}))
vi.mock('../activitypub/InstanceActor.js', () => ({
  signAsInstanceActor: vi.fn(async () => { throw new Error('no instance key in tests') }),
}))
vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichPostLinkPreviews: vi.fn(async () => false),
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let nextId = 1

const DEFAULTS: Record<string, Row> = {
  posts: { is_deleted: false, in_reply_to: null, metadata: {} },
}

/** In-memory Supabase double for the PostgREST chains these paths use. */
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
        insert(row: Row) {
          const stored = { id: `row-${nextId++}`, ...DEFAULTS[table], ...row }
          ;(tables[table] ??= []).push(stored)
          const result = { data: stored, error: null }
          return {
            select: () => ({ single: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result) }),
            then: (resolve: any) => resolve(result),
          }
        },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        is(col: string, val: any) { filters.push((row) => (row[col] ?? null) === val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder },
        or(expr: string) {
          const clauses = [...expr.matchAll(/([\w]+(?:->>[\w]+)?)\.eq\.(?:"((?:[^"\\]|\\.)*)"|([^,]*))/g)]
            .map((m) => ({ col: m[1], val: (m[2] ?? m[3]).replace(/\\(.)/g, '$1') }))
          const read = (row: Row, col: string) => {
            const [base, key] = col.split('->>')
            return key ? row[base]?.[key] : row[base]
          }
          filters.push((row) => clauses.some((c) => read(row, c.col) === c.val))
          return builder
        },
        ilike() { return builder },
        order() { return builder },
        limit(n: number) { cap = n; return builder },
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
const { resetProfileCountState } = await import('../activitypub/remoteCounts.js')
const actorRouter = (await import('../activitypub/ActorService.js')).default

const app = () => {
  const a = express()
  a.use(express.json())
  a.use('/', actorRouter)
  return a
}

const AUTHOR = 'https://mastodon.test/users/strypey'
const KIWI = 'https://mastodon.test/users/kiwi'
const PLEROMA = 'https://pleroma.test/users/pat'
const SUSPENDED = 'https://gts.test/users/gone'
const POST = `${AUTHOR}/statuses/1`
const PAGE_OTHERS = `${POST}/replies?only_other_accounts=true&page=true`
const PAGE_OTHERS_2 = `${POST}/replies?min_id=9&only_other_accounts=true&page=true`
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'

const ap = (doc: unknown) =>
  new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/activity+json' } })

const reply = (id: string, author: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'Note', attributedTo: author, inReplyTo: POST, to: [PUBLIC], content: `<p>${id}</p>`, ...extra,
})

/** Mastodon serves the status with likes and shares totals and its own replies on page one. */
const mastodonStatus = {
  id: POST,
  type: 'Note',
  attributedTo: AUTHOR,
  to: [PUBLIC],
  content: '<p>heavily boosted</p>',
  replies: {
    id: `${POST}/replies`,
    type: 'Collection',
    first: { type: 'CollectionPage', partOf: `${POST}/replies`, next: PAGE_OTHERS, items: [] },
  },
  likes: { id: `${POST}/likes`, type: 'Collection', totalItems: 764 },
  shares: { id: `${POST}/shares`, type: 'Collection', totalItems: 82 },
}

let docs: Record<string, unknown>
let requested: string[]
let FRESH: string
// Reply crawls keep a per-post cooldown for the life of the process; each test runs past it.
let clock = Date.now()

beforeEach(() => {
  clock += 20 * 60_000
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock)
  FRESH = new Date(clock).toISOString()
  nextId = 1
  blocked.clear()
  resetProfileCountState()
  requested = []
  tables = {
    profiles: [
      { id: 'author-id', username: 'strypey', domain: 'mastodon.test', is_local: false, federated_id: AUTHOR, updated_at: FRESH },
      { id: 'kiwi-id', username: 'kiwi', domain: 'mastodon.test', is_local: false, federated_id: KIWI, updated_at: FRESH },
      { id: 'pat-id', username: 'pat', domain: 'pleroma.test', is_local: false, federated_id: PLEROMA, updated_at: FRESH },
      { id: 'gone-id', username: 'gone', domain: 'gts.test', is_local: false, federated_id: SUSPENDED, updated_at: FRESH, is_suspended: true },
    ],
    posts: [
      { id: 'post-1', ap_id: POST, url: POST, author_id: 'author-id', is_local: false, is_deleted: false,
        in_reply_to: null, metadata: {}, replies_count: 0, favorites_count: 764, reblogs_count: 1 },
    ],
  }
  docs = {
    [POST]: mastodonStatus,
    [PAGE_OTHERS]: {
      id: PAGE_OTHERS, type: 'CollectionPage', next: PAGE_OTHERS_2,
      items: [
        reply(`${KIWI}/statuses/2`, KIWI),
        'https://pleroma.test/objects/r3',
      ],
    },
    [PAGE_OTHERS_2]: {
      id: PAGE_OTHERS_2, type: 'CollectionPage',
      items: ['https://gts.test/users/gone/statuses/4', 'https://blocked.test/users/x/statuses/5'],
    },
    'https://pleroma.test/objects/r3': reply('https://pleroma.test/objects/r3', PLEROMA, { summary: 'spoilers', sensitive: true }),
    'https://gts.test/users/gone/statuses/4': reply('https://gts.test/users/gone/statuses/4', SUSPENDED),
    'https://blocked.test/users/x/statuses/5': reply('https://blocked.test/users/x/statuses/5', 'https://blocked.test/users/x'),
  }
  vi.mocked(safeFetch).mockReset()
  vi.mocked(safeFetch).mockImplementation(async (url: any) => {
    requested.push(String(url))
    const doc = docs[String(url)]
    if (!doc) return new Response('', { status: 404 })
    return Object.defineProperty(ap(doc), 'url', { value: String(url) })
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const repliesOf = (postId: string) => (tables.posts ?? []).filter((p) => p.in_reply_to === postId)

describe('POST /fetch-replies', () => {
  it('crawls other accounts\' pages and stores each reply through the post path', async () => {
    blocked.add('blocked.test')
    const res = await supertest(app()).post('/fetch-replies').send({ post_ap_id: POST, post_id: 'post-1', force: true })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, status: 'ok', found: 4, new: 2, existing: 0, skipped: 2, pages: 2, truncated: false })
    expect(repliesOf('post-1').map((p) => p.ap_id).sort()).toEqual([`${KIWI}/statuses/2`, 'https://pleroma.test/objects/r3'])

    const pleromaReply = tables.posts.find((p) => p.ap_id === 'https://pleroma.test/objects/r3')!
    expect(pleromaReply).toMatchObject({ author_id: 'pat-id', content_warning: 'spoilers', is_sensitive: true })
    expect(requested).not.toContain('https://blocked.test/users/x/statuses/5')
    expect(requested).not.toContain(`${KIWI}/statuses/2`)
    expect(tables.posts.some((p) => p.ap_id === 'https://gts.test/users/gone/statuses/4')).toBe(false)
  })

  it('stores the post\'s likes and shares figures', async () => {
    await supertest(app()).post('/fetch-replies').send({ post_ap_id: POST, force: true })
    const row = tables.posts.find((p) => p.id === 'post-1')!
    expect(row).toMatchObject({ remote_favorites_count: 764, remote_reblogs_count: 82 })
    expect(row.remote_replies_count).toBeUndefined()
    expect(typeof row.remote_counts_fetched_at).toBe('string')
  })

  it('does not store a reply twice', async () => {
    await supertest(app()).post('/fetch-replies').send({ post_ap_id: POST, force: true })
    const first = tables.posts.length
    vi.setSystemTime(clock + 2 * 60_000)
    const res = await supertest(app()).post('/fetch-replies').send({ post_ap_id: POST, force: true })
    expect(res.body).toMatchObject({ status: 'ok', new: 0, existing: 2 })
    expect(tables.posts.length).toBe(first)
  })

  it('answers inside the cooldown without a crawl', async () => {
    await supertest(app()).post('/fetch-replies').send({ post_ap_id: `${AUTHOR}/statuses/77` })
    requested = []
    const res = await supertest(app()).post('/fetch-replies').send({ post_ap_id: `${AUTHOR}/statuses/77` })
    expect(res.body).toMatchObject({ success: true, status: 'recent', count: 0 })
    expect(requested).toEqual([])
  })

  it('refuses a crawl while four others run', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const slow = Array.from({ length: 4 }, (_, i) => `${AUTHOR}/statuses/slow${i}`)
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (slow.includes(String(url))) await held
      return new Response('', { status: 404 })
    })
    const running = slow.map((id) => supertest(app()).post('/fetch-replies').send({ post_ap_id: id }).then((r) => r))
    await new Promise((r) => setTimeout(r, 50))

    const res = await supertest(app()).post('/fetch-replies').send({ post_ap_id: `${AUTHOR}/statuses/fifth` })
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ success: false, status: 'busy' })

    release()
    for (const r of await Promise.all(running)) expect(r.body.status).toBe('unavailable')
  })

  it('reports a post without a replies collection', async () => {
    const misskeyStyle = 'https://akkoma.test/objects/plain'
    docs[misskeyStyle] = { id: misskeyStyle, type: 'Note', attributedTo: 'https://akkoma.test/users/a', content: '<p>x</p>' }
    const res = await supertest(app()).post('/fetch-replies').send({ post_ap_id: misskeyStyle, force: true })
    expect(res.body).toMatchObject({ success: true, status: 'no_collection', count: 0 })
  })

  it('reports a post its origin no longer serves', async () => {
    const res = await supertest(app()).post('/fetch-replies').send({ post_ap_id: 'https://mastodon.test/users/strypey/statuses/404', force: true })
    expect(res.body).toMatchObject({ success: true, status: 'unavailable', count: 0 })
  })
})

describe('POST /fetch-reactions', () => {
  it('stores the shares figure beside the likes figure', async () => {
    const res = await supertest(app()).post('/fetch-reactions').send({ post_ap_id: POST, post_id: 'post-1' })
    expect(res.status).toBe(200)
    expect(tables.posts[0]).toMatchObject({ remote_favorites_count: 764, remote_reblogs_count: 82 })
    expect(requested).toEqual([POST])
  })
})

describe('ingest', () => {
  it('stores the figures of a fetched post', async () => {
    const id = `${AUTHOR}/statuses/50`
    docs[id] = { ...mastodonStatus, id, replies: { totalItems: 7 } }
    const stored = await ActivityProcessor.fetchAndCreateRemotePost(id)
    expect(stored).not.toBeNull()
    expect(tables.posts.find((p) => p.ap_id === id)).toMatchObject({
      remote_replies_count: 7, remote_favorites_count: 764, remote_reblogs_count: 82,
    })
  })

  it('refuses a post by a suspended author or from a blocked host', async () => {
    expect(await ActivityProcessor.storeRemotePost(reply('https://gts.test/users/gone/statuses/9', SUSPENDED))).toBeNull()
    blocked.add('pleroma.test')
    expect(await ActivityProcessor.storeRemotePost(reply('https://pleroma.test/objects/9', PLEROMA))).toBeNull()
    expect(tables.posts).toHaveLength(1)
  })

  it('stores the figures of a boosted post fetched for its Announce', async () => {
    const id = `${AUTHOR}/statuses/60`
    docs[id] = { ...mastodonStatus, id }
    await (ActivityProcessor as any).processAnnounce({
      type: 'Announce', id: `${KIWI}/statuses/61/activity`, actor: KIWI, object: id, to: [PUBLIC],
    })
    expect(tables.posts.find((p) => p.ap_id === id)).toMatchObject({ remote_favorites_count: 764, remote_reblogs_count: 82 })
  })
})

describe('POST /lookup-user', () => {
  const outbox = `${AUTHOR}/outbox`
  const withCollections = () => {
    Object.assign(tables.profiles[0], {
      outbox_url: outbox, followers_url: `${AUTHOR}/followers`, following_url: `${AUTHOR}/following`,
      last_federation_sync: FRESH, federation_metadata: { bio_emojis: [{ name: 'x', url: 'y' }] },
    })
    docs[outbox] = { id: outbox, type: 'OrderedCollection', totalItems: 4321 }
    docs[`${AUTHOR}/followers`] = { id: `${AUTHOR}/followers`, type: 'OrderedCollection', totalItems: 1500 }
  }

  it('reads stale totals of a stored account before answering', async () => {
    withCollections()
    const res = await supertest(app()).post('/lookup-user').send({ handle: 'strypey@mastodon.test' })
    expect(res.status).toBe(200)
    expect(res.body.cached).toBe(true)
    expect(res.body.user).toMatchObject({ remote_posts_count: 4321, remote_followers_count: 1500, remote_following_count: null })
    expect(tables.profiles[0]).toMatchObject({ remote_posts_count: 4321, remote_followers_count: 1500, remote_following_count: null })
    expect(tables.profiles[0].followers_count).toBeUndefined()
  })

  it('starts an outbox backfill when the last one is over five minutes old', async () => {
    withCollections()
    tables.profiles[0].last_federation_sync = null
    const res = await supertest(app()).post('/lookup-user').send({ handle: 'strypey@mastodon.test' })
    expect(res.body.backfilling).toBe(true)
    expect(requested).toContain(outbox)
  })

  it('leaves totals younger than six hours', async () => {
    withCollections()
    Object.assign(tables.profiles[0], { remote_counts_fetched_at: FRESH, remote_posts_count: 10 })
    const res = await supertest(app()).post('/lookup-user').send({ handle: 'strypey@mastodon.test' })
    expect(res.body.user.remote_posts_count).toBe(10)
    expect(res.body.backfilling).toBe(false)
    expect(requested).toEqual([])
  })
})
