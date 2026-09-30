import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// Harmony as the reading instance: every read of a remote server's Group,
// channels or members is signed as a local member, never sent unsigned first.

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
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(),
  validateExternalHostname: vi.fn(),
}))
vi.mock('../middleware/auth.js', () => ({
  localProfileIdFromBearer: vi.fn(async (header?: string) =>
    header?.startsWith('Bearer ') ? header.slice(7) : null),
}))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { signedApFetch: vi.fn(), verifySignature: vi.fn() },
}))
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { sendToInbox: vi.fn(async () => undefined) },
}))
vi.mock('../activitypub/ActivityProcessor.js', () => ({
  ActivityProcessor: {
    ensureRemoteUser: vi.fn(async (url: string) => ({ id: 'author-profile', username: 'author', federated_id: url })),
  },
}))

const GROUP = 'https://remote.test/servers/11111111-1111-4111-8111-111111111111'
const REF = 'ref-1'
const CHANNEL = '22222222-2222-4222-8222-222222222222'
const STRAY = '33333333-3333-4333-8333-333333333333'
const LOCAL_CHANNEL = '44444444-4444-4444-8444-444444444444'

let db: Record<string, any[]>
const writes: Array<{ table: string; op: string; rows: any; filters?: Record<string, unknown> }> = []

function freshDb(): Record<string, any[]> {
  return {
    servers: [
      { id: REF, ap_id: GROUP, is_local_server: false, federation_metadata: {} },
      { id: 'other-ref', ap_id: 'https://elsewhere.test/servers/x', is_local_server: false, federation_metadata: {} },
      { id: 'local-server', ap_id: null, is_local_server: true },
    ],
    channels: [
      { id: CHANNEL, name: 'general', ap_id: `${GROUP}/channels/${CHANNEL}`, is_remote: true, server_id: REF,
        server: { id: REF, ap_id: GROUP, is_local_server: false } },
      { id: STRAY, name: 'stray', ap_id: `https://evil.test/servers/9/channels/${STRAY}`, is_remote: true, server_id: REF,
        server: { id: REF, ap_id: GROUP, is_local_server: false } },
      { id: LOCAL_CHANNEL, name: 'local', ap_id: null, is_remote: false, server_id: 'local-server',
        server: { id: 'local-server', ap_id: null, is_local_server: true } },
    ],
    channel_categories: [],
    user_servers: [
      { server_id: REF, user_id: 'remote-early', status: 'accepted', created_at: '2026-01-01' },
      { server_id: REF, user_id: 'bob', status: 'accepted', created_at: '2026-01-02' },
      { server_id: REF, user_id: 'carol', status: 'accepted', created_at: '2026-01-03' },
      { server_id: REF, user_id: 'pat', status: 'pending', created_at: '2026-01-04' },
      { server_id: REF, user_id: 'bea', status: 'banned', created_at: '2026-01-05' },
    ],
    profiles: [
      { id: 'remote-early', is_local: false },
      { id: 'bob', is_local: true },
      { id: 'carol', is_local: true },
      { id: 'pat', is_local: true },
      { id: 'bea', is_local: true },
      { id: 'alice', is_local: true },
      { id: 'dan', is_local: true, auth_user_id: 'auth-dan', username: 'dan', federated_id: 'https://harmony.test/users/dan' },
    ],
    messages: [
      { id: 'cached-1', channel_id: CHANNEL, content: [{ type: 'text', text: 'cached' }], created_at: '2026-01-01' },
    ],
  }
}

