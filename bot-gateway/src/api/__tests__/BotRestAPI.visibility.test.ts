import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb, type Row } from '../../__tests__/fakeSupabase.js'

// What a bot reads of channels it may not see, and of history before its install.
//   general  @everyone views it
//   staff    @everyone denied VIEW_CHANNEL
//   quiet    @everyone views it, denied READ_MESSAGE_HISTORY

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const OWNER_ID = '00000000-0000-0000-0000-0000000000a1'
const GENERAL = '00000000-0000-0000-0000-0000000000c1'
const STAFF = '00000000-0000-0000-0000-0000000000c2'
const QUIET = '00000000-0000-0000-0000-0000000000c3'
const EVERYONE_ROLE = '00000000-0000-0000-0000-0000000000e0'
const OLD_QUIET = '00000000-0000-0000-0000-0000000000d1'
const NEW_QUIET = '00000000-0000-0000-0000-0000000000d2'
const OLD_GENERAL = '00000000-0000-0000-0000-0000000000d3'
const TEXT_CATEGORY = '00000000-0000-0000-0000-0000000000f1'
const STAFF_CATEGORY = '00000000-0000-0000-0000-0000000000f2'
const EMPTY_CATEGORY = '00000000-0000-0000-0000-0000000000f3'

const bit = (n: number) => 1n << BigInt(n)
const VIEW_CHANNEL = bit(1)
const READ_MESSAGE_HISTORY = bit(22)
// create_default_server_role()
const EVERYONE_DEFAULT = 122646786n
const INSTALLED_AT = '2026-10-01T00:00:00.000Z'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: {},
}))

vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => {
    req.bot = { id: BOT_ID, username: 'reader', scopes: ['bot'] }
    next()
  },
  botRateLimit: (_req: any, _res: any, next: any) => next(),
}))

import { BotRestAPI } from '../BotRestAPI.js'

let db: FakeDb

function seed(install: Row = {}) {
  db = new FakeDb({
    servers: [{ id: SERVER_ID, owner: OWNER_ID }],
    server_roles: [
      { id: EVERYONE_ROLE, server_id: SERVER_ID, name: 'everyone', position: 0, permissions: Number(EVERYONE_DEFAULT), is_default: true, is_admin: false },
    ],
    channels: [
      { id: GENERAL, server_id: SERVER_ID, name: 'general', type: 0, order: 0, category: TEXT_CATEGORY },
      { id: STAFF, server_id: SERVER_ID, name: 'staff-only-plans', type: 0, order: 1, category: STAFF_CATEGORY },
      { id: QUIET, server_id: SERVER_ID, name: 'quiet', type: 0, order: 2, category: TEXT_CATEGORY },
    ],
    channel_categories: [
      { id: TEXT_CATEGORY, server_id: SERVER_ID, name: 'Text', order: 0 },
      { id: STAFF_CATEGORY, server_id: SERVER_ID, name: 'Staff', order: 1 },
      { id: EMPTY_CATEGORY, server_id: SERVER_ID, name: 'Empty', order: 2 },
    ],
    channel_permission_overrides: [
      { id: 'o1', channel_id: STAFF, target_type: 'role', role_id: EVERYONE_ROLE, user_id: null, allow_permissions: 0, deny_permissions: Number(VIEW_CHANNEL) },
      { id: 'o2', channel_id: QUIET, target_type: 'role', role_id: EVERYONE_ROLE, user_id: null, allow_permissions: 0, deny_permissions: Number(READ_MESSAGE_HISTORY) },
    ],
    messages: [
      { id: OLD_QUIET, channel_id: QUIET, user_id: OWNER_ID, content: [{ type: 'text', text: 'before install' }], metadata: { discord_message_id: '1' }, is_deleted: false, created_at: '2026-09-01T00:00:00.000Z' },
      { id: NEW_QUIET, channel_id: QUIET, user_id: OWNER_ID, content: [{ type: 'text', text: 'after install' }], metadata: { discord_message_id: '2' }, is_deleted: false, created_at: '2026-10-02T00:00:00.000Z' },
      { id: OLD_GENERAL, channel_id: GENERAL, user_id: OWNER_ID, content: [{ type: 'text', text: 'general history' }], metadata: { discord_message_id: '3' }, is_deleted: false, created_at: '2026-09-01T00:00:00.000Z' },
    ],
    bot_server_permissions: [{
      id: 'install', bot_id: BOT_ID, server_id: SERVER_ID, installed_by: OWNER_ID, installed_at: INSTALLED_AT,
      is_active: true, read_messages: true, send_messages: true, ...install,
    }],
  })
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
  mocks.rpc.mockImplementation(async (name: string, args: any) => {
    if (name === 'check_bot_permission') {
      const row = db.rows('bot_server_permissions').find((r) => r.bot_id === args.p_bot_id && r.server_id === args.p_server_id && r.is_active)
      return { data: row?.[args.p_permission] === true, error: null }
    }
    return { data: null, error: null }
  })
  seed()
})

