import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// GroupService GET routes: who reads what.
//
// Servers: PUB (public) and PRIV (private). Each has an OPEN channel @everyone
// can view and a RESTRICTED one only `vip` can view. Callers: unsigned, a
// signed stranger, a signed instance actor, a bad signature, a member on a
// blocked instance, `nop` (accepted member without the restricted channel)
// and `vip` (accepted member with it).
// public.federation_group_access is emulated from the same table; its SQL is
// covered by db_schema/tests/38_federation_channel_access.sql.

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
vi.mock('../middleware/rateLimit.js', () => ({
  inboxLimiter: (_req: any, _res: any, next: any) => next(),
  instanceInboxLimit: async () => true,
  signerInstanceKey: () => 'test',
}))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: (host: string) => host === 'blocked.test' },
}))

const PUB = '00000000-0000-4000-8000-00000000a001'
const PRIV = '00000000-0000-4000-8000-00000000a002'
const UNKNOWN_SERVER = '00000000-0000-4000-8000-00000000a0ff'
const PUB_OPEN = '00000000-0000-4000-8000-00000000c001'
const PUB_RESTRICTED = '00000000-0000-4000-8000-00000000c002'
const PRIV_OPEN = '00000000-0000-4000-8000-00000000c003'
const PRIV_RESTRICTED = '00000000-0000-4000-8000-00000000c004'
const UNKNOWN_CHANNEL = '00000000-0000-4000-8000-00000000c0ff'
const CAT_SECRET = '00000000-0000-4000-8000-00000000d001'
const CAT_EMPTY = '00000000-0000-4000-8000-00000000d002'

const ACTORS = {
  stranger: 'https://remote.test/users/stranger',
  instance: 'https://remote.test/actor',
  nop: 'https://remote.test/users/nop',
  vip: 'https://remote.test/users/vip',
  blocked: 'https://blocked.test/users/vip',
} as const
type Caller = 'unsigned' | 'badsig' | keyof typeof ACTORS

const SERVER_OF: Record<string, string> = {
  [PUB_OPEN]: PUB, [PUB_RESTRICTED]: PUB, [PRIV_OPEN]: PRIV, [PRIV_RESTRICTED]: PRIV,
}
const EVERYONE: Record<string, string[]> = { [PUB]: [PUB_OPEN], [PRIV]: [PRIV_OPEN] }
const MEMBERS: Record<string, { id: string; channels: Record<string, string[]> }> = {
  [ACTORS.nop]: { id: 'profile-nop', channels: { [PUB]: [PUB_OPEN], [PRIV]: [PRIV_OPEN] } },
  [ACTORS.vip]: {
    id: 'profile-vip',
    channels: { [PUB]: [PUB_OPEN, PUB_RESTRICTED], [PRIV]: [PRIV_OPEN, PRIV_RESTRICTED] },
  },
  // Membership exists; the blocked host still reads as anonymous.
  [ACTORS.blocked]: {
    id: 'profile-blocked',
    channels: { [PUB]: [PUB_OPEN, PUB_RESTRICTED], [PRIV]: [PRIV_OPEN, PRIV_RESTRICTED] },
  },
}

const db: Record<string, any[]> = {
  servers: [
    { id: PUB, name: 'Pub', public: true, is_local_server: true, owner: null, created_at: '2026-01-01T00:00:00Z' },
    { id: PRIV, name: 'Priv', public: false, is_local_server: true, owner: null, created_at: '2026-01-01T00:00:00Z' },
  ],
  channel_categories: [
    { id: CAT_SECRET, server_id: PRIV, name: 'secret-cat', order: 0 },
    { id: CAT_EMPTY, server_id: PUB, name: 'empty-cat', order: 1 },
  ],
  channels: [
    // is_remote NULL: a bulk insert that omits the column stores NULL, not the default.
    { id: PUB_OPEN, server_id: PUB, name: 'pub-open', type: 0, order: 0, category: null, is_remote: null },
    { id: PUB_RESTRICTED, server_id: PUB, name: 'pub-restricted', type: 0, order: 1, category: null, is_remote: false },
    { id: PRIV_OPEN, server_id: PRIV, name: 'priv-open', type: 0, order: 0, category: null, is_remote: false },
    { id: PRIV_RESTRICTED, server_id: PRIV, name: 'priv-restricted', type: 0, order: 1, category: CAT_SECRET, is_remote: false },
  ],
  messages: [PUB_OPEN, PUB_RESTRICTED, PRIV_OPEN, PRIV_RESTRICTED].map((channelId, i) => ({
    id: `00000000-0000-4000-8000-00000000e00${i}`,
    channel_id: channelId,
    is_deleted: false,
    content: [{ type: 'text', text: `in ${channelId}` }],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    author: { id: 'author', username: 'author', federated_id: 'https://harmony.test/users/author' },
    channel: { id: channelId, name: channelId },
  })),
  user_servers: [
    { server_id: PUB, status: 'accepted', user_id: 'profile-nop', profile: { federated_id: ACTORS.nop } },
    { server_id: PRIV, status: 'accepted', user_id: 'profile-vip', profile: { federated_id: ACTORS.vip } },
  ],
}

