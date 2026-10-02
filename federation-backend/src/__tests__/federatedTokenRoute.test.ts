import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// POST /api/livekit/federated-token: an expected refusal is answered 403 and
// logged at info with its reason; anything else is a 500 logged as an error.

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
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../utils/logger.js', () => ({ logger: log }))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: {
    verifySignature: vi.fn(async () => ({ verified: true, actorUrl: 'https://remote.test/users/bob' })),
    verifyActorMatch: (a: string, b: string) => a === b,
  },
}))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({}), getSupabaseClientWithAuth: () => ({}) }))

const { default: livekitRouter } = await import('../routes/livekit.js')
const { livekitService, TokenRefused } = await import('../services/LiveKitService.js')
const generate = vi.spyOn(livekitService, 'generateFederatedToken')

const app = express()
app.use(express.json())
app.use('/api/livekit', livekitRouter)
const ask = () => supertest(app).post('/api/livekit/federated-token').set('Signature', 'sig')
  .send({ actorId: 'https://remote.test/users/bob', roomName: 'federated-dm-x-1', roomType: 'dm_call' })

beforeEach(() => {
  Object.values(log).forEach((fn) => fn.mockClear())
  generate.mockReset()
})

describe('federated-token logging', () => {
  it('a refusal is a 403 logged at info with its reason', async () => {
    generate.mockRejectedValue(new TokenRefused('permission denied: no live outbound call', 'Not authorized for this room'))
    const res = await ask()
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Not authorized for this room')
    expect(log.error).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('permission denied: no live outbound call'))
  })

  it('an unexpected failure is a 500 logged as an error', async () => {
    generate.mockRejectedValue(new Error('LiveKit exploded'))
    const res = await ask()
    expect(res.status).toBe(500)
    expect(log.error).toHaveBeenCalled()
  })
})