describe('GET /servers/:id/channels', () => {
  it('lists only the channels the bot sees', async () => {
    const res = await supertest(app()).get(`/api/v1/servers/${SERVER_ID}/channels`)
    expect(res.status).toBe(200)
    expect(res.body.map((c: { id: string }) => c.id)).toEqual([GENERAL, QUIET])
    expect(JSON.stringify(res.body)).not.toContain('staff-only-plans')
  })

  it('lists a hidden channel named in allowed_channel_ids', async () => {
    seed({ allowed_channel_ids: [STAFF] })
    const res = await supertest(app()).get(`/api/v1/guilds/${SERVER_ID}/channels`)
    expect(res.body.map((c: { id: string }) => c.id)).toEqual([STAFF])
  })
})

describe('GET /servers/:id/categories', () => {
  it('lists only categories holding a channel the bot sees', async () => {
    const res = await supertest(app()).get(`/api/v1/servers/${SERVER_ID}/categories`)
    expect(res.status).toBe(200)
    expect(res.body.map((k: { id: string }) => k.id)).toEqual([TEXT_CATEGORY])
    expect(JSON.stringify(res.body)).not.toContain('Staff')
  })

  it('lists every category to a bot that manages channels', async () => {
    seed({ manage_channels: true })
    const res = await supertest(app()).get(`/api/v1/servers/${SERVER_ID}/categories`)
    expect(res.body.map((k: { id: string }) => k.id)).toEqual([TEXT_CATEGORY, STAFF_CATEGORY, EMPTY_CATEGORY])
  })
})

describe('history without READ_MESSAGE_HISTORY', () => {
  it('serves messages from the install on', async () => {
    const res = await supertest(app()).get(`/api/v1/channels/${QUIET}/messages`)
    expect(res.status).toBe(200)
    expect(res.body.map((m: { id: string }) => m.id)).toEqual([NEW_QUIET])
  })

  it('does not serve an earlier message by id or by Discord id', async () => {
    expect((await supertest(app()).get(`/api/v1/messages/${OLD_QUIET}`)).status).toBe(404)
    const lookup = await supertest(app())
      .get(`/api/v1/channels/${QUIET}/messages/lookup`).query({ discord_message_id: '1' })
    expect(lookup.status).toBe(404)
    expect((await supertest(app()).get(`/api/v1/messages/${NEW_QUIET}`)).status).toBe(200)
  })

  it('serves the whole history where the bit holds', async () => {
    const res = await supertest(app()).get(`/api/v1/channels/${GENERAL}/messages`)
    expect(res.body.map((m: { id: string }) => m.id)).toEqual([OLD_GENERAL])
  })

  it('serves the whole history of a channel named in allowed_channel_ids', async () => {
    seed({ allowed_channel_ids: [QUIET] })
    const res = await supertest(app()).get(`/api/v1/channels/${QUIET}/messages`)
    expect(res.body.map((m: { id: string }) => m.id).sort()).toEqual([OLD_QUIET, NEW_QUIET].sort())
  })
})
