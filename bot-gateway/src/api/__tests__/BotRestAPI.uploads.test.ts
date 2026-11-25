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

import { BotRestAPI, BusyError, UPLOADS_PER_BOT, WAITING_UPLOADS_PER_BOT, keyedConcurrencyLimit } from '../BotRestAPI.js'
import { EmptyFileError, OverQuotaError, QuotaBusyError, TooLargeError } from '../../utils/mirrorFile.js'
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
    expect(opts).toMatchObject({ botId: BOT_ID, channelId: GENERAL, fileName: 'deepfried.png', contentType: 'image/png', ceiling: 1000, declaredSize: PNG.length })
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

  it('answers 429 while only files in flight keep the server\'s cap from taking the file', async () => {
    seed()
    mocks.store.mockRejectedValueOnce(new QuotaBusyError(11))
    const busy = await post(GENERAL, PNG)
    expect(busy.status).toBe(429)
    expect(busy.headers['retry-after']).toBe('5')
    expect(busy.body).toEqual({ error: 'Too many uploads at once', retry_after: 5 })
  })
})

describe('uploads of one bot at once', () => {
  it('stores UPLOADS_PER_BOT at a time, lets the rest wait unread, and answers 429 past the line', async () => {
    seed()
    let open = 0
    let most = 0
    const finish: Array<() => void> = []
    mocks.store.mockImplementation(async (body: NodeJS.ReadableStream) => {
      most = Math.max(most, ++open)
      await new Promise<void>((resolve) => finish.push(resolve))
      for await (const _ of body) { /* consumes the request as the real store does */ }
      open--
      return { path: STORED, url: `https://signed.test/${STORED}`, contentType: 'image/png', bytes: PNG.length }
    })
    const server = app().listen(0)
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/channels/${GENERAL}/attachments?filename=a.png`
      const send = () => fetch(url, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(PNG) })
      const admitted = Array.from({ length: UPLOADS_PER_BOT + WAITING_UPLOADS_PER_BOT }, send)
      await vi.waitFor(() => expect(mocks.store).toHaveBeenCalledTimes(UPLOADS_PER_BOT))
      // The line fills before the next request asks.
      await new Promise((resolve) => setTimeout(resolve, 100))
      const refused = await send()
      expect(refused.status).toBe(429)
      expect(refused.headers.get('retry-after')).toBe('5')
      expect(await refused.json()).toEqual({ error: 'Too many uploads at once', retry_after: 5 })
      expect(mocks.store).toHaveBeenCalledTimes(UPLOADS_PER_BOT)

      let settled = false
      const all = Promise.all(admitted).then((responses) => { settled = true; return responses.map((r) => r.status) })
      while (!settled) {
        finish.splice(0).forEach((done) => done())
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(new Set(await all)).toEqual(new Set([201]))
      expect(most).toBe(UPLOADS_PER_BOT)
      const next = send()
      await vi.waitFor(() => expect(finish).toHaveLength(1))
      finish[0]()
      expect((await next).status).toBe(201)
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('counts each bot apart, frees a place on failure and never runs more than the limit', async () => {
    const limiter = keyedConcurrencyLimit(1, 1)
    const gates: Array<() => void> = []
    const hold = () => new Promise<void>((resolve) => gates.push(resolve))
    const first = limiter.run('a', async () => { await hold(); throw new Error('failed') })
    const second = limiter.run('a', async () => 'second')
    await expect(limiter.run('a', async () => 'third')).rejects.toBeInstanceOf(BusyError)
    expect(await limiter.run('b', async () => 'other')).toBe('other')
    gates.forEach((open) => open())
    await expect(first).rejects.toThrow('failed')
    expect(await second).toBe('second')
    expect(await limiter.run('a', async () => 'again')).toBe('again')

    // A task started in the turn another ends in waits behind the one whose turn it is.
    const order: string[] = []
    let running = 0
    let most = 0
    const step = (name: string) => limiter.run('c', async () => {
      most = Math.max(most, ++running)
      order.push(name)
      await Promise.resolve()
      running--
    })
    const one = step('one')
    const two = step('two')
    const three = one.then(() => step('three'))
    await Promise.all([one, two, three])
    expect(order).toEqual(['one', 'two', 'three'])
    expect(most).toBe(1)
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
