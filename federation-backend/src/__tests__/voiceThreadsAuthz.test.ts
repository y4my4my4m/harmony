import { describe, it, expect, vi, beforeEach } from 'vitest'

// Voice, thread and server-inbox authorization. `activity.actor` is the
// verified signer; every other field is sender-chosen. Ported from the
// security audit's demonstrations, asserting the fixed behaviour.

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    PORT: 3001,
    NODE_ENV: 'test',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    USE_BULLMQ_QUEUE: false,
    CORS_ORIGIN: 'http://localhost:5173',
    REQUIRE_VALID_SIGNATURES: true,
    ALLOW_FEDERATED_VOICE: true,
    WEBRTC_MODE: 'hybrid',
    FEDERATION_MODE: 'unified',
    LIVEKIT_API_KEY: 'lk-key',
    LIVEKIT_API_SECRET: 'lk-secret-lk-secret-lk-secret-lk-secret',
    LIVEKIT_URL: 'wss://livekit.harmony.test',
  },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn() }))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: vi.fn(() => false) },
}))
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { enqueue: vi.fn(), sendToInbox: vi.fn() },
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let broadcasts: Array<{ channel: string; msg: any }> = []
let granted: Record<string, Set<string>> = {}
let nextId = 1

const read = (row: Row, col: string) => {
  const [base, key] = col.split('->>')
  return key ? row[base]?.[key] : row[base]
}

/** Permissions has_permission grants a profile, as `{profileId: Set<PERMISSION>}`. */
const grant = (profileId: string, ...perms: string[]) => { granted[profileId] = new Set(perms) }

function fakeSupabase() {
  return {
    rpc: (fn: string, args: any) => {
      if (fn === 'broadcast_user_event') broadcasts.push({ channel: `user:${args.p_user_id}`, msg: args.p_payload })
      return Promise.resolve({
        data: fn === 'has_permission' ? granted[args.p_user_id]?.has(args.p_permission) === true : null,
        error: null,
      })
    },
    channel(name: string) {
      return { send: (msg: any) => { broadcasts.push({ channel: name, msg }); return Promise.resolve('ok') } }
    },
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let op: 'select' | 'delete' | 'update' | 'upsert' = 'select'
      let patch: Row = {}
      let selectCols = ''
      let upserted: Row[] = []

      // threads embed: creator:profiles!threads_created_by_fkey(federated_id)
      const decorate = (rows: Row[]) =>
        op === 'select' && table === 'threads' && selectCols.includes('creator:')
          ? rows.map((r) => ({
              ...r,
              creator: { federated_id: (tables.profiles ?? []).find((p) => p.id === r.created_by)?.federated_id ?? null },
            }))
          : rows

      const run = () => {
        if (op === 'upsert') return upserted
        const rows = tables[table] ?? []
        const matched = rows.filter((row) => filters.every((f) => f(row)))
        if (op === 'delete') tables[table] = rows.filter((row) => !matched.includes(row))
        if (op === 'update') matched.forEach((row) => Object.assign(row, patch))
        return decorate(matched)
      }

      const builder: any = {
        select(cols?: string) { if (op === 'select') selectCols = cols ?? ''; return builder },
        delete() { op = 'delete'; return builder },
        update(p: Row) { op = 'update'; patch = p; return builder },
        insert(row: Row) {
          const stored = { id: `row-${nextId++}`, ...row }
          ;(tables[table] ??= []).push(stored)
          const result = { data: stored, error: null }
          return {
            select: () => ({ single: () => Promise.resolve(result), maybeSingle: () => Promise.resolve(result) }),
            then: (resolve: any) => resolve(result),
          }
        },
        upsert(row: Row, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          op = 'upsert'
          const key = opts?.onConflict?.split(',') ?? ['id']
          const rows = (tables[table] ??= [])
          const existing = rows.find((r) => key.every((k) => r[k] === row[k]))
          if (existing) {
            if (!opts?.ignoreDuplicates) { Object.assign(existing, row); upserted = [existing] }
          } else {
            const stored = { id: `row-${nextId++}`, ...row }
            rows.push(stored)
            upserted = [stored]
          }
          return builder
        },
        eq(col: string, val: any) { filters.push((row) => read(row, col) === val); return builder },
        gt(col: string, val: any) { filters.push((row) => read(row, col) > val); return builder },
        is(col: string, val: any) { filters.push((row) => (read(row, col) ?? null) === val); return builder },
        not(col: string, _op: string, val: any) { filters.push((row) => (read(row, col) ?? null) !== val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(read(row, col))); return builder },
        or(expr: string) {
          const clauses = [...expr.matchAll(/([\w]+(?:->>[\w]+)?)\.eq\.(?:"((?:[^"\\]|\\.)*)"|([^,]*))/g)]
            .map((m) => ({ col: m[1], val: (m[2] ?? m[3]).replace(/\\(.)/g, '$1') }))
          filters.push((row) => clauses.some((c) => read(row, c.col) === c.val))
          return builder
        },
        limit() { return builder },
        order() { return builder },
        maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }) },
        single() {
          const rows = run()
          return Promise.resolve(rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } })
        },
        then(resolve: any) { return resolve({ data: run(), error: null }) },
      }
      return builder
    },
  }
}

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => fakeSupabase() }))

