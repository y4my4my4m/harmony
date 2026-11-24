import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const BOT = '00000000-0000-0000-0000-0000000000b0'
const CHANNEL = '00000000-0000-0000-0000-0000000000c1', OTHER_CHANNEL = '00000000-0000-0000-0000-0000000000c2'
const SERVER = '00000000-0000-0000-0000-00000000005a', USER = '00000000-0000-0000-0000-0000000000a1', MESSAGE = '00000000-0000-0000-0000-0000000000f1'
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), signed: vi.fn(), bucket: vi.fn(), rate: vi.fn(), store: vi.fn() }))
vi.mock('../../config/supabase.js', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc, storage: { getBucket: mocks.bucket, from: () => ({ createSignedUrl: mocks.signed }) } }, config: {} }))
vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, res: any, next: any) => { if (req.headers.authorization !== 'Bearer test') return res.status(401).json({ error: 'Unauthorized' }); req.bot = { id: BOT, username: 'matrix', scopes: ['bot'] }; next() },
  botRateLimit: (req: any, res: any, next: any) => { mocks.rate(); if (req.headers['x-rate-test']) return res.status(429).json({ error: 'Rate limited' }); next() },
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
import { MAX_BRIDGE_FILE_BYTES } from '../../utils/bridgeFiles.js'
import { EmptyFileError, OverQuotaError, TooLargeError } from '../../utils/mirrorFile.js'
import { forgetBridgeConsent } from '../../bridge/memberConsent.js'

