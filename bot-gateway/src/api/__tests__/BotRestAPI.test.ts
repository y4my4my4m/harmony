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

// Auth and rate limiting are covered in src/auth/__tests__; here every request is already a bot.
vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => {
    req.bot = { id: BOT_ID, username: 'testbot', scopes: ['bot'] }
    next()
  },
  botRateLimit: (_req: any, _res: any, next: any) => next(),
}))

import { BotRestAPI, botContentParts, botSuppliedMetadata, claimsBridgeAuthor, reactionMetadata } from '../BotRestAPI.js'

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

// An active installation with send_messages, and @everyone's default mask with no override:
// every channel visible. Channel visibility is covered in BotRestAPI.permissions.test.ts.
const OPEN_CHANNEL_FIXTURES: Record<string, Result> = {
  bot_server_permissions: {
    data: { bot_id: BOT_ID, server_id: '00000000-0000-0000-0000-0000000000s1', is_active: true, read_messages: true, send_messages: true },
    error: null,
  },
  server_roles: { data: { id: '00000000-0000-0000-0000-0000000000e0', permissions: 122646786 }, error: null },
  channel_permission_overrides: { data: [], error: null },
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
          : OPEN_CHANNEL_FIXTURES[table] ?? { data: { server_id: 'srv' }, error: null }
      const builder: any = new Proxy(
        {
          single: async () => result,
          maybeSingle: async () => result,
          then: (resolve: any) => resolve(
            table === 'channel_permission_overrides' ? result : { data: null, error: null },
          ),
          update: (patch: any) => { updates.push(patch); return builder },
        },
        { get: (target, prop) => (prop in target ? (target as any)[prop] : () => builder) },
      )
      return builder
    })
    routeRpc({})

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
  // embeds holds link-preview payloads embed parts render; webhook names a webhook author.
  it('drops server-only keys, link previews and webhook authorship among them', () => {
    expect(botSuppliedMetadata({
      discord_message_id: '1', embeds: { 'https://x.test': { provider: 'generic' } }, suppress_embeds: true,
      webhook: { name: 'CI' }, federated: true, created_via: 'x',
    })).toEqual({ discord_message_id: '1' })
  })

  it('keeps the relayed author only for a relaying bridge', () => {
    const metadata = { discord_user: { id: '1', username: 'alice' }, bridge_source: 'discord', discord_message_id: '2' }
    expect(botSuppliedMetadata(metadata)).toEqual({ discord_message_id: '2' })
    expect(botSuppliedMetadata(metadata, { bridgeAuthor: true })).toEqual(metadata)
    expect(claimsBridgeAuthor(metadata)).toBe(true)
    expect(claimsBridgeAuthor({ discord_message_id: '2' })).toBe(false)
  })

  it('reads anything but a plain object as empty', () => {
    expect(botSuppliedMetadata(null)).toEqual({})
    expect(botSuppliedMetadata(['ap_id'])).toEqual({})
    expect(botSuppliedMetadata('x')).toEqual({})
  })
})

describe('botContentParts', () => {
  it('drops system parts and malformed embeds and keeps an embed part\'s own fields', () => {
    const system = { type: 'system', event_type: 'join', user: { id: 'u', username: 'admin', display_name: 'Admin' } }
    expect(botContentParts([
      { type: 'text', text: 'hi' },
      system,
      { type: 'embed', url: 'https://x.test/a', provider: 'generic', previewId: 'https://x.test/a', collapsed: true, html: '<iframe>' },
      { type: 'embed', url: 'javascript:alert(1)', provider: 'generic', previewId: 'p' },
      { type: 'embed', url: 'https://x.test/b', provider: 'evil', previewId: 'p' },
      { type: 'embed', title: 'Discord-style', description: 'no url' },
      { type: 'url', url: 'https://x.test/c', preview: true },
    ])).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'embed', url: 'https://x.test/a', provider: 'generic', previewId: 'https://x.test/a', collapsed: true },
      { type: 'url', url: 'https://x.test/c', preview: true },
    ])
  })
})

