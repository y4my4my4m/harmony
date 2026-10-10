import { describe, it, expect, vi, beforeEach } from 'vitest'

// A remote user mentioned before this instance stored them is resolved through
// WebFinger when the post federates: the Note's Mention tag names the real actor
// id and the mentionee's inbox receives the Create.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', USE_BULLMQ_QUEUE: true },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichPostLinkPreviews: vi.fn().mockResolvedValue(false),
}))
const blocked = new Set<string>()
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: (d: string) => blocked.has(d) },
}))

type Row = Record<string, any>
const tables: Record<string, Row[]> = {}

function chain(table: string) {
  const filters: Array<(row: Row) => boolean> = []
  let patch: Row | null = null
  const rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
  const c: any = {
    select: () => c,
    eq: (col: string, val: any) => { filters.push((row) => row[col] === val); return c },
    in: (col: string, vals: any[]) => { filters.push((row) => vals.includes(row[col])); return c },
    // and(username.eq."x",domain.eq."y"),... as resolveMentionRecipients writes it.
    or: (expr: string) => {
      const pairs = [...expr.matchAll(/username\.eq\."([^"]*)",domain\.eq\."([^"]*)"/g)].map((m) => [m[1], m[2]])
      filters.push((row) => pairs.some(([u, d]) => row.username === u && row.domain === d))
      return c
    },
    update: (p: Row) => { patch = p; return c },
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

const broadcastToFollowers = vi.fn().mockResolvedValue(undefined)
const sendToInbox = vi.fn().mockResolvedValue(undefined)
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { broadcastToFollowers, sendToInbox },
}))

const HBY = {
  id: '9a9a9a9a-0000-4000-8000-000000000001',
  username: 'hby',
  domain: 'misskey.test',
  is_local: false,
  federated_id: 'https://misskey.test/users/9xyz',
  inbox_url: 'https://misskey.test/users/9xyz/inbox',
}
const resolveRemoteAccount = vi.fn(async (username: string, domain: string) => {
  if (username !== 'hby' || domain !== 'misskey.test') {
    return { ok: false, status: 404, body: { error: 'not found' } }
  }
  tables.profiles.push({ ...HBY })
  return { ok: true, user: { ...HBY }, actor: { id: HBY.federated_id } }
})
vi.mock('../activitypub/ActorService.js', () => ({ resolveRemoteAccount }))

const { handlePostJob } = await import('../queue/handlers/postHandler.js')

const AUTHOR = { id: 'author', username: 'poring', domain: 'harmony.test', is_local: true }
const unresolvedHby = {
  type: 'mention', userId: 'unresolved-hby@misskey.test', username: 'hby', domain: 'misskey.test', isLocal: false,
}

beforeEach(() => {
  tables.profiles = [{ ...AUTHOR }]
  tables.posts = [{
    id: 'post-1',
    author_id: AUTHOR.id,
    ap_id: 'https://harmony.test/posts/post-1',
    visibility: 'public',
    created_at: '2026-10-11T00:00:00.000Z',
    content: [unresolvedHby, { type: 'text', text: ' hello' }],
    metadata: {},
  }]
  blocked.clear()
  resolveRemoteAccount.mockClear()
  broadcastToFollowers.mockClear()
  sendToInbox.mockClear()
})

describe('mention delivery', () => {
  it('resolves an uncached mentionee through WebFinger and delivers to its inbox', async () => {
    await handlePostJob({ type: 'create', post_id: 'post-1', author_id: AUTHOR.id })

    expect(resolveRemoteAccount).toHaveBeenCalledWith('hby', 'misskey.test')
    expect(sendToInbox).toHaveBeenCalledTimes(1)
    const [inbox, create] = sendToInbox.mock.calls[0]
    expect(inbox).toBe(HBY.inbox_url)
    expect(create.type).toBe('Create')
    expect(create.object.tag).toContainEqual(expect.objectContaining({ type: 'Mention', href: HBY.federated_id }))
    expect(create.object.cc).toContain(HBY.federated_id)
    expect(tables.posts[0].federation_status).toBe('completed')
  })

  it('uses the stored profile without a lookup when the mentionee is known', async () => {
    tables.profiles.push({ ...HBY })
    await handlePostJob({ type: 'create', post_id: 'post-1', author_id: AUTHOR.id })

    expect(resolveRemoteAccount).not.toHaveBeenCalled()
    expect(sendToInbox.mock.calls[0][0]).toBe(HBY.inbox_url)
  })

  it('delivers a direct post to a mentionee resolved at delivery', async () => {
    tables.posts[0].visibility = 'direct'
    await handlePostJob({ type: 'create', post_id: 'post-1', author_id: AUTHOR.id })

    expect(broadcastToFollowers).not.toHaveBeenCalled()
    expect(sendToInbox.mock.calls[0][0]).toBe(HBY.inbox_url)
    expect(sendToInbox.mock.calls[0][1].object.to).toContain(HBY.federated_id)
  })

  it('skips a handle that does not resolve and still federates the post', async () => {
    tables.posts[0].content = [
      { type: 'mention', userId: 'unresolved-ghost@nowhere.test', username: 'ghost', domain: 'nowhere.test', isLocal: false },
    ]
    await handlePostJob({ type: 'create', post_id: 'post-1', author_id: AUTHOR.id })

    expect(resolveRemoteAccount).toHaveBeenCalledWith('ghost', 'nowhere.test')
    expect(sendToInbox).not.toHaveBeenCalled()
    expect(broadcastToFollowers).toHaveBeenCalledTimes(1)
  })

  it('never looks up a blocked instance or a bridged Discord user', async () => {
    blocked.add('misskey.test')
    tables.posts[0].content = [
      unresolvedHby,
      { type: 'mention', userId: '123', username: 'dis', domain: 'discord.com', isLocal: false, isBridged: true },
    ]
    await handlePostJob({ type: 'create', post_id: 'post-1', author_id: AUTHOR.id })

    expect(resolveRemoteAccount).not.toHaveBeenCalled()
    expect(sendToInbox).not.toHaveBeenCalled()
  })

  it('resolves mentionees of an edit before sending the Update', async () => {
    await handlePostJob({ type: 'update', post_id: 'post-1', author_id: AUTHOR.id })

    const [inbox, update] = sendToInbox.mock.calls[0]
    expect(inbox).toBe(HBY.inbox_url)
    expect(update.type).toBe('Update')
    expect(update.object.tag).toContainEqual(expect.objectContaining({ type: 'Mention', href: HBY.federated_id }))
  })
})
