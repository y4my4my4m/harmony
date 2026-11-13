import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const OTHER_BOT = '00000000-0000-0000-0000-0000000000b9'
const BRIDGE_ID = '00000000-0000-0000-0000-0000000000f0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const GENERAL = '00000000-0000-0000-0000-0000000000c1'
const IMPORT_ID = '00000000-0000-0000-0000-0000000000a1'
const THREAD_ID = '00000000-0000-0000-0000-0000000000d1'
const TOKEN = 'harmony_bot_bridge'
const D1 = '200000000000000001'
const M1 = '300000000000000001'
const M2 = '300000000000000002'
const CDN = 'https://cdn.discordapp.com/attachments/1/2/cat.png'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  applyPolicy: vi.fn(),
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
vi.mock('../../utils/mirrorExternalMedia.js', () => ({ applyBridgeAttachmentPolicy: mocks.applyPolicy }))

import { BridgeV2API } from '../BridgeV2API.js'
import { prepareBotMessageContent } from '../messageContent.js'

type RpcResult = { data: unknown; error: { code?: string; message: string; details?: string } | null }
let db: FakeDb
let rpcHandlers: Record<string, (args: any) => RpcResult>
let botId = BOT_ID

const job = (over: Record<string, unknown> = {}) => ({
  id: IMPORT_ID, bridge_id: BRIDGE_ID, harmony_channel_id: GENERAL, discord_channel_id: D1,
  state: 'running', phase: 'messages', cancel_requested: false, imported_count: 0, ...over,
})

function seed() {
  db = new FakeDb({
    discord_bridges: [
      { id: BRIDGE_ID, server_id: SERVER_ID, bot_id: BOT_ID, mode: 'self', discord_guild_id: '100000000000000001', settings: {}, updated_at: '2026-10-07T10:00:00.000Z' },
    ],
    discord_bridge_imports: [
      job(),
      job({ id: '00000000-0000-0000-0000-0000000000a2', bridge_id: 'other-bridge' }),
    ],
    channels: [{ id: GENERAL, server_id: SERVER_ID, name: 'general', type: 0, category: null, order: 1 }],
  })
  mocks.from.mockImplementation((table: string) => db.from(table))
}

function makeApp() {
  const app = express()
  app.set('trust proxy', 'loopback')
  app.use(express.json())
  app.use('/bridge/v2', new BridgeV2API().router)
  return app
}

const auth = { Authorization: `Bot ${TOKEN}` }
const rpcCalls = (fn: string) => mocks.rpc.mock.calls.filter(([name]) => name === fn).map(([, args]) => args)
const rpcError = (message: string, code: string, details?: string): RpcResult => ({ data: null, error: { code, message, details } })

