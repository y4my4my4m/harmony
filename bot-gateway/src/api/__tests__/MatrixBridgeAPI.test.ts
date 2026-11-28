import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { createHash } from 'crypto'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const CUSTOM_BOT = '00000000-0000-0000-0000-0000000000b9'
const BRIDGE_ID = '00000000-0000-0000-0000-0000000000f0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const OTHER_SERVER = '00000000-0000-0000-0000-00000000005b'
const GENERAL = '00000000-0000-0000-0000-0000000000c1'
const ELSEWHERE = '00000000-0000-0000-0000-0000000000c9'
const TOKEN = 'harmony_bot_matrix'
const CUSTOM_TOKEN = 'harmony_bot_custom'
const SAM = '@sam:example.org'
const EVE = '@eve/with=slash:example.org'
const HOST_SECRET = 'm'.repeat(40)
const DISCORD_HOST_SECRET = 'd'.repeat(40)

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
    bridge: { instanceDomain: 'harmony.test', publicUrl: '', hostSecret: '', matrixHostSecret: '', configPollMs: 5_000 },
  },
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: mocks.config,
}))

import { MatrixBridgeAPI } from '../MatrixBridgeAPI.js'
import { BridgeV2API, type HostLimitOptions, type RedeemLimitOptions } from '../BridgeV2API.js'
import { forgetBridgeHosts } from '../../bridge/bridgeHosts.js'
import { resetEraseCooldown, resumePendingErases } from '../../bridge/bridgePrivacy.js'
import { forgetBridgeConsent } from '../../bridge/memberConsent.js'

type RpcResult = { data: unknown; error: { code?: string; message: string } | null }
let db: FakeDb
let rpcHandlers: Record<string, (args: any) => RpcResult | Promise<RpcResult>>

const sha = (token: string) => createHash('sha256').update(token).digest('hex')
const bots: Record<string, string> = { [sha(TOKEN)]: BOT_ID, [sha(CUSTOM_TOKEN)]: CUSTOM_BOT }

const installsChanged = vi.fn(async (_channelId: string) => {})

function makeApp(options: RedeemLimitOptions & HostLimitOptions = {}) {
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.json({ limit: '10mb' }))
  // Mounted as index.ts does.
  app.use('/bridge/v2/matrix', new MatrixBridgeAPI(options, { installsChanged }).router)
  app.use('/bridge/v2', new BridgeV2API(options).router)
  return app
}

const auth = { Authorization: `Bot ${TOKEN}` }
const customAuth = { Authorization: `Bot ${CUSTOM_TOKEN}` }
const rpcCalls = (fn: string) => mocks.rpc.mock.calls.filter(([name]) => name === fn).map(([, args]) => args)

