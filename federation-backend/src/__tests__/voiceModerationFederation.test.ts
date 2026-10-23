import { describe, it, expect, vi, beforeEach } from 'vitest'

// Voice moderation of a remote member crosses instances (voiceModerationFederation.ts):
//   - host: a federate-voice-moderation job becomes harmony:VoiceMemberMove, -Disconnect or
//     -State from the server's Group, delivered to the member instance's copy inbox signed as
//     the Group; a move or disconnect once, retried by the job, a state through the queue;
//   - receiver: only the Group of a copied server, for an accepted local member of the copy,
//     naming the copy's voice channels; the member's client hears it as voice:moved, the state
//     is stored through apply_group_voice_state.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'member.test', NODE_ENV: 'test', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const delivery = {
  enqueue: vi.fn(async () => undefined),
  deliverOnce: vi.fn(async () => ({ delivered: true, retry: false })),
}
vi.mock('../activitypub/DeliveryQueue.js', () => ({ DeliveryQueue: delivery }))
let software: string | null = 'harmony'
vi.mock('../activitypub/instanceSoftware.js', () => ({ instanceSoftware: async () => software }))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let rpcCalls: Array<{ fn: string; args: any }> = []

function fakeSupabase() {
  return {
    rpc: (fn: string, args: any) => {
      rpcCalls.push({ fn, args })
      return Promise.resolve({ data: true, error: null })
    },
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      const run = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
      const builder: any = {
        select() { return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }) },
      }
      return builder
    },
  }
}
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => fakeSupabase() }))

const {
  voiceMemberActivity,
  memberCopyInbox,
  handleVoiceModerationFederationJob,
  processVoiceMemberActivity,
  copyOfGroup,
  VOICE_MEMBER_TYPES,
} = await import('../activitypub/voiceModerationFederation.js')

const S = '11111111-1111-4111-8111-111111111111'
const FROM = '22222222-2222-4222-8222-222222222222'
const TO = '33333333-3333-4333-8333-333333333333'
const TEXT = '44444444-4444-4444-8444-444444444444'
const RITA = 'aaaaaaaa-0000-4000-8000-000000000001'
const RITA_ACTOR = 'https://other.test/users/rita'
const GROUP = `https://member.test/servers/${S}`

// Receiver side: the Group of host.test's server, copied here.
const HOST_GROUP = `https://host.test/servers/${S}`
const COPY = { id: S, ap_id: HOST_GROUP, is_local_server: false }
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002'
const BOB_ACTOR = 'https://member.test/users/bob'
const CAROL = 'cccccccc-0000-4000-8000-000000000003'

beforeEach(() => {
  rpcCalls = []
  software = 'harmony'
  delivery.enqueue.mockClear()
  delivery.deliverOnce.mockClear()
  delivery.deliverOnce.mockResolvedValue({ delivered: true, retry: false })
  tables = {
    servers: [
      { id: S, is_local_server: true, federation_enabled: true },
    ],
    profiles: [
      { id: RITA, is_local: false, federated_id: RITA_ACTOR, inbox_url: `${RITA_ACTOR}/inbox`, shared_inbox_url: 'https://other.test/inbox' },
      { id: BOB, username: 'bob', is_local: true, federated_id: BOB_ACTOR },
      { id: CAROL, username: 'carol', is_local: true, federated_id: 'https://member.test/users/carol' },
      { id: 'remote-x', is_local: false, federated_id: 'https://member.test/users/impostor' },
    ],
    user_servers: [
      { server_id: S, user_id: BOB, status: 'accepted' },
      { server_id: S, user_id: 'remote-x', status: 'accepted' },
    ],
    channels: [
      { id: FROM, server_id: S, type: 1, ap_id: `${HOST_GROUP}/channels/${FROM}` },
      { id: TO, server_id: S, type: 1, ap_id: `${HOST_GROUP}/channels/${TO}` },
      { id: TEXT, server_id: S, type: 0, ap_id: `${HOST_GROUP}/channels/${TEXT}` },
    ],
  }
})

