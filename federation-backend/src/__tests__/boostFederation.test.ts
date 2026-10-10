import { describe, it, expect, vi, beforeEach } from 'vitest'

// A local boost federates as Announce of the original and is retracted by
// Undo(Announce), to the booster's followers and the original's remote author.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', USE_BULLMQ_QUEUE: true },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichPostLinkPreviews: vi.fn().mockResolvedValue(false),
}))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: () => false },
}))

type Row = Record<string, any>
const tables: Record<string, Row[]> = {}
const updates: Array<{ table: string; patch: Row }> = []

function chain(table: string) {
  const filters: Array<(row: Row) => boolean> = []
  let patch: Row | null = null
  const rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
  const c: any = {
    select: () => c,
    eq: (col: string, val: any) => { filters.push((row) => row[col] === val); return c },
    in: (col: string, vals: any[]) => { filters.push((row) => vals.includes(row[col])); return c },
    or: () => Promise.resolve({ data: [], error: null }),
    update: (p: Row) => { patch = p; updates.push({ table, patch: p }); return c },
    single: () => {
      const found = rows()
      return Promise.resolve(found.length === 1 ? { data: found[0], error: null } : { data: null, error: { message: 'none' } })
    },
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    then: (resolve: any) => {
      if (patch) rows().forEach((row) => Object.assign(row, patch))
      return resolve({ data: rows(), error: null })
    },
  }
  return c
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
  }),
}))

const followerInboxes = vi.fn()
const deliverEach = vi.fn().mockResolvedValue(undefined)
const broadcastToFollowers = vi.fn().mockResolvedValue(undefined)
const sendToInbox = vi.fn().mockResolvedValue(undefined)
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { followerInboxes, deliverEach, broadcastToFollowers, sendToInbox },
}))

const { handlePostJob } = await import('../queue/handlers/postHandler.js')

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const BOOSTER = { id: 'booster', username: 'poring', is_local: true }
const AUTHOR = {
  id: 'remote-author',
  username: 'bob',
  is_local: false,
  federated_id: 'https://mastodon.test/users/bob',
  inbox_url: 'https://mastodon.test/users/bob/inbox',
  shared_inbox_url: 'https://mastodon.test/inbox',
}
const ORIGINAL = { id: 'orig-1', ap_id: 'https://mastodon.test/users/bob/statuses/1', author_id: AUTHOR.id }

function boostRow(extra: Row = {}): Row {
  return {
    id: 'boost-1',
    author_id: BOOSTER.id,
    ap_id: 'https://harmony.test/activities/11111111-2222-4333-8444-555555555555',
    ap_type: 'Announce',
    visibility: 'public',
    created_at: '2026-10-11T00:00:00.000Z',
    content: [{ type: 'text', text: 'the original text' }],
    metadata: { reblog_of: ORIGINAL.id, original_author: AUTHOR.id },
    ...extra,
  }
}

const delivered = () => deliverEach.mock.calls.flatMap(([items]) => items as Array<{ inbox: string; activity: any }>)

beforeEach(() => {
  tables.profiles = [BOOSTER, AUTHOR].map((p) => ({ ...p }))
  tables.posts = [{ ...ORIGINAL }, boostRow()]
  updates.length = 0
  followerInboxes.mockReset().mockResolvedValue(['https://misskey.test/inbox'])
  deliverEach.mockClear()
  broadcastToFollowers.mockClear()
  sendToInbox.mockClear()
})

