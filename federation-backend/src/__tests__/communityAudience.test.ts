import { describe, it, expect, vi, beforeEach } from 'vitest'

// FEP-1b12: a local reply in a thread posted to a Group (a Lemmy community) names the Group as
// its audience and cc's it, read from posts.metadata.ap_audience of its remote parent or root.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony' },
  config: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const rows: Record<string, any[]> = {}

function query(table: string) {
  const filters: Array<(row: any) => boolean> = []
  const all = () => (rows[table] ?? []).filter((r) => filters.every((f) => f(r)))
  const q: any = {
    select: () => q,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
    in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
    maybeSingle: async () => ({ data: all()[0] ?? null, error: null }),
    single: async () => ({ data: all()[0] ?? null, error: null }),
    then: (resolve: any) => resolve({ data: all(), error: null }),
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from: (t: string) => query(t), rpc: async () => ({ data: false, error: null }) }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { buildLocalNote, createPostActivity } = await import('../listeners/FederationHandlers.js')
const { noteAudience } = await import('../activitypub/converters/fromActivityPub.js')

const GROUP = 'https://lemmy.test/c/rust'
const PAGE = 'f0230000-0000-0000-0000-000000000001'
const COMMENT = 'f0230000-0000-0000-0000-000000000002'
const LOCAL_REPLY = 'f0230000-0000-0000-0000-000000000003'
const ALICE = { id: 'alice-id', username: 'alice', domain: 'harmony.test', is_local: true }
const post = (id: string, extra: Record<string, unknown> = {}) => ({
  id, ap_id: null, author_id: ALICE.id, is_local: true, is_deleted: false, visibility: 'public',
  conversation_root_id: null, in_reply_to: null, created_at: '2026-11-07T00:00:00Z',
  content: [{ type: 'text', text: 'hi' }], media_attachments: [], metadata: {}, ...extra,
})
const reply = (parent: string, extra: Record<string, unknown> = {}) =>
  post('f0230000-0000-0000-0000-000000000099', { in_reply_to: parent, conversation_root_id: PAGE, ...extra })

beforeEach(() => {
  rows.profiles = [ALICE]
  rows.posts = [
    post(PAGE, { is_local: false, ap_id: 'https://lemmy.test/post/1', metadata: { ap_audience: GROUP } }),
    post(COMMENT, { is_local: false, ap_id: 'https://other.test/comment/2', in_reply_to: PAGE, conversation_root_id: PAGE, metadata: {} }),
  ]
})

describe('community audience', () => {
  it('names the community of the remote parent and cc\'s it', async () => {
    rows.posts[1].metadata = { ap_audience: GROUP }
    const note = await buildLocalNote(reply(COMMENT), ALICE)
    expect(note.audience).toBe(GROUP)
    expect(note.cc).toContain(GROUP)
    expect(note.to).toContain('https://www.w3.org/ns/activitystreams#Public')
    expect(note.cc.filter((a: string) => a === GROUP)).toHaveLength(1)
  })

  it('falls back to the remote root when the parent names none', async () => {
    const note = await buildLocalNote(reply(COMMENT), ALICE)
    expect(note.audience).toBe(GROUP)
    expect(note.cc).toContain(GROUP)
  })

  it('reads no audience off a local row', async () => {
    rows.posts.push(post(LOCAL_REPLY, { metadata: { ap_audience: 'https://elsewhere.test/c/x' } }))
    rows.posts[0].is_local = true
    const note = await buildLocalNote(reply(LOCAL_REPLY), ALICE)
    expect(note.audience).toBeUndefined()
  })

  it('is absent from a followers-only reply and from a post outside a community thread', async () => {
    expect((await buildLocalNote(reply(COMMENT, { visibility: 'followers' }), ALICE)).audience).toBeUndefined()
    expect((await buildLocalNote(post(LOCAL_REPLY), ALICE)).audience).toBeUndefined()
  })

  it('is carried by the Create', async () => {
    const activity = await createPostActivity(reply(COMMENT), ALICE)
    expect(activity.audience).toBe(GROUP)
    expect(activity.cc).toContain(GROUP)
    expect(activity.object.audience).toBe(GROUP)
  })

  it('is read off an inbound object as a reference, an object or the first of an array', () => {
    expect(noteAudience({ audience: GROUP })).toBe(GROUP)
    expect(noteAudience({ audience: { id: GROUP, type: 'Group' } })).toBe(GROUP)
    expect(noteAudience({ audience: [GROUP, 'https://lemmy.test/c/other'] })).toBe(GROUP)
    expect(noteAudience({ audience: 'urn:x' })).toBeNull()
    expect(noteAudience({})).toBeNull()
  })
})
