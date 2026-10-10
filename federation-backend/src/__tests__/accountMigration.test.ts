import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'

// Account migration: alsoKnownAs/movedTo on actor documents in both directions, inbound
// Move (signature, origin, fresh target checks, idempotency left to
// record_remote_account_move), the account-moved job's delivery set and follower
// batches, and the membership a moved account brings to a server it rejoins.

const config = vi.hoisted(() => ({
  INSTANCE_DOMAIN: 'harmony.test',
  INSTANCE_NAME: 'Harmony Test',
  NODE_ENV: 'test',
  REQUIRE_VALID_SIGNATURES: false,
}))
vi.mock('../config/index.js', () => ({ default: config, config }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
  AppError: class extends Error {},
}))

const blocked = vi.hoisted(() => new Set<string>())
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: (d: string) => blocked.has(d) },
}))
vi.mock('../services/FederatedInstanceService.js', () => ({
  FederatedInstanceService: { touchFromUrl: vi.fn() },
}))

const verification = vi.hoisted(() => ({
  result: { verified: true, actorUrl: 'https://old.test/users/alice' } as { verified: boolean; actorUrl?: string; error?: string },
}))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: {
    verifySignature: vi.fn(async () => verification.result),
    verifyActorMatch: (a: string, b: string) => a === b,
  },
}))

const delivery = vi.hoisted(() => ({
  followerInboxes: [] as string[],
  sent: [] as Array<{ inbox: string; activity: any; sender: string }>,
  coMembers: [] as Array<{ instance: string; shared_inbox?: string }>,
}))
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: {
    followerInboxes: vi.fn(async () => delivery.followerInboxes),
    deliverEach: vi.fn(async (items: any[], sender: string) => {
      for (const item of items) delivery.sent.push({ inbox: item.inbox, activity: item.activity, sender })
    }),
    sendToInbox: vi.fn(async (inbox: string, activity: any, sender: string) => {
      delivery.sent.push({ inbox, activity, sender })
    }),
    enqueue: vi.fn(),
  },
}))
vi.mock('../utils/federationUtils.js', () => ({
  getServerCoMemberInstances: vi.fn(async () => delivery.coMembers),
  getChannelRecipientGroups: vi.fn(async () => []),
}))

// In-memory tables behind a PostgREST-shaped builder: eq/in/is filters, select,
// insert, update, delete, maybeSingle/single and a thenable result.
type Row = Record<string, any>
const db: Record<string, Row[]> = {}
const rpcCalls: Array<{ name: string; args: any }> = []
const rpcResults: Record<string, (args: any) => any> = {}

function from(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
  let payload: any
  let limit: number | undefined
  const run = () => {
    const rows = (db[table] ??= [])
    if (op === 'insert' || op === 'upsert') {
      const items = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => ({ id: `${table}-${rows.length + 1}`, ...p }))
      rows.push(...items)
      return { data: items, error: null }
    }
    const hit = rows.filter((r) => filters.every((f) => f(r)))
    if (op === 'update') hit.forEach((r) => Object.assign(r, payload))
    if (op === 'delete') db[table] = rows.filter((r) => !hit.includes(r))
    return { data: limit ? hit.slice(0, limit) : hit, error: null }
  }
  const b: any = {
    select: () => b,
    order: () => b,
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b },
    is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b },
    ilike: (c: string, v: string) => { filters.push((r) => String(r[c]).toLowerCase() === v.replace(/\\_/g, '_').toLowerCase()); return b },
    limit: (n: number) => { limit = n; return b },
    insert: (p: any) => { op = 'insert'; payload = p; return b },
    upsert: (p: any) => { op = 'upsert'; payload = p; return b },
    update: (p: any) => { op = 'update'; payload = p; return b },
    delete: () => { op = 'delete'; return b },
    maybeSingle: () => { const r = run(); return Promise.resolve({ data: r.data[0] ?? null, error: null }) },
    single: () => b.maybeSingle(),
    then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
  }
  return b
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from,
    rpc: (name: string, args: any) => {
      rpcCalls.push({ name, args })
      const data = rpcResults[name] ? rpcResults[name](args) : null
      return Promise.resolve({ data, error: null })
    },
  }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const { default: inboxRouter } = await import('../activitypub/InboxHandler.js')
