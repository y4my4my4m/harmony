import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005e'
const GUILD = '123456789012345678'
const HASH = 'a'.repeat(32)

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  store: vi.fn(),
  removeImage: vi.fn(),
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
vi.mock('../../utils/discordProfileImage.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/discordProfileImage.js')>()),
  storeDiscordProfileImage: mocks.store,
  removeProfileImage: mocks.removeImage,
}))

import { BotRestAPI } from '../BotRestAPI.js'
import { ProfileImageError } from '../../utils/discordProfileImage.js'

type Result = { data: unknown; error: unknown }

function routeTables(tables: Record<string, Result>) {
  mocks.from.mockImplementation((table: string) => {
    const result = tables[table] ?? { data: null, error: null }
    const builder: any = new Proxy(
      { single: async () => result, maybeSingle: async () => result, then: (resolve: any) => resolve(result) },
      {
        get: (target, prop: string) => {
          if (prop in target) return (target as any)[prop]
          if (prop === 'insert') return (...a: unknown[]) => { mocks.insert(table, ...a); return builder }
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

const url = `/api/v1/servers/${SERVER_ID}/profile/discord`
const patch = (body: unknown) => supertest(app()).patch(url).send(body as object)
const bridged = (guild: string | null = GUILD) =>
  routeTables({ discord_bridges: { data: { id: 'b1', discord_guild_id: guild }, error: null }, bot_audit_log: { data: null, error: null } })
const rpcRow = (over: Record<string, unknown> = {}) => ({
  changed: true, previous_icon: null, previous_banner: null, name: 'N', description: null, icon: null, banner: null, ...over,
})
const profileCalls = () => mocks.rpc.mock.calls.filter((c) => c[0] === 'bridge_update_server_profile')

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.removeImage.mockResolvedValue(undefined)
  mocks.store.mockImplementation(async (kind: string) => ({ path: `${SERVER_ID}/${kind}-new.png` }))
  mocks.rpc.mockResolvedValue({ data: [rpcRow()], error: null })
  bridged()
})

describe('GET /servers/:serverId/profile/discord', () => {
  it('GET answers the RPC row', async () => {
    const row = { name: 'N', description: 'd', icon: 'i', banner: null, icon_discord_hash: HASH, icon_path: 'p', banner_discord_hash: null, banner_path: null }
    mocks.rpc.mockResolvedValue({ data: [row], error: null })
    const res = await supertest(app()).get(url)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(row)
    expect(mocks.rpc).toHaveBeenCalledWith('bridge_get_server_profile', { p_bot_id: BOT_ID, p_server_id: SERVER_ID })
  })

  it('GET 403 for a bot that is not the bridge', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not the bridge' } })
    const res = await supertest(app()).get(url)
    expect(res.status).toBe(403)
  })
})

describe('PATCH /servers/:serverId/profile/discord', () => {
  it('PATCH rejects a body with no profile fields', async () => {
    const res = await patch({ invoker_discord_id: '1' })
    expect(res.status).toBe(400)
    expect(profileCalls()).toHaveLength(0)
  })

  it('PATCH rejects a bad icon_hash', async () => {
    const res = await patch({ icon_hash: 'nothex' })
    expect(res.status).toBe(400)
    expect(mocks.store).not.toHaveBeenCalled()
    expect(profileCalls()).toHaveLength(0)
  })

  it('PATCH builds the CDN URL from the stored guild id', async () => {
    const res = await patch({ icon_hash: HASH, guild_id: '999' })
    expect(res.status).toBe(200)
    expect(mocks.store).toHaveBeenCalledWith('icon', SERVER_ID, GUILD, HASH)
    expect(profileCalls()[0][1].p_changes).toEqual({ icon: `${SERVER_ID}/icon-new.png`, icon_discord_hash: HASH })
  })

  it('PATCH writes name only without downloading', async () => {
    const res = await patch({ name: 'Cool' })
    expect(res.status).toBe(200)
    expect(mocks.store).not.toHaveBeenCalled()
    expect(profileCalls()[0][1]).toEqual({ p_bot_id: BOT_ID, p_server_id: SERVER_ID, p_changes: { name: 'Cool' } })
    expect(res.body).toEqual({ changed: true, name: 'N', description: null, icon: null, banner: null })
  })

  it('PATCH clears the banner', async () => {
    const prev = `${SERVER_ID}/banner-old.png`
    mocks.rpc.mockResolvedValue({ data: [rpcRow({ previous_banner: prev })], error: null })
    const res = await patch({ banner_hash: null })
    expect(res.status).toBe(200)
    expect(profileCalls()[0][1].p_changes).toEqual({ banner: null, banner_discord_hash: null })
    expect(mocks.removeImage).toHaveBeenCalledWith('banner', prev)
  })

  it('PATCH removes the icon upload when the banner download fails', async () => {
    mocks.store.mockImplementation(async (kind: string) => {
      if (kind === 'banner') throw new Error('Discord CDN answered 404')
      return { path: `${SERVER_ID}/icon-new.png` }
    })
    const res = await patch({ icon_hash: HASH, banner_hash: HASH })
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ code: 'PROFILE_IMAGE_DOWNLOAD', field: 'banner' })
    expect(profileCalls()).toHaveLength(0)
    expect(mocks.removeImage).toHaveBeenCalledWith('icon', `${SERVER_ID}/icon-new.png`)
  })

  it('PATCH answers 422 for an image Harmony cannot hold', async () => {
    mocks.store.mockRejectedValue(new ProfileImageError('icon', 'size'))
    const res = await patch({ icon_hash: HASH })
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ code: 'PROFILE_IMAGE', field: 'icon', reason: 'size' })
  })

  it('PATCH removes uploads when the RPC fails', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'name too long' } })
    const res = await patch({ name: 'x', icon_hash: HASH })
    expect(res.status).toBe(400)
    expect(mocks.removeImage).toHaveBeenCalledWith('icon', `${SERVER_ID}/icon-new.png`)
  })

  it('PATCH keeps a foreign previous icon', async () => {
    mocks.rpc.mockResolvedValue({ data: [rpcRow({ previous_icon: 'https://example.com/i.png' })], error: null })
    const res = await patch({ icon_hash: HASH })
    expect(res.status).toBe(200)
    expect(mocks.removeImage).not.toHaveBeenCalled()
  })

  it('PATCH logs server_profile_synced only when changed', async () => {
    const logged = () => mocks.insert.mock.calls.filter((c) => c[0] === 'bot_audit_log')
    await patch({ name: 'Cool', invoker_discord_id: '42' })
    expect(logged()).toHaveLength(1)
    expect(JSON.stringify(logged()[0])).toContain('server_profile_synced')
    mocks.insert.mockReset()
    mocks.rpc.mockResolvedValue({ data: [rpcRow({ changed: false })], error: null })
    await patch({ name: 'Cool' })
    expect(logged()).toHaveLength(0)
  })

  it('PATCH 409 NO_GUILD when an image is requested and the bridge has no guild id', async () => {
    bridged(null)
    const res = await patch({ icon_hash: HASH })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('NO_GUILD')
    expect(mocks.store).not.toHaveBeenCalled()
  })

  it('PATCH 403 when the bot is not the bridge', async () => {
    routeTables({ discord_bridges: { data: null, error: null } })
    const res = await patch({ name: 'x' })
    expect(res.status).toBe(403)
  })
})