beforeEach(() => {
  seed()
  botId = BOT_ID
  rpcHandlers = {
    verify_bot_token: () => ({ data: { valid: true, bot_id: botId, username: 'bridge', scopes: ['bot'] }, error: null }),
    check_and_increment_bot_rate_limit: () => ({ data: false, error: null }),
    bridge_import_present_ids: () => ({ data: [], error: null }),
    discord_bridge_import_block: () => ({ data: null, error: null }),
    bridge_import_admit: () => ({ data: { admitted: true }, error: null }),
  }
  mocks.rpc.mockReset()
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    const handler = rpcHandlers[fn]
    if (!handler) throw new Error(`test called unmocked rpc: ${fn}`)
    return handler(args)
  })
  mocks.applyPolicy.mockReset()
  mocks.applyPolicy.mockImplementation(async (parts: any[]) => ({ parts, deferred: false }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

const message = (over: Record<string, unknown> = {}) => ({
  discord_message_id: M1,
  created_at: '2020-01-01T00:00:00.000Z',
  content: [{ type: 'text', text: 'hello' }],
  discord_user: { id: '400000000000000001', username: 'old' },
  ...over,
})

describe('Bridge v2 import endpoints', () => {
  it('refuses a bot that is not a bridge', async () => {
    botId = OTHER_BOT
    const res = await supertest(makeApp()).get('/bridge/v2/imports').set(auth)
    expect(res.status).toBe(403)
  })

  it('answers 403 import_disabled on every route while the switch is off or the bridge may not import', async () => {
    for (const reason of ['instance_off', 'bridge_mode']) {
      rpcHandlers.discord_bridge_import_block = () => ({ data: reason, error: null })
      const app = makeApp()
      const calls = [
        supertest(app).get('/bridge/v2/imports'),
        supertest(app).get(`/bridge/v2/imports/${IMPORT_ID}`),
        supertest(app).post('/bridge/v2/imports').send({}),
        supertest(app).patch(`/bridge/v2/imports/${IMPORT_ID}`).send({ state: 'running' }),
        supertest(app).post(`/bridge/v2/imports/${IMPORT_ID}/cancel`),
        supertest(app).post(`/bridge/v2/imports/${IMPORT_ID}/messages`).send({ messages: [message()] }),
        supertest(app).post(`/bridge/v2/imports/${IMPORT_ID}/threads`).send({}),
        supertest(app).post(`/bridge/v2/imports/${IMPORT_ID}/replies/link`),
      ]
      for (const call of calls) {
        const res = await call.set(auth)
        expect(res.status).toBe(403)
        expect(res.body).toEqual({ code: 'import_disabled', reason })
      }
    }
    expect(rpcCalls('discord_bridge_import_block')[0]).toEqual({ p_bridge_id: BRIDGE_ID })
    for (const fn of ['discord_bridge_import_start_internal', 'discord_bridge_import_update', 'bridge_import_messages', 'bridge_import_thread']) {
      expect(rpcCalls(fn)).toEqual([])
    }
  })

  it('answers 503 when the switch cannot be read', async () => {
    rpcHandlers.discord_bridge_import_block = () => rpcError('boom', 'XX000')
    expect((await supertest(makeApp()).get('/bridge/v2/imports').set(auth)).status).toBe(503)
    rpcHandlers.discord_bridge_import_block = () => { throw new Error('network') }
    expect((await supertest(makeApp()).get('/bridge/v2/imports').set(auth)).status).toBe(503)
  })

  it('GET /imports/:id returns one job of this bridge; another bridge\'s is 404', async () => {
    const ok = await supertest(makeApp()).get(`/bridge/v2/imports/${IMPORT_ID}`).set(auth)
    expect(ok.status).toBe(200)
    expect(ok.body.import.id).toBe(IMPORT_ID)
    const other = await supertest(makeApp()).get('/bridge/v2/imports/00000000-0000-0000-0000-0000000000a2').set(auth)
    expect(other.status).toBe(404)
    expect(other.body.code).toBe('import_not_found')
  })

  it('POST /imports passes the Discord member who ran the command', async () => {
    rpcHandlers.discord_bridge_import_start_internal = () => ({ data: [job({ state: 'queued' })], error: null })
    await supertest(makeApp()).post('/bridge/v2/imports').set(auth)
      .send({ requested_by: { id: '400000000000000009', username: 'mod', avatar: 'x' } })
    expect(rpcCalls('discord_bridge_import_start_internal')[0].p_requested_by_remote)
      .toEqual({ id: '400000000000000009', username: 'mod' })
    await supertest(makeApp()).post('/bridge/v2/imports').set(auth).send({})
    expect(rpcCalls('discord_bridge_import_start_internal')[1].p_requested_by_remote).toBeNull()
  })

  it('PATCH maps import_busy to 429 with Retry-After and import_disabled to 403', async () => {
    rpcHandlers.discord_bridge_import_update = () => rpcError('import_busy', '53400', '30')
    const busy = await supertest(makeApp()).patch(`/bridge/v2/imports/${IMPORT_ID}`).set(auth).send({ state: 'running' })
    expect(busy.status).toBe(429)
    expect(busy.headers['retry-after']).toBe('30')
    expect(busy.body).toEqual({ code: 'import_busy', retry_after: 30 })
    rpcHandlers.discord_bridge_import_update = () => rpcError('import_disabled', '0A000', 'instance_off')
    const off = await supertest(makeApp()).patch(`/bridge/v2/imports/${IMPORT_ID}`).set(auth).send({ state: 'running' })
    expect(off.status).toBe(403)
    expect(off.body).toEqual({ code: 'import_disabled', reason: 'instance_off' })
  })

  it('GET /imports returns this bridge\'s jobs only', async () => {
    const res = await supertest(makeApp()).get('/bridge/v2/imports').set(auth)
    expect(res.status).toBe(200)
    expect(res.body.imports).toHaveLength(1)
    expect(res.body.imports[0].id).toBe(IMPORT_ID)
  })

  it('POST /imports without ids starts every importable pair and answers 201', async () => {
    rpcHandlers.discord_bridge_import_start_internal = () => ({ data: [job({ state: 'queued' })], error: null })
    const res = await supertest(makeApp()).post('/bridge/v2/imports').set(auth).send({})
    expect(res.status).toBe(201)
    expect(res.body.imports[0].state).toBe('queued')
    expect(rpcCalls('discord_bridge_import_start_internal')).toEqual([
      { p_bridge_id: BRIDGE_ID, p_discord_channel_ids: null, p_via: 'discord', p_requested_by: null, p_requested_by_remote: null },
    ])
  })

  it('POST /imports passes named channel ids and maps pair_not_importable to 400', async () => {
    rpcHandlers.discord_bridge_import_start_internal = () => rpcError('pair_not_importable', '22023', D1)
    const res = await supertest(makeApp()).post('/bridge/v2/imports').set(auth).send({ discord_channel_ids: [D1] })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ code: 'pair_not_importable', discord_channel_id: D1 })
    expect(rpcCalls('discord_bridge_import_start_internal')[0].p_discord_channel_ids).toEqual([D1])
  })

  it('POST /imports rejects a malformed id list', async () => {
    const res = await supertest(makeApp()).post('/bridge/v2/imports').set(auth).send({ discord_channel_ids: 'x' })
    expect(res.status).toBe(400)
    expect(mocks.rpc.mock.calls.some(([n]) => n === 'discord_bridge_import_start_internal')).toBe(false)
  })

  it('PATCH maps invalid_transition to 409', async () => {
    rpcHandlers.discord_bridge_import_update = () => rpcError('invalid_transition', '55000', 'running -> cancelled')
    const res = await supertest(makeApp()).patch(`/bridge/v2/imports/${IMPORT_ID}`).set(auth).send({ state: 'cancelled' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('invalid_transition')
    expect(rpcCalls('discord_bridge_import_update')[0]).toEqual({
      p_bridge_id: BRIDGE_ID, p_import_id: IMPORT_ID, p_patch: { state: 'cancelled' },
    })
  })

  it('PATCH returns the updated job; bad patches are 400; unknown jobs 404', async () => {
    rpcHandlers.discord_bridge_import_update = () => ({ data: job({ phase: 'threads' }), error: null })
    const ok = await supertest(makeApp()).patch(`/bridge/v2/imports/${IMPORT_ID}`).set(auth).send({ phase: 'threads' })
    expect(ok.status).toBe(200)
    expect(ok.body.import.phase).toBe('threads')

    rpcHandlers.discord_bridge_import_update = () => rpcError('invalid input syntax for type timestamp', '22007')
    const bad = await supertest(makeApp()).patch(`/bridge/v2/imports/${IMPORT_ID}`).set(auth).send({ start_at: 'nope' })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('invalid_patch')

    rpcHandlers.discord_bridge_import_update = () => rpcError('import_not_found', 'P0002')
    const missing = await supertest(makeApp()).patch(`/bridge/v2/imports/${IMPORT_ID}`).set(auth).send({ phase: 'threads' })
    expect(missing.status).toBe(404)
    expect(missing.body.code).toBe('import_not_found')

    const notUuid = await supertest(makeApp()).patch('/bridge/v2/imports/nope').set(auth).send({ phase: 'threads' })
    expect(notUuid.status).toBe(404)
  })

  it('POST cancel calls discord_bridge_import_cancel_internal', async () => {
    rpcHandlers.discord_bridge_import_cancel_internal = () => ({ data: [job({ cancel_requested: true })], error: null })
    const res = await supertest(makeApp()).post(`/bridge/v2/imports/${IMPORT_ID}/cancel`).set(auth)
    expect(res.status).toBe(200)
    expect(res.body.imports).toHaveLength(1)
    expect(rpcCalls('discord_bridge_import_cancel_internal')).toEqual([{ p_bridge_id: BRIDGE_ID, p_import_id: IMPORT_ID }])
  })

  describe('POST messages', () => {
    const post = (messages: unknown) =>
      supertest(makeApp()).post(`/bridge/v2/imports/${IMPORT_ID}/messages`).set(auth).send({ messages })

    it('rejects 0 and 101 items and a body that is no list as invalid_batch', async () => {
      for (const body of [
        [],
        Array.from({ length: 101 }, (_, i) => message({ discord_message_id: String(1000 + i) })),
        'nope',
      ]) {
        const res = await post(body)
        expect(res.status).toBe(400)
        expect(res.body.code).toBe('invalid_batch')
      }
      expect(mocks.rpc.mock.calls.some(([n]) => n === 'bridge_import_messages')).toBe(false)
    })

    it('rejects a message with a bad field alone and stores the rest of the batch', async () => {
      rpcHandlers.bridge_import_messages = (args) => ({
        data: { inserted: args.p_messages.map((m: any) => ({ discord_message_id: m.discord_message_id, id: 'row' })), skipped: [], rejected: [] },
        error: null,
      })
      const bad = [
        message({ discord_message_id: '501', created_at: 'not a date' }),
        message({ discord_message_id: '502', content: 'text' }),
        message({ discord_message_id: '503', discord_user: [] }),
        message({ discord_message_id: '504', thread_id: 'x' }),
        message({ discord_message_id: '505', pinned: 'yes' }),
      ]
      const res = await post([...bad, message({ discord_message_id: 'abc' }), message()])
      expect(res.status).toBe(200)
      expect(res.body.inserted).toEqual([{ discord_message_id: M1, id: 'row' }])
      expect(res.body.rejected).toEqual(bad.map((m) => ({ discord_message_id: m.discord_message_id, reason: 'invalid' })))
      expect(res.body.skipped).toEqual(['501', '502', '503', '504', '505'])
      expect(rpcCalls('bridge_import_messages')[0].p_messages.map((m: any) => m.discord_message_id)).toEqual([M1])
    })

    it('rejects a message dated more than a minute ahead as future_date, before preparing it', async () => {
      const ahead = new Date(Date.now() + 5 * 60_000).toISOString()
      const res = await post([
        message({ discord_message_id: '601', created_at: ahead }),
        message({ discord_message_id: '602', edited_at: ahead }),
      ])
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        inserted: [],
        skipped: ['601', '602'],
        rejected: [
          { discord_message_id: '601', reason: 'future_date' },
          { discord_message_id: '602', reason: 'future_date' },
        ],
      })
      expect(mocks.applyPolicy).not.toHaveBeenCalled()
      expect(rpcCalls('bridge_import_messages')).toEqual([])
    })

    it('answers 429 import_rate_limited with Retry-After when the minute is full, before preparing anything', async () => {
      rpcHandlers.bridge_import_admit = () => ({ data: { admitted: false, retry_after: 17 }, error: null })
      const res = await post([message(), message({ discord_message_id: M2 })])
      expect(res.status).toBe(429)
      expect(res.headers['retry-after']).toBe('17')
      expect(res.body).toEqual({ code: 'import_rate_limited', retry_after: 17 })
      expect(rpcCalls('bridge_import_admit')).toEqual([{ p_bot_id: BOT_ID, p_import_id: IMPORT_ID, p_count: 2 }])
      expect(mocks.applyPolicy).not.toHaveBeenCalled()
      expect(rpcCalls('bridge_import_messages')).toEqual([])
    })

    it('answers 409 when admission finds the job no longer running', async () => {
      rpcHandlers.bridge_import_admit = () => ({ data: { admitted: false, not_running: true, state: 'failed', error: 'import_disabled' }, error: null })
      const res = await post([message()])
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('import_not_running')
      expect(mocks.applyPolicy).not.toHaveBeenCalled()
    })

    it('removes the files mirrored for a message the batch did not store, and keeps the stored one\'s', async () => {
      const mirrorPath = (name: string) => `c/${GENERAL}/bridge/${BOT_ID}/${name}.png`
      mocks.applyPolicy.mockImplementation(async (parts: any[]) => ({
        parts: parts.map((p) => (p.type === 'file' ? { ...p, url: 'https://harmony.test/m', path: mirrorPath(p.name) } : p)),
        deferred: false,
      }))
      rpcHandlers.bridge_import_messages = () => ({
        data: { inserted: [{ discord_message_id: M1, id: 'row-1' }], skipped: [M2], rejected: [{ discord_message_id: M2, reason: 'opted_out' }] },
        error: null,
      })
      rpcHandlers.message_media_deletable = () => ({ data: [], error: null })
      const file = (name: string) => ({ type: 'file', url: CDN, name })
      const res = await post([
        message({ content: [file('kept')] }),
        message({ discord_message_id: M2, content: [file('dropped')] }),
      ])
      expect(res.status).toBe(200)
      expect(rpcCalls('message_media_deletable').map((c) => c.p_paths)).toEqual([[mirrorPath('dropped')]])
    })

    it('removes every mirrored file when the insert function fails', async () => {
      const mirrorPath = `c/${GENERAL}/bridge/${BOT_ID}/a.png`
      mocks.applyPolicy.mockImplementation(async (parts: any[]) => ({
        parts: parts.map((p) => (p.type === 'file' ? { ...p, url: 'https://harmony.test/m', path: mirrorPath } : p)),
        deferred: false,
      }))
      rpcHandlers.bridge_import_messages = () => rpcError('import_not_running', '55000', 'failed')
      rpcHandlers.message_media_deletable = () => ({ data: [], error: null })
      const res = await post([message({ content: [{ type: 'file', url: CDN, name: 'a' }] })])
      expect(res.status).toBe(409)
      expect(rpcCalls('message_media_deletable').map((c) => c.p_paths)).toEqual([[mirrorPath]])
    })

    it('writes user and role mentions as text', async () => {
      rpcHandlers.bridge_import_messages = () => ({ data: { inserted: [], skipped: [], rejected: [] }, error: null })
      await post([message({ content: [
        { type: 'mention', userId: 'u1', username: 'alice', displayName: 'Alice A', domain: 'harmony.test', isLocal: true },
        { type: 'text', text: ' and ' },
        { type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null },
        { type: 'role_mention', roleId: '00000000-0000-0000-0000-0000000000e1', roleName: '@mods', roleColor: '#fff' },
      ] })])
      expect(rpcCalls('bridge_import_messages')[0].p_messages[0].content).toEqual([
        { type: 'text', text: '@Alice A' },
        { type: 'text', text: ' and ' },
        { type: 'text', text: '@here' },
        { type: 'text', text: '@mods' },
      ])
    })

    it('runs each item through prepareBotMessageContent: mirrored CDN parts, no mass mention', async () => {
      mocks.applyPolicy.mockImplementation(async (parts: any[]) => ({
        parts: parts.map((p) => (p.url === CDN ? { ...p, type: 'file', url: 'https://harmony.test/m/cat.png', path: 'bots/cat.png' } : p)),
        deferred: false,
      }))
      rpcHandlers.bridge_import_messages = () => ({ data: { inserted: [], skipped: [] }, error: null })
      const res = await post([
        message({ content: [{ type: 'url', url: CDN }] }),
        message({ discord_message_id: M2, content: [{ type: 'text', text: '@everyone hi' }] }),
      ])
      expect(res.status).toBe(200)
      const [call] = rpcCalls('bridge_import_messages')
      expect(call.p_bot_id).toBe(BOT_ID)
      expect(call.p_import_id).toBe(IMPORT_ID)
      expect(call.p_messages[0].content).toEqual([
        { type: 'file', url: 'https://harmony.test/m/cat.png', path: 'bots/cat.png' },
      ])
      expect(call.p_messages[1].content).toEqual([{ type: 'text', text: '@everyone hi' }])
      expect(mocks.applyPolicy.mock.calls[0].slice(1)).toEqual([BOT_ID, GENERAL])
    })

    it('queues only inserted messages whose attachments were deferred', async () => {
      const M3 = '300000000000000003'
      mocks.applyPolicy.mockImplementation(async (parts: any[]) => ({
        parts, deferred: parts.some((p) => p.url === CDN),
      }))
      rpcHandlers.bridge_mirror_enqueue = () => ({ data: 1, error: null })
      rpcHandlers.bridge_import_messages = () => ({
        data: {
          inserted: [{ discord_message_id: M1, id: 'row-a' }, { discord_message_id: M2, id: 'row-b' }],
          skipped: [M3],
          rejected: [{ discord_message_id: M3, reason: 'bad' }],
        },
        error: null,
      })
      const res = await post([
        message({ content: [{ type: 'text', text: 'plain' }] }),
        message({ discord_message_id: M2, content: [{ type: 'url', url: CDN }] }),
        message({ discord_message_id: M3, content: [{ type: 'url', url: CDN }] }),
      ])
      expect(res.status).toBe(200)
      expect(rpcCalls('bridge_mirror_enqueue')).toEqual([{ p_message_ids: ['row-b'] }])
    })

    it('does not queue anything when no message was deferred', async () => {
      rpcHandlers.bridge_import_messages = () => ({ data: { inserted: [{ discord_message_id: M1, id: 'row-a' }], skipped: [] }, error: null })
      await post([message()])
      expect(rpcCalls('bridge_mirror_enqueue')).toEqual([])
    })

    it('does not turn a string @everyone into a mass mention either', async () => {
      rpcHandlers.bridge_import_messages = () => ({ data: { inserted: [], skipped: [] }, error: null })
      // content must be an array, but a text part carrying @everyone stays text; the role lookup never happens
      await post([message({ content: [{ type: 'text', text: '@here @everyone' }] })])
      expect(rpcCalls('bridge_import_messages')[0].p_messages[0].content).toEqual([{ type: 'text', text: '@here @everyone' }])
      expect(mocks.rpc.mock.calls.some(([n]) => n === 'check_bot_permission')).toBe(false)
    })

    it('drops messages whose content is empty and counts them as skipped', async () => {
      rpcHandlers.bridge_import_messages = (args) => ({
        data: { inserted: args.p_messages.map((m: any) => ({ discord_message_id: m.discord_message_id, id: 'row' })), skipped: [] },
        error: null,
      })
      const res = await post([message({ discord_message_id: M1, content: [] }), message({ discord_message_id: M2 })])
      expect(res.status).toBe(200)
      expect(rpcCalls('bridge_import_messages')[0].p_messages.map((m: any) => m.discord_message_id)).toEqual([M2])
      expect(res.body.inserted).toEqual([{ discord_message_id: M2, id: 'row' }])
      expect(res.body.skipped).toEqual([M1])
    })

    it('refuses a job that is not running before preparing anything', async () => {
      db.tables.discord_bridge_imports[0].state = 'paused'
      const res = await post([message({ content: [{ type: 'url', url: CDN }] })])
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('import_not_running')
      expect(mocks.applyPolicy).not.toHaveBeenCalled()
      expect(mocks.rpc.mock.calls.some(([n]) => n === 'bridge_import_messages')).toBe(false)
    })

    it('skips ids already in the channel without preparing them', async () => {
      rpcHandlers.bridge_import_present_ids = (args) => ({ data: args.p_ids.filter((id: string) => id === M1), error: null })
      rpcHandlers.bridge_import_messages = (args) => ({
        data: { inserted: args.p_messages.map((m: any) => ({ discord_message_id: m.discord_message_id, id: 'row' })), skipped: [] },
        error: null,
      })
      const res = await post([message(), message({ discord_message_id: M2 }), message({ discord_message_id: '300000000000000003' })])
      expect(res.status).toBe(200)
      expect(rpcCalls('bridge_import_present_ids')[0]).toEqual({
        p_bot_id: BOT_ID, p_import_id: IMPORT_ID, p_ids: [M1, M2, '300000000000000003'],
      })
      expect(mocks.applyPolicy).toHaveBeenCalledTimes(2)
      expect(rpcCalls('bridge_import_messages')[0].p_messages.map((m: any) => m.discord_message_id)).toEqual([M2, '300000000000000003'])
      expect(res.body.skipped).toEqual([M1])

      const all = await post([message()])
      expect(all.body).toEqual({ inserted: [], skipped: [M1] })
      expect(rpcCalls('bridge_import_messages')).toHaveLength(1)
    })

    it('answers 500 when the presence lookup fails', async () => {
      rpcHandlers.bridge_import_present_ids = () => ({ data: null, error: { code: 'XX000', message: 'boom' } })
      const res = await post([message()])
      expect(res.status).toBe(500)
      expect(mocks.rpc.mock.calls.some(([n]) => n === 'bridge_import_messages')).toBe(false)
    })

    it('maps import_not_found from the presence lookup to 404', async () => {
      rpcHandlers.bridge_import_present_ids = () => rpcError('import_not_found', 'P0002')
      expect((await post([message()])).status).toBe(404)
    })

    it('exposes the rejected messages of the RPC and keeps them in skipped', async () => {
      rpcHandlers.bridge_import_messages = () => ({
        data: {
          inserted: [{ discord_message_id: M1, id: 'u1' }],
          skipped: [M2],
          rejected: [{ discord_message_id: M2, reason: 'too_long' }],
        },
        error: null,
      })
      const res = await post([message(), message({ discord_message_id: M2 })])
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        inserted: [{ discord_message_id: M1, id: 'u1' }],
        skipped: [M2],
        rejected: [{ discord_message_id: M2, reason: 'too_long' }],
      })
    })

    it('answers an all-empty batch without calling the RPC', async () => {
      const res = await post([message({ content: [] })])
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ inserted: [], skipped: [M1] })
      expect(mocks.rpc.mock.calls.some(([n]) => n === 'bridge_import_messages')).toBe(false)
    })

    it('passes the RPC\'s inserted and skipped through', async () => {
      rpcHandlers.bridge_import_messages = () => ({
        data: { inserted: [{ discord_message_id: M1, id: 'u1' }], skipped: [M2] }, error: null,
      })
      const res = await post([message(), message({ discord_message_id: M2 })])
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ inserted: [{ discord_message_id: M1, id: 'u1' }], skipped: [M2] })
    })

    it('maps a job failed mid-call (not_running) and import_not_running to 409', async () => {
      rpcHandlers.bridge_import_messages = () => ({
        data: { inserted: [], skipped: [], not_running: true, state: 'failed', error: 'pair_removed' }, error: null,
      })
      const failed = await post([message()])
      expect(failed.status).toBe(409)
      expect(failed.body.code).toBe('import_not_running')

      rpcHandlers.bridge_import_messages = () => rpcError('import_not_running', '55000', 'failed')
      const stopped = await post([message()])
      expect(stopped.status).toBe(409)
      expect(stopped.body.code).toBe('import_not_running')
    })

    it('maps import_not_found to 404 and invalid_message / invalid_thread / cast errors to 400 invalid_batch', async () => {
      rpcHandlers.bridge_import_messages = () => rpcError('import_not_found', 'P0002')
      expect((await post([message()])).status).toBe(404)
      for (const [msg, code] of [['invalid_message', '22023'], ['invalid_thread', '22023'], ['bad timestamp', '22007'], ['bad uuid', '22P02'], ['check', '23514']]) {
        rpcHandlers.bridge_import_messages = () => rpcError(msg, code)
        const res = await post([message()])
        expect(res.status).toBe(400)
        expect(res.body.code).toBe('invalid_batch')
      }
    })
  })

  describe('POST threads', () => {
    const thread = { discord_thread_id: '500000000000000001', name: 'old thread', created_at: '2020-01-01T00:00:00.000Z', archived: true, locked: false }
    const post = (body: unknown) => supertest(makeApp()).post(`/bridge/v2/imports/${IMPORT_ID}/threads`).set(auth).send(body as object)

    it('returns the thread id', async () => {
      rpcHandlers.bridge_import_thread = () => ({ data: THREAD_ID, error: null })
      const res = await post(thread)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ thread_id: THREAD_ID })
      expect(rpcCalls('bridge_import_thread')).toEqual([{ p_bot_id: BOT_ID, p_import_id: IMPORT_ID, p_thread: thread }])
    })

    it('maps a NULL result to 409 import_not_running and bad input to 400 invalid_thread', async () => {
      rpcHandlers.bridge_import_thread = () => ({ data: null, error: null })
      const res = await post(thread)
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('import_not_running')

      rpcHandlers.bridge_import_thread = () => rpcError('invalid_thread', '22023')
      const bad = await post(thread)
      expect(bad.status).toBe(400)
      expect(bad.body.code).toBe('invalid_thread')

      const notObject = await supertest(makeApp()).post(`/bridge/v2/imports/${IMPORT_ID}/threads`).set(auth).send([])
      expect(notObject.status).toBe(400)
      expect(notObject.body.code).toBe('invalid_thread')
    })
  })

  describe('POST replies/link', () => {
    const post = () => supertest(makeApp()).post(`/bridge/v2/imports/${IMPORT_ID}/replies/link`).set(auth)

    it('returns linked, and a NULL result is 409 import_not_running', async () => {
      rpcHandlers.bridge_import_link_replies = () => ({ data: 3, error: null })
      const res = await post()
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ linked: 3 })
      expect(rpcCalls('bridge_import_link_replies')).toEqual([{ p_bot_id: BOT_ID, p_import_id: IMPORT_ID }])

      rpcHandlers.bridge_import_link_replies = () => ({ data: null, error: null })
      const failed = await post()
      expect(failed.status).toBe(409)
      expect(failed.body.code).toBe('import_not_running')
    })

    it('maps import_not_running (55000) to 409 and an unexpected error to 500', async () => {
      rpcHandlers.bridge_import_link_replies = () => rpcError('import_not_running', '55000')
      expect((await post()).status).toBe(409)
      rpcHandlers.bridge_import_link_replies = () => rpcError('boom', 'XX000')
      expect((await post()).status).toBe(500)
    })
  })

  describe('prepareBotMessageContent', () => {
    it('keeps typed @everyone as text for a bridge author and pings it otherwise', async () => {
      db.tables.server_roles = [{ id: '00000000-0000-0000-0000-0000000000e0', server_id: SERVER_ID, is_default: true }]
      rpcHandlers.check_bot_permission = () => ({ data: true, error: null })
      const input = { content: '@everyone hi', channelId: GENERAL, botId: BOT_ID }
      expect((await prepareBotMessageContent({ ...input, metadata: { discord_user: {} } })).parts)
        .toEqual([{ type: 'text', text: '@everyone hi' }])
      expect((await prepareBotMessageContent(input)).parts).toMatchObject([{ type: 'role_mention', roleId: '00000000-0000-0000-0000-0000000000e0' }, { type: 'text' }])
    })
  })
})
