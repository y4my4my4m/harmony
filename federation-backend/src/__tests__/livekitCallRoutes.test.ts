import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// /api/livekit/federated-call/*: each route acts for the authenticated profile
// only. federated_voice_calls holds inbound calls (remote caller, local
// recipient) and outbound ones (local caller, remote recipient).

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
vi.mock('../activitypub/SignatureService.js', () => ({ SignatureService: {} }))
vi.mock('../activitypub/DeliveryQueue.js', () => ({ DeliveryQueue: { sendToInbox: vi.fn(), enqueue: vi.fn() } }))

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}

function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let op: 'select' | 'update' = 'select'
      let patch: Row = {}
      const run = () => {
        const matched = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
        if (op === 'update') matched.forEach((row) => Object.assign(row, patch))
        return matched
      }
      const builder: any = {
        select() { return builder },
        insert(row: Row) {
          ;(tables[table] ??= []).push({ id: `row-${(tables[table] ?? []).length + 1}`, ...row })
          return Promise.resolve({ data: null, error: null })
        },
        update(p: Row) { op = 'update'; patch = p; return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        gt(col: string, val: any) { filters.push((row) => row[col] > val); return builder },
        is(col: string, val: any) { filters.push((row) => (row[col] ?? null) === val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder },
        or(expr: string) {
          const clauses = expr.split(',').map((c) => c.split('.eq.'))
          filters.push((row) => clauses.some(([col, val]) => row[col] === val))
          return builder
        },
        order() { return builder },
        limit() { return builder },
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
    auth: { getUser: async () => ({ data: { user: { id: token } }, error: null }) },
  }),
}))

const { default: config } = await import('../config/index.js')
const { default: livekitRouter } = await import('../routes/livekit.js')
const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')
const { VoiceActivityHandler } = await import('../activitypub/VoiceActivityHandler.js')
const requestCallToken = vi.spyOn(VoiceActivityHandler, 'requestCallToken')

const app = express()
app.use(express.json())
app.use('/api/livekit', livekitRouter)
const as = (authUid: string) => (path: string, body: any) =>
  supertest(app).post(`/api/livekit${path}`).set('Authorization', `Bearer ${authUid}`).send(body)

const BOB = 'https://mastodon.test/users/bob'
const CONV = '88888888-8888-8888-8888-888888888888'
const LATER = '2999-01-01T00:00:00.000Z'
const call = () => tables.federated_voice_calls[0]

const ROOM = `federated-dm-${CONV}-1`
const TOKEN = { token: 'REMOTE-TOKEN', wsUrl: 'wss://livekit.mastodon.test', roomName: ROOM }

beforeEach(() => {
  vi.mocked(DeliveryQueue.sendToInbox).mockReset()
  requestCallToken.mockReset().mockResolvedValue(TOKEN)
  tables = {
    profiles: [
      { id: 'alice-id', auth_user_id: 'alice-auth', federated_id: 'https://harmony.test/users/alice', is_local: true },
      { id: 'eve-id', auth_user_id: 'eve-auth', federated_id: 'https://harmony.test/users/eve', is_local: true },
      { id: 'bob-id', federated_id: BOB, is_local: false, inbox_url: `${BOB}/inbox` },
    ],
    conversation_participants: [
      { id: 'p1', conversation_id: CONV, user_id: 'alice-id', left_at: null },
      { id: 'p2', conversation_id: CONV, user_id: 'bob-id', left_at: null },
    ],
    user_blocks: [],
    federated_voice_calls: [{
      id: 'call-1', ap_id: `${BOB}/activities/1`, caller_id: 'bob-id', caller_federated_id: BOB,
      recipient_id: 'alice-id', conversation_id: CONV, status: 'pending', expires_at: LATER, direction: 'inbound',
      livekit_url: 'wss://livekit.mastodon.test', room_name: ROOM, created_at: '2026-01-01T00:00:00Z',
    }],
  }
})

