import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb, type Row } from '../../__tests__/fakeSupabase.js'

const BOT = '00000000-0000-0000-0000-0000000000b0'
const OTHER_BOT = '00000000-0000-0000-0000-0000000000b2'
const SERVER = '00000000-0000-0000-0000-00000000005a'
const CHANNEL = '00000000-0000-0000-0000-0000000000c1'
const USER = '00000000-0000-0000-0000-0000000000a1'
const OTHER_USER = '00000000-0000-0000-0000-0000000000a2'
const MESSAGE = '00000000-0000-0000-0000-0000000000f1'
const author = { platform: 'matrix', id: '@sam:example.org', username: 'sam', display_name: 'Sam', avatar_url: 'https://cdn.example/sam.png' }
const stored = { id: '@sam:example.org', username: 'sam', display_name: 'Sam', avatar_url: 'https://cdn.example/sam.png' }
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), upload: vi.fn(), list: vi.fn(), getPublicUrl: vi.fn() }))
vi.mock('../../config/supabase.js', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc, storage: { from: () => ({ upload: mocks.upload, list: mocks.list, getPublicUrl: mocks.getPublicUrl }) } }, config: {},
}))
vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => { req.bot = { id: BOT, username: 'matrix-bridge', scopes: ['bot'] }; next() },
  botRateLimit: (_req: any, _res: any, next: any) => next(),
}))
import { BotRestAPI, botSuppliedMetadata, reactionMetadata } from '../BotRestAPI.js'
import { forgetBridgeConsent } from '../../bridge/memberConsent.js'

let db: FakeDb
let platform: string | null
let platformFails: boolean
let optedOut: Record<string, string[]>
let optOutsFail: boolean
let consent: unknown
let room: unknown
let members: unknown
const fetcher = vi.fn()
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
function app() { const a = express(); a.use(express.json({ limit: '2mb' })); a.use('/api/v1', new BotRestAPI().router); return a }
const base = `/api/v1/channels/${CHANNEL}`
const inserted = () => db.writesTo('messages', 'insert').map(w => w.rows[0])

beforeEach(() => {
  forgetBridgeConsent()
  platform = 'matrix'; platformFails = false; optedOut = {}; optOutsFail = false; consent = true
  room = { room_id: '!opaqueRoom', sender_mode: 'ghost' }
  members = [{ id: USER, username: 'alice', display_name: 'Alice', avatar_url: 'alice/avatar.png', nickname: null, domain: 'profiles.example', is_local: true }]
  fetcher.mockReset(); vi.stubGlobal('fetch', fetcher)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  db = new FakeDb({
    bots: [{ id: BOT, bot_type: null, bridge_platform: 'matrix' }, { id: OTHER_BOT, bot_type: null, bridge_platform: null }],
    servers: [{ id: SERVER, owner: USER }], channels: [{ id: CHANNEL, server_id: SERVER }],
    server_roles: [{ id: 'everyone', server_id: SERVER, is_default: true, position: 0, permissions: 122646786 }],
    bot_server_permissions: [{ bot_id: BOT, server_id: SERVER, is_active: true, read_messages: true, send_messages: true }],
    bridge_channels: [{ bot_id: BOT, channel_id: CHANNEL, platform: 'matrix' }],
    messages: [{ id: MESSAGE, channel_id: CHANNEL, user_id: USER, bot_id: null, content: [{ type: 'text', text: 'private' }], metadata: { discord_message_id: '123' }, created_at: '2026-11-01T00:00:00Z' }],
  })
  mocks.from.mockImplementation((table: string) => db.from(table))
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    if (fn === 'bridge_channel_platform') return platformFails ? { data: null, error: { message: 'offline' } } : { data: platform, error: null }
    if (fn === 'bridge_member_optout_ids') {
      return optOutsFail ? { data: null, error: { message: 'offline' } } : { data: { user_ids: optedOut[args.p_platform] ?? [] }, error: null }
    }
    if (fn === 'bridge_member_relay_allowed') return { data: consent, error: null }
    if (fn === 'bridge_message_by_discord_id') {
      return { data: db.rows('messages').find(m => m.metadata?.discord_message_id === args.p_discord_message_id)?.id ?? null, error: null }
    }
    if (fn === 'matrix_bridge_bind_room' || fn === 'matrix_bridge_room') return { data: room, error: null }
    if (fn === 'matrix_bridge_channel_members') return { data: members, error: null }
    throw new Error('Unmocked RPC: ' + fn)
  })
  mocks.upload.mockResolvedValue({ error: null })
  mocks.list.mockResolvedValue({ data: [], error: null })
  mocks.getPublicUrl.mockImplementation((path: string) => ({ data: { publicUrl: 'https://harmony.example/storage/v1/object/public/avatars/' + path } }))
})

