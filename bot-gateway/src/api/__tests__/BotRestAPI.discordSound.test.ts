import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005e'
const SOUND_ID = '00000000-0000-0000-0000-0000000000a1'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  store: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
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
vi.mock('../../utils/discordSoundImport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/discordSoundImport.js')>()),
  storeDiscordSound: mocks.store,
  removeStoredSound: mocks.remove,
}))

import { BotRestAPI } from '../BotRestAPI.js'

type Result = { data: unknown; error: unknown }

function routeTables(tables: Record<string, Result>) {
  mocks.from.mockImplementation((table: string) => {
    const result = tables[table] ?? { data: null, error: null }
    const builder: any = new Proxy(
      { single: async () => result, maybeSingle: async () => result, then: (resolve: any) => resolve(result) },
      { get: (target, prop) => (prop in target ? (target as any)[prop] : () => builder) },
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

const body = { discord_sound_id: '111222333', name: ' airhorn ', emoji: ' 📣 ', emoji_id: null, volume: 0.5 }
const post = (b: unknown) => supertest(app()).post(`/api/v1/servers/${SERVER_ID}/sounds/discord`).send(b as object)
const row = (status: string) => ({ status, id: SOUND_ID, name: 'airhorn', emoji: '📣', emoji_id: null, volume: '0.50', discord_sound_id: '111222333' })
const bridged = () => routeTables({ discord_bridges: { data: { id: 'b1' }, error: null }, bot_audit_log: { data: null, error: null } })

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.store.mockReset()
  mocks.remove.mockReset()
  mocks.store.mockResolvedValue({ storagePath: `${SERVER_ID}/x.mp3`, durationMs: 1200 })
  mocks.remove.mockResolvedValue(undefined)
  bridged()
})

describe('GET /servers/:serverId/sounds', () => {
  it('lists the sounds for the bridge bot', async () => {
    const sounds = [{ id: SOUND_ID, name: 'airhorn', emoji: null, emoji_id: null, volume: 0.5, discord_sound_id: null }]
    routeTables({ discord_bridges: { data: { id: 'b1' }, error: null }, server_sounds: { data: sounds, error: null } })
    const res = await supertest(app()).get(`/api/v1/servers/${SERVER_ID}/sounds`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(sounds)
  })

  it('refuses a bot that does not bridge the server', async () => {
    routeTables({ discord_bridges: { data: null, error: null } })
    expect((await supertest(app()).get(`/api/v1/servers/${SERVER_ID}/sounds`)).status).toBe(403)
  })

  it('rejects a malformed server id', async () => {
    expect((await supertest(app()).get('/api/v1/servers/nope/sounds')).status).toBe(400)
  })
})

describe('POST /servers/:serverId/sounds/discord', () => {
  it('rejects bad bodies before any lookup', async () => {
    expect((await post({ ...body, discord_sound_id: 'x' })).status).toBe(400)
    expect((await post({ ...body, name: '   ' })).status).toBe(400)
    expect((await post({ ...body, volume: 2 })).status).toBe(400)
    expect((await post({ ...body, emoji_id: 'nope' })).status).toBe(400)
    expect((await post({ ...body, update: 'yes' })).status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('refuses a bot that does not bridge the server', async () => {
    routeTables({ discord_bridges: { data: null, error: null } })
    expect((await post(body)).status).toBe(403)
    expect(mocks.store).not.toHaveBeenCalled()
  })

  it('answers an existing sound without downloading', async () => {
    mocks.rpc.mockResolvedValue({ data: [row('existing')], error: null })
    const res = await post(body)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('existing')
    expect(mocks.store).not.toHaveBeenCalled()
    const args = mocks.rpc.mock.calls[0][1]
    expect(args).toMatchObject({ p_name: 'airhorn', p_emoji: '📣', p_update: false, p_storage_path: null, p_duration_ms: null })
  })

  it('downloads on invalid sound file and creates the row', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid sound file' } })
      .mockResolvedValueOnce({ data: [row('created')], error: null })
    const res = await post(body)
    expect(res.status).toBe(201)
    expect(mocks.store).toHaveBeenCalledWith(SERVER_ID, '111222333')
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_storage_path: `${SERVER_ID}/x.mp3`, p_duration_ms: 1200 })
  })

  it('removes the stored clip when the import RPC fails', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid sound file' } })
      .mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'SOUNDBOARD_FULL: a server holds at most 48 sounds' } })
    const res = await post(body)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('SOUND_LIMIT')
    expect(mocks.remove).toHaveBeenCalledWith(`${SERVER_ID}/x.mp3`)
  })

  it('removes the stored clip when a concurrent import won the race', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid sound file' } })
      .mockResolvedValueOnce({ data: [row('existing')], error: null })
    const res = await post(body)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('existing')
    expect(mocks.remove).toHaveBeenCalledWith(`${SERVER_ID}/x.mp3`)
  })

  it('reports a failed download as 502', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'invalid sound file' } })
    mocks.store.mockRejectedValue(new Error('Discord CDN answered 404'))
    expect((await post(body)).status).toBe(502)
  })

  it('maps a non-bridge bot error to 403 and others to 500', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'x' } })
    expect((await post(body)).status).toBe(403)
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'boom' } })
    expect((await post(body)).status).toBe(500)
  })
})

describe('DELETE /servers/:serverId/sounds/:soundId', () => {
  const del = () => supertest(app()).delete(`/api/v1/servers/${SERVER_ID}/sounds/${SOUND_ID}`)

  it('deletes the row and its stored clip', async () => {
    mocks.rpc.mockResolvedValue({ data: `${SERVER_ID}/x.mp3`, error: null })
    expect((await del()).status).toBe(204)
    expect(mocks.remove).toHaveBeenCalledWith(`${SERVER_ID}/x.mp3`)
  })

  it('answers 404 when the RPC finds no such sound', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    expect((await del()).status).toBe(404)
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})
