import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { createHash } from 'crypto'
import type { AddressInfo } from 'net'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const TOKEN = 'hrm_bot_9f2c1d4e8a7b'
const TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest('hex')

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  config: {
    supabaseUrl: 'http://localhost:54321',
    port: 3002,
    nodeEnv: 'test',
    instanceDomain: 'harmony.test',
    websocket: { heartbeatInterval: 30_000, maxConnectionsPerBot: 5, revalidateIntervalMs: 30_000 },
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  },
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: mocks.config,
}))

import { WebSocketGateway, sessionRevocationReason } from '../WebSocketGateway.js'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const VALID_VERIFICATION = {
  valid: true,
  bot_id: BOT_ID,
  username: 'testbot',
  scopes: ['bot'],
}

const tableCalls: { table: string; method: string; args: any[] }[] = []

/**
 * Heartbeat payloads passed to `.update()` on bot_presence, in call order.
 * Terminated sockets from an earlier test can still emit an offline update here,
 * so status writes are excluded.
 */
function heartbeatUpdates(): any[] {
  return tableCalls
    .filter((c) => c.table === 'bot_presence' && c.method === 'update')
    .map((c) => c.args[0])
    .filter((payload) => payload && 'latency_ms' in payload)
}

/**
 * Every builder method chains and resolves empty. Presence writes end in a bare
 * `.then()` with no callback, so the thenable has to tolerate that.
 */
function stubTables() {
  const settle = (resolve?: (r: unknown) => unknown) => {
    const result = { data: null, error: null }
    return typeof resolve === 'function' ? resolve(result) : Promise.resolve(result)
  }
  mocks.from.mockImplementation((table: string) => {
    const builder: any = new Proxy(
      { then: settle },
      {
        get(target, prop) {
          if (prop in target) return (target as any)[prop]
          return (...args: any[]) => {
            tableCalls.push({ table, method: String(prop), args })
            return builder
          }
        },
      },
    )
    return builder
  })
}

let wss: WebSocketServer
let gateway: WebSocketGateway
let url: string
const sockets: WebSocket[] = []

function connect(): Promise<WebSocket> {
  const ws = new WebSocket(url)
  sockets.push(ws)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/** Next frame, or the close code if the socket closes first. */
function nextEvent(ws: WebSocket, timeoutMs = 2000): Promise<{ frame?: any; close?: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no frame and no close within ${timeoutMs}ms`)),
      timeoutMs,
    )
    ws.once('message', (raw) => {
      clearTimeout(timer)
      resolve({ frame: JSON.parse(raw.toString()) })
    })
    ws.once('close', (code) => {
      clearTimeout(timer)
      resolve({ close: code })
    })
  })
}

async function identify(token?: string) {
  const ws = await connect()
  ws.send(JSON.stringify({ op: 2, d: token === undefined ? {} : { token } }))
  return { ws, event: await nextEvent(ws) }
}

beforeEach(async () => {
  mocks.rpc.mockReset()
  tableCalls.length = 0
  mocks.config.websocket.heartbeatInterval = 30_000
  mocks.config.websocket.revalidateIntervalMs = 30_000
  stubTables()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})

  wss = new WebSocketServer({ port: 0, path: '/gateway' })
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  gateway = new WebSocketGateway(wss)
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/gateway`
})

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  gateway.shutdown()
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  vi.restoreAllMocks()
})

