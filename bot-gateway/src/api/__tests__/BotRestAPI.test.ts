import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const EMOJI_ID = '00000000-0000-0000-0000-0000000000e1'

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  config: {
    supabaseUrl: 'http://localhost:54321',
    port: 3002,
    nodeEnv: 'test',
    instanceDomain: 'harmony.test',
    websocket: { heartbeatInterval: 30_000, maxConnectionsPerBot: 5 },
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  },
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: mocks.config,
}))

// Auth is covered in src/auth/__tests__; here every request is already a bot.
vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => {
    req.bot = { id: BOT_ID, username: 'testbot', scopes: ['bot'] }
    next()
  },
}))

import { BotRestAPI, botSuppliedMetadata } from '../BotRestAPI.js'

type Result = { data: unknown; error: unknown }

/** Terminal results keyed by table; every builder method chains. */
function routeTables(tables: Record<string, Result>) {
  mocks.from.mockImplementation((table: string) => {
    const result = tables[table] ?? { data: null, error: { message: `no fixture for ${table}` } }
    const builder: any = new Proxy(
      {
        single: async () => result,
        maybeSingle: async () => result,
        then: (resolve: any) => resolve(result),
      },
      {
        get(target, prop) {
          if (prop in target) return (target as any)[prop]
          return () => builder
        },
      },
    )
    return builder
  })
}

function routeRpc(handlers: Record<string, (args: any) => Result>) {
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    const handler = handlers[fn]
    if (!handler) throw new Error(`test called unmocked rpc: ${fn}`)
    return handler(args)
  })
}

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', new BotRestAPI().router)
  return app
}

