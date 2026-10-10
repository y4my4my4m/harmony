import { describe, it, expect, vi, beforeEach } from 'vitest'

// Follow requests: inbound Follow to a locked account, from a blocked account, Undo of a
// follow of a local profile stored without federated_id, Accept/Reject of an outbound
// follow, and the locked flag of remote actors.

const config = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'harmony.test',
  NODE_ENV: 'test',
  REQUIRE_VALID_SIGNATURES: false,
}))
vi.mock('../config/index.js', () => ({ default: config, config }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { verifyActorMatch: (a: string, b: string) => a === b },
}))

const sent = vi.hoisted(() => [] as Array<{ inbox: string; activity: any; sender: string }>)
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: {
    sendToInbox: vi.fn(async (inbox: string, activity: any, sender: string) => {
      sent.push({ inbox, activity, sender })
    }),
  },
}))
vi.mock('../activitypub/webfingerClient.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  confirmActorAcct: vi.fn(async () => null),
}))
vi.mock('../activitypub/remoteCounts.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  refreshRemoteProfileCounts: vi.fn(async () => undefined),
}))
vi.mock('../activitypub/instanceSoftware.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  noteDocumentSoftware: vi.fn(),
}))

// In-memory tables behind a PostgREST-shaped builder. Writes are logged in order.
type Row = Record<string, any>
let db: Record<string, Row[]> = {}
let writes: Array<{ table: string; op: string; payload?: any; ids: string[] }> = []
let nextId = 0

function from(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  let payload: any
  let conflict: string[] = ['id']
  const run = () => {
    const rows = (db[table] ??= [])
    if (op === 'insert' || op === 'upsert') {
      const items = Array.isArray(payload) ? payload : [payload]
      const out: Row[] = []
      for (const item of items) {
        const existing = op === 'upsert'
          ? rows.find((r) => conflict.every((c) => r[c] === item[c]))
          : undefined
        if (existing) {
          Object.assign(existing, item)
          out.push(existing)
        } else {
          const row = { id: `${table}-${++nextId}`, ...item }
          rows.push(row)
          out.push(row)
        }
      }
      writes.push({ table, op, payload, ids: out.map((r) => r.id) })
      return { data: out, error: null }
    }
    const hit = rows.filter((r) => filters.every((f) => f(r)))
    if (op === 'update') hit.forEach((r) => Object.assign(r, payload))
    if (op === 'delete') db[table] = rows.filter((r) => !hit.includes(r))
    if (op !== 'select') writes.push({ table, op, payload, ids: hit.map((r) => r.id) })
    return { data: hit, error: null }
  }
  const b: any = {
    select: () => b,
    order: () => b,
    limit: () => b,
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b },
    is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b },
    ilike: (c: string, v: string) => {
      filters.push((r) => String(r[c]).toLowerCase() === v.replace(/\\_/g, '_').toLowerCase())
      return b
    },
    insert: (p: any) => { op = 'insert'; payload = p; return b },
    upsert: (p: any, opts?: { onConflict?: string }) => {
      op = 'upsert'
      payload = p
      if (opts?.onConflict) conflict = opts.onConflict.split(',')
      return b
    },
    update: (p: any) => { op = 'update'; payload = p; return b },
    delete: () => { op = 'delete'; return b },
    maybeSingle: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
    single: () => {
      const r = run().data
      return Promise.resolve(r.length === 1 ? { data: r[0], error: null } : { data: null, error: { message: 'no rows' } })
    },
    then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
  }
  return b
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from, rpc: vi.fn(async () => ({ data: null, error: null })) }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const inbound = (activity: any) => ActivityProcessor.processIncomingActivity(activity)

const REMOTE = 'https://remote.test/users/carol'
const REMOTE_INBOX = 'https://remote.test/users/carol/inbox'
const LOCAL = 'https://harmony.test/users/bob'
const now = () => new Date().toISOString()

const bob = (extra: Row = {}): Row => ({
  id: 'bob-id', username: 'bob', is_local: true, federated_id: LOCAL,
  manually_approves_followers: false, ...extra,
})
const carol = (extra: Row = {}): Row => ({
  id: 'carol-id', username: 'carol', domain: 'remote.test', is_local: false,
  federated_id: REMOTE, inbox_url: REMOTE_INBOX, updated_at: now(), ...extra,
})

beforeEach(() => {
  db = { profiles: [bob(), carol()], follows: [], user_blocks: [] }
  writes = []
  sent.length = 0
})

const followsOf = (followerId: string) => (db.follows ?? []).filter((f) => f.follower_id === followerId)

