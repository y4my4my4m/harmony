import { describe, it, expect, vi, beforeEach } from 'vitest'

// FEP-044f quote approvals (Mastodon 4.5): QuoteRequest for a local post, and the answer to
// one this instance sent for a local quote.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let nextId = 1

function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let patch: Row | null = null
      let upsertRow: Row | null = null
      const rows = () => (tables[table] ??= [])
      const matched = () => rows().filter((row) => filters.every((f) => f(row)))
      const builder: any = {
        select() { return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        update(p: Row) { patch = p; return builder },
        upsert(row: Row) { upsertRow = row; return builder },
        maybeSingle: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
        single: () => {
          if (upsertRow) {
            const existing = rows().find((r) => r.quoted_post_id === upsertRow!.quoted_post_id && r.quoting_post_uri === upsertRow!.quoting_post_uri)
            const stored = existing ?? { id: `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`, ...upsertRow }
            if (!existing) rows().push(stored)
            return Promise.resolve({ data: stored, error: null })
          }
          return Promise.resolve({ data: matched()[0] ?? null, error: null })
        },
        then(resolve: any) {
          if (patch) matched().forEach((row) => Object.assign(row, patch))
          return resolve({ data: null, error: null })
        },
      }
      return builder
    },
  }
}

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => fakeSupabase() }))

const Q = await import('../activitypub/quoteAuthorization.js')

const BOB = 'https://mastodon.test/users/bob'
const BOB_NOTE = 'https://mastodon.test/users/bob/statuses/1'
const POST = '11111111-1111-1111-1111-111111111111'

function seed(visibility: string) {
  tables = {
    posts: [{ id: POST, ap_id: `https://harmony.test/posts/${POST}`, author_id: 'alice-id', visibility, is_deleted: false, is_local: true }],
    profiles: [
      { id: 'alice-id', username: 'alice' },
      { id: 'bob-id', username: 'bob', inbox_url: 'https://mastodon.test/users/bob/inbox' },
    ],
    follows: [],
    user_blocks: [],
    quote_authorizations: [],
  }
}

const sent: Array<{ inbox: string; activity: any; sender: string }> = []
const deps = {
  resolveProfile: async (url: string) => (url === BOB ? { id: 'bob-id' } : null),
  sendToInbox: async (inbox: string, activity: any, sender: string) => { sent.push({ inbox, activity, sender }) },
}

const request = (over: Record<string, any> = {}) => ({
  type: 'QuoteRequest',
  id: `${BOB_NOTE}/quote`,
  actor: BOB,
  object: `https://harmony.test/posts/${POST}`,
  instrument: { type: 'Note', id: BOB_NOTE, attributedTo: BOB, quote: `https://harmony.test/posts/${POST}` },
  ...over,
})

beforeEach(() => {
  sent.length = 0
  nextId = 1
})

describe('QuoteRequest for a local post', () => {
  it('accepts a quote of a public post with a stamp served under the author', async () => {
    seed('public')
    await Q.processQuoteRequest(request(), deps)

    expect(sent).toHaveLength(1)
    const [{ inbox, activity, sender }] = sent
    expect(inbox).toBe('https://mastodon.test/users/bob/inbox')
    expect(sender).toBe('alice-id')
    expect(activity).toMatchObject({
      type: 'Accept',
      actor: 'https://harmony.test/users/alice',
      to: BOB,
      object: { type: 'QuoteRequest', id: `${BOB_NOTE}/quote`, actor: BOB, object: `https://harmony.test/posts/${POST}`, instrument: BOB_NOTE },
    })
    const stamp = tables.quote_authorizations[0]
    expect(stamp).toMatchObject({ quoted_post_id: POST, quoting_post_uri: BOB_NOTE, quoting_actor_uri: BOB })
    expect(activity.result).toBe(`https://harmony.test/users/alice/quote_authorizations/${stamp.id}`)

    expect(Q.quoteAuthorizationObject(stamp as any, tables.posts[0] as any, 'alice')).toMatchObject({
      type: 'QuoteAuthorization',
      id: activity.result,
      attributedTo: 'https://harmony.test/users/alice',
      interactingObject: BOB_NOTE,
      interactionTarget: `https://harmony.test/posts/${POST}`,
    })
  })

  it('answers a repeated request with the same stamp', async () => {
    seed('unlisted')
    await Q.processQuoteRequest(request(), deps)
    await Q.processQuoteRequest(request(), deps)
    expect(tables.quote_authorizations).toHaveLength(1)
    expect(sent[0].activity.result).toBe(sent[1].activity.result)
  })

  it('rejects a quote of a direct post, and of any post by an account the author blocks', async () => {
    seed('direct')
    await Q.processQuoteRequest(request(), deps)
    expect(sent[0].activity.type).toBe('Reject')
    expect(sent[0].activity.result).toBeUndefined()

    seed('public')
    tables.user_blocks.push({ id: 'b1', blocker_id: 'alice-id', blocked_user_id: 'bob-id' })
    await Q.processQuoteRequest(request(), deps)
    expect(sent[1].activity.type).toBe('Reject')
    expect(tables.quote_authorizations).toHaveLength(0)
  })

  it('lets only accepted followers quote a followers-only post', async () => {
    seed('followers')
    await Q.processQuoteRequest(request(), deps)
    expect(sent[0].activity.type).toBe('Reject')

    tables.follows.push({ id: 'f1', follower_id: 'bob-id', following_id: 'alice-id', status: 'accepted' })
    await Q.processQuoteRequest(request(), deps)
    expect(sent[1].activity.type).toBe('Accept')
  })

  it('ignores a request whose quote post someone else wrote, or that names no local post', async () => {
    seed('public')
    await Q.processQuoteRequest(request({ instrument: { type: 'Note', id: BOB_NOTE, attributedTo: 'https://mastodon.test/users/eve' } }), deps)
    await Q.processQuoteRequest(request({ object: 'https://elsewhere.test/posts/1' }), deps)
    expect(sent).toHaveLength(0)
  })
})

