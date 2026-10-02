import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb, type Row } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const OWNER_ID = '00000000-0000-0000-0000-0000000000a1'
const MOD_USER_ID = '00000000-0000-0000-0000-0000000000a2'
const MEMBER_USER_ID = '00000000-0000-0000-0000-0000000000a3'
const PUBLIC_CHANNEL = '00000000-0000-0000-0000-0000000000c1'
const HIDDEN_CHANNEL = '00000000-0000-0000-0000-0000000000c2'
const EVERYONE_ROLE = '00000000-0000-0000-0000-0000000000e0'
const MEMBER_ROLE = '00000000-0000-0000-0000-0000000000e1'
const MOD_ROLE = '00000000-0000-0000-0000-0000000000e5'
const ADMIN_ROLE = '00000000-0000-0000-0000-0000000000e9'
const PUBLIC_MESSAGE = '00000000-0000-0000-0000-0000000000d1'
const HIDDEN_MESSAGE = '00000000-0000-0000-0000-0000000000d2'

const bit = (n: number) => 1n << BigInt(n)
const VIEW_CHANNEL = bit(1)
const MANAGE_ROLES = bit(3)
const CREATE_INVITE = bit(8)
const KICK_MEMBERS = bit(9)
const BAN_MEMBERS = bit(10)
const SEND_MESSAGES = bit(12)
const MANAGE_MESSAGES = bit(21)
// create_default_server_role()
const EVERYONE_DEFAULT = 122646786n
const ADMIN_ALL = 2199023255551n

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: {},
}))

vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => {
    req.bot = { id: BOT_ID, username: 'bridge', scopes: ['bot'] }
    next()
  },
  botRateLimit: (_req: any, _res: any, next: any) => next(),
}))

import { BotRestAPI } from '../BotRestAPI.js'

let db: FakeDb

/** The audited install: a bridge with the UI defaults, manage_channels on. */
function install(overrides: Row = {}): Row {
  return {
    id: '00000000-0000-0000-0000-0000000000f1',
    bot_id: BOT_ID,
    server_id: SERVER_ID,
    installed_by: OWNER_ID,
    is_active: true,
    read_messages: true,
    send_messages: true,
    add_reactions: true,
    manage_messages: false,
    manage_channels: true,
    ...overrides,
  }
}

function seed(installRow: Row = install(), extra: Record<string, Row[]> = {}) {
  db = new FakeDb({
    servers: [{ id: SERVER_ID, owner: OWNER_ID }],
    server_roles: [
      { id: EVERYONE_ROLE, server_id: SERVER_ID, name: 'everyone', position: 0, permissions: Number(EVERYONE_DEFAULT), is_default: true, is_admin: false },
      { id: MEMBER_ROLE, server_id: SERVER_ID, name: 'Member', position: 1, permissions: Number(SEND_MESSAGES), is_default: false, is_admin: false },
      { id: MOD_ROLE, server_id: SERVER_ID, name: 'Moderator', position: 5, permissions: Number(KICK_MEMBERS | MANAGE_MESSAGES), is_default: false, is_admin: false },
      { id: ADMIN_ROLE, server_id: SERVER_ID, name: 'Admin', position: 999, permissions: Number(ADMIN_ALL), is_default: false, is_admin: true },
    ],
    user_roles: [
      { user_id: OWNER_ID, role_id: ADMIN_ROLE, server_id: SERVER_ID },
      { user_id: MOD_USER_ID, role_id: MOD_ROLE, server_id: SERVER_ID },
      { user_id: MEMBER_USER_ID, role_id: MEMBER_ROLE, server_id: SERVER_ID },
    ],
    channels: [
      { id: PUBLIC_CHANNEL, server_id: SERVER_ID, name: 'general' },
      { id: HIDDEN_CHANNEL, server_id: SERVER_ID, name: 'mods-only' },
    ],
    channel_permission_overrides: [
      { id: '00000000-0000-0000-0000-0000000000a9', channel_id: HIDDEN_CHANNEL, target_type: 'role', role_id: EVERYONE_ROLE, user_id: null, allow_permissions: 0, deny_permissions: Number(VIEW_CHANNEL) },
    ],
    messages: [
      { id: PUBLIC_MESSAGE, channel_id: PUBLIC_CHANNEL, user_id: OWNER_ID, content: [{ type: 'text', text: 'hello' }], metadata: { discord_message_id: '1' }, is_deleted: false },
      { id: HIDDEN_MESSAGE, channel_id: HIDDEN_CHANNEL, user_id: OWNER_ID, content: [{ type: 'text', text: 'private mod note' }], metadata: { discord_message_id: '2' }, is_deleted: false },
    ],
    bot_server_permissions: [installRow],
    bot_audit_log: [],
    ...extra,
  })
  mocks.from.mockImplementation((table: string) => db.from(table))
}

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/v1', new BotRestAPI().router)
  return a
}

