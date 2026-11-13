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
  order: vi.fn(),
  limit: vi.fn(),
  gt: vi.fn(),
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

type TableResult = Result | ((afterId: string | null) => Result)

// A table answers its result; a keyset read past the first page (gt) answers no rows, unless
// the table is a function of the id the page follows.
function routeTables(tables: Record<string, TableResult>) {
  mocks.from.mockImplementation((table: string) => {
    const entry = tables[table] ?? { data: null, error: null }
    let afterId: string | null = null
    const result = (): Result => {
      if (typeof entry === 'function') return entry(afterId)
      return afterId !== null && Array.isArray(entry.data) ? { data: [], error: null } : entry
    }
    const builder: any = new Proxy(
      { single: async () => result(), maybeSingle: async () => result(), then: (resolve: any) => resolve(result()) },
      {
        get: (target, prop) => {
          if (prop in target) return (target as any)[prop]
          return (...a: unknown[]) => {
            if (prop === 'gt') afterId = a[1] as string
            if (prop === 'or' || prop === 'order' || prop === 'limit' || prop === 'gt') (mocks as any)[prop](...a)
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

  it('keeps the stored image when the RPC fails and a row of that Discord emoji holds it', async () => {
    routeTables({
      discord_bridges: { data: { id: 'b1' }, error: null },
      emojis: { data: { id: 'e1' }, error: null },
    })
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid emoji url' } })
      .mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'An emoji named catjam exists' } })
    const res = await post({ discord_emoji_id: '111', name: 'catjam' })
    expect(res.status).toBe(409)
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('keeps the stored image when the row lookup itself fails', async () => {
    routeTables({
      discord_bridges: { data: { id: 'b1' }, error: null },
      emojis: { data: null, error: { message: 'timeout' } },
    })
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid emoji url' } })
      .mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'SERVER_EMOJI_LIMIT 50' } })
    expect((await post({ discord_emoji_id: '111', name: 'catjam' })).status).toBe(409)
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('answers 403 EMOJI_REMOVED when the bridge may not restore the emoji', async () => {
    mocks.rpc.mockResolvedValue({
      data: null, error: { code: '42501', message: 'EMOJI_REMOVED: the bridge restores only emoji it removed' },
    })
    const res = await post({ discord_emoji_id: '111', name: 'catjam', update: true })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('EMOJI_REMOVED')
    expect(mocks.storeImage).not.toHaveBeenCalled()
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
  const stored = (id: string, ext = 'png') => `https://db.test/storage/v1/object/public/emojis/${SERVER_ID}/discord/${id}.${ext}`
  beforeEach(() => {
    mocks.rpc.mockReset(); mocks.or.mockReset(); mocks.order.mockReset(); mocks.limit.mockReset(); mocks.gt.mockReset()
  })

  it('answers limit and active plus removed linked rows, read by id keyset', async () => {
    const rows = [
      { id: 'e1', name: 'a', url: 'u', discord_emoji_id: '1', deleted_at: null, bridge_removed_at: null },
      { id: 'e2', name: 'b', url: 'u', discord_emoji_id: '2', deleted_at: '2026-01-01', bridge_removed_at: null },
    ]
    routeTables({ discord_bridges: { data: { id: 'b1' }, error: null }, emojis: { data: rows, error: null } })
    mocks.rpc.mockResolvedValue({ data: 50, error: null })
    const res = await get()
    expect(res.status).toBe(200)
    expect(mocks.or).toHaveBeenCalledWith('deleted_at.is.null,discord_emoji_id.not.is.null')
    expect(mocks.order).toHaveBeenCalledWith('id')
    expect(mocks.limit).toHaveBeenCalledWith(1000)
    expect(mocks.gt).toHaveBeenCalledWith('id', 'e2')
    expect(mocks.rpc).toHaveBeenCalledWith('server_emoji_limit')
    expect(res.body).toEqual({
      limit: 50,
      emojis: [
        { id: 'e1', name: 'a', url: 'u', discord_emoji_id: '1', removed: false, imported: false, restorable: false },
        { id: 'e2', name: 'b', url: 'u', discord_emoji_id: '2', removed: true, imported: false, restorable: false },
      ],
    })
  })

  it('reads every page: a page shorter than asked is not the last', async () => {
    const pages: Record<string, unknown[]> = {
      first: [{ id: 'e1', name: 'a', url: 'u', discord_emoji_id: null, deleted_at: null, bridge_removed_at: null }],
      e1: [{ id: 'e2', name: 'b', url: 'u', discord_emoji_id: null, deleted_at: null, bridge_removed_at: null }],
      e2: [{ id: 'e3', name: 'c', url: 'u', discord_emoji_id: null, deleted_at: null, bridge_removed_at: null }],
    }
    routeTables({
      discord_bridges: { data: { id: 'b1' }, error: null },
      emojis: (afterId) => ({ data: pages[afterId ?? 'first'] ?? [], error: null }),
    })
    mocks.rpc.mockResolvedValue({ data: 50, error: null })
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.body.emojis.map((e: { id: string }) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(mocks.gt.mock.calls.map((c) => c[1])).toEqual(['e1', 'e2', 'e3'])
  })

  it('answers 500 LIST_TOO_LARGE rather than a partial list', async () => {
    let n = 0
    routeTables({
      discord_bridges: { data: { id: 'b1' }, error: null },
      emojis: () => ({
        data: Array.from({ length: 1000 }, () => ({ id: `e${String(n++).padStart(6, '0')}`, name: 'a', url: 'u', discord_emoji_id: null, deleted_at: null, bridge_removed_at: null })),
        error: null,
      }),
    })
    mocks.rpc.mockResolvedValue({ data: 0, error: null })
    const res = await get()
    expect(res.status).toBe(500)
    expect(res.body.code).toBe('LIST_TOO_LARGE')
  })

  it('marks what the bridge imported and what it may restore', async () => {
    const at = '2026-11-12T00:00:00+00:00'
    const rows = [
      // Imported by the bridge, active.
      { id: 'e1', name: 'a', url: stored('1'), discord_emoji_id: '1', deleted_at: null, bridge_removed_at: null },
      // Imported and removed by the bridge.
      { id: 'e2', name: 'b', url: stored('2', 'gif'), discord_emoji_id: '2', deleted_at: at, bridge_removed_at: at },
      // Imported, removed by a person: no mark, or the mark of an earlier bridge removal.
      { id: 'e3', name: 'c', url: stored('3'), discord_emoji_id: '3', deleted_at: at, bridge_removed_at: null },
      { id: 'e4', name: 'd', url: stored('4'), discord_emoji_id: '4', deleted_at: at, bridge_removed_at: '2026-11-01T00:00:00+00:00' },
      // A member's upload linked by name: its own image.
      { id: 'e5', name: 'e', url: `https://db.test/storage/v1/object/public/emojis/${SERVER_ID}/u1/e.png`, discord_emoji_id: '5', deleted_at: null, bridge_removed_at: null },
      // Another Discord emoji's image.
      { id: 'e6', name: 'f', url: stored('1'), discord_emoji_id: '6', deleted_at: null, bridge_removed_at: null },
    ]
    routeTables({ discord_bridges: { data: { id: 'b1' }, error: null }, emojis: { data: rows, error: null } })
    mocks.rpc.mockResolvedValue({ data: 50, error: null })
    const res = await get()
    expect(res.body.emojis.map((e: any) => [e.id, e.imported, e.restorable])).toEqual([
      ['e1', true, false], ['e2', true, true], ['e3', true, false], ['e4', true, false], ['e5', false, false], ['e6', false, false],
    ])
  })

  it('answers 500 when the emoji limit is missing', async () => {
    routeTables({ discord_bridges: { data: { id: 'b1' }, error: null }, emojis: { data: [], error: null } })
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    const res = await get()
    expect(res.status).toBe(500)
    expect(res.body.error).toBeTruthy()
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
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'bridge_remove_server_emoji' ? { data: 'removed', error: null } : { data: [], error: null })
    expect((await del()).status).toBe(204)
    expect(mocks.rpc).toHaveBeenCalledWith('bridge_remove_server_emoji', { p_bot_id: BOT_ID, p_server_id: SERVER_ID, p_emoji_id: EMOJI_ID })
  })

  it('answers 403 EMOJI_NOT_LINKED for an emoji the bridge did not import', async () => {
    mocks.rpc.mockResolvedValue({
      data: null, error: { code: '42501', message: 'EMOJI_NOT_LINKED: the bridge removes only emoji it imported' },
    })
    const res = await del()
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('EMOJI_NOT_LINKED')
  })

  it('keeps the plain 403 of a bot that is not the bridge', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'bot is not the Discord bridge of this server' } })
    const res = await del()
    expect(res.status).toBe(403)
    expect(res.body.code).toBeUndefined()
  })

  describe('eviction after a removal', () => {
    const past = [{ id: 'old1', path: `${SERVER_ID}/discord/7.png` }, { id: 'old2', path: `${SERVER_ID}/discord/8.gif` }]
    const evictCalls = () => mocks.rpc.mock.calls.filter((c) => c[0] === 'bridge_evict_removed_emojis').map((c) => c[1].p_ids)
    beforeEach(() => { mocks.remove.mockReset(); mocks.remove.mockResolvedValue({ data: [], error: null }) })

    it('removes the files of the rows past the kept count, then deletes those rows', async () => {
      const order: string[] = []
      mocks.remove.mockImplementation(async () => { order.push('files'); return { data: [], error: null } })
      mocks.rpc.mockImplementation(async (name: string, args: any) => {
        if (name === 'bridge_remove_server_emoji') return { data: 'removed', error: null }
        order.push(args.p_ids === null ? 'list' : 'rows')
        return { data: args.p_ids === null ? past : [], error: null }
      })
      expect((await del()).status).toBe(204)
      expect(order).toEqual(['list', 'files', 'rows'])
      expect(mocks.remove).toHaveBeenCalledWith([`${SERVER_ID}/discord/7.png`, `${SERVER_ID}/discord/8.gif`])
      expect(evictCalls()).toEqual([null, ['old1', 'old2']])
    })

    it('leaves the rows when their files could not be removed', async () => {
      mocks.remove.mockResolvedValue({ data: null, error: { message: 'storage down' } })
      mocks.rpc.mockImplementation(async (name: string, args: any) =>
        name === 'bridge_remove_server_emoji' ? { data: 'removed', error: null } : { data: args.p_ids === null ? past : [], error: null })
      expect((await del()).status).toBe(204)
      expect(evictCalls()).toEqual([null])
    })

    it('does nothing when no row is past the kept count, or the emoji already was removed', async () => {
      mocks.rpc.mockImplementation(async (name: string) =>
        name === 'bridge_remove_server_emoji' ? { data: 'removed', error: null } : { data: [], error: null })
      expect((await del()).status).toBe(204)
      expect(evictCalls()).toEqual([null])
      expect(mocks.remove).not.toHaveBeenCalled()

      mocks.rpc.mockReset()
      mocks.rpc.mockResolvedValue({ data: 'existing', error: null })
      expect((await del()).status).toBe(204)
      expect(evictCalls()).toEqual([])
    })

    it('answers 204 when the eviction itself fails', async () => {
      mocks.rpc.mockImplementation(async (name: string) =>
        name === 'bridge_remove_server_emoji' ? { data: 'removed', error: null } : { data: null, error: { message: 'boom' } })
      expect((await del()).status).toBe(204)
    })
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