describe('boost federation', () => {
  it('sends Announce of the original, not Create, to followers and the original author', async () => {
    await handlePostJob({ type: 'create', post_id: 'boost-1', author_id: BOOSTER.id })

    const items = delivered()
    expect(items.map((i) => i.inbox)).toEqual(['https://misskey.test/inbox', AUTHOR.shared_inbox_url])
    const announce = items[0].activity
    expect(announce).toMatchObject({
      type: 'Announce',
      id: boostRow().ap_id,
      actor: 'https://harmony.test/users/poring',
      object: ORIGINAL.ap_id,
      to: [PUBLIC],
      cc: ['https://harmony.test/users/poring/followers', AUTHOR.federated_id],
    })
    expect(broadcastToFollowers).not.toHaveBeenCalled()
    expect(sendToInbox).not.toHaveBeenCalled()
    expect(tables.posts.find((p) => p.id === 'boost-1')!.federation_status).toBe('completed')
  })

  it('addresses an unlisted boost to followers, Public in cc', async () => {
    tables.posts[1].visibility = 'unlisted'
    await handlePostJob({ type: 'create', post_id: 'boost-1', author_id: BOOSTER.id })

    const announce = delivered()[0].activity
    expect(announce.to).toEqual(['https://harmony.test/users/poring/followers'])
    expect(announce.cc).toEqual([PUBLIC, AUTHOR.federated_id])
  })

  it('delivers once to an author whose inbox a follower already shares', async () => {
    followerInboxes.mockResolvedValue([AUTHOR.shared_inbox_url])
    await handlePostJob({ type: 'create', post_id: 'boost-1', author_id: BOOSTER.id })
    expect(delivered().map((i) => i.inbox)).toEqual([AUTHOR.shared_inbox_url])
  })

  it('gives a boost without ap_id the id its Announce goes out under', async () => {
    tables.posts[1].ap_id = null
    await handlePostJob({ type: 'create', post_id: 'boost-1', author_id: BOOSTER.id })

    expect(delivered()[0].activity.id).toBe('https://harmony.test/activities/boost-1')
    expect(tables.posts[1].ap_id).toBe('https://harmony.test/activities/boost-1')
  })

  it('retracts with Undo(Announce) embedding the Announce id, not Delete', async () => {
    tables.posts[1].is_deleted = true
    await handlePostJob({ type: 'delete', post_id: 'boost-1', author_id: BOOSTER.id })

    const items = delivered()
    expect(items.map((i) => i.inbox)).toEqual(['https://misskey.test/inbox', AUTHOR.shared_inbox_url])
    const undo = items[0].activity
    expect(undo.type).toBe('Undo')
    expect(undo.actor).toBe('https://harmony.test/users/poring')
    expect(undo.id).toBe(`${boostRow().ap_id}/undo`)
    expect(undo.object).toMatchObject({ type: 'Announce', id: boostRow().ap_id, object: ORIGINAL.ap_id })
    expect(undo.object['@context']).toBeUndefined()
  })

  it('names a local original by its /posts URL and delivers to followers only', async () => {
    tables.posts[0] = { id: 'orig-1', ap_id: null, author_id: BOOSTER.id }
    await handlePostJob({ type: 'create', post_id: 'boost-1', author_id: BOOSTER.id })

    const items = delivered()
    expect(items.map((i) => i.inbox)).toEqual(['https://misskey.test/inbox'])
    expect(items[0].activity.object).toBe('https://harmony.test/posts/orig-1')
    expect(items[0].activity.cc).toEqual(['https://harmony.test/users/poring/followers'])
  })

  it('federates nothing when the original is gone', async () => {
    tables.posts = [boostRow()]
    await handlePostJob({ type: 'create', post_id: 'boost-1', author_id: BOOSTER.id })
    expect(deliverEach).not.toHaveBeenCalled()
    expect(tables.posts[0].federation_status).toBe('skipped')
  })

  it('sends a quote as a Create of its own Note', async () => {
    tables.posts[1] = boostRow({
      ap_type: 'Announce',
      content: [{ type: 'text', text: 'my take' }],
      metadata: { reblog_of: ORIGINAL.id, is_quote: true },
    })
    await handlePostJob({ type: 'create', post_id: 'boost-1', author_id: BOOSTER.id })

    expect(deliverEach).not.toHaveBeenCalled()
    expect(broadcastToFollowers).toHaveBeenCalledTimes(1)
    const create = broadcastToFollowers.mock.calls[0][1]
    expect(create.type).toBe('Create')
    expect(create.object.quoteUrl).toBe(ORIGINAL.ap_id)
  })
})