const { VoiceActivityHandler } = await import('../activitypub/VoiceActivityHandler.js')
const { livekitService } = await import('../services/LiveKitService.js')
const { mintVoiceJoinId } = await import('../services/voiceAccess.js')
const { handleThreadActivity } = await import('../activitypub/ThreadActivityHandler.js')
const { processServerInboxActivity } = await import('../activitypub/ServerInboxHandler.js')
const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')

const FRESH = new Date().toISOString()
const LATER = '2999-01-01T00:00:00.000Z'
const LOCAL_ALICE = 'https://harmony.test/users/alice'
const MALLORY = 'https://evil.test/users/mallory'
const BOB = 'https://mastodon.test/users/bob'
const CAROL = 'https://remote.test/users/carol'
const DAVE = 'https://remote.test/users/dave'

const S = '11111111-1111-1111-1111-111111111111' // local server
const V = '22222222-2222-2222-2222-222222222222' // private voice channel in S
const R = '33333333-3333-3333-3333-333333333333' // remote server copy
const RV = '44444444-4444-4444-4444-444444444444' // voice channel in R
const C = '55555555-5555-5555-5555-555555555555' // text channel in S
const M = '66666666-6666-6666-6666-666666666666' // parent message in C
const T = '77777777-7777-7777-7777-777777777777' // carol's thread
const DM = '88888888-8888-8888-8888-888888888888' // alice <-> bob DM conversation
const REMOTE_CONV = '99999999-9999-9999-9999-999999999999' // bob's instance's conversation id

const jwtPayload = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
const voice = (a: any) => VoiceActivityHandler.processVoiceActivity(a as any)

beforeEach(() => {
  nextId = 1
  broadcasts = []
  granted = {}
  vi.mocked(DeliveryQueue.enqueue).mockReset()
  tables = {
    profiles: [
      { id: 'alice-id', username: 'alice', is_local: true, auth_user_id: 'alice-auth', federated_id: LOCAL_ALICE, updated_at: FRESH },
      { id: 'mallory-id', username: 'mallory', is_local: false, federated_id: MALLORY, updated_at: FRESH },
      { id: 'bob-id', username: 'bob', is_local: false, federated_id: BOB, updated_at: FRESH },
      { id: 'carol-id', username: 'carol', is_local: false, federated_id: CAROL, updated_at: FRESH },
      { id: 'dave-id', username: 'dave', is_local: false, federated_id: DAVE, updated_at: FRESH },
    ],
    servers: [
      { id: S, is_local_server: true, owner: 'alice-id', ap_id: `https://harmony.test/servers/${S}`, federation_enabled: true, host_domain: null, federation_domain: null },
      { id: R, is_local_server: false, owner: null, ap_id: `https://remote.test/servers/${R}`, federation_enabled: true, host_domain: 'remote.test', federation_domain: 'remote.test' },
    ],
    channels: [
      { id: V, server_id: S, name: 'staff-voice', ap_id: null },
      { id: C, server_id: S, name: 'general', ap_id: null },
      { id: RV, server_id: R, name: 'remote-voice', ap_id: `https://remote.test/servers/${R}/channels/${RV}` },
    ],
    conversations: [{ id: DM, type: 'direct' }],
    conversation_participants: [
      { id: 'cp-a', conversation_id: DM, user_id: 'alice-id', left_at: null },
      { id: 'cp-b', conversation_id: DM, user_id: 'bob-id', left_at: null },
    ],
    user_blocks: [],
    user_servers: [],
    server_bans: [],
    server_member_timeouts: [],
    user_roles: [],
    federated_voice_calls: [],
    voice_channel_participants: [],
    blocked_instances: [],
    messages: [],
    threads: [],
  }
})

