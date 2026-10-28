import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// Thread routes (threadRoutes.ts): who reads which thread.
//
// Servers: PUB (public) and PRIV (private), each with an OPEN channel @everyone can view and
// a RESTRICTED one only `vip` can view, one thread in each; and REMOTE, a remote server's
// copy. Callers as in groupAccessRoutes.test.ts: unsigned, a bad signature, a signed
// stranger, an instance actor, a member on a blocked instance, `nop` (member without the
// restricted channels) and `vip` (member with them).
// public.federation_group_access is emulated from the same table.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', REQUIRE_VALID_SIGNATURES: true },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: (host: string) => host === 'blocked.test' },
}))

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PUB = uuid(0xa001)
const PRIV = uuid(0xa002)
const REMOTE = uuid(0xa003)
const PUB_OPEN = uuid(0xc001)
const PUB_RESTRICTED = uuid(0xc002)
const PRIV_OPEN = uuid(0xc003)
const PRIV_RESTRICTED = uuid(0xc004)
const REMOTE_CHANNEL = uuid(0xc005)
// Public, federation off, vip a member from when it was on.
const CLOSED = uuid(0xa004)
const CLOSED_OPEN = uuid(0xc006)
const CLOSED_THREAD = uuid(0xe007)
const UNKNOWN = uuid(0xffff)

const THREAD_IN: Record<string, string> = {
  [PUB_OPEN]: uuid(0xe001),
  [PUB_RESTRICTED]: uuid(0xe002),
  [PRIV_OPEN]: uuid(0xe003),
  [PRIV_RESTRICTED]: uuid(0xe004),
}
const REMOTE_THREAD = uuid(0xe005)
const FOREIGN_THREAD = uuid(0xe006) // in PUB_OPEN, opened on another instance

const ACTORS = {
  stranger: 'https://remote.test/users/stranger',
  instance: 'https://remote.test/actor',
  nop: 'https://remote.test/users/nop',
  vip: 'https://remote.test/users/vip',
  blocked: 'https://blocked.test/users/vip',
} as const
type Caller = 'unsigned' | 'badsig' | keyof typeof ACTORS
const CALLERS: Caller[] = ['unsigned', 'badsig', 'stranger', 'instance', 'blocked', 'nop', 'vip']

const SERVER_OF: Record<string, string> = {
  [PUB_OPEN]: PUB, [PUB_RESTRICTED]: PUB, [PRIV_OPEN]: PRIV, [PRIV_RESTRICTED]: PRIV,
}
const EVERYONE: Record<string, string[]> = { [PUB]: [PUB_OPEN], [PRIV]: [PRIV_OPEN], [CLOSED]: [CLOSED_OPEN] }
const MEMBERS: Record<string, { id: string; channels: Record<string, string[]> }> = {
  [ACTORS.nop]: { id: 'profile-nop', channels: { [PUB]: [PUB_OPEN], [PRIV]: [PRIV_OPEN] } },
  [ACTORS.vip]: { id: 'profile-vip', channels: { [PUB]: [PUB_OPEN, PUB_RESTRICTED], [PRIV]: [PRIV_OPEN, PRIV_RESTRICTED], [CLOSED]: [CLOSED_OPEN] } },
  [ACTORS.blocked]: { id: 'profile-blocked', channels: { [PUB]: [PUB_OPEN, PUB_RESTRICTED], [PRIV]: [PRIV_OPEN, PRIV_RESTRICTED] } },
}

const threadRow = (id: string, channelId: string, extra: Record<string, unknown> = {}) => ({
  id,
  channel_id: channelId,
  parent_message_id: `parent-${id}`,
  name: `thread in ${channelId}`,
  created_by: 'alice',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  archived: false,
  locked: false,
  auto_archive_duration: 1440,
  message_count: 2,
  member_count: 2,
  last_message_at: '2026-01-02T00:00:00Z',
  ap_id: null,
  ...extra,
})