function query(table: string) {
  const filters: Array<(r: any) => boolean> = []
  const eqs: Record<string, unknown> = {}
  let op: 'select' | 'update' = 'select'
  let updateRows: any
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)))
  const settle = () => {
    if (op === 'update') {
      writes.push({ table, op: 'update', rows: updateRows, filters: { ...eqs } })
      return { data: null, error: null }
    }
    return { data: rows(), error: null }
  }
  const q: any = {
    select: () => q,
    eq: (col: string, val: unknown) => { eqs[col] = val; filters.push(r => r[col] === val); return q },
    in: (col: string, vals: unknown[]) => { filters.push(r => vals.includes(r[col])); return q },
    // Fixture rows are stored in created_at order.
    order: () => q,
    limit: () => q,
    range: () => q,
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    single: () => Promise.resolve(rows()[0] ? { data: rows()[0], error: null } : { data: null, error: { message: 'none' } }),
    update: (r: any) => { op = 'update'; updateRows = r; return q },
    insert: (r: any) => { writes.push({ table, op: 'insert', rows: r }); return Promise.resolve({ error: null }) },
    upsert: (r: any) => {
      writes.push({ table, op: 'upsert', rows: r })
      const u: any = { select: () => u, maybeSingle: () => Promise.resolve({ data: { id: r.id ?? 'cached' }, error: null }) }
      return u
    },
    then: (resolve: any, reject: any) => Promise.resolve(settle()).then(resolve, reject),
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: query,
    rpc: vi.fn(async () => ({ data: [], error: null })),
  }),
  getSupabaseClientWithAuth: (token: string) => ({
    auth: {
      getUser: async () => (token === 'dan-token'
        ? { data: { user: { id: 'auth-dan' } }, error: null }
        : { data: { user: null }, error: { message: 'invalid' } }),
    },
  }),
}))

const { default: discoveryRouter, ServerDiscoveryService } = await import('../services/ServerDiscoveryService.js')
const { SignatureService } = await import('../activitypub/SignatureService.js')
const { safeFetch } = await import('../utils/ssrfProtection.js')

const signedApFetch = vi.mocked(SignatureService.signedApFetch)
const json = (doc: unknown, status = 200) => new Response(JSON.stringify(doc), { status })

function app() {
  const a = express()
  a.use(express.json())
  a.use('/', discoveryRouter)
  return a
}

beforeEach(() => {
  db = freshDb()
  writes.length = 0
  signedApFetch.mockReset()
  vi.mocked(safeFetch).mockReset()
})

