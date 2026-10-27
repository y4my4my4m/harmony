import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// The copy of a server hosted elsewhere, brought to what its Group says: members read in a queued
// job, roles stripped only on a complete read, pins read where the advert changed.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', VERSION: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../middleware/rateLimit.js', () => ({
  discoveryLimiter: (_req: any, _res: any, next: any) => next(),
}))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn(), validateExternalHostname: vi.fn() }))
vi.mock('../middleware/auth.js', () => ({
  localProfileIdFromBearer: vi.fn(async (header?: string) => (header?.startsWith('Bearer ') ? header.slice(7) : null)),
}))
vi.mock('../activitypub/SignatureService.js', () => ({ SignatureService: { signedApFetch: vi.fn() } }))
vi.mock('../activitypub/DeliveryQueue.js', () => ({ DeliveryQueue: { sendToInbox: vi.fn() } }))
vi.mock('../activitypub/ActivityProcessor.js', () => ({
  ActivityProcessor: {
    ensureRemoteUser: vi.fn(async (url: string) => {
      const id = `fetched:${url}`
      db.profiles.push({ id, federated_id: url, username: url.split('/').pop(), updated_at: new Date().toISOString() })
      return { id, federated_id: url }
    }),
  },
}))

const redisHashes = new Map<string, Map<string, string>>()
let redisUp = true
vi.mock('../services/RedisService.js', () => ({
  redis: {
    hgetall: async (key: string) => (redisUp && redisHashes.get(key)?.size ? Object.fromEntries(redisHashes.get(key)!) : null),
    hset: async (key: string, field: string, value: string) => {
      if (!redisUp) return false
      const h = redisHashes.get(key) ?? new Map()
      h.set(field, value)
      redisHashes.set(key, h)
      return true
    },
    getClient: () => null,
  },
}))
const addJob = vi.fn(async (..._args: any[]): Promise<string | undefined> => 'job-1')
vi.mock('../queue/BullMQManager.js', () => ({ bullmqManager: { addJob: (...args: any[]) => addJob(...args) } }))

const GROUP = 'https://remote.test/servers/11111111-1111-4111-8111-111111111111'
const MEMBERS = `${GROUP}/members`
const REF = 'ref-1'
const CHANNEL = '22222222-2222-4222-8222-222222222222'
const CHANNEL_AP = `${GROUP}/channels/${CHANNEL}`
const NOTE = (n: number) => `https://remote.test/messages/00000000-0000-4000-8000-00000000000${n}`
const ROW = (n: number) => `00000000-0000-4000-8000-00000000000${n}`

let db: Record<string, any[]>
const writes: Array<{ table: string; op: string; rows: any }> = []
/** An upsert this returns an error for fails. */
let upsertError: (table: string, rows: any) => { message: string } | null

function field(r: any, col: string) {
  const m = /^(\w+)->>(\w+)$/.exec(col)
  return m ? r[m[1]]?.[m[2]] : r[col]
}

