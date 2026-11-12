import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const BOT = '00000000-0000-0000-0000-0000000000b0'
const SERVER = '00000000-0000-0000-0000-00000000005a'
const CHANNEL = '00000000-0000-0000-0000-0000000000c1'
const USER = '00000000-0000-0000-0000-0000000000a1'
const MESSAGE = '00000000-0000-0000-0000-0000000000f1'
const author = { platform: 'matrix', id: '@sam:example.org', username: 'sam', display_name: 'Sam' }
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), upload: vi.fn(), getPublicUrl: vi.fn() }))
vi.mock('../../config/supabase.js', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc, storage: { from: () => ({ upload: mocks.upload, getPublicUrl: mocks.getPublicUrl }) } }, config: {},
}))
vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => { req.bot = { id: BOT, username: 'matrix-bridge', scopes: ['bot'] }; next() },
  botRateLimit: (_req: any, _res: any, next: any) => next(),
}))
import { BotRestAPI, botSuppliedMetadata } from '../BotRestAPI.js'

let db: FakeDb
let platform: string | null
let consent: unknown
let visible: string[]
let room: unknown
let members: unknown
const fetcher = vi.fn()
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
function app() { const a = express(); a.use(express.json({ limit: '2mb' })); a.use('/api/v1', new BotRestAPI().router); return a }
const base = `/api/v1/channels/${CHANNEL}`
beforeEach(() => {
  platform = 'matrix'; consent = true; visible = [MESSAGE]
  room = { room_id: '!opaqueRoom', sender_mode: 'ghost' }
  members = [{ id: USER, username: 'alice', display_name: 'Alice', avatar_url: 'alice/avatar.png', nickname: null, domain: 'profiles.example', is_local: true }]
  fetcher.mockReset(); vi.stubGlobal('fetch', fetcher)
  db = new FakeDb({
    bots: [{ id: BOT, bot_type: 'bridge', bridge_platform: 'matrix' }],
    servers: [{ id: SERVER, owner: USER }], channels: [{ id: CHANNEL, server_id: SERVER }],
    server_roles: [{ id: 'everyone', server_id: SERVER, is_default: true, position: 0, permissions: 122646786 }],
    bot_server_permissions: [{ bot_id: BOT, server_id: SERVER, is_active: true, read_messages: true, send_messages: true }],
    bridge_channels: [{ bot_id: BOT, channel_id: CHANNEL, platform: 'matrix' }],
    messages: [{ id: MESSAGE, channel_id: CHANNEL, user_id: USER, bot_id: null, content: [{ type: 'text', text: 'private' }], metadata: {}, created_at: '2026-11-01T00:00:00Z' }],
  })
  mocks.from.mockImplementation((table: string) => db.from(table))
  mocks.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'bridge_channel_platform') return { data: platform, error: null }
    if (fn === 'can_bridge_member_messages') return { data: consent, error: null }
    if (fn === 'bridge_visible_message_ids') return { data: visible, error: null }
    if (fn === 'matrix_bridge_bind_room' || fn === 'matrix_bridge_room') return { data: room, error: null }
    if (fn === 'matrix_bridge_channel_members') return { data: members, error: null }
    throw new Error('Unmocked RPC: ' + fn)
  })
  mocks.upload.mockResolvedValue({ error: null })
  mocks.getPublicUrl.mockImplementation((path: string) => ({ data: { publicUrl: 'https://harmony.example/storage/v1/object/public/avatars/' + path } }))
})

describe('generalized author authorization', () => {
  it('posts plain text with a native Matrix author, not a body prefix or bot identity', async () => {
    const r = await supertest(app()).post(base + '/messages').send({ content: 'Hello', metadata: { bridge_author: { ...author, access_token: 'discard' }, discord_user: { id: '1' } } })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ content: 'Hello', author: { id: author.id, display_name: 'Sam', bridge_source: 'matrix', bot: false }, metadata: { bridge_author: author, bridge_source: 'matrix' } })
    expect(r.body.metadata).not.toHaveProperty('discord_user')
    expect(r.body.metadata.bridge_author).not.toHaveProperty('access_token')
  })
  it('rejects an unregistered or wrong-platform author rather than silently posting anonymously', async () => {
    platform = null
    expect((await supertest(app()).post(base + '/messages').send({ content: 'Hello', metadata: { bridge_author: author } })).status).toBe(403)
    platform = 'discord'
    expect((await supertest(app()).post(base + '/messages').send({ content: 'Hello', metadata: { bridge_author: author } })).status).toBe(400)
    expect(db.writesTo('messages', 'insert')).toHaveLength(0)
  })
  it('never accepts generic author metadata through the ordinary-bot sanitizer', () => {
    expect(botSuppliedMetadata({ bridge_author: author, bridge_source: 'matrix', note: 'ok' })).toEqual({ note: 'ok' })
  })
  it('does not let a Matrix bot borrow a legacy Discord pairing', async () => {
    db.rows('discord_bridge_pairings').push({ server_id: SERVER })
    const r = await supertest(app()).post(base + '/messages').send({ content: 'Hello', metadata: { discord_user: { id: '123', username: 'fake' }, bridge_source: 'discord' } })
    expect(r.status).toBe(201); expect(r.body.metadata).not.toHaveProperty('discord_user')
  })
  it('does not cache Matrix registration across writes on the same API instance', async () => {
    const api = app()
    const send = () => supertest(api).post(base + '/messages').send({ content: 'Hello', metadata: { bridge_author: author } })
    expect((await send()).status).toBe(201)
    platform = null
    expect((await send()).status).toBe(403)
    expect(db.writesTo('messages', 'insert')).toHaveLength(1)
  })
  it('checks registration again on an author metadata edit', async () => {
    db.rows('messages')[0].bot_id = BOT; platform = null
    const r = await supertest(app()).patch('/api/v1/messages/' + MESSAGE + '/metadata').send({ metadata: { bridge_author: author } })
    expect(r.status).toBe(403); expect(db.writesTo('messages', 'update')).toHaveLength(0)
  })
})