describe('voiceMemberActivity', () => {
  it('a move names the Group, the member, the channel left and the channel to join', () => {
    const a = voiceMemberActivity({ kind: 'move', server_id: S, user_id: RITA, from_channel_id: FROM, channel_id: TO, reason: 'moved' }, RITA_ACTOR)
    expect(a).toMatchObject({
      type: VOICE_MEMBER_TYPES.Move, actor: GROUP, object: RITA_ACTOR, to: [RITA_ACTOR],
      origin: `${GROUP}/channels/${FROM}`, target: `${GROUP}/channels/${TO}`,
    })
    expect(String(a.id).startsWith(`${GROUP}/voice-moderation/`)).toBe(true)
  })

  it('binds the harmony prefix inline: the only context URL is ActivityStreams', () => {
    const a = voiceMemberActivity({ kind: 'state', server_id: S, user_id: RITA, muted: true, deafened: false }, RITA_ACTOR)
    expect(a['@context']).toEqual(['https://www.w3.org/ns/activitystreams', { harmony: 'https://mony.lol/ns#' }])
  })

  it('a disconnect carries its reason; an unknown one reads as disconnected', () => {
    const revoked = voiceMemberActivity({ kind: 'disconnect', server_id: S, user_id: RITA, from_channel_id: FROM, reason: 'revoked' }, RITA_ACTOR)
    expect(revoked).toMatchObject({ type: VOICE_MEMBER_TYPES.Disconnect, 'harmony:reason': 'revoked' })
    expect(revoked).not.toHaveProperty('target')
    expect(voiceMemberActivity({ kind: 'disconnect', server_id: S, user_id: RITA, reason: 'whatever' }, RITA_ACTOR))
      .toMatchObject({ 'harmony:reason': 'disconnected' })
  })

  it('a state carries the server mute and deafen', () => {
    expect(voiceMemberActivity({ kind: 'state', server_id: S, user_id: RITA, muted: true, deafened: false }, RITA_ACTOR))
      .toMatchObject({ type: VOICE_MEMBER_TYPES.State, 'harmony:serverMuted': true, 'harmony:serverDeafened': false })
  })
})

describe('memberCopyInbox', () => {
  it('is the copy inbox on the origin of the member\'s inboxes, never another host', () => {
    expect(memberCopyInbox({ federated_id: RITA_ACTOR, shared_inbox_url: 'https://other.test/inbox' }, S))
      .toBe(`https://other.test/servers/${S}/inbox`)
    expect(memberCopyInbox({ federated_id: RITA_ACTOR, shared_inbox_url: 'https://evil.test/inbox', inbox_url: null }, S))
      .toBe(`https://other.test/servers/${S}/inbox`)
  })
})

describe('handleVoiceModerationFederationJob', () => {
  const inbox = `https://other.test/servers/${S}/inbox`

  it('delivers a move once, signed as the Group', async () => {
    await handleVoiceModerationFederationJob({ kind: 'move', server_id: S, user_id: RITA, from_channel_id: FROM, channel_id: TO })
    expect(delivery.deliverOnce).toHaveBeenCalledTimes(1)
    const [activity, url, signer] = delivery.deliverOnce.mock.calls[0] as any[]
    expect(activity.type).toBe(VOICE_MEMBER_TYPES.Move)
    expect(url).toBe(inbox)
    expect(signer).toEqual({ serverId: S })
  })

  it('a move refused for now throws, for the job to retry', async () => {
    delivery.deliverOnce.mockResolvedValue({ delivered: false, retry: true })
    await expect(handleVoiceModerationFederationJob({ kind: 'disconnect', server_id: S, user_id: RITA, from_channel_id: FROM, reason: 'disconnected' }))
      .rejects.toThrow(/not delivered/)
  })

  it('queues a state change for retry', async () => {
    await handleVoiceModerationFederationJob({ kind: 'state', server_id: S, user_id: RITA, muted: true, deafened: true })
    expect(delivery.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: VOICE_MEMBER_TYPES.State }), inbox, { serverId: S })
    expect(delivery.deliverOnce).not.toHaveBeenCalled()
  })

  it('sends nothing for a local member, a server that does not federate, or an instance not running Harmony', async () => {
    await handleVoiceModerationFederationJob({ kind: 'state', server_id: S, user_id: BOB, muted: true })
    tables.servers[0].federation_enabled = false
    await handleVoiceModerationFederationJob({ kind: 'state', server_id: S, user_id: RITA, muted: true })
    tables.servers[0].federation_enabled = true
    software = 'mastodon'
    await handleVoiceModerationFederationJob({ kind: 'state', server_id: S, user_id: RITA, muted: true })
    expect(delivery.enqueue).not.toHaveBeenCalled()
  })
})

