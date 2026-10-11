/**
 * Thread routes a Discord bridge relies on (bridge 2.4): sending into a thread, creating a
 * thread (paired with a Discord thread or not), finding a pair, reading a thread and pairing a
 * Harmony-created one. bot_create_thread is an rpc; its SQL is covered by pgTAP test 136.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb, type Row } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const OWNER_ID = '00000000-0000-0000-0000-0000000000a1'
const PAIRED = '00000000-0000-0000-0000-0000000000c1'
const UNPAIRED = '00000000-0000-0000-0000-0000000000c2'
const EVERYONE_ROLE = '00000000-0000-0000-0000-0000000000e0'
const BRIDGE_ID = '00000000-0000-0000-0000-0000000000d0'
const STARTER = '00000000-0000-0000-0000-0000000000f1'
const THREAD = '00000000-0000-0000-0000-0000000000a7'
const LOCKED = '00000000-0000-0000-0000-0000000000a8'
const OTHER_THREAD = '00000000-0000-0000-0000-0000000000a9'

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

function seed({ sendMessages = true } = {}) {
  const tables: Record<string, Row[]> = {
    bots: [{ id: BOT_ID, username: 'discord-bridge', bot_type: 'bridge' }],
    servers: [{ id: SERVER_ID, owner: OWNER_ID }],
    server_roles: [
      { id: EVERYONE_ROLE, server_id: SERVER_ID, name: 'everyone', color: null, position: 0, permissions: 122646786, is_default: true },
    ],
    channels: [
      { id: PAIRED, server_id: SERVER_ID, name: 'general' },
      { id: UNPAIRED, server_id: SERVER_ID, name: 'staff' },
    ],
    channel_permission_overrides: [],
    bot_server_permissions: [{
      id: '00000000-0000-0000-0000-0000000000b9', bot_id: BOT_ID, server_id: SERVER_ID, installed_by: OWNER_ID,
      is_active: true, read_messages: true, send_messages: sendMessages,
    }],
    messages: [{ id: STARTER, channel_id: PAIRED, user_id: OWNER_ID, bot_id: null, content: [], metadata: {} }],
    threads: [
      { id: THREAD, channel_id: PAIRED, parent_message_id: STARTER, name: 'Starter', archived: false, locked: false, created_at: '2026-10-11T00:00:00Z' },
      { id: LOCKED, channel_id: PAIRED, parent_message_id: STARTER, name: 'Locked', archived: false, locked: true, created_at: '2026-10-11T00:00:00Z' },
      { id: OTHER_THREAD, channel_id: UNPAIRED, parent_message_id: STARTER, name: 'Elsewhere', archived: false, locked: false, created_at: '2026-10-11T00:00:00Z' },
    ],
    discord_bridges: [{ id: BRIDGE_ID, server_id: SERVER_ID, bot_id: BOT_ID, mode: 'self' }],
    discord_bridge_channels: [{ id: 'pair-1', bridge_id: BRIDGE_ID, harmony_channel_id: PAIRED, discord_channel_id: '11' }],
    discord_bridge_threads: [],
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

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.from.mockReset()
  mocks.rpc.mockImplementation(async (fn: string) => {
    throw new Error(`test called unmocked rpc: ${fn}`)
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /channels/:id/messages with thread_id', () => {
  it('posts into a thread of the channel and answers with its thread_id', async () => {
    seed()
    const res = await supertest(app())
      .post(`/api/v1/channels/${PAIRED}/messages`)
      .send({ content: 'in the thread', thread_id: THREAD })
    expect(res.status).toBe(201)
    expect(res.body.thread_id).toBe(THREAD)
    expect(db.rows('messages').find((m) => m.id === res.body.id)?.thread_id).toBe(THREAD)
  })

  it('refuses a thread of another channel, an unknown id and a locked thread', async () => {
    seed()
    const send = (thread_id: unknown) =>
      supertest(app()).post(`/api/v1/channels/${PAIRED}/messages`).send({ content: 'x', thread_id })
    expect((await send(OTHER_THREAD)).status).toBe(400)
    expect((await send('not-a-thread')).status).toBe(400)
    expect((await send(LOCKED)).status).toBe(403)
  })
})

describe('POST /channels/:id/threads', () => {
  it('creates a thread on a message, paired with a Discord thread, through bot_create_thread', async () => {
    seed()
    mocks.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      expect(fn).toBe('bot_create_thread')
      expect(args).toEqual({
        p_bot_id: BOT_ID, p_channel_id: PAIRED, p_name: 'From Discord',
        p_parent_message_id: STARTER, p_discord_thread_id: '1234567890123',
      })
      db.rows('discord_bridge_threads').push({ thread_id: THREAD, bridge_id: BRIDGE_ID, discord_thread_id: '1234567890123' })
      return { data: THREAD, error: null }
    })
    const res = await supertest(app())
      .post(`/api/v1/channels/${PAIRED}/threads`)
      .send({ name: 'From Discord', message_id: STARTER, discord_thread_id: '1234567890123' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ id: THREAD, channel_id: PAIRED, parent_message_id: STARTER, discord_thread_id: '1234567890123' })
  })

  it('refuses a Discord pair in a channel the bot does not bridge, and a bot without send_messages', async () => {
    seed()
    expect((await supertest(app()).post(`/api/v1/channels/${UNPAIRED}/threads`)
      .send({ name: 'x', discord_thread_id: '1234567890123' })).status).toBe(403)
    seed({ sendMessages: false })
    expect((await supertest(app()).post(`/api/v1/channels/${PAIRED}/threads`).send({ name: 'x' })).status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('validates its body', async () => {
    seed()
    const post = (body: unknown) => supertest(app()).post(`/api/v1/channels/${PAIRED}/threads`).send(body as object)
    expect((await post({ name: '  ' })).status).toBe(400)
    expect((await post({ name: 'x', message_id: 'nope' })).status).toBe(400)
    expect((await post({ name: 'x', discord_thread_id: 'abc' })).status).toBe(400)
  })

  it('maps rpc refusals to statuses', async () => {
    seed()
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'P0002', message: 'Message not found in this channel' } })
    expect((await supertest(app()).post(`/api/v1/channels/${PAIRED}/threads`)
      .send({ name: 'x', message_id: STARTER })).status).toBe(404)
  })
})

describe('thread pairs', () => {
  it('finds a Harmony thread by its Discord thread id, only in its own channel', async () => {
    seed()
    db.rows('discord_bridge_threads').push({ thread_id: THREAD, bridge_id: BRIDGE_ID, discord_thread_id: '555' })
    const found = await supertest(app()).get(`/api/v1/channels/${PAIRED}/threads/lookup?discord_thread_id=555`)
    expect(found.status).toBe(200)
    expect(found.body).toMatchObject({ id: THREAD, discord_thread_id: '555' })
    expect((await supertest(app()).get(`/api/v1/channels/${PAIRED}/threads/lookup?discord_thread_id=556`)).status).toBe(404)
    expect((await supertest(app()).get(`/api/v1/channels/${UNPAIRED}/threads/lookup?discord_thread_id=555`)).status).toBe(404)
  })

  it('reads a thread and pairs a Harmony-created one once', async () => {
    seed()
    const read = await supertest(app()).get(`/api/v1/threads/${THREAD}`)
    expect(read.status).toBe(200)
    expect(read.body).toMatchObject({ id: THREAD, name: 'Starter', discord_thread_id: null })

    const paired = await supertest(app()).put(`/api/v1/threads/${THREAD}/discord`).send({ discord_thread_id: '777' })
    expect(paired.status).toBe(200)
    expect(paired.body.discord_thread_id).toBe('777')
    expect((await supertest(app()).put(`/api/v1/threads/${THREAD}/discord`).send({ discord_thread_id: '777' })).status).toBe(200)
    const other = await supertest(app()).put(`/api/v1/threads/${THREAD}/discord`).send({ discord_thread_id: '778' })
    expect(other.status).toBe(409)
    expect(other.body.discord_thread_id).toBe('777')
    expect(db.rows('discord_bridge_threads').filter((r) => r.thread_id === THREAD).map((r) => r.discord_thread_id)).toEqual(['777'])
  })

  it('pairs only threads of bridged channels', async () => {
    seed()
    expect((await supertest(app()).put(`/api/v1/threads/${OTHER_THREAD}/discord`).send({ discord_thread_id: '1' })).status).toBe(403)
    expect((await supertest(app()).put(`/api/v1/threads/${THREAD}/discord`).send({ discord_thread_id: 'x' })).status).toBe(400)
  })
})
