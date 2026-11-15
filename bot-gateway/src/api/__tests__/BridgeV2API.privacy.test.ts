import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const OTHER_BOT = '00000000-0000-0000-0000-0000000000b9'
const BRIDGE_ID = '00000000-0000-0000-0000-0000000000f0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const TOKEN = 'harmony_bot_bridge'
const DANA = '400000000000000001'
const EVE = '400000000000000002'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  config: {
    supabaseUrl: 'http://localhost:54321',
    port: 3002,
    nodeEnv: 'test',
    instanceDomain: 'localhost:3000',
    trustProxy: 'loopback' as string | boolean | number,
    websocket: { heartbeatInterval: 30_000, maxConnectionsPerBot: 5, revalidateIntervalMs: 30_000 },
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
    bridge: { instanceDomain: 'harmony.test', publicUrl: '', hostSecret: '', configPollMs: 5_000 },
  },
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: mocks.config,
}))

import { BridgeV2API } from '../BridgeV2API.js'
import { ERASE_COOLDOWN_MS, resetEraseCooldown } from '../../bridge/bridgePrivacy.js'

type RpcResult = { data: unknown; error: { code?: string; message: string } | null }
let rpcHandlers: Record<string, (args: any) => RpcResult | Promise<RpcResult>>
let botId = BOT_ID
// instance: the public instance bot; privacy routes serve every mode.
let mode = 'instance'

function makeApp() {
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.json())
  app.use('/bridge/v2', new BridgeV2API().router)
  return app
}

const auth = { Authorization: `Bot ${TOKEN}` }
const rpcCalls = (fn: string) => mocks.rpc.mock.calls.filter(([name]) => name === fn).map(([, args]) => args)
const scope = { p_server_id: SERVER_ID, p_platform: 'discord' }