describe('metadata.bridge_author on a message', () => {
  const send = (metadata: unknown) => supertest(app()).post(base + '/messages').send({ content: 'Hello', metadata })

  it('stores a Matrix author as matrix_user with bridge_source matrix, and drops discord_user', async () => {
    const r = await send({ bridge_author: { ...author, access_token: 'discard' }, discord_user: { id: '1', username: 'forged' } })
    expect(r.status).toBe(201)
    expect(inserted()[0].metadata).toEqual({ matrix_user: stored, bridge_source: 'matrix', bot: true, created_via: 'bot_api' })
    expect(r.body).toMatchObject({ content: 'Hello', author: { id: author.id, display_name: 'Sam', bot: false, bridge_source: 'matrix', bridge_author: true } })
    expect(mocks.rpc).toHaveBeenCalledWith('bridge_channel_platform', { p_bot_id: BOT, p_channel_id: CHANNEL })
  })

  it('keeps only an https avatar', async () => {
    await send({ bridge_author: { ...author, avatar_url: 'http://cdn.example/sam.png' } })
    expect(inserted()[0].metadata.matrix_user).toEqual({ id: author.id, username: 'sam', display_name: 'Sam' })
  })

  it('answers 403 where the bot does not relay the channel to Matrix, 503 when that is unknown, 400 for an invalid author', async () => {
    platform = null
    expect((await send({ bridge_author: author })).status).toBe(403)
    forgetBridgeConsent(); platform = 'discord'
    expect((await send({ bridge_author: author })).status).toBe(403)
    forgetBridgeConsent(); platformFails = true
    expect((await send({ bridge_author: author })).status).toBe(503)
    forgetBridgeConsent(); platformFails = false; platform = 'matrix'
    expect((await send({ bridge_author: { ...author, id: 'sam' } })).status).toBe(400)
    expect((await send({ bridge_author: { ...author, platform: 'discord', id: '42' } })).status).toBe(400)
    expect(db.writesTo('messages', 'insert')).toHaveLength(0)
  })

  it('never stores discord_user, bridge_author or matrix_user a bot supplies directly', async () => {
    expect(botSuppliedMetadata({ bridge_author: author, matrix_user: stored, discord_user: { id: '1' }, bridge_source: 'matrix', note: 'ok' }))
      .toEqual({ note: 'ok' })
    db.rows('discord_bridge_pairings').push({ server_id: SERVER })
    const r = await send({ matrix_user: stored, discord_user: { id: '123', username: 'fake' }, bridge_source: 'discord' })
    expect(r.status).toBe(201)
    expect(inserted()[0].metadata).toEqual({ bot: true, created_via: 'bot_api' })
  })

  it('applies the same rule to a metadata edit of its own message', async () => {
    db.rows('messages')[0].bot_id = BOT
    db.rows('messages')[0].user_id = null
    const patch = (metadata: unknown) => supertest(app()).patch('/api/v1/messages/' + MESSAGE + '/metadata').send({ metadata })
    expect((await patch({ bridge_author: author, matrix_user: { id: '@forged:example.org', username: 'x' } })).status).toBe(200)
    expect(db.rows('messages')[0].metadata).toEqual({ discord_message_id: '123', matrix_user: stored, bridge_source: 'matrix' })

    forgetBridgeConsent(); platform = null
    expect((await patch({ bridge_author: { ...author, username: 'renamed' } })).status).toBe(403)
    expect(db.rows('messages')[0].metadata.matrix_user).toEqual(stored)
  })
})

