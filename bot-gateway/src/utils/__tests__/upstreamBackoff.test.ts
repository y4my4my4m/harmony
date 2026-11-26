import { describe, it, expect, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { UpstreamBackoff, UPSTREAM_BACKOFF_MAX_MS, backoffFetch } from '../upstreamBackoff.js'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

function gate() {
  const c = clock()
  const log = { warn: vi.fn(), log: vi.fn() }
  return { c, log, g: new UpstreamBackoff(c.now, log) }
}

describe('UpstreamBackoff', () => {
  it('lets polls run until the API answers as down', () => {
    const { g } = gate()
    expect(g.ready()).toBe(true)
    g.succeeded()
    expect(g.ready()).toBe(true)
  })

  it('pauses 1 s, then doubles per failure up to 60 s', () => {
    const { c, g } = gate()
    const pauses: number[] = []
    for (let i = 0; i < 9; i++) {
      g.failed('HTTP 503')
      pauses.push(g.remainingMs())
      c.advance(g.remainingMs())
      expect(g.ready()).toBe(true)
    }
    expect(pauses).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000])
    expect(UPSTREAM_BACKOFF_MAX_MS).toBe(60_000)
  })

  it('counts the failures of requests caught by a running pause once', () => {
    const { c, g } = gate()
    g.failed('HTTP 503')
    c.advance(10)
    g.failed('HTTP 503')
    g.failed('fetch failed')
    expect(g.remainingMs()).toBe(990)
    c.advance(990)
    g.failed('HTTP 503')
    expect(g.remainingMs()).toBe(2_000)
  })

  it('warns once per outage and says when the API is back', () => {
    const { c, log, g } = gate()
    g.failed('HTTP 503')
    c.advance(1_000)
    g.failed('HTTP 502')
    c.advance(2_000)
    g.failed('HTTP 504')
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][0]).toContain('HTTP 503')
    c.advance(4_000)
    g.succeeded()
    expect(log.log).toHaveBeenCalledWith('API available again after 7 s')
    expect(g.ready()).toBe(true)

    g.failed('HTTP 503')
    expect(g.remainingMs()).toBe(1_000)
    expect(log.warn).toHaveBeenCalledTimes(2)
  })
})

describe('backoffFetch', () => {
  const respond = (status: number) => vi.fn(async () => new Response(status === 204 ? null : '{}', { status }))

  it.each([502, 503, 504])('reads %i as the API down', async (status) => {
    const { g } = gate()
    const res = await backoffFetch(respond(status), g)('http://kong.test/rest/v1/messages')
    expect(res.status).toBe(status)
    expect(g.ready()).toBe(false)
  })

  it.each([200, 204, 400, 401, 404, 409, 500])('reads %i as the API up', async (status) => {
    const { g } = gate()
    g.failed('HTTP 503')
    expect(g.ready()).toBe(false)
    await backoffFetch(respond(status), g)('http://kong.test/rest/v1/messages')
    expect(g.ready()).toBe(true)
  })

  it('reads a request with no answer as the API down and passes the error on', async () => {
    const { g } = gate()
    const inner = vi.fn(async () => { throw new TypeError('fetch failed') })
    await expect(backoffFetch(inner, g)('http://kong.test/rest/v1/messages')).rejects.toThrow('fetch failed')
    expect(g.ready()).toBe(false)
  })

  it('leaves an aborted request out', async () => {
    const { g } = gate()
    const inner = vi.fn(async () => { throw new DOMException('aborted', 'AbortError') })
    await expect(backoffFetch(inner, g)('http://kong.test/rest/v1/messages')).rejects.toThrow('aborted')
    expect(g.ready()).toBe(true)
  })

  it('sees the tables and RPCs of a Supabase client built with it', async () => {
    const { c, g } = gate()
    let status = 503
    const inner = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ message: 'name resolution failed' }), {
      status, headers: { 'content-type': 'application/json' },
    }))
    const client = createClient('http://kong.test', 'service-key', {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: backoffFetch(inner, g) },
    })

    const rpc = await client.rpc('claim_bot_interactions', { p_bot_ids: [], p_limit: 50 })
    expect(rpc.error).not.toBeNull()
    expect(String(inner.mock.calls[0][0])).toBe('http://kong.test/rest/v1/rpc/claim_bot_interactions')
    expect(g.ready()).toBe(false)

    c.advance(1_000)
    status = 200
    await client.from('messages').select('*').limit(1)
    expect(String(inner.mock.calls[1][0])).toContain('http://kong.test/rest/v1/messages?')
    expect(g.ready()).toBe(true)
  })
})
