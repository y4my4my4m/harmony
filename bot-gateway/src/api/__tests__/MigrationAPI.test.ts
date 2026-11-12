import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const OTHER_SERVER = '00000000-0000-0000-0000-00000000005b'
const PROFILE_ID = '00000000-0000-0000-0000-0000000000a1'
const AUTH_ID = '00000000-0000-0000-0000-0000000000b1'
const BRIDGE_ID = '00000000-0000-0000-0000-0000000000f0'
const TOKEN = 'ab'.repeat(24)
const STATE = 'cd'.repeat(32)
const TICKET = 'ef'.repeat(32)
const GUILD = '100000000000000091'
const CLIENT_ID = '300000000000000091'
const CLIENT_SECRET = 'client-secret-must-not-leak-0123'
const BOT_TOKEN = 'bot.token-must-not-leak.0123456789'
const JWT = 'user.jwt.value'
const CALLBACK = 'https://harmony.test/bot-gateway/bridge/v2/migrate/callback'
const APP = 'https://harmony.test'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  userRpc: vi.fn(),
  autoconfirm: vi.fn(),
  getUser: vi.fn(),
  createUser: vi.fn(),
  deleteUser: vi.fn(),
  resend: vi.fn(),
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
  discord: {
    exchangeUserCode: vi.fn(),
    fetchCurrentUser: vi.fn(),
    fetchGuildMember: vi.fn(),
    fetchGuildRoles: vi.fn(),
    fetchBotPermissionsInGuild: vi.fn(),
    fetchApplication: vi.fn(),
    fetchGuildChannels: vi.fn(),
  },
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
    auth: { getUser: mocks.getUser, admin: { createUser: mocks.createUser, deleteUser: mocks.deleteUser }, resend: mocks.resend },
  },
  createUserClient: () => ({ rpc: mocks.userRpc }),
  fetchMailerAutoconfirm: mocks.autoconfirm,
  config: mocks.config,
}))

vi.mock('../../migration/discordClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../migration/discordClient.js')>()),
  ...mocks.discord,
}))

import { MigrationAPI } from '../MigrationAPI.js'

type RpcResult = { data: unknown; error: { code?: string; message: string } | null }
let db: FakeDb
let rpcHandlers: Record<string, (args: any) => RpcResult>
let syncOne: Mock<(serverId: string, userId: string) => Promise<void>>
let logged: string[]

function makeApp() {
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.json())
  app.use('/bridge/v2/migrate', new MigrationAPI({ syncOne }).router)
  return app
}

const rpcCalls = (fn: string) => mocks.rpc.mock.calls.filter(([name]) => name === fn).map(([, args]) => args)
const future = () => new Date(Date.now() + 60_000).toISOString()
const past = () => new Date(Date.now() - 60_000).toISOString()

const BIT_NAMES = ['ADMINISTRATOR', 'VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES']