const invite = (actor: string, roomName: string, extra: Record<string, any> = {}) => ({
  type: 'harmony:VoiceCallInvite',
  id: `${actor}/activities/${nextId++}`,
  actor,
  to: [LOCAL_ALICE],
  object: { type: 'harmony:VoiceCall', callType: 'voice', conversationId: REMOTE_CONV, livekitUrl: `wss://livekit.${new URL(actor).host}`, roomName },
  published: FRESH,
  ...extra,
})

describe('VoiceCallInvite', () => {
  it('stores nothing for a channel room and grants no token for it', async () => {
    const room = `channel-${V}`
    await voice(invite(MALLORY, room))
    expect(tables.federated_voice_calls).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)

    await expect(livekitService.generateFederatedToken({ actorId: MALLORY, roomName: room, roomType: 'voice_channel' }))
      .rejects.toThrow(/permission denied/)
    await expect(livekitService.generateFederatedToken({ actorId: MALLORY, roomName: room, roomType: 'dm_call' }))
      .rejects.toThrow(/permission denied/)
  })

  it('does not ring a user the caller shares no conversation with', async () => {
    await voice(invite(MALLORY, `federated-dm-${REMOTE_CONV}-1700000000000`))
    expect(tables.federated_voice_calls).toHaveLength(0)
    expect(broadcasts).toHaveLength(0)
  })

  it('does not ring across a block in either direction', async () => {
    tables.user_blocks.push({ blocker_id: 'alice-id', blocked_user_id: 'bob-id', expires_at: null })
    await voice(invite(BOB, `federated-dm-${REMOTE_CONV}-1700000000000`))
    expect(tables.federated_voice_calls).toHaveLength(0)

    tables.user_blocks = [{ blocker_id: 'bob-id', blocked_user_id: 'alice-id', expires_at: null }]
    await voice(invite(BOB, `federated-dm-${REMOTE_CONV}-1700000000001`))
    expect(tables.federated_voice_calls).toHaveLength(0)
  })

  it('rings a DM partner; the stored room grants nothing, the shared conversation does', async () => {
    const room = `federated-dm-${REMOTE_CONV}-1700000000000`
    await voice(invite(BOB, room))

    expect(tables.federated_voice_calls).toEqual([
      expect.objectContaining({ caller_federated_id: BOB, recipient_id: 'alice-id', conversation_id: DM, room_name: room, status: 'pending' }),
    ])
    const ring = broadcasts.find((b) => b.channel === 'user:alice-id')
    expect(ring?.msg).toMatchObject({ type: 'federated_call:incoming', conversationId: DM, roomName: room })
    expect(Date.parse(tables.federated_voice_calls[0].expires_at) - Date.now()).toBeLessThanOrEqual(60_000)

    // The caller's room names its own conversation id: not a conversation here.
    await expect(livekitService.generateFederatedToken({ actorId: BOB, roomName: room, roomType: 'dm_call' }))
      .rejects.toThrow(/permission denied/)
    const token = await livekitService.generateFederatedToken({ actorId: BOB, roomName: `dm-${DM}`, roomType: 'dm_call' })
    expect(jwtPayload(token).video).toMatchObject({ room: `dm-${DM}`, roomJoin: true })
  })

  it('does not overwrite a stored invite whose ap_id is replayed', async () => {
    const room = `federated-dm-${REMOTE_CONV}-1700000000000`
    const first = invite(BOB, room)
    await voice(first)
    tables.federated_voice_calls[0].status = 'ended'
    broadcasts = []
    await voice({ ...first, object: { ...first.object, roomName: `federated-dm-${REMOTE_CONV}-1800000000000` } })
    expect(tables.federated_voice_calls).toHaveLength(1)
    expect(tables.federated_voice_calls[0]).toMatchObject({ status: 'ended', room_name: room })
    expect(broadcasts).toHaveLength(0)
  })

  it('refuses an invite id on another host than the caller', async () => {
    await voice(invite(BOB, `federated-dm-${REMOTE_CONV}-1700000000000`, { id: 'https://evil.test/activities/1' }))
    expect(tables.federated_voice_calls).toHaveLength(0)
  })
})