const { actorToProfile, parseAlsoKnownAs, parseMovedTo } = await import('../activitypub/converters/fromActivityPub.js')
const { profileToActor } = await import('../activitypub/converters/toActivityPub.js')
const { buildMoveActivity, movedColumns } = await import('../activitypub/accountMigration.js')
const { handleAccountMovedJob } = await import('../queue/handlers/accountMovedHandler.js')
const { processServerInboxActivity } = await import('../activitypub/ServerInboxHandler.js')
const { parseAccountHandle } = await import('../routes/accountMigration.js')
const { moveNoticeText, notificationUrl, pushAllowedForType } = await import('../services/pushPolicy.js')
const { default: supertest } = await import('supertest')

const OLD = 'https://old.test/users/alice'
const NEW = 'https://new.test/users/alice'
const ORIGIN_ID = '00000000-0000-0000-0000-0000000000a1'
const TARGET_ID = '00000000-0000-0000-0000-0000000000b2'

/** refreshRemoteActor answers from this map: the actor document as served now. */
const served: Record<string, any> = {}
const refresh = vi.spyOn(ActivityProcessor, 'refreshRemoteActor').mockImplementation(async (url: string) => {
  const actor = served[url]
  if (!actor) return null
  const profile = (db.profiles ?? []).find((p) => p.federated_id === url)
  return profile ? { profile, actor } : null
})

function moveActivity(overrides: Record<string, unknown> = {}) {
  return { id: `${OLD}#moves/1`, type: 'Move', actor: OLD, object: OLD, target: NEW, ...overrides }
}

function recordCalls() {
  return rpcCalls.filter((c) => c.name === 'record_remote_account_move').map((c) => c.args)
}

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k]
  for (const k of Object.keys(served)) delete served[k]
  for (const k of Object.keys(rpcResults)) delete rpcResults[k]
  rpcCalls.length = 0
  blocked.clear()
  refresh.mockClear()
  delivery.followerInboxes = []
  delivery.sent = []
  delivery.coMembers = []
  verification.result = { verified: true, actorUrl: OLD }
  db.profiles = [
    { id: ORIGIN_ID, federated_id: OLD, is_local: false, moved_to_uri: null, moved_at: null, is_suspended: false },
    { id: TARGET_ID, federated_id: NEW, is_local: false, also_known_as: [OLD], moved_to_uri: null, is_suspended: false },
  ]
  served[NEW] = { id: NEW, type: 'Person', alsoKnownAs: [OLD] }
  rpcResults.record_remote_account_move = () => ({ migration_id: 'm-1', created: true })
})

