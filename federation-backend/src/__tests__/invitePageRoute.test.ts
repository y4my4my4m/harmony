import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// GET /invite/:code, the link-preview page of a server invite, and /oembed for invite URLs.
// public.get_invite_preview is emulated; its SQL is covered by
// db_schema/tests/123_invite_preview_online_count.sql.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony', PUBLIC_SUPABASE_URL: 'https://db.harmony.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../middleware/rateLimit.js', () => ({
  invitePageLimiter: (_req: any, _res: any, next: any) => next(),
}))

const VALID = {
  status: 'valid', code: 'ABCD1234', server_id: 'server-1', name: 'Secret Lounge',
  description: 'Hang out.', icon: 's1/icon.png', banner: null, rules: ['be kind'],
  member_count: 1234, online_count: 56, expires_at: null, is_member: false,
}

const answers: Record<string, { data: unknown; error: unknown } | Error> = {}
const rpc = vi.fn(async (name: string, args: { p_code: string }) => {
  if (name !== 'get_invite_preview') return { data: null, error: { message: `unexpected ${name}` } }
  const answer = answers[args.p_code] ?? { data: { status: 'not_found' }, error: null }
  if (answer instanceof Error) throw answer
  return answer
})

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ rpc: (n: string, a: any) => rpc(n, a), from: vi.fn() }),
  getSupabaseClientWithAuth: vi.fn(),
}))

const { cache } = await import('../utils/cache.js')
const { default: invitePageRouter } = await import('../routes/invitePage.js')
const { default: outboxRouter } = await import('../activitypub/OutboxHandler.js')

function app() {
  const a = express()
  a.use('/', outboxRouter)
  a.use('/', invitePageRouter)
  return a
}
const get = (path: string, ua = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)') =>
  supertest(app()).get(path).set('User-Agent', ua)

beforeEach(() => {
  cache.flush()
  rpc.mockClear()
  for (const key of Object.keys(answers)) delete answers[key]
  answers.ABCD1234 = { data: VALID, error: null }
})

describe('GET /invite/:code', () => {
  it('serves the server card of a valid invite', async () => {
    const res = await get('/invite/ABCD1234')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('public, max-age=300')
    expect(res.headers.vary).toMatch(/User-Agent/)
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow')
    expect(res.headers['content-security-policy']).toMatch(/^default-src 'none';/)
    expect(res.headers['content-security-policy']).not.toMatch(/script-src/)
    expect(res.text).toContain('<meta property="og:title" content="Secret Lounge">')
    expect(res.text).toContain('<meta property="og:description" content="1,234 members · 56 online — Hang out.">')
    expect(res.text).not.toMatch(/<script\b/i)
    expect(rpc.mock.calls).toEqual([['get_invite_preview', { p_code: 'ABCD1234' }]])
  })

  it('accepts a trailing slash', async () => {
    const res = await get('/invite/ABCD1234/')
    expect(res.text).toContain('content="Secret Lounge"')
  })

  it('memoises the lookup', async () => {
    await get('/invite/ABCD1234')
    await get('/invite/ABCD1234')
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('advertises oEmbed to Discordbot only', async () => {
    expect((await get('/invite/ABCD1234')).text).toContain('application/json+oembed')
    const mastodon = await get('/invite/ABCD1234', 'http.rb/5.1.1 (Mastodon/4.3.0; +https://social.test/)')
    expect(mastodon.text).toContain('content="Secret Lounge"')
    expect(mastodon.text).not.toContain('json+oembed')
  })

  it.each(['not_found', 'exhausted', 'revoked', 'expired'])('answers a %s invite without the server', async (status) => {
    answers.DEADCODE = { data: { ...VALID, status }, error: null }
    const res = await get('/invite/DEADCODE')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=60')
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow')
    expect(res.text).toContain('<meta property="og:title" content="Invite invalid or expired">')
    expect(res.text).not.toContain('Secret Lounge')
    expect(res.text).not.toContain('Hang out')
    expect(res.text).not.toContain('s1/icon.png')
    expect(res.text).not.toContain('1,234')
  })

  it.each(['ab', 'a.b.c', 'x'.repeat(65), 'AB%20CD', 'AB%2FCD'])('does not look up the malformed code %s', async (code) => {
    const res = await get(`/invite/${code}`)
    expect(res.status).toBe(200)
    expect(res.text).toContain('Invite invalid or expired')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('answers 503 without caching when the lookup fails', async () => {
    answers.ABCD1234 = { data: null, error: { message: 'connection refused' } }
    const res = await get('/invite/ABCD1234')
    expect(res.status).toBe(503)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['retry-after']).toBe('30')
    expect(res.text).toContain('<meta property="og:title" content="Server invite">')
    expect(res.text).not.toContain('Invite invalid')

    answers.ABCD1234 = { data: VALID, error: null }
    expect((await get('/invite/ABCD1234')).status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('answers 503 when the lookup throws', async () => {
    answers.ABCD1234 = new Error('fetch failed')
    expect((await get('/invite/ABCD1234')).status).toBe(503)
  })

  it('answers HEAD', async () => {
    const res = await supertest(app()).head('/invite/ABCD1234')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
  })
})

describe('GET /oembed for an invite', () => {
  const oembed = (url: string) => supertest(app()).get('/oembed').query({ url, format: 'json' })

  it('describes a valid invite', async () => {
    const res = await oembed('https://harmony.test/invite/ABCD1234')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/json\+oembed/)
    expect(res.body).toMatchObject({
      type: 'link',
      title: 'Secret Lounge',
      author_name: "You've been invited to join a server",
      author_url: 'https://harmony.test/invite/ABCD1234',
      provider_name: 'Harmony',
      provider_url: 'https://harmony.test',
    })
  })

  it('answers 404 for an invalid invite', async () => {
    answers.DEADCODE = { data: { status: 'revoked' }, error: null }
    const res = await oembed('https://harmony.test/invite/DEADCODE')
    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('Secret')
  })

  it('answers 503 when the lookup fails', async () => {
    answers.ABCD1234 = { data: null, error: { message: 'down' } }
    expect((await oembed('https://harmony.test/invite/ABCD1234')).status).toBe(503)
  })

  it('ignores an invite path on another host', async () => {
    const res = await oembed('https://other.test/invite/ABCD1234')
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })
})