describe('VoiceCallAccept/Reject/End', () => {
  const callId = 'https://mastodon.test/users/bob/activities/9'
  beforeEach(() => {
    tables.federated_voice_calls.push({
      id: 'call-1', ap_id: callId, caller_id: 'bob-id', caller_federated_id: BOB, recipient_id: 'alice-id',
      status: 'pending', room_name: 'r', livekit_url: 'u', expires_at: LATER,
    })
  })

  it('the caller cannot accept its own invite', async () => {
    await voice({ type: 'harmony:VoiceCallAccept', id: `${BOB}/a/2`, actor: BOB, object: callId, published: FRESH })
    expect(tables.federated_voice_calls[0].status).toBe('pending')
  })

  it('an unrelated actor cannot accept, reject or end the call', async () => {
    for (const type of ['harmony:VoiceCallAccept', 'harmony:VoiceCallReject', 'harmony:VoiceCallEnd']) {
      await voice({ type, id: `${MALLORY}/a/${type}`, actor: MALLORY, object: callId, published: FRESH })
    }
    expect(tables.federated_voice_calls[0].status).toBe('pending')
    expect(broadcasts).toHaveLength(0)
  })

  it('the caller ends its own call', async () => {
    await voice({ type: 'harmony:VoiceCallEnd', id: `${BOB}/a/3`, actor: BOB, object: callId, published: FRESH })
    expect(tables.federated_voice_calls[0].status).toBe('ended')
    expect(broadcasts).toContainEqual({ channel: 'user:alice-id', msg: expect.objectContaining({ type: 'federated_call:ended' }) })
  })
})

describe('VoiceChannelJoinAccept', () => {
  const result = { type: 'harmony:VoiceToken', livekitUrl: 'wss://livekit.remote.test', token: 'TOKEN', roomName: `channel-${RV}`, expiresAt: FRESH }
  const accept = (actor: string, object: string) => ({
    type: 'harmony:VoiceChannelJoinAccept', id: `${actor}/a/${nextId++}`, actor, to: [LOCAL_ALICE], object, result, published: FRESH,
  })

  it('is ignored when it answers no join this user sent', async () => {
    await voice(accept(MALLORY, `${LOCAL_ALICE}/activities/anything`))
    await voice(accept(CAROL, `${LOCAL_ALICE}/activities/voice-join/forged.9999999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`))
    expect(broadcasts).toHaveLength(0)
  })

  it('is ignored from a host other than the one the join went to', async () => {
    const joinId = mintVoiceJoinId(LOCAL_ALICE, 'alice-id', 'remote.test')
    await voice(accept(MALLORY, joinId))
    expect(broadcasts).toHaveLength(0)
  })

  it('is ignored once the join has expired', async () => {
    const joinId = mintVoiceJoinId(LOCAL_ALICE, 'alice-id', 'remote.test', Date.now() - 10 * 60_000)
    await voice(accept(CAROL, joinId))
    expect(broadcasts).toHaveLength(0)
  })

  it('delivers the token for a pending join from its host, naming join and host', async () => {
    const joinId = mintVoiceJoinId(LOCAL_ALICE, 'alice-id', 'remote.test')
    await voice(accept(CAROL, joinId))
    // Delivered on the private user channel, never a public broadcast topic.
    expect(broadcasts.map((x) => x.channel)).toEqual(['user:alice-id'])
    expect(broadcasts[0].msg).toMatchObject({ type: 'federated_voice:token', originalJoinId: joinId, serverHost: 'remote.test', token: 'TOKEN' })
  })

  it('a join id minted for another user does not deliver to this one', async () => {
    const joinId = mintVoiceJoinId(LOCAL_ALICE, 'someone-else', 'remote.test')
    await voice(accept(CAROL, joinId))
    expect(broadcasts).toHaveLength(0)
  })
})

