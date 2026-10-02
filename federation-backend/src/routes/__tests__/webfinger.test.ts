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

// WebFingerService now queries BOTH tables (Lemmy-style handle disambiguation):
//   .from('profiles').select(...).ilike('username', X).eq('is_local', true).is('deleted_at', null).maybeSingle()
//   .from('servers').select(...).ilike('slug', X).eq(...).eq(...).eq(...).maybeSingle()
// and, when neither matches, deleted_actors for the 410 of a deleted account.
// The `.eq()` must be self-chaining (the servers query chains three of them) and
// each terminal `.maybeSingle()` resolves to that table's row. Dispatch by the
// `from()` table name so a user and/or a server can be returned independently.
function setupMocks(opts: { user?: string | null; server?: { id: string; slug: string } | null } = {}) {
  const makeChain = (result: any) => {
    const chain: any = {
      select: vi.fn(() => chain),
      ilike: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      is: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      maybeSingle: vi.fn(() => Promise.resolve(result)),
    }
    return chain
  }

  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'profiles') {
      return makeChain(
        opts.user
          ? { data: { username: opts.user, domain: 'harmony.test' }, error: null }
          : { data: null, error: null },
      )
    }
    if (table === 'servers') {
      return makeChain(
        opts.server ? { data: opts.server, error: null } : { data: null, error: null },
      )
    }
    return makeChain({ data: null, error: null })
  })
}

function setupMockUser(username: string | null) {
  setupMocks({ user: username })
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

  it('resolves a chat server (Group) by handle with an AS type property', async () => {
    setupMocks({ user: null, server: { id: 'srv-1', slug: 'gaming' } })
    const app = await createTestApp()
    const res = await supertest(app).get(
      '/.well-known/webfinger?resource=acct:gaming@harmony.test'
    )
    expect(res.status).toBe(200)
    expect(res.body.subject).toBe('acct:gaming@harmony.test')
    expect(res.body.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rel: 'self',
          type: 'application/activity+json',
          href: 'https://harmony.test/servers/srv-1',
          properties: { 'https://www.w3.org/ns/activitystreams#type': 'Group' },
        }),
      ])
    )
  })

  it('does not pass ILIKE wildcards through to the lookup', async () => {
    setupMockUser('alice')
    const app = await createTestApp()
    for (const localpart of ['%25', '*', 'a%25']) {
      const res = await supertest(app).get(`/.well-known/webfinger?resource=acct:${localpart}@harmony.test`)
      expect(res.status).toBe(404)
    }
  })

  it('escapes _ so a_b does not match axb', async () => {
    setupMockUser('a_b')
    mockSupabase.from.mockClear()
    const app = await createTestApp()
    await supertest(app).get('/.well-known/webfinger?resource=acct:a_b@harmony.test')
    const profilesChain = mockSupabase.from.mock.results.find(
      (_r: any, i: number) => mockSupabase.from.mock.calls[i][0] === 'profiles',
    )?.value
    expect(profilesChain.ilike).toHaveBeenCalledWith('username', 'a\\_b')
  })

  it('returns BOTH actors when a user and a server share a handle (type-tagged)', async () => {
    setupMocks({ user: 'general', server: { id: 'srv-9', slug: 'general' } })
    const app = await createTestApp()
    const res = await supertest(app).get(
      '/.well-known/webfinger?resource=acct:general@harmony.test'
    )
    expect(res.status).toBe(200)
    const selfLinks = res.body.links.filter(
      (l: any) => l.rel === 'self' && l.type === 'application/activity+json'
    )
    expect(selfLinks).toHaveLength(2)
    const types = selfLinks.map((l: any) => l.properties?.['https://www.w3.org/ns/activitystreams#type'])
    expect(types).toContain('Person')
    expect(types).toContain('Group')
  })
})
