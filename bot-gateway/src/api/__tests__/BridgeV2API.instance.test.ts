import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const BRIDGE_ID = '00000000-0000-0000-0000-0000000000f0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const OTHER_BRIDGE = '00000000-0000-0000-0000-0000000000f1'
const STATE = 'a'.repeat(64)
const APP_ID = '300000000000000091'
const CLIENT_SECRET = 'client-secret-must-not-leak-0123'
const BOT_TOKEN = 'bot.token-must-not-leak.0123456789'
const CODE = 'oauth2code9f8e7d'
const GUILD = '100000000000000091'
const QUERY_GUILD = '100000000000000099'
const HOST_SECRET = 'h'.repeat(40)
const CALLBACK = 'https://harmony.test/bot-gateway/bridge/v2/discord/callback'
const SETTINGS = `https://harmony.test/server/${SERVER_ID}?section=discord-bridge`

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

import { BridgeV2API, type BridgeV2Options } from '../BridgeV2API.js'
import { INSTANCE_BOT_PERMISSIONS } from '../../bridge/instanceBot.js'

type RpcResult = { data: unknown; error: { code?: string; message: string } | null }
let db: FakeDb
let rpcHandlers: Record<string, (args: any) => RpcResult>
let fetchMock: ReturnType<typeof vi.fn>
let logged: string[]

function makeApp(options: BridgeV2Options = {}) {
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.json())
  app.use('/bridge/v2', new BridgeV2API(options).router)
  return app
}

const rpcCalls = (fn: string) => mocks.rpc.mock.calls.filter(([name]) => name === fn).map(([, args]) => args)
const fetchCalls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init: init as RequestInit }))

function tokenResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const check = (error: string | null, serverId: string | null = SERVER_ID) => ({
  data: { bridge_id: serverId ? BRIDGE_ID : null, server_id: serverId, error },
  error: null,
})

beforeEach(() => {
  db = new FakeDb({
    discord_bridges: [
      { id: OTHER_BRIDGE, server_id: 'other', mode: 'instance', discord_guild_id: '100000000000000055' },
    ],
  })
  mocks.from.mockImplementation((table: string) => db.from(table))
  mocks.config.bridge = { instanceDomain: 'harmony.test', publicUrl: '', hostSecret: '', configPollMs: 5_000 }
  rpcHandlers = {
    discord_bridge_instance_link_check: () => check(null),
    discord_bridge_instance_bot_secrets: () => ({ data: [{ client_id: APP_ID, client_secret: CLIENT_SECRET }], error: null }),
    discord_bridge_instance_link_complete: () => ({ data: { bridge_id: BRIDGE_ID, server_id: SERVER_ID }, error: null }),
    discord_bridge_instance_hosted: () => ({
      data: { application_id: APP_ID, discord_token: BOT_TOKEN, presence: false, bridges: [] },
      error: null,
    }),
  }
  mocks.rpc.mockReset()
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    const handler = rpcHandlers[fn]
    if (!handler) throw new Error(`test called unmocked rpc: ${fn}`)
    return handler(args)
  })
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/oauth2/token')) {
      return tokenResponse({ access_token: 'user-access-token', token_type: 'Bearer', guild: { id: GUILD, name: 'Guild One' } })
    }
    return new Response(null, { status: 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
  logged = []
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  }
  vi.spyOn(console, 'error').mockImplementation(capture)
  vi.spyOn(console, 'warn').mockImplementation(capture)
  vi.spyOn(console, 'log').mockImplementation(capture)
})