const nativePath = `c/${CHANNEL}/${USER}/native.txt`, drivePath = `u/${USER}/drive.txt`
const native = { type: 'file', path: nativePath, url: 'https://evil.invalid/do-not-fetch?token=secret', fileName: 'hello world.txt', fileType: 'file', mimeType: 'text/plain', fileSize: 5 }
const base = `/api/v1/channels/${CHANNEL}`, getPath = `${base}/messages/${MESSAGE}/bridge-files/2`
const STORED = `c/${CHANNEL}/bridge/${BOT}/0f0e0d0c-0b0a-4908-8706-050403020100.png`
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const objects = new Map<string, { bytes: Buffer; mime: string }>()
let db: FakeDb, platform: string | null, encrypted: unknown, room: unknown, optedOut: string[], storedType: string
const fetcher = vi.fn()
function app() { const a = express(); a.use(express.json({ limit: '10mb' })); a.use('/api/v1', new BotRestAPI().router); return a }
function upload(bytes: Buffer = PNG, name: string | null = encodeURIComponent('hello world.png'), type = 'image/png') {
  const request = supertest(app()).post(base + '/bridge-files').set('Authorization', 'Bearer test').set('Content-Type', 'application/octet-stream').set('X-File-Type', type)
  return (name === null ? request : request.set('X-File-Name', name)).send(bytes)
}
function get(path = getPath) { return supertest(app()).get(path).set('Authorization', 'Bearer test') }
function fixture(name: string) { return readFileSync(resolve(__dirname, '../../../../tests/fixtures/media-metadata', name)) }
beforeEach(() => {
  vi.clearAllMocks(); forgetBridgeConsent()
  platform = 'matrix'; encrypted = false; optedOut = []; room = { room_id: '!room:hs', sender_mode: 'ghost' }; storedType = 'image/png'
  vi.stubEnv('SUPABASE_URL', 'https://storage.harmony.test'); vi.stubEnv('PUBLIC_URL', 'https://harmony.test')
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
  objects.clear(); objects.set(nativePath, { bytes: Buffer.from('hello'), mime: 'text/plain' })
  db = new FakeDb({
    bots: [{ id: BOT, bot_type: null, bridge_platform: 'matrix' }], servers: [{ id: SERVER, owner: USER }], channels: [{ id: CHANNEL, server_id: SERVER }],
    server_roles: [{ id: 'everyone', server_id: SERVER, is_default: true, position: 0, permissions: 122646786 }],
    bot_server_permissions: [{ bot_id: BOT, server_id: SERVER, is_active: true, read_messages: true, send_messages: true, attach_files: true, installed_at: '2026-01-01T00:00:00Z' }],
    bridge_channels: [{ bot_id: BOT, channel_id: CHANNEL, platform: 'matrix' }],
    messages: [{ id: MESSAGE, channel_id: CHANNEL, user_id: USER, bot_id: null, is_deleted: false, encrypted: false, content: [{ type: 'text', text: 'first' }, { type: 'file', url: 'https://evil.invalid/private' }, { ...native }], metadata: {}, created_at: '2026-11-01T00:00:00Z' }],
    bot_audit_log: [],
  })
  mocks.from.mockImplementation(table => db.from(table))
  mocks.rpc.mockImplementation(async (fn, args) => {
    if (fn === 'bridge_channel_platform') return { data: platform, error: null }
    if (fn === 'bridge_member_optout_ids') return { data: { user_ids: args.p_platform === 'matrix' ? optedOut : [] }, error: null }
    if (fn === 'matrix_bridge_room') return { data: room, error: null }
    if (fn === 'channel_messages_encrypted') return { data: encrypted, error: null }
    if (fn === 'get_instance_config') return { data: null, error: null }
    throw new Error('Unmocked RPC ' + fn)
  })
  mocks.store.mockImplementation(async (body: NodeJS.ReadableStream) => {
    let bytes = 0
    for await (const chunk of body) bytes += (chunk as Buffer).length
    return { path: STORED, url: `https://signed.test/${STORED}`, contentType: storedType, bytes }
  })
  mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: MAX_BRIDGE_FILE_BYTES, allowed_mime_types: null }, error: null })
  mocks.signed.mockImplementation(async path => ({ data: { signedUrl: 'https://storage.harmony.test/storage/v1/object/sign/message_media/' + path + '?token=private' }, error: null }))
  fetcher.mockImplementation(async (url: string) => {
    const path = decodeURIComponent(new URL(url).pathname.split('/message_media/')[1] || '')
    const object = objects.get(path)
    return object ? new Response(object.bytes, { headers: { 'content-type': object.mime, 'content-length': String(object.bytes.length) } }) : new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('Matrix bridge file access', () => {
  it('authenticates and rate limits before reading the body or fetching bytes', async () => {
    expect((await supertest(app()).post(base + '/bridge-files').set('Content-Type', 'application/octet-stream').send(Buffer.from('x'))).status).toBe(401)
    expect((await supertest(app()).get(getPath)).status).toBe(401)
    expect((await get().set('X-Rate-Test', 'yes')).status).toBe(429)
    expect((await upload().set('X-Rate-Test', 'yes')).status).toBe(429)
    expect(mocks.store).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['ordinary', 'discord', 'unpaired', 'read', 'send', 'room', 'encrypted', 'unknown-encryption'])('refuses %s access in both directions', async kind => {
    if (kind === 'ordinary') { db.rows('bots')[0].bridge_platform = null; platform = null }
    if (kind === 'discord') platform = 'discord'
    if (kind === 'unpaired') platform = null
    if (kind === 'read') db.rows('bot_server_permissions')[0].read_messages = false
    if (kind === 'send') db.rows('bot_server_permissions')[0].send_messages = false
    if (kind === 'room') room = null
    if (kind === 'encrypted') encrypted = true
    if (kind === 'unknown-encryption') encrypted = null
    expect([403, 503]).toContain((await upload()).status)
    expect([403, 503]).toContain((await get()).status)
    expect(mocks.store).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('POST /channels/:id/bridge-files', () => {
  it('stores the body as POST /attachments does and answers the file part', async () => {
    const res = await upload(PNG, encodeURIComponent('hello world.png'), 'image/png; charset=binary')
    expect(res.status).toBe(201)
    expect(res.body).toEqual({
      type: 'file', path: STORED, url: `https://signed.test/${STORED}`,
      fileType: 'image', fileName: 'hello world.png', fileSize: PNG.length, mimeType: 'image/png',
    })
    const [, opts] = mocks.store.mock.calls[0]
    expect(opts).toMatchObject({ botId: BOT, channelId: CHANNEL, fileName: 'hello world.png', contentType: 'image/png', ceiling: 1000 })
    expect(db.rows('bot_audit_log').map((r) => r.action_type)).toEqual(['file_uploaded'])
  })
  it.each(['video/mp4', 'audio/ogg', 'application/pdf'])('answers %s as fileType file', async type => {
    storedType = type
    const res = await upload(Buffer.from('bytes'), 'clip.bin', type)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ fileType: 'file', mimeType: type })
  })
  it('names the file by its URI-encoded X-File-Name and refuses a missing, malformed or unsafe one', async () => {
    expect((await upload(PNG, null)).status).toBe(400)
    expect((await upload(PNG, '%E0%A4%A')).status).toBe(400)
    expect((await upload(PNG, encodeURIComponent('../secret.png'))).status).toBe(415)
    expect((await upload(PNG, encodeURIComponent('page.html'))).status).toBe(415)
    expect(mocks.store).not.toHaveBeenCalled()
  })
  it.each([
    ['application/json', '{"a":1}'], ['application/json; charset=utf-8', '[1]'],
    ['application/x-www-form-urlencoded', 'a=1'], ['multipart/form-data; boundary=x', '--x--'],
  ])('refuses a %s body, which something else has read or which wraps the file', async (type, body) => {
    const res = await supertest(app()).post(base + '/bridge-files').set('Authorization', 'Bearer test')
      .set('Content-Type', type).set('X-File-Name', 'data.json').set('X-File-Type', 'application/json').send(body)
    expect(res.status).toBe(415)
    expect(res.body.error).toBe('Send the file itself as the request body, with its own Content-Type')
    expect(mocks.store).not.toHaveBeenCalled()
  })
  it('stores a JSON file sent as application/octet-stream', async () => {
    storedType = 'application/json'
    const res = await upload(Buffer.from('{"a":1}'), 'data.json', 'application/json')
    expect(res.status).toBe(201)
    expect(mocks.store.mock.calls[0][1]).toMatchObject({ fileName: 'data.json', contentType: 'application/json', declaredSize: 7 })
  })
  it('needs attach_files and fits the upload ceiling', async () => {
    db.rows('bot_server_permissions')[0].attach_files = false
    const denied = await upload()
    expect(denied.status).toBe(403)
    expect(denied.body.error).toBe('Missing permission: attach_files')
    db.rows('bot_server_permissions')[0].attach_files = true
    const big = await upload(Buffer.alloc(1001))
    expect(big.status).toBe(413)
    expect(big.body.max_bytes).toBe(1000)
    expect(mocks.store).not.toHaveBeenCalled()
  })
  it('answers 413, 400 and 507 for the store\'s refusals', async () => {
    mocks.store.mockRejectedValueOnce(new TooLargeError(2000))
    expect((await upload()).status).toBe(413)
    mocks.store.mockRejectedValueOnce(new EmptyFileError())
    expect((await upload()).status).toBe(400)
    mocks.store.mockRejectedValueOnce(new OverQuotaError(11))
    expect((await upload()).status).toBe(507)
    expect(db.rows('bot_audit_log')).toEqual([])
  })
  it('answers a part a message of the channel keeps with its path', async () => {
    const part = (await upload()).body
    const sent = await supertest(app()).post(base + '/messages').set('Authorization', 'Bearer test').send({ content: [part] })
    expect(sent.status).toBe(201)
    expect(db.rows('messages').at(-1)!.content).toEqual([part])
  })
})

describe('GET /channels/:id/messages/:messageId/bridge-files/:index', () => {
  it('serves the raw content index with headers and fetches only a newly signed own-storage object', async () => {
    const result = await get(getPath + '?url=http://127.0.0.1/private&path=c/other/secret')
    expect(result.status).toBe(200); expect(result.body).toEqual(Buffer.from('hello'))
    expect(result.headers).toMatchObject({ 'x-file-name': 'hello%20world.txt', 'x-file-type': 'text/plain', 'content-length': '5', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/message_media/' + nativePath), { redirect: 'error', signal: expect.any(AbortSignal) })
    expect((await get(getPath.replace('/2', '/0'))).status).toBe(422)
    expect((await get(getPath.replace('/2', '/1'))).status).toBe(422)
    expect((await get(getPath.replace('/2', '/01'))).status).toBe(400)
  })
  it.each(['optout', 'deleted', 'other-channel', 'encrypted-message', 'encryption-metadata', 'encrypted-file', 'outside-path', 'traversal'])('refuses native %s before storage access', async kind => {
    const message = db.rows('messages')[0]
    if (kind === 'optout') optedOut = [USER]
    if (kind === 'deleted') message.is_deleted = true
    if (kind === 'other-channel') message.channel_id = OTHER_CHANNEL
    if (kind === 'encrypted-message') message.encrypted = true
    if (kind === 'encryption-metadata') message.encryption_metadata = { algorithm: 'megolm' }
    if (kind === 'encrypted-file') message.content[2].iv = 'secret'
    if (kind === 'outside-path') message.content[2].path = `c/${OTHER_CHANNEL}/${USER}/secret.txt`
    if (kind === 'traversal') message.content[2].path = `c/${CHANNEL}/${USER}/../secret.txt`
    expect([404, 422]).toContain((await get()).status)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('answers 422 for a Drive file and never fetches it', async () => {
    objects.set(drivePath, { bytes: Buffer.from('drive'), mime: 'text/plain' })
    db.rows('messages')[0].content[2].path = drivePath
    const result = await get()
    expect(result.status).toBe(422)
    expect(result.body).toEqual({ error: 'Drive attachments are not relayed' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('enforces READ_MESSAGE_HISTORY floors', async () => {
    db.rows('channel_permission_overrides').push({ id: 'history', channel_id: CHANNEL, target_type: 'role', role_id: 'everyone', allow_permissions: 0, deny_permissions: 4194304 })
    db.rows('bot_server_permissions')[0].installed_at = '2026-12-01T00:00:00Z'
    expect((await get()).status).toBe(404); expect(fetcher).not.toHaveBeenCalled()
  })
  // Opt-outs and the platform are cached (memberConsent); the recheck reads them once expired.
  it.each(['optout', 'unpair', 'encrypt', 'delete', 'edit', 'history'])('rechecks native %s after downloading and before emitting bytes', async kind => {
    fetcher.mockImplementationOnce(async () => {
      forgetBridgeConsent()
      if (kind === 'optout') optedOut = [USER]
      if (kind === 'unpair') platform = null
      if (kind === 'encrypt') encrypted = true
      if (kind === 'delete') db.rows('messages')[0].is_deleted = true
      if (kind === 'edit') db.rows('messages')[0].content[2].path = `c/${CHANNEL}/${USER}/new.txt`
      if (kind === 'history') {
        db.rows('channel_permission_overrides').push({ id: 'history', channel_id: CHANNEL, target_type: 'role', role_id: 'everyone', allow_permissions: 0, deny_permissions: 4194304 })
        db.rows('bot_server_permissions')[0].installed_at = '2026-12-01T00:00:00Z'
      }
      return new Response('hello', { headers: { 'content-type': 'text/plain' } })
    })
    const result = await get()
    expect([403, 404, 409]).toContain(result.status)
    expect(result.body).not.toEqual(Buffer.from('hello'))
  })
  it('downloads at most three files at once', async () => {
    const waiting: Array<() => void> = []
    const respond = () => new Response('hello', { headers: { 'content-type': 'text/plain', 'content-length': '5' } })
    fetcher.mockImplementation(async () => {
      await new Promise<void>(release => waiting.push(release))
      return respond()
    })
    const api = app()
    const statuses = Promise.all(Array.from({ length: 5 }, () =>
      supertest(api).get(getPath).set('Authorization', 'Bearer test').then(r => r.status)))
    await vi.waitFor(() => expect(waiting).toHaveLength(3))
    await new Promise(settle => setTimeout(settle, 50))
    expect(waiting).toHaveLength(3)
    fetcher.mockImplementation(async () => respond())
    for (const release of waiting.splice(0)) release()
    expect(await statuses).toEqual([200, 200, 200, 200, 200])
    expect(fetcher).toHaveBeenCalledTimes(5)
  })
  it('strips photo metadata from the downloaded bytes', async () => {
    const image = fixture('gps.png')
    objects.set(nativePath, { bytes: image, mime: 'image/png' }); db.rows('messages')[0].content[2].fileName = 'photo.png'
    const downloaded = await get()
    expect(downloaded.status).toBe(200); expect(downloaded.headers['x-file-type']).toBe('image/png')
    expect(downloaded.body.length).toBeLessThan(image.length)
    expect(Buffer.from(downloaded.body).toString('latin1')).not.toContain('HarmonyCam')
  })
  it('applies the private bucket size and MIME policy, read again after the download', async () => {
    mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: 0, allowed_mime_types: null }, error: null })
    expect((await get()).status).toBe(413)
    mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: null, allowed_mime_types: ['image/*'] }, error: null })
    expect((await get()).status).toBe(415)
    mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: MAX_BRIDGE_FILE_BYTES, allowed_mime_types: null }, error: null })
    fetcher.mockImplementationOnce(async () => {
      mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: 0, allowed_mime_types: null }, error: null })
      return new Response('hello', { headers: { 'content-type': 'text/plain' } })
    })
    expect((await get()).status).toBe(413)
    mocks.bucket.mockResolvedValue({ data: { public: true }, error: null })
    expect((await get()).status).toBe(503)
  })
  it('rejects oversized declared and streamed storage responses, with redirects disabled and no URL errors exposed', async () => {
    fetcher.mockResolvedValueOnce(new Response('x', { headers: { 'content-type': 'text/plain', 'content-length': String(MAX_BRIDGE_FILE_BYTES + 1) } }))
    expect((await get()).status).toBe(413)
    mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: 3, allowed_mime_types: ['text/plain'] }, error: null })
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.close() } }), { headers: { 'content-type': 'text/plain' } }))
    expect((await get()).status).toBe(413)
    fetcher.mockRejectedValueOnce(new Error('redirect to https://evil?token=secret'))
    const result = await get(); expect(result.status).toBe(503); expect(result.text).not.toContain('secret')
  })
  it('sets the bounded download timeout and reports aborts without URL details', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    fetcher.mockRejectedValueOnce(new Error('AbortError https://secret?token=hidden'))
    const result = await get()
    expect(result.status).toBe(503); expect(result.text).not.toContain('hidden')
    expect(timeout).toHaveBeenCalledWith(15_000)
  })
  it('refuses forged storage signing URLs and never fetches an external object', async () => {
    mocks.signed.mockResolvedValue({ data: { signedUrl: 'https://evil.invalid/storage/v1/object/sign/message_media/' + nativePath }, error: null })
    const result = await get(); expect(result.status).toBe(503); expect(fetcher).not.toHaveBeenCalled()
  })
})
