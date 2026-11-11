/**
 * Interaction reply routes: POST /interactions/:id/callback, PATCH /interactions/:id/response,
 * POST /interactions/:id/followups. The bot_interaction_* RPCs are mocked to the contract's
 * answers; their SQL is covered by pgTAP 257 and tests/db.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb, type Row } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const OTHER_BOT = '00000000-0000-0000-0000-0000000000b9'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const CHANNEL = '00000000-0000-0000-0000-0000000000c1'
const EVERYONE_ROLE = '00000000-0000-0000-0000-0000000000e0'
const ALICE = '00000000-0000-0000-0000-0000000000a1'
const INTERACTION = '00000000-0000-0000-0000-00000000001a'
const FOREIGN = '00000000-0000-0000-0000-00000000001b'
const THREAD = '00000000-0000-0000-0000-0000000000a7'
const LOCKED = '00000000-0000-0000-0000-0000000000a8'
const REPLY_ID = '00000000-0000-0000-0000-0000000000f5'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: {},
}))

vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => {
    req.bot = { id: BOT_ID, username: 'weatherbot', scopes: ['bot'] }
    next()
  },
  botRateLimit: (_req: any, _res: any, next: any) => next(),
}))

import { BotRestAPI, botSuppliedMetadata, interactionErrorResponse, replyFlags } from '../BotRestAPI.js'

let db: FakeDb
// rpc names and message inserts, in call order.
let log: string[]
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>
let rpcAnswers: Record<string, (args: any) => { data: unknown; error: unknown }>

function seed({ sendMessages = true, threadId = null as string | null } = {}) {
  const tables: Record<string, Row[]> = {
    channels: [{ id: CHANNEL, server_id: SERVER_ID, name: 'general' }],
    server_roles: [{ id: EVERYONE_ROLE, server_id: SERVER_ID, name: 'everyone', color: null, permissions: 122646786, is_default: true }],
    channel_permission_overrides: [],
    bot_server_permissions: [{
      id: 'install', bot_id: BOT_ID, server_id: SERVER_ID, is_active: true, read_messages: true, send_messages: sendMessages,
    }],
    threads: [
      { id: THREAD, channel_id: CHANNEL, parent_message_id: 'p', name: 'T', archived: false, locked: false, created_at: '2026-11-10T00:00:00Z' },
      { id: LOCKED, channel_id: CHANNEL, parent_message_id: 'p', name: 'L', archived: false, locked: true, created_at: '2026-11-10T00:00:00Z' },
    ],
    bot_interactions: [
      { id: INTERACTION, bot_id: BOT_ID, channel_id: CHANNEL, thread_id: threadId, user_id: ALICE, command_name: 'weather', ephemeral: false },
      { id: FOREIGN, bot_id: OTHER_BOT, channel_id: CHANNEL, thread_id: null, user_id: ALICE, command_name: 'other', ephemeral: false },
    ],
    messages: [],
    instance_config: [],
    bot_audit_log: [],
  }
  db = new FakeDb(tables)
  mocks.from.mockImplementation((table: string) => {
    const query = db.from(table)
    if (table === 'messages') {
      const insert = query.insert.bind(query)
      const update = query.update.bind(query)
      ;(query as any).insert = (values: Row) => { log.push('insert:messages'); return insert(values) }
      ;(query as any).update = (values: Row) => { log.push('update:messages'); return update(values) }
    }
    return query
  })
}

/** The ack the contract describes for this bot's interaction. */
function ackRow(threadId: string | null = null, ephemeral = false) {
  return {
    id: INTERACTION, status: ephemeral ? 'responded' : 'responding', ephemeral,
    channel_id: CHANNEL, thread_id: threadId, user_id: ALICE, command_name: 'weather',
    expires_at: '2026-11-10T00:15:00Z',
  }
}

const raise = (message: string) => () => ({ data: null, error: { code: 'P0001', message } })

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/v1', new BotRestAPI().router)
  return a
}

const callback = (body: unknown, id = INTERACTION) =>
  supertest(app()).post(`/api/v1/interactions/${id}/callback`).send(body as object)
const respond = (body: unknown, id = INTERACTION) =>
  supertest(app()).patch(`/api/v1/interactions/${id}/response`).send(body as object)
const followup = (body: unknown, id = INTERACTION) =>
  supertest(app()).post(`/api/v1/interactions/${id}/followups`).send(body as object)

