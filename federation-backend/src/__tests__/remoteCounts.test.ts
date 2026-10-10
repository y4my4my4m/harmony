import { describe, it, expect, vi, beforeEach } from 'vitest'

// Origin figures: totalItems parsing, collection reads and their storage.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const blocked = vi.hoisted(() => new Set<string>())
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: (host: string) => blocked.has(host) },
}))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { signedApFetch: vi.fn() },
}))

const {
  parseCount, collectionTotal, noteEngagementTotals, noteEngagementColumns, engagementColumns,
  fetchCollectionTotal, fetchProfileCounts, profileCountColumns, profileCountsStale,
  refreshRemoteProfileCounts, resetProfileCountState, misskeyNoteTotals, PROFILE_COUNTS_TTL_MS,
} = await import('../activitypub/remoteCounts.js')

const ACTOR = 'https://mastodon.test/users/strypey'
const AT = new Date('2026-10-10T12:00:00Z')

const ap = (doc: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(doc), {
  status: 200, headers: { 'content-type': 'application/activity+json' }, ...init,
})

describe('parseCount and collectionTotal', () => {
  it('reads a number, a string of digits, and nothing else', () => {
    expect(parseCount(764)).toBe(764)
    expect(parseCount(0)).toBe(0)
    expect(parseCount('82')).toBe(82)
    expect(parseCount(' 82 ')).toBe(82)
    expect(parseCount(-1)).toBeNull()
    expect(parseCount(1.5)).toBeNull()
    expect(parseCount(Number.NaN)).toBeNull()
    expect(parseCount('8e2')).toBeNull()
    expect(parseCount('-3')).toBeNull()
    expect(parseCount(2_147_483_648)).toBeNull()
    expect(parseCount(null)).toBeNull()
    expect(parseCount(undefined)).toBeNull()
  })

  it('takes totalItems from an embedded collection only', () => {
    expect(collectionTotal({ type: 'Collection', totalItems: 12 })).toBe(12)
    expect(collectionTotal({ type: 'Collection', totalItems: '12' })).toBe(12)
    expect(collectionTotal({ type: 'Collection', first: 'https://x.test/c?page=1' })).toBeNull()
    expect(collectionTotal('https://mastodon.test/users/a/statuses/1/likes')).toBeNull()
    expect(collectionTotal([{ totalItems: 3 }])).toBeNull()
  })
})

describe('Note figures', () => {
  // As Mastodon 4.x serializes a status: likes and shares carry totalItems, replies a first page.
  const mastodonNote = {
    id: 'https://mastodon.test/users/strypey/statuses/1',
    type: 'Note',
    replies: {
      id: 'https://mastodon.test/users/strypey/statuses/1/replies',
      type: 'Collection',
      first: { type: 'CollectionPage', next: 'https://mastodon.test/users/strypey/statuses/1/replies?only_other_accounts=true&page=true', items: [] },
    },
    likes: { id: 'https://mastodon.test/users/strypey/statuses/1/likes', type: 'Collection', totalItems: 764 },
    shares: { id: 'https://mastodon.test/users/strypey/statuses/1/shares', type: 'Collection', totalItems: 82 },
  }

  it('takes likes and shares from a Mastodon status, replies only when given', () => {
    expect(noteEngagementTotals(mastodonNote)).toEqual({ replies: null, likes: 764, shares: 82 })
    expect(noteEngagementColumns(mastodonNote, AT)).toEqual({
      remote_favorites_count: 764,
      remote_reblogs_count: 82,
      remote_counts_fetched_at: AT.toISOString(),
    })
  })

  it('falls back to count fields beside the collections', () => {
    expect(noteEngagementTotals({ repliesCount: 3, favouritesCount: '4', sharesCount: 5 }))
      .toEqual({ replies: 3, likes: 4, shares: 5 })
    expect(noteEngagementTotals({ replies: { totalItems: 9 }, repliesCount: 3 }).replies).toBe(9)
  })

  it('writes nothing for a Note without figures', () => {
    expect(noteEngagementColumns({ id: 'https://pleroma.test/objects/1', type: 'Note' }, AT)).toEqual({})
    expect(engagementColumns({ replies: 0, likes: null, shares: null }, AT))
      .toEqual({ remote_replies_count: 0, remote_counts_fetched_at: AT.toISOString() })
  })

  it('reads Misskey renotes, replies and heart reactions from notes/show', () => {
    expect(misskeyNoteTotals({ renoteCount: 7, repliesCount: 2, reactions: { '❤': 5, '❤️': 1, ':blobcat@.:': 9, '🎉': 4 } }))
      .toEqual({ replies: 2, likes: 6, shares: 7 })
    expect(misskeyNoteTotals({})).toEqual({ replies: null, likes: null, shares: null })
  })
})