describe('GET /channels/:id/messages (remote channel proxy)', () => {
  const page = {
    type: 'OrderedCollectionPage',
    orderedItems: [{
      type: 'Note',
      id: 'https://remote.test/messages/55555555-5555-4555-8555-555555555555',
      attributedTo: 'https://remote.test/users/dora',
      content: '<p>hello</p>',
      published: '2026-01-01T00:00:00Z',
    }],
  }

  it('requires a bearer token and fetches nothing without one', async () => {
    const res = await supertest(app()).get(`/channels/${CHANNEL}/messages`)
    expect(res.status).toBe(401)
    expect(signedApFetch).not.toHaveBeenCalled()
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('signs the fetch as the requesting member and sends no unsigned attempt', async () => {
    signedApFetch.mockResolvedValue(json(page))
    const res = await supertest(app()).get(`/channels/${CHANNEL}/messages`).set('Authorization', 'Bearer bob')

    expect(res.status).toBe(200)
    expect(res.body.source).toBe('remote')
    expect(res.body.messages).toHaveLength(1)
    expect(signedApFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = signedApFetch.mock.calls[0]
    expect(url).toBe(`${GROUP}/channels/${CHANNEL}/messages?page=1`)
    expect(opts?.signAs).toBe('bob')
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('signs as a pending member: the host holds the membership', async () => {
    signedApFetch.mockResolvedValue(json(page))
    const res = await supertest(app()).get(`/channels/${CHANNEL}/messages`).set('Authorization', 'Bearer pat')
    expect(res.status).toBe(200)
    expect(signedApFetch.mock.calls[0][1]?.signAs).toBe('pat')
  })

  it.each(['alice', 'bea'])('is 404 for %s, who is not a member, without contacting the host', async (user) => {
    const res = await supertest(app()).get(`/channels/${CHANNEL}/messages`).set('Authorization', `Bearer ${user}`)
    expect(res.status).toBe(404)
    expect(signedApFetch).not.toHaveBeenCalled()
  })

  it('is 404 for a local channel', async () => {
    const res = await supertest(app()).get(`/channels/${LOCAL_CHANNEL}/messages`).set('Authorization', 'Bearer bob')
    expect(res.status).toBe(404)
    expect(signedApFetch).not.toHaveBeenCalled()
  })

  it('never signs a fetch to a channel outside its server\'s Group', async () => {
    const res = await supertest(app()).get(`/channels/${STRAY}/messages`).set('Authorization', 'Bearer bob')
    expect(res.status).toBe(404)
    expect(signedApFetch).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404, 410])('passes a %i refusal through as 404, not the local cache', async (status) => {
    signedApFetch.mockResolvedValue(json({}, status))
    const res = await supertest(app()).get(`/channels/${CHANNEL}/messages`).set('Authorization', 'Bearer bob')
    expect(res.status).toBe(404)
    expect(res.body.messages).toBeUndefined()
  })

  it('serves cached rows to an accepted member when the host is down', async () => {
    signedApFetch.mockResolvedValue(json({}, 503))
    const res = await supertest(app()).get(`/channels/${CHANNEL}/messages`).set('Authorization', 'Bearer bob')
    expect(res.status).toBe(200)
    expect(res.body.source).toBe('cache')
    expect(res.body.messages.map((m: any) => m.id)).toEqual(['cached-1'])
  })

  it('serves no cached rows to a pending member', async () => {
    signedApFetch.mockRejectedValue(new Error('connect ECONNREFUSED'))
    const res = await supertest(app()).get(`/channels/${CHANNEL}/messages`).set('Authorization', 'Bearer pat')
    expect(res.status).toBe(502)
    expect(res.body.messages).toBeUndefined()
  })
})

describe('signer selection for background reads', () => {
  it('picks the earliest accepted local member, never a remote or pending one', async () => {
    await expect(ServerDiscoveryService.pickSigningMember(REF)).resolves.toBe('bob')
  })

  it('has no signer for a server without local accepted members', async () => {
    db.user_servers = db.user_servers.filter(m => m.user_id === 'remote-early' || m.status !== 'accepted')
    await expect(ServerDiscoveryService.pickSigningMember(REF)).resolves.toBeNull()
  })

  it('skips the sync, fetching nothing, when no local member can sign', async () => {
    db.user_servers = []
    await ServerDiscoveryService.syncRemoteServer(REF)
    expect(signedApFetch).not.toHaveBeenCalled()
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('signs the sync as a local member when none is named', async () => {
    signedApFetch.mockResolvedValue(json({ type: 'Group', id: GROUP, inbox: `${GROUP}/inbox`, name: 'R', 'harmony:channels': [] }))
    await ServerDiscoveryService.syncRemoteServer(REF)
    expect(signedApFetch).toHaveBeenCalledTimes(1)
    expect(signedApFetch.mock.calls[0][0]).toBe(GROUP)
    expect(signedApFetch.mock.calls[0][1]?.signAs).toBe('bob')
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('signs the sync as the named user', async () => {
    signedApFetch.mockResolvedValue(json({ type: 'Group', id: GROUP, inbox: `${GROUP}/inbox`, name: 'R', 'harmony:channels': [] }))
    await ServerDiscoveryService.syncRemoteServer(REF, { asUserId: 'carol' })
    expect(signedApFetch.mock.calls[0][1]?.signAs).toBe('carol')
  })

  it('leaves the reference untouched when the Group answers with the non-member stub', async () => {
    signedApFetch.mockResolvedValue(json({ type: 'Group', id: GROUP, inbox: `${GROUP}/inbox`, name: 'Stub' }))
    await ServerDiscoveryService.syncRemoteServer(REF)
    expect(writes).toEqual([])
  })

  it('leaves the reference untouched when the Group names another id on its host', async () => {
    signedApFetch.mockResolvedValue(json({
      type: 'Group', id: 'https://remote.test/servers/other', inbox: 'https://remote.test/servers/other/inbox',
      name: 'Other', 'harmony:channels': [],
    }))
    await ServerDiscoveryService.syncRemoteServer(REF)
    expect(writes).toEqual([])
  })

  it('fetches a Group unsigned when no signer is given', async () => {
    vi.mocked(safeFetch).mockResolvedValue(json({ type: 'Group', id: GROUP, inbox: `${GROUP}/inbox` }))
    await ServerDiscoveryService.fetchServerByUrl(GROUP)
    expect(safeFetch).toHaveBeenCalledTimes(1)
    expect(signedApFetch).not.toHaveBeenCalled()
  })

  it('refuses to sign a members fetch off the server\'s host', async () => {
    await ServerDiscoveryService.syncRemoteServerMembers(REF, 'https://evil.test/members', { signAs: 'bob', serverApId: GROUP })
    expect(signedApFetch).not.toHaveBeenCalled()
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('signs a members fetch on the server\'s host', async () => {
    signedApFetch.mockResolvedValue(json({ orderedItems: [] }))
    await ServerDiscoveryService.syncRemoteServerMembers(REF, `${GROUP}/members`, { signAs: 'bob', serverApId: GROUP })
    expect(signedApFetch.mock.calls[0][0]).toBe(`${GROUP}/members?page=1`)
    expect(signedApFetch.mock.calls[0][1]?.signAs).toBe('bob')
  })
})

describe('POST /servers/join', () => {
  it('reads the joined Group again signed as the joiner, so a private one yields its channels', async () => {
    vi.mocked(safeFetch).mockResolvedValue(json({ type: 'Group', id: GROUP, inbox: `${GROUP}/inbox`, name: 'Stub' }))
    signedApFetch.mockResolvedValue(json({
      type: 'Group', id: GROUP, inbox: `${GROUP}/inbox`, name: 'Full',
      'harmony:channels': [{ id: `${GROUP}/channels/${CHANNEL}`, type: 'harmony:TextChannel', name: 'general' }],
    }))

    const res = await supertest(app())
      .post('/servers/join')
      .set('Authorization', 'Bearer dan-token')
      .send({ serverUrl: GROUP, userId: 'dan', inviteCode: 'CODE' })

    expect(res.status).toBe(200)
    expect(safeFetch).toHaveBeenCalledTimes(1)
    expect(signedApFetch).toHaveBeenCalledTimes(1)
    expect(signedApFetch.mock.calls[0][0]).toBe(GROUP)
    expect(signedApFetch.mock.calls[0][1]?.signAs).toBe('dan')
  })
})

describe('syncRemoteStructure', () => {
  const CAT = '66666666-6666-4666-8666-666666666666'
  const NEW = '77777777-7777-4777-8777-777777777777'
  const TAKEN = '88888888-8888-4888-8888-888888888888'

  it('keeps remote UUIDs, files channels under their category, and skips ids another server holds', async () => {
    db.channels.push({ id: TAKEN, server_id: 'other-ref', ap_id: 'https://elsewhere.test/servers/x/channels/y' })

    await ServerDiscoveryService.syncRemoteStructure(REF, GROUP, [
      { id: `${GROUP}/channels/${CAT}`, type: 'harmony:Category', channelType: 'category', name: 'cat', order: 2 },
      { id: `${GROUP}/channels/${CHANNEL}`, type: 'harmony:TextChannel', name: 'general-renamed', order: 0 },
      { id: `${GROUP}/channels/${NEW}`, type: 'harmony:VoiceChannel', channelType: 'voice', name: 'voice',
        categoryId: CAT, category: `${GROUP}/channels/${CAT}` },
      { id: `${GROUP}/channels/${TAKEN}`, type: 'harmony:TextChannel', name: 'hijack' },
      { id: `https://evil.test/servers/9/channels/${NEW}`, type: 'harmony:TextChannel', name: 'foreign' },
    ])

    const inserts = writes.filter(w => w.op === 'insert')
    const updates = writes.filter(w => w.op === 'update')
    expect(inserts.find(w => w.table === 'channel_categories')?.rows).toMatchObject({ id: CAT, server_id: REF, name: 'cat' })
    expect(updates.find(w => w.table === 'channels')).toMatchObject({
      rows: { name: 'general-renamed', is_remote: true },
      filters: { id: CHANNEL },
    })
    expect(inserts.find(w => w.table === 'channels')?.rows).toMatchObject({
      id: NEW, server_id: REF, name: 'voice', type: 1, category: CAT, ap_id: `${GROUP}/channels/${NEW}`,
    })
    const names = writes.filter(w => w.table === 'channels').map(w => w.rows.name)
    expect(names).not.toContain('hijack')
    expect(names).not.toContain('foreign')
  })
})