const argsOf = (fn: string) => rpcCalls.filter((c) => c.fn === fn).map((c) => c.args)
const insertedMessages = () => db.writesTo('messages', 'insert').flatMap((w) => w.rows)

beforeEach(() => {
  log = []
  rpcCalls = []
  rpcAnswers = {
    bot_interaction_record: () => ({ data: null, error: null }),
  }
  mocks.rpc.mockReset()
  mocks.from.mockReset()
  mocks.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    log.push(`rpc:${fn}`)
    rpcCalls.push({ fn, args })
    const answer = rpcAnswers[fn]
    if (!answer) throw new Error(`test called unmocked rpc: ${fn}`)
    return answer(args)
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /interactions/:id/callback', () => {
  it('acknowledges, then posts the public reply with metadata.interaction, then records its id', async () => {
    seed()
    rpcAnswers.bot_interaction_ack = () => ({ data: ackRow(), error: null })
    const res = await callback({ type: 4, data: { content: 'Tokyo: 18 °C' } })

    expect(res.status).toBe(204)
    expect(log).toEqual(['rpc:bot_interaction_ack', 'insert:messages', 'rpc:bot_interaction_record'])
    expect(argsOf('bot_interaction_ack')).toEqual([
      { p_bot_id: BOT_ID, p_id: INTERACTION, p_defer: false, p_ephemeral: false, p_reply: null },
    ])
    const [message] = insertedMessages()
    expect(message).toMatchObject({
      channel_id: CHANNEL, thread_id: null, bot_id: BOT_ID,
      content: [{ type: 'text', text: 'Tokyo: 18 °C' }],
      metadata: { bot: true, created_via: 'bot_api', interaction: { id: INTERACTION, name: 'weather', user_id: ALICE } },
    })
    expect(message.metadata.interaction).not.toHaveProperty('followup')
    expect(argsOf('bot_interaction_record')).toEqual([
      { p_bot_id: BOT_ID, p_id: INTERACTION, p_message_id: message.id, p_error: null },
    ])
  })

  it('posts into the thread the command was used in', async () => {
    seed({ threadId: THREAD })
    rpcAnswers.bot_interaction_ack = () => ({ data: ackRow(THREAD), error: null })
    const res = await callback({ type: 4, data: { content: 'in thread' } })

    expect(res.status).toBe(204)
    expect(insertedMessages()[0].thread_id).toBe(THREAD)
  })

  it('records an AutoMod refusal and answers it as POST /channels/:id/messages does', async () => {
    seed()
    db.failures.messages = { message: 'AUTOMOD_BLOCKED:keyword' }
    rpcAnswers.bot_interaction_ack = () => ({ data: ackRow(), error: null })
    const res = await callback({ type: 4, data: { content: 'blocked words' } })

    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: "Blocked by the server's AutoMod", code: 'AUTOMOD_BLOCKED' })
    expect(log).toEqual(['rpc:bot_interaction_ack', 'insert:messages', 'rpc:bot_interaction_record'])
    expect(argsOf('bot_interaction_record')).toEqual([
      { p_bot_id: BOT_ID, p_id: INTERACTION, p_message_id: null, p_error: 'automod_blocked' },
    ])
  })

  it('records a locked thread and a channel the bot can no longer post in', async () => {
    seed({ threadId: LOCKED })
    rpcAnswers.bot_interaction_ack = () => ({ data: ackRow(LOCKED), error: null })
    const locked = await callback({ type: 4, data: { content: 'x' } })
    expect(locked.status).toBe(403)
    expect(argsOf('bot_interaction_record').at(-1)).toMatchObject({ p_message_id: null, p_error: 'thread_locked' })

    seed({ sendMessages: false })
    rpcAnswers.bot_interaction_ack = () => ({ data: ackRow(), error: null })
    const denied = await callback({ type: 4, data: { content: 'x' } })
    expect(denied.status).toBe(403)
    expect(argsOf('bot_interaction_record').at(-1)).toMatchObject({ p_message_id: null, p_error: 'bot_cannot_post' })
    expect(insertedMessages()).toEqual([])
  })

  it('records a write that throws as failed', async () => {
    seed()
    const route = mocks.from.getMockImplementation()!
    mocks.from.mockImplementation((table: string) => {
      if (table === 'messages') throw new Error('socket hang up')
      return route(table)
    })
    rpcAnswers.bot_interaction_ack = () => ({ data: ackRow(), error: null })
    const res = await callback({ type: 4, data: { content: 'x' } })

    expect(res.status).toBe(500)
    expect(argsOf('bot_interaction_record')).toEqual([
      { p_bot_id: BOT_ID, p_id: INTERACTION, p_message_id: null, p_error: 'failed' },
    ])
  })

  it('stores a private reply through the ack and writes no message', async () => {
    seed()
    rpcAnswers.bot_interaction_ack = () => ({ data: ackRow(null, true), error: null })
    const res = await callback({
      type: 4,
      data: {
        flags: 64,
        content: [
          { type: 'text', text: 'Only you: ' },
          { type: 'system', event_type: 'join' },
          { type: 'file', url: 'https://cdn.test/a.png', path: 'c/other/secret.png' },
          { type: 'channel_mention', channelId: '00000000-0000-0000-0000-0000000000ff', name: 'hidden' },
        ],
        embeds: [{ url: 'https://x.test/a', provider: 'generic', previewId: 'p', html: '<iframe>' }],
      },
    })

    expect(res.status).toBe(204)
    expect(log).toEqual(['rpc:bot_interaction_ack'])
    expect(argsOf('bot_interaction_ack')).toEqual([{
      p_bot_id: BOT_ID, p_id: INTERACTION, p_defer: false, p_ephemeral: true,
      p_reply: [
        { type: 'text', text: 'Only you: ' },
        { type: 'file', url: 'https://cdn.test/a.png' },
        { type: 'text', text: '#hidden' },
        { type: 'embed', url: 'https://x.test/a', provider: 'generic', previewId: 'p' },
      ],
    }])
    expect(db.writesTo('messages')).toEqual([])
  })

  it('defers, public or private, without writing a message', async () => {
    seed()
    rpcAnswers.bot_interaction_ack = () => ({ data: { ...ackRow(), status: 'deferred' }, error: null })
    expect((await callback({ type: 5 })).status).toBe(204)
    expect((await callback({ type: 5, data: { flags: 64 } })).status).toBe(204)

    expect(argsOf('bot_interaction_ack')).toEqual([
      { p_bot_id: BOT_ID, p_id: INTERACTION, p_defer: true, p_ephemeral: false, p_reply: null },
      { p_bot_id: BOT_ID, p_id: INTERACTION, p_defer: true, p_ephemeral: true, p_reply: null },
    ])
    expect(db.writesTo('messages')).toEqual([])
  })

  it('refuses other callback types, flags and empty replies before acknowledging', async () => {
    seed()
    const cases: Array<[unknown, number, string]> = [
      [{ type: 1 }, 400, 'type must be 4 (reply) or 5 (defer)'],
      [{ type: 7, data: { content: 'x' } }, 400, 'type must be 4 (reply) or 5 (defer)'],
      [{ type: 4, data: { content: 'x', flags: 4 } }, 400, 'flags must be 0 or 64'],
      [{ type: 5, data: { flags: 64 | 4096 } }, 400, 'flags must be 0 or 64'],
      [{ type: 4, data: 'x' }, 400, 'data must be an object'],
      [{ type: 4, data: { content: '' } }, 400, 'Cannot send an empty message'],
      [{ type: 4 }, 400, 'Cannot send an empty message'],
    ]
    for (const [body, status, error] of cases) {
      const res = await callback(body)
      expect([res.status, res.body.error]).toEqual([status, error])
    }
    expect((await callback({ type: 4, data: { content: 'x' } }, 'not-an-id')).status).toBe(404)
    expect(rpcCalls).toEqual([])
  })

  it('answers 404 for a private reply to another bot\'s interaction without acknowledging', async () => {
    seed()
    const res = await callback({ type: 4, data: { content: 'x', flags: 64 } }, FOREIGN)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Unknown interaction' })
    expect(rpcCalls).toEqual([])
  })

  it('maps the ack\'s refusals', async () => {
    seed()
    const cases: Array<[string, number, string]> = [
      ['INTERACTION_UNKNOWN', 404, 'Unknown interaction'],
      ['INTERACTION_ACKNOWLEDGED', 400, 'Interaction already acknowledged'],
      ['INTERACTION_EXPIRED', 400, 'Interaction expired'],
      ['INTERACTION_REPLY_TOO_LONG:2000', 400, 'Message text exceeds the instance limit of 2000 characters'],
    ]
    for (const [code, status, error] of cases) {
      rpcAnswers.bot_interaction_ack = raise(code)
      const res = await callback({ type: 4, data: { content: 'x' } })
      expect([res.status, res.body]).toEqual([status, { error }])
    }
    expect(db.writesTo('messages')).toEqual([])
    expect(argsOf('bot_interaction_record')).toEqual([])
  })
})