describe('metadata.bridge_author on a reaction', () => {
  const react = (metadata: unknown) => supertest(app()).put(`/api/v1/messages/${MESSAGE}/reactions/hello`).send({ metadata })

  beforeEach(() => { db.rows('bot_server_permissions')[0].add_reactions = true })

  it('stores a Matrix reactor as reactions.metadata.matrix_user', async () => {
    expect((await react({ bridge_author: { ...author, secret: 'discard' }, discord_user: { id: '1' } })).status).toBe(204)
    expect(db.rows('reactions')[0].metadata).toEqual({ matrix_user: stored, bridge_source: 'matrix' })
  })

  it('answers 403 where the bot does not relay the channel to Matrix, and 400 for an invalid author', async () => {
    platform = null
    expect((await react({ bridge_author: author })).status).toBe(403)
    forgetBridgeConsent(); platform = 'matrix'
    expect((await react({ bridge_author: { ...author, username: '' } })).status).toBe(400)
    expect(db.writesTo('reactions')).toHaveLength(0)
  })

  it('never stores bridge_author or matrix_user a bot supplies directly', () => {
    expect(reactionMetadata({ bridge_author: author, matrix_user: stored, remote_emoji_url: 'https://cdn.discordapp.com/emojis/1.png' }))
      .toEqual({ remote_emoji_url: 'https://cdn.discordapp.com/emojis/1.png' })
  })
})

describe('history and single reads by a Matrix bridge', () => {
  const history = (query = '') => supertest(app()).get(base + '/messages' + query)
  const ids = (body: any[]) => body.map(m => m.id)

  it('hides a message whose author opted out of Matrix from history, single reads and the Discord-id lookup', async () => {
    expect(ids((await history()).body)).toEqual([MESSAGE])
    expect((await supertest(app()).get('/api/v1/messages/' + MESSAGE)).status).toBe(200)
    expect((await supertest(app()).get(base + '/messages/lookup?discord_message_id=123')).status).toBe(200)

    optedOut = { matrix: [USER] }
    forgetBridgeConsent()
    expect((await history()).body).toEqual([])
    expect((await supertest(app()).get('/api/v1/messages/' + MESSAGE)).status).toBe(404)
    expect((await supertest(app()).get(base + '/messages/lookup?discord_message_id=123')).status).toBe(404)
  })

  it('keeps it for an opt-out of another platform, and hides a bot reply to an interaction of the opted-out member', async () => {
    optedOut = { discord: [USER] }
    db.rows('messages').push({
      id: '00000000-0000-0000-0000-0000000000f2', channel_id: CHANNEL, user_id: null, bot_id: OTHER_BOT, content: [],
      metadata: { interaction: { id: 'i', name: 'weather', user_id: OTHER_USER } }, created_at: '2026-10-31T00:00:00Z',
    })
    expect(ids((await history()).body)).toEqual([MESSAGE, '00000000-0000-0000-0000-0000000000f2'])
    optedOut = { matrix: [OTHER_USER] }
    forgetBridgeConsent()
    expect(ids((await history()).body)).toEqual([MESSAGE])
  })

  it('hides every member row while the opt-outs cannot be read', async () => {
    optOutsFail = true
    const history200 = await history()
    expect(history200.status).toBe(200)
    expect(history200.body).toEqual([])
    expect((await supertest(app()).get('/api/v1/messages/' + MESSAGE)).status).toBe(404)
  })

  it('fills a short page from older rows, at most four further reads', async () => {
    // FakeDb keeps insertion order: rows are seeded newest first, as the query orders them.
    const row = (i: number, userId: string): Row => ({
      id: `00000000-0000-0000-0000-0000000001${String(i).padStart(2, '0')}`, channel_id: CHANNEL, user_id: userId, bot_id: null,
      content: [], metadata: {}, created_at: new Date(Date.UTC(2026, 10, 10) - i * 60_000).toISOString(),
    })
    const reads = () => mocks.from.mock.calls.filter(([table]) => table === 'messages').length
    optedOut = { matrix: [USER] }

    db.tables.messages = [row(0, USER), row(1, OTHER_USER), row(2, OTHER_USER), row(3, OTHER_USER)]
    let before = reads()
    expect(ids((await history('?limit=2')).body)).toEqual([row(1, OTHER_USER).id, row(2, OTHER_USER).id])
    expect(reads() - before).toBe(2)

    db.tables.messages = [...Array.from({ length: 9 }, (_, i) => row(i, USER)), row(9, OTHER_USER), row(10, OTHER_USER)]
    before = reads()
    expect(ids((await history('?limit=2')).body)).toEqual([row(9, OTHER_USER).id])
    expect(reads() - before).toBe(5)
  })
})