function role(id: string): Row | undefined {
  return db.rows('server_roles').find((r) => r.id === id)
}

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.from.mockReset()
  // check_bot_permission() as in the baseline: the install's flag column, active installs only.
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    if (fn !== 'check_bot_permission') throw new Error(`test called unmocked rpc: ${fn}`)
    const row = db.rows('bot_server_permissions').find(
      (r) => r.bot_id === args.p_bot_id && r.server_id === args.p_server_id && r.is_active === true,
    )
    return { data: row?.[args.p_permission] === true, error: null }
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('role management requires manage_roles', () => {
  it('refuses role create, edit and delete to a bot holding manage_channels alone', async () => {
    seed()
    const create = await supertest(app())
      .post(`/api/v1/servers/${SERVER_ID}/roles`)
      .send({ name: 'Escalated', position: 1, permissions: String(KICK_MEMBERS) })
    const edit = await supertest(app())
      .patch(`/api/v1/servers/${SERVER_ID}/roles/${MEMBER_ROLE}`)
      .send({ name: 'Renamed' })
    const del = await supertest(app()).delete(`/api/v1/servers/${SERVER_ID}/roles/${MEMBER_ROLE}`)

    for (const res of [create, edit, del]) {
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('Missing permission: manage_roles')
    }
    expect(db.writesTo('server_roles')).toEqual([])
  })

  it('refuses a bot not installed in the server', async () => {
    seed(install({ is_active: false, manage_roles: true }))
    const res = await supertest(app())
      .post(`/api/v1/servers/${SERVER_ID}/roles`)
      .send({ name: 'Role' })

    expect(res.status).toBe(403)
  })
})

describe('role permission masks', () => {
  it('refuses a role carrying a permission the bot does not hold', async () => {
    seed(install({ manage_roles: true }))
    const res = await supertest(app())
      .post(`/api/v1/servers/${SERVER_ID}/roles`)
      .send({ name: 'Bouncer', position: 2, permissions: String(KICK_MEMBERS | SEND_MESSAGES) })

    expect(res.status).toBe(403)
    expect(res.body.missing_permissions).toBe(KICK_MEMBERS.toString())
    expect(db.writesTo('server_roles')).toEqual([])
  })

  it('creates a lower role from the install\'s and @everyone\'s bits, ADMINISTRATOR cleared', async () => {
    seed(install({ manage_roles: true }))
    const requested = VIEW_CHANNEL | SEND_MESSAGES | CREATE_INVITE | MANAGE_ROLES | 1n
    const res = await supertest(app())
      .post(`/api/v1/servers/${SERVER_ID}/roles`)
      .send({ name: 'Bridged', position: 2, permissions: requested.toString() })

    expect(res.status).toBe(201)
    expect(res.body.permissions).toBe((requested & ~1n).toString())
    expect(res.body.position).toBe(2)
  })

  it('keeps bits a role already holds on edit and refuses newly added ones', async () => {
    seed(install({ manage_roles: true }))
    const keep = await supertest(app())
      .patch(`/api/v1/servers/${SERVER_ID}/roles/${MOD_ROLE}`)
      .send({ permissions: String(KICK_MEMBERS | SEND_MESSAGES) })
    expect(keep.status).toBe(200)
    expect(role(MOD_ROLE)!.permissions).toBe(String(KICK_MEMBERS | SEND_MESSAGES))

    const add = await supertest(app())
      .patch(`/api/v1/servers/${SERVER_ID}/roles/${MOD_ROLE}`)
      .send({ permissions: String(KICK_MEMBERS | BAN_MEMBERS) })
    expect(add.status).toBe(403)
    expect(add.body.missing_permissions).toBe(BAN_MEMBERS.toString())
    expect(role(MOD_ROLE)!.permissions).toBe(String(KICK_MEMBERS | SEND_MESSAGES))
  })

  it('refuses to touch a role holding ADMINISTRATOR without the is_admin flag', async () => {
    seed(install({ manage_roles: true }))
    db.rows('server_roles').push({
      id: '00000000-0000-0000-0000-0000000000e3', server_id: SERVER_ID, name: 'Root', position: 3, permissions: 1, is_default: false, is_admin: false,
    })
    const edit = await supertest(app())
      .patch(`/api/v1/servers/${SERVER_ID}/roles/00000000-0000-0000-0000-0000000000e3`)
      .send({ permissions: '0' })
    const del = await supertest(app()).delete(`/api/v1/servers/${SERVER_ID}/roles/00000000-0000-0000-0000-0000000000e3`)

    expect(edit.status).toBe(403)
    expect(del.status).toBe(403)
  })
})

