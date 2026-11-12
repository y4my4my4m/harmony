/**
 * Bot REST routes a Discord bridge relies on (bridge 2.2): one emoji by id, the Discord mapping
 * on Harmony-origin messages, and role and channel mention parts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb, type Row } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const OTHER_SERVER = '00000000-0000-0000-0000-00000000005b'
const OWNER_ID = '00000000-0000-0000-0000-0000000000a1'
const PAIRED = '00000000-0000-0000-0000-0000000000c1'
const UNPAIRED = '00000000-0000-0000-0000-0000000000c2'
const ELSEWHERE = '00000000-0000-0000-0000-0000000000c9'
const EVERYONE_ROLE = '00000000-0000-0000-0000-0000000000e0'
const CREW_ROLE = '00000000-0000-0000-0000-0000000000e1'
const OTHER_ROLE = '00000000-0000-0000-0000-0000000000e9'
const BRIDGE_ID = '00000000-0000-0000-0000-0000000000d0'
const HARMONY_MESSAGE = '00000000-0000-0000-0000-0000000000f1'
const UNPAIRED_MESSAGE = '00000000-0000-0000-0000-0000000000f2'
const EMOJI_ID = '00000000-0000-0000-0000-0000000000aa'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), policy: vi.fn(), enqueue: vi.fn() }))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: {},
}))

vi.mock('../../utils/mirrorExternalMedia.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/mirrorExternalMedia.js')>()),
  applyBridgeAttachmentPolicy: mocks.policy,
}))
vi.mock('../../bridge/mirrorEnqueue.js', () => ({ enqueueMirror: mocks.enqueue }))

vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => {
    req.bot = { id: BOT_ID, username: 'discord-bridge', scopes: ['bot'] }
    next()
  },
  botRateLimit: (_req: any, _res: any, next: any) => next(),
}))

import { BotRestAPI } from '../BotRestAPI.js'

let db: FakeDb

function seed({ botType = 'bridge', v2 = true, v1 = false, installedBy = OWNER_ID }: { botType?: string; v2?: boolean; v1?: boolean; installedBy?: string } = {}) {
  const tables: Record<string, Row[]> = {
    bots: [{ id: BOT_ID, username: 'discord-bridge', bot_type: botType }],
    servers: [{ id: SERVER_ID, owner: OWNER_ID }, { id: OTHER_SERVER, owner: OWNER_ID }],
    server_roles: [
      { id: EVERYONE_ROLE, server_id: SERVER_ID, name: 'everyone', color: null, position: 0, permissions: 122646786, is_default: true },
      { id: CREW_ROLE, server_id: SERVER_ID, name: 'Crew', color: '#00ff00', position: 1, permissions: 0, is_default: false },
      { id: OTHER_ROLE, server_id: OTHER_SERVER, name: 'Outsiders', color: '#ff0000', position: 1, permissions: 0, is_default: false },
    ],
    channels: [
      { id: PAIRED, server_id: SERVER_ID, name: 'general' },
      { id: UNPAIRED, server_id: SERVER_ID, name: 'staff' },
      { id: ELSEWHERE, server_id: OTHER_SERVER, name: 'secret-plans' },
    ],
    channel_permission_overrides: [],
    bot_server_permissions: [{
      id: '00000000-0000-0000-0000-0000000000b9', bot_id: BOT_ID, server_id: SERVER_ID, installed_by: installedBy,
      is_active: true, read_messages: true, send_messages: true,
    }],
    messages: [
      { id: HARMONY_MESSAGE, channel_id: PAIRED, user_id: OWNER_ID, bot_id: null, content: [], metadata: { source: 'harmony' } },
      { id: UNPAIRED_MESSAGE, channel_id: UNPAIRED, user_id: OWNER_ID, bot_id: null, content: [], metadata: {} },
    ],
    discord_bridges: v2 ? [{ id: BRIDGE_ID, server_id: SERVER_ID, bot_id: BOT_ID, mode: 'instance' }] : [],
    discord_bridge_channels: v2 ? [{ id: 'pair-1', bridge_id: BRIDGE_ID, harmony_channel_id: PAIRED, discord_channel_id: '11' }] : [],
    discord_bridge_pairings: v1 ? [{ server_id: SERVER_ID, pairing_code: 'HRM-AAAA-BBBB' }] : [],
    emojis: [{ id: EMOJI_ID, name: 'blobcat', url: 'https://harmony.test/storage/v1/object/public/emojis/s/u/blobcat.gif', server_id: SERVER_ID }],
    instance_config: [],
    bot_audit_log: [],
  }
  db = new FakeDb(tables)
  mocks.from.mockImplementation((table: string) => db.from(table))
}

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/v1', new BotRestAPI().router)
  return a
}

const metadataOf = (id: string) => db.rows('messages').find((m) => m.id === id)?.metadata

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.from.mockReset()
  mocks.policy.mockReset()
  mocks.policy.mockImplementation(async (parts: unknown[]) => ({ parts, deferred: false }))
  mocks.enqueue.mockReset()
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'update_message_content_silent') return { data: true, error: null }
    throw new Error(`test called unmocked rpc: ${fn}`)
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /emojis?id=', () => {
  it('answers one emoji by id', async () => {
    seed()
    const res = await supertest(app()).get(`/api/v1/emojis?id=${EMOJI_ID}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: EMOJI_ID, name: 'blobcat', url: expect.stringContaining('blobcat.gif') })
  })

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    seed()
    expect((await supertest(app()).get('/api/v1/emojis?id=00000000-0000-0000-0000-0000000000ab')).status).toBe(404)
    expect((await supertest(app()).get('/api/v1/emojis?id=blobcat')).status).toBe(400)
  })

  it('still lists every emoji without an id', async () => {
    seed()
    const res = await supertest(app()).get('/api/v1/emojis')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
  })
})

describe('PATCH /messages/:id/metadata on a Harmony-origin message', () => {
  const MAPPING = {
    discord_message_id: '1300000000000000001',
    discord_message_ids: ['1300000000000000001', '1300000000000000002'],
    discord_via_webhook: true,
    discord_uploaded_files: ['cat.png'],
  }

  it('lets a bridge bot record its Discord mapping in a channel its bridge pairs', async () => {
    seed()
    const res = await supertest(app()).patch(`/api/v1/messages/${HARMONY_MESSAGE}/metadata`).send({ metadata: MAPPING })

    expect(res.status).toBe(200)
    expect(metadataOf(HARMONY_MESSAGE)).toEqual({ source: 'harmony', ...MAPPING })
  })

  // Bridge 2.2 sends the mapping with bridge_source 'harmony' in one request.
  it('accepts the mapping with bridge_source harmony', async () => {
    seed()
    const metadata = { ...MAPPING, bridge_source: 'harmony' }
    const res = await supertest(app()).patch(`/api/v1/messages/${HARMONY_MESSAGE}/metadata`).send({ metadata })

    expect(res.status).toBe(200)
    expect(metadataOf(HARMONY_MESSAGE)).toEqual({ source: 'harmony', ...metadata })
  })

  it('refuses any other key, alone or beside the mapping', async () => {
    seed()
    for (const metadata of [
      { discord_user: { id: '1', username: 'spoofed' } },
      { ...MAPPING, bridge_source: 'discord' },
      { bridge_source: 'harmony', discord_user: { id: '1', username: 'spoofed' } },
      {},
    ]) {
      const res = await supertest(app()).patch(`/api/v1/messages/${HARMONY_MESSAGE}/metadata`).send({ metadata })
      expect(res.status).toBe(403)
    }
    expect(metadataOf(HARMONY_MESSAGE)).toEqual({ source: 'harmony' })
  })

  it('refuses a channel the bridge does not pair', async () => {
    seed()
    const res = await supertest(app()).patch(`/api/v1/messages/${UNPAIRED_MESSAGE}/metadata`).send({ metadata: MAPPING })
    expect(res.status).toBe(403)
    expect(metadataOf(UNPAIRED_MESSAGE)).toEqual({})
  })

  it('refuses a bot that is no bridge bot', async () => {
    seed({ botType: 'bot' })
    const res = await supertest(app()).patch(`/api/v1/messages/${HARMONY_MESSAGE}/metadata`).send({ metadata: MAPPING })
    expect(res.status).toBe(403)
    expect(metadataOf(HARMONY_MESSAGE)).toEqual({ source: 'harmony' })
  })

  it('takes a v1 pairing of the server for a bridge bot without a v2 bridge, and only then', async () => {
    seed({ v2: false, v1: true })
    const v1 = await supertest(app()).patch(`/api/v1/messages/${UNPAIRED_MESSAGE}/metadata`).send({ metadata: MAPPING })
    expect(v1.status).toBe(200)

    seed({ v2: true, v1: true })
    const v2 = await supertest(app()).patch(`/api/v1/messages/${UNPAIRED_MESSAGE}/metadata`).send({ metadata: MAPPING })
    expect(v2.status).toBe(403)
  })

  it('takes no v1 pairing for a bridge bot neither the server owner nor the pairing creator brought', async () => {
    seed({ v2: false, v1: true, installedBy: '00000000-0000-0000-0000-0000000000ee' })
    const res = await supertest(app()).patch(`/api/v1/messages/${UNPAIRED_MESSAGE}/metadata`).send({ metadata: MAPPING })
    expect(res.status).toBe(403)
  })
})

describe('role and channel mention parts', () => {
  const insertedContent = () => db.writesTo('messages', 'insert')[0].rows[0].content

  it('keeps mentions of the channel\'s server with the stored names and turns others into text', async () => {
    seed()
    const res = await supertest(app())
      .post(`/api/v1/channels/${PAIRED}/messages`)
      .send({
        content: [
          { type: 'text', text: 'hey ' },
          { type: 'role_mention', roleId: CREW_ROLE, roleName: 'wrong name', roleColor: '#123456' },
          { type: 'role_mention', roleId: OTHER_ROLE, roleName: 'Outsiders', roleColor: null },
          { type: 'role_mention', roleId: 'not-a-uuid', roleName: 'mods' },
          { type: 'channel_mention', channelId: UNPAIRED, serverId: OTHER_SERVER, name: 'x' },
          { type: 'channel_mention', channelId: ELSEWHERE, serverId: OTHER_SERVER, name: 'secret-plans' },
          { type: 'channel_mention', channelId: PAIRED },
        ],
      })

    expect(res.status).toBe(201)
    expect(insertedContent()).toEqual([
      { type: 'text', text: 'hey ' },
      { type: 'role_mention', roleId: CREW_ROLE, roleName: 'Crew', roleColor: '#00ff00' },
      { type: 'text', text: '@Outsiders' },
      { type: 'text', text: '@mods' },
      { type: 'channel_mention', channelId: UNPAIRED, serverId: SERVER_ID, name: 'staff' },
      { type: 'text', text: '#secret-plans' },
      { type: 'channel_mention', channelId: PAIRED, serverId: SERVER_ID, name: 'general' },
    ])
  })

  it('applies the same check to an edit', async () => {
    seed()
    db.rows('messages').push({ id: '00000000-0000-0000-0000-0000000000f3', channel_id: PAIRED, user_id: null, bot_id: BOT_ID, content: [], metadata: {} })
    const res = await supertest(app())
      .patch('/api/v1/messages/00000000-0000-0000-0000-0000000000f3')
      .send({ content: [{ type: 'role_mention', roleId: OTHER_ROLE, roleName: 'Outsiders' }] })

    expect(res.status).toBe(200)
    expect(db.writesTo('messages', 'update')[0].rows[0].content).toEqual([{ type: 'text', text: '@Outsiders' }])
  })

  describe('@everyone and @here', () => {
    const pings = [
      { type: 'role_mention', roleId: 'here', roleName: 'online', roleColor: '#123456' },
      { type: 'text', text: ' and ' },
      { type: 'role_mention', roleId: EVERYONE_ROLE, roleName: 'everyone', roleColor: null },
    ]

    function mentionEveryone(granted: boolean) {
      mocks.rpc.mockImplementation(async (fn: string, args: any) => {
        if (fn === 'check_bot_permission' && args.p_permission === 'mention_everyone' && args.p_bot_id === BOT_ID) {
          return { data: granted, error: null }
        }
        throw new Error(`test called unmocked rpc: ${fn}`)
      })
    }

    it('keeps both parts for a bot holding mention_everyone', async () => {
      seed()
      mentionEveryone(true)
      const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`).send({ content: pings })

      expect(res.status).toBe(201)
      expect(insertedContent()).toEqual([
        { type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null },
        { type: 'text', text: ' and ' },
        { type: 'role_mention', roleId: EVERYONE_ROLE, roleName: 'everyone', roleColor: null },
      ])
    })

    it('turns both into text for a bot without it, as the database ignores them', async () => {
      seed()
      mentionEveryone(false)
      const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`).send({ content: pings })

      expect(res.status).toBe(201)
      expect(insertedContent()).toEqual([
        { type: 'text', text: '@here' },
        { type: 'text', text: ' and ' },
        { type: 'text', text: '@everyone' },
      ])
    })

    const typed = 'standup @everyone, `@here` https://x.test/@here @Everyone @everyone@other.test @here!'

    it('reads typed words in string content as pings for a bot holding mention_everyone', async () => {
      seed()
      mentionEveryone(true)
      const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`).send({ content: typed })

      expect(res.status).toBe(201)
      expect(insertedContent()).toEqual([
        { type: 'text', text: 'standup ' },
        { type: 'role_mention', roleId: EVERYONE_ROLE, roleName: 'everyone', roleColor: null },
        { type: 'text', text: ', `@here` https://x.test/@here @Everyone @everyone@other.test ' },
        { type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null },
        { type: 'text', text: '!' },
      ])
    })

    it('keeps typed words text for a bot without it', async () => {
      seed()
      mentionEveryone(false)
      const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`).send({ content: typed })

      expect(res.status).toBe(201)
      expect(insertedContent()).toEqual([{ type: 'text', text: typed }])
    })

    it('keeps typed words text in relayed content and in text parts', async () => {
      seed()
      mentionEveryone(true)
      await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
        .send({ content: '@everyone', metadata: { discord_user: { id: '42', username: 'alice' }, bridge_source: 'discord' } })
      await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
        .send({ content: [{ type: 'text', text: '@everyone' }] })

      const inserts = db.writesTo('messages', 'insert')
      expect(inserts[0].rows[0].content).toEqual([{ type: 'text', text: '@everyone' }])
      expect(inserts[1].rows[0].content).toEqual([{ type: 'text', text: '@everyone' }])
    })

    it('asks nothing when the message pings no one', async () => {
      seed()
      const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
        .send({ content: [{ type: 'role_mention', roleId: CREW_ROLE }] })

      expect(res.status).toBe(201)
      expect(mocks.rpc).not.toHaveBeenCalled()
    })
  })
})

describe('relayed authors and server-only content', () => {
  const inserted = () => db.writesTo('messages', 'insert')[0].rows[0]
  const AUTHOR = { discord_user: { id: '42', username: 'alice', display_name: 'Alice' }, bridge_source: 'discord' }

  it('keeps discord_user from a bridge bot in a channel its bridge pairs', async () => {
    seed()
    const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
      .send({ content: [{ type: 'text', text: 'hi' }], metadata: { ...AUTHOR, discord_message_id: '7' } })
    expect(res.status).toBe(201)
    expect(inserted().metadata).toEqual({ ...AUTHOR, discord_message_id: '7', bot: true, created_via: 'bot_api' })
  })

  it('drops it in a channel the bridge does not pair, and from a bot that is no bridge bot', async () => {
    seed()
    const unpaired = await supertest(app()).post(`/api/v1/channels/${UNPAIRED}/messages`)
      .send({ content: 'hi', metadata: AUTHOR })
    expect(unpaired.status).toBe(201)
    expect(inserted().metadata).toEqual({ bot: true, created_via: 'bot_api' })

    seed({ botType: 'bot' })
    const ordinary = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
      .send({ content: 'hi', metadata: AUTHOR })
    expect(ordinary.status).toBe(201)
    expect(inserted().metadata).toEqual({ bot: true, created_via: 'bot_api' })
  })

  it('drops it from a metadata merge outside a paired channel', async () => {
    seed({ botType: 'bot' })
    db.rows('messages').push({ id: '00000000-0000-0000-0000-0000000000f4', channel_id: PAIRED, user_id: null, bot_id: BOT_ID, content: [], metadata: {} })
    const res = await supertest(app()).patch('/api/v1/messages/00000000-0000-0000-0000-0000000000f4/metadata')
      .send({ metadata: { ...AUTHOR, discord_message_id: '8' } })
    expect(res.status).toBe(200)
    expect(metadataOf('00000000-0000-0000-0000-0000000000f4')).toEqual({ discord_message_id: '8' })
  })

  it('strips system parts, malformed embeds and server-only metadata from a sent message', async () => {
    seed()
    const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
      .send({
        content: [
          { type: 'system', event_type: 'join', user: { id: 'u', username: 'admin', display_name: 'Admin' } },
          { type: 'text', text: 'real' },
          { type: 'embed', url: 'https://x.test', provider: 'generic', previewId: 'https://x.test', html: '<script>' },
        ],
        embeds: [{ title: 'Discord-style embed' }],
        metadata: { embeds: { 'https://x.test': { provider: 'generic', html: '<script>' } }, suppress_embeds: true, webhook: { name: 'CI' } },
      })
    expect(res.status).toBe(201)
    expect(inserted().content).toEqual([
      { type: 'text', text: 'real' },
      { type: 'embed', url: 'https://x.test', provider: 'generic', previewId: 'https://x.test' },
    ])
    expect(inserted().metadata).toEqual({ bot: true, created_via: 'bot_api' })
  })

  it('drops history_import from bot-supplied metadata, on send and on a metadata merge', async () => {
    seed()
    const sent = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
      .send({ content: 'hi', metadata: { ...AUTHOR, discord_message_id: '9', history_import: true, discord_reply_to: '5' } })
    expect(sent.status).toBe(201)
    expect(inserted().metadata).not.toHaveProperty('history_import')
    expect(inserted().metadata).not.toHaveProperty('discord_reply_to')

    const own = '00000000-0000-0000-0000-0000000000f5'
    db.rows('messages').push({ id: own, channel_id: PAIRED, user_id: null, bot_id: BOT_ID, content: [], metadata: {} })
    const merged = await supertest(app()).patch(`/api/v1/messages/${own}/metadata`)
      .send({ metadata: { discord_message_id: '10', history_import: true, discord_reply_to: '5', created_via: 'history_import' } })
    expect(merged.status).toBe(200)
    expect(metadataOf(own)).toEqual({ discord_message_id: '10' })
  })

  it('refuses a message left empty', async () => {
    seed()
    const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
      .send({ content: [{ type: 'system', event_type: 'leave', user: { id: 'u' } }] })
    expect(res.status).toBe(400)
    expect(db.writesTo('messages', 'insert')).toHaveLength(0)
  })
})

describe('sendMessage and a Discord message id already bridged', () => {
  const EXISTING = '00000000-0000-0000-0000-0000000000f7'
  const DUPLICATE_ERROR = {
    code: '23505',
    message: 'duplicate key value violates unique constraint "messages_channel_discord_message_id_unique"',
  }

  // The insert of a message is refused by the unique index; reads go to the fake table.
  function refuseInsert(error: { code: string; message: string }) {
    mocks.from.mockImplementation((table: string) => {
      const query: any = db.from(table)
      if (table !== 'messages') return query
      const insert = () => ({ select: async () => ({ data: null, error }) })
      return new Proxy(query, { get: (target, prop) => (prop === 'insert' ? insert : target[prop].bind(target)) })
    })
  }

  it('returns the existing message when the Discord message id is already bridged', async () => {
    seed()
    db.rows('messages').push({
      id: EXISTING, channel_id: PAIRED, user_id: null, bot_id: BOT_ID,
      content: [{ type: 'text', text: 'first' }], metadata: { discord_message_id: '77', bot: true }, is_deleted: false,
    })
    refuseInsert(DUPLICATE_ERROR)
    const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
      .send({ content: [{ type: 'text', text: 'again' }], metadata: { discord_message_id: '77' } })
    expect(res.status).toBe(200)
    expect(res.body.id).toBe(EXISTING)
    expect(res.body.content).toBe('first')
    expect(db.rows('bot_audit_log')).toHaveLength(0)
  })

  it('still fails on any other unique violation', async () => {
    seed()
    refuseInsert({ code: '23505', message: 'duplicate key value violates unique constraint "messages_pkey"' })
    const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
      .send({ content: [{ type: 'text', text: 'again' }], metadata: { discord_message_id: '77' } })
    expect(res.status).toBe(500)
  })

  it('answers 409 without the row when another bot holds the Discord message id', async () => {
    seed()
    db.rows('messages').push({
      id: EXISTING, channel_id: PAIRED, user_id: null, bot_id: '00000000-0000-0000-0000-0000000000b7',
      content: [{ type: 'text', text: 'not yours' }], metadata: { discord_message_id: '77', bot: true }, is_deleted: false,
    })
    refuseInsert(DUPLICATE_ERROR)
    const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
      .send({ content: [{ type: 'text', text: 'again' }], metadata: { discord_message_id: '77' } })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('DISCORD_MESSAGE_ID_TAKEN')
    expect(JSON.stringify(res.body)).not.toContain('not yours')
  })

  it('answers 403 BRIDGE_AUTHOR_OPTED_OUT when the relayed author opted out', async () => {
    seed()
    refuseInsert({ code: '23514', message: 'BRIDGE_AUTHOR_OPTED_OUT' })
    const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
      .send({ content: [{ type: 'text', text: 'hi' }], metadata: { discord_user: { id: '400000000000000001', username: 'dana' }, discord_message_id: '78' } })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('BRIDGE_AUTHOR_OPTED_OUT')
  })
})

describe('PATCH /messages/:id/metadata and a Discord message id already bridged', () => {
  const MINE = '00000000-0000-0000-0000-0000000000f8'
  const UPDATE_DUPLICATE = {
    code: '23505',
    message: 'duplicate key value violates unique constraint "messages_channel_discord_message_id_unique"',
  }

  function refuseUpdate(error: { code: string; message: string }) {
    mocks.from.mockImplementation((table: string) => {
      const query: any = db.from(table)
      if (table !== 'messages') return query
      const update = () => ({ eq: async () => ({ error }) })
      return new Proxy(query, { get: (target, prop) => (prop === 'update' ? update : target[prop].bind(target)) })
    })
  }

  it('answers 200 and leaves the message unchanged when an import already holds the id', async () => {
    seed()
    db.rows('messages').push({ id: MINE, channel_id: PAIRED, user_id: null, bot_id: BOT_ID, content: [], metadata: { bot: true } })
    refuseUpdate(UPDATE_DUPLICATE)
    const res = await supertest(app()).patch(`/api/v1/messages/${MINE}/metadata`)
      .send({ metadata: { discord_message_id: '77' } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, metadata: { bot: true } })
  })

  it('still fails on any other unique violation', async () => {
    seed()
    db.rows('messages').push({ id: MINE, channel_id: PAIRED, user_id: null, bot_id: BOT_ID, content: [], metadata: {} })
    refuseUpdate({ code: '23505', message: 'duplicate key value violates unique constraint "messages_pkey"' })
    const res = await supertest(app()).patch(`/api/v1/messages/${MINE}/metadata`)
      .send({ metadata: { discord_message_id: '77' } })
    expect(res.status).toBe(500)
  })
})

describe('messages whose attachments the policy deferred', () => {
  const CDN = 'https://cdn.discordapp.com/attachments/1/2/big.mp4'
  const OWN = '00000000-0000-0000-0000-0000000000f8'
  const defer = () => mocks.policy.mockImplementation(async (parts: unknown[]) => ({ parts, deferred: true }))

  it('queues a new message for the mirror worker', async () => {
    seed()
    defer()
    const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`).send({ content: [{ type: 'url', url: CDN }] })
    expect(res.status).toBe(201)
    expect(mocks.enqueue).toHaveBeenCalledTimes(1)
    expect(mocks.enqueue).toHaveBeenCalledWith([res.body.id])
  })

  it('does not queue a message nothing was deferred for', async () => {
    seed()
    const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`).send({ content: [{ type: 'text', text: 'hi' }] })
    expect(res.status).toBe(201)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it('does not queue the existing row of a duplicate', async () => {
    seed()
    defer()
    db.rows('messages').push({
      id: OWN, channel_id: PAIRED, user_id: null, bot_id: BOT_ID,
      content: [{ type: 'text', text: 'first' }], metadata: { discord_message_id: '78', bot: true }, is_deleted: false,
    })
    mocks.from.mockImplementation((table: string) => {
      const query: any = db.from(table)
      if (table !== 'messages') return query
      const insert = () => ({ select: async () => ({ data: null, error: {
        code: '23505', message: 'duplicate key value violates unique constraint "messages_channel_discord_message_id_unique"',
      } }) })
      return new Proxy(query, { get: (target, prop) => (prop === 'insert' ? insert : target[prop].bind(target)) })
    })
    const res = await supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`)
      .send({ content: [{ type: 'url', url: CDN }], metadata: { discord_message_id: '78' } })
    expect(res.status).toBe(200)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })

  it('queues an edited message', async () => {
    seed()
    defer()
    db.rows('messages').push({
      id: OWN, channel_id: PAIRED, user_id: null, bot_id: BOT_ID,
      content: [{ type: 'text', text: 'first' }], metadata: { bot: true }, is_deleted: false,
    })
    const res = await supertest(app()).patch(`/api/v1/messages/${OWN}`).send({ content: [{ type: 'url', url: CDN }] })
    expect(res.status).toBe(200)
    expect(mocks.enqueue).toHaveBeenCalledWith([OWN])
  })

  it('does not queue an edit nothing was deferred for', async () => {
    seed()
    db.rows('messages').push({
      id: OWN, channel_id: PAIRED, user_id: null, bot_id: BOT_ID,
      content: [{ type: 'text', text: 'first' }], metadata: { bot: true }, is_deleted: false,
    })
    const res = await supertest(app()).patch(`/api/v1/messages/${OWN}`).send({ content: [{ type: 'text', text: 'second' }] })
    expect(res.status).toBe(200)
    expect(mocks.enqueue).not.toHaveBeenCalled()
  })
})

describe('PATCH /messages/:id/content-silent never replaces a mirrored part', () => {
  const OWN = '00000000-0000-0000-0000-0000000000f9'
  const PATH = `c/${PAIRED}/bridge/${BOT_ID}/abc.png`
  const NEW_CDN = 'https://cdn.discordapp.com/attachments/1/2/cat.png?ex=2'
  const silentCalls = () => mocks.rpc.mock.calls.filter(([fn]) => fn === 'update_message_content_silent')

  function own(content: unknown[]) {
    seed()
    db.rows('messages').push({
      id: OWN, channel_id: PAIRED, user_id: null, bot_id: BOT_ID, content, metadata: { bot: true }, is_deleted: false,
    })
  }

  it('refuses to swap a stored file for a Discord link', async () => {
    own([{ type: 'file', fileType: 'image', url: 'https://x/storage/cat.png', path: PATH }])
    const res = await supertest(app()).patch(`/api/v1/messages/${OWN}/content-silent`)
      .send({ content: [{ type: 'file', fileType: 'image', url: NEW_CDN }] })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'mirrored_part' })
    expect(silentCalls()).toHaveLength(0)
  })

  it('refuses when the mirrored part is dropped', async () => {
    own([{ type: 'file', fileType: 'image', url: 'u', path: PATH }])
    const res = await supertest(app()).patch(`/api/v1/messages/${OWN}/content-silent`).send({ content: [] })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'mirrored_part' })
  })

  it('lets one Discord link be swapped for a fresh one', async () => {
    own([{ type: 'file', fileType: 'image', url: 'https://cdn.discordapp.com/attachments/1/2/cat.png?ex=1' }])
    const res = await supertest(app()).patch(`/api/v1/messages/${OWN}/content-silent`)
      .send({ content: [{ type: 'file', fileType: 'image', url: NEW_CDN }] })
    expect(res.status).toBe(200)
    expect(silentCalls()).toHaveLength(1)
  })

  it('lets a mirrored part stay as it is', async () => {
    const part = { type: 'file', fileType: 'image', url: 'https://x/storage/cat.png', path: PATH }
    own([part])
    const res = await supertest(app()).patch(`/api/v1/messages/${OWN}/content-silent`).send({ content: [part] })
    expect(res.status).toBe(200)
  })
})