describe('answer to a QuoteRequest this instance sent', () => {
  const QUOTE = '22222222-2222-2222-2222-222222222222'
  const QUOTED = '33333333-3333-3333-3333-333333333333'
  const answer = (type: 'Accept' | 'Reject', over: Record<string, any> = {}) => ({
    type,
    actor: BOB,
    object: { type: 'QuoteRequest', id: `https://harmony.test/posts/${QUOTE}#quote-request`, actor: 'https://harmony.test/users/alice', object: `${BOB_NOTE}`, instrument: `https://harmony.test/posts/${QUOTE}` },
    result: 'https://mastodon.test/users/bob/quote_authorizations/9',
    ...over,
  })

  beforeEach(() => {
    tables = {
      posts: [
        { id: QUOTE, author_id: 'alice-id', is_local: true, metadata: { is_quote: true, reblog_of: QUOTED } },
        { id: QUOTED, author: { federated_id: BOB } },
      ],
    }
  })

  it('records the stamp from the quoted author and asks for an Update', async () => {
    expect(Q.answersQuoteRequest(answer('Accept'))).toBe(true)
    expect(await Q.processQuoteAnswer(answer('Accept'), true)).toEqual({ postId: QUOTE, authorId: 'alice-id' })
    expect(tables.posts[0].metadata.quote_authorization).toBe('https://mastodon.test/users/bob/quote_authorizations/9')
    expect(await Q.processQuoteAnswer(answer('Accept'), true)).toBeNull()
  })

  it('ignores an answer from anyone but the quoted author, or a stamp on another host', async () => {
    expect(await Q.processQuoteAnswer(answer('Accept', { actor: 'https://mastodon.test/users/eve' }), true)).toBeNull()
    expect(await Q.processQuoteAnswer(answer('Accept', { result: 'https://evil.test/stamps/1' }), true)).toBeNull()
    expect(tables.posts[0].metadata.quote_authorization).toBeUndefined()
  })

  it('marks a rejected quote', async () => {
    await Q.processQuoteAnswer(answer('Accept'), true)
    expect(await Q.processQuoteAnswer(answer('Reject'), false)).toEqual({ postId: QUOTE, authorId: 'alice-id' })
    expect(tables.posts[0].metadata).toMatchObject({ quote_state: 'rejected' })
    expect(tables.posts[0].metadata.quote_authorization).toBeUndefined()
  })

  it('tells quote answers from follow answers', () => {
    expect(Q.answersQuoteRequest({ type: 'Accept', object: { type: 'Follow' } })).toBe(false)
    expect(Q.answersQuoteRequest({ type: 'Accept', object: 'https://harmony.test/activities/follow/1' })).toBe(false)
    expect(Q.answersQuoteRequest({ type: 'Accept', object: `https://harmony.test/posts/${QUOTE}#quote-request` })).toBe(true)
  })
})

describe('localPostIdFromUri', () => {
  it('reads AP ids and post pages on this host only', () => {
    expect(Q.localPostIdFromUri(`https://harmony.test/posts/${POST}`)).toBe(POST)
    expect(Q.localPostIdFromUri(`https://harmony.test/social/post/${POST}`)).toBe(POST)
    expect(Q.localPostIdFromUri(`https://other.test/posts/${POST}`)).toBeNull()
    expect(Q.localPostIdFromUri('not a url')).toBeNull()
  })
})
