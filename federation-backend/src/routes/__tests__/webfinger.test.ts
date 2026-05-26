import { describe, it, expect, vi } from 'vitest'
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
  },
}))

const mockSupabase = {
  from: vi.fn(),
}

vi.mock('../../config/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => mockSupabase),
}))

vi.mock('../../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))

import { default as supertest } from 'supertest'

function setupMockUser(username: string | null) {
  // WebFingerService chains:
  //   .from('profiles').select(...).ilike('username', X).eq('is_local', true).maybeSingle()
  // The previous mock used `.eq().eq().single()` which (a) doesn't expose
  // the `ilike` step the route calls and (b) terminates with `.single()`
  // instead of `.maybeSingle()` - both produce `undefined.method()` at
  // runtime, which the route's asyncHandler turns into a 500 response and
  // every assertion of 200/404 fails. Mirror the actual chain shape.
  const result = Promise.resolve(
    username
      ? { data: { username, domain: 'harmony.test' }, error: null }
      : { data: null, error: null },
  )
  mockSupabase.from.mockReturnValue({
    select: vi.fn().mockReturnValue({
      ilike: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockReturnValue(result),
        }),
      }),
    }),
  })
}

async function createTestApp() {
  const app = express()
  app.use(express.json())
  const { default: webFingerRouter } = await import('../../activitypub/WebFingerService.js')
  app.use('/', webFingerRouter)
  return app
}

describe('WebFinger endpoint', () => {
  it('returns 400 when resource param is missing', async () => {
    const app = await createTestApp()
    const res = await supertest(app).get('/.well-known/webfinger')
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('resource')
  })

  it('returns 400 for invalid resource format', async () => {
    const app = await createTestApp()
    const res = await supertest(app).get('/.well-known/webfinger?resource=invalid')
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Invalid')
  })

  it('returns 404 for wrong domain', async () => {
    const app = await createTestApp()
    const res = await supertest(app).get(
      '/.well-known/webfinger?resource=acct:alice@other-domain.com'
    )
    expect(res.status).toBe(404)
  })

  it('returns 404 for non-existent user', async () => {
    setupMockUser(null)
    const app = await createTestApp()
    const res = await supertest(app).get(
      '/.well-known/webfinger?resource=acct:nonexistent@harmony.test'
    )
    expect(res.status).toBe(404)
  })

  it('returns valid WebFinger response for existing user', async () => {
    setupMockUser('alice')
    const app = await createTestApp()
    const res = await supertest(app).get(
      '/.well-known/webfinger?resource=acct:alice@harmony.test'
    )
    expect(res.status).toBe(200)
    expect(res.body.subject).toBe('acct:alice@harmony.test')
    expect(res.body.aliases).toContain('https://harmony.test/users/alice')
    expect(res.body.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rel: 'self',
          type: 'application/activity+json',
          href: 'https://harmony.test/users/alice',
        }),
      ])
    )
  })

  it('WebFinger response includes profile-page link', async () => {
    setupMockUser('bob')
    const app = await createTestApp()
    const res = await supertest(app).get(
      '/.well-known/webfinger?resource=acct:bob@harmony.test'
    )
    expect(res.body.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rel: 'http://webfinger.net/rel/profile-page',
          type: 'text/html',
        }),
      ])
    )
  })
})