describe('PATCH /interactions/:id/response', () => {
  it('replaces a private reply and answers it without writing a message', async () => {
    seed()
    db.rows('bot_interactions')[0].ephemeral = true
    rpcAnswers.bot_interaction_reply = (args) => ({
      data: { action: 'stored', reply: { id: REPLY_ID, content: args.p_reply, created_at: 't0', edited_at: 't1' } },
      error: null,
    })
    const res = await respond({ content: 'Updated forecast' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      id: REPLY_ID, ephemeral: true, content: 'Updated forecast', content_raw: [{ type: 'text', text: 'Updated forecast' }],
    })
    expect(argsOf('bot_interaction_reply')).toEqual([{
      p_bot_id: BOT_ID, p_id: INTERACTION, p_kind: 'original', p_ephemeral: true,
      p_reply: [{ type: 'text', text: 'Updated forecast' }],
    }])
    expect(db.writesTo('messages')).toEqual([])
  })

  it('posts the public reply after a defer and records it', async () => {
    seed()
    rpcAnswers.bot_interaction_reply = () => ({ data: { action: 'create_message' }, error: null })
    const res = await respond({ content: 'Done' })

    expect(res.status).toBe(200)
    expect(log).toEqual(['rpc:bot_interaction_reply', 'insert:messages', 'rpc:bot_interaction_record'])
    const [message] = insertedMessages()
    expect(res.body).toMatchObject({ id: message.id, channel_id: CHANNEL, content: 'Done' })
    expect(res.body.metadata.interaction).toEqual({ id: INTERACTION, name: 'weather', user_id: ALICE })
    expect(argsOf('bot_interaction_record')).toEqual([
      { p_bot_id: BOT_ID, p_id: INTERACTION, p_message_id: message.id, p_error: null },
    ])
  })

  it('edits the public reply in place', async () => {
    seed()
    const MESSAGE = '00000000-0000-0000-0000-0000000000d1'
    db.rows('messages').push({
      id: MESSAGE, channel_id: CHANNEL, bot_id: BOT_ID, user_id: null,
      content: [{ type: 'text', text: 'old' }],
      metadata: { bot: true, created_via: 'bot_api', interaction: { id: INTERACTION, name: 'weather', user_id: ALICE } },
    })
    rpcAnswers.bot_interaction_reply = () => ({ data: { action: 'edit_message', message_id: MESSAGE }, error: null })
    const res = await respond({ content: 'new' })

    expect(res.status).toBe(200)
    expect(log).toEqual(['rpc:bot_interaction_reply', 'update:messages'])
    expect(db.rows('messages')[0]).toMatchObject({
      content: [{ type: 'text', text: 'new' }],
      metadata: { interaction: { id: INTERACTION, name: 'weather', user_id: ALICE } },
    })
    expect(res.body.content).toBe('new')
  })

  it('maps the reply\'s refusals', async () => {
    seed()
    const cases: Array<[string, number, string]> = [
      ['INTERACTION_NOT_ACKNOWLEDGED', 400, 'Interaction not acknowledged'],
      ['INTERACTION_RESPONSE_IN_PROGRESS', 409, 'Response in progress'],
      ['INTERACTION_EXPIRED', 400, 'Interaction expired'],
      ['INTERACTION_UNKNOWN', 404, 'Unknown interaction'],
      ['INTERACTION_REPLY_TOO_LONG:4000', 400, 'Message text exceeds the instance limit of 4000 characters'],
    ]
    for (const [code, status, error] of cases) {
      rpcAnswers.bot_interaction_reply = raise(code)
      const res = await respond({ content: 'x' })
      expect([res.status, res.body]).toEqual([status, { error }])
    }
    expect(db.writesTo('messages')).toEqual([])
  })

  it('answers 404 for another bot\'s interaction and refuses an empty body', async () => {
    seed()
    expect((await respond({ content: 'x' }, FOREIGN)).body).toEqual({ error: 'Unknown interaction' })
    expect((await respond({ content: 'x' }, 'nope')).status).toBe(404)
    expect((await respond({})).status).toBe(400)
    expect(rpcCalls).toEqual([])
  })
})