const db: Record<string, any[]> = {
  servers: [
    { id: PUB, public: true, is_local_server: true, federation_enabled: true },
    { id: PRIV, public: false, is_local_server: true, federation_enabled: true },
    { id: REMOTE, public: true, is_local_server: false },
    { id: CLOSED, public: true, is_local_server: true, federation_enabled: false },
  ],
  channels: [
    { id: PUB_OPEN, server_id: PUB, name: 'pub-open', ap_id: null, is_remote: null },
    { id: PUB_RESTRICTED, server_id: PUB, name: 'pub-restricted', ap_id: null, is_remote: false },
    { id: PRIV_OPEN, server_id: PRIV, name: 'priv-open', ap_id: null, is_remote: false },
    { id: PRIV_RESTRICTED, server_id: PRIV, name: 'priv-restricted', ap_id: null, is_remote: false },
    { id: CLOSED_OPEN, server_id: CLOSED, name: 'closed-open', ap_id: null, is_remote: false },
    { id: REMOTE_CHANNEL, server_id: REMOTE, name: 'mirror', ap_id: `https://host.test/servers/${REMOTE}/channels/${REMOTE_CHANNEL}`, is_remote: true },
  ],
  threads: [
    ...Object.entries(THREAD_IN).map(([channelId, id]) => threadRow(id, channelId)),
    threadRow(REMOTE_THREAD, REMOTE_CHANNEL, { ap_id: `https://host.test/threads/${REMOTE_THREAD}` }),
    threadRow(CLOSED_THREAD, CLOSED_OPEN),
    threadRow(FOREIGN_THREAD, PUB_OPEN, { ap_id: `https://remote.test/threads/${FOREIGN_THREAD}`, created_by: 'profile-vip' }),
  ],
  messages: [
    ...Object.values(THREAD_IN).map((id) => ({ id: `parent-${id}`, metadata: {} })),
    { id: `parent-${FOREIGN_THREAD}`, metadata: { ap_id: 'https://remote.test/messages/p' } },
  ],
  profiles: [
    { id: 'alice', username: 'alice', federated_id: 'https://harmony.test/users/alice', is_local: true },
    { id: 'profile-vip', username: 'vip', federated_id: ACTORS.vip, is_local: false },
  ],
  thread_members: Object.values(THREAD_IN).flatMap((threadId) => [
    { id: `${threadId}-a`, thread_id: threadId, user_id: 'alice', joined_at: '2026-01-01T00:00:00Z' },
    { id: `${threadId}-v`, thread_id: threadId, user_id: 'profile-vip', joined_at: '2026-01-02T00:00:00Z' },
  ]),
}

const rpc = vi.fn(async (name: string, args: any) => {
  if (name !== 'federation_group_access') return { data: null, error: { message: 'unexpected rpc' } }
  const server = db.servers.find((s) => s.id === args.p_server_id)
  if (!server || !server.is_local_server) return { data: [], error: null }
  const member = args.p_actor_ap_id ? MEMBERS[args.p_actor_ap_id] : undefined
  return {
    data: [{
      is_public: server.public,
      member_id: member?.id ?? null,
      everyone_channel_ids: EVERYONE[server.id],
      member_channel_ids: member?.channels[server.id] ?? [],
    }],
    error: null,
  }
})

// `alias:table!<table>_<fk>_fkey(cols)` embeds the row whose id is the fk column.
function withEmbeds(table: string, select: string, row: any): any {
  const out = { ...row }
  for (const m of select.matchAll(/(\w+):(\w+)!(\w+)\(([^)]*)\)/g)) {
    const [, alias, target, fkName] = m
    const fk = fkName.replace(`${table}_`, '').replace(/_fkey$/, '')
    out[alias] = (db[target] || []).find((r) => r.id === row[fk]) ?? null
  }
  return out
}

function query(table: string) {
  const filters: Array<(r: any) => boolean> = []
  let head = false
  let selectStr = '*'
  let window: [number, number] | null = null
  const sorts: Array<[string, boolean]> = []
  const compare = (a: any, b: any) => {
    for (const [col, asc] of sorts) {
      if (a[col] !== b[col]) return (a[col] < b[col] ? -1 : 1) * (asc ? 1 : -1)
    }
    return 0
  }
  const rows = () => {
    const all = (db[table] || []).filter((r) => filters.every((f) => f(r))).sort(compare)
    return (window ? all.slice(window[0], window[1] + 1) : all).map((r) => withEmbeds(table, selectStr, r))
  }
  const q: any = {
    select: (cols?: string, opts?: any) => { selectStr = cols ?? '*'; if (opts?.head) head = true; return q },
    eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return q },
    order: (col: string, opts?: { ascending?: boolean }) => { sorts.push([col, opts?.ascending !== false]); return q },
    range: (from: number, to: number) => { window = [from, to]; return q },
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) =>
      Promise.resolve(head ? { count: rows().length, data: null, error: null } : { data: rows(), error: null })
        .then(resolve, reject),
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from: query, rpc }),
}))

