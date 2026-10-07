import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { createHash } from 'crypto'
import { FakeDb, type Row } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const OTHER_BOT = '00000000-0000-0000-0000-0000000000b9'
const BRIDGE_ID = '00000000-0000-0000-0000-0000000000f0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const OTHER_SERVER = '00000000-0000-0000-0000-00000000005b'
const GENERAL = '00000000-0000-0000-0000-0000000000c1'
const HIDDEN = '00000000-0000-0000-0000-0000000000c2'
const CATEGORY_CHANNEL = '00000000-0000-0000-0000-0000000000c3'
const ELSEWHERE = '00000000-0000-0000-0000-0000000000c9'
const CATEGORY = '00000000-0000-0000-0000-0000000000ca'
const EVERYONE_ROLE = '00000000-0000-0000-0000-0000000000e0'
const TOKEN = 'harmony_bot_bridge'
const TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest('hex')
const HOST_SECRET = 'h'.repeat(40)
const D1 = '200000000000000001'
const D2 = '200000000000000002'

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

import { BridgeV2API, secretsEqual, type BridgeV2Options } from '../BridgeV2API.js'

type RpcResult = { data: unknown; error: { code?: string; message: string } | null }
let db: FakeDb
let rpcHandlers: Record<string, (args: any) => RpcResult>

function seed() {
  db = new FakeDb({
    discord_bridges: [
      {
        id: BRIDGE_ID, server_id: SERVER_ID, bot_id: BOT_ID, mode: 'self', discord_guild_id: '100000000000000001',
        settings: { sync_member_list: true }, updated_at: '2026-10-07T10:00:00.000Z',
      },
    ],
    discord_bridge_channels: [
      { id: 'p1', bridge_id: BRIDGE_ID, harmony_channel_id: GENERAL, discord_channel_id: D1, discord_channel_name: 'general', direction: 'both' },
    ],
    channels: [
      { id: GENERAL, server_id: SERVER_ID, name: 'general', type: 0, category: CATEGORY, order: 1 },
      { id: HIDDEN, server_id: SERVER_ID, name: 'staff', type: 0, category: null, order: 2 },
      { id: CATEGORY_CHANNEL, server_id: SERVER_ID, name: 'Text', type: 2, category: null, order: 0 },
      { id: ELSEWHERE, server_id: OTHER_SERVER, name: 'elsewhere', type: 0, category: null, order: 0 },
    ],
    channel_categories: [{ id: CATEGORY, server_id: SERVER_ID, name: 'Community' }],
    bot_server_permissions: [
      { id: 'i1', bot_id: BOT_ID, server_id: SERVER_ID, is_active: true, read_messages: true, send_messages: true },
    ],
    server_roles: [{ id: EVERYONE_ROLE, server_id: SERVER_ID, permissions: 122646786, is_default: true }],
    channel_permission_overrides: [
      { id: 'o1', channel_id: HIDDEN, role_id: EVERYONE_ROLE, user_id: null, allow_permissions: 0, deny_permissions: 2 },
    ],
    instance_config: [{ config_key: 'discord_bridge_hosting_enabled', config_value: false }],
  })
  mocks.from.mockImplementation((table: string) => db.from(table))
}

function makeApp(options: BridgeV2Options = {}) {
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.json())
  app.use('/bridge/v2', new BridgeV2API(options).router)
  return app
}

const auth = { Authorization: `Bot ${TOKEN}` }