describe('federated-call/accept and reject', () => {
  it('only the invited recipient accepts', async () => {
    const res = await as('eve-auth')('/federated-call/accept', { conversationId: CONV, callerFederatedId: BOB })
    expect(res.status).toBe(404)
    expect(call().status).toBe('pending')

    const ok = await as('alice-auth')('/federated-call/accept', { conversationId: CONV, callerFederatedId: BOB })
    expect(ok.status).toBe(200)
    expect(call().status).toBe('accepted')
  })

  it('answers with the token the caller\'s instance issued for its room, then tells the caller', async () => {
    const res = await as('alice-auth')('/federated-call/accept', { conversationId: CONV, callerFederatedId: BOB })
    expect(res.body).toMatchObject({ token: 'REMOTE-TOKEN', livekitUrl: 'wss://livekit.mastodon.test', roomName: ROOM })
    const [callArg, recipient] = requestCallToken.mock.calls[0] as any[]
    expect(callArg).toMatchObject({ caller_federated_id: BOB, room_name: ROOM })
    expect(recipient).toEqual({ id: 'alice-id', federated_id: 'https://harmony.test/users/alice' })
    const [inbox, activity, signer] = vi.mocked(DeliveryQueue.sendToInbox).mock.calls[0] as any[]
    expect(inbox).toBe(`${BOB}/inbox`)
    expect(signer).toBe('alice-id')
    expect(activity).toMatchObject({ type: 'harmony:VoiceCallAccept', actor: 'https://harmony.test/users/alice', object: `${BOB}/activities/1` })
  })

  it('accepts nothing when the caller\'s instance issues no token', async () => {
    requestCallToken.mockResolvedValue(null)
    const res = await as('alice-auth')('/federated-call/accept', { conversationId: CONV, callerFederatedId: BOB })
    expect(res.status).toBe(502)
    expect(call().status).toBe('pending')
    expect(DeliveryQueue.sendToInbox).not.toHaveBeenCalled()
  })

  it('an outbound call is not accepted by its local caller', async () => {
    Object.assign(call(), { direction: 'outbound', caller_id: 'alice-id', caller_federated_id: 'https://harmony.test/users/alice', recipient_id: 'bob-id' })
    const res = await as('alice-auth')('/federated-call/accept', { conversationId: CONV, callerFederatedId: 'https://harmony.test/users/alice' })
    expect(res.status).toBe(404)
    expect(requestCallToken).not.toHaveBeenCalled()
  })

  it('an expired ring cannot be accepted', async () => {
    call().expires_at = '2000-01-01T00:00:00.000Z'
    const res = await as('alice-auth')('/federated-call/accept', { conversationId: CONV, callerFederatedId: BOB })
    expect(res.status).toBe(404)
    expect(call().status).toBe('pending')
  })

  it('only the invited recipient rejects', async () => {
    await as('eve-auth')('/federated-call/reject', { conversationId: CONV, callerFederatedId: BOB })
    expect(call().status).toBe('pending')
    await as('alice-auth')('/federated-call/reject', { conversationId: CONV, callerFederatedId: BOB })
    expect(call().status).toBe('rejected')
  })
})

describe('federated-call/end', () => {
  it('ends only calls the user is a party to, and tells the remote caller', async () => {
    await as('eve-auth')('/federated-call/end', { conversationId: CONV })
    expect(call().status).toBe('pending')
    await as('alice-auth')('/federated-call/end', { conversationId: CONV })
    expect(call().status).toBe('ended')
    const [inbox, activity] = vi.mocked(DeliveryQueue.sendToInbox).mock.calls[0] as any[]
    expect(inbox).toBe(`${BOB}/inbox`)
    expect(activity).toMatchObject({ type: 'harmony:VoiceCallEnd', to: [BOB], object: `${BOB}/activities/1` })
  })

  it('the local caller ends an outbound call and tells the remote recipient', async () => {
    Object.assign(call(), {
      direction: 'outbound', ap_id: 'https://harmony.test/users/alice/activities/2',
      caller_id: 'alice-id', caller_federated_id: 'https://harmony.test/users/alice', recipient_id: 'bob-id',
    })
    await as('alice-auth')('/federated-call/end', { conversationId: CONV })
    expect(call().status).toBe('ended')
    const [inbox, activity, signer] = vi.mocked(DeliveryQueue.sendToInbox).mock.calls[0] as any[]
    expect(inbox).toBe(`${BOB}/inbox`)
    expect(signer).toBe('alice-id')
    expect(activity).toMatchObject({ type: 'harmony:VoiceCallEnd', actor: 'https://harmony.test/users/alice', to: [BOB] })
  })
})

