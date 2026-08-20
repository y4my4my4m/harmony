import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { createHash } from 'crypto'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  config: {
    supabaseUrl: 'http://localhost:54321',
    port: 3002,
    nodeEnv: 'test',
    instanceDomain: 'harmony.test',
    websocket: { heartbeatInterval: 30_000, maxConnectionsPerBot: 5 },
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  },
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc },
  config: mocks.config,
}))

import { botAuthMiddleware, type BotRequest } from '../BotAuthMiddleware.js'

const TOKEN = 'hrm_bot_9f2c1d4e8a7b'
const TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest('hex')
const BOT_ID = '00000000-0000-0000-0000-0000000000b0'

/** PostgREST surfaces a plpgsql failure as a body with the SQLSTATE in `code`. */
const UNDEFINED_COLUMN = {
  code: '42703',
  details: null,
  hint: null,
  message: 'column "is_active" does not exist',
}

const VALID_VERIFICATION = {
  valid: true,
  bot_id: BOT_ID,
  username: 'testbot',
  scopes: ['bot', 'send_messages'],
}

type RpcResult = { data: unknown; error: unknown }

function routeRpc(handlers: Record<string, (args: any) => RpcResult>) {
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    const handler = handlers[fn]
    if (!handler) throw new Error(`test called unmocked rpc: ${fn}`)
    return handler(args)
  })
}

/** Single guarded route; the handler echoes what the middleware attached. */
function makeApp() {
  const app = express()
  app.get('/api/v1/probe', botAuthMiddleware as express.RequestHandler, (req, res) => {
    res.json({ bot: (req as BotRequest).bot })
  })
  return app
}

const allow = () => ({ data: false, error: null })

beforeEach(() => {
  mocks.rpc.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('botAuthMiddleware', () => {
  it('rejects a request with no Authorization header without touching the database', async () => {
    routeRpc({})
    const res = await supertest(makeApp()).get('/api/v1/probe')

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Missing Authorization header')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('rejects a Bearer token: the bot API takes "Bot TOKEN" only', async () => {
    routeRpc({})
    const res = await supertest(makeApp())
      .get('/api/v1/probe')
      .set('Authorization', `Bearer ${TOKEN}`)

    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/Expected: Bot TOKEN/)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('looks the token up by sha256 digest; the raw token never leaves the process', async () => {
    routeRpc({
      verify_bot_token: () => ({ data: VALID_VERIFICATION, error: null }),
      check_and_increment_bot_rate_limit: allow,
    })

    await supertest(makeApp()).get('/api/v1/probe').set('Authorization', `Bot ${TOKEN}`)

    expect(mocks.rpc).toHaveBeenCalledWith('verify_bot_token', { p_token_hash: TOKEN_SHA256 })
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(TOKEN)
  })

  it('attaches bot id, username and scopes on success', async () => {
    routeRpc({
      verify_bot_token: () => ({ data: VALID_VERIFICATION, error: null }),
      check_and_increment_bot_rate_limit: allow,
    })

    const res = await supertest(makeApp())
      .get('/api/v1/probe')
      .set('Authorization', `Bot ${TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.body.bot).toEqual({
      id: BOT_ID,
      username: 'testbot',
      scopes: ['bot', 'send_messages'],
    })
  })

  it('defaults scopes to [] when the token row carries none', async () => {
    routeRpc({
      verify_bot_token: () => ({
        data: { ...VALID_VERIFICATION, scopes: null },
        error: null,
      }),
      check_and_increment_bot_rate_limit: allow,
    })

    const res = await supertest(makeApp())
      .get('/api/v1/probe')
      .set('Authorization', `Bot ${TOKEN}`)

    expect(res.status).toBe(200)
    expect(res.body.bot.scopes).toEqual([])
  })

  it('rejects a token the RPC reports as invalid', async () => {
    routeRpc({
      verify_bot_token: () => ({
        data: { valid: false, error: 'Invalid or expired token' },
        error: null,
      }),
      check_and_increment_bot_rate_limit: allow,
    })

    const res = await supertest(makeApp())
      .get('/api/v1/probe')
      .set('Authorization', `Bot ${TOKEN}`)

    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid or expired token')
  })

  // verify_bot_token reads bot_tokens.is_active and writes bot_tokens.uses_count.
  // Production has both columns; db_schema/init/06_tables_misc.sql and staging have
  // neither, so the RPC raises 42703 on every call against a fresh instance.
  //
  // 401 is a claim about the credential. A lookup that never completed is a claim
  // about the server: 5xx, with the SQLSTATE on the way out.
  it('does not report an RPC failure as an invalid token', async () => {
    routeRpc({
      verify_bot_token: () => ({ data: null, error: UNDEFINED_COLUMN }),
      check_and_increment_bot_rate_limit: allow,
    })

    const res = await supertest(makeApp())
      .get('/api/v1/probe')
      .set('Authorization', `Bot ${TOKEN}`)

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(res.body.error).not.toBe('Invalid or expired token')

    const logged = (console.error as any).mock.calls.flat().map(String).join(' ')
    expect(logged).toContain('42703')
  })

  it('returns 429 when the rate-limit RPC reports the bucket exhausted', async () => {
    routeRpc({
      verify_bot_token: () => ({ data: VALID_VERIFICATION, error: null }),
      check_and_increment_bot_rate_limit: () => ({ data: true, error: null }),
    })

    const res = await supertest(makeApp())
      .get('/api/v1/probe')
      .set('Authorization', `Bot ${TOKEN}`)

    expect(res.status).toBe(429)
    expect(res.body.retry_after).toBe(60)
  })

  it('keys the rate limit on the request path and passes the configured window in seconds', async () => {
    routeRpc({
      verify_bot_token: () => ({ data: VALID_VERIFICATION, error: null }),
      check_and_increment_bot_rate_limit: allow,
    })

    await supertest(makeApp()).get('/api/v1/probe').set('Authorization', `Bot ${TOKEN}`)

    expect(mocks.rpc).toHaveBeenCalledWith('check_and_increment_bot_rate_limit', {
      p_bot_id: BOT_ID,
      p_bucket: '/api/v1/probe',
      p_limit: 100,
      p_window_seconds: 60,
    })
  })

  // Deliberate: a database hiccup must not take the bot API offline.
  it('lets the request through when the rate-limit RPC fails', async () => {
    routeRpc({
      verify_bot_token: () => ({ data: VALID_VERIFICATION, error: null }),
      check_and_increment_bot_rate_limit: () => ({
        data: null,
        error: { code: '42P01', message: 'relation "bot_rate_limits" does not exist' },
      }),
    })

    const res = await supertest(makeApp())
      .get('/api/v1/probe')
      .set('Authorization', `Bot ${TOKEN}`)

    expect(res.status).toBe(200)
  })
})