describe('POST /interactions/:id/followups', () => {
  it('posts a public follow-up marked followup, and records nothing', async () => {
    seed()
    rpcAnswers.bot_interaction_reply = () => ({ data: { action: 'create_message' }, error: null })
    const res = await followup({ content: 'Tomorrow: rain' })

    expect(res.status).toBe(200)
    expect(log).toEqual(['rpc:bot_interaction_reply', 'insert:messages'])
    expect(argsOf('bot_interaction_reply')).toEqual([{
      p_bot_id: BOT_ID, p_id: INTERACTION, p_kind: 'followup', p_ephemeral: false,
      p_reply: [{ type: 'text', text: 'Tomorrow: rain' }],
    }])
    expect(insertedMessages()[0].metadata.interaction).toEqual({ id: INTERACTION, name: 'weather', user_id: ALICE, followup: true })
    expect(res.body.metadata.interaction.followup).toBe(true)
  })

  it('stores a private follow-up', async () => {
    seed()
    rpcAnswers.bot_interaction_reply = (args) => ({
      data: { action: 'stored', reply: { id: REPLY_ID, content: args.p_reply, created_at: 't', edited_at: null } },
      error: null,
    })
    const res = await followup({ content: 'psst', flags: 64 })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: REPLY_ID, ephemeral: true, content: 'psst', content_raw: [{ type: 'text', text: 'psst' }] })
    expect(argsOf('bot_interaction_reply')[0]).toMatchObject({ p_kind: 'followup', p_ephemeral: true })
    expect(db.writesTo('messages')).toEqual([])
  })

  it('answers AutoMod on a follow-up without recording it', async () => {
    seed()
    db.failures.messages = { message: 'AUTOMOD_BLOCKED:keyword' }
    rpcAnswers.bot_interaction_reply = () => ({ data: { action: 'create_message' }, error: null })
    const res = await followup({ content: 'blocked' })

    expect(res.status).toBe(403)
    expect(res.body.code).toBe('AUTOMOD_BLOCKED')
    expect(argsOf('bot_interaction_record')).toEqual([])
  })

  it('maps the follow-up limit and refuses bad flags', async () => {
    seed()
    rpcAnswers.bot_interaction_reply = raise('INTERACTION_FOLLOWUP_LIMIT')
    expect((await followup({ content: 'x' })).body).toEqual({ error: 'Follow-up limit reached' })
    expect((await followup({ content: 'x', flags: 2 })).body).toEqual({ error: 'flags must be 0 or 64' })
    expect(argsOf('bot_interaction_reply')).toHaveLength(1)
  })
})

