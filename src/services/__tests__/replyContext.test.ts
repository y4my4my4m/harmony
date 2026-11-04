/**
 * services/replyContext.ts: the parent a reply's card previews, read from an embedded row and,
 * for cards whose read had no embed, in one request per tick; a remote parent that is not
 * stored goes to the federation backend once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const reads = vi.hoisted(() => ({ calls: [] as Array<{ select: string; ids: string[] }>, rows: [] as any[] }))
vi.mock('@/supabase', () => ({
  supabase: {
    from: () => ({
      select: (select: string) => ({
        in: (_col: string, ids: string[]) => {
          reads.calls.push({ select, ids })
          return Promise.resolve({ data: reads.rows.filter((r) => ids.includes(r.id)), error: null })
        },
      }),
    }),
    auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'tok' } } }) },
  },
}))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({ federationApiUrl: '/api/federation' }) }))

import {
  REPLY_PARENT_EMBED, replyContextCache, replyContextOf, replySnippet, requestReplyContext,
  resetReplyContextCache, withReplyContext,
} from '../replyContext'

const author = { id: 'a1', username: 'toonie', display_name: 'Toonie', avatar_url: '/t.webp', domain: 'meow.example', is_local: false }
const parent = (extra: Record<string, unknown> = {}) => ({
  id: 'p1',
  content: [
    { type: 'mention', username: 'moshboy', domain: 'mastodon.example', isLocal: false },
    { type: 'text', text: '  is this    the right place? ' },
  ],
  content_warning: null,
  visibility: 'public',
  is_deleted: false,
  media_attachments: [],
  created_at: '2026-11-01T00:00:00Z',
  author,
  ...extra,
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetReplyContextCache()
  reads.calls.length = 0
  reads.rows = []
  vi.unstubAllGlobals()
})

describe('replySnippet', () => {
  it('drops the leading mentions and collapses whitespace', () => {
    expect(replySnippet(parent().content)).toBe('is this the right place?')
  })

  it('keeps a post made only of mentions', () => {
    expect(replySnippet([{ type: 'mention', username: 'a', isLocal: true }])).toBe('@a')
  })

  it('cuts a long post at 280 characters', () => {
    const text = replySnippet([{ type: 'text', text: 'x'.repeat(1000) }])
    expect(text).toHaveLength(280)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('replyContextOf', () => {
  it('reads a readable parent', () => {
    const ctx = replyContextOf({ id: 'r1', in_reply_to: 'p1', reply_parent: parent() })
    expect(ctx).toMatchObject({ id: 'p1', state: 'post', content_preview: 'is this the right place?', author: { username: 'toonie' } })
  })

  it('reads a deleted parent without its content', () => {
    const ctx = replyContextOf({ id: 'r1', in_reply_to: 'p1', reply_parent: parent({ is_deleted: true }) })
    expect(ctx).toEqual({ id: 'p1', state: 'deleted' })
  })

  it('reads a parent RLS withholds as hidden, with no author', () => {
    expect(replyContextOf({ id: 'r1', in_reply_to: 'p1', reply_parent: null })).toEqual({ id: 'p1', state: 'hidden' })
  })

  it('reads a parent that is not stored as remote', () => {
    const url = 'https://meow.example/users/toonie/statuses/1'
    expect(replyContextOf({ id: 'r1', in_reply_to: null, metadata: { in_reply_to_ap_url: url } }))
      .toEqual({ id: null, state: 'remote', url })
    expect(replyContextOf({ id: 'r1', in_reply_to: null, metadata: {} })).toBeNull()
  })

  it('moves the embed to reply_context', () => {
    const row = withReplyContext({ id: 'r1', in_reply_to: 'p1', reply_parent: parent() })
    expect('reply_parent' in row).toBe(false)
    expect(row.reply_context?.id).toBe('p1')
    const plain = { id: 'r2', in_reply_to: 'p1' }
    expect(withReplyContext(plain)).toBe(plain)
  })
})

describe('requestReplyContext', () => {
  it('reads every card of one tick in one request', async () => {
    reads.rows = [
      { id: 'r1', in_reply_to: 'p1', metadata: {}, reply_parent: parent() },
      { id: 'r2', in_reply_to: 'p2', metadata: {}, reply_parent: null },
    ]
    requestReplyContext({ id: 'r1', in_reply_to: 'p1' })
    requestReplyContext({ id: 'r2', in_reply_to: 'p2' })
    requestReplyContext({ id: 'r3', in_reply_to: 'p3' })
    requestReplyContext({ id: 'r1', in_reply_to: 'p1' })
    await tick()
    await tick()
    expect(reads.calls).toHaveLength(1)
    expect(reads.calls[0].ids).toEqual(['r1', 'r2', 'r3'])
    expect(reads.calls[0].select).toContain(REPLY_PARENT_EMBED)
    expect(replyContextCache.get('r1')?.state).toBe('post')
    expect(replyContextCache.get('r2')).toEqual({ id: 'p2', state: 'hidden' })
    expect(replyContextCache.get('r3')).toBeNull()
  })

  it('reads nothing for a card whose read embedded the parent', async () => {
    requestReplyContext({ id: 'r1', in_reply_to: 'p1', reply_context: { id: 'p1', state: 'post' } })
    await tick()
    expect(reads.calls).toHaveLength(0)
  })

  it('asks the backend once for remote parents, then reads the linked replies', async () => {
    const url = 'https://meow.example/users/toonie/statuses/1'
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ results: { r1: 'linked', r2: 'unavailable' } }) }))
    vi.stubGlobal('fetch', fetchMock)
    reads.rows = [{ id: 'r1', in_reply_to: 'p1', metadata: { in_reply_to_ap_url: url }, reply_parent: parent() }]

    requestReplyContext({ id: 'r1', in_reply_to: null, metadata: { in_reply_to_ap_url: url } })
    requestReplyContext({ id: 'r2', reply_context: { id: null, state: 'remote', url } })
    await tick()
    await vi.waitFor(() => expect(replyContextCache.get('r1')?.state).toBe('post'))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(target).toBe('/api/federation/resolve-reply-parents')
    expect(JSON.parse(String(init.body))).toEqual({ post_ids: ['r1', 'r2'] })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(reads.calls.map((c) => c.ids)).toEqual([['r1']])
    expect(replyContextCache.has('r2')).toBe(false)

    requestReplyContext({ id: 'r2', reply_context: { id: null, state: 'remote', url } })
    await tick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