describe('bridge-consent and bridge-platform', () => {
  it('answers relay_allowed from bridge_member_relay_allowed, read on every request', async () => {
    const api = app()
    expect((await supertest(api).get(base + '/bridge-consent/' + USER)).body).toEqual({ relay_allowed: true })
    consent = false
    expect((await supertest(api).get(base + '/bridge-consent/' + USER)).body).toEqual({ relay_allowed: false })
    expect(mocks.rpc).toHaveBeenCalledWith('bridge_member_relay_allowed', { p_bot_id: BOT, p_channel_id: CHANNEL, p_user_id: USER })
    consent = null
    expect((await supertest(api).get(base + '/bridge-consent/' + USER)).status).toBe(503)
  })

  it('reports the platform, and 503 when it cannot be read', async () => {
    expect((await supertest(app()).get(base + '/bridge-platform')).body).toEqual({ platform: 'matrix' })
    forgetBridgeConsent(); platformFails = true
    expect((await supertest(app()).get(base + '/bridge-platform')).status).toBe(503)
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
  it('requires Matrix read/send registration on every control/member request', async () => {
    platform = null
    for (const path of ['/bridge-room', '/bridge-members', '/bridge-members/' + USER + '/avatar']) {
      expect((await supertest(app()).get(base + path)).status).toBe(403)
    }
    forgetBridgeConsent(); platform = 'matrix'; db.rows('bot_server_permissions')[0].send_messages = false
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
  const upload = () => supertest(app()).post(base + '/bridge-avatar').send({ data: png, content_type: 'image/png' })
  it('stores only content-addressed image bytes under this bridge bot', async () => {
    const r = await upload()
    expect(r.status).toBe(200); expect(r.body.avatar_url).toContain('/avatars/bridges/' + BOT + '/')
    expect(mocks.upload).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^bridges/${BOT}/[a-f0-9]{64}\\.png$`)), expect.any(Buffer), expect.objectContaining({ contentType: 'image/png' }))
  })
  it.each([{ data: png, content_type: 'image/svg+xml' }, { data: 'invalid base64', content_type: 'image/png' }, { data: png, content_type: 'image/jpeg' }, { data: Buffer.alloc(1024 * 1024 + 1).toString('base64'), content_type: 'image/png' }])('rejects invalid raster input', async body => {
    mocks.upload.mockClear()
    expect((await supertest(app()).post(base + '/bridge-avatar').send(body)).status).toBe(400)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('requires a Matrix pairing and propagates storage failure without a public URL', async () => {
    platform = 'discord'
    expect((await upload()).status).toBe(403)
    forgetBridgeConsent(); platform = 'matrix'; mocks.upload.mockResolvedValue({ error: { message: 'unavailable' } })
    expect((await upload()).status).toBe(503)
  })
  it('answers 507 for a new avatar past the 5000 a bot keeps', async () => {
    mocks.list.mockImplementation(async (_prefix: string, options: { search?: string }) => (
      { data: options.search ? [] : Array.from({ length: 5000 }, (_, i) => ({ name: `${i}.png` })), error: null }))
    expect((await upload()).status).toBe(507)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
})
