import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005e'
const STICKER_ID = '00000000-0000-0000-0000-0000000000a1'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  store: vi.fn(),
  removeStored: vi.fn(),
  eq: vi.fn(),
  or: vi.fn(),
  order: vi.fn(),
  range: vi.fn(),
  insert: vi.fn(),
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from, storage: { from: () => ({}) } },
  config: {
    supabaseUrl: 'http://localhost:54321',
    port: 3002,
    nodeEnv: 'test',
    instanceDomain: 'harmony.test',
    websocket: { heartbeatInterval: 30_000, maxConnectionsPerBot: 5 },
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  },
}))
vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => {
    req.bot = { id: BOT_ID, username: 'bridge', scopes: ['bot'] }
    next()
  },
  botRateLimit: (_req: any, _res: any, next: any) => next(),
}))
vi.mock('../../utils/discordStickerImport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/discordStickerImport.js')>()),
  storeDiscordSticker: mocks.store,
  removeStoredSticker: mocks.removeStored,
}))

import { BotRestAPI } from '../BotRestAPI.js'
import { StickerFileError } from '../../utils/discordStickerImport.js'

type Result = { data: unknown; error: unknown }
const RECORDED = new Set(['eq', 'or', 'order', 'range', 'insert'])

function routeTables(tables: Record<string, Result>) {
  mocks.from.mockImplementation((table: string) => {
    const result = tables[table] ?? { data: null, error: null }
    const builder: any = new Proxy(
      { single: async () => result, maybeSingle: async () => result, then: (resolve: any) => resolve(result) },
      {
        get: (target, prop: string) => {
          if (prop in target) return (target as any)[prop]
          if (RECORDED.has(prop)) return (...a: unknown[]) => { (mocks as any)[prop](table, ...a); return builder }
          return () => builder
        },
      },
    )
    return builder
  })
}

const app = () => {
  const a = express()
  a.use(express.json())
  a.use('/api/v1', new BotRestAPI().router)
  return a
}

const base = `/api/v1/servers/${SERVER_ID}/stickers`
const post = (body: unknown) => supertest(app()).post(`${base}/discord`).send(body as object)
const row = (status: string) => ({
  status, id: 's1', name: 'wave', description: 'A wave', url: 'https://db.test/s.png', discord_sticker_id: '111', removed: false,
})
const BODY = { discord_sticker_id: '111', name: 'wave', description: 'A wave', format_type: 1 }
const FILE = { path: `server/${SERVER_ID}/u.png`, url: 'https://db.test/storage/v1/object/public/stickers/p', width: 100, height: 90, durationMs: null }
const NO_FILE_ERROR = { code: '22023', message: 'invalid sticker file' }
const bridged = () => routeTables({ discord_bridges: { data: { id: 'b1' }, error: null }, bot_audit_log: { data: null, error: null } })

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.removeStored.mockResolvedValue(undefined)
  mocks.store.mockResolvedValue(FILE)
  bridged()
})