const EMOJI_ROW = {
  id: EMOJI_ID,
  created_at: '2026-01-01T00:00:00Z',
  name: 'blobcat',
  url: 'https://remote.test/emoji/blobcat.png',
  server_id: null,
  uploader: '00000000-0000-0000-0000-0000000000a1',
  domain: 'remote.test',
  scope: 'instance',
}

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.from.mockReset()
  routeTables({ bot_audit_log: { data: null, error: null } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /emojis', () => {
  it('rejects a body without name or url', async () => {
    routeRpc({})
    const res = await supertest(makeApp()).post('/api/v1/emojis').send({ name: 'blobcat' })

    expect(res.status).toBe(400)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  // Bot-created emojis are instance-scoped. A server_id would put a bot's emoji
  // inside a guild it has no claim on.
  it('rejects a server-scoped emoji', async () => {
    routeRpc({})
    const res = await supertest(makeApp())
      .post('/api/v1/emojis')
      .send({ name: 'blobcat', url: EMOJI_ROW.url, server_id: '00000000-0000-0000-0000-00000000000f' })

    expect(res.status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  // Argument names are the RPC's contract: PostgREST matches by name, and a rename
  // on either side answers PGRST202 rather than failing to compile.
  it('calls create_federated_emoji with the bot id as creator and returns the row', async () => {
    routeRpc({ create_federated_emoji: () => ({ data: [EMOJI_ROW], error: null }) })

    const res = await supertest(makeApp())
      .post('/api/v1/emojis')
      .send({ name: 'blobcat', url: EMOJI_ROW.url, domain: 'remote.test' })

    expect(mocks.rpc).toHaveBeenCalledWith('create_federated_emoji', {
      p_name: 'blobcat',
      p_url: EMOJI_ROW.url,
      p_created_by: BOT_ID,
      p_domain: 'remote.test',
    })
    expect(res.status).toBe(201)
    expect(res.body).toEqual(EMOJI_ROW)
  })

  it('answers 5xx when the RPC raises', async () => {
    routeRpc({
      create_federated_emoji: () => ({
        data: null,
        error: {
          code: '42702',
          message: 'column reference "id" is ambiguous',
          details: 'It could refer to either a PL/pgSQL variable or a table column.',
          hint: null,
        },
      }),
    })

    const res = await supertest(makeApp())
      .post('/api/v1/emojis')
      .send({ name: 'blobcat', url: EMOJI_ROW.url })

    expect(res.status).toBe(500)
  })

  it('answers 5xx when the RPC returns no row', async () => {
    routeRpc({ create_federated_emoji: () => ({ data: [], error: null }) })

    const res = await supertest(makeApp())
      .post('/api/v1/emojis')
      .send({ name: 'blobcat', url: EMOJI_ROW.url })

    expect(res.status).toBe(500)
  })
})

describe('route table', () => {
  // Express matches in registration order. /users/@me must be registered ahead of
  // /users/:userId or "@me" reaches a uuid column and the route answers 404.
  it('GET /users/@me resolves to the calling bot', async () => {
    routeTables({
      bots: { data: { id: BOT_ID, username: 'testbot', discriminator: '0000' }, error: null },
      profiles: {
        data: null,
        error: { code: '22P02', message: 'invalid input syntax for type uuid: "@me"' },
      },
    })

    const res = await supertest(makeApp()).get('/api/v1/users/@me')

    expect(res.status).toBe(200)
    expect(res.body.id).toBe(BOT_ID)
  })

  it('GET /users/:id answers 404 for an unknown profile', async () => {
    routeTables({
      profiles: { data: null, error: { code: 'PGRST116', message: 'no rows returned' } },
    })

    const res = await supertest(makeApp()).get(
      '/api/v1/users/00000000-0000-0000-0000-0000000000ff',
    )

    expect(res.status).toBe(404)
  })
})

describe('PATCH /messages/:id/metadata', () => {
  const MESSAGE_ID = '00000000-0000-0000-0000-0000000000c1'

  // The write runs as service role; ownership is the only thing stopping a bot
  // from rewriting discord_user on a human's message and changing its author.
  it("refuses a message the bot didn't send", async () => {
    routeTables({
      messages: {
        data: { channel_id: 'ch', metadata: {}, bot_id: null },
        error: null,
      },
    })

    const res = await supertest(makeApp())
      .patch(`/api/v1/messages/${MESSAGE_ID}/metadata`)
      .send({ metadata: { discord_user: { username: 'spoofed' } } })

    expect(res.status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it("refuses another bot's message", async () => {
    routeTables({
      messages: {
        data: { channel_id: 'ch', metadata: {}, bot_id: '00000000-0000-0000-0000-0000000000b9' },
        error: null,
      },
    })

    const res = await supertest(makeApp())
      .patch(`/api/v1/messages/${MESSAGE_ID}/metadata`)
      .send({ metadata: { discord_message_id: '1' } })

    expect(res.status).toBe(403)
  })

  // Federation identity and notice types are server statements: a bot naming them
  // would squat a remote message's ap_id or restyle its message as a notice.
  it('keeps server-only keys out of a metadata merge', async () => {
    const updates: any[] = []
    mocks.from.mockImplementation((table: string) => {
      const result =
        table === 'messages'
          ? { data: { channel_id: 'ch', metadata: { bot: true, created_via: 'bot_api' }, bot_id: BOT_ID }, error: null }
          : { data: { server_id: 'srv' }, error: null }
      const builder: any = new Proxy(
        {
          single: async () => result,
          maybeSingle: async () => result,
          then: (resolve: any) => resolve({ data: null, error: null }),
          update: (patch: any) => { updates.push(patch); return builder },
        },
        { get: (target, prop) => (prop in target ? (target as any)[prop] : () => builder) },
      )
      return builder
    })
    routeRpc({ check_bot_permission: () => ({ data: true, error: null }) })

    const res = await supertest(makeApp())
      .patch(`/api/v1/messages/${MESSAGE_ID}/metadata`)
      .send({ metadata: { discord_message_id: '42', ap_id: 'https://peer.test/m/1', federated: true, type: 'member_ban', bot: false } })

    expect(res.status).toBe(200)
    expect(updates).toEqual([
      { metadata: { bot: true, created_via: 'bot_api', discord_message_id: '42' } },
    ])
  })
})

describe('botSuppliedMetadata', () => {
  it('drops server-only keys and keeps bridge keys', () => {
    expect(botSuppliedMetadata({ discord_user: { id: '1' }, embeds: {}, federated: true, created_via: 'x' }))
      .toEqual({ discord_user: { id: '1' }, embeds: {} })
  })

  it('reads anything but a plain object as empty', () => {
    expect(botSuppliedMetadata(null)).toEqual({})
    expect(botSuppliedMetadata(['ap_id'])).toEqual({})
    expect(botSuppliedMetadata('x')).toEqual({})
  })
})

describe('AutoMod rejections', () => {
  const CHANNEL_ID = '00000000-0000-0000-0000-0000000000c1'

  function sendFixtures(messages: Result) {
    routeTables({
      channels: { data: { server_id: '00000000-0000-0000-0000-0000000000s1' }, error: null },
      instance_config: { data: null, error: null },
      bot_audit_log: { data: null, error: null },
      messages,
    })
    routeRpc({ check_bot_permission: () => ({ data: true, error: null }) })
  }

  it('answers 403 AUTOMOD_BLOCKED when the insert returns no row', async () => {
    sendFixtures({ data: [], error: null })
    const res = await supertest(makeApp())
      .post(`/api/v1/channels/${CHANNEL_ID}/messages`)
      .send({ content: 'blocked words' })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('AUTOMOD_BLOCKED')
  })

  it('answers 403 when the database raises AUTOMOD_BLOCKED', async () => {
    sendFixtures({ data: null, error: { message: 'AUTOMOD_BLOCKED:keyword', details: '{}' } })
    const res = await supertest(makeApp())
      .post(`/api/v1/channels/${CHANNEL_ID}/messages`)
      .send({ content: 'blocked words' })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('AUTOMOD_BLOCKED')
  })

  it('returns the created message otherwise', async () => {
    sendFixtures({
      data: [{ id: 'm1', channel_id: CHANNEL_ID, content: [{ type: 'text', text: 'hi' }], bot_id: BOT_ID }],
      error: null,
    })
    const res = await supertest(makeApp())
      .post(`/api/v1/channels/${CHANNEL_ID}/messages`)
      .send({ content: 'hi' })

    expect(res.status).toBe(201)
  })
})
