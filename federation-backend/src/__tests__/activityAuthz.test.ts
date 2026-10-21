import { describe, it, expect, vi, beforeEach } from 'vitest'

// Authorization and origin checks in ActivityProcessor. `activity.actor` is
// the verified signer (InboxHandler enforces the match); everything else in
// the payload is sender-chosen.

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    PORT: 3001,
    NODE_ENV: 'test',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    USE_BULLMQ_QUEUE: false,
    CORS_ORIGIN: 'http://localhost:5173',
    REQUIRE_VALID_SIGNATURES: true,
    ALLOW_FEDERATED_VOICE: true,
    WEBRTC_MODE: 'hybrid',
    FEDERATION_MODE: 'unified',
  },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn() }))

vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: vi.fn(() => false) },
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let nextId = 1

/**
 * In-memory Supabase double: select/eq/is/in/ilike/or-less filters, awaited
 * as an array or via maybeSingle/single; update/delete/insert/upsert.
 */
function fakeSupabase() {
  return {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let op: 'select' | 'delete' | 'update' = 'select'
      let patch: Row = {}

      const run = () => {
        const rows = tables[table] ?? []
        const matched = rows.filter((row) => filters.every((f) => f(row)))
        if (op === 'delete') tables[table] = rows.filter((row) => !matched.includes(row))
        if (op === 'update') matched.forEach((row) => Object.assign(row, patch))
        return matched
      }

      const builder: any = {
        select() { return builder },
        delete() { op = 'delete'; return builder },
        update(p: Row) { op = 'update'; patch = p; return builder },
        insert(row: Row) {
          const stored = { id: `row-${nextId++}`, ...row }
          ;(tables[table] ??= []).push(stored)
          const result = { data: stored, error: null }
          return {
            select: () => ({ single: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result) }),
            then: (resolve: any) => resolve(result),
          }
        },
        upsert(row: Row, opts?: { onConflict?: string }) {
          const key = opts?.onConflict?.split(',') ?? ['id']
          const rows = (tables[table] ??= [])
          const existing = rows.find((r) => key.every((k) => r[k] === row[k]))
          if (existing) Object.assign(existing, row)
          else rows.push({ id: `row-${nextId++}`, ...row })
          const result = { data: null, error: null }
          return { select: () => Promise.resolve(result), then: (resolve: any) => resolve(result) }
        },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        is(col: string, val: any) { filters.push((row) => (row[col] ?? null) === val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder },
        // PostgreSQL ILIKE: `%` any run, `_` one character, `\` escapes.
        ilike(col: string, val: string) {
          let re = ''
          for (let i = 0; i < val.length; i++) {
            const ch = val[i]
            if (ch === '\\' && i + 1 < val.length) re += val[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            else if (ch === '%') re += '.*'
            else if (ch === '_') re += '.'
            else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          }
          const pattern = new RegExp(`^${re}$`, 'i')
          filters.push((row) => pattern.test(String(row[col])))
          return builder
        },
        // `a.eq."x",metadata->>b.eq."y"` - any clause matching.
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
        limit() { return builder },
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

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => fakeSupabase() }))

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const { safeFetch } = await import('../utils/ssrfProtection.js')

const P = ActivityProcessor as any

const LOCAL_ALICE = 'https://harmony.test/users/alice'
const MALLORY = 'https://evil.test/users/mallory'
const BOB = 'https://mastodon.test/users/bob'
const FRESH = new Date().toISOString()

beforeEach(() => {
  nextId = 1
  vi.mocked(safeFetch).mockReset()
  tables = {
    profiles: [
      { id: 'alice-id', username: 'alice', is_local: true, federated_id: LOCAL_ALICE, updated_at: FRESH },
      { id: 'mallory-id', username: 'mallory', domain: 'evil.test', is_local: false, federated_id: MALLORY, updated_at: FRESH },
      { id: 'bob-id', username: 'bob', domain: 'mastodon.test', is_local: false, federated_id: BOB, updated_at: FRESH, public_key: 'BOB-KEY' },
    ],
    posts: [],
    post_interactions: [],
    follows: [],
    ap_activities: [],
    reactions: [],
    messages: [],
  }
})

describe('Undo', () => {
  it('does not delete a post that is not the signer\'s reblog', async () => {
    tables.posts.push({ id: 'local-post', ap_id: 'https://harmony.test/posts/local-post', author_id: 'alice-id', ap_type: 'Note', metadata: {} })

    await P.processUndo({
      type: 'Undo',
      actor: MALLORY,
      object: { type: 'Announce', id: 'https://harmony.test/posts/local-post', actor: MALLORY },
    })

    expect(tables.posts.map((p) => p.id)).toEqual(['local-post'])
  })

  it('does not delete another actor\'s reblog', async () => {
    tables.posts.push({ id: 'bob-reblog', ap_id: 'https://mastodon.test/announces/1', author_id: 'bob-id', ap_type: 'Announce', metadata: { reblog_of: 'x' } })

    await P.processUndo({
      type: 'Undo',
      actor: MALLORY,
      object: { type: 'Announce', id: 'https://mastodon.test/announces/1', actor: BOB },
    })

    expect(tables.posts).toHaveLength(1)
  })

  it('deletes the signer\'s own reblog and its interaction row', async () => {
    tables.posts.push({ id: 'bob-reblog', ap_id: 'https://mastodon.test/announces/1', author_id: 'bob-id', ap_type: 'Announce', metadata: { reblog_of: 'orig' } })
    tables.post_interactions.push({ id: 'i1', user_id: 'bob-id', post_id: 'orig', interaction_type: 'reblog' })

    await P.processUndo({
      type: 'Undo',
      actor: BOB,
      object: { type: 'Announce', id: 'https://mastodon.test/announces/1', actor: BOB },
    })

    expect(tables.posts).toHaveLength(0)
    expect(tables.post_interactions).toHaveLength(0)
  })

  it('does not remove a follow the signer is not the follower of', async () => {
    tables.follows.push({ id: 'f1', follower_id: 'alice-id', following_id: 'bob-id', status: 'accepted' })

    await P.processUndo({
      type: 'Undo',
      actor: MALLORY,
      object: { type: 'Follow', actor: LOCAL_ALICE, object: BOB },
    })

    expect(tables.follows).toHaveLength(1)
  })

  it('removes the signer\'s own follow', async () => {
    tables.follows.push({ id: 'f1', follower_id: 'bob-id', following_id: 'alice-id', status: 'accepted' })

    await P.processUndo({
      type: 'Undo',
      actor: BOB,
      object: { type: 'Follow', actor: BOB, object: LOCAL_ALICE },
    })

    expect(tables.follows).toHaveLength(0)
  })

  it('does not remove another user\'s reaction', async () => {
    tables.posts.push({ id: 'p1', ap_id: 'https://harmony.test/posts/p1', author_id: 'alice-id' })
    tables.post_interactions.push({ id: 'r1', user_id: 'bob-id', post_id: 'p1', interaction_type: 'favorite' })

    await P.processUndo({
      type: 'Undo',
      actor: MALLORY,
      object: { type: 'Like', actor: BOB, object: 'https://harmony.test/posts/p1' },
    })

    expect(tables.post_interactions).toHaveLength(1)
  })

  it('does not undo a stored activity of another actor referenced by id', async () => {
    tables.follows.push({ id: 'f1', follower_id: 'bob-id', following_id: 'alice-id', status: 'accepted' })
    tables.ap_activities.push({
      ap_id: 'https://mastodon.test/follows/1',
      ap_type: 'Follow',
      actor_ap_id: BOB,
      activity_data: { id: 'https://mastodon.test/follows/1', type: 'Follow', actor: BOB, object: LOCAL_ALICE },
    })

    await P.processUndo({ type: 'Undo', actor: MALLORY, object: 'https://mastodon.test/follows/1' })

    expect(tables.follows).toHaveLength(1)
  })
})

describe('Accept / Reject of a Follow', () => {
  it('ignores an Accept from someone other than the followee', async () => {
    // Pending request from Mallory to a locked local account. Mallory knows
    // the Follow id because Mallory sent it.
    tables.follows.push({ id: 'f1', follower_id: 'mallory-id', following_id: 'alice-id', status: 'pending', ap_id: 'https://evil.test/follows/1' })

    await P.processAccept({
      type: 'Accept',
      actor: MALLORY,
      object: { type: 'Follow', id: 'https://evil.test/follows/1', actor: MALLORY, object: LOCAL_ALICE },
    })

    expect(tables.follows[0].status).toBe('pending')
  })

  it('ignores a Reject from someone other than the followee', async () => {
    tables.follows.push({ id: 'f1', follower_id: 'alice-id', following_id: 'bob-id', status: 'accepted', ap_id: 'https://harmony.test/activities/x' })

    await P.processReject({
      type: 'Reject',
      actor: MALLORY,
      object: { type: 'Follow', id: 'https://harmony.test/activities/x', actor: LOCAL_ALICE, object: BOB },
    })

    expect(tables.follows).toHaveLength(1)
  })

  it('applies a Reject from the followee when the Follow id differs from the stored one', async () => {
    // The outbound Follow id (/activities/follow/<row id>) is not the id the
    // client stored on the row.
    tables.follows.push({ id: 'f1', follower_id: 'alice-id', following_id: 'bob-id', status: 'accepted', ap_id: 'https://harmony.test/activities/client-id' })

    await P.processReject({
      type: 'Reject',
      actor: BOB,
      object: { type: 'Follow', id: 'https://harmony.test/activities/follow/f1', actor: LOCAL_ALICE, object: BOB },
    })

    expect(tables.follows).toHaveLength(0)
  })

  it('applies an Accept from the followee', async () => {
    tables.follows.push({ id: 'f1', follower_id: 'alice-id', following_id: 'bob-id', status: 'pending', ap_id: 'https://harmony.test/activities/follow/f1' })

    await P.processAccept({
      type: 'Accept',
      actor: BOB,
      object: { type: 'Follow', id: 'https://harmony.test/activities/follow/f1', actor: LOCAL_ALICE, object: BOB },
    })

    expect(tables.follows[0].status).toBe('accepted')
  })
})

describe('Reject of a Join', () => {
  const GROUP = 'https://chat.example/servers/eaa74f77-149a-4a43-9a0e-2a51a2a0078f'
  const JOIN = 'https://harmony.test/users/alice/activities/join-1'
  const reject = (summary?: string) => ({
    type: 'Reject',
    actor: GROUP,
    ...(summary ? { summary } : {}),
    object: { type: 'Join', id: JOIN, actor: LOCAL_ALICE, object: GROUP },
  })

  beforeEach(() => {
    tables.servers = [{ id: 'ref', name: 'Mastodon Canada', ap_id: GROUP, is_local_server: false }]
    tables.user_servers = [{ id: 'm1', server_id: 'ref', user_id: 'alice-id', status: 'accepted', join_activity_id: JOIN }]
    tables.notifications = []
  })

  it('removes the membership and tells the user why when it arrives after the join answered', async () => {
    await P.processReject(reject('Federation is disabled on this server'))

    expect(tables.user_servers).toHaveLength(0)
    expect(tables.notifications).toHaveLength(1)
    expect(tables.notifications[0]).toMatchObject({
      user_id: 'alice-id',
      type: 'server_join_rejected',
      data: { server: { id: 'ref', name: 'Mastodon Canada', ap_id: GROUP }, reason: 'Federation is disabled on this server' },
    })
  })

  it('leaves the telling to the join request that is still answering', async () => {
    const { markJoinInFlight, clearJoinInFlight } = await import('../activitypub/joinsInFlight.js')
    markJoinInFlight(JOIN)
    try {
      await P.processReject(reject('Federation is disabled on this server'))
    } finally {
      clearJoinInFlight(JOIN)
    }
    expect(tables.user_servers).toHaveLength(0)
    expect(tables.notifications).toHaveLength(0)
  })

  it('says nothing when there was no membership to remove', async () => {
    tables.user_servers = []
    await P.processReject(reject())
    expect(tables.notifications).toHaveLength(0)
  })

  it('leaves a membership made by a later Join: a stale or replayed Reject names another Join', async () => {
    tables.user_servers[0].join_activity_id = 'https://harmony.test/users/alice/activities/join-2'
    await P.processReject(reject('Federation is disabled on this server'))
    expect(tables.user_servers).toHaveLength(1)
    expect(tables.notifications).toHaveLength(0)
  })

  it('leaves an accepted membership that stored no Join id', async () => {
    tables.user_servers[0].join_activity_id = null
    await P.processReject(reject())
    expect(tables.user_servers).toHaveLength(1)
  })

  it('removes a pending membership that stored no Join id', async () => {
    tables.user_servers[0] = { id: 'm1', server_id: 'ref', user_id: 'alice-id', status: 'pending', join_activity_id: null }
    await P.processReject(reject())
    expect(tables.user_servers).toHaveLength(0)
  })
})

describe('Remove of a member by a remote Group', () => {
  const GROUP = 'https://chat.example/servers/eaa74f77-149a-4a43-9a0e-2a51a2a0078f'
  const OTHER_GROUP = 'https://chat.example/servers/0a5c0f2b-6f5e-4f43-9d3a-6c1d1b7f0e11'
  const remove = (extra: Record<string, unknown> = {}) => ({
    type: 'Remove',
    id: `${GROUP}/activities/removal-1`,
    actor: GROUP,
    object: LOCAL_ALICE,
    target: `${GROUP}/members`,
    published: '2026-10-21T12:00:00.000Z',
    summary: 'This server stopped taking members from other instances',
    'harmony:reason': 'federation_closed',
    ...extra,
  })

  beforeEach(() => {
    tables.servers = [
      { id: 'ref', name: 'Mastodon Canada', ap_id: GROUP, is_local_server: false },
      { id: 'other-ref', name: 'Other', ap_id: OTHER_GROUP, is_local_server: false },
    ]
    tables.user_servers = [
      { id: 'm1', server_id: 'ref', user_id: 'alice-id', status: 'accepted', created_at: '2026-10-01T00:00:00.000Z' },
      { id: 'm2', server_id: 'other-ref', user_id: 'alice-id', status: 'accepted', created_at: '2026-10-01T00:00:00.000Z' },
    ]
    tables.notifications = []
  })

  it('removes the membership when federation was turned off and says so without calling it a ban', async () => {
    await P.processRemove(remove())

    expect(tables.user_servers.map(r => r.id)).toEqual(['m2'])
    expect(tables.notifications).toHaveLength(1)
    expect(tables.notifications[0]).toMatchObject({
      user_id: 'alice-id',
      type: 'server_federation_closed',
      data: { server: { id: 'ref', name: 'Mastodon Canada', ap_id: GROUP } },
    })
  })

  it('names a kick or a ban, with the reason the server gave', async () => {
    await P.processRemove(remove({ 'harmony:reason': 'ban', summary: 'spam' }))

    expect(tables.user_servers.map(r => r.id)).toEqual(['m2'])
    expect(tables.notifications[0]).toMatchObject({
      type: 'server_member_removed',
      data: { server: { id: 'ref' }, action: 'ban', reason: 'spam' },
    })
  })

  it('does nothing for a Group other than the one whose members it names', async () => {
    await P.processRemove(remove({ actor: OTHER_GROUP }))
    expect(tables.user_servers).toHaveLength(2)
    expect(tables.notifications).toHaveLength(0)
  })

  it('does nothing for a member of another instance', async () => {
    await P.processRemove(remove({ object: BOB }))
    expect(tables.user_servers).toHaveLength(2)
    expect(tables.notifications).toHaveLength(0)
  })

  it('does nothing for an actor that is no server reference here', async () => {
    const stray = 'https://evil.test/servers/x'
    await P.processRemove(remove({ actor: stray, target: `${stray}/members` }))
    expect(tables.user_servers).toHaveLength(2)
  })

  it('keeps a membership made after the Remove was published', async () => {
    tables.user_servers[0].created_at = '2026-10-21T13:00:00.000Z'
    await P.processRemove(remove())
    expect(tables.user_servers).toHaveLength(2)
    expect(tables.notifications).toHaveLength(0)
  })

  it('says nothing when there was no membership to remove', async () => {
    tables.user_servers = tables.user_servers.filter(r => r.id !== 'm1')
    await P.processRemove(remove())
    expect(tables.notifications).toHaveLength(0)
  })
})

describe('local actor URL fallback', () => {
  it('does not rewrite a local user\'s actor URLs from a case-variant URL', async () => {
    await P.processFollow({
      id: 'https://evil.test/follows/9',
      type: 'Follow',
      actor: MALLORY,
      object: 'https://harmony.test/users/ALICE',
    })

    const alice = tables.profiles.find((p) => p.id === 'alice-id')
    expect(alice?.federated_id).toBe(LOCAL_ALICE)
  })

  it('does not treat a wildcard path segment as a username', async () => {
    await P.processFollow({
      id: 'https://evil.test/follows/10',
      type: 'Follow',
      actor: MALLORY,
      object: 'https://harmony.test/users/%',
    })

    expect(tables.follows).toHaveLength(0)
  })

  it('backfills federated_id from the stored username', async () => {
    const alice = tables.profiles.find((p) => p.id === 'alice-id')!
    alice.federated_id = null

    await P.processFollow({
      id: 'https://evil.test/follows/11',
      type: 'Follow',
      actor: MALLORY,
      object: 'https://harmony.test/users/Alice',
    })

    expect(alice.federated_id).toBe(LOCAL_ALICE)
  })
})

describe('Create origin', () => {
  it('rejects a Note whose id is on another host than the actor', async () => {
    await P.processCreate({
      type: 'Create',
      actor: MALLORY,
      object: {
        id: 'https://mastodon.test/users/bob/statuses/1',
        type: 'Note',
        attributedTo: MALLORY,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        content: '<p>squatted</p>',
      },
    })

    expect(tables.posts).toHaveLength(0)
  })

  it('stores a Note on the actor\'s own host', async () => {
    await P.processCreate({
      type: 'Create',
      actor: BOB,
      object: {
        id: 'https://mastodon.test/users/bob/statuses/1',
        type: 'Note',
        attributedTo: BOB,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        content: '<p>hello</p>',
      },
    })

    expect(tables.posts.map((p) => p.ap_id)).toEqual(['https://mastodon.test/users/bob/statuses/1'])
  })
})

const json = (doc: unknown) =>
  new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/activity+json' } })

describe('fetched documents', () => {
  it('does not store a fetched Note that claims an id and author on another host', async () => {
    const evilUrl = 'https://evil.test/notes/1'
    const forged = {
      id: 'https://mastodon.test/users/bob/statuses/99',
      type: 'Note',
      attributedTo: BOB,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      content: '<p>forged words</p>',
    }
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (url === evilUrl) return json(forged)
      return new Response('', { status: 404 })
    })

    const result = await P.fetchAndCreateRemotePost(evilUrl)

    expect(result).toBeNull()
    expect(tables.posts).toHaveLength(0)
  })

  it('keeps a Note re-fetched from its own host when the first URL was elsewhere', async () => {
    const realId = 'https://mastodon.test/users/bob/statuses/99'
    const real = {
      id: realId,
      type: 'Note',
      attributedTo: BOB,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      content: '<p>real words</p>',
    }
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (url === 'https://evil.test/notes/1') return json({ ...real, content: '<p>forged</p>' })
      if (url === realId) return json(real)
      return new Response('', { status: 404 })
    })

    await P.fetchAndCreateRemotePost('https://evil.test/notes/1')

    expect(tables.posts).toHaveLength(1)
    expect(tables.posts[0].author_id).toBe('bob-id')
    expect(JSON.stringify(tables.posts[0].content)).toContain('real words')
  })

  it('does not overwrite an actor from a document served by another host', async () => {
    const newcomer = 'https://evil.test/users/newcomer'
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (url === newcomer) {
        return json({
          id: BOB,
          type: 'Person',
          preferredUsername: 'bob',
          inbox: 'https://evil.test/inbox',
          publicKey: { id: `${BOB}#main-key`, owner: BOB, publicKeyPem: 'EVIL-KEY' },
        })
      }
      if (url === BOB) return new Response('', { status: 404 })
      return new Response('', { status: 404 })
    })

    await P.ensureRemoteUser(newcomer)

    const bob = tables.profiles.find((p) => p.federated_id === BOB)
    expect(bob?.public_key).toBe('BOB-KEY')
    expect(bob?.inbox_url).toBeUndefined()
  })

  it('does not overwrite an actor from another URL on its own host', async () => {
    const upload = 'https://mastodon.test/system/media/evil.json'
    const forged = {
      id: BOB,
      type: 'Person',
      preferredUsername: 'bob',
      inbox: 'https://mastodon.test/evil-inbox',
      publicKey: { id: `${BOB}#main-key`, owner: BOB, publicKeyPem: 'EVIL-KEY' },
    }
    vi.mocked(safeFetch).mockImplementation(async (url: any) => {
      if (url === upload) return json(forged)
      if (url === BOB) return json({ ...forged, inbox: `${BOB}/inbox`, publicKey: { ...forged.publicKey, publicKeyPem: 'BOB-KEY' } })
      return new Response('', { status: 404 })
    })

    const returned = await P.ensureRemoteUser(upload)

    expect(returned).toBeNull()
    const bob = tables.profiles.find((p) => p.federated_id === BOB)
    expect(bob?.public_key).toBe('BOB-KEY')
    expect(bob?.inbox_url).toBeUndefined()
  })
})
