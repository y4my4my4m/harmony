import { describe, it, expect, vi, beforeEach } from 'vitest'

// Group conversations, boosts and quotes, and server Updates through
// ActivityProcessor. `activity.actor` is the verified signer (InboxHandler
// enforces the match); everything else in the payload is sender-chosen.
// Ported from the security audit's demonstrations, asserting the fixed
// behaviour.

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
vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichPostLinkPreviews: vi.fn(async () => false),
  enrichMessageLinkPreviews: vi.fn(async () => false),
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let rpcResult: Record<string, any> = {}
let nextId = 1

const read = (row: Row, col: string) => {
  const [base, key] = col.split('->>')
  return key ? row[base]?.[key] : row[base]
}

function fakeSupabase() {
  return {
    rpc: (fn: string) => Promise.resolve({ data: rpcResult[fn] ?? null, error: null }),
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
        eq(col: string, val: any) { filters.push((row) => read(row, col) === val); return builder },
        is(col: string, val: any) { filters.push((row) => (read(row, col) ?? null) === val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(read(row, col))); return builder },
        filter(col: string, _op: string, val: any) { filters.push((row) => read(row, col) === val); return builder },
        contains(col: string, val: Row) {
          filters.push((row) => Object.entries(val).every(([k, v]) => row[col]?.[k] === v))
          return builder
        },
        ilike(col: string, val: string) {
          const pattern = new RegExp(`^${val.replace(/\\_/g, '_').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
          filters.push((row) => pattern.test(String(row[col])))
          return builder
        },
        or(expr: string) {
          const clauses = [...expr.matchAll(/([\w]+(?:->>[\w]+)?)\.eq\.(?:"((?:[^"\\]|\\.)*)"|([^,]*))/g)]
            .map((m) => ({ col: m[1], val: (m[2] ?? m[3]).replace(/\\(.)/g, '$1') }))
          filters.push((row) => clauses.some((c) => read(row, c.col) === c.val))
          return builder
        },
        limit() { return builder },
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

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => fakeSupabase() }))

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const P = ActivityProcessor as any

const FRESH = new Date().toISOString()
const ALICE = 'https://harmony.test/users/alice'
const MALLORY = 'https://evil.test/users/mallory'
const CAROL = 'https://remote.test/users/carol'
const DAVE = 'https://remote.test/users/dave'
const ERIN = 'https://third.test/users/erin'
const DIRECT_POST = '11111111-1111-4111-8111-111111111111'
const PUBLIC_POST = '22222222-2222-4222-8222-222222222222'
const R = '33333333-3333-4333-8333-333333333333'

const groupTarget = { 'harmony:type': 'harmony:GroupConversation', 'harmony:conversationId': 'conv-1' }
const participant = (convId: string, userId: string) =>
  ({ id: `cp-${convId}-${userId}`, conversation_id: convId, user_id: userId, left_at: null })
const leftAt = (userId: string) => tables.conversation_participants.find((p) => p.user_id === userId)?.left_at

beforeEach(() => {
  nextId = 1
  rpcResult = {}
  const profile = (id: string, username: string, federated_id: string, is_local = false) =>
    ({ id, username, is_local, federated_id, updated_at: FRESH })
  tables = {
    profiles: [
      profile('alice-id', 'alice', ALICE, true),
      profile('mallory-id', 'mallory', MALLORY),
      profile('carol-id', 'carol', CAROL),
      profile('dave-id', 'dave', DAVE),
      profile('erin-id', 'erin', ERIN),
    ],
    // A group created on this instance by alice, with carol and erin.
    conversations: [{ id: 'conv-1', type: 'group', name: 'family', created_by: 'alice-id', metadata: {} }],
    conversation_participants: [participant('conv-1', 'alice-id'), participant('conv-1', 'carol-id'), participant('conv-1', 'erin-id')],
    posts: [
      { id: DIRECT_POST, author_id: 'alice-id', visibility: 'direct', content: [{ type: 'text', text: 'private' }], ap_id: null },
      { id: PUBLIC_POST, author_id: 'alice-id', visibility: 'public', content: [{ type: 'text', text: 'hello' }], ap_id: null },
    ],
    post_interactions: [],
    messages: [],
    servers: [{ id: R, is_local_server: false, ap_id: `https://remote.test/servers/${R}`, name: 'remote' }],
  }
})

describe('group conversation Update', () => {
  const rename = (actor: string) => P.processUpdate({
    type: 'Update', actor, 'harmony:updateType': 'name',
    object: { ...groupTarget, name: 'renamed' },
  })

  it('a non-participant cannot rename the conversation', async () => {
    await rename(MALLORY)
    expect(tables.conversations[0].name).toBe('family')
  })

  it('a participant renames it', async () => {
    await rename(CAROL)
    expect(tables.conversations[0].name).toBe('renamed')
  })
})

describe('group conversation Remove', () => {
  const remove = (actor: string, object: string) =>
    P.processRemove({ type: 'Remove', actor, object, target: groupTarget })

  it('a non-participant removes nobody', async () => {
    await remove(MALLORY, ALICE)
    expect(leftAt('alice-id')).toBeNull()
  })

  it("a participant's instance cannot remove users of other instances", async () => {
    await remove(CAROL, ERIN)
    await remove(CAROL, ALICE)
    expect(leftAt('erin-id')).toBeNull()
    expect(leftAt('alice-id')).toBeNull()
  })

  it('a participant leaves, and its instance removes its own users', async () => {
    tables.conversation_participants.push(participant('conv-1', 'dave-id'))
    await remove(CAROL, DAVE)
    expect(leftAt('dave-id')).not.toBeNull()
    await remove(CAROL, CAROL)
    expect(leftAt('carol-id')).not.toBeNull()
  })

  it("the creator's instance removes anyone", async () => {
    tables.conversations[0].created_by = 'carol-id'
    await remove(CAROL, ERIN)
    expect(leftAt('erin-id')).not.toBeNull()
  })
})

describe('group DM by remote conversation id', () => {
  it('a non-participant naming an existing conversation posts nothing into it', async () => {
    rpcResult.get_or_create_federated_group_conversation = 'conv-1'
    await P.handleDirectMessage(
      { id: 'https://evil.test/notes/1', attributedTo: MALLORY, to: [ALICE, CAROL], 'harmony:conversationType': 'group', 'harmony:conversationId': 'remote-conv' },
      'mallory-id', [{ type: 'text', text: 'hi' }], null, { skipSpamGuard: true },
    )
    expect(tables.messages).toHaveLength(0)
  })

  it('a participant posts into it', async () => {
    rpcResult.get_or_create_federated_group_conversation = 'conv-1'
    await P.handleDirectMessage(
      { id: 'https://remote.test/notes/1', attributedTo: CAROL, to: [ALICE], 'harmony:conversationType': 'group', 'harmony:conversationId': 'remote-conv' },
      'carol-id', [{ type: 'text', text: 'hi' }], null, { skipSpamGuard: true },
    )
    expect(tables.messages).toEqual([expect.objectContaining({ conversation_id: 'conv-1', user_id: 'carol-id' })])
  })
})

describe('Announce and quote visibility', () => {
  it('an Announce of a direct post stores nothing', async () => {
    await P.processAnnounce({ type: 'Announce', id: 'https://evil.test/a/1', actor: MALLORY,
      object: `https://harmony.test/posts/${DIRECT_POST}` })
    expect(tables.posts.find((p) => p.ap_id === 'https://evil.test/a/1')).toBeUndefined()
    expect(tables.post_interactions).toHaveLength(0)
  })

  it('an Announce of a deleted post stores nothing', async () => {
    tables.posts[1].is_deleted = true
    await P.processAnnounce({ type: 'Announce', id: 'https://evil.test/a/2', actor: MALLORY,
      object: `https://harmony.test/posts/${PUBLIC_POST}` })
    expect(tables.posts.find((p) => p.ap_id === 'https://evil.test/a/2')).toBeUndefined()
  })

  it('an Announce of a public post is stored', async () => {
    await P.processAnnounce({ type: 'Announce', id: 'https://evil.test/a/3', actor: MALLORY,
      object: `https://harmony.test/posts/${PUBLIC_POST}` })
    const reblog = tables.posts.find((p) => p.ap_id === 'https://evil.test/a/3')
    expect(reblog?.reblog?.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('a quote of a direct post keeps the post and drops the quoted content', async () => {
    await P.processCreate({
      type: 'Create', id: 'https://evil.test/a/4', actor: MALLORY,
      object: {
        type: 'Note', id: 'https://evil.test/notes/4', attributedTo: MALLORY, content: '<p>look</p>',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        quoteUrl: `https://harmony.test/posts/${DIRECT_POST}`,
      },
    }, { skipSpamGuard: true })
    const quote = tables.posts.find((p) => p.ap_id === 'https://evil.test/notes/4')
    expect(quote).toBeDefined()
    expect(quote?.reblog).toBeUndefined()
    expect(quote?.metadata?.is_quote).toBeUndefined()
  })

  it('a quote of a public post embeds it', async () => {
    await P.processCreate({
      type: 'Create', id: 'https://evil.test/a/5', actor: MALLORY,
      object: {
        type: 'Note', id: 'https://evil.test/notes/5', attributedTo: MALLORY, content: '<p>look</p>',
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        quoteUrl: `https://harmony.test/posts/${PUBLIC_POST}`,
      },
    }, { skipSpamGuard: true })
    const quote = tables.posts.find((p) => p.ap_id === 'https://evil.test/notes/5')
    expect(quote?.reblog?.content).toEqual([{ type: 'text', text: 'hello' }])
  })
})

describe('Update Group', () => {
  const update = (actor: string) => P.processUpdate({
    type: 'Update', actor,
    object: { type: 'Group', id: `https://remote.test/servers/${R}`, name: 'renamed', 'harmony:ChatServer': true },
  })

  it('another actor on the server host is not the server', async () => {
    await update(DAVE)
    expect(tables.servers[0].name).toBe('remote')
  })

  it("the server's own actor updates it", async () => {
    await update(`https://remote.test/servers/${R}`)
    expect(tables.servers[0].name).toBe('renamed')
  })
})
