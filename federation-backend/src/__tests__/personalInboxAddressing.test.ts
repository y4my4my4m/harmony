import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'

// A personal inbox accepts an activity addressed to its user, publicly, through a mention, or to
// the followers of an actor the user follows. Addressing is read through audience.ts: one value or
// an array, link objects, compact `as:Public`, and the embedded object's own `to` and `cc`.

const config = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'harmony.test',
  INSTANCE_NAME: 'Harmony Test',
  NODE_ENV: 'test',
  REQUIRE_VALID_SIGNATURES: true,
}))
vi.mock('../config/index.js', () => ({ default: config }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
  AppError: class extends Error {},
}))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: () => false },
}))
vi.mock('../services/FederatedInstanceService.js', () => ({
  FederatedInstanceService: { touchFromUrl: vi.fn() },
}))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: {
    verifySignature: vi.fn(async () => ({ verified: true, actorUrl: ANN })),
    verifyActorMatch: (a: string, b: string) => a === b,
  },
}))

const processed = vi.hoisted(() => [] as any[])
vi.mock('../activitypub/ActivityProcessor.js', () => ({
  ActivityProcessor: {
    processIncomingActivity: vi.fn(async (activity: any) => { processed.push(activity) }),
    fetchApDocument: vi.fn(async () => null),
  },
}))

type Row = Record<string, any>
const tables = vi.hoisted(() => ({} as Record<string, Record<string, any>[]>))
const rpcArgs = vi.hoisted(() => [] as Array<{ name: string; args: any }>)
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = []
      const rows = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push((row) => row[c] === v); return q },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        single: async () => (rows().length === 1 ? { data: rows()[0], error: null } : { data: null, error: { message: 'no rows' } }),
      }
      return q
    },
    rpc: async (name: string, args: any) => {
      rpcArgs.push({ name, args })
      return { data: name === 'claim_ap_activity' ? true : null, error: null }
    },
  }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { default: inboxRouter } = await import('../activitypub/InboxHandler.js')
const { default: supertest } = await import('supertest')

const ANN = 'https://origin.test/users/ann'
const BOB = 'https://harmony.test/users/bob'

function app() {
  const a = express()
  a.use(express.json({ type: ['application/json', 'application/activity+json'], verify: (req: any, _res, buf) => { req.rawBody = buf } }))
  a.use('/', inboxRouter)
  return a
}
const deliver = (activity: unknown) => supertest(app())
  .post('/users/bob/inbox')
  .set('Content-Type', 'application/activity+json')
  .set('Signature', 'keyId="x",headers="(request-target) host date digest",signature="s"')
  .send(activity as object)

let seq = 0
function create(audience: { to?: unknown; cc?: unknown }, objectAudience: { to?: unknown; cc?: unknown } = {}) {
  seq++
  return {
    id: `${ANN}/statuses/${seq}/activity`,
    type: 'Create',
    actor: ANN,
    ...audience,
    object: { id: `${ANN}/statuses/${seq}`, type: 'Note', attributedTo: ANN, content: '<p>hi</p>', ...objectAudience },
  }
}

beforeEach(() => {
  processed.length = 0
  rpcArgs.length = 0
  tables.profiles = [
    { id: 'bob-row', username: 'bob', is_local: true, federated_id: BOB },
    { id: 'ann-row', federated_id: ANN, followers_url: `${ANN}/followers/` },
  ]
  tables.follows = [{ id: 'f1', follower_id: 'bob-row', following_id: 'ann-row', status: 'accepted' }]
})

describe('personal inbox addressing', () => {
  it('accepts a Create addressed to the user on its embedded object only', async () => {
    const res = await deliver(create({}, { to: [BOB], cc: [] }))
    expect(res.status).toBe(202)
    expect(processed).toHaveLength(1)
  })

  it('accepts the user named by a link object', async () => {
    expect((await deliver(create({ to: { type: 'Link', href: BOB } }))).status).toBe(202)
    expect(processed).toHaveLength(1)
  })

  it('accepts the followers collection the sender declares, trailing slash or not', async () => {
    expect((await deliver(create({ to: `${ANN}/followers` }))).status).toBe(202)
    tables.profiles[1].followers_url = `${ANN}/followers`
    expect((await deliver(create({ to: `${ANN}/followers/` }))).status).toBe(202)
    expect(processed).toHaveLength(2)
  })

  it('records the activity with its addresses read once each, compact Public expanded', async () => {
    await deliver(create({ to: ['as:Public', { id: BOB }, BOB], cc: `${ANN}/followers` }))
    const stored = rpcArgs.find((c) => c.name === 'upsert_ap_activity')?.args
    expect(stored?.p_to_addresses).toEqual(['https://www.w3.org/ns/activitystreams#Public', BOB])
    expect(stored?.p_cc_addresses).toEqual([`${ANN}/followers`])
  })

  it('ignores an activity addressed to someone else (control)', async () => {
    const res = await deliver(create({ to: ['https://origin.test/users/followers_club'] }))
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ status: 'ignored', reason: 'not addressed to this user' })
    expect(processed).toEqual([])
  })
})