beforeEach(() => {
  seed()
  mocks.config.bridge = { instanceDomain: 'harmony.test', publicUrl: '', hostSecret: '', configPollMs: 5_000 }
  rpcHandlers = {
    verify_bot_token: ({ p_token_hash }) =>
      p_token_hash === TOKEN_SHA256
        ? { data: { valid: true, bot_id: BOT_ID, username: 'bridge', scopes: ['bot'] }, error: null }
        : { data: { valid: false, error: 'Invalid or expired token' }, error: null },
    check_and_increment_bot_rate_limit: () => ({ data: false, error: null }),
    discord_bridge_encrypted_channel_ids: ({ p_bridge_id }) => ({ data: p_bridge_id === BRIDGE_ID ? [] : null, error: null }),
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

const rpcCalls = (fn: string) => mocks.rpc.mock.calls.filter(([name]) => name === fn).map(([, args]) => args)

describe('POST /bridge/v2/redeem', () => {
  const REDEEMED = { bridge_id: BRIDGE_ID, server_id: SERVER_ID, harmony_token: 'harmony_bot_new' }

  it('refuses a malformed code without touching the database', async () => {
    const res = await supertest(makeApp()).post('/bridge/v2/redeem').send({ code: 'HRM-AB12-CD34' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Invalid or expired setup code', code: 'invalid_code' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('answers an unknown, used or expired code exactly as a malformed one', async () => {
    rpcHandlers.discord_bridge_redeem_code = () => ({ data: null, error: null })
    const app = makeApp()
    const unknown = await supertest(app).post('/bridge/v2/redeem').send({ code: 'HB-AAAA-BBBB-CCCC' })
    const malformed = await supertest(app).post('/bridge/v2/redeem').send({ code: 'nope' })

    expect(unknown.status).toBe(malformed.status)
    expect(unknown.body).toEqual(malformed.body)
  })

  it('trades a code for the bot token and the instance URLs', async () => {
    rpcHandlers.discord_bridge_redeem_code = () => ({ data: REDEEMED, error: null })
    const res = await supertest(makeApp()).post('/bridge/v2/redeem').send({ code: ' hb-abcd-efgh-jk23 ' })

    expect(rpcCalls('discord_bridge_redeem_code')).toEqual([{ p_code: 'HB-ABCD-EFGH-JK23' }])
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({
      ...REDEEMED,
      base_url: 'https://harmony.test',
      api_url: 'https://harmony.test/bot-gateway',
      gateway_url: 'wss://harmony.test/bot-gateway/gateway',
    })
  })

  const spellings: Array<[string, string]> = [
    ['without dashes', 'hbabcdefghjk23'],
    ['without the prefix', 'abcd-efgh-jk23'],
    ['with spaces', ' HB ABCD EFGH JK23 '],
    ['with typographic dashes', 'HB\u2013ABCD\u2014EFGH\u2212JK23'],
  ]
  for (const [how, typed] of spellings) {
    it(`hashes a code typed ${how} in its canonical form`, async () => {
      rpcHandlers.discord_bridge_redeem_code = () => ({ data: REDEEMED, error: null })
      const res = await supertest(makeApp()).post('/bridge/v2/redeem').send({ code: typed })

      expect(res.status).toBe(200)
      expect(rpcCalls('discord_bridge_redeem_code')).toEqual([{ p_code: 'HB-ABCD-EFGH-JK23' }])
    })
  }

  it('answers every malformed spelling as an unknown code', async () => {
    rpcHandlers.discord_bridge_redeem_code = () => ({ data: null, error: null })
    const app = makeApp({ redeemLimit: 100 })
    const unknown = await supertest(app).post('/bridge/v2/redeem').send({ code: 'HB-AAAA-BBBB-CCCC' })
    for (const code of ['HB-ABCD-EFGH-JK2', 'HB_ABCD_EFGH_JK23', 'HB-ABCD-EFGH-JK23-X', 42, null]) {
      const res = await supertest(app).post('/bridge/v2/redeem').send({ code })
      expect([res.status, res.body]).toEqual([unknown.status, unknown.body])
    }
    expect(rpcCalls('discord_bridge_redeem_code')).toHaveLength(1)
  })

  it('keeps the scheme of a configured URL', async () => {
    mocks.config.bridge.instanceDomain = 'http://harmony.lan:8080/'
    rpcHandlers.discord_bridge_redeem_code = () => ({ data: REDEEMED, error: null })
    const res = await supertest(makeApp()).post('/bridge/v2/redeem').send({ code: 'HB-ABCD-EFGH-JK23' })

    expect(res.body.base_url).toBe('http://harmony.lan:8080')
    expect(res.body.gateway_url).toBe('ws://harmony.lan:8080/bot-gateway/gateway')
  })

  it('falls back to PUBLIC_URL, then to the origin the request reached, never a localhost default', async () => {
    rpcHandlers.discord_bridge_redeem_code = () => ({ data: REDEEMED, error: null })
    mocks.config.bridge.instanceDomain = ''
    mocks.config.bridge.publicUrl = 'https://public.example'
    const viaPublic = await supertest(makeApp()).post('/bridge/v2/redeem').send({ code: 'HB-ABCD-EFGH-JK23' })
    expect(viaPublic.body.api_url).toBe('https://public.example/bot-gateway')

    mocks.config.bridge.publicUrl = ''
    const viaHost = await supertest(makeApp())
      .post('/bridge/v2/redeem')
      .set('Host', 'gateway.example:3002')
      .set('X-Forwarded-Proto', 'https')
      .send({ code: 'HB-ABCD-EFGH-JK23' })
    expect(viaHost.body).toMatchObject({
      base_url: 'https://gateway.example:3002',
      api_url: 'https://gateway.example:3002',
      gateway_url: 'wss://gateway.example:3002/gateway',
    })
    expect(JSON.stringify(viaHost.body)).not.toContain('localhost:3000')
  })

  it('answers 500 without detail when the lookup fails', async () => {
    rpcHandlers.discord_bridge_redeem_code = () => ({ data: null, error: { code: '57014', message: 'canceling statement' } })
    const res = await supertest(makeApp()).post('/bridge/v2/redeem').send({ code: 'HB-ABCD-EFGH-JK23' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Redeem failed' })
  })

  it('limits attempts per client IP', async () => {
    rpcHandlers.discord_bridge_redeem_code = () => ({ data: null, error: null })
    const app = makeApp({ redeemLimit: 3 })
    const attempt = (ip: string) =>
      supertest(app).post('/bridge/v2/redeem').set('X-Forwarded-For', ip).send({ code: 'HB-AAAA-BBBB-CCCC' })

    for (let i = 0; i < 3; i++) expect((await attempt('203.0.113.7')).status).toBe(400)
    const limited = await attempt('203.0.113.7')
    expect(limited.status).toBe(429)
    expect(limited.body.code).toBe('rate_limited')
    expect((await attempt('198.51.100.9')).status).toBe(400)
    expect(rpcCalls('discord_bridge_redeem_code')).toHaveLength(4)
  })
})

describe('GET /bridge/v2/hosted', () => {
  const HOSTED = [{ bridge_id: BRIDGE_ID, harmony_token: 'harmony_bot_x', discord_token: 'discord.token.x', server_id: SERVER_ID }]

  beforeEach(() => {
    rpcHandlers.discord_bridge_hosted_list = () => ({ data: HOSTED, error: null })
  })

  it('is absent while BRIDGE_HOST_SECRET is unset', async () => {
    const res = await supertest(makeApp()).get('/bridge/v2/hosted').set('X-Bridge-Host-Secret', '')

    expect(res.status).toBe(404)
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('is absent while BRIDGE_HOST_SECRET is shorter than 32 characters', async () => {
    mocks.config.bridge.hostSecret = 'short'
    const res = await supertest(makeApp()).get('/bridge/v2/hosted').set('X-Bridge-Host-Secret', 'short')

    expect(res.status).toBe(404)
  })

  it('refuses a missing or wrong secret', async () => {
    mocks.config.bridge.hostSecret = HOST_SECRET
    const app = makeApp()

    expect((await supertest(app).get('/bridge/v2/hosted')).status).toBe(401)
    expect((await supertest(app).get('/bridge/v2/hosted').set('X-Bridge-Host-Secret', `${HOST_SECRET}x`)).status).toBe(401)
    expect(rpcCalls('discord_bridge_hosted_list')).toHaveLength(0)
  })

  it('is absent while hosting is disabled', async () => {
    mocks.config.bridge.hostSecret = HOST_SECRET
    const res = await supertest(makeApp()).get('/bridge/v2/hosted').set('X-Bridge-Host-Secret', HOST_SECRET)

    expect(res.status).toBe(404)
    expect(rpcCalls('discord_bridge_hosted_list')).toHaveLength(0)
  })

  it('lists hosted bridges with both tokens when the secret matches and hosting is on', async () => {
    mocks.config.bridge.hostSecret = HOST_SECRET
    db.rows('instance_config')[0].config_value = true
    const res = await supertest(makeApp()).get('/bridge/v2/hosted').set('X-Bridge-Host-Secret', HOST_SECRET)

    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual([{ bridge_id: BRIDGE_ID, harmony_token: 'harmony_bot_x', discord_token: 'discord.token.x' }])
  })

  it('answers 503 when the hosting flag cannot be read', async () => {
    mocks.config.bridge.hostSecret = HOST_SECRET
    db.failures.instance_config = { message: 'connection reset' }
    const res = await supertest(makeApp()).get('/bridge/v2/hosted').set('X-Bridge-Host-Secret', HOST_SECRET)

    expect(res.status).toBe(503)
  })

  it('limits failed attempts per client IP and leaves successes uncounted', async () => {
    mocks.config.bridge.hostSecret = HOST_SECRET
    db.rows('instance_config')[0].config_value = true
    const app = makeApp({ hostedFailureLimit: 2 })
    const get = (secret: string) =>
      supertest(app).get('/bridge/v2/hosted').set('X-Forwarded-For', '203.0.113.7').set('X-Bridge-Host-Secret', secret)

    for (let i = 0; i < 3; i++) expect((await get(HOST_SECRET)).status).toBe(200)
    expect((await get('wrong')).status).toBe(401)
    expect((await get('wrong')).status).toBe(401)
    expect((await get(HOST_SECRET)).status).toBe(429)
  })

  it('does not count polls answered 404 while hosting is disabled', async () => {
    mocks.config.bridge.hostSecret = HOST_SECRET
    const app = makeApp({ hostedFailureLimit: 2 })
    const get = () =>
      supertest(app).get('/bridge/v2/hosted').set('X-Forwarded-For', '203.0.113.8').set('X-Bridge-Host-Secret', HOST_SECRET)

    for (let i = 0; i < 4; i++) expect((await get()).status).toBe(404)
    db.rows('instance_config')[0].config_value = true
    expect((await get()).status).toBe(200)
  })

  it('compares secrets by digest', () => {
    expect(secretsEqual(HOST_SECRET, HOST_SECRET)).toBe(true)
    expect(secretsEqual('', HOST_SECRET)).toBe(false)
    expect(secretsEqual(HOST_SECRET.slice(1), HOST_SECRET)).toBe(false)
  })
})

describe('bridge bot authentication', () => {
  it('refuses a request without a bot token', async () => {
    const res = await supertest(makeApp()).get('/bridge/v2/config')

    expect(res.status).toBe(401)
  })

  it('refuses a token verify_bot_token rejects', async () => {
    const res = await supertest(makeApp()).get('/bridge/v2/config').set('Authorization', 'Bot wrong')

    expect(res.status).toBe(401)
  })

  it('refuses a bot that drives no bridge', async () => {
    rpcHandlers.verify_bot_token = () => ({
      data: { valid: true, bot_id: OTHER_BOT, username: 'music', scopes: ['bot'] },
      error: null,
    })
    const app = makeApp()

    expect((await supertest(app).get('/bridge/v2/config').set(auth)).status).toBe(403)
    expect((await supertest(app).post('/bridge/v2/status').set(auth).send({})).status).toBe(403)
    expect((await supertest(app).post('/bridge/v2/pairs').set(auth).send({})).status).toBe(403)
    expect((await supertest(app).delete(`/bridge/v2/pairs/${D1}`).set(auth)).status).toBe(403)
  })

  it('answers 429 when the bot rate limit is exhausted', async () => {
    rpcHandlers.check_and_increment_bot_rate_limit = () => ({ data: true, error: null })
    const res = await supertest(makeApp()).get('/bridge/v2/config').set(auth)

    expect(res.status).toBe(429)
    expect(rpcCalls('check_and_increment_bot_rate_limit')[0].p_bucket).toBe('/bridge/v2/config')
  })

  it('answers 503 when the bridge lookup fails', async () => {
    db.failures.discord_bridges = { message: 'connection reset' }
    const res = await supertest(makeApp()).get('/bridge/v2/config').set(auth)

    expect(res.status).toBe(503)
  })
})

describe('GET /bridge/v2/config', () => {
  it('returns the bridge, its pairs and the channels the bridge bot sees', async () => {
    const res = await supertest(makeApp()).get('/bridge/v2/config').set(auth)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      bridge_id: BRIDGE_ID,
      server_id: SERVER_ID,
      mode: 'self',
      discord_guild_id: '100000000000000001',
      settings: { sync_member_list: true },
      updated_at: '2026-10-07T10:00:00.000Z',
      base_url: 'https://harmony.test',
      pairs: [{
        harmony_channel_id: GENERAL,
        harmony_channel_name: 'general',
        discord_channel_id: D1,
        discord_channel_name: 'general',
        direction: 'both',
      }],
      harmony_channels: [{ id: GENERAL, name: 'general', type: 0, category: 'Community', category_id: CATEGORY, encrypted: false }],
    })
    expect(rpcCalls('discord_bridge_encrypted_channel_ids')).toEqual([{ p_bridge_id: BRIDGE_ID }])
  })

  it('marks the channels whose messages are end-to-end encrypted', async () => {
    rpcHandlers.discord_bridge_encrypted_channel_ids = () => ({ data: [GENERAL.toUpperCase()], error: null })
    const res = await supertest(makeApp()).get('/bridge/v2/config').set(auth)

    expect(res.body.harmony_channels).toEqual([expect.objectContaining({ id: GENERAL, encrypted: true })])
  })

  it('answers 503 rather than report an unknown encryption state as plaintext', async () => {
    rpcHandlers.discord_bridge_encrypted_channel_ids = () => ({ data: null, error: { code: '57014', message: 'canceling statement' } })
    const res = await supertest(makeApp()).get('/bridge/v2/config').set(auth)

    expect(res.status).toBe(503)
  })

  it('gives the base URL redeem gives, the request origin when none is configured', async () => {
    mocks.config.bridge.instanceDomain = ''
    const res = await supertest(makeApp())
      .get('/bridge/v2/config')
      .set(auth)
      .set('Host', 'gateway.example:3002')
      .set('X-Forwarded-Proto', 'https')

    expect(res.body.base_url).toBe('https://gateway.example:3002')
  })

  it('lists no channel when the bridge bot is not installed', async () => {
    db.rows('bot_server_permissions').splice(0)
    const res = await supertest(makeApp()).get('/bridge/v2/config').set(auth)

    expect(res.body.harmony_channels).toEqual([])
    expect(res.body.pairs).toHaveLength(1)
  })

  it('answers 503 when a lookup fails', async () => {
    db.failures.discord_bridge_channels = { message: 'connection reset' }
    const res = await supertest(makeApp()).get('/bridge/v2/config').set(auth)

    expect(res.status).toBe(503)
  })
})

describe('POST /bridge/v2/status', () => {
  beforeEach(() => {
    rpcHandlers.discord_bridge_report_status = () => ({
      data: { bridge_id: BRIDGE_ID, discord_guild_id: '100000000000000001' },
      error: null,
    })
  })

  it('refuses a body that is not an object', async () => {
    const res = await supertest(makeApp()).post('/bridge/v2/status').set(auth).send([1, 2])

    expect(res.status).toBe(400)
    expect(rpcCalls('discord_bridge_report_status')).toHaveLength(0)
  })

  it('stores the documented fields only, bounded', async () => {
    const res = await supertest(makeApp()).post('/bridge/v2/status').set(auth).send({
      version: '2.0.0',
      secret: 'dropped',
      discord: {
        connected: true,
        application_id: '300000000000000001',
        bot_user: { id: '300000000000000001', name: 'n'.repeat(300), avatar: 'abc', token: 'dropped' },
        intents: { message_content: true, members: 'yes', presence: false },
      },
      guilds: [
        {
          id: '100000000000000001', name: 'Guild', icon: null,
          channels: [
            { id: D1, name: 'general', type: 0, parent_id: null, position: 1, can_view: true, can_send: true, can_manage_webhooks: false, extra: 1 },
            { id: 'not-an-id', name: 'dropped' },
          ],
        },
        { id: 'not-a-guild', name: 'dropped' },
      ],
      harmony: { connected: true },
      problems: [
        { code: 'intent_missing', params: { intent: 'members', 'Bad Key': 'x', nested: { a: 1 } } },
        { code: 'Not A Code' },
      ],
    })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, discord_guild_id: '100000000000000001' })
    const [args] = rpcCalls('discord_bridge_report_status')
    expect(args.p_bot_id).toBe(BOT_ID)
    expect(args.p_version).toBe('2.0.0')
    expect(args.p_status).toEqual({
      version: '2.0.0',
      discord: {
        connected: true,
        application_id: '300000000000000001',
        bot_user: { id: '300000000000000001', name: 'n'.repeat(100), avatar: 'abc' },
        intents: { message_content: true, members: false, presence: false },
      },
      harmony: { connected: true },
      problems: [{ code: 'intent_missing', params: { intent: 'members' } }],
    })
    expect(args.p_snapshot).toEqual({
      guilds: [{
        id: '100000000000000001', name: 'Guild', icon: null,
        channels: [{ id: D1, name: 'general', type: 0, parent_id: null, position: 1, can_view: true, can_send: true, can_manage_webhooks: false }],
      }],
    })
  })

  // discord_bridge_report_status stores the snapshot and selects a guild only from a connected report.
  it('passes a disconnected report on marked disconnected, with the guilds it carries', async () => {
    const res = await supertest(makeApp()).post('/bridge/v2/status').set(auth).send({
      version: '2.0.0',
      discord: { connected: false },
      guilds: [],
      problems: [{ code: 'discord_unreachable' }],
    })

    expect(res.status).toBe(200)
    const [args] = rpcCalls('discord_bridge_report_status')
    expect(args.p_status.discord.connected).toBe(false)
    expect(args.p_snapshot).toEqual({ guilds: [] })
  })

  it('maps a refused report to 400', async () => {
    rpcHandlers.discord_bridge_report_status = () => ({ data: null, error: { code: '22023', message: 'status report too large' } })
    const res = await supertest(makeApp()).post('/bridge/v2/status').set(auth).send({ guilds: [] })

    expect(res.status).toBe(400)
  })
})

describe('POST /bridge/v2/pairs', () => {
  const link = (body: Row) => supertest(makeApp()).post('/bridge/v2/pairs').set(auth).send(body)

  beforeEach(() => {
    rpcHandlers.discord_bridge_bot_pair = () => ({ data: 'p2', error: null })
  })

  it('validates the Discord id, the Harmony id and the direction before any lookup', async () => {
    expect((await link({ discord_channel_id: 'general', harmony_channel_id: GENERAL })).status).toBe(400)
    expect((await link({ discord_channel_id: D2, harmony_channel_id: 'general' })).status).toBe(400)
    expect((await link({ discord_channel_id: D2, harmony_channel_id: GENERAL, direction: 'sideways' })).status).toBe(400)
    expect(rpcCalls('discord_bridge_bot_pair')).toHaveLength(0)
  })

  it('refuses a channel of another server', async () => {
    const res = await link({ discord_channel_id: D2, harmony_channel_id: ELSEWHERE })

    expect(res.status).toBe(400)
    expect(rpcCalls('discord_bridge_bot_pair')).toHaveLength(0)
  })

  it('refuses a channel the bridge bot cannot see', async () => {
    const res = await link({ discord_channel_id: D2, harmony_channel_id: HIDDEN })

    expect(res.status).toBe(403)
    expect(rpcCalls('discord_bridge_bot_pair')).toHaveLength(0)
  })

  it('pairs a visible channel through discord_bridge_bot_pair', async () => {
    const res = await link({ discord_channel_id: D2, harmony_channel_id: GENERAL, discord_channel_name: 'memes' })

    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id: 'p2', harmony_channel_id: GENERAL, discord_channel_id: D2, direction: 'both' })
    expect(rpcCalls('discord_bridge_bot_pair')).toEqual([{
      p_bot_id: BOT_ID,
      p_harmony_channel_id: GENERAL,
      p_discord_channel_id: D2,
      p_discord_channel_name: 'memes',
      p_direction: 'both',
    }])
  })

  it('maps a duplicate to 409 and a Discord channel outside the guild to 400', async () => {
    rpcHandlers.discord_bridge_bot_pair = () => ({ data: null, error: { code: '23505', message: 'already paired' } })
    expect((await link({ discord_channel_id: D2, harmony_channel_id: GENERAL })).status).toBe(409)

    rpcHandlers.discord_bridge_bot_pair = () => ({ data: null, error: { code: '22023', message: 'not in the selected guild' } })
    const res = await link({ discord_channel_id: D2, harmony_channel_id: GENERAL })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('not in the selected guild')
  })
})

describe('DELETE /bridge/v2/pairs/:discordChannelId', () => {
  it('refuses an id that is not a Discord id', async () => {
    const res = await supertest(makeApp()).delete('/bridge/v2/pairs/general').set(auth)

    expect(res.status).toBe(400)
  })

  it('answers 404 for an unpaired channel and 204 for a paired one', async () => {
    let paired = true
    rpcHandlers.discord_bridge_bot_unpair = () => {
      const was = paired
      paired = false
      return { data: was, error: null }
    }
    const app = makeApp()

    expect((await supertest(app).delete(`/bridge/v2/pairs/${D1}`).set(auth)).status).toBe(204)
    expect((await supertest(app).delete(`/bridge/v2/pairs/${D1}`).set(auth)).status).toBe(404)
    expect(rpcCalls('discord_bridge_bot_unpair')[0]).toEqual({ p_bot_id: BOT_ID, p_discord_channel_id: D1 })
  })
})