const rpc = vi.fn(async (name: string, args: any) => {
  if (name !== 'federation_group_access') return { data: null, error: { message: 'unexpected rpc' } }
  const server = db.servers.find(s => s.id === args.p_server_id)
  if (!server) return { data: [], error: null }
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

function query(table: string) {
  const filters: Array<(r: any) => boolean> = []
  let head = false
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)))
  const q: any = {
    select: (_cols?: string, opts?: any) => { if (opts?.head) head = true; return q },
    eq: (col: string, val: unknown) => { filters.push(r => r[col] === val); return q },
    in: (col: string, vals: unknown[]) => { filters.push(r => vals.includes(r[col])); return q },
    // Only `.not(col, 'is', value)` is used: IS NOT, so NULL passes.
    not: (col: string, _op: 'is', val: unknown) => { filters.push(r => r[col] !== val); return q },
    order: () => q,
    range: () => q,
    limit: () => q,
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    single: () => Promise.resolve(rows()[0] ? { data: rows()[0], error: null } : { data: null, error: { message: 'no rows' } }),
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

const { default: groupRouter } = await import('../activitypub/GroupService.js')

function app() {
  const a = express()
  a.use('/', groupRouter)
  return a
}

function get(path: string, caller: Caller) {
  const req = supertest(app()).get(path).set('Accept', 'application/activity+json')
  if (caller === 'unsigned') return req
  if (caller === 'badsig') return req.set('Signature', 'keyId="https://remote.test/users/vip#main-key",signature="bad"')
  return req.set('Signature', `keyId="${ACTORS[caller]}#main-key",headers="(request-target) host date",signature="ok"`)
}

const CALLERS: Caller[] = ['unsigned', 'badsig', 'stranger', 'instance', 'blocked', 'nop', 'vip']

function readable(serverId: string, caller: Caller): Set<string> {
  const server = db.servers.find(s => s.id === serverId)!
  const out = new Set<string>(server.public ? EVERYONE[serverId] : [])
  const actor = caller in ACTORS && caller !== 'blocked' ? ACTORS[caller as keyof typeof ACTORS] : null
  for (const id of (actor && MEMBERS[actor]?.channels[serverId]) || []) out.add(id)
  return out
}
const isMember = (caller: Caller) => caller === 'nop' || caller === 'vip'
const canReadServer = (serverId: string, caller: Caller) => serverId === PUB || isMember(caller)
const isPublicChannel = (channelId: string) =>
  SERVER_OF[channelId] === PUB && EVERYONE[PUB].includes(channelId)

beforeEach(() => {
  verifySignature.mockClear()
  rpc.mockClear()
})

describe('channel routes', () => {
  const cells = Object.keys(SERVER_OF).flatMap(channelId => CALLERS.map(caller => ({ channelId, caller })))

  for (const suffix of ['', '/messages', '/messages?page=1', '/outbox?page=1']) {
    it.each(cells)(`GET channel${suffix || ' document'}: $caller on $channelId`, async ({ channelId, caller }) => {
      const serverId = SERVER_OF[channelId]
      const res = await get(`/servers/${serverId}/channels/${channelId}${suffix}`, caller)

      if (readable(serverId, caller).has(channelId)) {
        expect(res.status).toBe(200)
        expect(res.headers['cache-control']).toEqual(
          isPublicChannel(channelId) ? expect.stringMatching(/^public, max-age=\d+$/) : 'private, no-store',
        )
        if (suffix.includes('page=1')) {
          expect(res.body.orderedItems.map((n: any) => n.context)).toEqual([
            `https://harmony.test/servers/${serverId}/channels/${channelId}`,
          ])
        }
      } else {
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ error: 'Channel not found' })
        expect(res.headers['cache-control']).toBeUndefined()
      }
    })
  }

  it('answers an unknown channel exactly as a channel the caller may not read', async () => {
    const unknown = await get(`/servers/${PUB}/channels/${UNKNOWN_CHANNEL}/messages?page=1`, 'unsigned')
    const hidden = await get(`/servers/${PUB}/channels/${PUB_RESTRICTED}/messages?page=1`, 'unsigned')
    const wrongServer = await get(`/servers/${PUB}/channels/${PRIV_OPEN}/messages?page=1`, 'vip')
    for (const res of [unknown, hidden, wrongServer]) {
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'Channel not found' })
      expect(res.headers['cache-control']).toBeUndefined()
    }
  })

  it('treats a member signature that does not cover (request-target) as anonymous', async () => {
    const res = await supertest(app())
      .get(`/servers/${PRIV}/channels/${PRIV_OPEN}/messages?page=1`)
      .set('Accept', 'application/activity+json')
      .set('Signature', `keyId="${ACTORS.vip}#main-key",headers="host date",signature="ok"`)
    expect(res.status).toBe(404)
    expect(verifySignature).not.toHaveBeenCalled()
  })

  it('verifies the signature over the method and the full request path, with no body', async () => {
    await get(`/servers/${PRIV}/channels/${PRIV_OPEN}/messages?page=1`, 'nop')
    expect(verifySignature).toHaveBeenCalledTimes(1)
    const [, , method, path, body] = verifySignature.mock.calls[0] as any[]
    expect(method).toBe('GET')
    expect(path).toBe(`/servers/${PRIV}/channels/${PRIV_OPEN}/messages?page=1`)
    expect(body).toBeUndefined()
  })

  it('asks for access as the key owner, and as nobody when the signature fails', async () => {
    await get(`/servers/${PRIV}/channels/${PRIV_OPEN}`, 'vip')
    await get(`/servers/${PRIV}/channels/${PRIV_OPEN}`, 'badsig')
    expect(rpc.mock.calls.map(c => (c[1] as any).p_actor_ap_id)).toEqual([ACTORS.vip, null])
  })
})