beforeEach(() => {
  botId = BOT_ID
  mode = 'instance'
  resetEraseCooldown()
  mocks.from.mockImplementation((table: string) => new FakeDb({
    discord_bridges: [
      { id: BRIDGE_ID, server_id: SERVER_ID, bot_id: BOT_ID, mode, discord_guild_id: '100000000000000001', settings: {}, updated_at: '2026-10-07T10:00:00.000Z' },
    ],
  }).from(table))
  rpcHandlers = {
    verify_bot_token: () => ({ data: { valid: true, bot_id: botId, username: 'bridge', scopes: ['bot'] }, error: null }),
    check_and_increment_bot_rate_limit: () => ({ data: false, error: null }),
  }
  mocks.rpc.mockReset()
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    const handler = rpcHandlers[fn]
    if (!handler) throw new Error(`test called unmocked rpc: ${fn}`)
    return handler(args)
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Bridge v2 privacy endpoints', () => {
  it('refuses a bot that is not a bridge', async () => {
    botId = OTHER_BOT
    const res = await supertest(makeApp()).get('/bridge/v2/privacy/optouts').set(auth)
    expect(res.status).toBe(403)
  })

  it('GET /optouts lists the opted-out Discord ids of the bridge\'s server with their version', async () => {
    rpcHandlers.bridge_privacy_optout_ids = () => ({ data: { version: '2:1762900000000', remote_user_ids: [DANA, EVE] }, error: null })
    const res = await supertest(makeApp()).get('/bridge/v2/privacy/optouts').set(auth)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ version: '2:1762900000000', remote_user_ids: [DANA, EVE] })
    expect(rpcCalls('bridge_privacy_optout_ids')).toEqual([scope])
  })

  it('GET /optouts/:id answers the status of one user', async () => {
    rpcHandlers.bridge_privacy_status = () => ({ data: { opted_out: true, since: '2026-11-12T00:00:00Z', source: 'self' }, error: null })
    const res = await supertest(makeApp()).get(`/bridge/v2/privacy/optouts/${DANA}`).set(auth)
    expect(res.body).toEqual({ opted_out: true, since: '2026-11-12T00:00:00Z', source: 'self' })
    expect(rpcCalls('bridge_privacy_status')).toEqual([{ ...scope, p_remote_user_id: DANA }])
  })

  it('PUT opts a user out and DELETE opts them in', async () => {
    rpcHandlers.bridge_privacy_set_optout = ({ p_opted_out }) => ({
      data: { opted_out: p_opted_out, since: p_opted_out ? '2026-11-12T00:00:00Z' : null, source: p_opted_out ? 'self' : null },
      error: null,
    })
    const out = await supertest(makeApp()).put(`/bridge/v2/privacy/optouts/${DANA}`).set(auth).send({ username: 'dana' })
    expect(out.status).toBe(200)
    expect(out.body.opted_out).toBe(true)
    const back = await supertest(makeApp()).delete(`/bridge/v2/privacy/optouts/${DANA}`).set(auth)
    expect(back.body.opted_out).toBe(false)
    expect(rpcCalls('bridge_privacy_set_optout')).toEqual([
      { ...scope, p_remote_user_id: DANA, p_opted_out: true },
      { ...scope, p_remote_user_id: DANA, p_opted_out: false },
    ])
  })

  it('refuses an id that is not a Discord id with 400 and calls nothing', async () => {
    const app = makeApp()
    for (const call of [
      supertest(app).get('/bridge/v2/privacy/optouts/dana'),
      supertest(app).put('/bridge/v2/privacy/optouts/dana'),
      supertest(app).delete(`/bridge/v2/privacy/optouts/${'9'.repeat(21)}`),
      supertest(app).post('/bridge/v2/privacy/erase').send({ remote_user_id: 'dana' }),
      supertest(app).post('/bridge/v2/privacy/erase').send({}),
    ]) {
      const res = await call.set(auth)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ code: 'invalid_remote_user' })
    }
    expect(mocks.rpc.mock.calls.filter(([n]) => String(n).startsWith('bridge_privacy_'))).toEqual([])
  })

  it('answers 500 without the database message when a function fails', async () => {
    rpcHandlers.bridge_privacy_status = () => ({ data: null, error: { code: 'XX000', message: 'relation "secret" does not exist' } })
    const res = await supertest(makeApp()).get(`/bridge/v2/privacy/optouts/${DANA}`).set(auth)
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('secret')
  })

  describe('POST /erase', () => {
    const erase = (id = DANA) => supertest(makeApp()).post('/bridge/v2/privacy/erase').set(auth).send({ remote_user_id: id })

    it('erases one batch and answers 202 with the count', async () => {
      rpcHandlers.bridge_privacy_erase = () => ({ data: { opted_out: true, erased: 3, more: false }, error: null })
      const res = await erase()
      expect(res.status).toBe(202)
      expect(res.body).toEqual({ opted_out: true, erased: 3, more: false })
      expect(rpcCalls('bridge_privacy_erase')).toEqual([{ ...scope, p_remote_user_id: DANA, p_limit: 200 }])
    })

    // The first batch answers the request (bridge_privacy_erase); the rest run in the background
    // through bridge_privacy_erase_tail, which stops once the user opted in again.
    const both = (answer: () => unknown) => {
      rpcHandlers.bridge_privacy_erase = answer as any
      rpcHandlers.bridge_privacy_erase_tail = answer as any
    }
    const batches = () => rpcCalls('bridge_privacy_erase').length + rpcCalls('bridge_privacy_erase_tail').length

    it('finishes in the background while more is left', async () => {
      const answers = [
        { opted_out: true, erased: 200, more: true },
        { opted_out: true, erased: 200, more: true },
        { opted_out: true, erased: 7, more: false },
      ]
      both(() => ({ data: answers.shift() ?? { erased: 0, more: false }, error: null }))
      const res = await erase()
      expect(res.body).toEqual({ opted_out: true, erased: 200, more: true })
      await vi.waitFor(() => expect(batches()).toBe(3), { timeout: 2_000 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(rpcCalls('bridge_privacy_erase')).toHaveLength(1)
      expect(rpcCalls('bridge_privacy_erase_tail')).toHaveLength(2)
    })

    it('stops when the user opted in meanwhile', async () => {
      rpcHandlers.bridge_privacy_erase = () => ({ data: { opted_out: true, erased: 200, more: true }, error: null })
      rpcHandlers.bridge_privacy_erase_tail = () => ({ data: { opted_out: false, erased: 0, more: false }, error: null })
      await erase()
      await vi.waitFor(() => expect(rpcCalls('bridge_privacy_erase_tail')).toHaveLength(1), { timeout: 2_000 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(rpcCalls('bridge_privacy_erase_tail')).toHaveLength(1)
    })

    it('tries a failed background batch again and goes on', async () => {
      const answers: Array<() => unknown> = [
        () => ({ data: { opted_out: true, erased: 200, more: true }, error: null }),
        () => ({ data: null, error: { code: '55P03', message: 'canceling statement due to lock timeout' } }),
        () => ({ data: { opted_out: true, erased: 9, more: false }, error: null }),
      ]
      both(() => (answers.shift() ?? (() => ({ data: { erased: 0, more: false }, error: null })))())
      const res = await erase()
      expect(res.body).toEqual({ opted_out: true, erased: 200, more: true })
      await vi.waitFor(() => expect(batches()).toBe(3), { timeout: 3_000 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(batches()).toBe(3)
    })

    it('finishes the erases the database lists as unfinished, one loop per user', async () => {
      const { resumePendingErases } = await import('../../bridge/bridgePrivacy.js')
      rpcHandlers.bridge_privacy_pending = () => ({
        data: [
          { server_id: SERVER_ID, platform: 'discord', remote_user_id: DANA },
          { server_id: SERVER_ID, platform: 'discord', remote_user_id: DANA },
        ],
        error: null,
      })
      rpcHandlers.bridge_privacy_erase_tail = () => ({ data: { opted_out: true, erased: 3, more: false }, error: null })
      expect(await resumePendingErases()).toBe(1)
      await vi.waitFor(() => expect(rpcCalls('bridge_privacy_erase_tail')).toHaveLength(1), { timeout: 2_000 })
      expect(rpcCalls('bridge_privacy_erase_tail')[0]).toMatchObject({ p_server_id: SERVER_ID, p_remote_user_id: DANA })
    })

    it('resumes one user at a time, and one pass at a time', async () => {
      const { resumePendingErases } = await import('../../bridge/bridgePrivacy.js')
      rpcHandlers.bridge_privacy_pending = () => ({
        data: [
          { server_id: SERVER_ID, platform: 'discord', remote_user_id: DANA },
          { server_id: SERVER_ID, platform: 'discord', remote_user_id: EVE },
        ],
        error: null,
      })
      let inFlight = 0
      let most = 0
      rpcHandlers.bridge_privacy_erase_tail = async () => {
        inFlight++
        most = Math.max(most, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 20))
        inFlight--
        return { data: { opted_out: true, erased: 1, more: false }, error: null }
      }
      const first = resumePendingErases()
      expect(await resumePendingErases()).toBe(0)
      expect(await first).toBe(2)
      expect(most).toBe(1)
      expect(rpcCalls('bridge_privacy_erase_tail').map((a: any) => a.p_remote_user_id)).toEqual([DANA, EVE])
    })

    it('answers 429 erase_recent for the same user inside the cooldown, and serves another user', async () => {
      rpcHandlers.bridge_privacy_erase = () => ({ data: { opted_out: true, erased: 0, more: false }, error: null })
      expect((await erase()).status).toBe(202)
      const again = await erase()
      expect(again.status).toBe(429)
      expect(again.body.code).toBe('erase_recent')
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(0)
      expect(Number(again.headers['retry-after'])).toBeLessThanOrEqual(ERASE_COOLDOWN_MS / 1000)
      expect((await erase(EVE)).status).toBe(202)
      expect(rpcCalls('bridge_privacy_erase').map((c) => c.p_remote_user_id)).toEqual([DANA, EVE])
    })

    it('a failed erase does not start the cooldown', async () => {
      rpcHandlers.bridge_privacy_erase = () => ({ data: null, error: { code: 'XX000', message: 'boom' } })
      expect((await erase()).status).toBe(500)
      rpcHandlers.bridge_privacy_erase = () => ({ data: { opted_out: true, erased: 1, more: false }, error: null })
      expect((await erase()).status).toBe(202)
    })
  })
})
