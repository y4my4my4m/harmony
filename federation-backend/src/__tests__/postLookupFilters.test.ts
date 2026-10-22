import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// Unauthenticated post lookups by URL: POST /resolve-post and GET /fetch-replies/status.
// The database double evaluates `.or()` trees the way PostgREST splits them: top-level
// commas outside double quotes and parentheses separate clauses, a quoted value is one
// literal. A URL carrying `,` or `(` must not add clauses.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', VERSION: 'test', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(),
  validateExternalHostname: vi.fn(),
  validateExternalUrl: vi.fn(),
}))
vi.mock('../middleware/rateLimit.js', () => {
  const pass = (_req: any, _res: any, next: any) => next()
  return { discoveryLimiter: pass, reactionsLimiter: pass, repliesLimiter: pass, repliesStatusLimiter: pass }
})
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: () => false },
}))
vi.mock('../activitypub/InstanceActor.js', () => ({
  signAsInstanceActor: vi.fn(async () => { throw new Error('no instance key in tests') }),
}))
vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichPostLinkPreviews: vi.fn(async () => false),
}))

type Row = Record<string, any>
let posts: Row[] = []
const orExpressions: string[] = []

/** Top-level clauses of a PostgREST logical tree. */
function splitTree(expr: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let current = ''
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]
    if (quoted) {
      current += ch
      if (ch === '\\') { current += expr[++i] ?? ''; continue }
      if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(current); current = ''; continue }
    current += ch
  }
  out.push(current)
  return out
}

function clauseMatches(clause: string, row: Row): boolean {
  const and = /^and\((.*)\)$/.exec(clause)
  if (and) return splitTree(and[1]).every((c) => clauseMatches(c, row))
  const m = /^([\w]+)\.eq\.(.*)$/.exec(clause)
  if (!m) return false
  const raw = m[2]
  const value = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, '$1') : raw
  return String(row[m[1]]) === value
}

function fakeSupabase(visible: (row: Row) => boolean = () => true) {
  return {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from() {
      const filters: Array<(row: Row) => boolean> = [visible]
      const builder: any = {
        select() { return builder },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder },
        or(expr: string) {
          orExpressions.push(expr)
          filters.push((row) => splitTree(expr).some((c) => clauseMatches(c, row)))
          return builder
        },
        order() { return builder },
        limit() { return builder },
        maybeSingle() { return Promise.resolve({ data: posts.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }) },
      }
      return builder
    },
  }
}
// A session's client: 'reader' reads every row (as RLS lets a recipient), any other none.
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => fakeSupabase(),
  getSupabaseClientWithAuth: (token: string) => (token === 'reader' ? fakeSupabase() : fakeSupabase(() => false)),
}))

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const actorRouter = (await import('../activitypub/ActorService.js')).default

const app = () => {
  const a = express()
  a.use(express.json())
  a.use('/', actorRouter)
  return a
}

const DIRECT = {
  id: '0f1e2d3c-0000-4000-8000-000000000001', author_id: 'a1', visibility: 'direct', is_deleted: false,
  ap_id: 'https://harmony.test/posts/0f1e2d3c-0000-4000-8000-000000000001', url: null,
  replies_count: 3, favorites_count: 2, reblogs_count: 0, created_at: '2026-10-01T00:00:00Z', replies_fetched_at: null,
}

beforeEach(() => {
  posts = [{ ...DIRECT }]
  orExpressions.length = 0
  vi.spyOn(ActivityProcessor, 'fetchAndCreateRemotePost').mockResolvedValue(null)
})

describe('POST /resolve-post', () => {
  it('quotes every URL variant inside the filter tree', async () => {
    await supertest(app()).post('/resolve-post').send({ url: 'https://evil.test/x,visibility.eq.direct' })
    expect(orExpressions).toHaveLength(1)
    for (const clause of splitTree(orExpressions[0])) {
      expect(clause).toMatch(/^(ap_id|url)\.eq\."(?:[^"\\]|\\.)*"$/)
    }
  })

  it('does not name a private post for a URL that carries filter syntax', async () => {
    const res = await supertest(app()).post('/resolve-post')
      .send({ url: 'https://evil.test/x,visibility.eq.direct' })
    expect(res.body.post_id).toBeUndefined()
    expect(res.status).toBe(404)
  })

  it('does not answer a content predicate smuggled in an and() group', async () => {
    const res = await supertest(app()).post('/resolve-post')
      .send({ url: `https://evil.test/x,and(author_id.eq.a1,visibility.eq.direct)` })
    expect(res.body.post_id).toBeUndefined()
  })

  it('names a stored direct post only to a session that reads it, and fetches nothing', async () => {
    const anonymous = await supertest(app()).post('/resolve-post').send({ url: DIRECT.ap_id })
    expect(anonymous.status).toBe(404)
    expect(anonymous.body.post_id).toBeUndefined()
    const stranger = await supertest(app()).post('/resolve-post').set('Authorization', 'Bearer other').send({ url: DIRECT.ap_id })
    expect(stranger.status).toBe(404)
    const reader = await supertest(app()).post('/resolve-post').set('Authorization', 'Bearer reader').send({ url: DIRECT.ap_id })
    expect(reader.body).toEqual({ success: true, post_id: DIRECT.id })
    expect(ActivityProcessor.fetchAndCreateRemotePost).not.toHaveBeenCalled()
  })

  it('still resolves a stored post by its exact URL', async () => {
    posts.push({ id: 'pub', visibility: 'public', is_deleted: false, ap_id: 'https://remote.test/notes/1', url: null })
    const res = await supertest(app()).post('/resolve-post').send({ url: 'https://remote.test/notes/1' })
    expect(res.body).toEqual({ success: true, post_id: 'pub' })
  })
})

describe('GET /fetch-replies/status', () => {
  it('gives no counts for a direct post', async () => {
    const res = await supertest(app()).get('/fetch-replies/status').query({ post_ap_id: DIRECT.ap_id })
    expect(res.status).toBe(200)
    expect(res.body.replies_count).toBeUndefined()
    expect(res.body.favorites_count).toBeUndefined()
  })

  it('gives counts for a public post', async () => {
    posts = [{ ...DIRECT, visibility: 'public' }]
    const res = await supertest(app()).get('/fetch-replies/status').query({ post_ap_id: DIRECT.ap_id })
    expect(res.body.replies_count).toBe(3)
  })
})