describe('gateway IDENTIFY', () => {
  it('closes 4001 when the payload carries no token', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    const { event } = await identify()

    expect(event.close).toBe(4001)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('closes 4004 on a token the RPC rejects', async () => {
    mocks.rpc.mockResolvedValue({ data: { valid: false }, error: null })
    const { event } = await identify(TOKEN)

    expect(event.close).toBe(4004)
  })

  it('answers READY with the bot identity, a session id and the heartbeat interval', async () => {
    mocks.rpc.mockResolvedValue({ data: VALID_VERIFICATION, error: null })
    const { event } = await identify(TOKEN)

    expect(mocks.rpc).toHaveBeenCalledWith('verify_bot_token', { p_token_hash: TOKEN_SHA256 })
    expect(event.frame).toMatchObject({
      op: 0,
      t: 'READY',
      d: {
        bot: { id: BOT_ID, username: 'testbot' },
        heartbeat_interval: 30_000,
      },
    })
    expect(event.frame.d.session_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(gateway.getConnectedBotCount()).toBe(1)
  })

  it('refuses the connection when the RPC fails', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '42703', message: 'column "is_active" does not exist' },
    })
    const { event } = await identify(TOKEN)

    expect(event.close).toBe(4004)
    expect(gateway.getConnectedBotCount()).toBe(0)
  })

  const refusals: Array<[string, { data: unknown; error: unknown }, string]> = [
    ['a rejected token', { data: { valid: false, error: 'Invalid or expired token' }, error: null }, 'Invalid or expired token'],
    ['an inactive bot', { data: { valid: false, error: 'Bot not found or inactive' }, error: null }, 'Bot not found or inactive'],
    ['a refusal without a reason', { data: { valid: false }, error: null }, 'Invalid or expired token'],
    ['a failed lookup', { data: null, error: { code: '57014', message: 'canceling statement' } }, 'Token verification unavailable'],
  ]
  for (const [what, verification, reason] of refusals) {
    it(`closes 4004 naming the cause for ${what}`, async () => {
      mocks.rpc.mockResolvedValue(verification)
      const ws = await connect()
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        ws.once('close', (code, raw) => resolve({ code, reason: raw.toString() })),
      )
      ws.send(JSON.stringify({ op: 2, d: { token: TOKEN } }))

      expect(await closed).toEqual({ code: 4004, reason })
    })
  }
})

describe('gateway frames', () => {
  it('acknowledges a heartbeat with op 11', async () => {
    mocks.rpc.mockResolvedValue({ data: VALID_VERIFICATION, error: null })
    const { ws } = await identify(TOKEN)

    ws.send(JSON.stringify({ op: 1 }))
    const event = await nextEvent(ws)

    expect(event.frame).toEqual({ op: 11 })
  })

  it('records the arrival delay past the advertised interval as latency', async () => {
    mocks.rpc.mockResolvedValue({ data: VALID_VERIFICATION, error: null })
    let clock = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    const { ws } = await identify(TOKEN)
    clock += 30_000 + 120
    ws.send(JSON.stringify({ op: 1 }))
    await nextEvent(ws)

    await vi.waitFor(() =>
      expect(heartbeatUpdates()).toContainEqual({
        last_heartbeat_at: new Date(clock).toISOString(),
        latency_ms: 120,
      }),
    )
  })

  it('clamps latency to 0 when a heartbeat arrives early', async () => {
    mocks.rpc.mockResolvedValue({ data: VALID_VERIFICATION, error: null })
    let clock = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    const { ws } = await identify(TOKEN)
    clock += 5_000
    ws.send(JSON.stringify({ op: 1 }))
    await nextEvent(ws)

    await vi.waitFor(() =>
      expect(heartbeatUpdates()).toContainEqual(expect.objectContaining({ latency_ms: 0 })),
    )
  })

  // latency_ms is an integer column (db_schema/init/08_tables_bots_extended.sql).
  it('measures each heartbeat against the previous one, as a whole number', async () => {
    mocks.rpc.mockResolvedValue({ data: VALID_VERIFICATION, error: null })
    let clock = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    const { ws } = await identify(TOKEN)
    clock += 30_000 + 40
    ws.send(JSON.stringify({ op: 1 }))
    await nextEvent(ws)
    clock += 30_000 + 900
    ws.send(JSON.stringify({ op: 1 }))
    await nextEvent(ws)

    await vi.waitFor(() => expect(heartbeatUpdates()).toHaveLength(2))
    expect(heartbeatUpdates().map((u) => u.latency_ms)).toEqual([40, 900])
    for (const update of heartbeatUpdates()) {
      expect(Number.isInteger(update.latency_ms)).toBe(true)
    }
  })

  it('ignores a heartbeat from an unidentified socket', async () => {
    const ws = await connect()
    ws.send(JSON.stringify({ op: 1 }))

    await expect(nextEvent(ws, 300)).rejects.toThrow(/no frame and no close/)
  })

  it('closes 1008 on an unparseable payload', async () => {
    const ws = await connect()
    ws.send('not json')
    const event = await nextEvent(ws)

    expect(event.close).toBe(1008)
  })

  it('drops the bot from the connected set when the socket closes', async () => {
    mocks.rpc.mockResolvedValue({ data: VALID_VERIFICATION, error: null })
    const { ws } = await identify(TOKEN)
    expect(gateway.getConnectedBotCount()).toBe(1)

    ws.close()
    await vi.waitFor(() => expect(gateway.getConnectedBotCount()).toBe(0))
  })
})

