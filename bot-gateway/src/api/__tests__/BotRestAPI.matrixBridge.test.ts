import { beforeEach, describe, expect, it, vi } from 'vitest'
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
function app() { const a = express(); a.use(express.json({ limit: '2mb' })); a.use('/api/v1', new BotRestAPI().router); return a }
const base = `/api/v1/channels/${CHANNEL}`
beforeEach(() => {
  platform = 'matrix'; consent = true; visible = [MESSAGE]
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
