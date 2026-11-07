import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// Remote profile import: an outbox read in 20-item pages loses no item, an
// Announce stores its original first, a page that cannot be read fails the
// request and is read again by the next one, and the featured collection pins
// the account's posts.

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
  BlockedInstancesCache: { isBlocked: () => false },
}))
vi.mock('../activitypub/InstanceActor.js', () => ({
  signAsInstanceActor: vi.fn(async () => { throw new Error('no instance key in tests') }),
}))
vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichPostLinkPreviews: vi.fn(async () => false),
}))

/** Documents served by the fake remote, by URL. */
const served = vi.hoisted(() => new Map<string, any>())
const fetchedUrls = vi.hoisted(() => [] as string[])
function respond(url: string) {
  fetchedUrls.push(url)
  const doc = served.get(url)
  return new Response(doc ? JSON.stringify(doc) : 'gone', {
    status: doc ? 200 : 404,
    headers: { 'content-type': 'application/activity+json' },
  })
}
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { signedApFetch: vi.fn(async (url: string) => respond(url)) },
}))

const processor = vi.hoisted(() => ({
  fetchAndCreateRemotePost: vi.fn(),
  storeRemotePost: vi.fn(),
  fetchApDocument: vi.fn(async (url: string) => {
    const doc = served.get(url)
    return doc ? { doc, finalUrl: url } : null
  }),
}))
vi.mock('../activitypub/ActivityProcessor.js', () => ({ ActivityProcessor: processor }))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let nextId = 1

/** In-memory Supabase double; posts enforce posts_content_not_empty. */
function fakeSupabase() {
  return {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let op: 'select' | 'update' | 'insert' = 'select'
      let patch: Row = {}
      let inserted: Row | null = null
      const run = () => {
        if (op === 'insert') {
          const row = inserted!
          if (table === 'posts' && !(Array.isArray(row.content) && row.content.length > 0) && row.reblog == null) {
            return { data: null, error: { code: '23514', message: 'violates check constraint "posts_content_not_empty"' } }
          }
          const stored = { id: `row-${nextId++}`, is_deleted: false, is_pinned: false, ...row }
          ;(tables[table] ??= []).push(stored)
          return { data: [stored], error: null }
        }
        const matched = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
        if (op === 'update') matched.forEach((row) => Object.assign(row, patch))
        return { data: matched, error: null }
      }
      const builder: any = {
        select() { return builder },
        insert(row: Row) { op = 'insert'; inserted = row; return builder },
        update(p: Row) { op = 'update'; patch = p; return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder },
        not(col: string, operator: string, value: string) {
          const vals = operator === 'in' ? value.replace(/^\(|\)$/g, '').split(',') : [value]
          filters.push((row) => !vals.includes(String(row[col])))
          return builder
        },
        maybeSingle() {
          const { data, error } = run()
          return Promise.resolve({ data: data?.[0] ?? null, error })
        },
        single() {
          const { data, error } = run()
          return Promise.resolve(data?.length === 1 ? { data: data[0], error: null } : { data: null, error: error ?? { message: 'no rows' } })
        },
        then(resolve: any) { return resolve(run()) },
      }
      return builder
    },
  }
}
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => fakeSupabase(),
  getSupabaseClientWithAuth: () => fakeSupabase(),
}))

const { fetchRecentPostsInBackground, syncFeaturedCollection, default: actorRouter } = await import('../activitypub/ActorService.js')
const { SignatureService } = await import('../activitypub/SignatureService.js')

const HOST = 'https://mastodon.test'
const ACTOR = `${HOST}/users/alice`
const OUTBOX = `${ACTOR}/outbox`
const AUTHOR_ID = 'alice-row'