describe('VoiceChannelJoin on a local server', () => {
  const join = () => voice({
    type: 'harmony:VoiceChannelJoin', id: `${MALLORY}/a/${nextId++}`, actor: MALLORY,
    object: { type: 'harmony:VoiceChannel', id: `https://harmony.test/servers/${S}/channels/${V}`, name: 'staff-voice' },
    published: FRESH,
  })

  beforeEach(() => {
    tables.user_servers.push({ user_id: 'mallory-id', server_id: S, status: 'accepted' })
  })

  it('mints no token for a timed-out member', async () => {
    grant('mallory-id', 'VIEW_CHANNEL', 'CONNECT', 'SPEAK')
    tables.server_member_timeouts.push({ user_id: 'mallory-id', server_id: S, until: LATER })
    await join()
    expect(DeliveryQueue.enqueue).not.toHaveBeenCalled()
  })

  it('mints no token without VIEW_CHANNEL and CONNECT', async () => {
    grant('mallory-id', 'VIEW_CHANNEL')
    await join()
    grant('mallory-id', 'CONNECT')
    await join()
    expect(DeliveryQueue.enqueue).not.toHaveBeenCalled()
  })

  it('mints no token for a banned or pending member, or with federation off', async () => {
    grant('mallory-id', 'VIEW_CHANNEL', 'CONNECT', 'SPEAK')
    tables.server_bans.push({ id: 'ban-1', server_id: S, user_id: 'mallory-id' })
    await join()
    tables.server_bans = []
    tables.user_servers[0].status = 'pending'
    await join()
    tables.user_servers[0].status = 'accepted'
    tables.servers[0].federation_enabled = false
    await join()
    expect(DeliveryQueue.enqueue).not.toHaveBeenCalled()
  })

  it('a member without SPEAK listens only', async () => {
    grant('mallory-id', 'VIEW_CHANNEL', 'CONNECT')
    tables.profiles[0].federated_id = LOCAL_ALICE
    await join()
    expect(DeliveryQueue.enqueue).toHaveBeenCalledTimes(1)
    const [accept, inbox] = vi.mocked(DeliveryQueue.enqueue).mock.calls[0] as any[]
    expect(inbox).toBe('https://evil.test/inbox')
    expect(jwtPayload(accept.result.token).video).toMatchObject({ room: `channel-${V}`, canSubscribe: true, canPublish: false })
  })

  it('a member with SPEAK publishes', async () => {
    grant('mallory-id', 'VIEW_CHANNEL', 'CONNECT', 'SPEAK')
    await join()
    const [accept] = vi.mocked(DeliveryQueue.enqueue).mock.calls[0] as any[]
    expect(jwtPayload(accept.result.token).video).toMatchObject({ canPublish: true })
  })
})

describe('LiveKit tokens for local users', () => {
  beforeEach(() => {
    tables.profiles.push({ id: 'eve-id', username: 'eve', is_local: true, auth_user_id: 'eve-auth', federated_id: null, updated_at: FRESH })
    tables.user_servers.push({ user_id: 'eve-id', server_id: S, status: 'accepted' })
    grant('eve-id', 'VIEW_CHANNEL', 'CONNECT', 'SPEAK')
  })
  const token = (roomName: string, roomType: 'voice_channel' | 'dm_call' = 'voice_channel') =>
    livekitService.generateToken({ userId: 'eve-auth', roomName, roomType })

  it('grants a member with VIEW_CHANNEL and CONNECT', async () => {
    await expect(token(`channel-${V}`)).resolves.toMatchObject({ profileId: 'eve-id' })
  })

  it('refuses a banned, pending or timed-out member, and missing CONNECT', async () => {
    tables.server_bans.push({ id: 'b', server_id: S, user_id: 'eve-id' })
    await expect(token(`channel-${V}`)).rejects.toThrow(/permission denied/)
    tables.server_bans = []
    tables.user_servers[0].status = 'pending'
    await expect(token(`channel-${V}`)).rejects.toThrow(/permission denied/)
    tables.user_servers[0].status = 'accepted'
    tables.server_member_timeouts.push({ user_id: 'eve-id', server_id: S, until: LATER })
    await expect(token(`channel-${V}`)).rejects.toThrow(/permission denied/)
    tables.server_member_timeouts = []
    grant('eve-id', 'VIEW_CHANNEL')
    await expect(token(`channel-${V}`)).rejects.toThrow(/permission denied/)
  })

  it('refuses a channel room asked for as a DM call', async () => {
    await expect(token(`channel-${V}`, 'dm_call')).rejects.toThrow(/permission denied/)
  })
})