describe('role positions', () => {
  it('refuses a role at or above the lowest admin role', async () => {
    seed(install({ manage_roles: true }))
    const res = await supertest(app())
      .post(`/api/v1/servers/${SERVER_ID}/roles`)
      .send({ name: 'Above admin', position: 1000, permissions: '0' })

    expect(res.status).toBe(403)
    expect(res.body.max_position).toBe(998)
  })

  it('caps positions below a non-owner installer\'s highest role', async () => {
    seed(install({ manage_roles: true, installed_by: MOD_USER_ID }))
    const atCap = await supertest(app())
      .post(`/api/v1/servers/${SERVER_ID}/roles`)
      .send({ name: 'Peer', position: 5 })
    const below = await supertest(app())
      .post(`/api/v1/servers/${SERVER_ID}/roles`)
      .send({ name: 'Junior', position: 4 })

    expect(atCap.status).toBe(403)
    expect(below.status).toBe(201)
  })

  it('refuses to edit, move or delete a role at or above the cap', async () => {
    seed(install({ manage_roles: true, installed_by: MEMBER_USER_ID }))
    const edit = await supertest(app())
      .patch(`/api/v1/servers/${SERVER_ID}/roles/${MOD_ROLE}`)
      .send({ permissions: '0' })
    const del = await supertest(app()).delete(`/api/v1/servers/${SERVER_ID}/roles/${MOD_ROLE}`)

    expect(edit.status).toBe(403)
    expect(del.status).toBe(403)
    expect(role(MOD_ROLE)).toBeDefined()
  })

  it('refuses moving a manageable role into the admin range', async () => {
    seed(install({ manage_roles: true }))
    const res = await supertest(app())
      .patch(`/api/v1/servers/${SERVER_ID}/roles/${MEMBER_ROLE}`)
      .send({ position: 999 })

    expect(res.status).toBe(403)
    expect(role(MEMBER_ROLE)!.position).toBe(1)
  })

  it('edits and deletes a lower role for a bot with manage_roles', async () => {
    seed(install({ manage_roles: true }))
    const edit = await supertest(app())
      .patch(`/api/v1/servers/${SERVER_ID}/roles/${MOD_ROLE}`)
      .send({ name: 'Mods', position: 6 })
    expect(edit.status).toBe(200)
    expect(role(MOD_ROLE)).toMatchObject({ name: 'Mods', position: 6 })

    const del = await supertest(app()).delete(`/api/v1/servers/${SERVER_ID}/roles/${MOD_ROLE}`)
    expect(del.status).toBe(204)
    expect(role(MOD_ROLE)).toBeUndefined()
  })

  it('still refuses the default and admin roles', async () => {
    seed(install({ manage_roles: true }))
    const everyone = await supertest(app())
      .patch(`/api/v1/servers/${SERVER_ID}/roles/${EVERYONE_ROLE}`)
      .send({ permissions: '0' })
    const admin = await supertest(app()).delete(`/api/v1/servers/${SERVER_ID}/roles/${ADMIN_ROLE}`)

    expect(everyone.status).toBe(403)
    expect(admin.status).toBe(403)
  })
})

