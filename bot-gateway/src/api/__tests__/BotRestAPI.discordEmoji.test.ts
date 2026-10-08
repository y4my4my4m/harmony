import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005e'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  storeImage: vi.fn(),
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

const post = (body: unknown) => supertest(app()).post(`/api/v1/servers/${SERVER_ID}/emojis/discord`).send(body as object)
const row = (status: string) => ({ status, id: 'e1', name: 'catjam', url: 'https://db.test/e.gif', discord_emoji_id: '111' })

describe('POST /servers/:serverId/emojis/discord', () => {
  beforeEach(() => {
    mocks.rpc.mockReset()
    mocks.storeImage.mockReset()
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