beforeEach(() => {
  db = new FakeDb({
    discord_migrations: [
      { server_id: SERVER_ID, state: 'open', discord_guild_id: GUILD, credential_source: 'instance_bot', link_token: TOKEN },
      { server_id: OTHER_SERVER, state: 'finished', discord_guild_id: GUILD, credential_source: 'own', link_token: 'ff'.repeat(24) },
    ],
    discord_migration_link_states: [],
    discord_migration_claims: [{ ticket: TICKET, server_id: SERVER_ID, auth_user_id: null, expires_at: future() }],
    discord_migration_links: [],
    profiles: [{ id: PROFILE_ID, auth_user_id: AUTH_ID, username: 'someone', is_local: true }],
    instance_config: [],
    discord_bridges: [{ id: BRIDGE_ID, server_id: SERVER_ID, mode: 'instance' }],
    discord_bridge_channels: [{ bridge_id: BRIDGE_ID, discord_channel_id: 'c1' }],
  })
  mocks.from.mockImplementation((table: string) => db.from(table))
  mocks.config.bridge = { instanceDomain: 'harmony.test', publicUrl: '', hostSecret: '', configPollMs: 5_000 }
  mocks.autoconfirm.mockReset()
  mocks.autoconfirm.mockResolvedValue(false)

  rpcHandlers = {
    discord_migration_credentials: () => ({
      data: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, bot_token: BOT_TOKEN },
      error: null,
    }),
    discord_migration_create_claim: () => ({ data: { ticket: TICKET }, error: null }),
    discord_migration_bind_claim: () => ({ data: null, error: null }),
    discord_migration_store_discord_roles: () => ({ data: null, error: null }),
    discord_migration_store_warnings: () => ({ data: null, error: null }),
    discord_migration_store_member_overrides: () => ({ data: null, error: null }),
    permission_bit_names: () => ({ data: BIT_NAMES, error: null }),
  }
  mocks.rpc.mockReset()
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    const handler = rpcHandlers[fn]
    if (!handler) throw new Error(`test called unmocked rpc: ${fn}`)
    return handler(args)
  })
  mocks.userRpc.mockReset()
  mocks.userRpc.mockResolvedValue({ data: true, error: null })
  mocks.getUser.mockReset()
  mocks.getUser.mockResolvedValue({ data: { user: { id: AUTH_ID, factors: [] } }, error: null })
  mocks.createUser.mockReset()
  mocks.createUser.mockResolvedValue({ data: { user: { id: AUTH_ID } }, error: null })
  mocks.deleteUser.mockReset()
  mocks.deleteUser.mockResolvedValue({ data: null, error: null })
  mocks.resend.mockReset()
  mocks.resend.mockResolvedValue({ data: {}, error: null })

  const d = mocks.discord
  for (const fn of Object.values(d)) fn.mockReset()
  d.exchangeUserCode.mockResolvedValue({ ok: true, value: { accessToken: 'user-access-token' } })
  d.fetchCurrentUser.mockResolvedValue({
    ok: true,
    value: { id: '555', username: 'dave', global_name: 'Dave', avatar_url: 'https://cdn.example/a.png', banner_url: null, accent_color: null },
  })
  d.fetchGuildMember.mockResolvedValue({
    ok: true,
    value: { present: true, member: { role_ids: ['11', '22'], joined_at: '2024-01-02T03:04:05.000Z', user: {} } },
  })
  d.fetchGuildRoles.mockResolvedValue({
    ok: true,
    value: [
      { id: '11', name: 'Mods', color: 5, position: 3, permissions: String((1n << 3n) | (1n << 10n)) },
      { id: '22', name: 'Plain', color: 0, position: 1, permissions: '0' },
    ],
  })
  d.fetchBotPermissionsInGuild.mockResolvedValue({ ok: true, value: { canBan: true } })
  d.fetchApplication.mockResolvedValue({ ok: true, value: { id: CLIENT_ID } })
  d.fetchGuildChannels.mockResolvedValue({
    ok: true,
    value: [
      {
        id: 'c1',
        name: 'general',
        type: 0,
        permission_overwrites: [
          { id: '11', type: 0, allow: '0', deny: '0' },
          { id: '777', type: 1, allow: String((1n << 10n) | (1n << 11n)), deny: String(1n << 3n) },
        ],
      },
      {
        id: 'c2',
        name: 'random',
        type: 0,
        permission_overwrites: [
          { id: '888', type: 1, allow: '0', deny: String(1n << 10n) },
          { id: '999', type: 1, allow: String(1n << 3n), deny: '0' },
        ],
      },
      { id: 'c3', name: 'Text Channels', type: 4, permission_overwrites: [] },
      { id: 'c4', name: 'Lounge', type: 2, permission_overwrites: [] },
      { id: 'c5', name: 'news', type: 5, permission_overwrites: [] },
    ],
  })

  syncOne = vi.fn(async (_serverId: string, _userId: string) => undefined)
  logged = []
  const capture = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  }
  vi.spyOn(console, 'error').mockImplementation(capture)
  vi.spyOn(console, 'warn').mockImplementation(capture)
})

afterEach(() => {
  for (const line of logged) {
    for (const secret of [CLIENT_SECRET, BOT_TOKEN, 'user-access-token']) expect(line).not.toContain(secret)
  }
  vi.restoreAllMocks()
})

