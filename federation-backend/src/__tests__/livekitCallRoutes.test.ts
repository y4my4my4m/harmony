import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// /api/livekit/federated-call/*: each route acts for the authenticated profile
// only. federated_voice_calls holds inbound invites (remote caller, local
// recipient).

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

const { default: livekitRouter } = await import('../routes/livekit.js')
const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')

const app = express()
app.use(express.json())
app.use('/api/livekit', livekitRouter)
const as = (authUid: string) => (path: string, body: any) =>
  supertest(app).post(`/api/livekit${path}`).set('Authorization', `Bearer ${authUid}`).send(body)

const BOB = 'https://mastodon.test/users/bob'
const CONV = '88888888-8888-8888-8888-888888888888'
const LATER = '2999-01-01T00:00:00.000Z'
const call = () => tables.federated_voice_calls[0]

beforeEach(() => {
  vi.mocked(DeliveryQueue.sendToInbox).mockReset()
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
      recipient_id: 'alice-id', conversation_id: CONV, status: 'pending', expires_at: LATER,
      livekit_url: 'wss://livekit.mastodon.test', room_name: `federated-dm-${CONV}-1`, created_at: '2026-01-01T00:00:00Z',
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
  it('ends only calls the user is a party to', async () => {
    await as('eve-auth')('/federated-call/end', { conversationId: CONV })
    expect(call().status).toBe('pending')
    await as('alice-auth')('/federated-call/end', { conversationId: CONV })
    expect(call().status).toBe('ended')
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

  it('refuses a conversation the callee is not in, or a room for another conversation', async () => {
    expect((await as('eve-auth')('/federated-call/invite', body())).status).toBe(403)
    expect((await as('alice-auth')('/federated-call/invite', body({ roomName: 'channel-22222222-2222-2222-2222-222222222222' }))).status).toBe(400)
    expect(DeliveryQueue.sendToInbox).not.toHaveBeenCalled()
  })

  it('refuses across a block', async () => {
    tables.user_blocks.push({ blocker_id: 'bob-id', blocked_user_id: 'alice-id', expires_at: null })
    expect((await as('alice-auth')('/federated-call/invite', body())).status).toBe(403)
  })
})
