import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { TrackSource } from 'livekit-server-sdk'

// Voice grants and moderation (20261017100002_voice_moderation.sql):
//   - STREAM governs camera and screen share, SPEAK the microphone;
//   - a server mute withholds the microphone, a server deafen also every subscription;
//   - a moderator's move admits the member to the destination without CONNECT for a while;
//   - the routes run the RPC as the caller, then bring LiveKit in line;
//   - the worker's sweep removes participants who lost membership and syncs stale flags.

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    NODE_ENV: 'test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    ALLOW_FEDERATED_VOICE: true,
    WEBRTC_MODE: 'hybrid',
    LIVEKIT_API_KEY: 'lk-key',
    LIVEKIT_API_SECRET: 'lk-secret-lk-secret-lk-secret-lk-secret',
    LIVEKIT_URL: 'wss://livekit.harmony.test',
  },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../activitypub/DeliveryQueue.js', () => ({ DeliveryQueue: { sendToInbox: vi.fn(), enqueue: vi.fn(), deliverOnce: vi.fn() } }))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let granted: Record<string, Set<string>> = {}
let rpcAnswer: { data: any; error: any } = { data: null, error: null }
let rpcCalls: Array<{ fn: string; args: any; as: string }> = []

const grant = (profileId: string, ...perms: string[]) => { granted[profileId] = new Set(perms) }

function fakeSupabase() {
  return {
    rpc: (fn: string, args: any) => Promise.resolve({
      data: fn === 'has_permission' ? granted[args.p_user_id]?.has(args.p_permission) === true : null,
      error: null,
    }),
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      const run = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
      const builder: any = {
        select() { return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        gt(col: string, val: any) { filters.push((row) => row[col] > val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder },
        maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }) },
        single() { return Promise.resolve({ data: run()[0] ?? null, error: null }) },
        then(resolve: any) { return resolve({ data: run(), error: null }) },
      }
      return builder
    },
  }
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => fakeSupabase(),
  getSupabaseClientWithAuth: (token: string) => ({
    auth: { getUser: async () => ({ data: { user: token ? { id: token } : null }, error: null }) },
    rpc: (fn: string, args: any) => {
      rpcCalls.push({ fn, args, as: token })
      return Promise.resolve(rpcAnswer)
    },
  }),
}))

const room = {
  listRooms: vi.fn(),
  listParticipants: vi.fn(),
  updateParticipant: vi.fn(async () => ({})),
  removeParticipant: vi.fn(async () => undefined),
}

const { livekitService } = await import('../services/LiveKitService.js')
vi.spyOn(livekitService, 'roomServiceClient').mockReturnValue(room as any)
const { liveKitGrant, participantPermission, mergeVoiceMetadata } = await import('../services/voiceGrants.js')
const { syncVoiceMember, enforceVoiceRooms } = await import('../services/voiceModeration.js')
const { default: voiceRouter, MOVE_GRACE_MS } = await import('../routes/voice.js')
const { getSupabaseClient } = await import('../config/supabase.js')

const S = '11111111-1111-4111-8111-111111111111'
const V = '22222222-2222-4222-8222-222222222222'
const W = '33333333-3333-4333-8333-333333333333'
const EVE = 'eeeeeeee-0000-4000-8000-000000000001'
const MOD = 'dddddddd-0000-4000-8000-000000000002'
const BOB_ACTOR = 'https://remote.test/users/bob'
const LATER = '2999-01-01T00:00:00.000Z'
const EARLIER = '2000-01-01T00:00:00.000Z'

const jwtPayload = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
const deps = () => ({ roomService: room as any, supabase: getSupabaseClient() as any, instanceDomain: 'harmony.test' })

const ALL: Parameters<typeof liveKitGrant>[1] = {
  canSpeak: true, canStream: true, canHear: true, canSoundboard: true, canExternalSounds: true,
  serverMuted: false, serverDeafened: false,
}