describe('VoiceChannelJoin on a remote server copy', () => {
  const presence = (actor: string) => voice({
    type: 'harmony:VoiceChannelJoin', id: `${actor}/a/${nextId++}`, actor,
    object: { type: 'harmony:VoiceChannel', id: `https://remote.test/servers/${R}/channels/${RV}`, name: 'remote-voice' },
    published: FRESH,
  })

  it('records nothing for a sender off the server host', async () => {
    tables.user_servers.push({ user_id: 'mallory-id', server_id: R, status: 'accepted' })
    await presence(MALLORY)
    expect(tables.voice_channel_participants).toEqual([])
    expect(broadcasts).toHaveLength(0)
  })

  it('records nothing for a host user who is not a member', async () => {
    await presence(DAVE)
    expect(tables.voice_channel_participants).toEqual([])
  })

  it('records presence of a host member', async () => {
    tables.user_servers.push({ user_id: 'dave-id', server_id: R, status: 'accepted' })
    await presence(DAVE)
    expect(tables.voice_channel_participants).toEqual([
      expect.objectContaining({ channel_id: RV, server_id: R, user_id: 'dave-id', is_federated: true }),
    ])
    expect(broadcasts.some((b) => b.channel === `voice-channels:${R}`)).toBe(true)
  })
})

describe('ChatThread Create on an existing thread', () => {
  const threadApId = `https://remote.test/threads/${T}`
  const create = (actor: string, name: string) => ({
    type: 'Create', id: `https://remote.test/a/${nextId++}`, actor, published: FRESH,
    object: {
      type: 'ChatThread', id: threadApId, name, locked: true,
      context: `https://harmony.test/servers/${S}/channels/${C}`,
      inReplyTo: `https://harmony.test/messages/${M}`,
    },
  } as any)

  beforeEach(() => {
    tables.user_servers.push(
      { user_id: 'carol-id', server_id: S, status: 'accepted' },
      { user_id: 'dave-id', server_id: S, status: 'accepted' },
    )
    tables.messages.push({ id: M, channel_id: C, metadata: {} })
    for (const id of ['carol-id', 'dave-id']) {
      grant(id, 'VIEW_CHANNEL', 'CREATE_PUBLIC_THREADS', 'SEND_MESSAGES')
    }
  })

  it('another user on the same host cannot take the thread over', async () => {
    tables.threads.push({ id: T, channel_id: C, parent_message_id: M, name: 'carol thread', created_by: 'carol-id', ap_id: threadApId, federation_status: 'synced' })

    expect(await handleThreadActivity(create(DAVE, 'hijacked'), { serverId: S }))
      .toEqual({ success: false, error: 'Signer is not the thread creator' })
    expect(tables.threads[0]).toMatchObject({ name: 'carol thread', created_by: 'carol-id' })

    const del = { type: 'Delete', id: 'https://remote.test/a/d1', actor: DAVE, object: { type: 'ChatThread', id: threadApId }, published: FRESH } as any
    expect(await handleThreadActivity(del, { serverId: S })).toEqual({ success: false, error: 'Signer is not the thread creator' })
    expect(tables.threads).toHaveLength(1)
  })

  it('the creator re-sends its Create without changing ownership', async () => {
    tables.threads.push({ id: T, channel_id: C, parent_message_id: M, name: 'carol thread', created_by: 'carol-id', ap_id: threadApId, federation_status: 'synced' })
    expect(await handleThreadActivity(create(CAROL, 'renamed'), { serverId: S })).toEqual({ success: true })
    expect(tables.threads[0]).toMatchObject({ name: 'renamed', created_by: 'carol-id' })
  })

  it("the thread's Create claims a stub made from an earlier message", async () => {
    tables.threads.push({ id: T, channel_id: C, parent_message_id: 'placeholder', name: 'first message', created_by: 'dave-id', ap_id: threadApId, federation_status: 'stub' })
    expect(await handleThreadActivity(create(CAROL, 'carol thread'), { serverId: S })).toEqual({ success: true })
    expect(tables.threads[0]).toMatchObject({ name: 'carol thread', created_by: 'carol-id', parent_message_id: M, federation_status: 'synced' })

    // Claimed once; afterwards the stub's author cannot claim it back.
    expect(await handleThreadActivity(create(DAVE, 'back'), { serverId: S }))
      .toEqual({ success: false, error: 'Signer is not the thread creator' })
  })
})

