import { describe, it, expect, vi, beforeEach } from 'vitest'

// A remote actor's Delete of itself removes the account's follows and posts and silences
// it; a Follow of a chat server's Group is answered with the Group's Reject; an actor key
// that answers 410 is reported to the inbox.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => fn,
  AppError: class extends Error {},
}))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: () => false },
}))
const sent = vi.hoisted(() => [] as Array<{ inbox: string; activity: any; signer: unknown }>)
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: {
    sendToInbox: vi.fn(async (inbox: string, activity: any, signer: unknown) => { sent.push({ inbox, activity, signer }) }),
  },
}))
const fetchStatus = vi.hoisted(() => ({ status: 410 }))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(async () => new Response('', { status: fetchStatus.status })),
}))
vi.mock('../activitypub/InstanceActor.js', () => ({
  signAsInstanceActor: vi.fn(async () => ({ headers: {} })),
  isInstanceActorUsername: () => false,
}))

type Op = { table: string; op: string; values?: any; filters: Array<[string, string, unknown]> }
const ops: Op[] = []
const rows: Record<string, any[]> = {}

function query(table: string) {
  const op: Op = { table, op: 'select', filters: [] }
  const result = () => {
    if (op.op !== 'select') {
      ops.push(op)
      return { data: null, error: null }
    }
    const data = (rows[table] ?? []).filter((r) => op.filters.every(([kind, c, v]) => kind !== 'eq' || r[c] === v))
    return { data, error: null }
  }
  const q: any = {
    select: () => q,
    update: (values: any) => { op.op = 'update'; op.values = values; return q },
    delete: () => { op.op = 'delete'; return q },
    upsert: () => { op.op = 'upsert'; return q },
    eq: (c: string, v: unknown) => (op.filters.push(['eq', c, v]), q),
    or: (v: string) => (op.filters.push(['or', '', v]), q),
    is: (c: string, v: unknown) => (op.filters.push(['is', c, v]), q),
    in: () => q,
    limit: () => q,
    maybeSingle: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: null } },
    single: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: null } },
    then: (resolve: any) => resolve(result()),
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from: (t: string) => query(t), rpc: async () => ({ data: null, error: null }) }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const { processServerInboxActivity } = await import('../activitypub/ServerInboxHandler.js')
const { SignatureService } = await import('../activitypub/SignatureService.js')

const GONE = 'https://origin.test/users/gone'

beforeEach(() => {
  ops.length = 0
  sent.length = 0
  rows.profiles = [
    { id: 'gone-id', federated_id: GONE, is_local: false, is_suspended: false, deleted_at: null },
    { id: 'local-id', federated_id: 'https://harmony.test/users/alice', is_local: true, is_suspended: false, deleted_at: null },
  ]
  rows.posts = []
  rows.messages = []
})

const opsOn = (table: string, op: string) => ops.filter((o) => o.table === table && o.op === op)

describe('Delete of an actor by itself', () => {
  it('marks the remote account deleted, drops its follows both ways and soft-deletes its posts', async () => {
    await ActivityProcessor.processIncomingActivity({ id: `${GONE}#delete`, type: 'Delete', actor: GONE, object: GONE })

    const profileUpdate = opsOn('profiles', 'update')
    expect(profileUpdate).toHaveLength(1)
    expect(profileUpdate[0].values.deleted_at).toEqual(expect.any(String))
    expect(profileUpdate[0].filters).toContainEqual(['eq', 'id', 'gone-id'])

    expect(opsOn('follows', 'update')).toEqual([
      expect.objectContaining({ values: { status: 'rejected', accepted_at: null }, filters: [['eq', 'following_id', 'gone-id']] }),
    ])
    expect(opsOn('follows', 'delete').map((o) => o.filters)).toEqual([
      [['eq', 'following_id', 'gone-id']],
      [['eq', 'follower_id', 'gone-id']],
    ])
    const posts = opsOn('posts', 'update')
    expect(posts).toHaveLength(1)
    expect(posts[0].values).toMatchObject({ is_deleted: true })
    expect(posts[0].filters).toEqual([['eq', 'author_id', 'gone-id'], ['eq', 'is_deleted', false]])
  })

  it('touches no local account', async () => {
    await ActivityProcessor.processIncomingActivity({
      type: 'Delete', actor: 'https://harmony.test/users/alice', object: 'https://harmony.test/users/alice',
    })
    expect(ops).toEqual([])
  })

  it('silences the deleted account afterwards', async () => {
    rows.profiles[0].deleted_at = '2026-10-20T00:00:00Z'
    await ActivityProcessor.processIncomingActivity({ type: 'Delete', actor: GONE, object: 'https://origin.test/notes/1' })
    expect(ops).toEqual([])
  })
})

describe('Follow of a chat server', () => {
  const SERVER = 'f0180000-0000-0000-0000-000000000001'
  const GROUP = `https://harmony.test/servers/${SERVER}`
  const FAN = 'https://mastodon.test/users/fan'

  beforeEach(() => {
    rows.servers = [{ id: SERVER, is_local_server: true, federation_enabled: false, ap_id: null }]
    rows.profiles.push({ id: 'fan-id', federated_id: FAN, is_local: false, inbox_url: `${FAN}/inbox`, shared_inbox_url: 'https://mastodon.test/inbox' })
    vi.spyOn(ActivityProcessor as any, 'ensureRemoteUser').mockResolvedValue({ id: 'fan-id' })
  })

  it('is answered with the Group\'s Reject at the follower\'s inbox, federation on or off', async () => {
    const follow = { id: `${FAN}#follows/1`, type: 'Follow', actor: FAN, object: GROUP }
    await processServerInboxActivity(SERVER, follow, { verifiedSigner: FAN })
    expect(sent).toHaveLength(1)
    expect(sent[0].inbox).toBe(`${FAN}/inbox`)
    expect(sent[0].signer).toEqual({ serverId: SERVER })
    expect(sent[0].activity).toMatchObject({ type: 'Reject', actor: GROUP, object: follow })
  })

  it('a Follow naming something else is dropped', async () => {
    await processServerInboxActivity(SERVER, { id: `${FAN}#follows/2`, type: 'Follow', actor: FAN, object: 'https://harmony.test/users/alice' }, { verifiedSigner: FAN })
    expect(sent).toEqual([])
  })
})

describe('signature key fetch status', () => {
  it('reports the status of an actor key fetch that failed', async () => {
    fetchStatus.status = 410
    const date = new Date().toUTCString()
    const result = await SignatureService.verifySignature(
      'keyId="https://origin.test/users/unknown#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="c2ln"',
      { host: 'harmony.test', date },
      'POST',
      '/inbox',
    )
    expect(result).toMatchObject({ verified: false, actorUrl: 'https://origin.test/users/unknown', keyStatus: 410 })
  })
})
