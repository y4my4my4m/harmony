import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// The per-instance inbox budget is keyed on the verified signer's host, after
// signature verification. The per-IP limiter runs before verification and is
// replaced by a pass-through here so the signer budget is what is measured.

vi.mock('../../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', REQUIRE_VALID_SIGNATURES: true },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../../services/RedisService.js', () => ({ redis: { ready: false } }))
vi.mock('../../middleware/rateLimit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/rateLimit.js')>()),
  inboxLimiter: (_req: any, _res: any, next: any) => next(),
}))
vi.mock('../../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: () => false },
}))
vi.mock('../../services/FederatedInstanceService.js', () => ({
  FederatedInstanceService: { touchFromUrl: vi.fn() },
}))
vi.mock('../../config/supabase.js', () => ({
  getSupabaseClient: () => ({ rpc: () => Promise.resolve({ data: true, error: null }) }),
  getSupabaseClientWithAuth: vi.fn(),
}))
vi.mock('../../activitypub/ActivityProcessor.js', () => ({
  ActivityProcessor: { processIncomingActivity: vi.fn().mockResolvedValue(undefined) },
}))

const verifySignature = vi.fn()
vi.mock('../../activitypub/SignatureService.js', async () => {
  const actual = await vi.importActual<any>('../../activitypub/SignatureService.js')
  return {
    SignatureService: {
      verifySignature: (...args: any[]) => verifySignature(...args),
      verifyActorMatch: actual.SignatureService.verifyActorMatch,
    },
  }
})

const { default: inboxRouter } = await import('../../activitypub/InboxHandler.js')

const app = express()
app.use(express.json({ type: ['application/json', 'application/activity+json'] }))
app.use('/', inboxRouter)

let n = 0
const post = (actor: string) =>
  supertest(app)
    .post('/inbox')
    .set('Content-Type', 'application/activity+json')
    .set('Signature', 'keyId="k",signature="s"')
    .send({ id: `https://x.test/a/${n++}`, type: 'Like', actor, object: 'https://harmony.test/posts/1' })

beforeEach(() => {
  verifySignature.mockReset()
})

describe('inbox per-instance budget', () => {
  it('does not charge the domain named in the body for activities that fail verification', async () => {
    verifySignature.mockResolvedValue({ verified: false, error: 'bad signature' })
    for (let i = 0; i < 70; i++) {
      expect((await post('https://victim.test/users/v')).status).toBe(401)
    }

    verifySignature.mockResolvedValue({ verified: true, actorUrl: 'https://victim.test/users/v' })
    expect((await post('https://victim.test/users/v')).status).toBe(202)
  })

  it('charges the verified signer and refuses it past the budget', async () => {
    verifySignature.mockResolvedValue({ verified: true, actorUrl: 'https://flood.test/users/f' })
    for (let i = 0; i < 60; i++) {
      expect((await post('https://flood.test/users/f')).status).toBe(202)
    }
    const res = await post('https://flood.test/users/f')
    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })

  it('a signer over budget cannot shift its traffic onto another domain', async () => {
    verifySignature.mockResolvedValue({ verified: true, actorUrl: 'https://spender.test/users/s' })
    for (let i = 0; i < 61; i++) await post('https://spender.test/users/s')

    // The body names another domain; the key still belongs to spender.test.
    expect((await post('https://other.test/users/o')).status).toBe(403)

    verifySignature.mockResolvedValue({ verified: true, actorUrl: 'https://other.test/users/o' })
    expect((await post('https://other.test/users/o')).status).toBe(202)
  })
})