describe('GET /servers/:serverId/stickers/discord', () => {
  const get = () => supertest(app()).get(`${base}/discord`)

  it('lists active and retired linked stickers with the limit', async () => {
    const rows = [
      { id: 's1', name: 'a', description: 'da', url: 'u1', discord_sticker_id: '1', removed_at: null },
      { id: 's2', name: 'b', description: 'db', url: 'u2', discord_sticker_id: '2', removed_at: '2026-01-01' },
    ]
    routeTables({ discord_bridges: { data: { id: 'b1' }, error: null }, stickers: { data: rows, error: null } })
    mocks.rpc.mockResolvedValue({ data: 15, error: null })
    const res = await get()
    expect(res.status).toBe(200)
    expect(mocks.eq).toHaveBeenCalledWith('stickers', 'scope', 'server')
    expect(mocks.eq).toHaveBeenCalledWith('stickers', 'server_id', SERVER_ID)
    expect(mocks.or).toHaveBeenCalledWith('stickers', 'removed_at.is.null,discord_sticker_id.not.is.null')
    expect(mocks.order.mock.calls.map((c) => c[1])).toEqual(['created_at', 'id'])
    expect(mocks.range).toHaveBeenCalledWith('stickers', 0, 4999)
    expect(mocks.rpc).toHaveBeenCalledWith('sticker_limit', { p_scope: 'server' })
    expect(res.body).toEqual({
      limit: 15,
      stickers: [
        { id: 's1', name: 'a', description: 'da', url: 'u1', discord_sticker_id: '1', removed: false },
        { id: 's2', name: 'b', description: 'db', url: 'u2', discord_sticker_id: '2', removed: true },
      ],
    })
  })

  it('answers 500 when the limit is missing', async () => {
    routeTables({ discord_bridges: { data: { id: 'b1' }, error: null }, stickers: { data: [], error: null } })
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    expect((await get()).status).toBe(500)
  })

  it('refuses a bot that is not the bridge', async () => {
    routeTables({ discord_bridges: { data: null, error: null } })
    expect((await get()).status).toBe(403)
  })
})

describe('POST /servers/:serverId/stickers/discord', () => {
  it('rejects a bad snowflake and a bad server id before any lookup', async () => {
    expect((await post({ ...BODY, discord_sticker_id: 'x' })).status).toBe(400)
    expect((await supertest(app()).post('/api/v1/servers/nope/stickers/discord').send(BODY)).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('refuses a bot that does not bridge the server', async () => {
    routeTables({ discord_bridges: { data: null, error: null } })
    expect((await post(BODY)).status).toBe(403)
    expect(mocks.store).not.toHaveBeenCalled()
  })

  it('answers an existing sticker without downloading', async () => {
    mocks.rpc.mockResolvedValue({ data: [row('existing')], error: null })
    const res = await post(BODY)
    expect(res.status).toBe(200)
    expect(mocks.store).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    expect(mocks.rpc.mock.calls[0][1].p_path).toBeNull()
  })

  it('downloads only after invalid sticker file and passes the file fields', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: NO_FILE_ERROR })
      .mockResolvedValueOnce({ data: [row('created')], error: null })
    const res = await post({ ...BODY, format_type: 4 })
    expect(res.status).toBe(201)
    expect(mocks.store).toHaveBeenCalledWith(SERVER_ID, '111', 4)
    expect(mocks.rpc.mock.calls[0][0]).toBe('bridge_import_server_sticker')
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({
      p_bot_id: BOT_ID, p_server_id: SERVER_ID, p_discord_sticker_id: '111', p_name: 'wave', p_description: 'A wave', p_update: false,
    })
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({
      p_path: FILE.path, p_url: FILE.url, p_width: 100, p_height: 90, p_duration_ms: null,
    })
  })

  it('passes p_update when update is set', async () => {
    mocks.rpc.mockResolvedValue({ data: [row('updated')], error: null })
    const res = await post({ ...BODY, update: true })
    expect(res.status).toBe(200)
    expect(mocks.rpc.mock.calls[0][1].p_update).toBe(true)
  })

  it('maps STICKER_LIMIT and 23505 to 409 codes', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'STICKER_LIMIT: 15' } })
    let res = await post(BODY)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('STICKER_LIMIT')
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'STICKER_NAME_TAKEN: wave' } })
    res = await post(BODY)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('STICKER_NAME_TAKEN')
  })

  it('does not call a STICKER_FILE_TAKEN collision a name clash', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'STICKER_FILE_TAKEN: st-1' } })
    const res = await post(BODY)
    expect(res.status).toBe(500)
    expect(res.body.code).toBeUndefined()
  })

  it('maps 42501 to 403, 22023 to 400 and other errors to 500', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not the bridge' } })
    expect((await post(BODY)).status).toBe(403)
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'invalid sticker name' } })
    expect((await post(BODY)).status).toBe(400)
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom' } })
    expect((await post(BODY)).status).toBe(500)
  })

  it('answers 422 STICKER_FILE with the reason', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: NO_FILE_ERROR })
    mocks.store.mockRejectedValue(new StickerFileError('lottie'))
    const res = await post({ ...BODY, format_type: 3 })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('STICKER_FILE')
    expect(res.body.reason).toBe('lottie')
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('reports a failed download as 502', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: NO_FILE_ERROR })
    mocks.store.mockRejectedValue(new Error('Discord CDN answered 404'))
    expect((await post(BODY)).status).toBe(502)
  })

  it('removes the stored file when the second call fails', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: NO_FILE_ERROR })
      .mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'STICKER_LIMIT: 15' } })
    expect((await post(BODY)).status).toBe(409)
    expect(mocks.removeStored).toHaveBeenCalledWith(FILE.path)
  })

  it('removes the stored file when the second call answers existing or updated, keeps it on created', async () => {
    for (const [status, removed] of [['existing', true], ['updated', true], ['created', false]] as const) {
      mocks.removeStored.mockClear()
      mocks.rpc
        .mockResolvedValueOnce({ data: null, error: NO_FILE_ERROR })
        .mockResolvedValueOnce({ data: [row(status)], error: null })
      expect((await post(BODY)).status).toBe(status === 'created' ? 201 : 200)
      if (removed) expect(mocks.removeStored).toHaveBeenCalledWith(FILE.path)
      else expect(mocks.removeStored).not.toHaveBeenCalled()
    }
  })
})