function note(n: number) {
  return {
    id: `${ACTOR}/statuses/${n}`,
    type: 'Note',
    attributedTo: ACTOR,
    content: `<p>post ${n}</p>`,
    published: new Date(Date.UTC(2026, 0, 1) + (1000 - n) * 60_000).toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${ACTOR}/followers`],
  }
}
const create = (n: number) => ({ id: `${ACTOR}/statuses/${n}/activity`, type: 'Create', actor: ACTOR, object: note(n) })

/** Mastodon's shape: the collection links `first`, each page links `next`. */
function serveOutbox(items: any[], pageSize = 20) {
  served.set(OUTBOX, { id: OUTBOX, type: 'OrderedCollection', totalItems: items.length, first: `${OUTBOX}?page=true` })
  for (let i = 0; i * pageSize < items.length; i++) {
    const url = i === 0 ? `${OUTBOX}?page=true` : `${OUTBOX}?page=true&max_id=${i}`
    const nextUrl = (i + 1) * pageSize < items.length ? `${OUTBOX}?page=true&max_id=${i + 1}` : undefined
    served.set(url, {
      id: url,
      type: 'OrderedCollectionPage',
      partOf: OUTBOX,
      orderedItems: items.slice(i * pageSize, (i + 1) * pageSize),
      ...(nextUrl ? { next: nextUrl } : {}),
    })
  }
}

const storedApIds = () => tables.posts.filter((p) => p.author_id === AUTHOR_ID).map((p) => p.ap_id)
const supabase = fakeSupabase()

beforeEach(() => {
  served.clear()
  fetchedUrls.length = 0
  tables = { posts: [], profiles: [{ id: AUTHOR_ID, federated_id: ACTOR, outbox_url: OUTBOX, is_local: false }] }
  nextId = 1
  processor.fetchAndCreateRemotePost.mockReset()
  processor.storeRemotePost.mockReset()
})

describe('outbox import', () => {
  it('imports every item of 20-item pages, page after page', async () => {
    serveOutbox(Array.from({ length: 45 }, (_, i) => create(i + 1)))

    const first = await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase)
    expect(first.hasMore).toBe(true)
    expect(storedApIds()).toHaveLength(20)

    const second = await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase, 'more')
    expect(second.hasMore).toBe(true)
    expect(storedApIds()).toHaveLength(40)

    const third = await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase, 'more')
    expect(third.hasMore).toBe(false)
    expect(new Set(storedApIds())).toEqual(new Set(Array.from({ length: 45 }, (_, i) => note(i + 1).id)))
  })

  it('continues a page longer than the request mid-page', async () => {
    serveOutbox(Array.from({ length: 50 }, (_, i) => create(i + 1)), 30)

    await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase, undefined, 20)
    expect(storedApIds()).toEqual(Array.from({ length: 20 }, (_, i) => note(i + 1).id))

    await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase, 'more', 20)
    expect(storedApIds()).toEqual(Array.from({ length: 40 }, (_, i) => note(i + 1).id))

    const last = await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase, 'more', 20)
    expect(last.hasMore).toBe(false)
    expect(storedApIds()).toHaveLength(50)
  })

  it('walks past pages already stored within one request', async () => {
    serveOutbox(Array.from({ length: 60 }, (_, i) => create(i + 1)))
    for (let n = 1; n <= 40; n++) {
      tables.posts.push({ id: `old-${n}`, ap_id: note(n).id, author_id: AUTHOR_ID, content: [{ type: 'text', text: 'x' }] })
    }

    const result = await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase)
    expect(storedApIds()).toHaveLength(60)
    expect(result.hasMore).toBe(false)
  })

  it('stores the original of an Announce before the boost, and skips one it cannot store', async () => {
    const boosted = `${'https://misskey.test'}/notes/abc`
    serveOutbox([
      { id: `${ACTOR}/statuses/100/activity`, type: 'Announce', actor: ACTOR, object: boosted, published: '2026-01-02T00:00:00Z' },
      { id: `${ACTOR}/statuses/101/activity`, type: 'Announce', actor: ACTOR, object: 'https://gone.test/notes/x' },
      create(1),
    ])
    processor.fetchAndCreateRemotePost.mockImplementation(async (url: string) => {
      if (url !== boosted) return null
      const row = { id: 'orig-row', ap_id: boosted, author_id: 'misskey-author', visibility: 'public', content: [{ type: 'text', text: 'hi' }], created_at: '2026-01-01T00:00:00Z' }
      tables.posts.push(row)
      return { id: row.id, in_reply_to: null, conversation_root_id: null }
    })

    await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase)

    const reblog = tables.posts.find((p) => p.ap_id === `${ACTOR}/statuses/100/activity`)
    expect(reblog).toMatchObject({
      ap_type: 'Announce',
      author_id: AUTHOR_ID,
      reblog: expect.objectContaining({ id: 'orig-row', ap_id: boosted }),
      metadata: expect.objectContaining({ reblog_of: 'orig-row', reblog_of_ap_url: boosted }),
    })
    expect(tables.posts.find((p) => p.ap_id === `${ACTOR}/statuses/101/activity`)).toBeUndefined()
    expect(storedApIds()).toContain(note(1).id)
  })

  it('reads no page off the outbox host', async () => {
    served.set(OUTBOX, { id: OUTBOX, type: 'OrderedCollection', first: 'https://evil.test/page' })
    served.set('https://evil.test/page', { orderedItems: [create(1)] })
    const result = await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase)
    expect(result.hasMore).toBe(false)
    expect(fetchedUrls).not.toContain('https://evil.test/page')
    expect(tables.posts).toEqual([])
  })
})

describe('unreadable outbox', () => {
  const PAGE_2 = `${OUTBOX}?page=true&max_id=1`

  it('fails the request, and the next one reads the page it could not', async () => {
    serveOutbox(Array.from({ length: 45 }, (_, i) => create(i + 1)))
    await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase)
    expect(storedApIds()).toHaveLength(20)

    const page2 = served.get(PAGE_2)
    served.delete(PAGE_2)
    const failed = await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase, 'more')
    expect(failed.failed).toBe(true)
    expect(storedApIds()).toHaveLength(20)

    served.set(PAGE_2, page2)
    fetchedUrls.length = 0
    const resumed = await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase, 'more')
    expect(resumed.failed).toBeUndefined()
    expect(resumed.hasMore).toBe(true)
    expect(fetchedUrls).toEqual([PAGE_2])
    expect(storedApIds()).toHaveLength(40)
  })

  it('fails on a network error', async () => {
    serveOutbox([create(1)])
    vi.mocked(SignatureService.signedApFetch).mockRejectedValueOnce(new TypeError('fetch failed'))
    const result = await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase)
    expect(result.failed).toBe(true)
    expect(tables.posts).toEqual([])
  })

  it('keeps what an earlier page of the request stored', async () => {
    serveOutbox(Array.from({ length: 45 }, (_, i) => create(i + 1)))
    served.delete(PAGE_2)
    const result = await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase, undefined, 40)
    expect(result.failed).toBeUndefined()
    expect(result.hasMore).toBe(true)
    expect(storedApIds()).toHaveLength(20)
  })

  it('ends without failing at the end of an outbox that was read', async () => {
    serveOutbox([create(1)])
    await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase)
    const result = await fetchRecentPostsInBackground(AUTHOR_ID, OUTBOX, supabase, 'more')
    expect(result).toMatchObject({ hasMore: false })
    expect(result.failed).toBeUndefined()
  })
})

describe('POST /fetch-posts', () => {
  const request = () => supertest(express().use(express.json()).use('/', actorRouter))
    .post('/fetch-posts')
    .send({ user_id: AUTHOR_ID, outbox_url: OUTBOX })

  it('answers 502 when the outbox cannot be read', async () => {
    const res = await request()
    expect(res.status).toBe(502)
  })

  it('answers 200 with has_more false at the end of the outbox', async () => {
    serveOutbox([create(1)])
    const res = await request()
    expect(res.status).toBe(200)
    expect(res.body.has_more).toBe(false)
  })
})

describe('featured collection', () => {
  const FEATURED = `${ACTOR}/collections/featured`

  beforeEach(() => {
    processor.storeRemotePost.mockImplementation(async (object: any) => {
      let row = tables.posts.find((p) => p.ap_id === object.id)
      if (!row) {
        row = { id: `row-${nextId++}`, ap_id: object.id, author_id: AUTHOR_ID, is_pinned: false, content: [{ type: 'text', text: 'x' }] }
        tables.posts.push(row)
      }
      return { id: row.id, in_reply_to: null, conversation_root_id: null }
    })
    processor.fetchAndCreateRemotePost.mockImplementation(async (url: string) => processor.storeRemotePost({ id: url }))
  })

  it('pins the listed posts, embedded or linked, and unpins the rest', async () => {
    tables.posts.push(
      { id: 'was-pinned', ap_id: note(9).id, author_id: AUTHOR_ID, is_pinned: true, content: [] },
      { id: 'other-author', ap_id: 'https://mastodon.test/users/bob/statuses/1', author_id: 'bob-row', is_pinned: true, content: [] },
    )
    served.set(ACTOR, {
      id: ACTOR, type: 'Person', preferredUsername: 'alice', inbox: `${ACTOR}/inbox`, featured: FEATURED,
    })
    served.set(FEATURED, {
      id: FEATURED, type: 'OrderedCollection', totalItems: 2,
      orderedItems: [note(1), note(2).id],
    })

    const pinned = await syncFeaturedCollection({ id: AUTHOR_ID, federated_id: ACTOR, featured_url: null }, null, supabase)

    expect(pinned).toHaveLength(2)
    const byAp = (id: string) => tables.posts.find((p) => p.ap_id === id)
    expect(byAp(note(1).id)?.is_pinned).toBe(true)
    expect(byAp(note(2).id)?.is_pinned).toBe(true)
    expect(byAp(note(9).id)?.is_pinned).toBe(false)
    expect(tables.posts.find((p) => p.id === 'other-author')?.is_pinned).toBe(true)
    expect(tables.profiles[0].featured_url).toBe(FEATURED)
    expect(processor.storeRemotePost).toHaveBeenCalledWith(note(1))
    expect(processor.fetchAndCreateRemotePost).toHaveBeenCalledWith(note(2).id)
  })

  it('pins nothing that another account wrote', async () => {
    served.set(FEATURED, { id: FEATURED, type: 'OrderedCollection', orderedItems: [note(1)] })
    processor.storeRemotePost.mockResolvedValue({ id: 'foreign', in_reply_to: null, conversation_root_id: null })
    tables.posts.push({ id: 'foreign', ap_id: note(1).id, author_id: 'someone-else', is_pinned: false, content: [] })

    const pinned = await syncFeaturedCollection({ id: AUTHOR_ID, federated_id: ACTOR, featured_url: FEATURED }, null, supabase)
    expect(pinned).toEqual([])
    expect(tables.posts.find((p) => p.id === 'foreign')?.is_pinned).toBe(false)
  })

  it('leaves the pins as they are when the collection cannot be read', async () => {
    tables.posts.push({ id: 'was-pinned', ap_id: note(9).id, author_id: AUTHOR_ID, is_pinned: true, content: [] })
    const pinned = await syncFeaturedCollection({ id: AUTHOR_ID, federated_id: ACTOR, featured_url: FEATURED }, null, supabase)
    expect(pinned).toBeNull()
    expect(tables.posts[0].is_pinned).toBe(true)
  })

  it('reads no featured collection off the actor host', async () => {
    const pinned = await syncFeaturedCollection({ id: AUTHOR_ID, federated_id: ACTOR, featured_url: null }, 'https://evil.test/featured', supabase)
    expect(pinned).toBeNull()
    expect(processor.fetchApDocument).not.toHaveBeenCalledWith('https://evil.test/featured')
  })
})
