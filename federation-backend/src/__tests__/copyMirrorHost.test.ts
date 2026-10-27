import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// A local server's Group as its member instances' copies read it (copyMirror.ts): the pins
// advert counts what each channel's pins collection serves, and an unread role list, pin list or
// role assignment is left out rather than sent short.

vi.mock('../config/index.js', () => {
  const cfg = {
    INSTANCE_DOMAIN: 'harmony.test',
    REQUIRE_VALID_SIGNATURES: true,
    SUPABASE_URL: 'http://kong:8000',
    PUBLIC_SUPABASE_URL: 'https://db.harmony.test',
  }
  return { default: cfg, config: cfg }
})
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
  clientIp: () => '203.0.113.1',
}))
vi.mock('../activitypub/ServerActor.js', () => ({
  getServerActorKeys: async () => ({ publicKey: 'PEM', privateKey: 'KEY' }),
  serverActorPublicKey: (id: string, pem: string) => ({ id: `${id}#main-key`, publicKeyPem: pem }),
}))
vi.mock('../activitypub/ActivityProcessor.js', () => ({ ActivityProcessor: {} }))
vi.mock('../services/LinkPreviewService.js', () => ({ linkPreviewService: {} }))
vi.mock('../activitypub/DeliveryQueue.js', () => ({ DeliveryQueue: { enqueue: vi.fn(async () => undefined) } }))
vi.mock('../utils/federationUtils.js', () => ({
  getRemoteMemberGroups: vi.fn(async () => [{ instance: 'member.test', shared_inbox: 'https://member.test/inbox' }]),
  getChannelRecipientGroups: vi.fn(async () => []),
  getCategoryRecipientGroups: vi.fn(async () => []),
}))

const SERVER = '00000000-0000-4000-8000-00000000a001'
const GROUP = `https://harmony.test/servers/${SERVER}`
const A = '00000000-0000-4000-8000-00000000c001'
const B = '00000000-0000-4000-8000-00000000c002'
const ROLE = '00000000-0000-4000-8000-00000000b001'

let db: Record<string, any[]>
let everyone: string[]
let cutoffs: Record<string, string>
/** A read this returns true for answers an error. */
let failWhen: (table: string, eqs: Record<string, unknown>, select: string) => boolean
/** Ids of each `in` filter on messages. */
let inCalls: unknown[][]

function query(table: string) {
  const filters: Array<(r: any) => boolean> = []
  const eqs: Record<string, unknown> = {}
  let select = ''
  let head = false
  const sorts: Array<(a: any, b: any) => number> = []
  let window: [number, number] | null = null
  const rows = () => {
    let out = (db[table] || []).filter(r => filters.every(f => f(r)))
    if (sorts.length > 0) out = [...out].sort((a, b) => sorts.map(f => f(a, b)).find(d => d !== 0) ?? 0)
    if (window) out = out.slice(window[0], window[1] + 1)
    // PostgREST max-rows.
    if (!head) out = out.slice(0, 1000)
    // JSON path columns: alias:metadata->>key and alias:metadata->key.
    const paths = [...select.matchAll(/(\w+):metadata->>?(\w+)/g)]
    return paths.length === 0 ? out : out.map(r => {
      const projected = { ...r }
      for (const [, alias, key] of paths) projected[alias] = r.metadata?.[key]
      return projected
    })
  }
  const settle = () => {
    if (failWhen(table, eqs, select)) return { data: null, error: { message: 'statement timeout' } }
    return head ? { count: rows().length, data: null, error: null } : { data: rows(), error: null }
  }
  const q: any = {
    select: (cols?: string, opts?: any) => { select = cols ?? ''; if (opts?.head) head = true; return q },
    eq: (col: string, val: unknown) => { eqs[col] = val; filters.push(r => r[col] === val); return q },
    gte: (col: string, val: string) => { filters.push(r => r[col] >= val); return q },
    in: (col: string, vals: unknown[]) => {
      if (table === 'messages') inCalls.push(vals)
      filters.push(r => vals.includes(r[col]))
      return q
    },
    not: (col: string, _op: string, val: unknown) => { filters.push(r => r[col] !== val); return q },
    or: () => q,
    order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => {
      const asc = opts?.ascending !== false
      sorts.push((a, b) => {
        const x = a[col] ?? null
        const y = b[col] ?? null
        if (x === y) return 0
        if (x === null) return opts?.nullsFirst ? -1 : 1
        if (y === null) return opts?.nullsFirst ? 1 : -1
        return (x < y ? -1 : 1) * (asc ? 1 : -1)
      })
      return q
    },
    range: (from: number, to: number) => { window = [from, to]; return q },
    limit: (n: number) => { window = [0, n - 1]; return q },
    maybeSingle: () => Promise.resolve(failWhen(table, eqs, select)
      ? { data: null, error: { message: 'statement timeout' } }
      : { data: rows()[0] ?? null, error: null }),
    single: () => Promise.resolve(rows()[0] ? { data: rows()[0], error: null } : { data: null, error: { message: 'no rows' } }),
    then: (resolve: any, reject: any) => Promise.resolve(settle()).then(resolve, reject),
  }
  return q
}