beforeEach(() => {
  granted = {}
  rpcCalls = []
  rpcAnswer = { data: null, error: null }
  for (const fn of Object.values(room)) fn.mockClear()
  room.listRooms.mockResolvedValue([])
  room.listParticipants.mockResolvedValue([])
  tables = {
    profiles: [
      { id: EVE, auth_user_id: 'eve-auth', username: 'eve', is_local: true, federated_id: null },
      { id: MOD, auth_user_id: 'mod-auth', username: 'mod', is_local: true, federated_id: null },
      { id: 'bob-id', username: 'bob', is_local: false, federated_id: BOB_ACTOR, is_suspended: false },
    ],
    servers: [{ id: S, owner: 'owner-id', is_local_server: true, federation_enabled: true }],
    channels: [{ id: V, server_id: S, type: 1 }, { id: W, server_id: S, type: 1 }],
    user_servers: [
      { server_id: S, user_id: EVE, status: 'accepted' },
      { server_id: S, user_id: MOD, status: 'accepted' },
      { server_id: S, user_id: 'bob-id', status: 'accepted' },
    ],
    server_bans: [],
    server_member_timeouts: [],
    server_voice_moderation: [],
    voice_move_grants: [],
    blocked_instances: [],
  }
  grant(EVE, 'VIEW_CHANNEL', 'CONNECT', 'SPEAK', 'STREAM', 'USE_SOUNDBOARD')
  grant('bob-id', 'VIEW_CHANNEL', 'CONNECT', 'SPEAK', 'STREAM')
})

describe('liveKitGrant', () => {
  it('lists the microphone for SPEAK and camera, screen and screen audio for STREAM', () => {
    expect(liveKitGrant({ roomName: 'r', roomType: 'voice_channel' }, ALL)).toEqual({
      roomJoin: true, room: 'r', canPublish: true, canSubscribe: true, canPublishData: true,
      canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
    })
    expect(liveKitGrant({ roomName: 'r', roomType: 'voice_channel' }, { ...ALL, canStream: false }).canPublishSources)
      .toEqual([TrackSource.MICROPHONE])
    expect(liveKitGrant({ roomName: 'r', roomType: 'voice_channel' }, { ...ALL, canSpeak: false }).canPublishSources)
      .toEqual([TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO])
  })

  it('publishes nothing, with no source list, when no source is allowed', () => {
    const g = liveKitGrant({ roomName: 'r', roomType: 'voice_channel' }, { ...ALL, canSpeak: false, canStream: false })
    expect(g.canPublish).toBe(false)
    expect(g).not.toHaveProperty('canPublishSources')
  })

  it('subscribes to nothing when deafened, and a request cannot widen the grant', () => {
    expect(liveKitGrant({ roomName: 'r', roomType: 'voice_channel', canSubscribe: true }, { ...ALL, canHear: false }).canSubscribe).toBe(false)
    expect(liveKitGrant({ roomName: 'r', roomType: 'stage' }, ALL).canPublish).toBe(false)
  })
})

describe('participantPermission', () => {
  it('keeps a stage listener a listener and withholds a muted speaker\'s microphone', () => {
    const muted = { ...ALL, canSpeak: false, serverMuted: true }
    expect(participantPermission(muted, true, { canPublish: false }).canPublish).toBe(false)
    expect(participantPermission(muted, true, { canPublish: true, canPublishSources: [] }).canPublishSources)
      .toEqual([TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO])
    expect(participantPermission(ALL, false)).toMatchObject({ canPublish: true, canSubscribe: true, canPublishData: true })
  })

  it('merges the flags into existing metadata', () => {
    expect(JSON.parse(mergeVoiceMetadata('{"profileId":"p","soundboard":true}', { ...ALL, canSoundboard: false, serverMuted: true })))
      .toEqual({ profileId: 'p', soundboard: false, soundboardExternal: true, serverMuted: true, serverDeafened: false })
    expect(JSON.parse(mergeVoiceMetadata('not json', ALL))).toMatchObject({ serverMuted: false })
  })
})