describe('with federated voice off', () => {
  it('neither rings out nor accepts', async () => {
    config.ALLOW_FEDERATED_VOICE = false
    try {
      const invite = await as('alice-auth')('/federated-call/invite', {
        calleeFederatedId: BOB, callType: 'voice', conversationId: CONV, roomName: `federated-dm-${CONV}-1700000000000`,
      })
      expect(invite.status).toBe(403)
      const accept = await as('alice-auth')('/federated-call/accept', { conversationId: CONV, callerFederatedId: BOB })
      expect(accept.status).toBe(403)
      expect(call().status).toBe('pending')
      expect(DeliveryQueue.sendToInbox).not.toHaveBeenCalled()
      expect(requestCallToken).not.toHaveBeenCalled()
    } finally {
      config.ALLOW_FEDERATED_VOICE = true
    }
  })
})

describe('federated-call/invite', () => {
  const body = (extra: Record<string, any> = {}) => ({
    calleeFederatedId: BOB, callType: 'voice', conversationId: CONV, roomName: `federated-dm-${CONV}-1700000000000`,
    callerFederatedId: 'https://harmony.test/users/somebody-else', livekitUrl: 'wss://evil.test', ...extra,
  })

  it('goes out under the caller\'s own actor with this instance\'s LiveKit URL', async () => {
    const res = await as('alice-auth')('/federated-call/invite', body())
    expect(res.status).toBe(200)
    const [inbox, activity, signer] = vi.mocked(DeliveryQueue.sendToInbox).mock.calls[0] as any[]
    expect(inbox).toBe(`${BOB}/inbox`)
    expect(signer).toBe('alice-id')
    expect(activity.actor).toBe('https://harmony.test/users/alice')
    expect(activity.object.livekitUrl).toBe('wss://livekit.harmony.test')
  })

  it('stores the invite as an outbound call naming the callee and the room', async () => {
    tables.federated_voice_calls = []
    const res = await as('alice-auth')('/federated-call/invite', body())
    expect(tables.federated_voice_calls).toEqual([expect.objectContaining({
      ap_id: res.body.activityId, direction: 'outbound', status: 'pending',
      caller_id: 'alice-id', caller_federated_id: 'https://harmony.test/users/alice', recipient_id: 'bob-id',
      conversation_id: CONV, room_name: `federated-dm-${CONV}-1700000000000`, livekit_url: 'wss://livekit.harmony.test',
    })])
  })

  it('refuses a conversation the callee is not in, or a room for another conversation', async () => {
    tables.federated_voice_calls = []
    expect((await as('eve-auth')('/federated-call/invite', body())).status).toBe(403)
    expect((await as('alice-auth')('/federated-call/invite', body({ roomName: 'channel-22222222-2222-2222-2222-222222222222' }))).status).toBe(400)
    expect(DeliveryQueue.sendToInbox).not.toHaveBeenCalled()
    expect(tables.federated_voice_calls).toEqual([])
  })

  it('refuses across a block', async () => {
    tables.user_blocks.push({ blocker_id: 'bob-id', blocked_user_id: 'alice-id', expires_at: null })
    expect((await as('alice-auth')('/federated-call/invite', body())).status).toBe(403)
  })
})