describe('inbound Follow', () => {
  const follow = { id: 'https://remote.test/follows/1', type: 'Follow', actor: REMOTE, object: LOCAL }

  it('to a locked account stores a pending request and sends no Accept', async () => {
    db.profiles[0].manually_approves_followers = true
    await inbound(follow)

    expect(followsOf('carol-id')).toMatchObject([
      { following_id: 'bob-id', status: 'pending', ap_id: follow.id, accepted_at: null },
    ])
    expect(sent).toEqual([])
  })

  it('to an unlocked account is accepted and answered with an Accept', async () => {
    await inbound(follow)

    expect(followsOf('carol-id')).toMatchObject([{ following_id: 'bob-id', status: 'accepted' }])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ inbox: REMOTE_INBOX, sender: 'bob-id' })
    expect(sent[0].activity).toMatchObject({ type: 'Accept', object: { id: follow.id } })
  })

  it('from an account the target blocks is rejected and not stored', async () => {
    db.user_blocks.push({ id: 'block-1', blocker_id: 'bob-id', blocked_user_id: 'carol-id' })
    await inbound(follow)

    expect(followsOf('carol-id')).toEqual([])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ inbox: REMOTE_INBOX, sender: 'bob-id' })
    expect(sent[0].activity).toMatchObject({ type: 'Reject', actor: LOCAL, object: { id: follow.id } })
  })
})

describe('inbound Undo(Follow)', () => {
  it('finds a local followee stored without federated_id', async () => {
    db.profiles[0].federated_id = null
    db.follows.push({ id: 'f1', follower_id: 'carol-id', following_id: 'bob-id', status: 'accepted' })

    await inbound({
      id: 'https://remote.test/undo/1',
      type: 'Undo',
      actor: REMOTE,
      object: { id: 'https://remote.test/follows/1', type: 'Follow', actor: REMOTE, object: LOCAL },
    })

    expect(db.follows).toEqual([])
  })
})

describe('answers to an outbound follow', () => {
  beforeEach(() => {
    db.follows.push({
      id: '0f0f0f0f-0000-4000-8000-000000000001', follower_id: 'bob-id', following_id: 'carol-id',
      status: 'pending', ap_id: null,
    })
  })

  it('an Accept naming only the Follow id accepts the request', async () => {
    await inbound({
      id: 'https://remote.test/accepts/1',
      type: 'Accept',
      actor: REMOTE,
      object: 'https://harmony.test/activities/follow/0f0f0f0f-0000-4000-8000-000000000001',
    })

    expect(db.follows[0]).toMatchObject({ status: 'accepted' })
  })

  it('a Reject marks the follow rejected before deleting it, so no Undo is queued', async () => {
    await inbound({
      id: 'https://remote.test/rejects/1',
      type: 'Reject',
      actor: REMOTE,
      object: { id: 'https://harmony.test/activities/follow/0f0f0f0f-0000-4000-8000-000000000001', type: 'Follow', actor: LOCAL, object: REMOTE },
    })

    const followWrites = writes.filter((w) => w.table === 'follows')
    expect(followWrites.map((w) => w.op)).toEqual(['update', 'delete'])
    expect(followWrites[0].payload).toMatchObject({ status: 'rejected' })
    expect(db.follows).toEqual([])
  })
})

describe('locked flag of remote actors', () => {
  const actor = (extra: Row = {}) => ({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: 'https://remote.test/users/dave',
    type: 'Person',
    preferredUsername: 'dave',
    name: 'Dave',
    inbox: 'https://remote.test/users/dave/inbox',
    outbox: 'https://remote.test/users/dave/outbox',
    followers: 'https://remote.test/users/dave/followers',
    following: 'https://remote.test/users/dave/following',
    ...extra,
  })
  const dave = () => db.profiles.find((p) => p.federated_id === 'https://remote.test/users/dave')

  it('is stored from the actor document', async () => {
    await (ActivityProcessor as any).storeRemoteActor(
      'https://remote.test/users/dave', actor({ manuallyApprovesFollowers: true }), null)
    expect(dave()).toMatchObject({ is_local: false, manually_approves_followers: true })
  })

  it('follows Update(Person), an absent key reading as unlocked', async () => {
    db.profiles.push({ id: 'dave-id', username: 'dave', is_local: false,
      federated_id: 'https://remote.test/users/dave', manually_approves_followers: false })

    await inbound({ id: 'https://remote.test/u/1', type: 'Update', actor: 'https://remote.test/users/dave',
      object: actor({ manuallyApprovesFollowers: true }) })
    expect(dave()?.manually_approves_followers).toBe(true)

    await inbound({ id: 'https://remote.test/u/2', type: 'Update', actor: 'https://remote.test/users/dave',
      object: actor() })
    expect(dave()?.manually_approves_followers).toBe(false)
  })
})
