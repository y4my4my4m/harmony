import { describe, it, expect, vi, beforeEach } from 'vitest'

// The quote of a local post's Note (buildLocalNote) and the QuoteRequest its Create triggers
// (quoteRequestFor), FEP-044f.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}

function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let upsertRow: Row | null = null
      const rows = () => (tables[table] ??= [])
      const matched = () => rows().filter((row) => filters.every((f) => f(row)))
      const builder: any = {
        select() { return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder },
        upsert(row: Row) { upsertRow = row; return builder },
        maybeSingle: () => Promise.resolve({ data: matched()[0] ?? null, error: null }),
        single: () => {
          if (upsertRow) {
            const existing = rows().find((r) => r.quoted_post_id === upsertRow!.quoted_post_id && r.quoting_post_uri === upsertRow!.quoting_post_uri)
            const stored = existing ?? { id: '99999999-9999-9999-9999-999999999999', ...upsertRow }
            if (!existing) rows().push(stored)
            return Promise.resolve({ data: stored, error: null })
          }
          return Promise.resolve({ data: matched()[0] ?? null, error: null })
        },
        then: (resolve: any) => resolve({ data: matched(), error: null }),
      }
      return builder
    },
  }
}

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => fakeSupabase() }))

const { buildLocalNote, quoteRequestFor } = await import('../listeners/FederationHandlers.js')

const ALICE = { id: 'alice-id', username: 'alice' }
const REMOTE_QUOTED = '33333333-3333-3333-3333-333333333333'
const LOCAL_QUOTED = '44444444-4444-4444-4444-444444444444'
const BOB_NOTE = 'https://mastodon.test/users/bob/statuses/1'

const quotePost = (quoted: string, metadata: Row = {}) => ({
  id: '22222222-2222-2222-2222-222222222222',
  author_id: ALICE.id,
  visibility: 'public',
  created_at: '2026-10-12T00:00:00Z',
  content: [{ type: 'text', text: 'look' }],
  metadata: { is_quote: true, reblog_of: quoted, ...metadata },
})

beforeEach(() => {
  tables = {
    posts: [
      {
        id: REMOTE_QUOTED, ap_id: BOB_NOTE, author_id: 'bob-id', visibility: 'public', is_local: false, is_deleted: false,
        author: { username: 'bob', federated_id: 'https://mastodon.test/users/bob', inbox_url: 'https://mastodon.test/users/bob/inbox', shared_inbox_url: 'https://mastodon.test/inbox', is_local: false },
      },
      {
        id: LOCAL_QUOTED, ap_id: null, author_id: 'carol-id', visibility: 'public', is_local: true, is_deleted: false,
        author: { username: 'carol', federated_id: null, inbox_url: null, shared_inbox_url: null, is_local: true },
      },
    ],
    quote_authorizations: [],
    user_blocks: [],
    follows: [],
  }
})

describe('a local quote of a remote post', () => {
  it('names the target, carries no stamp until approved, and asks the author', async () => {
    const post = quotePost(REMOTE_QUOTED)
    const note = await buildLocalNote(post, ALICE)
    expect(note.quote).toBe(BOB_NOTE)
    expect(note.quoteAuthorization).toBeUndefined()

    const request = await quoteRequestFor(post, ALICE, note)
    expect(request?.inbox).toBe('https://mastodon.test/inbox')
    expect(request?.activity).toMatchObject({
      type: 'QuoteRequest',
      actor: 'https://harmony.test/users/alice',
      object: BOB_NOTE,
      instrument: { id: note.id, quote: BOB_NOTE },
    })
    expect(request?.activity.id).toBe(`${note.id}#quote-request`)
  })

  it('carries the stamp once approved, and asks no more', async () => {
    const post = quotePost(REMOTE_QUOTED, { quote_authorization: 'https://mastodon.test/users/bob/quote_authorizations/7' })
    const note = await buildLocalNote(post, ALICE)
    expect(note.quoteAuthorization).toBe('https://mastodon.test/users/bob/quote_authorizations/7')
    expect(await quoteRequestFor(post, ALICE, note)).toBeNull()
  })
})

describe('a local quote of a local post', () => {
  it('is stamped here under the quoted author', async () => {
    const note = await buildLocalNote(quotePost(LOCAL_QUOTED), ALICE)
    expect(note.quote).toBe(`https://harmony.test/posts/${LOCAL_QUOTED}`)
    expect(note.quoteAuthorization).toBe('https://harmony.test/users/carol/quote_authorizations/99999999-9999-9999-9999-999999999999')
    expect(tables.quote_authorizations[0]).toMatchObject({ quoted_post_id: LOCAL_QUOTED, quoting_post_uri: note.id })
    expect(await quoteRequestFor(quotePost(LOCAL_QUOTED), ALICE, note)).toBeNull()
  })

  it('is not stamped when the quoted author blocks the quoter', async () => {
    tables.user_blocks.push({ id: 'b', blocker_id: 'carol-id', blocked_user_id: ALICE.id })
    const note = await buildLocalNote(quotePost(LOCAL_QUOTED), ALICE)
    expect(note.quoteAuthorization).toBeUndefined()
  })

  it('needs no stamp for a self-quote', async () => {
    tables.posts[1].author_id = ALICE.id
    const note = await buildLocalNote(quotePost(LOCAL_QUOTED), ALICE)
    expect(note.quoteAuthorization).toBeUndefined()
    expect(tables.quote_authorizations).toHaveLength(0)
  })
})