describe('fetchCollectionTotal', () => {
  beforeEach(() => blocked.clear())

  it('reads a numeric total', async () => {
    const get = vi.fn(async () => ap({ type: 'OrderedCollection', totalItems: 4321 }))
    expect(await fetchCollectionTotal(`${ACTOR}/outbox`, ACTOR, get)).toBe(4321)
    expect(get).toHaveBeenCalledWith(`${ACTOR}/outbox`, 5000)
  })

  it('reads a string total', async () => {
    expect(await fetchCollectionTotal(`${ACTOR}/followers`, ACTOR, async () => ap({ totalItems: '1500' }))).toBe(1500)
  })

  it('reports a collection without totalItems as withheld', async () => {
    expect(await fetchCollectionTotal(`${ACTOR}/followers`, ACTOR, async () => ap({ type: 'OrderedCollection', first: `${ACTOR}/followers?page=1` }))).toBeNull()
  })

  it('reports a private collection as withheld', async () => {
    for (const status of [401, 403, 404, 410]) {
      expect(await fetchCollectionTotal(`${ACTOR}/followers`, ACTOR, async () => new Response('', { status }))).toBeNull()
    }
  })

  it('reports an HTML answer as withheld', async () => {
    const html = new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    expect(await fetchCollectionTotal(`${ACTOR}/followers`, ACTOR, async () => html)).toBeNull()
  })

  it('reports a failed read as unknown', async () => {
    expect(await fetchCollectionTotal(`${ACTOR}/outbox`, ACTOR, async () => new Response('', { status: 503 }))).toBeUndefined()
    expect(await fetchCollectionTotal(`${ACTOR}/outbox`, ACTOR, async () => { throw new Error('timeout') })).toBeUndefined()
    const bad = new Response('{not json', { status: 200, headers: { 'content-type': 'application/activity+json' } })
    expect(await fetchCollectionTotal(`${ACTOR}/outbox`, ACTOR, async () => bad)).toBeUndefined()
  })

  it('does not read a collection on another host, a blocked host, or no URL', async () => {
    const get = vi.fn(async () => ap({ totalItems: 1_000_000 }))
    expect(await fetchCollectionTotal('https://inflate.test/followers', ACTOR, get)).toBeNull()
    expect(await fetchCollectionTotal(undefined, ACTOR, get)).toBeNull()
    blocked.add('mastodon.test')
    expect(await fetchCollectionTotal(`${ACTOR}/followers`, ACTOR, get)).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })

  it('reads the three collections into columns', async () => {
    const totals: Record<string, Response> = {
      [`${ACTOR}/outbox`]: ap({ totalItems: 4321 }),
      [`${ACTOR}/followers`]: new Response('', { status: 403 }),
      [`${ACTOR}/following`]: new Response('', { status: 502 }),
    }
    const reads = await fetchProfileCounts({
      federated_id: ACTOR,
      outbox_url: `${ACTOR}/outbox`,
      followers_url: `${ACTOR}/followers`,
      following_url: `${ACTOR}/following`,
    }, async (url) => totals[url])
    expect(reads).toEqual({ posts: 4321, followers: null, following: undefined })
    expect(profileCountColumns(reads, AT)).toEqual({
      remote_posts_count: 4321,
      remote_followers_count: null,
      remote_counts_fetched_at: AT.toISOString(),
    })
    expect(profileCountColumns({ posts: undefined, followers: undefined, following: undefined }, AT)).toEqual({})
  })
})

describe('refreshRemoteProfileCounts', () => {
  const updates: Array<{ id: string; columns: Record<string, unknown> }> = []
  const supabase = {
    from: () => ({
      update: (columns: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          updates.push({ id, columns })
          return Promise.resolve({ error: null })
        },
      }),
    }),
  }
  const row = {
    id: 'remote-1',
    is_local: false,
    federated_id: ACTOR,
    outbox_url: `${ACTOR}/outbox`,
    followers_url: `${ACTOR}/followers`,
    following_url: `${ACTOR}/following`,
    remote_counts_fetched_at: null as string | null,
  }
  const totalsGet = vi.fn(async (url: string) => ap({
    totalItems: url.endsWith('/outbox') ? 4321 : url.endsWith('/followers') ? 1500 : 320,
  }))

  beforeEach(() => {
    updates.length = 0
    totalsGet.mockClear()
    resetProfileCountState()
  })

  it('reads and stores the totals of a profile never read', async () => {
    const columns = await refreshRemoteProfileCounts(supabase, row, { get: totalsGet })
    expect(columns).toMatchObject({ remote_posts_count: 4321, remote_followers_count: 1500, remote_following_count: 320 })
    expect(updates).toEqual([{ id: 'remote-1', columns }])
  })

  it('leaves figures younger than the TTL, unless forced', async () => {
    const fresh = { ...row, remote_counts_fetched_at: new Date(Date.now() - 60_000).toISOString() }
    expect(profileCountsStale(fresh)).toBe(false)
    expect(await refreshRemoteProfileCounts(supabase, fresh, { get: totalsGet })).toBeNull()
    expect(totalsGet).not.toHaveBeenCalled()
    expect(await refreshRemoteProfileCounts(supabase, fresh, { get: totalsGet, force: true })).not.toBeNull()

    const old = { ...row, remote_counts_fetched_at: new Date(Date.now() - PROFILE_COUNTS_TTL_MS - 1).toISOString() }
    expect(profileCountsStale(old)).toBe(true)
  })

  it('never reads a local profile', async () => {
    expect(await refreshRemoteProfileCounts(supabase, { ...row, is_local: true }, { get: totalsGet })).toBeNull()
    expect(totalsGet).not.toHaveBeenCalled()
  })

  it('shares one read between concurrent calls', async () => {
    const [a, b] = await Promise.all([
      refreshRemoteProfileCounts(supabase, row, { get: totalsGet }),
      refreshRemoteProfileCounts(supabase, row, { get: totalsGet }),
    ])
    expect(a).toBe(b)
    expect(totalsGet).toHaveBeenCalledTimes(3)
    expect(updates).toHaveLength(1)
  })

  it('writes nothing for an unreachable origin and waits before trying again', async () => {
    const down = vi.fn(async () => new Response('', { status: 503 }))
    expect(await refreshRemoteProfileCounts(supabase, row, { get: down })).toBeNull()
    expect(updates).toHaveLength(0)
    expect(await refreshRemoteProfileCounts(supabase, row, { get: down })).toBeNull()
    expect(down).toHaveBeenCalledTimes(3)
  })
})