const rpc = vi.fn(async (name: string) => {
  if (name === 'federation_history_cutoffs') return { data: cutoffs, error: null }
  if (name === 'federation_group_access') {
    return { data: [{ is_public: true, member_id: null, everyone_channel_ids: everyone, member_channel_ids: [] }], error: null }
  }
  return { data: [], error: null }
})

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from: query, rpc }),
}))

const { default: groupRouter } = await import('../activitypub/GroupService.js')
const { handleServerUpdated, ServerRolesUnreadError } = await import('../listeners/DatabaseListener.js')
const { handleServerUpdateJob } = await import('../queue/handlers/serverStructureHandler.js')
const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')

function app() {
  const a = express()
  a.use('/', groupRouter)
  return a
}

const AUTHOR = { id: 'p-ann', username: 'ann', federated_id: null, display_name: 'Ann', avatar_url: null }
let seq = 0
function pin(channelId: string, over: Record<string, any> = {}) {
  seq++
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    channel_id: channelId,
    is_pinned: true,
    is_deleted: false,
    pinned_at: `2026-10-${String(1 + (seq % 27)).padStart(2, '0')}T00:00:00.000Z`,
    created_at: '2026-09-01T00:00:00.000Z',
    is_system: false,
    metadata: {},
    content: [{ type: 'text', text: `pin ${seq}` }],
    user_id: AUTHOR.id,
    author: AUTHOR,
    bot_id: null,
    bot: null,
    ...over,
  }
}

function channel(id: string, order = 0) {
  return { id, server_id: SERVER, name: `c-${id.slice(-4)}`, type: 0, order, category: null, is_remote: false }
}

beforeEach(() => {
  seq = 0
  inCalls = []
  cutoffs = {}
  everyone = [A, B]
  failWhen = () => false
  vi.mocked(DeliveryQueue.enqueue).mockClear()
  db = {
    servers: [{
      id: SERVER, name: 'Hall', public: true, is_local_server: true, federation_enabled: true, owner: null,
      created_at: '2026-01-01T00:00:00Z',
    }],
    channel_categories: [],
    channels: [channel(A, 0), channel(B, 1)],
    server_roles: [
      { id: 'e0e0e0e0-0000-4000-8000-000000000000', server_id: SERVER, name: 'everyone', position: 0, is_default: true },
      { id: ROLE, server_id: SERVER, name: 'Mod', color: '#123456', position: 3, is_default: false },
    ],
    user_servers: [],
    user_roles: [],
    messages: [],
    profiles: [],
    bots: [],
  }
})