describe('GET /bridge/v2/migrate/authorize', () => {
  it('redirects an open token to Discord with the identify scope and stores a 10 minute state', async () => {
    const res = await supertest(makeApp()).get(`/bridge/v2/migrate/authorize?token=${TOKEN}`)

    expect(res.status).toBe(302)
    const location = new URL(res.headers.location)
    expect(`${location.origin}${location.pathname}`).toBe('https://discord.com/oauth2/authorize')
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(location.searchParams.get('scope')).toBe('identify')
    expect(location.searchParams.get('redirect_uri')).toBe(CALLBACK)
    const state = location.searchParams.get('state')!
    expect(state).toMatch(/^[0-9a-f]{64}$/)
    const stored = db.rows('discord_migration_link_states')
    expect(stored).toHaveLength(1)
    expect(stored[0].state).toBe(state)
    expect(stored[0].server_id).toBe(SERVER_ID)
    const ttl = Date.parse(stored[0].expires_at) - Date.now()
    expect(ttl).toBeGreaterThan(9 * 60_000)
    expect(ttl).toBeLessThanOrEqual(10 * 60_000)
  })

  it('redirects a finished migration to the app with error=closed', async () => {
    const res = await supertest(makeApp()).get(`/bridge/v2/migrate/authorize?token=${'ff'.repeat(24)}`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`${APP}/migrate/${'ff'.repeat(24)}?error=closed`)
    expect(db.rows('discord_migration_link_states')).toHaveLength(0)
  })

  it('treats an unknown token as closed and refuses a malformed one', async () => {
    const unknown = await supertest(makeApp()).get(`/bridge/v2/migrate/authorize?token=${'12'.repeat(24)}`)
    expect(unknown.headers.location).toBe(`${APP}/migrate/${'12'.repeat(24)}?error=closed`)
    const bad = await supertest(makeApp()).get('/bridge/v2/migrate/authorize?token=nope')
    expect(bad.status).toBe(400)
  })
})

describe('GET /bridge/v2/migrate/callback', () => {
  beforeEach(() => {
    db.rows('discord_migration_link_states').push({ state: STATE, server_id: SERVER_ID, expires_at: future() })
  })

  it('creates a claim for a guild member, passes joined_at, and redirects with the ticket', async () => {
    const res = await supertest(makeApp()).get(`/bridge/v2/migrate/callback?code=abc123&state=${STATE}`)

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`${APP}/migrate/${TOKEN}?ticket=${TICKET}&username=dave`)
    expect(mocks.discord.exchangeUserCode).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code: 'abc123',
      redirectUri: CALLBACK,
    })
    expect(rpcCalls('discord_migration_create_claim')).toEqual([
      {
        p_server_id: SERVER_ID,
        p_discord_user: { id: '555', username: 'dave', global_name: 'Dave', avatar_url: 'https://cdn.example/a.png' },
        p_discord_role_ids: ['11', '22'],
        p_discord_joined_at: '2024-01-02T03:04:05.000Z',
      },
    ])
    expect(db.rows('discord_migration_link_states')).toHaveLength(0)
  })

  it('redirects a non-member with error=not_member and never creates a claim', async () => {
    mocks.discord.fetchGuildMember.mockResolvedValue({ ok: true, value: { present: false } })
    const res = await supertest(makeApp()).get(`/bridge/v2/migrate/callback?code=abc123&state=${STATE}`)
    expect(res.headers.location).toBe(`${APP}/migrate/${TOKEN}?error=not_member`)
    expect(rpcCalls('discord_migration_create_claim')).toHaveLength(0)
  })

  it.each(['MIGRATION_CLOSED', 'DISCORD_BANNED_HERE', 'ALREADY_LINKED_ELSEWHERE'])('passes %s through lowercased', async (code) => {
    rpcHandlers.discord_migration_create_claim = () => ({ data: { error: code }, error: null })
    const res = await supertest(makeApp()).get(`/bridge/v2/migrate/callback?code=abc123&state=${STATE}`)
    expect(res.headers.location).toBe(`${APP}/migrate/${TOKEN}?error=${code.toLowerCase()}`)
  })

  it('returns 400 for a bad, unknown or expired state', async () => {
    const app = makeApp()
    expect((await supertest(app).get('/bridge/v2/migrate/callback?code=abc&state=zzz')).status).toBe(400)
    expect((await supertest(app).get(`/bridge/v2/migrate/callback?code=abc&state=${'99'.repeat(32)}`)).status).toBe(400)
    db.rows('discord_migration_link_states')[0].expires_at = past()
    expect((await supertest(app).get(`/bridge/v2/migrate/callback?code=abc&state=${STATE}`)).status).toBe(400)
    expect(mocks.discord.exchangeUserCode).not.toHaveBeenCalled()
  })

  it('uses a state once', async () => {
    const app = makeApp()
    await supertest(app).get(`/bridge/v2/migrate/callback?code=abc123&state=${STATE}`)
    const again = await supertest(app).get(`/bridge/v2/migrate/callback?code=abc123&state=${STATE}`)
    expect(again.status).toBe(400)
  })

  it('maps a denied consent and a failed exchange to redirects', async () => {
    const denied = await supertest(makeApp()).get(`/bridge/v2/migrate/callback?error=access_denied&state=${STATE}`)
    expect(denied.headers.location).toBe(`${APP}/migrate/${TOKEN}?error=denied`)

    db.rows('discord_migration_link_states').push({ state: STATE, server_id: SERVER_ID, expires_at: future() })
    mocks.discord.exchangeUserCode.mockResolvedValue({ ok: false, status: 400, reason: 'discord_http_400' })
    const failed = await supertest(makeApp()).get(`/bridge/v2/migrate/callback?code=abc123&state=${STATE}`)
    expect(failed.headers.location).toBe(`${APP}/migrate/${TOKEN}?error=exchange_failed`)
  })

  it('turns a throw from the Discord client into a redirect, not an unhandled exception', async () => {
    mocks.discord.fetchGuildMember.mockRejectedValue(new TypeError('Cannot read properties of undefined'))
    const res = await supertest(makeApp()).get(`/bridge/v2/migrate/callback?code=abc123&state=${STATE}`)
    expect(res.status).toBe(302)
    expect(res.headers.location).toBe(`${APP}/migrate/${TOKEN}?error=unavailable`)
  })
})