describe('AutoMod rejections', () => {
  const CHANNEL_ID = '00000000-0000-0000-0000-0000000000c1'

  function sendFixtures(messages: Result) {
    routeTables({
      ...OPEN_CHANNEL_FIXTURES,
      channels: { data: { server_id: '00000000-0000-0000-0000-0000000000s1' }, error: null },
      instance_config: { data: null, error: null },
      bot_audit_log: { data: null, error: null },
      messages,
    })
    routeRpc({})
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

/** routeTables, plus the payload of each insert into `table`. */
function captureInserts(table: string, tables: Record<string, Result>): unknown[] {
  routeTables(tables)
  const inserts: unknown[] = []
  const route = mocks.from.getMockImplementation()!
  mocks.from.mockImplementation((name: string) => {
    const builder = route(name)
    if (name !== table) return builder
    return new Proxy(builder, {
      get(target, prop) {
        if (prop === 'insert') {
          return (payload: unknown) => {
            inserts.push(payload)
            return builder
          }
        }
        return target[prop]
      },
    })
  })
  return inserts
}

describe('POST /channels/:id/messages file parts', () => {
  const CHANNEL_ID = '00000000-0000-0000-0000-0000000000c1'

  it('stores audio and Discord sticker parts as sent, without a bot-supplied path', async () => {
    const inserts = captureInserts('messages', {
      ...OPEN_CHANNEL_FIXTURES,
      channels: { data: { server_id: '00000000-0000-0000-0000-0000000000s1' }, error: null },
      instance_config: { data: { config_value: '"link"' }, error: null },
      bot_audit_log: { data: null, error: null },
      messages: { data: [{ id: 'm1', channel_id: CHANNEL_ID, content: [], bot_id: BOT_ID }], error: null },
    })
    routeRpc({})
    const voice = {
      type: 'file',
      fileType: 'audio',
      url: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=1',
      fileName: 'voice-message.ogg',
    }
    const sticker = { type: 'file', fileType: 'image', url: 'https://media.discordapp.net/stickers/749054660769218631.png?size=160' }

    const res = await supertest(makeApp())
      .post(`/api/v1/channels/${CHANNEL_ID}/messages`)
      .send({ content: [voice, { ...sticker, path: 'c/other/u/secret.png' }] })

    expect(res.status).toBe(201)
    expect(inserts).toHaveLength(1)
    expect((inserts[0] as { content: unknown }).content).toEqual([voice, sticker])
  })
})

describe('reactionMetadata', () => {
  it('keeps a Discord CDN remote_emoji_url, animated included', () => {
    const metadata = {
      remote_emoji_url: 'https://cdn.discordapp.com/emojis/1234567890.gif',
      remote_emoji_name: 'party',
      discord_user: { id: '80351110224678912' },
    }
    expect(reactionMetadata(metadata)).toEqual(metadata)
    expect(reactionMetadata({ remote_emoji_url: 'https://media.discordapp.net/emojis/1.webp?size=48' }))
      .toEqual({ remote_emoji_url: 'https://media.discordapp.net/emojis/1.webp?size=48' })
  })

  it('drops a remote_emoji_url off Discord\'s CDN or over http', () => {
    for (const url of [
      'https://tracker.example/pixel.gif',
      'http://cdn.discordapp.com/emojis/1.png',
      'https://cdn.discordapp.com.evil.example/emojis/1.png',
      'javascript:alert(1)',
      42,
    ]) {
      expect(reactionMetadata({ remote_emoji_url: url, remote_emoji_name: 'x' })).toEqual({ remote_emoji_name: 'x' })
    }
  })

  it('leaves absent metadata absent', () => {
    expect(reactionMetadata(undefined)).toBeNull()
    expect(reactionMetadata(null)).toBeNull()
  })
})

describe('PUT /messages/:id/reactions/:emoji', () => {
  const MESSAGE_ID = '00000000-0000-0000-0000-0000000000a1'

  it('stores a reaction without a remote_emoji_url outside Discord\'s CDN', async () => {
    const install = OPEN_CHANNEL_FIXTURES.bot_server_permissions.data as Record<string, unknown>
    const inserts = captureInserts('reactions', {
      ...OPEN_CHANNEL_FIXTURES,
      bot_server_permissions: { data: { ...install, add_reactions: true }, error: null },
      messages: { data: { channel_id: 'c1' }, error: null },
      channels: { data: { server_id: 's1' }, error: null },
      reactions: { data: null, error: null },
    })

    const res = await supertest(makeApp())
      .put(`/api/v1/messages/${MESSAGE_ID}/reactions/${encodeURIComponent('discord:party:1234567890')}`)
      .send({ metadata: { remote_emoji_url: 'https://tracker.example/p.gif', remote_emoji_name: 'party' } })

    expect(res.status).toBe(204)
    expect(inserts).toEqual([{
      message_id: MESSAGE_ID,
      bot_id: BOT_ID,
      metadata: { remote_emoji_name: 'party' },
      custom_emoji_content: 'discord:party:1234567890',
      emoji_id: null,
    }])
  })

  it('answers a twenty-first emoji on a message with Discord\'s 30010', async () => {
    const install = OPEN_CHANNEL_FIXTURES.bot_server_permissions.data as Record<string, unknown>
    routeTables({
      ...OPEN_CHANNEL_FIXTURES,
      bot_server_permissions: { data: { ...install, add_reactions: true }, error: null },
      messages: { data: { channel_id: 'c1' }, error: null },
      channels: { data: { server_id: 's1' }, error: null },
      reactions: { data: null, error: { code: '23514', message: 'REACTION_LIMIT: 20 different emoji per message' } },
    })

    const res = await supertest(makeApp()).put(`/api/v1/messages/${MESSAGE_ID}/reactions/%F0%9F%9A%80`).send({})

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Maximum number of reactions reached (20)', code: 30010 })
  })
})
