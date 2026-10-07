import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import express from 'express'
import supertest from 'supertest'
import { AccessToken } from 'livekit-server-sdk'

// POST /api/livekit/webhook: a LiveKit-signed participant_left / room_finished on
// a channel room reconciles that channel; anything unsigned is refused.

const API_KEY = 'lk-key'
const API_SECRET = 'lk-secret-lk-secret-lk-secret-lk-secret'

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
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => { throw new Error('unused') },
  getSupabaseClientWithAuth: () => { throw new Error('unused') },
}))
vi.mock('../activitypub/SignatureService.js', () => ({ SignatureService: {} }))
vi.mock('../activitypub/DeliveryQueue.js', () => ({ DeliveryQueue: { sendToInbox: vi.fn(), enqueue: vi.fn() } }))
vi.mock('../services/voiceParticipantSweep.js', () => ({
  reconcileVoiceNow: vi.fn(async () => ({ ok: true, checked: 0, removed: 0 })),
}))

const { default: livekitRouter } = await import('../routes/livekit.js')
const { reconcileVoiceNow } = await import('../services/voiceParticipantSweep.js')

const CHANNEL = '11111111-1111-4111-8111-111111111111'
const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001'

const app = express()
app.use(express.json())
app.use('/api/livekit', livekitRouter)

async function sign(body: string, secret = API_SECRET): Promise<string> {
  const at = new AccessToken(API_KEY, secret, { ttl: '5m' })
  at.sha256 = createHash('sha256').update(body).digest('base64')
  return at.toJwt()
}

function post(body: string, auth?: string) {
  const req = supertest(app).post('/api/livekit/webhook').set('Content-Type', 'application/webhook+json')
  if (auth) req.set('Authorization', auth)
  return req.send(body)
}

const participantLeft = JSON.stringify({
  event: 'participant_left',
  id: 'EV_1',
  createdAt: '1791244800',
  room: { name: `channel-${CHANNEL}` },
  participant: {
    identity: 'federated:https://harmony.test/users/alice',
    metadata: JSON.stringify({ profileId: ALICE }),
  },
})

beforeEach(() => {
  vi.mocked(reconcileVoiceNow).mockClear()
})

describe('POST /api/livekit/webhook', () => {
  it('refuses a request without a signature', async () => {
    const res = await post(participantLeft)
    expect(res.status).toBe(401)
    expect(reconcileVoiceNow).not.toHaveBeenCalled()
  })

  it('refuses a request signed with another secret', async () => {
    const res = await post(participantLeft, await sign(participantLeft, 'another-secret-another-secret-another'))
    expect(res.status).toBe(401)
    expect(reconcileVoiceNow).not.toHaveBeenCalled()
  })

  it('refuses a body the signature does not cover', async () => {
    const tampered = participantLeft.replace(CHANNEL, '22222222-2222-4222-8222-222222222222')
    const res = await post(tampered, await sign(participantLeft))
    expect(res.status).toBe(401)
    expect(reconcileVoiceNow).not.toHaveBeenCalled()
  })

  it('reconciles the channel of a participant_left with the departure', async () => {
    const res = await post(participantLeft, await sign(participantLeft))
    expect(res.status).toBe(200)
    expect(reconcileVoiceNow).toHaveBeenCalledWith({
      channelIds: [CHANNEL],
      departure: {
        identity: 'federated:https://harmony.test/users/alice',
        profileId: ALICE,
        at: new Date(1791244800 * 1000),
      },
    })
  })

  it('reconciles the channel of a room_finished without a departure', async () => {
    const body = JSON.stringify({ event: 'room_finished', id: 'EV_2', createdAt: '1791244800', room: { name: `stage-${CHANNEL}` } })
    const res = await post(body, await sign(body))
    expect(res.status).toBe(200)
    expect(reconcileVoiceNow).toHaveBeenCalledWith({ channelIds: [CHANNEL], departure: undefined })
  })

  it('ignores DM rooms and other events', async () => {
    const dm = JSON.stringify({ event: 'participant_left', id: 'EV_3', room: { name: `dm-${CHANNEL}` },
      participant: { identity: 'x' } })
    const joined = JSON.stringify({ event: 'participant_joined', id: 'EV_4', room: { name: `channel-${CHANNEL}` },
      participant: { identity: 'x' } })
    expect((await post(dm, await sign(dm))).status).toBe(200)
    expect((await post(joined, await sign(joined))).status).toBe(200)
    expect(reconcileVoiceNow).not.toHaveBeenCalled()
  })
})