describe('generic reaction author authorization', () => {
  it('requires registration and validates the platform before writing a reaction author', async () => {
    db.rows('bot_server_permissions')[0].add_reactions = true
    platform = null
    expect((await supertest(app()).put(`/api/v1/messages/${MESSAGE}/reactions/hello`).send({ metadata: { bridge_author: author } })).status).toBe(403)
    expect(db.writesTo('reactions')).toHaveLength(0)
    platform = 'matrix'
    expect((await supertest(app()).put(`/api/v1/messages/${MESSAGE}/reactions/hello`).send({ metadata: { bridge_author: { ...author, secret: 'discard' } } })).status).toBe(204)
    expect(db.rows('reactions')[0].metadata.bridge_author).toEqual(author)
  })
})

describe('bridge privacy REST boundaries', () => {
  it('filters channel history and returns 404 for an opted-out single message', async () => {
    visible = []
    expect((await supertest(app()).get(base + '/messages')).body).toEqual([])
    expect((await supertest(app()).get('/api/v1/messages/' + MESSAGE)).status).toBe(404)
  })
  it('filters lookup by Discord mapping too', async () => {
    visible = []; db.rows('messages')[0].is_deleted = false
    expect((await supertest(app()).get(base + '/messages/lookup?discord_message_id=123')).status).toBe(404)
  })
  it('reports registration and explicit current consent', async () => {
    expect((await supertest(app()).get(base + '/bridge-platform')).body).toEqual({ platform: 'matrix' })
    consent = false
    expect((await supertest(app()).get(base + '/bridge-consent/' + USER)).body).toEqual({ relay_allowed: false })
  })
  it('does not cache consent across requests on the same API instance', async () => {
    const api = app()
    expect((await supertest(api).get(base + '/bridge-consent/' + USER)).body).toEqual({ relay_allowed: true })
    consent = false
    expect((await supertest(api).get(base + '/bridge-consent/' + USER)).body).toEqual({ relay_allowed: false })
  })
  it('fails closed for unavailable or malformed consent and registration', async () => {
    consent = null
    expect((await supertest(app()).get(base + '/bridge-consent/' + USER)).status).toBe(503)
    mocks.rpc.mockResolvedValue({ data: undefined, error: { message: 'offline' } })
    expect((await supertest(app()).get(base + '/bridge-platform')).status).toBe(503)
    expect((await supertest(app()).get(base + '/messages')).status).toBe(500)
  })
  it('checks channel read access before exposing consent or registration', async () => {
    db.rows('bot_server_permissions')[0].read_messages = false
    expect((await supertest(app()).get(base + '/bridge-platform')).status).toBe(403)
    expect((await supertest(app()).get(base + '/bridge-consent/' + USER)).status).toBe(403)
  })
})