const verifySignature = vi.fn(async (signature: string) => {
  if (signature.includes('bad')) return { verified: false, error: 'bad signature' }
  const keyId = /keyId="([^"]+)"/.exec(signature)?.[1] ?? ''
  return { verified: true, actorUrl: keyId.split('#')[0] }
})
vi.mock('../activitypub/SignatureService.js', async () => {
  const actual = await vi.importActual<any>('../activitypub/SignatureService.js')
  return {
    SignatureService: {
      verifySignature: (...args: any[]) => (verifySignature as any)(...args),
      verifyActorMatch: actual.SignatureService.verifyActorMatch,
    },
  }
})

const { default: threadRouter } = await import('../activitypub/threadRoutes.js')

function app() {
  const a = express()
  a.use('/', threadRouter)
  return a
}

function get(path: string, caller: Caller, accept = 'application/activity+json') {
  const req = supertest(app()).get(path).set('Accept', accept)
  if (caller === 'unsigned') return req
  if (caller === 'badsig') return req.set('Signature', 'keyId="https://remote.test/users/vip#main-key",signature="bad"')
  return req.set('Signature', `keyId="${ACTORS[caller]}#main-key",headers="(request-target) host date",signature="ok"`)
}

function readable(channelId: string, caller: Caller): boolean {
  const serverId = SERVER_OF[channelId]
  const server = db.servers.find((s) => s.id === serverId)!
  if (server.public && EVERYONE[serverId].includes(channelId)) return true
  const actor = caller in ACTORS && caller !== 'blocked' ? ACTORS[caller as keyof typeof ACTORS] : null
  return !!actor && (MEMBERS[actor]?.channels[serverId] ?? []).includes(channelId)
}
const isPublicChannel = (channelId: string) => SERVER_OF[channelId] === PUB && EVERYONE[PUB].includes(channelId)

beforeEach(() => {
  verifySignature.mockClear()
  rpc.mockClear()
})

const cells = Object.keys(THREAD_IN).flatMap((channelId) => CALLERS.map((caller) => ({ channelId, caller })))

function expectHidden(res: supertest.Response) {
  expect(res.status).toBe(404)
  expect(res.body).toEqual({ error: 'Not found' })
  expect(res.headers['cache-control']).toBeUndefined()
}

describe('GET /threads/:id', () => {
  it.each(cells)('$caller on the thread of $channelId', async ({ channelId, caller }) => {
    const threadId = THREAD_IN[channelId]
    const res = await get(`/threads/${threadId}`, caller)
    if (!readable(channelId, caller)) {
      expectHidden(res)
      return
    }
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/activity\+json/)
    expect(res.headers['cache-control']).toBe(isPublicChannel(channelId) ? 'public, max-age=60' : 'private, no-store')
    const serverId = SERVER_OF[channelId]
    expect(res.body).toMatchObject({
      type: 'ChatThread',
      id: `https://harmony.test/threads/${threadId}`,
      name: `thread in ${channelId}`,
      context: `https://harmony.test/servers/${serverId}/channels/${channelId}`,
      inReplyTo: `https://harmony.test/messages/parent-${threadId}`,
      attributedTo: 'https://harmony.test/users/alice',
      'harmony:serverId': serverId,
      'harmony:channelId': channelId,
    })
    expect(res.body['@context'][0]).toBe('https://www.w3.org/ns/activitystreams')
  })

  it('answers an unknown id, a malformed one, a remote copy\'s thread and another instance\'s thread as hidden', async () => {
    for (const path of [`/threads/${UNKNOWN}`, '/threads/not-a-uuid', `/threads/${REMOTE_THREAD}`, `/threads/${FOREIGN_THREAD}`]) {
      expectHidden(await get(path, 'vip'))
    }
  })

  it('hides the threads of a server with federation off, from a remote member too', async () => {
    for (const caller of ['unsigned', 'vip'] as const) {
      expectHidden(await get(`/threads/${CLOSED_THREAD}`, caller))
      expectHidden(await get(`/channels/${CLOSED_OPEN}/threads`, caller))
    }
  })

  it('serves ActivityPub only', async () => {
    const res = await get(`/threads/${THREAD_IN[PUB_OPEN]}`, 'unsigned', 'text/html')
    expect(res.status).toBe(406)
    const ld = await get(`/threads/${THREAD_IN[PUB_OPEN]}`, 'unsigned', 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"')
    expect(ld.status).toBe(200)
  })

  it('reads access as the key owner, and as nobody for a signature that fails', async () => {
    await get(`/threads/${THREAD_IN[PRIV_OPEN]}`, 'vip')
    await get(`/threads/${THREAD_IN[PRIV_OPEN]}`, 'badsig')
    expect(rpc.mock.calls.map((c) => (c[1] as any).p_actor_ap_id)).toEqual([ACTORS.vip, null])
  })
})