describe('POST /bridge/v2/migrate/account', () => {
  const body = { ticket: TICKET, username: 'dave_d', email: 'dave@example.com', password: 'correct horse battery' }
  const post = (b: object = body) => supertest(makeApp()).post('/bridge/v2/migrate/account').send(b)

  it('creates the user unconfirmed, binds the claim and reports needsConfirmation', async () => {
    const res = await post()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, needsConfirmation: true })
    expect(mocks.createUser).toHaveBeenCalledWith({
      email: 'dave@example.com',
      password: 'correct horse battery',
      email_confirm: false,
      user_metadata: { username: 'dave_d' },
    })
    expect(rpcCalls('discord_migration_bind_claim')).toEqual([{ p_ticket: TICKET, p_auth_user_id: AUTH_ID }])
    expect(mocks.createUser.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder.at(-1)!)
  })

  it('reports needsConfirmation false and confirms the email when GoTrue auto-confirms', async () => {
    mocks.autoconfirm.mockResolvedValue(true)
    const res = await post()
    expect(res.body).toEqual({ ok: true, needsConfirmation: false })
    expect(mocks.createUser.mock.calls[0][0].email_confirm).toBe(true)
  })

  it('fails safe to an unconfirmed account and warns when the GoTrue settings cannot be read', async () => {
    mocks.autoconfirm.mockResolvedValue(null)
    const res = await post()
    expect(res.body).toEqual({ ok: true, needsConfirmation: true })
    expect(mocks.createUser.mock.calls[0][0].email_confirm).toBe(false)
    expect(logged.some((l) => l.includes('GoTrue settings unreadable'))).toBe(true)
  })

  it('answers 403 account_creation_disabled when the instance switch is off', async () => {
    db.rows('instance_config').push({ config_key: 'discord_migration_account_creation', config_value: false })
    const res = await post()
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('account_creation_disabled')
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('answers 400 for an unknown, expired or already bound ticket', async () => {
    expect((await post({ ...body, ticket: '77'.repeat(32) })).status).toBe(400)
    db.rows('discord_migration_claims')[0].expires_at = past()
    expect((await post()).status).toBe(400)
    db.rows('discord_migration_claims')[0].expires_at = future()
    db.rows('discord_migration_claims')[0].auth_user_id = AUTH_ID
    expect((await post()).status).toBe(400)
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('answers 409 username_taken among local profiles only', async () => {
    db.rows('profiles').push({ id: 'p2', username: 'dave_d', is_local: true })
    const res = await post()
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('username_taken')
    expect(mocks.createUser).not.toHaveBeenCalled()
  })

  it('answers 409 email_exists when the email is registered', async () => {
    mocks.createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', status: 422, message: 'exists' } })
    const res = await post()
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('email_exists')
    expect(rpcCalls('discord_migration_bind_claim')).toHaveLength(0)
  })

  it('removes the new user when the claim cannot be bound', async () => {
    rpcHandlers.discord_migration_bind_claim = () => ({ data: null, error: { message: 'TICKET_EXPIRED' } })
    const res = await post()
    expect(res.status).toBe(400)
    expect(mocks.deleteUser).toHaveBeenCalledWith(AUTH_ID)
  })

  it('rolls back on any bind error and logs a failed rollback with the user id', async () => {
    rpcHandlers.discord_migration_bind_claim = () => ({ data: null, error: { code: 'XX000', message: 'boom' } })
    mocks.deleteUser.mockResolvedValue({ data: null, error: { message: 'gotrue down' } })
    const res = await post()
    expect(res.status).toBe(500)
    expect(mocks.deleteUser).toHaveBeenCalledWith(AUTH_ID)
    expect(logged.some((l) => l.includes(AUTH_ID) && l.includes('gotrue down'))).toBe(true)
  })

  it('rejects a malformed username', async () => {
    expect((await post({ ...body, username: 'Bad Name!' })).status).toBe(400)
  })
})

describe('POST /bridge/v2/migrate/:serverId/refresh', () => {
  const post = (jwt: string | null = JWT) => {
    const req = supertest(makeApp()).post(`/bridge/v2/migrate/${SERVER_ID}/refresh`)
    return jwt ? req.set('Authorization', `Bearer ${jwt}`) : req
  }

  it('answers 401 without a JWT or with an invalid one', async () => {
    expect((await post(null)).status).toBe(401)
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } })
    expect((await post()).status).toBe(401)
    expect(mocks.userRpc).not.toHaveBeenCalled()
  })

  it('answers 403 to a caller who cannot manage the bridge', async () => {
    mocks.userRpc.mockResolvedValue({ data: false, error: null })
    const res = await post()
    expect(res.status).toBe(403)
    expect(mocks.userRpc).toHaveBeenCalledWith('can_manage_discord_bridge', { p_server_id: SERVER_ID })
    expect(rpcCalls('discord_migration_store_discord_roles')).toHaveLength(0)
  })

  it('stores the role snapshot with harmony_permissions, canBan and the readiness warnings', async () => {
    const res = await post()

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, roles: 2, canBan: true })
    const mask = String((1 << 0) | (1 << 1)) // ADMINISTRATOR and VIEW_CHANNEL at bit positions 0 and 1
    expect(rpcCalls('discord_migration_store_discord_roles')).toEqual([
      {
        p_server_id: SERVER_ID,
        p_roles: [
          { id: '11', name: 'Mods', color: 5, position: 3, harmony_permissions: mask },
          { id: '22', name: 'Plain', color: 0, position: 1, harmony_permissions: '0' },
        ],
      },
    ])
    expect(db.rows('discord_migrations').find((m) => m.server_id === SERVER_ID)!.bot_can_ban).toBe(true)
    // Discord VIEW_CHANNEL at Harmony bit 1 (SEND_MESSAGES is not among this test's bit names); an ADMINISTRATOR-only overwrite carries nothing.
    expect(rpcCalls('discord_migration_store_member_overrides')).toEqual([
      {
        p_server_id: SERVER_ID,
        p_overrides: [
          { channel_id: 'c1', channel_name: 'general', user_id: '777', allow: String(1 << 1), deny: '0' },
          { channel_id: 'c2', channel_name: 'random', user_id: '888', allow: '0', deny: String(1 << 1) },
        ],
      },
    ])
    expect(rpcCalls('discord_migration_store_warnings')).toEqual([
      { p_server_id: SERVER_ID, p_warnings: { unpaired_channels: ['random', 'news'], member_overrides: 3 } },
    ])
  })

  it('finishes the refresh when the member overwrite snapshot cannot be stored', async () => {
    rpcHandlers.discord_migration_store_member_overrides = () => ({ data: null, error: { code: 'XX000', message: 'boom' } })
    const res = await post()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, roles: 2, canBan: true })
    expect(rpcCalls('discord_migration_store_warnings')).toHaveLength(1)
    expect(logged.some((line) => line.includes('discord_migration_store_member_overrides failed'))).toBe(true)
  })

  it('answers credentials_missing when the credentials cannot be resolved', async () => {
    rpcHandlers.discord_migration_credentials = () => ({ data: null, error: { message: 'MIGRATION_CREDENTIALS_MISSING' } })
    const res = await post()
    expect(res.body).toEqual({ ok: false, error: 'credentials_missing' })
  })

  it('maps a 401 from Discord to token_invalid and a missing guild to bot_not_in_guild', async () => {
    mocks.discord.fetchGuildRoles.mockResolvedValue({ ok: false, status: 401, reason: 'discord_http_401' })
    expect((await post()).body).toEqual({ ok: false, error: 'token_invalid' })
    mocks.discord.fetchGuildRoles.mockResolvedValue({ ok: false, status: 404, reason: 'discord_http_404 code 10004' })
    expect((await post()).body).toEqual({ ok: false, error: 'bot_not_in_guild' })
    mocks.discord.fetchGuildRoles.mockResolvedValue({ ok: true, value: [] })
    mocks.discord.fetchBotPermissionsInGuild.mockResolvedValue({ ok: false, status: 404, reason: 'bot_not_in_guild' })
    expect((await post()).body).toEqual({ ok: false, error: 'bot_not_in_guild' })
  })

  it('answers 502 when Discord is unreachable or returns a malformed body', async () => {
    mocks.discord.fetchGuildRoles.mockResolvedValue({ ok: false, status: 0, reason: 'timeout' })
    expect((await post()).status).toBe(502)
    mocks.discord.fetchGuildRoles.mockRejectedValue(new TypeError('x is not iterable'))
    const res = await post()
    expect(res.status).toBe(502)
    expect(res.body.ok).toBe(false)
  })

  it('fills the client id of a bridge source from the bridge bot', async () => {
    db.rows('discord_migrations')[0].credential_source = 'bridge'
    db.rows('discord_bridges').push({ id: 'b-hosted', server_id: SERVER_ID, mode: 'hosted' })
    db.rows('discord_migration_secrets').push({ server_id: SERVER_ID, client_id: null })
    let resolved = false
    rpcHandlers.discord_migration_credentials = () =>
      resolved
        ? { data: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, bot_token: BOT_TOKEN }, error: null }
        : { data: null, error: { message: 'MIGRATION_CREDENTIALS_MISSING' } }
    rpcHandlers.discord_bridge_hosted_list = () => {
      resolved = true
      return { data: [{ bridge_id: 'b-hosted', harmony_token: 'h', discord_token: BOT_TOKEN }], error: null }
    }

    const res = await post()

    expect(res.body.ok).toBe(true)
    expect(mocks.discord.fetchApplication).toHaveBeenCalledWith(BOT_TOKEN)
    expect(db.rows('discord_migration_secrets')[0].client_id).toBe(CLIENT_ID)
  })
})