describe('Matrix room control and consenting native members', () => {
  it('binds the configured room without overwriting an existing administrator mode', async () => {
    const r = await supertest(app()).put(base + '/bridge-room').send({ room_id: '!opaqueRoom', initial_sender_mode: 'relay' })
    expect(r.status).toBe(200); expect(r.body).toEqual(room)
    expect(mocks.rpc).toHaveBeenCalledWith('matrix_bridge_bind_room', {
      p_bot_id: BOT, p_channel_id: CHANNEL, p_room_id: '!opaqueRoom', p_initial_sender_mode: 'relay',
    })
    expect((await supertest(app()).get(base + '/bridge-room')).body).toEqual(room)
  })
  it.each([{ room_id: '!bad/room', initial_sender_mode: 'ghost' }, { room_id: '!ok', initial_sender_mode: 'auto' }, { room_id: '!ok\u0000', initial_sender_mode: 'relay' }])('rejects malformed room bindings', async body => {
    expect((await supertest(app()).put(base + '/bridge-room').send(body)).status).toBe(400)
  })
  it('requires current Matrix read/send registration on every control/member request', async () => {
    platform = null
    for (const path of ['/bridge-room', '/bridge-members', '/bridge-members/' + USER + '/avatar']) {
      expect((await supertest(app()).get(base + path)).status).toBe(403)
    }
    platform = 'matrix'; db.rows('bot_server_permissions')[0].send_messages = false
    expect((await supertest(app()).get(base + '/bridge-members')).status).toBe(403)
  })
  it('returns only the member projection and no avatars after opt-out', async () => {
    vi.stubEnv('PUBLIC_URL', 'https://harmony.example')
    ;(members as any[])[0].private_data = 'do not expose'
    const r = await supertest(app()).get(base + '/bridge-members')
    expect(r.status).toBe(200); expect(r.body[0]).toMatchObject({ id: USER, display_name: 'Alice', domain: 'profiles.example', is_local: true })
    expect(r.body[0]).not.toHaveProperty('private_data')
    members = []
    expect((await supertest(app()).get(base + '/bridge-members')).body).toEqual([])
    expect((await supertest(app()).get(base + '/bridge-members/' + USER + '/avatar')).status).toBe(404)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('fails closed on malformed control/member RPC answers', async () => {
    room = { room_id: '!opaque', sender_mode: 'automatic' }; members = null
    expect((await supertest(app()).get(base + '/bridge-room')).status).toBe(503)
    expect((await supertest(app()).get(base + '/bridge-members')).status).toBe(503)
  })
  it('serves bounded native raster bytes from configured storage without credentials', async () => {
    const png = Buffer.from([137,80,78,71,13,10,26,10])
    fetcher.mockResolvedValue(new Response(png))
    const r = await supertest(app()).get(base + '/bridge-members/' + USER + '/avatar')
    expect(r.status).toBe(200); expect(r.body).toEqual({ data: png.toString('base64'), content_type: 'image/png' })
    expect(fetcher).toHaveBeenCalledWith('https://harmony.example/storage/v1/object/public/avatars/alice/avatar.png', expect.objectContaining({ redirect: 'error' }))
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('headers')
  })
  it.each(['https://attacker.example/avatar.png', '../private/file.png', '/default_avatar.webp'])('never fetches an arbitrary or bundled avatar URL (%s)', async avatar => {
    ;(members as any[])[0].avatar_url = avatar
    expect((await supertest(app()).get(base + '/bridge-members/' + USER + '/avatar')).status).toBe(404)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('rejects oversized or nonraster avatar downloads', async () => {
    fetcher.mockResolvedValueOnce(new Response(Buffer.alloc(1024 * 1024 + 1)))
      .mockResolvedValueOnce(new Response('<svg/>'))
    expect((await supertest(app()).get(base + '/bridge-members/' + USER + '/avatar')).status).toBe(404)
    expect((await supertest(app()).get(base + '/bridge-members/' + USER + '/avatar')).status).toBe(404)
  })
})

describe('bounded Matrix avatar upload', () => {
  const png = Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')
  it('stores only content-addressed image bytes under this bridge bot', async () => {
    const r = await supertest(app()).post(base + '/bridge-avatar').send({ data: png, content_type: 'image/png' })
    expect(r.status).toBe(200); expect(r.body.avatar_url).toContain('/avatars/bridges/' + BOT + '/')
    expect(mocks.upload).toHaveBeenCalledWith(expect.stringMatching(/\.png$/), expect.any(Buffer), expect.objectContaining({ contentType: 'image/png' }))
  })
  it.each([{ data: png, content_type: 'image/svg+xml' }, { data: 'invalid base64', content_type: 'image/png' }, { data: png, content_type: 'image/jpeg' }, { data: Buffer.alloc(1024 * 1024 + 1).toString('base64'), content_type: 'image/png' }])('rejects invalid raster input', async body => {
    mocks.upload.mockClear()
    expect((await supertest(app()).post(base + '/bridge-avatar').send(body)).status).toBe(400)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('requires a Matrix pairing and propagates storage failure without a public URL', async () => {
    platform = 'discord'
    expect((await supertest(app()).post(base + '/bridge-avatar').send({ data: png, content_type: 'image/png' })).status).toBe(403)
    platform = 'matrix'; mocks.upload.mockResolvedValue({ error: { message: 'unavailable' } })
    expect((await supertest(app()).post(base + '/bridge-avatar').send({ data: png, content_type: 'image/png' })).status).toBe(503)
  })
})