describe('session revalidation', () => {
  const TOKEN_ROW = {
    id: '00000000-0000-0000-0000-0000000000f1',
    bot_id: BOT_ID,
    token_hash: TOKEN_SHA256,
    is_active: true,
    revoked_at: null,
    expires_at: null,
  }

  function seed() {
    const db = new FakeDb({
      bot_tokens: [TOKEN_ROW],
      bots: [{ id: BOT_ID, username: 'testbot', is_active: true }],
      bot_presence: [],
    })
    mocks.from.mockImplementation((table: string) => db.from(table))
    mocks.rpc.mockResolvedValue({ data: VALID_VERIFICATION, error: null })
    return db
  }

  function closeOf(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no close within ${timeoutMs}ms`)), timeoutMs)
      ws.once('close', (code, reason) => {
        clearTimeout(timer)
        resolve({ code, reason: reason.toString() })
      })
    })
  }

  /** The server-side close handler has run: it writes status offline to bot_presence. */
  async function serverClosed(db: FakeDb) {
    await vi.waitFor(() =>
      expect(db.writesTo('bot_presence', 'update').some((w) => w.rows.some((r) => r.status === 'offline'))).toBe(true),
    )
  }

  const revocations: Array<[string, (db: FakeDb) => void, string]> = [
    ['the token is revoked', (db) => Object.assign(db.rows('bot_tokens')[0], { is_active: false, revoked_at: new Date().toISOString() }), 'Token revoked'],
    ['the token row is gone', (db) => db.rows('bot_tokens').splice(0), 'Token revoked'],
    ['the token has expired', (db) => Object.assign(db.rows('bot_tokens')[0], { expires_at: '2020-01-01T00:00:00Z' }), 'Token expired'],
    ['the bot is deactivated', (db) => Object.assign(db.rows('bots')[0], { is_active: false }), 'Bot inactive'],
    ['the bot is deleted', (db) => db.rows('bots').splice(0), 'Bot inactive'],
  ]

  for (const [when, mutate, reason] of revocations) {
    it(`closes an open session with 4004 when ${when}`, async () => {
      const db = seed()
      const { ws, event } = await identify(TOKEN)
      expect(event.frame.t).toBe('READY')

      mutate(db)
      const closed = closeOf(ws)
      await gateway.revalidateSessions()

      expect(await closed).toEqual({ code: 4004, reason })
      expect(gateway.isBotConnected(BOT_ID)).toBe(false)
      await serverClosed(db)
    })
  }

  it('keeps a session whose token and bot are valid', async () => {
    seed()
    const { ws } = await identify(TOKEN)
    await gateway.revalidateSessions()

    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(gateway.isBotConnected(BOT_ID)).toBe(true)
  })

  // A database hiccup must not disconnect every bot; 4004 tells clients not to reconnect.
  it('closes nothing when the lookup fails', async () => {
    const db = seed()
    const { ws } = await identify(TOKEN)
    db.rows('bot_tokens').splice(0)
    db.failures.bot_tokens = { message: 'connection reset' }
    await gateway.revalidateSessions()

    expect(ws.readyState).toBe(WebSocket.OPEN)
  })

  it('runs on the configured interval', async () => {
    gateway.shutdown()
    wss.removeAllListeners('connection')
    mocks.config.websocket.revalidateIntervalMs = 50
    gateway = new WebSocketGateway(wss)

    const db = seed()
    const { ws } = await identify(TOKEN)
    const closed = closeOf(ws)
    db.rows('bot_tokens')[0].is_active = false

    expect(await closed).toEqual({ code: 4004, reason: 'Token revoked' })
    await serverClosed(db)
  })

  it('reads revocation from revoked_at where bot_tokens has no is_active column', () => {
    const conn = { botId: BOT_ID, tokenHash: TOKEN_SHA256 }
    const { is_active: _dropped, ...stagingRow } = TOKEN_ROW
    const bots = [{ id: BOT_ID, is_active: true }]

    expect(sessionRevocationReason(conn, [stagingRow], bots, Date.now())).toBeNull()
    expect(
      sessionRevocationReason(conn, [{ ...stagingRow, revoked_at: '2026-10-01T00:00:00Z' }], bots, Date.now()),
    ).toBe('Token revoked')
  })
})

describe('bridge data registration (op 6)', () => {
  const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
  const OTHER_SERVER = '00000000-0000-0000-0000-00000000005b'
  const GENERAL = '00000000-0000-0000-0000-0000000000c1'
  const MODS_ONLY = '00000000-0000-0000-0000-0000000000c2'
  const ELSEWHERE = '00000000-0000-0000-0000-0000000000c9'
  const EVERYONE_ROLE = '00000000-0000-0000-0000-0000000000e0'
  const MEMBER = { id: '80351110224678912', username: 'alice', displayName: 'Alice', avatarUrl: '', source: 'discord' }
  const conn = { botId: BOT_ID, username: 'bridge', scopes: [], lastHeartbeat: 0, sessionId: 's', tokenHash: 'h' }

  function seed(install: Record<string, unknown> = {}) {
    const db = new FakeDb({
      channels: [
        { id: GENERAL, server_id: SERVER_ID },
        { id: MODS_ONLY, server_id: SERVER_ID },
        { id: ELSEWHERE, server_id: OTHER_SERVER },
      ],
      server_roles: [{ id: EVERYONE_ROLE, server_id: SERVER_ID, permissions: 122646786, is_default: true }],
      channel_permission_overrides: [
        { id: 'ov1', channel_id: MODS_ONLY, role_id: EVERYONE_ROLE, user_id: null, allow_permissions: 0, deny_permissions: 2 },
      ],
      bot_server_permissions: [
        { id: 'i1', bot_id: BOT_ID, server_id: SERVER_ID, is_active: true, read_messages: true, ...install },
      ],
    })
    mocks.from.mockImplementation((table: string) => db.from(table))
  }

  const register = () =>
    (gateway as any).handleBridgeDataRegistration(conn, {
      channels: [{ harmonyChannelId: GENERAL }, { harmonyChannelId: MODS_ONLY }, { harmonyChannelId: ELSEWHERE }],
      members: [MEMBER],
    })

  it('keeps channels the bot sees and drops hidden ones and other servers', async () => {
    seed()
    await register()

    expect(gateway.getBridgedUsers(GENERAL)).toEqual([MEMBER])
    expect(gateway.getBridgedUsers(MODS_ONLY)).toEqual([])
    expect(gateway.getBridgedUsers(ELSEWHERE)).toEqual([])
  })

  it('keeps a hidden channel named in allowed_channel_ids', async () => {
    seed({ allowed_channel_ids: [GENERAL, MODS_ONLY] })
    await register()

    expect(gateway.getBridgedUsers(MODS_ONLY)).toEqual([MEMBER])
  })

  it('drops every channel when visibility cannot be established', async () => {
    seed()
    const db = new FakeDb({})
    db.failures.channel_permission_overrides = { message: 'connection reset' }
    const from = mocks.from.getMockImplementation()!
    mocks.from.mockImplementation((table: string) =>
      table === 'channel_permission_overrides' ? db.from(table) : from(table),
    )
    await register()

    expect(gateway.getBridgedUsers(GENERAL)).toEqual([])
  })
})

describe('bridge data registration (op 6) across servers', () => {
  const SERVER_A = '00000000-0000-0000-0000-00000000006a'
  const SERVER_B = '00000000-0000-0000-0000-00000000006b'
  const CHANNEL_A = '00000000-0000-0000-0000-0000000006c1'
  const CHANNEL_A2 = '00000000-0000-0000-0000-0000000006c2'
  const CHANNEL_B = '00000000-0000-0000-0000-0000000006c3'
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const ALICE = { id: '80351110224678912', username: 'alice', displayName: 'Alice', avatarUrl: '', source: 'discord' }
  const BOB = { id: '80351110224678913', username: 'bob', displayName: 'Bob', avatarUrl: '', source: 'discord' }
  const conn = { botId: BOT_ID, username: 'bridge', scopes: [], lastHeartbeat: 0, sessionId: 's', tokenHash: 'h' }
  let db: FakeDb

  /** PostgREST refuses an `in` list holding a value its uuid column cannot parse. */
  function strictFrom(table: string) {
    const query = db.from(table)
    const inFilter = query.in.bind(query)
    ;(query as any).in = (column: string, values: readonly unknown[]) => {
      if (column === 'id' && table === 'channels' && values.some((v) => typeof v !== 'string' || !UUID_SHAPE.test(v))) {
        return Promise.resolve({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } })
      }
      return inFilter(column, values)
    }
    return query
  }

  beforeEach(() => {
    db = new FakeDb({
      channels: [
        { id: CHANNEL_A, server_id: SERVER_A },
        { id: CHANNEL_A2, server_id: SERVER_A },
        { id: CHANNEL_B, server_id: SERVER_B },
      ],
      server_roles: [
        { id: 'ea', server_id: SERVER_A, permissions: 122646786, is_default: true },
        { id: 'eb', server_id: SERVER_B, permissions: 122646786, is_default: true },
      ],
      channel_permission_overrides: [],
      bot_server_permissions: [
        { id: 'ia', bot_id: BOT_ID, server_id: SERVER_A, is_active: true, read_messages: true },
        { id: 'ib', bot_id: BOT_ID, server_id: SERVER_B, is_active: true, read_messages: true },
      ],
    })
    mocks.from.mockImplementation(strictFrom)
  })

  const register = (d: unknown) => (gateway as any).handleBridgeDataRegistration(conn, d)

  // v1 HarmonyClient.registerBridgeData sends the first guild's members at the root and every
  // channel's own list, empty for a guild whose members are not cached yet.
  it('keeps one guild\'s members out of another server\'s channels', async () => {
    await register({
      channels: [
        { harmonyChannelId: CHANNEL_A, discordChannelId: '1', members: [ALICE] },
        { harmonyChannelId: CHANNEL_B, discordChannelId: '2', members: [] },
      ],
      members: [ALICE],
    })

    expect(gateway.getBridgedUsers(CHANNEL_A)).toEqual([ALICE])
    expect(gateway.getBridgedUsers(CHANNEL_B)).toEqual([])
    expect(gateway.getBridgedUsersForServer([CHANNEL_B])).toEqual([])
  })

  it('applies root members to channels without a list of their own in one server', async () => {
    await register({ channels: [{ harmonyChannelId: CHANNEL_A }, { harmonyChannelId: CHANNEL_A2 }], members: [ALICE] })

    expect(gateway.getBridgedUsers(CHANNEL_A)).toEqual([ALICE])
    expect(gateway.getBridgedUsers(CHANNEL_A2)).toEqual([ALICE])
  })

  it('ignores root members that would span servers', async () => {
    await register({ channels: [{ harmonyChannelId: CHANNEL_A }, { harmonyChannelId: CHANNEL_B }], members: [ALICE] })

    expect(gateway.getBridgedUsers(CHANNEL_A)).toEqual([])
    expect(gateway.getBridgedUsers(CHANNEL_B)).toEqual([])
  })

  it('drops a mapping that is not a uuid and keeps the rest', async () => {
    await register({
      channels: [
        { harmonyChannelId: 'general', members: [BOB] },
        { harmonyChannelId: CHANNEL_A, members: [ALICE] },
      ],
    })

    expect(gateway.getBridgedUsers(CHANNEL_A)).toEqual([ALICE])
    expect(gateway.getBridgedUsers('general')).toEqual([])
  })

  it('keeps the previous registration when a lookup fails', async () => {
    await register({ channels: [{ harmonyChannelId: CHANNEL_A, members: [ALICE] }] })
    db.failures.bot_server_permissions = { message: 'connection reset' }
    await register({ channels: [{ harmonyChannelId: CHANNEL_A, members: [BOB] }] })

    expect(gateway.getBridgedUsers(CHANNEL_A)).toEqual([ALICE])
  })

  it('replaces the previous registration', async () => {
    await register({ channels: [{ harmonyChannelId: CHANNEL_A, members: [ALICE] }, { harmonyChannelId: CHANNEL_B, members: [BOB] }] })
    await register({ channels: [{ harmonyChannelId: CHANNEL_A, members: [BOB] }] })

    expect(gateway.getBridgedUsers(CHANNEL_A)).toEqual([BOB])
    expect(gateway.getBridgedUsers(CHANNEL_B)).toEqual([])
  })
})
