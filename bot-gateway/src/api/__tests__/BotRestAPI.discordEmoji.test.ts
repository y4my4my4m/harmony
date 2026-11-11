import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005e'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  storeImage: vi.fn(),
  remove: vi.fn(),
  or: vi.fn(),
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from, storage: { from: () => ({ remove: mocks.remove }) } },
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
vi.mock('../../utils/discordEmojiImport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/discordEmojiImport.js')>()),
  storeDiscordEmojiImage: mocks.storeImage,
}))

import { BotRestAPI } from '../BotRestAPI.js'

type Result = { data: unknown; error: unknown }

function routeTables(tables: Record<string, Result>) {
  mocks.from.mockImplementation((table: string) => {
    const result = tables[table] ?? { data: null, error: null }
    const builder: any = new Proxy(
      { single: async () => result, maybeSingle: async () => result, then: (resolve: any) => resolve(result) },
      { get: (target, prop) => (prop in target ? (target as any)[prop] : prop === 'or' ? (...a: unknown[]) => { mocks.or(...a); return builder } : () => builder) },
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

const post = (body: unknown) => supertest(app()).post(`/api/v1/servers/${SERVER_ID}/emojis/discord`).send(body as object)
const row = (status: string) => ({ status, id: 'e1', name: 'catjam', url: 'https://db.test/e.gif', discord_emoji_id: '111' })

describe('POST /servers/:serverId/emojis/discord', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    mocks.storeImage.mockReset()
    mocks.remove.mockReset()
    mocks.remove.mockResolvedValue({ data: [], error: null })
    mocks.storeImage.mockResolvedValue('https://db.test/storage/v1/object/public/emojis/s/discord/111.gif')
    routeTables({ discord_bridges: { data: { id: 'b1' }, error: null }, bot_audit_log: { data: null, error: null } })
  })

  it('rejects a bad snowflake and a bad name before any lookup', async () => {
    expect((await post({ discord_emoji_id: 'x', name: 'catjam' })).status).toBe(400)
    expect((await post({ discord_emoji_id: '111', name: 'cat jam' })).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('refuses a bot that does not bridge the server, without fetching the image', async () => {
    routeTables({ discord_bridges: { data: null, error: null } })
    const res = await post({ discord_emoji_id: '111', name: 'catjam' })
    expect(res.status).toBe(403)
    expect(mocks.storeImage).not.toHaveBeenCalled()
  })

  it('answers an already imported emoji without storing the image again', async () => {
    mocks.rpc.mockResolvedValue({ data: [row('existing')], error: null })
    const res = await post({ discord_emoji_id: '111', name: 'catjam', animated: true })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('existing')
    expect(mocks.storeImage).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    expect(mocks.rpc.mock.calls[0][1].p_url).toBeNull()
  })

  it('stores the image and creates the row for a new emoji', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid emoji url' } })
      .mockResolvedValueOnce({ data: [row('created')], error: null })
    const res = await post({ discord_emoji_id: '111', name: 'catjam', animated: true })
    expect(res.status).toBe(201)
    expect(mocks.storeImage).toHaveBeenCalledWith(SERVER_ID, '111', true)
    expect(mocks.rpc.mock.calls[1][1].p_url).toMatch(/\/emojis\/s\/discord\/111\.gif$/)
  })

  it('passes p_update true when update is set', async () => {
    mocks.rpc.mockResolvedValue({ data: [row('updated')], error: null })
    const res = await post({ discord_emoji_id: '111', name: 'catjam', update: true })
    expect(res.status).toBe(200)
    expect(mocks.rpc.mock.calls[0][1].p_update).toBe(true)
  })

  it('maps SERVER_EMOJI_LIMIT to 409 EMOJI_LIMIT and 23505 to EMOJI_NAME_TAKEN', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'SERVER_EMOJI_LIMIT 50' } })
    let res = await post({ discord_emoji_id: '111', name: 'catjam' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('EMOJI_LIMIT')
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'An emoji named catjam exists' } })
    res = await post({ discord_emoji_id: '111', name: 'catjam' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('EMOJI_NAME_TAKEN')
  })

  it('removes the stored image when the RPC fails after storing', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid emoji url' } })
      .mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'SERVER_EMOJI_LIMIT 50' } })
    const res = await post({ discord_emoji_id: '111', name: 'catjam', animated: false })
    expect(res.status).toBe(409)
    expect(mocks.remove).toHaveBeenCalledWith([`${SERVER_ID}/discord/111.png`])
  })

  it('keeps the stored image when the second call answers existing or linked', async () => {
    for (const status of ['existing', 'linked']) {
      mocks.remove.mockClear()
      mocks.rpc
        .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid emoji url' } })
        .mockResolvedValueOnce({ data: [row(status)], error: null })
      expect((await post({ discord_emoji_id: '111', name: 'catjam' })).status).toBe(200)
      expect(mocks.remove).not.toHaveBeenCalled()
    }
  })

  it('reports a failed image copy as 502', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'invalid emoji url' } })
    mocks.storeImage.mockRejectedValue(new Error('Discord CDN answered 404'))
    expect((await post({ discord_emoji_id: '111', name: 'catjam' })).status).toBe(502)
  })
})