describe('alsoKnownAs and movedTo', () => {
  it('reads aliases from a string, objects or an array, http(s) only, once each, at most 20', () => {
    expect(parseAlsoKnownAs(OLD)).toEqual([OLD])
    expect(parseAlsoKnownAs([OLD, { id: NEW }, OLD, 'ftp://x.test/u', 'not a url', 7, null])).toEqual([OLD, NEW])
    expect(parseAlsoKnownAs(Array.from({ length: 30 }, (_, i) => `https://a.test/u/${i}`))).toHaveLength(20)
    expect(parseAlsoKnownAs(undefined)).toEqual([])
  })

  it('reads movedTo from a string or an object', () => {
    expect(parseMovedTo(NEW)).toBe(NEW)
    expect(parseMovedTo({ id: NEW })).toBe(NEW)
    expect(parseMovedTo('javascript:alert(1)')).toBeNull()
    expect(parseMovedTo(undefined)).toBeNull()
  })

  it('maps an actor document onto profile columns, dropping self references', () => {
    const profile = actorToProfile({
      id: OLD, type: 'Person', preferredUsername: 'alice', inbox: `${OLD}/inbox`,
      alsoKnownAs: [OLD, NEW], movedTo: NEW,
    })
    expect(profile.also_known_as).toEqual([NEW])
    expect(profile.moved_to_uri).toBe(NEW)
    expect(actorToProfile({ id: OLD, inbox: `${OLD}/inbox`, movedTo: OLD }).moved_to_uri).toBeNull()
  })

  it('publishes a local account\'s aliases and move target with their JSON-LD terms', () => {
    const actor = profileToActor({ username: 'bob', also_known_as: [OLD, 'https://harmony.test/users/bob'], moved_to_uri: NEW })
    expect(actor.alsoKnownAs).toEqual([OLD])
    expect(actor.movedTo).toBe(NEW)
    expect(actor['@context'][2]).toEqual({
      alsoKnownAs: { '@id': 'as:alsoKnownAs', '@type': '@id' },
      movedTo: { '@id': 'as:movedTo', '@type': '@id' },
    })
    const plain = profileToActor({ username: 'bob', also_known_as: [] })
    expect(plain).not.toHaveProperty('alsoKnownAs')
    expect(plain).not.toHaveProperty('movedTo')
  })

  it('stamps moved_at when movedTo changes and resolves a stored target', async () => {
    const supabase = (await import('../config/supabase.js')).getSupabaseClient()
    const first = await movedColumns(supabase, { also_known_as: [], moved_to_uri: NEW }, { id: ORIGIN_ID, moved_to_uri: null })
    expect(first).toMatchObject({ moved_to_uri: NEW, moved_to_id: TARGET_ID })
    expect(first.moved_at).toEqual(expect.any(String))
    const same = await movedColumns(supabase, { also_known_as: [], moved_to_uri: NEW }, { id: ORIGIN_ID, moved_to_uri: NEW })
    expect(same).not.toHaveProperty('moved_at')
    expect(await movedColumns(supabase, { also_known_as: [NEW], moved_to_uri: null }, null))
      .toEqual({ also_known_as: [NEW], moved_to_uri: null, moved_to_id: null, moved_at: null })
  })

  it('builds Move in Mastodon\'s shape', () => {
    expect(buildMoveActivity(OLD, NEW, 'm-1')).toEqual({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${OLD}#moves/m-1`, type: 'Move', actor: OLD, object: OLD, target: NEW,
    })
  })

  it('pushes a move notice that opens the new account, under the follow preference', () => {
    const data = {
      origin: { username: 'alice', domain: 'old.test', display_name: 'Alice', is_local: false },
      target: { username: 'alice', domain: 'new.test', is_local: false },
      follow_status: 'pending',
    }
    expect(moveNoticeText(data)).toEqual({
      title: 'Alice moved to @alice@new.test',
      body: 'A follow request was sent to @alice@new.test for you.',
    })
    expect(notificationUrl('move', data)).toBe('/social/profile/alice@new.test')
    expect(pushAllowedForType('move', { activitypub_desktop_follows: false })).toBe(false)
  })

  it('parses account handles', () => {
    expect(parseAccountHandle('@alice@New.Test')).toEqual({ username: 'alice', domain: 'new.test' })
    expect(parseAccountHandle('bob')).toEqual({ username: 'bob', domain: null })
    expect(parseAccountHandle('a@b@c')).toBeNull()
    expect(parseAccountHandle('al ice@new.test')).toBeNull()
    expect(parseAccountHandle(42)).toBeNull()
  })
})

describe('ActivityProcessor.processMove', () => {
  it('records a Move whose fresh target lists the origin', async () => {
    await ActivityProcessor.processMove(moveActivity())
    expect(refresh).toHaveBeenCalledWith(NEW)
    expect(recordCalls()).toEqual([{ p_origin_id: ORIGIN_ID, p_target_id: TARGET_ID }])
  })

  it('accepts the target as an object reference', async () => {
    await ActivityProcessor.processMove(moveActivity({ object: { id: OLD }, target: { id: NEW, type: 'Person' } }))
    expect(recordCalls()).toHaveLength(1)
  })

  it('ignores a Move whose object is not its actor', async () => {
    await ActivityProcessor.processMove(moveActivity({ object: 'https://old.test/users/someone' }))
    expect(recordCalls()).toEqual([])
  })

  it('ignores a target that does not list the origin, judged on the document fetched now', async () => {
    served[NEW] = { id: NEW, type: 'Person', alsoKnownAs: [] }
    await ActivityProcessor.processMove(moveActivity())
    expect(recordCalls()).toEqual([])
  })

  it('ignores a target that has moved itself', async () => {
    served[NEW] = { id: NEW, type: 'Person', alsoKnownAs: [OLD], movedTo: 'https://third.test/users/alice' }
    await ActivityProcessor.processMove(moveActivity())
    expect(recordCalls()).toEqual([])
  })

  it('ignores a target that cannot be fetched', async () => {
    delete served[NEW]
    await ActivityProcessor.processMove(moveActivity())
    expect(recordCalls()).toEqual([])
  })

  it('never contacts a blocked target instance', async () => {
    blocked.add('new.test')
    await ActivityProcessor.processMove(moveActivity())
    expect(refresh).not.toHaveBeenCalled()
    expect(recordCalls()).toEqual([])
  })

  it('ignores a suspended target', async () => {
    db.profiles[1].is_suspended = true
    await ActivityProcessor.processMove(moveActivity())
    expect(recordCalls()).toEqual([])
  })

  it('ignores an unknown or local origin', async () => {
    db.profiles[0].is_local = true
    await ActivityProcessor.processMove(moveActivity())
    db.profiles[0].federated_id = 'https://elsewhere.test/users/x'
    await ActivityProcessor.processMove(moveActivity())
    expect(recordCalls()).toEqual([])
  })

  it('ignores a Move elsewhere inside 30 days of the last one; a repeat goes to the RPC', async () => {
    db.profiles[0].moved_to_uri = 'https://third.test/users/alice'
    db.profiles[0].moved_at = new Date(Date.now() - 86_400_000).toISOString()
    await ActivityProcessor.processMove(moveActivity())
    expect(recordCalls()).toEqual([])

    db.profiles[0].moved_to_uri = NEW
    await ActivityProcessor.processMove(moveActivity())
    expect(recordCalls()).toHaveLength(1)
  })

  it('checks a local target\'s aliases on its row, without a fetch', async () => {
    const local = 'https://harmony.test/users/bob'
    db.profiles.push({ id: 'local-bob', username: 'bob', federated_id: local, is_local: true, also_known_as: [OLD], moved_to_uri: null })
    await ActivityProcessor.processMove(moveActivity({ target: local }))
    expect(refresh).not.toHaveBeenCalled()
    expect(recordCalls()).toEqual([{ p_origin_id: ORIGIN_ID, p_target_id: 'local-bob' }])
  })
})