describe('processVoiceMemberActivity', () => {
  const activity = (extra: Record<string, unknown>) => ({
    id: `${HOST_GROUP}/voice-moderation/1`, actor: HOST_GROUP, object: BOB_ACTOR, to: [BOB_ACTOR], ...extra,
  })
  const events = () => rpcCalls.filter((c) => c.fn === 'broadcast_user_event')

  it('tells the member\'s client to switch to the copy\'s channel', async () => {
    expect(await processVoiceMemberActivity(COPY, activity({
      type: VOICE_MEMBER_TYPES.Move, origin: `${HOST_GROUP}/channels/${FROM}`, target: `${HOST_GROUP}/channels/${TO}`,
    }))).toBeNull()
    expect(events()).toEqual([{ fn: 'broadcast_user_event', args: { p_user_id: BOB, p_payload: {
      type: 'voice:moved', server_id: S, from_channel_id: FROM, channel_id: TO, reason: 'moved',
    } } }])
  })

  it('a disconnect leaves voice with its reason', async () => {
    expect(await processVoiceMemberActivity(COPY, activity({
      type: VOICE_MEMBER_TYPES.Disconnect, origin: `${HOST_GROUP}/channels/${FROM}`, 'harmony:reason': 'timed_out',
    }))).toBeNull()
    expect(events()[0].args.p_payload).toEqual({ type: 'voice:moved', server_id: S, from_channel_id: FROM, channel_id: null, reason: 'timed_out' })
  })

  it('a state is stored in the copy', async () => {
    expect(await processVoiceMemberActivity(COPY, activity({
      type: VOICE_MEMBER_TYPES.State, 'harmony:serverMuted': true, 'harmony:serverDeafened': false,
    }))).toBeNull()
    expect(rpcCalls).toEqual([{ fn: 'apply_group_voice_state', args: { p_server_id: S, p_user_id: BOB, p_muted: true, p_deafened: false } }])
  })

  it('refuses another actor, a local server, a member elsewhere, a non-member, a remote profile, another Group\'s channels', async () => {
    const move = { type: VOICE_MEMBER_TYPES.Move, target: `${HOST_GROUP}/channels/${TO}` }
    expect(await processVoiceMemberActivity(COPY, activity({ ...move, actor: 'https://host.test/users/mallory' }))).toMatch(/not the Group/)
    expect(await processVoiceMemberActivity({ ...COPY, is_local_server: true }, activity(move))).toMatch(/not a remote server/)
    expect(await processVoiceMemberActivity(COPY, activity({ ...move, object: RITA_ACTOR }))).toMatch(/not on this instance/)
    expect(await processVoiceMemberActivity(COPY, activity({ ...move, object: 'https://member.test/users/carol' }))).toMatch(/not a member/)
    expect(await processVoiceMemberActivity(COPY, activity({ ...move, object: 'https://member.test/users/impostor' }))).toMatch(/no local profile/)
    expect(await processVoiceMemberActivity(COPY, activity({ ...move, target: `https://host.test/servers/other/channels/${TO}` })))
      .toMatch(/no voice channel/)
    expect(await processVoiceMemberActivity(COPY, activity({ ...move, target: `${HOST_GROUP}/channels/${TEXT}` }))).toMatch(/no voice channel/)
    expect(await processVoiceMemberActivity(COPY, activity({ ...move, origin: `${HOST_GROUP}/channels/nope` }))).toMatch(/origin/)
    expect(rpcCalls).toEqual([])
  })

  it('copyOfGroup finds a copy only by its Group, exactly', async () => {
    tables.servers.push({ id: 'copy', ap_id: HOST_GROUP, is_local_server: false })
    expect((await copyOfGroup(HOST_GROUP))?.id).toBe('copy')
    expect(await copyOfGroup(`${HOST_GROUP}/`)).toBeNull()
    expect(await copyOfGroup(GROUP)).toBeNull()
  })
})