const groupDoc = async () => (await supertest(app()).get(`/servers/${SERVER}`)).body
const advertOf = (doc: any, channelId: string) =>
  doc['harmony:channels'].find((c: any) => c.localId === channelId)?.['harmony:pins']
const pinsOf = (channelId: string) => supertest(app()).get(`/servers/${SERVER}/channels/${channelId}/pins`)

describe('pins advert', () => {
  it('counts exactly the Notes the pins collection serves', async () => {
    const older = '2026-10-01T00:00:00.000Z'
    const newer = '2026-10-09T00:00:00.000Z'
    db.messages = [
      pin(A, { pinned_at: '2026-10-05T00:00:00.000Z' }),
      // No pin time: served with harmony:pinnedAt null, counted, never the newest.
      pin(A, { pinned_at: null }),
      // Nobody speaks for it: not served, not counted, and not the newest.
      pin(A, { user_id: null, author: null, pinned_at: newer }),
      // A bot speaks through the Group: served and counted.
      pin(A, { user_id: null, author: null, bot_id: 'bot-1', bot: { id: 'bot-1', username: 'helper', display_name: 'Helper' }, pinned_at: older }),
      // A notice with a Note, and one without.
      pin(A, { is_system: true, user_id: null, author: null, metadata: { type: 'member_join' }, pinned_at: older }),
      pin(A, { is_system: true, user_id: null, author: null, metadata: { type: 'automod_alert' }, pinned_at: newer }),
      pin(A, { is_deleted: true, pinned_at: newer }),
    ]
    const advert = advertOf(await groupDoc(), A)
    const served = (await pinsOf(A)).body

    expect(served.totalItems).toBe(4)
    expect(advert).toEqual({
      type: 'OrderedCollection', id: `${GROUP}/channels/${A}/pins`, totalItems: 4, updated: '2026-10-05T00:00:00.000Z',
    })
    expect(served.orderedItems.map((n: any) => n['harmony:pinnedAt'])).toContain(null)
  })

  it('advertises 0 for a channel with no pins, and the count of each channel apart', async () => {
    db.messages = [pin(A), pin(A)]
    const doc = await groupDoc()
    expect(advertOf(doc, A).totalItems).toBe(2)
    expect(advertOf(doc, B)).toMatchObject({ totalItems: 0, updated: null })
  })

  it('reads the pins of many channels a chunk of channels and a page of rows at a time', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `00000000-0000-4000-8000-0000000d${String(i).padStart(4, '0')}`)
    db.channels = ids.map((id, i) => channel(id, i))
    everyone = ids
    db.messages = ids.map(id => pin(id, { pinned_at: '2026-01-01T00:00:00.000Z' }))
    // 1500 newer pins in one channel fill the first page of 1000 rows of its chunk.
    const busy = ids[0]
    for (let i = 0; i < 1500; i++) db.messages.push(pin(busy, { pinned_at: '2026-06-01T00:00:00.000Z' }))
    db.messages.push(pin(busy, { pinned_at: '2026-12-31T00:00:00.000Z' }))

    const doc = await groupDoc()
    expect(inCalls.length).toBeGreaterThan(0)
    expect(Math.max(...inCalls.map(c => c.length))).toBeLessThanOrEqual(50)
    for (const id of ids.slice(1)) expect(advertOf(doc, id).totalItems).toBe(1)
    expect(advertOf(doc, busy)).toMatchObject({ totalItems: 100, updated: '2026-12-31T00:00:00.000Z' })
  })

  it('leaves the advert out of every channel when a pinned read fails', async () => {
    db.messages = [pin(A)]
    failWhen = (table, eqs) => table === 'messages' && eqs.is_pinned === true
    const doc = await groupDoc()
    expect(doc['harmony:channels']).toHaveLength(2)
    expect(advertOf(doc, A)).toBeUndefined()
    expect(advertOf(doc, B)).toBeUndefined()
  })

  it('leaves the advert out of a channel the reader reads from a history cutoff on', async () => {
    db.messages = [pin(A), pin(B)]
    cutoffs = { [B]: '2026-10-01T00:00:00Z' }
    const doc = await groupDoc()
    expect(advertOf(doc, A).totalItems).toBe(1)
    expect(advertOf(doc, B)).toBeUndefined()
  })
})