function query(table: string) {
  const filters: Array<(r: any) => boolean> = []
  let op: 'select' | 'update' = 'select'
  let patch: any
  let sort: ((a: any, b: any) => number) | null = null
  let window: [number, number] | null = null
  const rows = () => {
    let out = (db[table] || []).filter(r => filters.every(f => f(r)))
    if (sort) out = [...out].sort(sort)
    if (window) out = out.slice(window[0], window[1] + 1)
    // PostgREST max-rows.
    return out.slice(0, 1000)
  }
  const settle = () => {
    if (op === 'update') {
      const hit = rows()
      writes.push({ table, op: 'update', rows: patch })
      for (const r of hit) Object.assign(r, patch)
      return { data: hit.map(r => ({ id: r.id })), error: null }
    }
    return { data: rows(), error: null }
  }
  const q: any = {
    select: () => q,
    eq: (col: string, val: unknown) => { filters.push(r => field(r, col) === val); return q },
    is: (col: string, val: unknown) => { filters.push(r => (field(r, col) ?? null) === val); return q },
    in: (col: string, vals: unknown[]) => { filters.push(r => vals.includes(field(r, col))); return q },
    not: () => q,
    gte: () => q,
    lte: () => q,
    order: (col: string) => { sort = (a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0); return q },
    range: (from: number, to: number) => { window = [from, to]; return q },
    limit: () => q,
    update: (p: any) => { op = 'update'; patch = p; return q },
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    single: () => Promise.resolve(rows()[0] ? { data: rows()[0], error: null } : { data: null, error: { message: 'none' } }),
    insert: (r: any) => { (db[table] ??= []).push(...(Array.isArray(r) ? r : [r])); return Promise.resolve({ error: null }) },
    upsert: (r: any) => {
      writes.push({ table, op: 'upsert', rows: r })
      const error = upsertError(table, r)
      const list = Array.isArray(r) ? r : [r]
      let inserted: any = null
      if (!error) {
        for (const row of list) {
          const held = table === 'user_servers'
            ? db.user_servers.some(m => m.server_id === row.server_id && m.user_id === row.user_id)
            : (db[table] || []).some(m => m.id === row.id)
          if (!held) { (db[table] ??= []).push({ ...row }); inserted = row }
        }
      }
      const u: any = {
        select: () => u,
        maybeSingle: () => Promise.resolve({ data: inserted ? { id: inserted.id } : null, error }),
        then: (resolve: any, reject: any) => Promise.resolve({ error }).then(resolve, reject),
      }
      return u
    },
    then: (resolve: any, reject: any) => Promise.resolve(settle()).then(resolve, reject),
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from: query, rpc: vi.fn(async () => ({ data: [], error: null })) }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { default: discoveryRouter, ServerDiscoveryService } = await import('../services/ServerDiscoveryService.js')
const { CopyMirrorService } = await import('../services/CopyMirrorService.js')
const { SignatureService } = await import('../activitypub/SignatureService.js')
const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')

const signedApFetch = vi.mocked(SignatureService.signedApFetch)
const ensureRemoteUser = vi.mocked((ActivityProcessor as any).ensureRemoteUser as (url: string) => Promise<any>)
const json = (doc: unknown, status = 200) => new Response(JSON.stringify(doc), { status })
const server = () => db.servers.find(s => s.id === REF)
const membersFetches = () => signedApFetch.mock.calls.filter(c => String(c[0]).startsWith(`${MEMBERS}?`))

function app() {
  const a = express()
  a.use('/', discoveryRouter)
  return a
}

beforeEach(() => {
  writes.length = 0
  redisHashes.clear()
  redisUp = true
  upsertError = () => null
  signedApFetch.mockReset()
  ensureRemoteUser.mockClear()
  addJob.mockReset()
  addJob.mockResolvedValue('job-1')
  db = {
    servers: [{ id: REF, ap_id: GROUP, is_local_server: false, federation_metadata: { members: MEMBERS } }],
    channels: [{ id: CHANNEL, server_id: REF, ap_id: CHANNEL_AP, is_remote: true }],
    channel_categories: [],
    user_servers: [{ server_id: REF, user_id: 'bob', status: 'accepted', created_at: '2026-01-01' }],
    profiles: [{ id: 'bob', is_local: true, username: 'bob' }],
    server_roles: [],
    user_roles: [],
    messages: [],
    instance_server_blocks: [],
  }
})

describe('member sync', () => {
  const group = { type: 'Group', id: GROUP, inbox: `${GROUP}/inbox`, name: 'R', members: MEMBERS, 'harmony:channels': [] }

  it('is queued, one job per server, and the sync request answers without reading the members', async () => {
    signedApFetch.mockResolvedValue(json(group))
    const res = await supertest(app()).get(`/servers/${REF}/sync`).set('Authorization', 'Bearer bob')
    expect(res.status).toBe(200)
    await vi.waitFor(() => expect(addJob).toHaveBeenCalledTimes(1))
    expect(addJob).toHaveBeenCalledWith(
      'copy-member-sync',
      { type: 'update', server_id: REF, sign_as: 'bob' },
      { dedupeId: `copy-member-sync:${REF}`, attempts: 1 },
    )
    expect(membersFetches()).toEqual([])
  })

  it('queues nothing within ten minutes of the last read', async () => {
    server().federation_metadata.members_synced_at = new Date(Date.now() - 60_000).toISOString()
    await ServerDiscoveryService.queueMemberSync(REF, 'bob')
    expect(addJob).not.toHaveBeenCalled()

    server().federation_metadata.members_synced_at = new Date(Date.now() - 11 * 60_000).toISOString()
    await ServerDiscoveryService.queueMemberSync(REF, 'bob')
    expect(addJob).toHaveBeenCalledTimes(1)
  })

  it('runs once per server in this process when no queue takes it', async () => {
    addJob.mockResolvedValue(undefined)
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    signedApFetch.mockImplementation(async () => { await held; return json({ orderedItems: [] }) })

    await ServerDiscoveryService.queueMemberSync(REF, 'bob')
    await ServerDiscoveryService.queueMemberSync(REF, 'bob')
    await vi.waitFor(() => expect(membersFetches()).toHaveLength(1))
    release()
    await vi.waitFor(() => expect(server().federation_metadata.members_synced_at).toBeDefined())
    expect(membersFetches()).toHaveLength(1)
  })

  it('stamps members_synced_at when the read ends, not before', async () => {
    let stampDuringRead: unknown = 'unread'
    signedApFetch.mockImplementation(async () => {
      stampDuringRead = server().federation_metadata.members_synced_at
      return json({ orderedItems: [] })
    })
    await ServerDiscoveryService.runMemberSync(REF, 'bob')
    expect(stampDuringRead).toBeUndefined()
    expect(Date.parse(server().federation_metadata.members_synced_at)).toBeGreaterThan(Date.now() - 5_000)
    expect(server().federation_metadata.members).toBe(MEMBERS)
  })

  it('leaves members_synced_at unset when no page could be read', async () => {
    signedApFetch.mockResolvedValue(json({}, 502))
    await ServerDiscoveryService.runMemberSync(REF, 'bob')
    expect(server().federation_metadata.members_synced_at).toBeUndefined()
  })

  it('fetches only actors with no profile here, a stale one used as stored, and adds members in one batch', async () => {
    const stale = 'https://member.test/users/stale'
    const held = 'https://member.test/users/held'
    db.profiles.push(
      { id: 'p-stale', federated_id: stale, updated_at: '2020-01-01T00:00:00Z' },
      { id: 'p-held', federated_id: held, updated_at: '2020-01-01T00:00:00Z' },
    )
    db.user_servers.push({ server_id: REF, user_id: 'p-held', status: 'accepted' })
    signedApFetch.mockResolvedValue(json({
      orderedItems: [stale, held, 'https://member.test/users/new', 'https://harmony.test/users/bob', 'javascript:alert(1)'],
    }))

    expect(await ServerDiscoveryService.syncRemoteServerMembers(REF, MEMBERS, { signAs: 'bob', serverApId: GROUP })).toBe(true)

    expect(ensureRemoteUser.mock.calls.map(c => c[0])).toEqual(['https://member.test/users/new'])
    const upserts = writes.filter(w => w.table === 'user_servers' && w.op === 'upsert')
    expect(upserts).toHaveLength(1)
    expect(upserts[0].rows.map((r: any) => r.user_id).sort()).toEqual(['fetched:https://member.test/users/new', 'p-stale'])
    expect(upserts[0].rows[0]).toMatchObject({ server_id: REF, status: 'accepted', member_instance: 'member.test' })
  })

  it('stores the rest of a batch one by one when a guard refuses one row', async () => {
    db.profiles.push(
      { id: 'p-ok', federated_id: 'https://member.test/users/ok' },
      { id: 'p-banned', federated_id: 'https://member.test/users/banned' },
    )
    upsertError = (table, rows) => (table === 'user_servers' && (Array.isArray(rows) || rows.user_id === 'p-banned')
      ? { message: 'BANNED_FROM_SERVER' }
      : null)
    signedApFetch.mockResolvedValue(json({ orderedItems: ['https://member.test/users/ok', 'https://member.test/users/banned'] }))
    await ServerDiscoveryService.syncRemoteServerMembers(REF, MEMBERS, { signAs: 'bob', serverApId: GROUP })
    expect(db.user_servers.map(m => m.user_id)).toEqual(['bob', 'p-ok'])
  })

  describe('member roles', () => {
    const ROLE = `${GROUP}/roles/33333333-3333-4333-8333-333333333333`

    it('strips roles of members no entry names only when every page carried harmony:memberRoles', async () => {
      const apply = vi.spyOn(CopyMirrorService, 'applyMemberRoles').mockResolvedValue(0)
      onTestFinished(() => apply.mockRestore())
      const pages = (second: Record<string, unknown>) => {
        signedApFetch.mockReset()
        signedApFetch
          .mockResolvedValueOnce(json({ orderedItems: [], 'harmony:memberRoles': [{ member: 'https://member.test/users/a', roles: [ROLE] }], next: `${MEMBERS}?page=2` }))
          .mockResolvedValueOnce(json({ orderedItems: [], ...second }))
      }

      pages({ 'harmony:memberRoles': [] })
      await ServerDiscoveryService.syncRemoteServerMembers(REF, MEMBERS, { signAs: 'bob', serverApId: GROUP })
      expect(apply.mock.calls.at(-1)?.[3]).toEqual({ complete: true })

      // A page without the property: its members' roles are unknown, not none.
      pages({})
      await ServerDiscoveryService.syncRemoteServerMembers(REF, MEMBERS, { signAs: 'bob', serverApId: GROUP })
      expect(apply.mock.calls.at(-1)?.[2]).toEqual([{ member: 'https://member.test/users/a', roles: [ROLE] }])
      expect(apply.mock.calls.at(-1)?.[3]).toEqual({ complete: false })
    })
  })
})

describe('pins', () => {
  const advert = (totalItems: number, updated: string | null) => [{
    id: CHANNEL_AP, type: 'harmony:TextChannel', name: 'general',
    'harmony:pins': { type: 'OrderedCollection', id: `${CHANNEL_AP}/pins`, totalItems, ...(updated ? { updated } : {}) },
  }]
  const message = (n: number, pinnedAt: string | null, pinned = true) => ({
    id: ROW(n), channel_id: CHANNEL, is_pinned: pinned, pinned_at: pinnedAt, metadata: { ap_id: NOTE(n) },
  })
  const collection = (items: Array<{ n: number; at: string | null }>) => json({
    id: `${CHANNEL_AP}/pins`, type: 'OrderedCollection', totalItems: items.length,
    orderedItems: items.map(({ n, at }) => ({
      type: 'Note', id: NOTE(n), attributedTo: 'https://remote.test/users/dora', content: 'x',
      published: '2026-10-01T00:00:00Z', 'harmony:pinnedAt': at,
    })),
  })
  const T1 = '2026-10-01T00:00:00.000Z'
  const T2 = '2026-10-02T00:00:00.000Z'

  it('reads the collection when the advert says 0 over pins the copy holds, rather than unpinning them', async () => {
    db.messages = [message(1, T1)]
    const read = vi.spyOn(ServerDiscoveryService, 'syncChannelPins').mockResolvedValue(true)
    try {
      await ServerDiscoveryService.syncAdvertisedPins(REF, GROUP, advert(0, null), 'bob')
      expect(read).toHaveBeenCalledWith(REF, CHANNEL, { signAs: 'bob' })
      expect(db.messages[0].is_pinned).toBe(true)
    } finally {
      read.mockRestore()
    }
  })

  it('unpins only what the collection leaves out', async () => {
    db.messages = [message(1, T1), message(2, T2)]
    signedApFetch.mockResolvedValue(collection([{ n: 1, at: T1 }]))
    expect(await ServerDiscoveryService.syncChannelPins(REF, CHANNEL, { signAs: 'bob' })).toBe(true)
    expect(db.messages.map(m => m.is_pinned)).toEqual([true, false])

    signedApFetch.mockResolvedValue(collection([]))
    await ServerDiscoveryService.syncChannelPins(REF, CHANNEL, { signAs: 'bob' })
    expect(db.messages.map(m => m.is_pinned)).toEqual([false, false])
  })

  it('keeps a pin\'s stored time when the host sends none, and stores none for a new one', async () => {
    db.messages = [message(1, T1), message(2, null, false)]
    signedApFetch.mockResolvedValue(collection([{ n: 1, at: null }, { n: 2, at: null }]))
    await ServerDiscoveryService.syncChannelPins(REF, CHANNEL, { signAs: 'bob' })
    expect(db.messages.map(m => [m.is_pinned, m.pinned_at])).toEqual([[true, T1], [true, null]])
    expect(writes.filter(w => w.table === 'messages' && w.op === 'update')).toHaveLength(1)
  })

  it('reads a channel once per advert, though the copy cannot hold a Note it names', async () => {
    // The host pins two Notes; the copy holds one.
    db.messages = [message(1, T1)]
    signedApFetch.mockResolvedValue(collection([{ n: 1, at: T1 }, { n: 9, at: T2 }]))
    vi.mocked((ActivityProcessor as any).ensureRemoteUser).mockResolvedValueOnce(null)

    await ServerDiscoveryService.syncAdvertisedPins(REF, GROUP, advert(2, T2), 'bob')
    await ServerDiscoveryService.syncAdvertisedPins(REF, GROUP, advert(2, T2), 'bob')
    expect(signedApFetch).toHaveBeenCalledTimes(1)

    // A changed advert the copy does not match is read again.
    await ServerDiscoveryService.syncAdvertisedPins(REF, GROUP, advert(3, T2), 'bob')
    expect(signedApFetch).toHaveBeenCalledTimes(2)
  })

  it('remembers an advert in this process when Redis takes no write', async () => {
    redisUp = false
    db.messages = [message(1, T1)]
    signedApFetch.mockResolvedValue(collection([{ n: 1, at: T1 }, { n: 9, at: T2 }]))
    vi.mocked((ActivityProcessor as any).ensureRemoteUser).mockResolvedValueOnce(null)
    await ServerDiscoveryService.syncAdvertisedPins(REF, GROUP, advert(2, T2), 'bob')
    await ServerDiscoveryService.syncAdvertisedPins(REF, GROUP, advert(2, T2), 'bob')
    expect(signedApFetch).toHaveBeenCalledTimes(1)
  })

  it('reads nothing where the copy already matches the advert', async () => {
    db.messages = [message(1, T1), message(2, null)]
    await ServerDiscoveryService.syncAdvertisedPins(REF, GROUP, advert(2, T1), 'bob')
    expect(signedApFetch).not.toHaveBeenCalled()
  })

  it('remembers no advert whose collection could not be read', async () => {
    db.messages = [message(1, T1)]
    signedApFetch.mockResolvedValue(json({}, 503))
    await ServerDiscoveryService.syncAdvertisedPins(REF, GROUP, advert(0, null), 'bob')
    await ServerDiscoveryService.syncAdvertisedPins(REF, GROUP, advert(0, null), 'bob')
    expect(signedApFetch).toHaveBeenCalledTimes(2)
    expect(db.messages[0].is_pinned).toBe(true)
  })
})