afterEach(() => {
  for (const line of logged) {
    for (const secret of [CODE, CLIENT_SECRET, BOT_TOKEN, STATE, 'user-access-token']) {
      expect(line).not.toContain(secret)
    }
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /bridge/v2/discord/authorize', () => {
  it('redirects to Discord with the bot scope, the bridge permissions and the registered redirect URI', async () => {
    const res = await supertest(makeApp()).get(`/bridge/v2/discord/authorize?state=${STATE}`)

    expect(res.status).toBe(302)
    expect(res.headers['cache-control']).toBe('no-store')
    const location = new URL(res.headers.location)
    expect(`${location.origin}${location.pathname}`).toBe('https://discord.com/oauth2/authorize')
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: APP_ID,
      scope: 'bot applications.commands',
      permissions: '537259072',
      response_type: 'code',
      integration_type: '0',
      redirect_uri: CALLBACK,
      state: STATE,
    })
    expect(res.headers.location).toContain('scope=bot%20applications.commands')
    expect(rpcCalls('discord_bridge_instance_link_check')).toEqual([{ p_state: STATE, p_guild_id: null }])
  })

  it('carries the permissions the bridge program documents, plus Use External Emojis', () => {
    // View Channels, Send Messages, Embed Links, Attach Files, Read Message History, Add Reactions,
    // Manage Webhooks (536988736, the bridge README's invite before 2.2) + Manage Messages
    // (1 << 13, bridge 2.2) + Use External Emojis (1 << 18).
    expect(INSTANCE_BOT_PERMISSIONS).toBe(String(536988736 + 8192 + 262144))
    expect(INSTANCE_BOT_PERMISSIONS).toBe('537259072')
  })

  it('returns an expired or used state to the bridge settings before Discord is involved', async () => {
    rpcHandlers.discord_bridge_instance_link_check = () => check('state_invalid')
    const res = await supertest(makeApp()).get(`/bridge/v2/discord/authorize?state=${STATE}`)

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`${SETTINGS}&link_error=state_invalid`)
    expect(rpcCalls('discord_bridge_instance_bot_secrets')).toHaveLength(0)
  })

  it('answers a malformed or unknown state with a page, having no server to return to', async () => {
    const app = makeApp()
    const malformed = await supertest(app).get('/bridge/v2/discord/authorize?state=nope')
    expect(malformed.status).toBe(400)
    expect(malformed.headers['content-type']).toContain('text/html')
    expect(malformed.text).toContain('href="https://harmony.test/"')
    expect(rpcCalls('discord_bridge_instance_link_check')).toHaveLength(0)

    rpcHandlers.discord_bridge_instance_link_check = () => check('state_invalid', null)
    expect((await supertest(app).get(`/bridge/v2/discord/authorize?state=${STATE}`)).status).toBe(400)
  })

  it('returns to the settings when the instance bot is off', async () => {
    rpcHandlers.discord_bridge_instance_bot_secrets = () => ({ data: [], error: null })
    const res = await supertest(makeApp()).get(`/bridge/v2/discord/authorize?state=${STATE}`)

    expect(res.headers.location).toBe(`${SETTINGS}&link_error=exchange_failed`)
  })

  it('refuses to redirect anywhere while no public instance URL is configured', async () => {
    mocks.config.bridge.instanceDomain = ''
    const res = await supertest(makeApp())
      .get(`/bridge/v2/discord/authorize?state=${STATE}`)
      .set('Host', 'localhost:3002')

    expect(res.status).toBe(503)
    expect(res.headers.location).toBeUndefined()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('uses PUBLIC_URL when INSTANCE_DOMAIN is unset', async () => {
    mocks.config.bridge.instanceDomain = ''
    mocks.config.bridge.publicUrl = 'https://public.example/'
    const res = await supertest(makeApp()).get(`/bridge/v2/discord/authorize?state=${STATE}`)

    expect(new URL(res.headers.location).searchParams.get('redirect_uri')).toBe(
      'https://public.example/bot-gateway/bridge/v2/discord/callback',
    )
  })
})