describe('metadata.interaction is the gateway\'s', () => {
  it('drops a bot-supplied interaction from a message it sends', async () => {
    seed()
    const res = await supertest(app())
      .post(`/api/v1/channels/${CHANNEL}/messages`)
      .send({ content: 'forged', metadata: { interaction: { id: INTERACTION, name: 'ban', user_id: ALICE }, custom: 1 } })

    expect(res.status).toBe(201)
    expect(insertedMessages()[0].metadata).toEqual({ custom: 1, bot: true, created_via: 'bot_api' })
  })

  it('drops it from a metadata merge and keeps the stored one', async () => {
    seed()
    const MESSAGE = '00000000-0000-0000-0000-0000000000d2'
    const stored = { id: INTERACTION, name: 'weather', user_id: ALICE }
    db.rows('messages').push({ id: MESSAGE, channel_id: CHANNEL, bot_id: BOT_ID, metadata: { bot: true, interaction: stored } })
    const res = await supertest(app())
      .patch(`/api/v1/messages/${MESSAGE}/metadata`)
      .send({ metadata: { interaction: { id: FOREIGN, name: 'ban', user_id: ALICE }, note: 'x' } })

    expect(res.status).toBe(200)
    expect(db.rows('messages')[0].metadata).toEqual({ bot: true, interaction: stored, note: 'x' })
  })

  it('is a reserved key of botSuppliedMetadata', () => {
    expect(botSuppliedMetadata({ interaction: { id: 'x' }, keep: true })).toEqual({ keep: true })
  })
})

describe('helpers', () => {
  it('reads flags 0, absent and 64 only', () => {
    expect([undefined, null, 0, 64, 4, '64', 65].map(replyFlags)).toEqual([0, 0, 0, 64, null, null, null])
  })

  it('answers 500 for an RPC error the contract does not name', () => {
    expect(interactionErrorResponse({ message: 'function public.bot_interaction_ack does not exist' }))
      .toEqual({ status: 500, body: { error: 'function public.bot_interaction_ack does not exist' } })
  })
})
