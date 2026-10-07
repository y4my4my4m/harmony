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

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: {},
}))

vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => {
    req.bot = { id: BOT_ID, username: 'discord-bridge', scopes: ['bot'] }
    next()
  },
  botRateLimit: (_req: any, _res: any, next: any) => next(),
}))

import { BotRestAPI } from '../BotRestAPI.js'

let db: FakeDb

function seed({ botType = 'bridge', v2 = true, v1 = false }: { botType?: string; v2?: boolean; v1?: boolean } = {}) {
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
      id: '00000000-0000-0000-0000-0000000000b9', bot_id: BOT_ID, server_id: SERVER_ID, installed_by: OWNER_ID,
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

  it('refuses any other key, alone or beside the mapping', async () => {
    seed()
    for (const metadata of [
      { discord_user: { id: '1', username: 'spoofed' } },
      { ...MAPPING, bridge_source: 'discord' },
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
})
