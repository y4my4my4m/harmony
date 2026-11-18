import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb, type Row } from '../../__tests__/fakeSupabase.js'

const BOT_ID = '00000000-0000-0000-0000-0000000000b0'
const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const OWNER_ID = '00000000-0000-0000-0000-0000000000a1'
const GENERAL = '00000000-0000-0000-0000-0000000000c1'
const NO_FILES = '00000000-0000-0000-0000-0000000000c2'
const EVERYONE_ROLE = '00000000-0000-0000-0000-0000000000e0'
const ATTACH_FILES = 1n << 17n
// create_default_server_role()
const EVERYONE_DEFAULT = 122646786n

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  store: vi.fn(),
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: {},
}))

vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, _res: any, next: any) => {
    req.bot = { id: BOT_ID, username: 'levels', scopes: ['bot'] }
    next()
  },
  botRateLimit: (_req: any, _res: any, next: any) => next(),
}))

vi.mock('../../utils/mirrorFile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/mirrorFile.js')>()
  return { ...actual, storeBotUpload: mocks.store }
})

vi.mock('../../utils/mirrorExternalMedia.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/mirrorExternalMedia.js')>()
  return { ...actual, getUploadCeilingBytes: async () => 1000 }
})

import { BotRestAPI } from '../BotRestAPI.js'
import { EmptyFileError, OverQuotaError, TooLargeError } from '../../utils/mirrorFile.js'
import { formatContent } from '../messageContent.js'

let db: FakeDb

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
    attach_files: true,
    ...overrides,
  }
}

function seed(installRow: Row = install()) {
  db = new FakeDb({
    servers: [{ id: SERVER_ID, owner: OWNER_ID }],
    server_roles: [
      { id: EVERYONE_ROLE, server_id: SERVER_ID, name: 'everyone', position: 0, permissions: Number(EVERYONE_DEFAULT), is_default: true, is_admin: false },
    ],
    channels: [
      { id: GENERAL, server_id: SERVER_ID, name: 'general' },
      { id: NO_FILES, server_id: SERVER_ID, name: 'no-files' },
    ],
    channel_permission_overrides: [
      { id: '00000000-0000-0000-0000-0000000000a9', channel_id: NO_FILES, target_type: 'role', role_id: EVERYONE_ROLE, user_id: null, allow_permissions: 0, deny_permissions: Number(ATTACH_FILES) },
    ],
    bot_server_permissions: [installRow],
    bot_audit_log: [],
  })
  mocks.from.mockImplementation((table: string) => db.from(table))
}

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/v1', new BotRestAPI().router)
  return a
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const STORED = `c/${GENERAL}/bridge/${BOT_ID}/0f0e0d0c-0b0a-4908-8706-050403020100.png`

const post = (channelId: string, body: Buffer | string, type = 'image/png', query = '?filename=deepfried.png') =>
  supertest(app()).post(`/api/v1/channels/${channelId}/attachments${query}`).set('Content-Type', type).send(body)

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.from.mockReset()
  mocks.store.mockReset()
  mocks.store.mockImplementation(async (body: NodeJS.ReadableStream) => {
    for await (const _ of body) { /* consumes the request as the real store does */ }
    return { path: STORED, url: `https://signed.test/${STORED}`, contentType: 'image/png', bytes: PNG.length }
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /channels/:id/attachments', () => {
  it('stores the body and answers the file part to send', async () => {
    seed()
    const res = await post(GENERAL, PNG)

    expect(res.status).toBe(201)
    expect(res.body).toEqual({
      type: 'file',
      path: STORED,
      url: `https://signed.test/${STORED}`,
      fileType: 'image',
      fileName: 'deepfried.png',
      fileSize: PNG.length,
      mimeType: 'image/png',
    })
    const [, opts] = mocks.store.mock.calls[0]
    expect(opts).toMatchObject({ botId: BOT_ID, channelId: GENERAL, fileName: 'deepfried.png', contentType: 'image/png', ceiling: 1000 })
    expect(db.rows('bot_audit_log').map((r) => r.action_type)).toEqual(['file_uploaded'])
  })

  it('keeps only the last segment of the file name, without control characters', async () => {
    seed()
    const res = await post(GENERAL, PNG, 'image/png', `?filename=${encodeURIComponent('../../etc/pa\u0007sswd')}`)
    expect(res.body.fileName).toBe('passwd')
    const unnamed = await post(GENERAL, PNG, 'image/png', '')
    expect(unnamed.body.fileName).toBe('file')
  })

  it('needs attach_files and send_messages, and the channel\'s ATTACH_FILES', async () => {
    seed(install({ attach_files: false }))
    expect((await post(GENERAL, PNG)).body.error).toBe('Missing permission: attach_files')
    seed(install({ send_messages: false }))
    expect((await post(GENERAL, PNG)).body.error).toBe('Missing permission: send_messages')
    seed()
    const denied = await post(NO_FILES, PNG)
    expect(denied.status).toBe(403)
    expect(denied.body.error).toBe('Missing permission in this channel: attach_files')
    expect(mocks.store).not.toHaveBeenCalled()
  })

  it('refuses a JSON or form body, an oversized Content-Length and a bad channel id', async () => {
    seed()
    expect((await post(GENERAL, '{"a":1}', 'application/json')).status).toBe(415)
    expect((await post(GENERAL, 'a=1', 'application/x-www-form-urlencoded')).status).toBe(415)
    const big = await post(GENERAL, Buffer.alloc(1001))
    expect(big.status).toBe(413)
    expect(big.body.max_bytes).toBe(1000)
    expect((await post('nope', PNG)).status).toBe(400)
    expect(mocks.store).not.toHaveBeenCalled()
  })

  it('answers 413, 400 and 507 for the store\'s refusals', async () => {
    seed()
    mocks.store.mockRejectedValueOnce(new TooLargeError(2000))
    expect((await post(GENERAL, PNG)).status).toBe(413)
    mocks.store.mockRejectedValueOnce(new EmptyFileError())
    expect((await post(GENERAL, PNG)).status).toBe(400)
    mocks.store.mockRejectedValueOnce(new OverQuotaError(11))
    expect((await post(GENERAL, PNG)).status).toBe(507)
    expect(db.rows('bot_audit_log')).toEqual([])
  })
})

describe('a message naming an uploaded file', () => {
  it('keeps the path of the bot\'s own file in that channel and drops any other', () => {
    const own = { type: 'file', url: 'https://signed.test/x', path: STORED, fileType: 'image' }
    const foreign = { type: 'file', url: 'https://signed.test/y', path: `c/${GENERAL}/u/${OWNER_ID}/a.png`, fileType: 'image' }

    expect(formatContent([own, foreign], undefined, { channelId: GENERAL, botId: BOT_ID })).toEqual([
      own,
      { type: 'file', url: 'https://signed.test/y', fileType: 'image' },
    ])
    expect(formatContent([own], undefined, { channelId: NO_FILES, botId: BOT_ID })[0]).not.toHaveProperty('path')
  })
})