beforeEach(() => {
  installsChanged.mockClear()
  resetEraseCooldown()
  forgetBridgeConsent()
  forgetBridgeHosts()
  db = new FakeDb({
    matrix_bridges: [{ id: BRIDGE_ID, server_id: SERVER_ID, bot_id: BOT_ID, updated_at: '2026-11-25T10:00:00.000Z' }],
    discord_bridges: [],
    channels: [{ id: GENERAL, server_id: SERVER_ID }, { id: ELSEWHERE, server_id: OTHER_SERVER }],
  })
  mocks.from.mockImplementation((table: string) => db.from(table))
  mocks.config.bridge = {
    instanceDomain: 'harmony.test', publicUrl: '', hostSecret: DISCORD_HOST_SECRET, matrixHostSecret: HOST_SECRET, configPollMs: 5_000,
  }
  rpcHandlers = {
    verify_bot_token: ({ p_token_hash }) => bots[p_token_hash]
      ? { data: { valid: true, bot_id: bots[p_token_hash], username: 'bridge', scopes: ['bot'] }, error: null }
      : { data: { valid: false }, error: null },
    check_and_increment_bot_rate_limit: () => ({ data: 0, error: null }),
    bridge_channel_platform: ({ p_bot_id, p_channel_id }) =>
      ({ data: p_bot_id === CUSTOM_BOT && p_channel_id === ELSEWHERE ? 'matrix' : null, error: null }),
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
  vi.restoreAllMocks()
})

describe('POST /bridge/v2/matrix/redeem', () => {
  const REDEEMED = { bridge_id: BRIDGE_ID, server_id: SERVER_ID, harmony_token: 'harmony_bot_new' }
  const redeem = (code: unknown, app = makeApp()) => supertest(app).post('/bridge/v2/matrix/redeem').send({ code })

  it('trades a code for the bot token and the instance URLs', async () => {
    rpcHandlers.matrix_bridge_redeem_code = () => ({ data: { ...REDEEMED, secret: 'x' }, error: null })
    const res = await redeem(' mx-abcd-efgh-jk23 ')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({
      ...REDEEMED,
      base_url: 'https://harmony.test',
      api_url: 'https://harmony.test/bot-gateway',
      gateway_url: 'wss://harmony.test/bot-gateway/gateway',
    })
    expect(rpcCalls('matrix_bridge_redeem_code')).toEqual([{ p_code: 'MX-ABCD-EFGH-JK23' }])
  })

  it.each([
    ['without dashes', 'mxabcdefghjk23'],
    ['without the prefix', 'abcd-efgh-jk23'],
    ['with typographic dashes', 'MX\u2013ABCD\u2014EFGH\u2212JK23'],
  ])('hashes a code typed %s in its canonical form', async (_how, typed) => {
    rpcHandlers.matrix_bridge_redeem_code = () => ({ data: REDEEMED, error: null })
    expect((await redeem(typed)).status).toBe(200)
    expect(rpcCalls('matrix_bridge_redeem_code')).toEqual([{ p_code: 'MX-ABCD-EFGH-JK23' }])
  })

  it('answers every failure alike, and a malformed code without touching the database', async () => {
    rpcHandlers.matrix_bridge_redeem_code = () => ({ data: null, error: null })
    const app = makeApp({ redeemLimit: 100 })
    const refused = await redeem('MX-AAAA-BBBB-CCCC', app)
    expect(refused.status).toBe(400)
    expect(refused.body).toEqual({ error: 'Invalid or expired setup code', code: 'invalid_code' })
    for (const code of ['MX-ABCD-EFGH-JK2', 'MX_ABCD_EFGH_JK23', 'nope', 42, null, { a: 1 }]) {
      const res = await redeem(code, app)
      expect([res.status, res.body]).toEqual([refused.status, refused.body])
    }
    expect(rpcCalls('matrix_bridge_redeem_code')).toHaveLength(1)
  })

  it('a code of one platform reaches no function at the other\'s route', async () => {
    const app = makeApp({ redeemLimit: 100 })
    expect((await redeem('HB-ABCD-EFGH-JK23', app)).status).toBe(400)
    expect((await supertest(app).post('/bridge/v2/redeem').send({ code: 'MX-ABCD-EFGH-JK23' })).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('answers 500 when the database fails, and says nothing of it', async () => {
    rpcHandlers.matrix_bridge_redeem_code = () => ({ data: null, error: { code: 'XX000', message: 'secret detail' } })
    const res = await redeem('MX-ABCD-EFGH-JK23')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Redeem failed' })
  })

  it('allows 10 attempts per client in 15 minutes', async () => {
    rpcHandlers.matrix_bridge_redeem_code = () => ({ data: null, error: null })
    const app = makeApp()
    for (let i = 0; i < 10; i++) expect((await redeem('MX-AAAA-BBBB-CCCC', app)).status).toBe(400)
    const limited = await redeem('MX-AAAA-BBBB-CCCC', app)
    expect(limited.status).toBe(429)
    expect(limited.body.code).toBe('rate_limited')
  })
})

describe('managed bridge bot authentication', () => {
  it.each([['get', '/config'], ['post', '/status']] as const)('%s %s needs the bot of a managed bridge', async (method, path) => {
    const call = () => supertest(makeApp())[method]('/bridge/v2/matrix' + path)
    expect((await call()).status).toBe(401)
    expect((await call().set('Authorization', 'Bot wrong')).status).toBe(401)
    expect((await call().set(customAuth)).status).toBe(403)
    db.failures.matrix_bridges = { message: 'connection reset' }
    expect((await call().set(auth)).status).toBe(503)
  })

  it('counts requests toward the bot\'s rate limit', async () => {
    rpcHandlers.check_and_increment_bot_rate_limit = () => ({ data: 7, error: null })
    const res = await supertest(makeApp()).get('/bridge/v2/matrix/config').set(auth)
    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBe('7')
    expect(rpcCalls('check_and_increment_bot_rate_limit')[0]).toMatchObject({ p_bot_id: BOT_ID, p_bucket: '/bridge/v2/matrix/config' })
  })

  it('does not open the Discord routes to a Matrix bridge', async () => {
    const res = await supertest(makeApp()).get('/bridge/v2/config').set(auth)
    expect(res.status).toBe(403)
  })
})

describe('GET /bridge/v2/matrix/config', () => {
  const CONFIG = {
    bridge_id: BRIDGE_ID, server_id: SERVER_ID, mode: 'self', updated_at: '2026-11-25T10:00:00+00:00', privacy_version: '1:1762900000000',
    pairs: [{ channel_id: GENERAL, channel_name: 'general', room_id: null, room_alias: '#general:example.org', direction: 'both', sender_mode: 'ghost', encrypted: false }],
  }

  it('answers matrix_bridge_config with the instance URL', async () => {
    rpcHandlers.matrix_bridge_config = () => ({ data: CONFIG, error: null })
    const res = await supertest(makeApp()).get('/bridge/v2/matrix/config').set(auth)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ...CONFIG, base_url: 'https://harmony.test' })
    expect(rpcCalls('matrix_bridge_config')).toEqual([{ p_bot_id: BOT_ID }])
  })

  it('answers 503 when it cannot be read, or the bridge is gone meanwhile', async () => {
    for (const answer of [{ data: null, error: { code: '57014', message: 'timeout' } }, { data: null, error: null }]) {
      rpcHandlers.matrix_bridge_config = () => answer
      expect((await supertest(makeApp()).get('/bridge/v2/matrix/config').set(auth)).status).toBe(503)
    }
  })
})

describe('POST /bridge/v2/matrix/status', () => {
  const post = (body: unknown) => supertest(makeApp()).post('/bridge/v2/matrix/status').set(auth).send(body as object)

  it('stores the report in its parts', async () => {
    rpcHandlers.matrix_bridge_report_status = () => ({ data: { ok: true }, error: null })
    const res = await post({
      version: '0.2.0', connection: 'application_service', ready: true, user_id: '@harmony:example.org',
      homeserver: 'https://matrix.example.org', server_name: 'example.org', pending: 3, failed: 0,
      rooms: [{ room_id: '!a:example.org', name: 'A', alias: '#a:example.org', encrypted: false, can_send: true, members: 4, invited: true }],
      pairs: [{ channel_id: GENERAL, state: 'ready', error: null }],
      problems: [{ code: 'room_not_joined', detail: 'M_FORBIDDEN' }],
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(rpcCalls('matrix_bridge_report_status')).toEqual([{
      p_bot_id: BOT_ID,
      p_connection: 'application_service',
      p_status: {
        ready: true, user_id: '@harmony:example.org', homeserver: 'https://matrix.example.org', server_name: 'example.org',
        pending: 3, failed: 0, problems: [{ code: 'room_not_joined', detail: 'M_FORBIDDEN' }],
      },
      p_snapshot: { rooms: [{ room_id: '!a:example.org', name: 'A', alias: '#a:example.org', encrypted: false, can_send: true, invited: true, members: 4 }] },
      p_version: '0.2.0',
      p_pairs: [{ channel_id: GENERAL, state: 'ready', error: null }],
    }])
  })

  it('answers 400 to a body that is no object and to one the database refuses, 403 once the bridge is gone', async () => {
    rpcHandlers.matrix_bridge_report_status = () => ({ data: null, error: { code: '22023', message: 'status report too large' } })
    expect((await post([])).status).toBe(400)
    expect(rpcCalls('matrix_bridge_report_status')).toHaveLength(0)
    expect((await post({})).status).toBe(400)
    rpcHandlers.matrix_bridge_report_status = () => ({ data: null, error: null })
    expect((await post({})).status).toBe(403)
    rpcHandlers.matrix_bridge_report_status = () => ({ data: null, error: { code: 'XX000', message: 'boom' } })
    expect((await post({})).status).toBe(500)
  })
})

describe('Matrix privacy', () => {
  const base = '/bridge/v2/matrix/privacy'
  const scope = { p_server_id: SERVER_ID, p_platform: 'matrix' }
  const mxid = (id: string) => encodeURIComponent(id)

  it('lists the opted-out MXIDs of the bridge\'s server', async () => {
    rpcHandlers.bridge_privacy_optout_ids = () => ({ data: { version: '1:17', remote_user_ids: [SAM] }, error: null })
    const res = await supertest(makeApp()).get(`${base}/optouts`).set(auth)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ version: '1:17', remote_user_ids: [SAM] })
    expect(rpcCalls('bridge_privacy_optout_ids')).toEqual([scope])
  })

  it('reads, sets and clears one opt-out; an MXID may hold a slash', async () => {
    rpcHandlers.bridge_privacy_status = () => ({ data: { opted_out: false, since: null, source: null }, error: null })
    rpcHandlers.bridge_privacy_set_optout = ({ p_opted_out }) => ({ data: { opted_out: p_opted_out, since: null, source: 'self' }, error: null })
    const app = makeApp()
    expect((await supertest(app).get(`${base}/optouts/${mxid(EVE)}`).set(auth)).body.opted_out).toBe(false)
    expect((await supertest(app).put(`${base}/optouts/${mxid(SAM)}`).set(auth)).body.opted_out).toBe(true)
    expect((await supertest(app).delete(`${base}/optouts/${mxid(SAM)}`).set(auth)).body.opted_out).toBe(false)
    expect(rpcCalls('bridge_privacy_status')).toEqual([{ ...scope, p_remote_user_id: EVE }])
    expect(rpcCalls('bridge_privacy_set_optout')).toEqual([
      { ...scope, p_remote_user_id: SAM, p_opted_out: true },
      { ...scope, p_remote_user_id: SAM, p_opted_out: false },
    ])
  })

  it('refuses an id that is no MXID and calls nothing', async () => {
    const app = makeApp()
    for (const id of ['sam', '400000000000000001', '@sam', '@sam:', '@s am:example.org', '@sam:exa\u0001mple.org', '@' + 'a'.repeat(250) + ':b.org']) {
      const res = await supertest(app).put(`${base}/optouts/${mxid(id)}`).set(auth)
      expect([id, res.status, res.body]).toEqual([id, 400, { code: 'invalid_remote_user' }])
    }
    for (const body of [{}, { user_id: 'sam' }, { user_id: 7 }, { remote_user_id: SAM }, { user_id: '@sam:\ud800' }]) {
      expect((await supertest(app).post(`${base}/erase`).set(auth).send(body)).status).toBe(400)
    }
    expect(mocks.rpc.mock.calls.filter(([fn]) => String(fn).startsWith('bridge_privacy'))).toEqual([])
  })

  it('erases one person a minute, in the background past the first batch', async () => {
    rpcHandlers.bridge_privacy_erase = () => ({ data: { opted_out: true, erased: 200, more: true }, error: null })
    rpcHandlers.bridge_privacy_erase_tail = () => ({ data: { opted_out: true, erased: 4, more: false }, error: null })
    const app = makeApp()
    const erase = (id: string) => supertest(app).post(`${base}/erase`).set(auth).send({ user_id: id })
    const first = await erase(SAM)
    expect(first.status).toBe(202)
    expect(first.body).toEqual({ opted_out: true, erased: 200, more: true })
    const again = await erase(SAM)
    expect(again.status).toBe(429)
    expect(again.body.code).toBe('erase_recent')
    expect((await erase(EVE)).status).toBe(202)
    await vi.waitFor(() => expect(rpcCalls('bridge_privacy_erase_tail')).toHaveLength(2), { timeout: 2_000 })
    expect(rpcCalls('bridge_privacy_erase')[0]).toEqual({ ...scope, p_remote_user_id: SAM, p_limit: 200 })
    expect(rpcCalls('bridge_privacy_erase_tail').every((args: any) => args.p_platform === 'matrix')).toBe(true)
  })

  it('resumes the unfinished erases of both platforms at start, each under its own', async () => {
    rpcHandlers.bridge_privacy_pending = () => ({
      data: [
        { server_id: SERVER_ID, platform: 'matrix', remote_user_id: SAM },
        { server_id: SERVER_ID, platform: 'discord', remote_user_id: '400000000000000001' },
        { server_id: SERVER_ID, platform: 'irc', remote_user_id: 'sam' },
      ],
      error: null,
    })
    rpcHandlers.bridge_privacy_erase_tail = () => ({ data: { opted_out: true, erased: 1, more: false }, error: null })
    expect(await resumePendingErases()).toBe(2)
    expect(rpcCalls('bridge_privacy_erase_tail').map((a: any) => [a.p_platform, a.p_remote_user_id])).toEqual([
      ['matrix', SAM], ['discord', '400000000000000001'],
    ])
  })

  describe('of a custom bot', () => {
    it('is about the server of the channel it names and relays', async () => {
      rpcHandlers.bridge_privacy_set_optout = () => ({ data: { opted_out: true, since: null, source: 'self' }, error: null })
      rpcHandlers.bridge_privacy_erase = () => ({ data: { opted_out: true, erased: 0, more: false }, error: null })
      const app = makeApp()
      expect((await supertest(app).put(`${base}/optouts/${mxid(SAM)}`).query({ channel_id: ELSEWHERE }).set(customAuth)).status).toBe(200)
      expect((await supertest(app).post(`${base}/erase`).query({ channel_id: ELSEWHERE }).set(customAuth).send({ user_id: SAM })).status).toBe(202)
      expect(rpcCalls('bridge_privacy_set_optout')[0]).toMatchObject({ p_server_id: OTHER_SERVER, p_platform: 'matrix' })
      expect(rpcCalls('bridge_privacy_erase')[0]).toMatchObject({ p_server_id: OTHER_SERVER, p_platform: 'matrix' })
    })

    it('needs a channel, one it relays to Matrix, and a readable registration', async () => {
      const app = makeApp()
      const list = (query: object, headers = customAuth) => supertest(app).get(`${base}/optouts`).query(query).set(headers)
      expect((await list({})).body.code).toBe('channel_required')
      expect((await list({ channel_id: 'general' })).status).toBe(400)
      expect((await list({ channel_id: GENERAL })).status).toBe(403)
      forgetBridgeConsent()
      rpcHandlers.bridge_channel_platform = () => ({ data: 'discord', error: null })
      expect((await list({ channel_id: ELSEWHERE })).status).toBe(403)
      forgetBridgeConsent()
      rpcHandlers.bridge_channel_platform = () => ({ data: null, error: { message: 'offline' } })
      expect((await list({ channel_id: ELSEWHERE })).status).toBe(503)
      db.failures.matrix_bridges = { message: 'connection reset' }
      expect((await list({ channel_id: ELSEWHERE })).status).toBe(503)
      expect(rpcCalls('bridge_privacy_optout_ids')).toEqual([])
    })

    it('a managed bridge\'s channel_id names no other server', async () => {
      rpcHandlers.bridge_privacy_optout_ids = () => ({ data: { version: '0:0', remote_user_ids: [] }, error: null })
      expect((await supertest(makeApp()).get(`${base}/optouts`).query({ channel_id: ELSEWHERE }).set(auth)).status).toBe(200)
      expect(rpcCalls('bridge_privacy_optout_ids')).toEqual([scope])
    })
  })
})

describe('the Matrix bridge host', () => {
  const base = '/bridge/v2/matrix/host'
  const HOSTED = [{ bridge_id: BRIDGE_ID, harmony_token: 'harmony_bot_h', homeserver_url: 'https://hs.test', access_token: 'syt_community' }]
  const INSTANCE = {
    connection: 'application_service', homeserver_url: 'http://synapse:8008', server_name: 'example.org', sender_localpart: 'harmony_relay',
    as_token: 'as', hs_token: 'hs', access_token: null, bridges: [{ bridge_id: BRIDGE_ID, harmony_token: 'harmony_bot_i' }],
  }
  const routes = [['get', ''], ['post', '/status'], ['post', '/link']] as const
  const call = (method: 'get' | 'post', path: string, secret?: string, app = makeApp()) => {
    const request = supertest(app)[method](base + path).set('X-Forwarded-For', '203.0.113.9')
    return secret === undefined ? request : request.set('X-Bridge-Host-Secret', secret)
  }

  beforeEach(() => {
    rpcHandlers.matrix_bridge_hosted_list = () => ({ data: HOSTED, error: null })
    rpcHandlers.matrix_bridge_instance_hosted = () => ({ data: INSTANCE, error: null })
    rpcHandlers.bridge_host_report = () => ({ data: null, error: null })
  })

  it.each(routes)('%s %s answers 404 while its secret is unset or short, and 401 to a wrong one', async (method, path) => {
    for (const secret of ['', 'x'.repeat(31)]) {
      mocks.config.bridge.matrixHostSecret = secret
      const res = await call(method, path, secret)
      expect([res.status, res.body]).toEqual([404, { error: 'Not found' }])
      expect(res.headers['cache-control']).toBe('no-store')
    }
    mocks.config.bridge.matrixHostSecret = HOST_SECRET
    // The Discord host's secret opens nothing of Matrix.
    for (const secret of [undefined, '', HOST_SECRET.slice(1), HOST_SECRET + 'm', DISCORD_HOST_SECRET]) {
      const res = await call(method, path, secret)
      expect([secret, res.status, res.body]).toEqual([secret, 401, { error: 'Invalid host secret' }])
      expect(res.headers['cache-control']).toBe('no-store')
    }
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('its secret opens nothing of Discord', async () => {
    for (const path of ['/bridge/v2/hosted', '/bridge/v2/hosted/instance']) {
      expect((await supertest(makeApp()).get(path).set('X-Bridge-Host-Secret', HOST_SECRET)).status).toBe(401)
    }
  })

  it('a bot token is no host secret', async () => {
    for (const [method, path] of routes) expect((await supertest(makeApp())[method](base + path).set(auth)).status).toBe(401)
  })

  it('counts wrong secrets per client and no poll', async () => {
    const app = makeApp({ hostedFailureLimit: 2 })
    for (let i = 0; i < 4; i++) expect((await call('get', '', HOST_SECRET, app)).status).toBe(200)
    expect((await call('get', '', 'wrong', app)).status).toBe(401)
    expect((await call('post', '/link', 'wrong', app)).status).toBe(401)
    expect((await call('get', '', HOST_SECRET, app)).status).toBe(429)
  })

  it('reads the hosted bridges and the instance\'s connection, their tokens and nothing else', async () => {
    rpcHandlers.matrix_bridge_hosted_list = () => ({ data: [{ ...HOSTED[0], extra: 1 }], error: null })
    rpcHandlers.matrix_bridge_instance_hosted = () => ({ data: { ...INSTANCE, extra: 1 }, error: null })
    const res = await call('get', '', HOST_SECRET)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({ hosted: HOSTED, instance: INSTANCE })
  })

  it('reads nothing of a mode that is off, or without Vault', async () => {
    rpcHandlers.matrix_bridge_hosted_list = () => ({ data: [], error: null })
    rpcHandlers.matrix_bridge_instance_hosted = () => ({ data: null, error: null })
    expect((await call('get', '', HOST_SECRET)).body).toEqual({ hosted: [], instance: null })
    rpcHandlers.matrix_bridge_hosted_list = () => ({ data: null, error: { code: '0A000', message: 'Vault absent' } })
    expect((await call('get', '', HOST_SECRET)).body).toEqual({ hosted: [], instance: null })
  })

  // The host stops what a list leaves out.
  it('answers 503 and no partial list when a lookup fails', async () => {
    for (const fn of ['matrix_bridge_hosted_list', 'matrix_bridge_instance_hosted']) {
      const works = rpcHandlers[fn]
      rpcHandlers[fn] = () => ({ data: null, error: { code: '57014', message: 'secret detail' } })
      const res = await call('get', '', HOST_SECRET)
      expect([fn, res.status, res.body]).toEqual([fn, 503, { error: 'Host list unavailable' }])
      rpcHandlers[fn] = works
    }
  })

  it('reports its status, cleaned and bounded', async () => {
    const post = (body: unknown) => call('post', '/status', HOST_SECRET).send(body as object)
    const res = await post({
      version: '0.3.0\u0000', hosted: 4, access_token: 'secret',
      instance: {
        ready: true, user_id: '@harmony_relay:example.org', server_name: 'example.org', as_token: 'secret',
        problems: [{ code: 'matrix_unreachable', detail: 'x'.repeat(500) }, { detail: 'no code' }],
      },
    })
    expect([res.status, res.body]).toEqual([200, { ok: true }])
    expect(rpcCalls('bridge_host_report')).toEqual([{
      p_platform: 'matrix', p_version: '0.3.0',
      p_status: {
        instance: { ready: true, user_id: '@harmony_relay:example.org', server_name: 'example.org', problems: [{ code: 'matrix_unreachable', detail: 'x'.repeat(200) }] },
        hosted: 4,
      },
    }])
    await post({ hosted: -1, instance: 'on', version: 7 })
    expect(rpcCalls('bridge_host_report')[1]).toEqual({ p_platform: 'matrix', p_version: null, p_status: { instance: null, hosted: 0 } })
    await post({ instance: { ready: 'yes', user_id: 'sam', server_name: 'exa mple' } })
    expect(rpcCalls('bridge_host_report')[2].p_status.instance).toEqual({ ready: false, user_id: null, server_name: null, problems: [] })
    expect((await post([])).status).toBe(400)
    rpcHandlers.bridge_host_report = () => ({ data: null, error: { code: 'XX000', message: 'boom' } })
    expect((await post({})).status).toBe(500)
  })

  describe('links a room', () => {
    const LINKED = { bridge_id: BRIDGE_ID, server_name: 'Server', channel_id: GENERAL, channel_name: 'general' }
    const link = (body: unknown) => call('post', '/link', HOST_SECRET).send(body as object)
    const ROOM = { code: 'ML-ABCD-EFGH-JK23', room_id: '!room:example.org', sender: SAM }

    it('by the code posted in it', async () => {
      rpcHandlers.matrix_bridge_link_room = () => ({ data: { ...LINKED, server_id: SERVER_ID }, error: null })
      const res = await link({ ...ROOM, code: ' ml abcd\u2013efgh\u2014jk23 ' })
      expect([res.status, res.body]).toEqual([200, LINKED])
      expect(rpcCalls('matrix_bridge_link_room')).toEqual([{ p_code: 'ML-ABCD-EFGH-JK23', p_room_id: '!room:example.org', p_sender: SAM }])
      // The event dispatch reads the install the link widened: the first message after it is relayed.
      expect(installsChanged.mock.calls).toEqual([[LINKED.channel_id]])
    })

    it('answers every bad code alike, and a malformed or foreign one without touching the database', async () => {
      rpcHandlers.matrix_bridge_link_room = () => ({ data: null, error: null })
      const refused = await link(ROOM)
      expect([refused.status, refused.body]).toEqual([400, { error: 'Invalid or expired room code', code: 'invalid_code' }])
      for (const code of ['nope', 'MX-ABCD-EFGH-JK23', 'HB-ABCD-EFGH-JK23', 7, null, undefined, { a: 1 }]) {
        const res = await link({ ...ROOM, code })
        expect([code, res.status, res.body]).toEqual([code, refused.status, refused.body])
      }
      expect(rpcCalls('matrix_bridge_link_room')).toHaveLength(1)
    })

    it('answers 409 channel_encrypted, 400 to a malformed room or sender, 503 to a failure', async () => {
      rpcHandlers.matrix_bridge_link_room = () => ({ data: null, error: { code: '55000', message: 'channel_encrypted' } })
      let res = await link(ROOM)
      expect([res.status, res.body.code]).toEqual([409, 'channel_encrypted'])
      for (const body of [{ ...ROOM, room_id: 'room' }, { ...ROOM, room_id: '!a/b' }, { ...ROOM, room_id: '!\ud800' }, { ...ROOM, sender: 'sam' }, {}]) {
        res = await link(body)
        expect([res.status, res.body.code]).toEqual([400, 'invalid_request'])
      }
      expect(rpcCalls('matrix_bridge_link_room')).toHaveLength(1)
      expect(installsChanged).not.toHaveBeenCalled()
      rpcHandlers.matrix_bridge_link_room = () => ({ data: null, error: { code: '22023', message: 'Invalid Matrix room or user id' } })
      res = await link(ROOM)
      expect([res.status, res.body.code]).toEqual([400, 'invalid_request'])
      rpcHandlers.matrix_bridge_link_room = () => ({ data: null, error: { code: '23505', message: 'secret detail' } })
      res = await link(ROOM)
      expect([res.status, res.body]).toEqual([503, { error: 'Room not linked' }])
    })
  })
})

describe('the Discord bridge host', () => {
  const poll = (path = '/bridge/v2/hosted', secret = DISCORD_HOST_SECRET) =>
    supertest(makeApp()).get(path).set('X-Bridge-Host-Secret', secret)
  const reports = () => rpcCalls('bridge_host_report')

  beforeEach(() => {
    db.rows('instance_config').push({ config_key: 'discord_bridge_hosting_enabled', config_value: true })
    rpcHandlers.discord_bridge_hosted_list = () => ({ data: [], error: null })
    rpcHandlers.discord_bridge_instance_hosted = () => ({ data: null, error: null })
    rpcHandlers.bridge_host_report = () => ({ data: null, error: null })
  })

  it('is recorded at most once a minute, by either route, hosting on or off', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    db.rows('instance_config')[0].config_value = false
    expect((await poll()).status).toBe(404)
    expect((await poll('/bridge/v2/hosted/instance')).status).toBe(404)
    expect(reports()).toEqual([{ p_platform: 'discord' }])
    vi.mocked(Date.now).mockReturnValue(1_060_000)
    await poll('/bridge/v2/hosted/instance')
    expect(reports()).toHaveLength(2)
  })

  it('is not recorded with a wrong secret', async () => {
    expect((await poll('/bridge/v2/hosted', 'wrong')).status).toBe(401)
    expect(reports()).toEqual([])
  })

  it('gets its answer whatever becomes of the record, which is tried again', async () => {
    for (const fails of [() => ({ data: null, error: { code: 'XX000', message: 'boom' } }), () => { throw new Error('offline') }, () => new Promise<RpcResult>(() => {})]) {
      rpcHandlers.bridge_host_report = fails
      const res = await poll()
      expect([res.status, res.body]).toEqual([200, []])
    }
    expect(reports()).toHaveLength(3)
  })
})