describe('pins collection', () => {
  it('answers 503, not an empty collection, when the pins cannot be read', async () => {
    db.messages = [pin(A)]
    expect((await pinsOf(A)).body.totalItems).toBe(1)

    failWhen = (table, eqs) => table === 'messages' && eqs.is_pinned === true
    const res = await pinsOf(A)
    expect(res.status).toBe(503)
    expect(res.body.orderedItems).toBeUndefined()
  })
})

describe('roles on the Group', () => {
  it('lists the roles it reads', async () => {
    const doc = await groupDoc()
    expect(doc['harmony:roles'].map((r: any) => r.name)).toEqual(['Mod'])
  })

  it('leaves harmony:roles out when the roles cannot be read: an empty list deletes a copy\'s roles', async () => {
    failWhen = table => table === 'server_roles'
    const doc = await groupDoc()
    expect(doc.name).toBe('Hall')
    expect('harmony:roles' in doc).toBe(false)
  })
})

describe('members page', () => {
  const page = async () => (await supertest(app()).get(`/servers/${SERVER}/members?page=1`)).body
  const member = (n: number) => ({
    server_id: SERVER, status: 'accepted', user_id: `u${n}`, created_at: `2026-01-0${n}`,
    profile: { id: `u${n}`, username: `m${n}`, federated_id: `https://member.test/users/m${n}`, is_local: false },
  })

  it('reads every assignment of a page, past one page of rows', async () => {
    db.user_servers = [member(1), member(2), member(3)]
    let id = 0
    for (const n of [1, 2, 3]) {
      for (let r = 0; r < 400; r++) {
        db.user_roles.push({
          id: String(++id).padStart(6, '0'), server_id: SERVER, user_id: `u${n}`,
          role_id: `00000000-0000-4000-8000-${String(r).padStart(12, '0')}`, role: { is_default: false },
        })
      }
    }
    const entries = (await page())['harmony:memberRoles']
    expect(entries).toHaveLength(3)
    expect(entries.find((e: any) => e.member === 'https://member.test/users/m3').roles).toHaveLength(400)
  })

  it('leaves harmony:memberRoles out when an assignment cannot be read', async () => {
    db.user_servers = [member(1)]
    db.user_roles = [{ id: '1', server_id: SERVER, user_id: 'u1', role_id: ROLE, role: { is_default: false } }]
    expect((await page())['harmony:memberRoles']).toEqual([{ member: 'https://member.test/users/m1', roles: [`${GROUP}/roles/${ROLE}`] }])

    failWhen = table => table === 'user_roles'
    const body = await page()
    expect(body.orderedItems).toEqual(['https://member.test/users/m1'])
    expect('harmony:memberRoles' in body).toBe(false)
  })
})

describe('Update(Group)', () => {
  const server = () => db.servers[0]

  it('carries the roles it reads', async () => {
    await handleServerUpdated(server(), server())
    const sent: any = vi.mocked(DeliveryQueue.enqueue).mock.calls[0][0]
    expect(sent.object['harmony:roles'].map((r: any) => r.name)).toEqual(['Mod'])
  })

  it('is not sent, and the job fails for a retry, when the roles cannot be read', async () => {
    failWhen = table => table === 'server_roles'
    await expect(handleServerUpdated(server(), server())).rejects.toBeInstanceOf(ServerRolesUnreadError)
    expect(DeliveryQueue.enqueue).not.toHaveBeenCalled()

    await expect(handleServerUpdateJob({ type: 'update', server_id: SERVER })).rejects.toBeInstanceOf(ServerRolesUnreadError)
    expect(DeliveryQueue.enqueue).not.toHaveBeenCalled()
  })
})