describe('tokens', () => {
  const tableAuth = (authUserId: string) => tables.profiles.find((p) => p.auth_user_id === authUserId)!
  const token = async (roomName = `channel-${V}`) => {
    const { token: jwt } = await livekitService.generateToken({ userId: tableAuth('eve-auth').auth_user_id, roomName, roomType: 'voice_channel' })
    return jwtPayload(jwt)
  }

  it('grants no camera or screen share without STREAM', async () => {
    grant(EVE, 'VIEW_CHANNEL', 'CONNECT', 'SPEAK')
    expect((await token()).video.canPublishSources).toEqual(['microphone'])
  })

  it('withholds the microphone and the soundboard from a server-muted member', async () => {
    tables.server_voice_moderation.push({ server_id: S, user_id: EVE, muted: true, deafened: false })
    const payload = await token()
    expect(payload.video).toMatchObject({ canPublish: true, canSubscribe: true, canPublishSources: ['camera', 'screen_share', 'screen_share_audio'] })
    expect(JSON.parse(payload.metadata)).toMatchObject({ serverMuted: true, serverDeafened: false, soundboard: false })
  })

  it('a server-deafened member neither speaks nor hears', async () => {
    tables.server_voice_moderation.push({ server_id: S, user_id: EVE, muted: false, deafened: true })
    const payload = await token()
    expect(payload.video.canSubscribe).toBe(false)
    expect(payload.video.canPublishSources).not.toContain('microphone')
    expect(JSON.parse(payload.metadata)).toMatchObject({ serverDeafened: true })
  })

  it('a live move grant stands in for CONNECT; an expired one or one for another channel does not', async () => {
    grant(EVE, 'VIEW_CHANNEL', 'SPEAK')
    await expect(token()).rejects.toThrow(/permission denied/)
    tables.voice_move_grants.push({ server_id: S, user_id: EVE, channel_id: W, expires_at: LATER })
    await expect(token()).rejects.toThrow(/permission denied/)
    tables.voice_move_grants[0].channel_id = V
    await expect(token()).resolves.toMatchObject({ video: { room: `channel-${V}` } })
    tables.voice_move_grants[0].expires_at = EARLIER
    await expect(token()).rejects.toThrow(/permission denied/)
  })

  it('a remote member\'s token follows the same moderation', async () => {
    tables.server_voice_moderation.push({ server_id: S, user_id: 'bob-id', muted: true, deafened: true })
    const jwt = await livekitService.generateFederatedToken({ actorId: BOB_ACTOR, roomName: `channel-${V}`, roomType: 'voice_channel' })
    const payload = jwtPayload(jwt)
    expect(payload.video).toMatchObject({ canSubscribe: false, canPublishSources: ['camera', 'screen_share', 'screen_share_audio'] })
    expect(JSON.parse(payload.metadata)).toMatchObject({ serverMuted: true, serverDeafened: true })
  })
})

function seat(roomName: string, participants: Row[]) {
  room.listRooms.mockImplementation(async (names?: string[]) =>
    (!names || names.includes(roomName)) ? [{ name: roomName, numParticipants: participants.length }] : [])
  room.listParticipants.mockImplementation(async (name: string) => (name === roomName ? participants : []))
}

