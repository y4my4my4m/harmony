import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'

vi.mock('../../config/index.js', () => ({
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
  },
}))

const mockRpc = vi.fn().mockResolvedValue({ error: null })
const mockSupabase = {
  from: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    }),
  }),
  rpc: mockRpc,
}

vi.mock('../../config/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => mockSupabase),
}))

vi.mock('../../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
  AppError: class extends Error {
    statusCode: number
    constructor(code: number, msg: string) {
      super(msg)
      this.statusCode = code
    }
  },
}))

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: {
    isBlocked: vi.fn(() => false),
  },
}))

vi.mock('../../activitypub/SignatureService.js', () => ({
  SignatureService: {
    verifySignature: vi.fn().mockResolvedValue({ verified: true, actorUrl: 'https://mastodon.social/users/alice' }),
    verifyActorMatch: vi.fn().mockReturnValue(true),
  },
}))

vi.mock('../../activitypub/ActivityProcessor.js', () => ({
  ActivityProcessor: {
    processIncomingActivity: vi.fn().mockResolvedValue(undefined),
  },
}))

import { default as supertest } from 'supertest'

async function createTestApp() {
  const app = express()
  app.use(express.json({
    type: ['application/json', 'application/activity+json', 'application/ld+json'],
  }))
  const { default: inboxRouter } = await import('../../activitypub/InboxHandler.js')
  app.use('/', inboxRouter)
  return app
}

describe('Inbox handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRpc.mockResolvedValue({ error: null })
    mockSupabase.from.mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    })
  })

  describe('POST /inbox (shared inbox)', () => {
    it('rejects empty body with 400', async () => {
      const app = await createTestApp()
      const res = await supertest(app)
        .post('/inbox')
        .set('Content-Type', 'application/activity+json')
        .send({})
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Invalid activity')
    })

    it('rejects activity without type', async () => {
      const app = await createTestApp()
      const res = await supertest(app)
        .post('/inbox')
        .set('Content-Type', 'application/activity+json')
        .send({ actor: 'https://mastodon.social/users/alice' })
      expect(res.status).toBe(400)
    })

    it('rejects activity without actor', async () => {
      const app = await createTestApp()
      const res = await supertest(app)
        .post('/inbox')
        .set('Content-Type', 'application/activity+json')
        .send({ type: 'Follow' })
      expect(res.status).toBe(400)
    })

    it('rejects unsigned activity when REQUIRE_VALID_SIGNATURES is true', async () => {
      const app = await createTestApp()
      const res = await supertest(app)
        .post('/inbox')
        .set('Content-Type', 'application/activity+json')
        .send({
          type: 'Follow',
          actor: 'https://mastodon.social/users/alice',
          object: 'https://harmony.test/users/bob',
        })
      // No Signature header -> 401
      expect(res.status).toBe(401)
      expect(res.body.error).toContain('Signature')
    })

    it('accepts valid signed activity', async () => {
      const { SignatureService } = await import('../../activitypub/SignatureService.js')
      ;(SignatureService.verifySignature as any).mockResolvedValue({
        verified: true,
        actorUrl: 'https://mastodon.social/users/alice',
      })
      ;(SignatureService.verifyActorMatch as any).mockReturnValue(true)

      const app = await createTestApp()
      const res = await supertest(app)
        .post('/inbox')
        .set('Content-Type', 'application/activity+json')
        .set('Signature', 'keyId="https://mastodon.social/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="abc123"')
        .send({
          id: 'https://mastodon.social/activities/follow-1',
          type: 'Follow',
          actor: 'https://mastodon.social/users/alice',
          object: 'https://harmony.test/users/bob',
        })
      expect(res.status).toBe(202)
    })

    it('rejects activity when signature verification fails', async () => {
      const { SignatureService } = await import('../../activitypub/SignatureService.js')
      ;(SignatureService.verifySignature as any).mockResolvedValue({
        verified: false,
        actorUrl: 'https://mastodon.social/users/alice',
        error: 'Invalid signature',
      })

      const app = await createTestApp()
      const res = await supertest(app)
        .post('/inbox')
        .set('Content-Type', 'application/activity+json')
        .set('Signature', 'keyId="https://mastodon.social/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="badsig"')
        .send({
          id: 'https://mastodon.social/activities/1',
          type: 'Follow',
          actor: 'https://mastodon.social/users/alice',
          object: 'https://harmony.test/users/bob',
        })
      expect(res.status).toBe(401)
      expect(res.body.error).toContain('Invalid HTTP Signature')
    })

    it('rejects activity when actor does not match signing key (spoofing)', async () => {
      const { SignatureService } = await import('../../activitypub/SignatureService.js')
      ;(SignatureService.verifySignature as any).mockResolvedValue({
        verified: true,
        actorUrl: 'https://evil.example.com/users/impersonator',
      })
      ;(SignatureService.verifyActorMatch as any).mockReturnValue(false)

      const app = await createTestApp()
      const res = await supertest(app)
        .post('/inbox')
        .set('Content-Type', 'application/activity+json')
        .set('Signature', 'keyId="https://evil.example.com/users/impersonator#main-key",signature="sig"')
        .send({
          id: 'https://mastodon.social/activities/1',
          type: 'Follow',
          actor: 'https://mastodon.social/users/alice',
          object: 'https://harmony.test/users/bob',
        })
      expect(res.status).toBe(403)
      expect(res.body.error).toContain('Actor mismatch')
    })
  })

  describe('POST /users/:username/inbox', () => {
    it('returns 404 when user does not exist', async () => {
      const { SignatureService } = await import('../../activitypub/SignatureService.js')
      ;(SignatureService.verifySignature as any).mockResolvedValue({
        verified: true,
        actorUrl: 'https://mastodon.social/users/alice',
      })
      ;(SignatureService.verifyActorMatch as any).mockReturnValue(true)

      mockSupabase.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
            }),
          }),
        }),
      })

      const app = await createTestApp()
      const res = await supertest(app)
        .post('/users/nonexistent/inbox')
        .set('Content-Type', 'application/activity+json')
        .set('Signature', 'keyId="https://mastodon.social/users/alice#main-key",signature="sig"')
        .send({
          id: 'https://mastodon.social/activities/1',
          type: 'Follow',
          actor: 'https://mastodon.social/users/alice',
          object: 'https://harmony.test/users/nonexistent',
        })
      expect(res.status).toBe(404)
    })
  })
})
