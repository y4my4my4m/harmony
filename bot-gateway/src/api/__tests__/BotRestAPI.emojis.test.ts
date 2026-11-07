import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// POST /emojis records a federated emoji only, which names its instance; emoji lists leave out
// removed emoji (emojis.deleted_at, migration 20261107100001).

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005e'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), calls: [] as Array<[string, string, unknown[]]> }))

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

import { BotRestAPI } from '../BotRestAPI.js'

type Result = { data: unknown; error: unknown }

function routeTables(tables: Record<string, Result>) {
  mocks.from.mockImplementation((table: string) => {
    const result = tables[table] ?? { data: null, error: null }
    const builder: any = new Proxy(
      { single: async () => result, maybeSingle: async () => result, then: (resolve: any) => resolve(result) },
      {
        get: (target, prop) => {
          if (prop in target) return (target as any)[prop]
          return (...args: unknown[]) => {
            mocks.calls.push([table, String(prop), args])
            return builder
          }
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

const filtersRemoved = (table: string) =>
  mocks.calls.some(([t, method, args]) => t === table && method === 'is' && args[0] === 'deleted_at' && args[1] === null)

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.calls.length = 0
  routeTables({ bot_audit_log: { data: null, error: null } })
})

describe('POST /emojis', () => {
  const post = (body: unknown) => supertest(app()).post('/api/v1/emojis').send(body as object)

  it.each([undefined, null, '', '   ', 42])('refuses domain %j before the database', async (domain) => {
    const res = await post({ name: 'blob', url: 'https://remote.example/blob.png', domain })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/domain/)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('records a federated emoji under its trimmed domain', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ id: 'e1', name: 'blob', domain: 'remote.example' }], error: null })
    const res = await post({ name: 'blob', url: 'https://remote.example/blob.png', domain: ' remote.example ' })
    expect(res.status).toBe(201)
    expect(mocks.rpc).toHaveBeenCalledWith('create_federated_emoji', {
      p_name: 'blob', p_url: 'https://remote.example/blob.png', p_created_by: BOT_ID, p_domain: 'remote.example',
    })
  })

  it('answers 400 when the database refuses the row (22023)', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'EMOJI_URL: an http(s) url of at most 2048 characters' } })
    const res = await post({ name: 'blob', url: 'ftp://remote.example/blob.png', domain: 'remote.example' })
    expect(res.status).toBe(400)
  })
})

describe('emoji lists leave out removed emoji', () => {
  it('GET /emojis', async () => {
    routeTables({ emojis: { data: [], error: null } })
    expect((await supertest(app()).get('/api/v1/emojis')).status).toBe(200)
    expect(filtersRemoved('emojis')).toBe(true)
  })

  it('GET /servers/:serverId/emojis', async () => {
    routeTables({ bot_server_permissions: { data: { id: 'p' }, error: null }, emojis: { data: [], error: null } })
    expect((await supertest(app()).get(`/api/v1/servers/${SERVER_ID}/emojis`)).status).toBe(200)
    expect(filtersRemoved('emojis')).toBe(true)
  })

  it('GET /emojis?id= answers a removed emoji with its deleted_at', async () => {
    const removed = { id: '5e000000-0000-4000-8000-000000000001', name: 'gone', deleted_at: '2026-11-07T00:00:00Z' }
    routeTables({ emojis: { data: removed, error: null } })
    const res = await supertest(app()).get(`/api/v1/emojis?id=${removed.id}`)
    expect(res.status).toBe(200)
    expect(res.body.deleted_at).toBe(removed.deleted_at)
    expect(filtersRemoved('emojis')).toBe(false)
  })
})