describe('syncVoiceMember', () => {
  it('applies a server mute to the connected participant at once', async () => {
    seat(`channel-${V}`, [{ identity: 'federated:https://harmony.test/users/eve', metadata: JSON.stringify({ profileId: EVE, soundboard: true }) }])
    tables.server_voice_moderation.push({ server_id: S, user_id: EVE, muted: true, deafened: false })
    expect(await syncVoiceMember(deps(), S, EVE)).toEqual({ updated: 1, removed: 0 })
    const [roomName, identity, options] = room.updateParticipant.mock.calls[0] as any[]
    expect(roomName).toBe(`channel-${V}`)
    expect(identity).toBe('federated:https://harmony.test/users/eve')
    expect(options.permission).toMatchObject({ canPublish: true, canSubscribe: true })
    expect(options.permission.canPublishSources).not.toContain(TrackSource.MICROPHONE)
    expect(JSON.parse(options.metadata)).toMatchObject({ profileId: EVE, serverMuted: true, soundboard: false })
  })

  it('removes a participant who is no longer admitted: kicked', async () => {
    seat(`channel-${V}`, [{ identity: 'eve-identity', metadata: JSON.stringify({ profileId: EVE }) }])
    tables.user_servers = tables.user_servers.filter((m) => m.user_id !== EVE)
    expect(await syncVoiceMember(deps(), S, EVE)).toEqual({ updated: 0, removed: 1 })
    expect(room.removeParticipant).toHaveBeenCalledWith(`channel-${V}`, 'eve-identity')
    expect(room.updateParticipant).not.toHaveBeenCalled()
  })

  it('finds a remote member by its federated identity', async () => {
    seat(`channel-${V}`, [{ identity: `federated:${BOB_ACTOR}`, metadata: JSON.stringify({ federated: true }) }])
    tables.server_voice_moderation.push({ server_id: S, user_id: 'bob-id', muted: false, deafened: true })
    expect(await syncVoiceMember(deps(), S, 'bob-id')).toEqual({ updated: 1, removed: 0 })
    expect((room.updateParticipant.mock.calls[0] as any[])[2].permission.canSubscribe).toBe(false)
  })

  it('leaves other participants alone', async () => {
    seat(`channel-${V}`, [{ identity: 'someone-else', metadata: JSON.stringify({ profileId: MOD }) }])
    expect(await syncVoiceMember(deps(), S, EVE)).toEqual({ updated: 0, removed: 0 })
  })
})

describe('enforceVoiceRooms', () => {
  it('removes a banned or timed-out participant and syncs one whose flags are stale', async () => {
    tables.profiles.push({ id: 'zed-id', username: 'zed', is_local: true })
    tables.user_servers.push({ server_id: S, user_id: 'zed-id', status: 'accepted' })
    tables.server_bans.push({ server_id: S, user_id: 'zed-id' })
    tables.server_member_timeouts.push({ server_id: S, user_id: MOD, until: LATER })
    tables.server_voice_moderation.push({ server_id: S, user_id: 'bob-id', muted: true, deafened: false })
    seat(`channel-${V}`, [
      { identity: 'eve', metadata: JSON.stringify({ profileId: EVE, serverMuted: false }) },
      { identity: 'zed', metadata: JSON.stringify({ profileId: 'zed-id' }) },
      { identity: 'mod', metadata: JSON.stringify({ profileId: MOD }) },
      { identity: `federated:${BOB_ACTOR}`, metadata: JSON.stringify({ federated: true, serverMuted: false }) },
    ])
    expect(await enforceVoiceRooms(deps())).toEqual({ checked: 4, updated: 1, removed: 2 })
    expect(room.removeParticipant.mock.calls.map((c: any[]) => c[1]).sort()).toEqual(['mod', 'zed'])
    expect((room.updateParticipant.mock.calls[0] as any[])[1]).toBe(`federated:${BOB_ACTOR}`)
  })

  it('touches nothing when the flags agree', async () => {
    seat(`channel-${V}`, [{ identity: 'eve', metadata: JSON.stringify({ profileId: EVE }) }])
    expect(await enforceVoiceRooms(deps())).toEqual({ checked: 1, updated: 0, removed: 0 })
  })
})

