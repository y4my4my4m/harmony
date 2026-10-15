import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TrackSource } from 'livekit-server-sdk'

// Connected participants follow permission changes (20261017100005_voice_moderation_followups.sql,
// voiceGrantSync.ts): the pending voice_grant_resyncs rows of a server give the scope,
// voice_participant_grants decides in batches, LiveKit is told only of what changed, a refused
// participant leaves LiveKit and its presence row, and the rows are deleted once applied.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let decisions: Map<string, Row> = new Map()
let rpcCalls: Array<{ fn: string; args: any }> = []
let rpcError: { message: string } | null = null

function fakeSupabase() {
  return {
    rpc: (fn: string, args: any) => {
      rpcCalls.push({ fn, args })
      if (rpcError) return Promise.resolve({ data: null, error: rpcError })
      if (fn === 'voice_participant_grants') {
        const data = (args.p_channels as string[]).map((c: string, i: number) => decisions.get(`${c} ${args.p_users[i]}`))
          .filter(Boolean)
        return Promise.resolve({ data, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let remove = false
      let limit = Infinity
      const run = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row))).slice(0, limit)
      const builder: any = {
        select() { return builder },
        delete() { remove = true; return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        lt(col: string, val: any) { filters.push((row) => row[col] < val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder },
        order() { return builder },
        limit(n: number) { limit = n; return builder },
        then(resolve: any) {
          if (remove) {
            const gone = new Set(run())
            tables[table] = (tables[table] ?? []).filter((row) => !gone.has(row))
            return resolve({ data: null, error: null })
          }
          return resolve({ data: run(), error: null })
        },
      }
      return builder
    },
  }
}

const room = {
  listRooms: vi.fn(),
  listParticipants: vi.fn(),
  updateParticipant: vi.fn(async () => ({})),
  removeParticipant: vi.fn(async () => undefined),
}

const { syncVoiceGrants, syncStaleVoiceGrants, participantAgrees, grantsOf, GRANT_BATCH } = await import('../services/voiceGrantSync.js')
const { participantPermission, mergeVoiceMetadata } = await import('../services/voiceGrants.js')

const S = '11111111-1111-4111-8111-111111111111'
const OTHER = '99999999-9999-4999-8999-999999999999'
const V = '22222222-2222-4222-8222-222222222222'
const W = '33333333-3333-4333-8333-333333333333'
const EVE = 'eeeeeeee-0000-4000-8000-000000000001'
const MOD = 'dddddddd-0000-4000-8000-000000000002'
const BOB = 'bbbbbbbb-0000-4000-8000-000000000003'
const BOB_ACTOR = 'https://remote.test/users/bob'
const OLD = '2000-01-01T00:00:00.000Z'

const deps = (live = true) => ({ supabase: fakeSupabase() as any, roomService: live ? room as any : null })

const OPEN: Row = {
  reason: null, can_speak: true, can_stream: true, can_soundboard: true, can_external_sounds: false,
  server_muted: false, server_deafened: false,
}
const decide = (channel: string, user: string, row: Row = OPEN) => decisions.set(`${channel} ${user}`, { channel_id: channel, user_id: user, ...OPEN, ...row })

/** A participant whose permission and metadata already follow `row`. */
function settled(identity: string, profileId: string | null, row: Row = OPEN) {
  const grants = grantsOf({ channel_id: V, user_id: profileId ?? '', ...OPEN, ...row } as any)
  return {
    identity,
    metadata: mergeVoiceMetadata(JSON.stringify(profileId ? { profileId } : { federated: true }), grants),
    permission: participantPermission(grants, false),
  }
}

function seat(rooms: Record<string, Row[]>) {
  room.listRooms.mockImplementation(async (names?: string[]) => Object.keys(rooms)
    .filter((name) => !names || names.includes(name))
    .map((name) => ({ name, numParticipants: rooms[name].length })))
  room.listParticipants.mockImplementation(async (name: string) => rooms[name] ?? [])
}

beforeEach(() => {
  decisions = new Map()
  rpcCalls = []
  rpcError = null
  for (const fn of Object.values(room)) fn.mockClear()
  seat({})
  tables = {
    channels: [{ id: V, server_id: S, type: 1 }, { id: W, server_id: S, type: 1 }],
    profiles: [{ id: BOB, federated_id: BOB_ACTOR }],
    voice_channel_participants: [],
    voice_grant_resyncs: [],
  }
})

describe('participantAgrees', () => {
  it('is true only when permission and metadata flags already match', () => {
    const p = settled('eve', EVE)
    expect(participantAgrees(p as any, grantsOf({ ...OPEN } as any), false)).toBe(true)
    expect(participantAgrees(p as any, grantsOf({ ...OPEN, can_speak: false } as any), false)).toBe(false)
    expect(participantAgrees(p as any, grantsOf({ ...OPEN, can_soundboard: false } as any), false)).toBe(false)
    expect(participantAgrees({ ...p, metadata: 'not json' } as any, grantsOf({ ...OPEN } as any), false)).toBe(false)
  })
})

describe('syncVoiceGrants', () => {
  it('does nothing without pending rows', async () => {
    expect(await syncVoiceGrants(deps(), S)).toEqual({ checked: 0, updated: 0, removed: 0 })
    expect(rpcCalls).toEqual([])
    expect(room.listRooms).not.toHaveBeenCalled()
  })

  it('a server-wide change updates who lost SPEAK, removes who lost CONNECT, and leaves the rest alone', async () => {
    tables.voice_grant_resyncs.push({ id: 1, server_id: S, channel_id: null, user_id: null, queued_at: OLD })
    seat({
      [`channel-${V}`]: [settled('eve', EVE), settled('mod', MOD), settled(`federated:${BOB_ACTOR}`, null)],
    })
    decide(V, EVE, { can_speak: false, can_soundboard: false })
    decide(V, MOD)
    decide(V, BOB, { reason: 'missing CONNECT', can_speak: false, can_stream: false, can_soundboard: false })

    expect(await syncVoiceGrants(deps(), S)).toEqual({ checked: 3, updated: 1, removed: 1 })
    const [roomName, identity, update] = room.updateParticipant.mock.calls[0] as any[]
    expect([roomName, identity]).toEqual([`channel-${V}`, 'eve'])
    expect(update.permission.canPublishSources).toEqual([TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO])
    expect(JSON.parse(update.metadata)).toMatchObject({ profileId: EVE, soundboard: false })
    expect(room.removeParticipant).toHaveBeenCalledWith(`channel-${V}`, `federated:${BOB_ACTOR}`)
    expect(tables.voice_grant_resyncs).toEqual([])
  })

  it('a refused presence row leaves through voice_remove_member, once per member', async () => {
    tables.voice_grant_resyncs.push({ id: 1, server_id: S, channel_id: V, user_id: null, queued_at: OLD })
    tables.voice_channel_participants.push(
      { server_id: S, channel_id: V, user_id: EVE },
      { server_id: S, channel_id: V, user_id: MOD },
      { server_id: S, channel_id: W, user_id: BOB },
    )
    decide(V, EVE, { reason: 'missing VIEW_CHANNEL' })
    decide(V, MOD)
    expect(await syncVoiceGrants(deps(false), S)).toEqual({ checked: 2, updated: 0, removed: 1 })
    expect(rpcCalls.filter((c) => c.fn === 'voice_remove_member'))
      .toEqual([{ fn: 'voice_remove_member', args: { p_server_id: S, p_user_id: EVE, p_reason: 'revoked' } }])
    const asked = rpcCalls.find((c) => c.fn === 'voice_participant_grants')!.args
    expect(asked.p_users.sort()).toEqual([EVE, MOD].sort())
  })

  it('a member-scoped change reads that member alone', async () => {
    tables.voice_grant_resyncs.push({ id: 7, server_id: S, channel_id: null, user_id: MOD, queued_at: OLD })
    seat({ [`channel-${V}`]: [settled('eve', EVE), settled('mod', MOD)] })
    decide(V, EVE, { can_speak: false })
    decide(V, MOD, { can_stream: false })
    expect(await syncVoiceGrants(deps(), S)).toEqual({ checked: 1, updated: 1, removed: 0 })
    expect((room.updateParticipant.mock.calls[0] as any[])[1]).toBe('mod')
  })

  it('a channel-scoped change lists only that channel\'s rooms', async () => {
    tables.voice_grant_resyncs.push({ id: 2, server_id: S, channel_id: W, user_id: null, queued_at: OLD })
    seat({ [`channel-${V}`]: [settled('eve', EVE)], [`channel-${W}`]: [settled('mod', MOD)] })
    decide(W, MOD, { can_speak: false })
    expect(await syncVoiceGrants(deps(), S)).toEqual({ checked: 1, updated: 1, removed: 0 })
    expect(room.listRooms).toHaveBeenCalledWith([`channel-${W}`, `stage-${W}`])
  })

  it('reads grants in batches', async () => {
    tables.voice_grant_resyncs.push({ id: 1, server_id: S, channel_id: null, user_id: null, queued_at: OLD })
    const n = GRANT_BATCH + 3
    for (let i = 0; i < n; i++) {
      const user = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      tables.voice_channel_participants.push({ server_id: S, channel_id: V, user_id: user })
      decide(V, user)
    }
    expect((await syncVoiceGrants(deps(false), S)).checked).toBe(n)
    expect(rpcCalls.filter((c) => c.fn === 'voice_participant_grants').map((c) => c.args.p_users.length)).toEqual([GRANT_BATCH, 3])
  })

  it('keeps the rows when the decision cannot be read', async () => {
    tables.voice_grant_resyncs.push({ id: 1, server_id: S, channel_id: null, user_id: null, queued_at: OLD })
    tables.voice_channel_participants.push({ server_id: S, channel_id: V, user_id: EVE })
    rpcError = { message: 'boom' }
    await expect(syncVoiceGrants(deps(false), S)).rejects.toThrow(/boom/)
    expect(tables.voice_grant_resyncs).toHaveLength(1)
  })

  it('deletes only the rows it read', async () => {
    tables.voice_grant_resyncs.push(
      { id: 1, server_id: S, channel_id: null, user_id: EVE, queued_at: OLD },
      { id: 2, server_id: OTHER, channel_id: null, user_id: null, queued_at: OLD },
    )
    await syncVoiceGrants(deps(false), S)
    expect(tables.voice_grant_resyncs.map((r) => r.id)).toEqual([2])
  })
})

describe('syncStaleVoiceGrants', () => {
  it('handles servers whose rows a notification never reached', async () => {
    tables.channels.push({ id: 'x', server_id: OTHER, type: 1 })
    tables.voice_grant_resyncs.push(
      { id: 1, server_id: S, channel_id: null, user_id: null, queued_at: OLD },
      { id: 2, server_id: OTHER, channel_id: null, user_id: null, queued_at: new Date(Date.now() + 60_000).toISOString() },
    )
    tables.voice_channel_participants.push({ server_id: S, channel_id: V, user_id: EVE })
    decide(V, EVE)
    expect(await syncStaleVoiceGrants(deps(false), 30_000)).toEqual({ checked: 1, updated: 0, removed: 0 })
    expect(tables.voice_grant_resyncs.map((r) => r.id)).toEqual([2])
  })
})