describe('POST /bridge/v2/migrate/me/:serverId/sync', () => {
  const post = (jwt: string | null = JWT) => {
    const req = supertest(makeApp()).post(`/bridge/v2/migrate/me/${SERVER_ID}/sync`)
    return jwt ? req.set('Authorization', `Bearer ${jwt}`) : req
  }

  it('answers 401 without a JWT', async () => {
    expect((await post(null)).status).toBe(401)
  })

  it('answers 404 without an active link and does not sync', async () => {
    const res = await post()
    expect(res.status).toBe(404)
    expect(syncOne).not.toHaveBeenCalled()
  })

  it('answers 404 once the migration is finished', async () => {
    db.rows('discord_migration_links').push({ server_id: SERVER_ID, user_id: PROFILE_ID, status: 'active' })
    db.rows('discord_migrations')[0].state = 'finished'
    expect((await post()).status).toBe(404)
    expect(syncOne).not.toHaveBeenCalled()
  })

  it('runs syncOne once for the caller with an active link', async () => {
    db.rows('discord_migration_links').push({ server_id: SERVER_ID, user_id: PROFILE_ID, status: 'active' })
    const res = await post()
    expect(res.status).toBe(200)
    expect(syncOne).toHaveBeenCalledTimes(1)
    expect(syncOne).toHaveBeenCalledWith(SERVER_ID, PROFILE_ID)
  })

  it('answers 502 when the sync throws', async () => {
    db.rows('discord_migration_links').push({ server_id: SERVER_ID, user_id: PROFILE_ID, status: 'active' })
    syncOne.mockRejectedValue(new Error('boom'))
    expect((await post()).status).toBe(502)
  })
})

describe('rate limits', () => {
  it('limits each route per IP', async () => {
    const app = express()
    app.set('trust proxy', 'loopback')
    app.use(express.json())
    app.use('/m', new MigrationAPI({ syncOne, limit: 2 }).router)
    const get = () => supertest(app).get(`/m/authorize?token=${TOKEN}`)
    expect((await get()).status).toBe(302)
    expect((await get()).status).toBe(302)
    expect((await get()).status).toBe(429)
    // another route keeps its own allowance
    expect((await supertest(app).post('/m/account').send({})).status).toBe(400)
  })
})