describe('routes', () => {
  const app = express()
  app.use(express.json())
  app.use('/api/federation/voice', voiceRouter)
  const post = (path: string, body: any, as = 'mod-auth') =>
    supertest(app).post(`/api/federation/voice/${path}`).set('Authorization', `Bearer ${as}`).send(body)

  afterEach(() => { vi.useRealTimers() })

  it('/moderation runs the RPC as the caller, then updates LiveKit', async () => {
    seat(`channel-${V}`, [{ identity: 'eve', metadata: JSON.stringify({ profileId: EVE }) }])
    rpcAnswer = { data: { muted: true, deafened: false }, error: null }
    tables.server_voice_moderation.push({ server_id: S, user_id: EVE, muted: true, deafened: false })
    const res = await post('moderation', { serverId: S, userId: EVE, mute: true })
    expect(res.status).toBe(200)
    expect(rpcCalls).toEqual([{ fn: 'set_server_voice_state', as: 'mod-auth', args: { p_server_id: S, p_user_id: EVE, p_mute: true, p_deafen: null } }])
    expect(res.body.livekit).toEqual({ updated: 1, removed: 0 })
  })

  it('/moderation passes a refusal on and leaves LiveKit untouched', async () => {
    rpcAnswer = { data: null, error: { code: '42501', message: 'Missing permission: MUTE_MEMBERS' } }
    const res = await post('moderation', { serverId: S, userId: EVE, mute: true })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Missing permission: MUTE_MEMBERS')
    expect(room.listRooms).not.toHaveBeenCalled()
  })

  it('/moderation needs a flag and a token', async () => {
    expect((await post('moderation', { serverId: S, userId: EVE })).status).toBe(400)
    expect((await supertest(app).post('/api/federation/voice/moderation').send({ serverId: S, userId: EVE, mute: true })).status).toBe(401)
    expect(rpcCalls).toEqual([])
  })

  it('/move with no channel disconnects at once', async () => {
    seat(`channel-${V}`, [{ identity: 'eve', metadata: JSON.stringify({ profileId: EVE }) }])
    rpcAnswer = { data: { from_channel_id: V, channel_id: null }, error: null }
    const res = await post('move', { serverId: S, userId: EVE, channelId: null })
    expect(res.status).toBe(200)
    expect(rpcCalls[0]).toMatchObject({ fn: 'move_voice_member', args: { p_channel_id: null } })
    expect(room.removeParticipant).toHaveBeenCalledWith(`channel-${V}`, 'eve')
  })

  it('/move to a channel leaves the client time to switch, then removes it from the old room', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    seat(`channel-${V}`, [{ identity: 'eve', metadata: JSON.stringify({ profileId: EVE }) }])
    rpcAnswer = { data: { from_channel_id: V, channel_id: W }, error: null }
    expect((await post('move', { serverId: S, userId: EVE, channelId: W })).status).toBe(200)
    expect(room.removeParticipant).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(MOVE_GRACE_MS)
    expect(room.removeParticipant).toHaveBeenCalledWith(`channel-${V}`, 'eve')
  })

  it('/move maps a missing member to 404', async () => {
    rpcAnswer = { data: null, error: { code: 'P0002', message: 'Member is not in a voice channel of this server' } }
    expect((await post('move', { serverId: S, userId: EVE, channelId: W })).status).toBe(404)
    expect(room.removeParticipant).not.toHaveBeenCalled()
  })

  it('/sync is open to members only and applies the database\'s decision', async () => {
    seat(`channel-${V}`, [{ identity: 'eve', metadata: JSON.stringify({ profileId: EVE }) }])
    tables.user_servers = tables.user_servers.filter((m) => m.user_id !== EVE)
    tables.profiles.push({ id: 'out-id', auth_user_id: 'out-auth', username: 'out', is_local: true })
    expect((await post('sync', { serverId: S, userId: EVE }, 'out-auth')).status).toBe(403)
    expect(room.removeParticipant).not.toHaveBeenCalled()
    const res = await post('sync', { serverId: S, userId: EVE })
    expect(res.status).toBe(200)
    expect(res.body.livekit).toEqual({ updated: 0, removed: 1 })
  })
})