describe('Group document', () => {
  const cells = [PUB, PRIV].flatMap(serverId => CALLERS.map(caller => ({ serverId, caller })))

  it.each(cells)('$caller on $serverId', async ({ serverId, caller }) => {
    const res = await get(`/servers/${serverId}`, caller)
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(`https://harmony.test/servers/${serverId}`)
    expect(res.body.type).toBe('Group')
    expect(res.body.inbox).toBe(`https://harmony.test/servers/${serverId}/inbox`)

    if (!canReadServer(serverId, caller)) {
      expect(res.body['harmony:channels']).toBeUndefined()
      expect(res.body['harmony:memberCount']).toBeUndefined()
      expect(res.body.outbox).toBeUndefined()
      expect(res.body.name).toBe('Priv')
      expect(res.headers['cache-control']).toBe('private, no-store')
      return
    }

    const listed = res.body['harmony:channels'].filter((c: any) => c.channelType !== 'category').map((c: any) => c.localId)
    expect(new Set(listed)).toEqual(readable(serverId, caller))

    const categories = res.body['harmony:channels'].filter((c: any) => c.channelType === 'category').map((c: any) => c.localId)
    if (serverId === PUB) expect(categories).toEqual([CAT_EMPTY])
    else expect(categories).toEqual(caller === 'vip' ? [CAT_SECRET] : [])

    const extra = [...readable(serverId, caller)].some(id => !EVERYONE[serverId].includes(id))
    if (serverId === PUB && !extra) {
      expect(res.headers['cache-control']).toBe('public, max-age=60')
      expect(res.headers.vary).toContain('Signature')
    } else {
      expect(res.headers['cache-control']).toBe('private, no-store')
    }
  })

  it('is 404 for an unknown server', async () => {
    const res = await get(`/servers/${UNKNOWN_SERVER}`, 'vip')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Server not found' })
  })
})

describe('server collections', () => {
  const cells = [PUB, PRIV].flatMap(serverId => CALLERS.map(caller => ({ serverId, caller })))

  it.each(cells)('members: $caller on $serverId', async ({ serverId, caller }) => {
    const res = await get(`/servers/${serverId}/members?page=1`, caller)
    if (!canReadServer(serverId, caller)) {
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'Server not found' })
      return
    }
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe(serverId === PUB ? 'public, max-age=60' : 'private, no-store')
  })

  it.each(cells)('outbox: $caller on $serverId', async ({ serverId, caller }) => {
    const res = await get(`/servers/${serverId}/outbox?page=1`, caller)
    if (!canReadServer(serverId, caller)) {
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'Server not found' })
      return
    }
    expect(res.status).toBe(200)
    const contexts = new Set(res.body.orderedItems.map((a: any) => a.object.context.split('/channels/')[1]))
    expect(contexts).toEqual(readable(serverId, caller))

    const extra = [...readable(serverId, caller)].some(id => !EVERYONE[serverId].includes(id))
    expect(res.headers['cache-control']).toBe(
      serverId === PUB && !extra ? 'public, max-age=15' : 'private, no-store',
    )
  })

  it('answers an unknown server exactly as a private one the caller may not read', async () => {
    for (const path of ['members', 'outbox', 'outbox?page=1', 'members?page=1']) {
      const unknown = await get(`/servers/${UNKNOWN_SERVER}/${path}`, 'stranger')
      const hidden = await get(`/servers/${PRIV}/${path}`, 'stranger')
      expect(unknown.status).toBe(404)
      expect(hidden.status).toBe(404)
      expect(hidden.body).toEqual(unknown.body)
      expect(hidden.headers['cache-control']).toEqual(unknown.headers['cache-control'])
    }
  })
})