describe('Server inbox and profile suspension', () => {
  it('a suspended remote member creates no thread through /servers/:id/inbox', async () => {
    tables.profiles.find((p) => p.id === 'dave-id')!.is_suspended = true
    tables.user_servers.push({ user_id: 'dave-id', server_id: S, status: 'accepted' })
    tables.messages.push({ id: M, channel_id: C, metadata: {} })
    grant('dave-id', 'VIEW_CHANNEL', 'CREATE_PUBLIC_THREADS')

    await processServerInboxActivity(S, {
      type: 'Create', id: 'https://remote.test/a/c2', actor: DAVE, published: FRESH,
      object: {
        type: 'ChatThread', id: 'https://remote.test/threads/88888888-8888-8888-8888-888888888888', name: 'from suspended',
        context: `https://harmony.test/servers/${S}/channels/${C}`, inReplyTo: `https://harmony.test/messages/${M}`,
      },
    })
    expect(tables.threads).toEqual([])
  })

  it('the same Create from an unsuspended member goes through', async () => {
    tables.user_servers.push({ user_id: 'dave-id', server_id: S, status: 'accepted' })
    tables.messages.push({ id: M, channel_id: C, metadata: {} })
    grant('dave-id', 'VIEW_CHANNEL', 'CREATE_PUBLIC_THREADS')

    await processServerInboxActivity(S, {
      type: 'Create', id: 'https://remote.test/a/c3', actor: DAVE, published: FRESH,
      object: {
        type: 'ChatThread', id: 'https://remote.test/threads/88888888-8888-8888-8888-888888888888', name: 'from dave',
        context: `https://harmony.test/servers/${S}/channels/${C}`, inReplyTo: `https://harmony.test/messages/${M}`,
      },
    })
    expect(tables.threads).toEqual([expect.objectContaining({ name: 'from dave', created_by: 'dave-id' })])
  })
})

describe('Server inbox Remove(member)', () => {
  const KICK = String(1n << 9n)
  const kick = (actor: string, target: string) =>
    processServerInboxActivity(S, { type: 'Remove', id: `${actor}/a/${nextId++}`, actor, object: target })

  beforeEach(() => {
    tables.user_servers.push(
      { user_id: 'alice-id', server_id: S, status: 'accepted' },
      { user_id: 'mallory-id', server_id: S, status: 'accepted' },
      { user_id: 'carol-id', server_id: S, status: 'accepted' },
      { user_id: 'dave-id', server_id: S, status: 'accepted' },
    )
    tables.user_roles.push(
      { user_id: 'mallory-id', server_id: S, server_roles: { is_admin: false, permissions: KICK, position: 5 } },
      { user_id: 'carol-id', server_id: S, server_roles: { is_admin: false, permissions: '0', position: 5 } },
      { user_id: 'dave-id', server_id: S, server_roles: { is_admin: false, permissions: '0', position: 2 } },
    )
  })
  const member = (id: string) => tables.user_servers.find((r) => r.user_id === id)

  it('a remote KICK_MEMBERS holder cannot kick the owner', async () => {
    await kick(MALLORY, LOCAL_ALICE)
    expect(member('alice-id')).toBeDefined()
  })

  it('cannot kick a member with an equal role', async () => {
    await kick(MALLORY, CAROL)
    expect(member('carol-id')).toBeDefined()
  })

  it('kicks a member with a lower role', async () => {
    await kick(MALLORY, DAVE)
    expect(member('dave-id')).toBeUndefined()
  })

  it('a member without KICK_MEMBERS kicks nobody, but leaves on its own', async () => {
    await kick(CAROL, DAVE)
    expect(member('dave-id')).toBeDefined()
    await kick(CAROL, CAROL)
    expect(member('carol-id')).toBeUndefined()
  })
})
