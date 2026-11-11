/**
 * Command registration routes: GET, PUT and POST /commands, DELETE /commands/:id. The
 * get_bot_commands, bot_commands_replace and bot_command_upsert RPCs are mocked to the
 * contract's answers; their SQL is covered by pgTAP 257 and tests/db.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const OTHER_BOT = '00000000-0000-0000-0000-0000000000b9'
const COMMAND = '00000000-0000-0000-0000-0000000000c5'
const FOREIGN_COMMAND = '00000000-0000-0000-0000-0000000000c6'

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

import { BotRestAPI, commandErrorResponse } from '../BotRestAPI.js'

let db: FakeDb
let rpcCalls: Array<{ fn: string; args: any }>
let rpcAnswers: Record<string, (args: any) => { data: unknown; error: unknown }>

const stored = (name: string) => ({
  id: COMMAND, name, description: 'Weather', options: [], required_permissions: [],
  created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z',
})

const raise = (message: string) => () => ({ data: null, error: { code: 'P0001', message } })

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/v1', new BotRestAPI().router)
  return a
}

beforeEach(() => {
  db = new FakeDb({
    bot_commands: [
      { id: COMMAND, bot_id: BOT_ID, name: 'weather', command_type: 'slash' },
      { id: FOREIGN_COMMAND, bot_id: OTHER_BOT, name: 'weather', command_type: 'slash' },
    ],
    bot_audit_log: [],
  })
  rpcCalls = []
  rpcAnswers = {}
  mocks.rpc.mockReset()
  mocks.from.mockReset()
  mocks.from.mockImplementation((table: string) => db.from(table))
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    rpcCalls.push({ fn, args })
    const answer = rpcAnswers[fn]
    if (!answer) throw new Error(`test called unmocked rpc: ${fn}`)
    return answer(args)
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /commands', () => {
  it('lists the bot\'s commands', async () => {
    rpcAnswers.get_bot_commands = () => ({ data: [stored('weather')], error: null })
    const res = await supertest(app()).get('/api/v1/commands')

    expect(res.status).toBe(200)
    expect(res.body).toEqual([stored('weather')])
    expect(rpcCalls).toEqual([{ fn: 'get_bot_commands', args: { p_bot_id: BOT_ID } }])
  })
})

describe('PUT /commands', () => {
  it('replaces the set with the normalized definitions', async () => {
    rpcAnswers.bot_commands_replace = () => ({ data: [stored('weather')], error: null })
    const res = await supertest(app())
      .put('/api/v1/commands')
      .send([{
        name: 'weather', description: 'Weather', nsfw: false, required_permissions: ['SEND_MESSAGES'],
        options: [{ type: 3, name: 'city', description: 'City', required: true, name_localizations: {} }],
      }])

    expect(res.status).toBe(200)
    expect(res.body).toEqual([stored('weather')])
    expect(rpcCalls).toEqual([{
      fn: 'bot_commands_replace',
      args: {
        p_bot_id: BOT_ID,
        p_commands: [{
          name: 'weather', description: 'Weather', required_permissions: ['SEND_MESSAGES'],
          options: [{ type: 3, name: 'city', description: 'City', required: true }],
        }],
      },
    }])
    expect(db.rows('bot_audit_log')).toMatchObject([{ bot_id: BOT_ID, action_type: 'commands_replaced', metadata: { count: 1 } }])
  })

  it('takes an empty array, which deletes every command', async () => {
    rpcAnswers.bot_commands_replace = () => ({ data: [], error: null })
    const res = await supertest(app()).put('/api/v1/commands').send([])

    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
    expect(rpcCalls[0].args.p_commands).toEqual([])
  })

  it('refuses an invalid set without calling the database', async () => {
    const cases: Array<[unknown, string]> = [
      [{ name: 'weather', description: 'x' }, 'Body must be an array of commands'],
      [[{ name: 'a', description: 'a' }, { name: 'a', description: 'b' }], 'Duplicate command name: a'],
      [[{ name: 'ban', description: 'Ban', default_member_permissions: '4' }],
        'default_member_permissions is not supported; use required_permissions with Harmony permission names'],
      [[{ name: 'ban', description: 'Ban', options: [{ type: 9, name: 'who', description: 'x' }] }],
        '[0].options[0].type: 9 (MENTIONABLE) is not supported'],
      [Array.from({ length: 101 }, (_, i) => ({ name: `c${i}`, description: 'x' })), 'At most 100 commands'],
    ]
    for (const [body, error] of cases) {
      const res = await supertest(app()).put('/api/v1/commands').send(body as object)
      expect([res.status, res.body]).toEqual([400, { error }])
    }
    expect(rpcCalls).toEqual([])
  })

  it('maps the RPC\'s refusals to sentences', async () => {
    const cases: Array<[string, string]> = [
      ['BOT_COMMAND_LIMIT', 'A bot has at most 100 commands'],
      ['BOT_COMMAND_DUPLICATE:weather', 'Duplicate command name: weather'],
      ['BOT_COMMAND_UNKNOWN_PERMISSION:USE_SOUNDBOARD', 'Unknown permission name: USE_SOUNDBOARD'],
      ['BOT_COMMAND_INVALID:options', 'The command was refused: options'],
    ]
    for (const [message, error] of cases) {
      rpcAnswers.bot_commands_replace = raise(message)
      const res = await supertest(app()).put('/api/v1/commands').send([{ name: 'weather', description: 'x' }])
      expect([res.status, res.body]).toEqual([400, { error }])
    }
    rpcAnswers.bot_commands_replace = () => ({ data: null, error: { code: '42703', message: 'column "x" does not exist' } })
    expect((await supertest(app()).put('/api/v1/commands').send([])).status).toBe(500)
  })
})

describe('POST /commands', () => {
  it('answers 201 for a new command and 200 for a replaced one', async () => {
    rpcAnswers.bot_command_upsert = () => ({ data: { created: true, command: stored('weather') }, error: null })
    const created = await supertest(app()).post('/api/v1/commands').send({ name: 'weather', description: 'Weather', x: 1 })
    expect(created.status).toBe(201)
    expect(created.body).toEqual(stored('weather'))
    expect(rpcCalls[0]).toEqual({
      fn: 'bot_command_upsert',
      args: { p_bot_id: BOT_ID, p_command: { name: 'weather', description: 'Weather', options: [], required_permissions: [] } },
    })

    rpcAnswers.bot_command_upsert = () => ({ data: { created: false, command: stored('weather') }, error: null })
    const replaced = await supertest(app()).post('/api/v1/commands').send({ name: 'weather', description: 'Weather' })
    expect(replaced.status).toBe(200)
    expect(replaced.body).toEqual(stored('weather'))
  })

  it('refuses an invalid command and maps the 101st', async () => {
    const res = await supertest(app()).post('/api/v1/commands').send({ name: 'Weather', description: 'x' })
    expect([res.status, res.body]).toEqual([400, { error: 'name: must be lowercase' }])
    expect(rpcCalls).toEqual([])

    rpcAnswers.bot_command_upsert = raise('BOT_COMMAND_LIMIT')
    const full = await supertest(app()).post('/api/v1/commands').send({ name: 'weather', description: 'x' })
    expect([full.status, full.body]).toEqual([400, { error: 'A bot has at most 100 commands' }])
  })
})

describe('DELETE /commands/:id', () => {
  it('deletes the bot\'s own command', async () => {
    const res = await supertest(app()).delete(`/api/v1/commands/${COMMAND}`)

    expect(res.status).toBe(204)
    expect(db.rows('bot_commands').map((c) => c.id)).toEqual([FOREIGN_COMMAND])
  })

  it('answers 404 Unknown command for another bot\'s command, an unknown id and a malformed one', async () => {
    for (const id of [FOREIGN_COMMAND, '00000000-0000-0000-0000-0000000000ff', 'weather']) {
      const res = await supertest(app()).delete(`/api/v1/commands/${id}`)
      expect([res.status, res.body]).toEqual([404, { error: 'Unknown command' }])
    }
    expect(db.rows('bot_commands')).toHaveLength(2)
  })
})

describe('commandErrorResponse', () => {
  it('answers 500 for errors that are no BOT_COMMAND_ refusal, and 400 for the RPC\'s shape check', () => {
    expect(commandErrorResponse({ message: 'permission denied for function bot_commands_replace' }).status).toBe(500)
    expect(commandErrorResponse({ code: '22023', message: 'command name is 1-32 characters without whitespace' }))
      .toEqual({ status: 400, body: { error: 'command name is 1-32 characters without whitespace' } })
  })
})