describe('channel permission overrides', () => {
  const put = (channelId: string, body: Row) =>
    supertest(app()).put(`/api/v1/channels/${channelId}/permission-overrides`).send(body)

  it('refuses a user override allowing a permission the bot does not hold', async () => {
    seed()
    const res = await put(PUBLIC_CHANNEL, {
      target_type: 'user',
      user_id: MEMBER_USER_ID,
      allow_permissions: String(MANAGE_MESSAGES),
    })

    expect(res.status).toBe(403)
    expect(res.body.missing_permissions).toBe(MANAGE_MESSAGES.toString())
    expect(db.writesTo('channel_permission_overrides')).toEqual([])
  })

  it('refuses lifting @everyone\'s VIEW_CHANNEL deny on a hidden channel, by any route', async () => {
    seed()
    const cleared = await put(HIDDEN_CHANNEL, { target_type: 'role', role_id: EVERYONE_ROLE, allow_permissions: '0', deny_permissions: '0' })
    const allowed = await put(HIDDEN_CHANNEL, { target_type: 'role', role_id: MEMBER_ROLE, allow_permissions: String(VIEW_CHANNEL) })
    const deleted = await supertest(app()).delete(
      `/api/v1/channels/${HIDDEN_CHANNEL}/permission-overrides/role/${EVERYONE_ROLE}`,
    )

    for (const res of [cleared, allowed, deleted]) expect(res.status).toBe(403)
    expect(db.rows('channel_permission_overrides')).toHaveLength(1)
  })

  it('writes overrides inside the bot\'s permissions in the channel', async () => {
    seed()
    const deny = await put(PUBLIC_CHANNEL, { target_type: 'role', role_id: MEMBER_ROLE, deny_permissions: String(SEND_MESSAGES) })
    expect(deny.status).toBe(201)

    const allow = await put(PUBLIC_CHANNEL, { target_type: 'role', role_id: MEMBER_ROLE, allow_permissions: String(SEND_MESSAGES) })
    expect(allow.status).toBe(200)
    expect(allow.body).toMatchObject({ allow_permissions: String(SEND_MESSAGES), deny_permissions: '0' })
  })

  it('grants nothing in a channel outside allowed_channel_ids', async () => {
    seed(install({ allowed_channel_ids: [HIDDEN_CHANNEL] }))
    const res = await put(PUBLIC_CHANNEL, { target_type: 'role', role_id: MEMBER_ROLE, allow_permissions: String(SEND_MESSAGES) })

    expect(res.status).toBe(403)
  })
})

describe('reading messages follows channel visibility', () => {
  it('refuses channel history for a channel hidden from @everyone', async () => {
    seed()
    const hidden = await supertest(app()).get(`/api/v1/channels/${HIDDEN_CHANNEL}/messages`)
    const visible = await supertest(app()).get(`/api/v1/channels/${PUBLIC_CHANNEL}/messages`)

    expect(hidden.status).toBe(403)
    expect(JSON.stringify(hidden.body)).not.toContain('private mod note')
    expect(visible.status).toBe(200)
    expect(visible.body.map((m: Row) => m.id)).toEqual([PUBLIC_MESSAGE])
  })

  it('refuses a single message and a bridge lookup in a hidden channel', async () => {
    seed()
    const byId = await supertest(app()).get(`/api/v1/messages/${HIDDEN_MESSAGE}`)
    const lookup = await supertest(app()).get(
      `/api/v1/channels/${HIDDEN_CHANNEL}/messages/lookup?discord_message_id=2`,
    )

    expect(byId.status).toBe(403)
    expect(lookup.status).toBe(403)
    expect((await supertest(app()).get(`/api/v1/messages/${PUBLIC_MESSAGE}`)).status).toBe(200)
  })

  it('restricts reads to allowed_channel_ids', async () => {
    seed(install({ allowed_channel_ids: [] }))
    expect((await supertest(app()).get(`/api/v1/channels/${PUBLIC_CHANNEL}/messages`)).status).toBe(403)

    seed(install({ allowed_channel_ids: [PUBLIC_CHANNEL] }))
    expect((await supertest(app()).get(`/api/v1/channels/${PUBLIC_CHANNEL}/messages`)).status).toBe(200)
  })

  it('refuses reads when the visibility lookup fails', async () => {
    seed()
    db.failures.channel_permission_overrides = { message: 'connection reset' }
    const res = await supertest(app()).get(`/api/v1/channels/${PUBLIC_CHANNEL}/messages`)

    expect(res.status).toBe(403)
  })
})