describe('GET /threads/:id/members', () => {
  it.each(cells)('$caller on the members of the thread of $channelId', async ({ channelId, caller }) => {
    const threadId = THREAD_IN[channelId]
    const collection = await get(`/threads/${threadId}/members`, caller)
    const page = await get(`/threads/${threadId}/members?page=1`, caller)
    if (!readable(channelId, caller)) {
      expectHidden(collection)
      expectHidden(page)
      return
    }
    expect(collection.body).toMatchObject({
      type: 'OrderedCollection',
      id: `https://harmony.test/threads/${threadId}/members`,
      totalItems: 2,
      first: `https://harmony.test/threads/${threadId}/members?page=1`,
    })
    expect(page.body.type).toBe('OrderedCollectionPage')
    expect(page.body.orderedItems).toEqual(['https://harmony.test/users/alice', ACTORS.vip])
    expect(page.headers['cache-control']).toBe(isPublicChannel(channelId) ? 'public, max-age=60' : 'private, no-store')
  })

  it('answers a malformed page as hidden', async () => {
    expectHidden(await get(`/threads/${THREAD_IN[PUB_OPEN]}/members?page=0`, 'unsigned'))
  })

  it('orders members who joined at the same instant by user id', async () => {
    const threadId = THREAD_IN[PUB_OPEN]
    const saved = db.thread_members
    db.thread_members = saved.filter((m) => m.thread_id === threadId).reverse()
      .map((m) => ({ ...m, joined_at: '2026-01-01T00:00:00Z' }))
    try {
      const page = await get(`/threads/${threadId}/members?page=1`, 'unsigned')
      expect(page.body.orderedItems).toEqual(['https://harmony.test/users/alice', ACTORS.vip])
    } finally {
      db.thread_members = saved
    }
  })
})

describe('GET /channels/:id/threads', () => {
  it.each(cells)('$caller on the threads of $channelId', async ({ channelId, caller }) => {
    const collection = await get(`/channels/${channelId}/threads`, caller)
    const page = await get(`/channels/${channelId}/threads?page=1`, caller)
    if (!readable(channelId, caller)) {
      expectHidden(collection)
      expectHidden(page)
      return
    }
    const own = `https://harmony.test/threads/${THREAD_IN[channelId]}`
    const listed = page.body.orderedItems.map((item: any) => (typeof item === 'string' ? item : item.id))
    if (channelId === PUB_OPEN) {
      expect(collection.body.totalItems).toBe(2)
      expect(listed).toEqual([own, `https://remote.test/threads/${FOREIGN_THREAD}`])
    } else {
      expect(collection.body.totalItems).toBe(1)
      expect(listed).toEqual([own])
    }
    expect(page.body.orderedItems[0]).toMatchObject({ type: 'ChatThread', id: own })
    expect(page.headers['cache-control']).toBe(isPublicChannel(channelId) ? 'public, max-age=60' : 'private, no-store')
  })

  it('answers an unknown channel and a remote copy\'s channel as hidden', async () => {
    expectHidden(await get(`/channels/${UNKNOWN}/threads`, 'vip'))
    expectHidden(await get(`/channels/${REMOTE_CHANNEL}/threads`, 'vip'))
  })
})
