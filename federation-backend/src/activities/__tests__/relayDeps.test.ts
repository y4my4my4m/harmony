import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'

// The relay's token check against a real supabase-js client: what GoTrue and PostgREST answer is
// the fetch stub below.

const answers = vi.hoisted(() => ({
  user: (): Response | Promise<Response> => new Response('{}'),
  profile: (): Response | Promise<Response> => new Response('[]'),
}))

const client = createClient('http://kong.test', 'service-key', {
  auth: { persistSession: false, autoRefreshToken: false },
  global: {
    fetch: async (input) => {
      const url = String(input instanceof Request ? input.url : input)
      return url.includes('/auth/v1/user') ? answers.user() : answers.profile()
    },
  },
})

vi.mock('../../config/supabase.js', () => ({ getSupabaseClient: () => client }))

const { supabaseRelayDeps } = await import('../relayDeps.js')

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const USER = { id: 'aaaaaaaa-0000-4000-8000-000000000001', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z', factors: [] }
const PROFILE = 'bbbbbbbb-0000-4000-8000-000000000001'
const token = (exp: number, aal = 'aal1') => `h.${Buffer.from(JSON.stringify({ exp, sub: USER.id, aal })).toString('base64url')}.s`
const FACTOR = { id: 'cccccccc-0000-4000-8000-000000000001', factor_type: 'totp', status: 'verified', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }

const verify = () => supabaseRelayDeps().verifyToken(token(2_000_000_000))

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  answers.user = () => json(200, USER)
  answers.profile = () => json(200, [{ id: PROFILE }])
})

describe('relay token check', () => {
  it('names the local profile of a valid token', async () => {
    expect(await verify()).toEqual({ profileId: PROFILE, expiresAt: 2_000_000_000_000 })
  })

  it.each([
    ['401', () => json(401, { message: 'Invalid authentication credentials' })],
    ['403 bad_jwt', () => json(403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' })],
    ['403 user_not_found', () => json(403, { code: 403, error_code: 'user_not_found', msg: 'User from sub claim in JWT does not exist' })],
    ['403 session_not_found', () => json(403, { code: 403, error_code: 'session_not_found', msg: 'Session from session_id claim in JWT does not exist' })],
  ])('refuses a token GoTrue answers %s', async (_name, answer) => {
    answers.user = answer
    expect(await verify()).toBeNull()
  })

  it('refuses a token below aal2 of an account with a verified factor', async () => {
    answers.user = () => json(200, { ...USER, factors: [FACTOR] })
    expect(await supabaseRelayDeps().verifyToken(token(2_000_000_000, 'aal1'))).toBeNull()
    expect(await supabaseRelayDeps().verifyToken(token(2_000_000_000, 'aal2'))).toEqual({ profileId: PROFILE, expiresAt: 2_000_000_000_000 })
    answers.user = () => json(200, { ...USER, factors: [{ ...FACTOR, status: 'unverified' }] })
    expect(await supabaseRelayDeps().verifyToken(token(2_000_000_000, 'aal1'))).toEqual({ profileId: PROFILE, expiresAt: 2_000_000_000_000 })
  })

  it('refuses a token whose account has no local profile', async () => {
    answers.profile = () => json(200, [])
    expect(await verify()).toBeNull()
  })

  it.each([
    ['503', () => json(503, { message: 'name resolution failed' })],
    ['502 with an HTML body', () => new Response('<html>', { status: 502 })],
    ['500', () => json(500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error' })],
    ['500 with no JSON', () => new Response('upstream', { status: 500 })],
    ['429', () => json(429, { code: 429, error_code: 'over_request_rate_limit', msg: 'rate limit' })],
    ['404 with no route', () => json(404, { message: 'no Route matched with those values' })],
    ['a connection error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('throws when GoTrue answers %s', async (_name, answer) => {
    answers.user = answer
    await expect(verify()).rejects.toThrow(/token check/)
  })

  it('throws when the profile cannot be read', async () => {
    answers.profile = () => json(503, { code: 'PGRST002', message: 'Could not query the database for the schema cache' })
    await expect(verify()).rejects.toThrow(/token profile/)
  })

  it('keeps nothing of a failed check', async () => {
    const deps = supabaseRelayDeps()
    answers.user = () => json(503, {})
    await expect(deps.verifyToken(token(2_000_000_000))).rejects.toThrow()
    answers.user = () => json(200, USER)
    expect(await deps.verifyToken(token(2_000_000_000))).toEqual({ profileId: PROFILE, expiresAt: 2_000_000_000_000 })
  })
})