describe('inbox: Move', () => {
  function app() {
    const a = express()
    a.use(express.json({
      type: ['application/json', 'application/activity+json'],
      verify: (req: any, _res, buf) => { req.rawBody = buf },
    }))
    a.use('/', inboxRouter)
    return a
  }

  function post(body: unknown, signed = true, path = '/inbox') {
    const req = supertest(app()).post(path).set('Content-Type', 'application/activity+json')
    if (signed) req.set('Signature', `keyId="${OLD}#main-key",headers="(request-target)",signature="x"`)
    return req.send(body as object)
  }

  beforeEach(() => {
    rpcResults.claim_ap_activity = () => true
    db.profiles.push({ id: 'local-carol', username: 'carol', federated_id: 'https://harmony.test/users/carol', is_local: true })
  })

  it('refuses an unsigned Move even with REQUIRE_VALID_SIGNATURES off', async () => {
    const res = await post(moveActivity(), false)
    expect(res.status).toBe(401)
    expect(recordCalls()).toEqual([])
  })

  it('refuses a Move whose signature does not verify', async () => {
    verification.result = { verified: false, error: 'bad signature' }
    const res = await post(moveActivity())
    expect(res.status).toBe(401)
    expect(recordCalls()).toEqual([])
  })

  it('refuses a Move signed by another actor', async () => {
    verification.result = { verified: true, actorUrl: 'https://old.test/users/mallory' }
    const res = await post(moveActivity())
    expect(res.status).toBe(403)
    expect(recordCalls()).toEqual([])
  })

  it('accepts an unaddressed Move at a follower\'s personal inbox, as Mastodon sends it', async () => {
    const res = await post(moveActivity(), true, '/users/carol/inbox')
    expect(res.status).toBe(202)
    expect(res.body.message).toBe('Activity accepted')
    expect(recordCalls()).toEqual([{ p_origin_id: ORIGIN_ID, p_target_id: TARGET_ID }])
  })
})

describe('account-moved job', () => {
  beforeEach(() => {
    db.profiles.push({ id: 'local-bob', username: 'bob', is_local: true, deleted_at: null, moved_to_uri: NEW })
    db.account_migrations = [{
      id: 'm-1', profile_id: 'local-bob', target_profile_id: TARGET_ID, target_uri: NEW,
      delivered_at: null, cancelled_at: null,
    }]
    const batches = [200, 3]
    rpcResults.migrate_account_followers = () => batches.shift() ?? 0
    delivery.followerInboxes = ['https://a.test/inbox', 'https://b.test/inbox']
    delivery.coMembers = [{ instance: 'b.test', shared_inbox: 'https://b.test/inbox' }, { instance: 'c.test' }]
  })

  it('sends the Move to followers and co-member instances once each, then migrates in batches', async () => {
    await handleAccountMovedJob({ migration_id: 'm-1' })
    expect(delivery.sent.map((s) => s.inbox)).toEqual(['https://a.test/inbox', 'https://b.test/inbox', 'https://c.test/inbox'])
    expect(delivery.sent[0].activity).toEqual(buildMoveActivity('https://harmony.test/users/bob', NEW, 'm-1'))
    expect(delivery.sent.every((s) => s.sender === 'local-bob')).toBe(true)
    expect(rpcCalls.filter((c) => c.name === 'migrate_account_followers')).toHaveLength(2)
    expect(db.account_migrations[0].delivered_at).toEqual(expect.any(String))
  })

  it('does not forward a Move received from another instance', async () => {
    db.account_migrations[0].profile_id = ORIGIN_ID
    await handleAccountMovedJob({ migration_id: 'm-1' })
    expect(delivery.sent).toEqual([])
    expect(rpcCalls.filter((c) => c.name === 'migrate_account_followers')).toHaveLength(2)
  })

  it('sends nothing for a redirect cancelled before delivery', async () => {
    db.account_migrations[0].cancelled_at = new Date().toISOString()
    await handleAccountMovedJob({ migration_id: 'm-1' })
    expect(delivery.sent).toEqual([])
    expect(rpcCalls).toEqual([])
  })
})

