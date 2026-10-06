import { describe, it, expect, vi, beforeEach } from 'vitest'

// reconcileVoiceParticipants: voice_channel_participants rows against a mocked
// RoomServiceClient. A row is removed (remove_voice_participant) only when its
// profile has no participant in the channel's room, the row is past the grace
// period, and LiveKit and the database were both read.

vi.mock('../config/index.js', () => ({ default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' } }))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => { throw new Error('unused') } }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { reconcileVoiceParticipants, JOIN_GRACE_MS } = await import('../services/voiceParticipantReconciler.js')

const DOMAIN = 'harmony.test'
const NOW = new Date('2026-10-06T12:00:00Z')
const CH1 = '11111111-1111-4111-8111-111111111111'
const CH2 = '22222222-2222-4222-8222-222222222222'
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002'
const CAROL = 'cccccccc-0000-4000-8000-000000000003' // remote actor
const CAROL_ACTOR = 'https://remote.example/users/carol'

type Row = Record<string, any>
let tables: Record<string, Row[]>
let rpcCalls: Array<{ name: string; args: Row }>
let readError: string | null

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      const builder: any = {
        select() { return builder },
        lt(col: string, val: string) { filters.push((row) => row[col] < val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder },
        then(resolve: any) {
          if (readError && table === 'voice_channel_participants') {
            return resolve({ data: null, error: { message: readError } })
          }
          return resolve({ data: (tables[table] ?? []).filter((row) => filters.every((f) => f(row))), error: null })
        },
      }
      return builder
    },
    async rpc(name: string, args: Row) {
      rpcCalls.push({ name, args })
      const rows = tables.voice_channel_participants
      const i = rows.findIndex((r) => r.channel_id === args.p_channel_id && r.user_id === args.p_user_id
        && r.joined_at < args.p_joined_before)
      if (i < 0) return { data: false, error: null }
      rows.splice(i, 1)
      return { data: true, error: null }
    },
  } as any
}

type Participant = { identity: string; metadata?: string }

function fakeRoomService(rooms: Record<string, Participant[]>, opts: { failList?: boolean; failParticipants?: boolean } = {}) {
  return {
    listRooms: vi.fn(async (names?: string[]) => {
      if (opts.failList) throw new Error('connect ECONNREFUSED')
      return Object.keys(rooms).filter((n) => !names || names.includes(n)).map((name) => ({ name }))
    }),
    listParticipants: vi.fn(async (room: string) => {
      if (opts.failParticipants) throw new Error('twirp error: unavailable')
      return rooms[room] ?? []
    }),
  } as any
}

const localIdentity = (username: string) => `federated:https://${DOMAIN}/users/${username}`

beforeEach(() => {
  readError = null
  rpcCalls = []
  tables = {
    profiles: [
      { id: ALICE, username: 'alice', federated_id: null },
      { id: BOB, username: 'bob', federated_id: null },
      { id: CAROL, username: 'carol', federated_id: CAROL_ACTOR },
    ],
    voice_channel_participants: [],
  }
})

function row(channel_id: string, user_id: string, ageMs: number, metadata: Row = {}) {
  tables.voice_channel_participants.push({ channel_id, user_id, joined_at: ago(ageMs), metadata })
}

const run = (roomService: any, extra: Row = {}) =>
  reconcileVoiceParticipants({ roomService, supabase: fakeSupabase(), instanceDomain: DOMAIN, now: NOW, ...extra })

const remaining = () => tables.voice_channel_participants.map((r) => `${r.channel_id}/${r.user_id}`)

describe('reconcileVoiceParticipants', () => {
  it('keeps a row whose profile is connected under its token identity', async () => {
    row(CH1, ALICE, 10 * 60_000)
    const result = await run(fakeRoomService({ [`channel-${CH1}`]: [{ identity: localIdentity('alice') }] }))
    expect(result).toEqual({ ok: true, checked: 1, removed: 0 })
    expect(rpcCalls).toEqual([])
  })

  it('keeps a row matched by the token metadata profileId after a rename', async () => {
    row(CH1, ALICE, 10 * 60_000)
    const participant = { identity: localIdentity('old-name'), metadata: JSON.stringify({ profileId: ALICE }) }
    const result = await run(fakeRoomService({ [`channel-${CH1}`]: [participant] }))
    expect(result).toEqual({ ok: true, checked: 1, removed: 0 })
  })

  it('keeps a row whose profile is in the stage room of the channel', async () => {
    row(CH1, ALICE, 10 * 60_000)
    const result = await run(fakeRoomService({ [`stage-${CH1}`]: [{ identity: localIdentity('alice') }] }))
    expect(result).toEqual({ ok: true, checked: 1, removed: 0 })
  })

  it('removes a row past the grace period whose profile is not in the room', async () => {
    row(CH1, ALICE, 10 * 60_000)
    row(CH1, BOB, 10 * 60_000)
    const result = await run(fakeRoomService({ [`channel-${CH1}`]: [{ identity: localIdentity('bob') }] }))
    expect(result).toEqual({ ok: true, checked: 2, removed: 1 })
    expect(rpcCalls).toEqual([{
      name: 'remove_voice_participant',
      args: { p_channel_id: CH1, p_user_id: ALICE, p_joined_before: ago(JOIN_GRACE_MS) },
    }])
    expect(remaining()).toEqual([`${CH1}/${BOB}`])
  })

  it('removes every row of a channel whose room does not exist', async () => {
    row(CH1, ALICE, 40 * 24 * 3600_000)
    row(CH2, BOB, 3 * 24 * 3600_000)
    const result = await run(fakeRoomService({}))
    expect(result).toEqual({ ok: true, checked: 2, removed: 2 })
    expect(remaining()).toEqual([])
  })

  it('leaves a row inside the grace period', async () => {
    row(CH1, ALICE, JOIN_GRACE_MS - 1000)
    const result = await run(fakeRoomService({}))
    expect(result).toEqual({ ok: true, checked: 0, removed: 0 })
    expect(remaining()).toEqual([`${CH1}/${ALICE}`])
  })

  it('removes nothing when LiveKit cannot list rooms', async () => {
    row(CH1, ALICE, 10 * 60_000)
    const result = await run(fakeRoomService({}, { failList: true }))
    expect(result.ok).toBe(false)
    expect(rpcCalls).toEqual([])
    expect(remaining()).toEqual([`${CH1}/${ALICE}`])
  })

  it('removes nothing when LiveKit cannot list a room\'s participants', async () => {
    row(CH1, ALICE, 10 * 60_000)
    row(CH2, BOB, 10 * 60_000)
    const result = await run(fakeRoomService({ [`channel-${CH1}`]: [] }, { failParticipants: true }))
    expect(result.ok).toBe(false)
    expect(rpcCalls).toEqual([])
  })

  it('removes nothing and skips LiveKit when the rows cannot be read', async () => {
    row(CH1, ALICE, 10 * 60_000)
    readError = 'connection refused'
    const roomService = fakeRoomService({})
    const result = await run(roomService)
    expect(result.ok).toBe(false)
    expect(roomService.listRooms).not.toHaveBeenCalled()
    expect(rpcCalls).toEqual([])
  })

  it('matches a remote participant by federated:<actor>', async () => {
    row(CH1, CAROL, 10 * 60_000, {})
    tables.voice_channel_participants[0].is_federated = true
    const present = await run(fakeRoomService({ [`channel-${CH1}`]: [{ identity: `federated:${CAROL_ACTOR}` }] }))
    expect(present).toEqual({ ok: true, checked: 1, removed: 0 })

    const absent = await run(fakeRoomService({ [`channel-${CH1}`]: [{ identity: localIdentity('carol') }] }))
    expect(absent).toEqual({ ok: true, checked: 1, removed: 1 })
  })

  it('skips a row on the P2P fallback', async () => {
    row(CH1, ALICE, 10 * 60_000, { transport: 'p2p' })
    const result = await run(fakeRoomService({}))
    expect(result).toEqual({ ok: true, checked: 0, removed: 0 })
    expect(remaining()).toEqual([`${CH1}/${ALICE}`])
  })

  it('limits the run to the given channels', async () => {
    row(CH1, ALICE, 10 * 60_000)
    row(CH2, BOB, 10 * 60_000)
    const result = await run(fakeRoomService({}), { channelIds: [CH2] })
    expect(result).toEqual({ ok: true, checked: 1, removed: 1 })
    expect(remaining()).toEqual([`${CH1}/${ALICE}`])
  })

  it('judges a departed participant against the departure time, others against the grace', async () => {
    row(CH1, ALICE, 30_000)
    row(CH1, BOB, 30_000)
    const departure = { identity: localIdentity('alice'), at: new Date(NOW.getTime() - 5_000) }
    const result = await run(fakeRoomService({ [`channel-${CH1}`]: [] }), { channelIds: [CH1], departure })
    expect(result).toEqual({ ok: true, checked: 2, removed: 1 })
    expect(rpcCalls[0].args).toEqual({ p_channel_id: CH1, p_user_id: ALICE, p_joined_before: departure.at.toISOString() })
    expect(remaining()).toEqual([`${CH1}/${BOB}`])
  })

  it('keeps a departed participant whose row was rewritten after the departure', async () => {
    row(CH1, ALICE, 1_000)
    const departure = { identity: localIdentity('alice'), at: new Date(NOW.getTime() - 5_000) }
    const result = await run(fakeRoomService({}), { channelIds: [CH1], departure })
    expect(result).toEqual({ ok: true, checked: 0, removed: 0 })
  })

  it('keeps a departed participant who is back in the room', async () => {
    row(CH1, ALICE, 30_000)
    const departure = { identity: localIdentity('alice'), at: new Date(NOW.getTime() - 5_000) }
    const result = await run(
      fakeRoomService({ [`channel-${CH1}`]: [{ identity: localIdentity('alice') }] }),
      { channelIds: [CH1], departure },
    )
    expect(result).toEqual({ ok: true, checked: 1, removed: 0 })
  })
})