describe('GET /bridge/v2/discord/callback', () => {
  const callback = (query: string, app = makeApp()) => supertest(app).get(`/bridge/v2/discord/callback?${query}`)
  const ok = `code=${CODE}&state=${STATE}&guild_id=${QUERY_GUILD}&permissions=537259072`

  it('exchanges the code and links the guild of the token response, never the query', async () => {
    const res = await callback(ok)

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`${SETTINGS}&linked=1`)
    const [exchange] = fetchCalls()
    expect(exchange.url).toBe('https://discord.com/api/v10/oauth2/token')
    expect(exchange.init.method).toBe('POST')
    expect((exchange.init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(String(exchange.init.body)))).toEqual({
      grant_type: 'authorization_code',
      code: CODE,
      redirect_uri: CALLBACK,
      client_id: APP_ID,
      client_secret: CLIENT_SECRET,
    })
    expect(rpcCalls('discord_bridge_instance_link_complete')).toEqual([
      { p_state: STATE, p_guild_id: GUILD, p_guild_name: 'Guild One' },
    ])
    expect(rpcCalls('discord_bridge_instance_link_check')).toEqual([{ p_state: STATE, p_guild_id: QUERY_GUILD }])
  })

  it('sends a denied consent back as discord_denied without exchanging anything', async () => {
    const res = await callback(`error=access_denied&error_description=The+resource+owner+denied&state=${STATE}`)

    expect(res.headers.location).toBe(`${SETTINGS}&link_error=discord_denied`)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rpcCalls('discord_bridge_instance_link_check')).toEqual([{ p_state: STATE, p_guild_id: null }])
  })

  it('sends any other Discord error back as exchange_failed', async () => {
    const res = await callback(`error=invalid_scope&state=${STATE}`)

    expect(res.headers.location).toBe(`${SETTINGS}&link_error=exchange_failed`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  for (const why of ['used', 'expired', 'superseded']) {
    it(`refuses a ${why} state before the code is exchanged`, async () => {
      rpcHandlers.discord_bridge_instance_link_check = () => check('state_invalid')
      const res = await callback(ok)

      expect(res.headers.location).toBe(`${SETTINGS}&link_error=state_invalid`)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(rpcCalls('discord_bridge_instance_link_complete')).toHaveLength(0)
    })
  }

  it('answers a state that names no server with a page', async () => {
    rpcHandlers.discord_bridge_instance_link_check = () => check('state_invalid', null)
    const unknown = await callback(ok)
    const malformed = await callback(`code=${CODE}&state=zzz`)

    expect(unknown.status).toBe(400)
    expect(malformed.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a guild linked to another server before the bot joins it', async () => {
    rpcHandlers.discord_bridge_instance_link_check = ({ p_guild_id }) =>
      check(p_guild_id === QUERY_GUILD ? 'guild_linked_elsewhere' : null)
    const res = await callback(ok)

    expect(res.headers.location).toBe(`${SETTINGS}&link_error=guild_linked_elsewhere`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses past the instance limit before the bot joins', async () => {
    rpcHandlers.discord_bridge_instance_link_check = () => check('limit_reached')
    const res = await callback(ok)

    expect(res.headers.location).toBe(`${SETTINGS}&link_error=limit_reached`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports a refused exchange as exchange_failed and logs Discord\'s error code alone', async () => {
    fetchMock.mockImplementation(async () =>
      tokenResponse({ error: 'invalid_grant', error_description: `Invalid "code" in request: ${CODE}` }, 400),
    )
    const res = await callback(ok)

    expect(res.headers.location).toBe(`${SETTINGS}&link_error=exchange_failed`)
    expect(rpcCalls('discord_bridge_instance_link_complete')).toHaveLength(0)
    expect(logged.join('\n')).toContain('HTTP 400 invalid_grant')
  })

  it('reports an unreachable Discord as exchange_failed', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed')
    })
    const res = await callback(ok)

    expect(res.headers.location).toBe(`${SETTINGS}&link_error=exchange_failed`)
  })

  it('reports a token response without a guild as exchange_failed', async () => {
    fetchMock.mockImplementation(async () => tokenResponse({ access_token: 'user-access-token', token_type: 'Bearer' }))
    const res = await callback(ok)

    expect(res.headers.location).toBe(`${SETTINGS}&link_error=exchange_failed`)
    expect(rpcCalls('discord_bridge_instance_link_complete')).toHaveLength(0)
  })

  it('refuses a missing or malformed code without calling Discord', async () => {
    const app = makeApp()
    expect((await callback(`state=${STATE}`, app)).headers.location).toBe(`${SETTINGS}&link_error=exchange_failed`)
    expect((await callback(`state=${STATE}&code=${encodeURIComponent('a b<c>')}`, app)).headers.location).toBe(
      `${SETTINGS}&link_error=exchange_failed`,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports exchange_failed when the instance bot was turned off meanwhile', async () => {
    rpcHandlers.discord_bridge_instance_bot_secrets = () => ({ data: [], error: null })
    const res = await callback(ok)

    expect(res.headers.location).toBe(`${SETTINGS}&link_error=exchange_failed`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the bot in a guild another bridge links when completion finds it taken', async () => {
    db.rows('discord_bridges')[0].discord_guild_id = GUILD
    rpcHandlers.discord_bridge_instance_link_complete = () => ({
      data: null,
      error: { code: '23505', message: 'guild_linked_elsewhere' },
    })
    const res = await callback(ok)

    expect(res.headers.location).toBe(`${SETTINGS}&link_error=guild_linked_elsewhere`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fetchCalls().map((c) => c.init.method)).toEqual(['POST'])
  })

  it('leaves a guild the bot joined through a link refused at completion', async () => {
    rpcHandlers.discord_bridge_instance_link_complete = () => ({ data: null, error: { code: '54000', message: 'limit_reached' } })
    const res = await callback(ok)

    expect(res.headers.location).toBe(`${SETTINGS}&link_error=limit_reached`)
    await vi.waitFor(() => expect(fetchCalls()).toHaveLength(2))
    const leave = fetchCalls()[1]
    expect(leave.url).toBe(`https://discord.com/api/v10/users/@me/guilds/${GUILD}`)
    expect(leave.init.method).toBe('DELETE')
    expect((leave.init.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`)
  })

  it('answers 503 when the state cannot be checked', async () => {
    rpcHandlers.discord_bridge_instance_link_check = () => ({ data: null, error: { code: '57014', message: 'canceling statement' } })
    const res = await callback(ok)

    expect(res.status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('limits authorize and callback requests per client IP', async () => {
    rpcHandlers.discord_bridge_instance_link_check = () => check('state_invalid')
    const app = makeApp({ linkLimit: 3 })
    const hit = (ip: string, path: string) =>
      supertest(app).get(`/bridge/v2/discord/${path}?state=${STATE}`).set('X-Forwarded-For', ip)

    expect((await hit('203.0.113.7', 'authorize')).status).toBe(302)
    expect((await hit('203.0.113.7', 'callback')).status).toBe(302)
    expect((await hit('203.0.113.7', 'callback')).status).toBe(302)
    const limited = await hit('203.0.113.7', 'callback')
    expect(limited.status).toBe(429)
    expect(limited.body.code).toBe('rate_limited')
    expect((await hit('198.51.100.9', 'callback')).status).toBe(302)
  })
})

describe('GET /bridge/v2/hosted/instance', () => {
  const HOSTED = {
    application_id: APP_ID,
    discord_token: BOT_TOKEN,
    presence: true,
    bridges: [{ bridge_id: BRIDGE_ID, harmony_token: 'harmony_bot_x', discord_guild_id: GUILD, extra: 1 }],
  }

  beforeEach(() => {
    rpcHandlers.discord_bridge_instance_hosted = () => ({ data: HOSTED, error: null })
  })

  it('is absent while BRIDGE_HOST_SECRET is unset or short', async () => {
    expect((await supertest(makeApp()).get('/bridge/v2/hosted/instance')).status).toBe(404)
    mocks.config.bridge.hostSecret = 'short'
    expect((await supertest(makeApp()).get('/bridge/v2/hosted/instance').set('X-Bridge-Host-Secret', 'short')).status).toBe(404)
    expect(rpcCalls('discord_bridge_instance_hosted')).toHaveLength(0)
  })

  it('refuses a wrong secret', async () => {
    mocks.config.bridge.hostSecret = HOST_SECRET
    const res = await supertest(makeApp()).get('/bridge/v2/hosted/instance').set('X-Bridge-Host-Secret', `${HOST_SECRET}x`)

    expect(res.status).toBe(401)
    expect(rpcCalls('discord_bridge_instance_hosted')).toHaveLength(0)
  })

  it('returns the instance bot and its linked bridges', async () => {
    mocks.config.bridge.hostSecret = HOST_SECRET
    const res = await supertest(makeApp()).get('/bridge/v2/hosted/instance').set('X-Bridge-Host-Secret', HOST_SECRET)

    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toEqual({
      application_id: APP_ID,
      discord_token: BOT_TOKEN,
      presence: true,
      bridges: [{ bridge_id: BRIDGE_ID, harmony_token: 'harmony_bot_x', discord_guild_id: GUILD }],
    })
  })

  it('is absent while the instance bot is off, unconfigured or Vault is missing', async () => {
    mocks.config.bridge.hostSecret = HOST_SECRET
    const app = makeApp()
    rpcHandlers.discord_bridge_instance_hosted = () => ({ data: null, error: null })
    expect((await supertest(app).get('/bridge/v2/hosted/instance').set('X-Bridge-Host-Secret', HOST_SECRET)).status).toBe(404)
    rpcHandlers.discord_bridge_instance_hosted = () => ({ data: null, error: { code: '0A000', message: 'Vault absent' } })
    expect((await supertest(app).get('/bridge/v2/hosted/instance').set('X-Bridge-Host-Secret', HOST_SECRET)).status).toBe(404)
  })

  it('leaves GET /hosted with its array shape', async () => {
    mocks.config.bridge.hostSecret = HOST_SECRET
    db.rows('instance_config').push({ config_key: 'discord_bridge_hosting_enabled', config_value: true })
    rpcHandlers.discord_bridge_hosted_list = () => ({
      data: [{ bridge_id: BRIDGE_ID, harmony_token: 'harmony_bot_y', discord_token: 'discord.token.y' }],
      error: null,
    })
    const res = await supertest(makeApp()).get('/bridge/v2/hosted').set('X-Bridge-Host-Secret', HOST_SECRET)

    expect(res.body).toEqual([{ bridge_id: BRIDGE_ID, harmony_token: 'harmony_bot_y', discord_token: 'discord.token.y' }])
  })
})