describe('DELETE /servers/:serverId/stickers/:stickerId', () => {
  const del = (id = STICKER_ID) => supertest(app()).delete(`${base}/${id}`)

  it('answers 204 and calls bridge_retire_server_sticker', async () => {
    mocks.rpc.mockResolvedValue({ data: 'removed', error: null })
    expect((await del()).status).toBe(204)
    expect(mocks.rpc).toHaveBeenCalledWith('bridge_retire_server_sticker', {
      p_bot_id: BOT_ID, p_server_id: SERVER_ID, p_sticker_id: STICKER_ID,
    })
  })

  it('answers 204 for an already retired sticker', async () => {
    mocks.rpc.mockResolvedValue({ data: 'existing', error: null })
    expect((await del()).status).toBe(204)
  })

  it('answers 404 on P0002 whatever the message', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0002', message: 'sticker not found' } })
    expect((await del()).status).toBe(404)
  })

  it('answers 400 on a bad uuid', async () => {
    expect((await del('nope')).status).toBe(400)
  })
})

describe('bot audit log', () => {
  const logged = () => mocks.insert.mock.calls
    .filter((c) => c[0] === 'bot_audit_log')
    .map((c) => ({ action: c[1].action_type, metadata: c[1].metadata, serverId: c[1].server_id }))

  it('logs sticker_imported, sticker_updated and sticker_removed', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [row('created')], error: null })
    await post(BODY)
    mocks.rpc.mockResolvedValueOnce({ data: [row('updated')], error: null })
    await post({ ...BODY, update: true })
    mocks.rpc.mockResolvedValueOnce({ data: [row('existing')], error: null })
    await post(BODY)
    mocks.rpc.mockResolvedValueOnce({ data: 'removed', error: null })
    await supertest(app()).delete(`${base}/${STICKER_ID}`)
    mocks.rpc.mockResolvedValueOnce({ data: 'existing', error: null })
    await supertest(app()).delete(`${base}/${STICKER_ID}`)
    expect(logged()).toEqual([
      { action: 'sticker_imported', metadata: { stickerId: 's1', serverId: SERVER_ID, discordStickerId: '111' }, serverId: SERVER_ID },
      { action: 'sticker_updated', metadata: { stickerId: 's1', serverId: SERVER_ID, discordStickerId: '111' }, serverId: SERVER_ID },
      { action: 'sticker_removed', metadata: { stickerId: STICKER_ID, serverId: SERVER_ID }, serverId: SERVER_ID },
    ])
  })
})