describe('server Join from a moved account', () => {
  const SERVER = '00000000-0000-0000-0000-0000000000c3'
  const OLD_MEMBER = '00000000-0000-0000-0000-0000000000d4'
  const NEW_MEMBER = '00000000-0000-0000-0000-0000000000e5'
  const OLD_URI = 'https://old.test/users/member'
  const NEW_URI = 'https://new.test/users/member'
  const join = { id: `${NEW_URI}#join/1`, type: 'Join', actor: NEW_URI, object: `https://harmony.test/servers/${SERVER}` }

  beforeEach(() => {
    db.servers = [{ id: SERVER, is_local_server: true, federation_enabled: true, public: false, owner: 'owner' }]
    db.profiles.push(
      { id: OLD_MEMBER, federated_id: OLD_URI, is_local: false, moved_to_id: NEW_MEMBER, moved_to_uri: NEW_URI },
      { id: NEW_MEMBER, username: 'member', federated_id: NEW_URI, is_local: false, also_known_as: [OLD_URI],
        inbox_url: `${NEW_URI}/inbox`, is_suspended: false },
    )
    db.user_servers = [{ id: 'us-1', server_id: SERVER, user_id: OLD_MEMBER, status: 'accepted' }]
    db.server_bans = []
    served[NEW_URI] = { id: NEW_URI, alsoKnownAs: [OLD_URI] }
    served[OLD_URI] = { id: OLD_URI, movedTo: NEW_URI }
    vi.spyOn(ActivityProcessor as any, 'ensureRemoteUser').mockResolvedValue({ id: NEW_MEMBER })
    rpcResults.carry_over_moved_membership = () => 'carried'
  })

  const sentTypes = () => delivery.sent.map((s) => s.activity.type)

  it('admits the new account without an invite and carries the old membership over', async () => {
    await processServerInboxActivity(SERVER, join)
    expect(rpcCalls.map((c) => c.name)).not.toContain('consume_invite')
    expect(db.user_servers.some((m) => m.user_id === NEW_MEMBER && m.status === 'accepted')).toBe(true)
    expect(rpcCalls.find((c) => c.name === 'carry_over_moved_membership')?.args).toEqual({
      p_server_id: SERVER, p_profile_id: NEW_MEMBER, p_alias_id: OLD_MEMBER,
    })
    expect(sentTypes()).toEqual(['Accept'])
  })

  it('refuses the new account when the old one is banned', async () => {
    db.server_bans = [{ server_id: SERVER, user_id: OLD_MEMBER }]
    await processServerInboxActivity(SERVER, join)
    expect(db.user_servers.some((m) => m.user_id === NEW_MEMBER)).toBe(false)
    expect(sentTypes()).toEqual(['Reject'])
  })

  it('asks for an invite when the old account\'s document no longer points at the joiner', async () => {
    served[OLD_URI] = { id: OLD_URI, movedTo: 'https://third.test/users/member' }
    await processServerInboxActivity(SERVER, join)
    expect(rpcCalls.map((c) => c.name)).not.toContain('carry_over_moved_membership')
    expect(db.user_servers.some((m) => m.user_id === NEW_MEMBER)).toBe(false)
    expect(sentTypes()).toEqual(['Reject'])
  })

  it('asks for an invite when the joiner no longer lists the old account', async () => {
    served[NEW_URI] = { id: NEW_URI, alsoKnownAs: [] }
    await processServerInboxActivity(SERVER, join)
    expect(rpcCalls.map((c) => c.name)).not.toContain('carry_over_moved_membership')
    expect(sentTypes()).toEqual(['Reject'])
  })
})