describe('GET /servers/:serverId/emojis', () => {
  it('lists server emoji with their Discord ids for a bot in the server', async () => {
    const emojis = [{ id: 'e1', name: 'catjam', url: 'u', server_id: SERVER_ID, discord_emoji_id: '111' }]
    routeTables({ bot_server_permissions: { data: { id: 'p' }, error: null }, emojis: { data: emojis, error: null } })
    const res = await supertest(app()).get(`/api/v1/servers/${SERVER_ID}/emojis`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(emojis)
  })

  it('refuses a bot outside the server', async () => {
    routeTables({ bot_server_permissions: { data: null, error: null } })
    expect((await supertest(app()).get(`/api/v1/servers/${SERVER_ID}/emojis`)).status).toBe(403)
  })
})

describe('GET /servers/:serverId/emojis/discord', () => {
  const get = () => supertest(app()).get(`/api/v1/servers/${SERVER_ID}/emojis/discord`)
  beforeEach(() => { mocks.rpc.mockReset(); mocks.or.mockReset() })

  it('answers limit and active plus removed linked rows', async () => {
    const rows = [
      { id: 'e1', name: 'a', url: 'u', discord_emoji_id: '1', deleted_at: null },
      { id: 'e2', name: 'b', url: 'u', discord_emoji_id: '2', deleted_at: '2026-01-01' },
    ]
    routeTables({ discord_bridges: { data: { id: 'b1' }, error: null }, emojis: { data: rows, error: null } })
    mocks.rpc.mockResolvedValue({ data: 50, error: null })
    const res = await get()
    expect(res.status).toBe(200)
    expect(mocks.or).toHaveBeenCalledWith('deleted_at.is.null,discord_emoji_id.not.is.null')
    expect(mocks.rpc).toHaveBeenCalledWith('server_emoji_limit')
    expect(res.body).toEqual({
      limit: 50,
      emojis: [
        { id: 'e1', name: 'a', url: 'u', discord_emoji_id: '1', removed: false },
        { id: 'e2', name: 'b', url: 'u', discord_emoji_id: '2', removed: true },
      ],
    })
  })

  it('refuses a bot that is not the bridge', async () => {
    routeTables({ discord_bridges: { data: null, error: null } })
    expect((await get()).status).toBe(403)
  })
})

describe('DELETE /servers/:serverId/emojis/:emojiId', () => {
  const EMOJI_ID = '00000000-0000-0000-0000-0000000000e1'
  const del = (id = EMOJI_ID) => supertest(app()).delete(`/api/v1/servers/${SERVER_ID}/emojis/${id}`)
  beforeEach(() => {
    mocks.rpc.mockReset()
    routeTables({ discord_bridges: { data: { id: 'b1' }, error: null }, bot_audit_log: { data: null, error: null } })
  })

  it('answers 204 and calls bridge_remove_server_emoji', async () => {
    mocks.rpc.mockResolvedValue({ data: 'removed', error: null })
    expect((await del()).status).toBe(204)
    expect(mocks.rpc).toHaveBeenCalledWith('bridge_remove_server_emoji', { p_bot_id: BOT_ID, p_server_id: SERVER_ID, p_emoji_id: EMOJI_ID })
  })

  it('answers 404 on P0002', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0002', message: 'emoji not found' } })
    expect((await del()).status).toBe(404)
  })

  it('answers 400 on a bad uuid', async () => {
    expect((await del('nope')).status).toBe(400)
  })
})

describe('GET /servers/:serverId/emojis is unchanged', () => {
  it('still filters deleted_at IS NULL and returns an array', async () => {
    const emojis = [{ id: 'e1', name: 'catjam', url: 'u', server_id: SERVER_ID, discord_emoji_id: '111' }]
    routeTables({ bot_server_permissions: { data: { id: 'p' }, error: null }, emojis: { data: emojis, error: null } })
    const res = await supertest(app()).get(`/api/v1/servers/${SERVER_ID}/emojis`)
    expect(Array.isArray(res.body)).toBe(true)
    expect(mocks.or).not.toHaveBeenCalled()
  })
})
