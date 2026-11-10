import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import supertest from 'supertest'
import { FakeDb } from '../../__tests__/fakeSupabase.js'

const BOT = '00000000-0000-0000-0000-0000000000b0', OTHER_BOT = '00000000-0000-0000-0000-0000000000b2'
const CHANNEL = '00000000-0000-0000-0000-0000000000c1', OTHER_CHANNEL = '00000000-0000-0000-0000-0000000000c2'
const SERVER = '00000000-0000-0000-0000-00000000005a', USER = '00000000-0000-0000-0000-0000000000a1', MESSAGE = '00000000-0000-0000-0000-0000000000f1'
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), upload: vi.fn(), signed: vi.fn(), bucket: vi.fn(), rate: vi.fn() }))
vi.mock('../../config/supabase.js', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc, storage: { getBucket: mocks.bucket, from: () => ({ upload: mocks.upload, createSignedUrl: mocks.signed }) } }, config: {} }))
vi.mock('../../auth/BotAuthMiddleware.js', () => ({
  botAuthMiddleware: (req: any, res: any, next: any) => { if (req.headers.authorization !== 'Bearer test') return res.status(401).json({ error: 'Unauthorized' }); req.bot = { id: BOT, username: 'matrix', scopes: ['bot'] }; next() },
  botRateLimit: (req: any, res: any, next: any) => { mocks.rate(); if (req.headers['x-rate-test']) return res.status(429).json({ error: 'Rate limited' }); next() },
}))
import { BotRestAPI } from '../BotRestAPI.js'
import { MAX_BRIDGE_FILE_BYTES } from '../../utils/bridgeFiles.js'

const nativePath = `c/${CHANNEL}/${USER}/native.txt`, drivePath = `u/${USER}/drive.txt`
const native = { type: 'file', path: nativePath, url: 'https://evil.invalid/do-not-fetch?token=secret', fileName: 'hello world.txt', fileType: 'file', mimeType: 'text/plain', fileSize: 5 }
const base = `/api/v1/channels/${CHANNEL}`, getPath = `${base}/messages/${MESSAGE}/bridge-files/2`
const objects = new Map<string, { bytes: Buffer; mime: string }>()
let db: FakeDb, platform: string | null, encrypted: unknown, room: unknown, visible: string[], driveOwner: unknown
const fetcher = vi.fn()
function app() { const a = express(); a.use(express.json({ limit: '10mb' })); a.use('/api/v1', new BotRestAPI().router); return a }
function upload(bytes = Buffer.from('hello'), name = 'hello world.txt', type = 'text/plain') {
  return supertest(app()).post(base + '/bridge-files').set('Authorization', 'Bearer test').set('Content-Type', 'application/octet-stream').set('X-File-Name', encodeURIComponent(name)).set('X-File-Type', type).send(bytes)
}
function get(path = getPath) { return supertest(app()).get(path).set('Authorization', 'Bearer test') }
function post(content: any[], metadata?: any) { return supertest(app()).post(base + '/messages').set('Authorization', 'Bearer test').send({ content, metadata }) }
function fixture(name: string) { return readFileSync(resolve(__dirname, '../../../../tests/fixtures/media-metadata', name)) }
beforeEach(() => {
  vi.clearAllMocks(); platform = 'matrix'; encrypted = false; visible = [MESSAGE]; room = { room_id: '!room:hs', sender_mode: 'ghost' }; driveOwner = true
  vi.stubEnv('SUPABASE_URL', 'https://storage.harmony.test'); vi.stubEnv('PUBLIC_URL', 'https://harmony.test')
  objects.clear(); objects.set(nativePath, { bytes: Buffer.from('hello'), mime: 'text/plain' }); objects.set(drivePath, { bytes: Buffer.from('drive'), mime: 'text/plain' })
  db = new FakeDb({
    bots: [{ id: BOT, bot_type: 'bridge', bridge_platform: 'matrix' }], servers: [{ id: SERVER, owner: USER }], channels: [{ id: CHANNEL, server_id: SERVER }],
    server_roles: [{ id: 'everyone', server_id: SERVER, is_default: true, position: 0, permissions: 122646786 }],
    bot_server_permissions: [{ bot_id: BOT, server_id: SERVER, is_active: true, read_messages: true, send_messages: true, installed_at: '2026-01-01T00:00:00Z' }],
    bridge_channels: [{ bot_id: BOT, channel_id: CHANNEL, platform: 'matrix' }],
    messages: [{ id: MESSAGE, channel_id: CHANNEL, user_id: USER, bot_id: null, is_deleted: false, encrypted: false, content: [{ type: 'text', text: 'first' }, { type: 'file', url: 'https://evil.invalid/private' }, { ...native }], metadata: {}, created_at: '2026-11-01T00:00:00Z' }],
  })
  mocks.from.mockImplementation(table => db.from(table))
  mocks.rpc.mockImplementation(async (fn, args) => {
    if (fn === 'bridge_channel_platform') return { data: platform, error: null }
    if (fn === 'matrix_bridge_room') return { data: room, error: null }
    if (fn === 'channel_messages_encrypted') return { data: encrypted, error: null }
    if (fn === 'bridge_visible_message_ids') return { data: visible, error: null }
    if (fn === 'drive_file_owned_by') return { data: driveOwner === 'other' ? args.p_profile !== USER : driveOwner, error: null }
    if (fn === 'get_instance_config') return { data: null, error: null }
    throw new Error('Unmocked RPC ' + fn)
  })
  mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: MAX_BRIDGE_FILE_BYTES, allowed_mime_types: null }, error: null })
  mocks.upload.mockImplementation(async (path, bytes, options) => { objects.set(path, { bytes: Buffer.from(bytes), mime: options.contentType }); return { error: null } })
  mocks.signed.mockImplementation(async path => ({ data: { signedUrl: 'https://storage.harmony.test/storage/v1/object/sign/message_media/' + path + '?token=private' }, error: null }))
  fetcher.mockImplementation(async (url: string) => {
    const path = decodeURIComponent(new URL(url).pathname.split('/message_media/')[1] || '')
    const object = objects.get(path)
    return object ? new Response(object.bytes, { headers: { 'content-type': object.mime, 'content-length': String(object.bytes.length) } }) : new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('Matrix bridge file transfer boundary', () => {
  it('authenticates and rate limits before parsing raw uploads or fetching bytes', async () => {
    expect((await supertest(app()).post(base + '/bridge-files').set('Content-Type', 'application/octet-stream').send(Buffer.from('x'))).status).toBe(401)
    expect((await supertest(app()).get(getPath)).status).toBe(401)
    expect((await get().set('X-Rate-Test', 'yes')).status).toBe(429)
    expect((await upload().set('X-Rate-Test', 'yes')).status).toBe(429)
    expect(mocks.upload).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['ordinary', 'discord', 'unpaired', 'read', 'send', 'room', 'encrypted', 'unknown-encryption'])('rejects %s access for both directions', async kind => {
    if (kind === 'ordinary') { db.rows('bots')[0].bot_type = 'bot'; db.rows('bots')[0].bridge_platform = null; platform = null }
    if (kind === 'discord') platform = 'discord'
    if (kind === 'unpaired') platform = null
    if (kind === 'read') db.rows('bot_server_permissions')[0].read_messages = false
    if (kind === 'send') db.rows('bot_server_permissions')[0].send_messages = false
    if (kind === 'room') room = null
    if (kind === 'encrypted') encrypted = true
    if (kind === 'unknown-encryption') encrypted = null
    expect([403, 503]).toContain((await upload()).status)
    expect([403, 503]).toContain((await get()).status)
    expect(mocks.upload).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('returns canonical private file fields, content-addresses metadata, and round-trips through Matrix create', async () => {
    const result = await upload()
    expect(result.status).toBe(201)
    const part = result.body
    expect(part).toMatchObject({ type: 'file', fileName: 'hello world.txt', fileType: 'file', fileSize: 5, mimeType: 'text/plain' })
    expect(part.path).toMatch(new RegExp(`^c/${CHANNEL}/bridge/${BOT}/[a-f0-9]{64}\\.txt$`))
    expect(part.url).toContain('https://harmony.test/storage/v1/object/sign/message_media/')
    const sent = await post([{ ...part, url: 'https://evil.invalid/never-follow', keyToDiscard: 'extra' }])
    expect(sent.status).toBe(201)
    expect(db.rows('messages').at(-1)!.content[0]).toEqual(part)
    expect(fetcher.mock.calls.every(([url]) => new URL(url).hostname === 'storage.harmony.test')).toBe(true)
  })
  it('supports zero-byte ordinary files and audio/video as files, not inline media', async () => {
    const empty = await upload(Buffer.alloc(0), 'empty.bin', 'application/octet-stream')
    expect(empty.status).toBe(201); expect(empty.body.fileSize).toBe(0)
    expect((await post([empty.body])).status).toBe(201)
    for (const [name, type, bytes] of [['sound.ogg', 'audio/ogg', Buffer.from('OggSdata')], ['clip.mp4', 'video/mp4', fixture('gps.mp4')]] as const) {
      const r = await upload(bytes, name, type)
      expect(r.status).toBe(201); expect(r.body.fileType).toBe('file')
    }
  })
  it('strips house photo metadata before storage, hashing, posting and native download', async () => {
    const image = fixture('gps.png'), response = await upload(image, 'photo.png', 'image/png')
    expect(response.status).toBe(201); expect(response.body.fileType).toBe('image')
    const stored = objects.get(response.body.path)!.bytes
    expect(stored.length).toBeLessThan(image.length); expect(stored.toString('latin1')).not.toContain('HarmonyCam')
    expect(response.body.fileSize).toBe(stored.length)
    expect((await post([response.body])).status).toBe(201)
    objects.set(nativePath, { bytes: image, mime: 'image/png' }); db.rows('messages')[0].content[2].fileName = 'photo.png'
    const downloaded = await get()
    expect(downloaded.status).toBe(200); expect(downloaded.body).toEqual(stored)
    expect(downloaded.headers['x-file-type']).toBe('image/png')
  })
  it.each([
    ['x.svg', 'image/svg+xml', '<svg/>'], ['x.html', 'text/html', '<html/>'], ['x.js', 'application/javascript', 'alert(1)'],
    ['x.bin', 'application/octet-stream', '<?xml version="1.0"?><svg/>'], ['x.bin', 'application/octet-stream', '<script>alert(1)</script>'],
    ['x.png', 'image/png', '<html>fake</html>'], ['x.jpg', 'image/jpeg', 'not jpeg'], ['x.png', 'image/png', ''],
    ['x.exe', 'application/octet-stream', 'MZexecutable'], ['x.txt', 'text/plain', '#!/bin/sh'],
  ])('rejects active content or spoofed image %s / %s', async (name, type, body) => {
    expect((await upload(Buffer.from(body), name, type)).status).toBe(415)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('keeps raw parsing local, rejects JSON and compressed requests and enforces the hard size limit', async () => {
    expect((await supertest(app()).post(base + '/bridge-files').set('Authorization', 'Bearer test').send({ data: 'base64' })).status).toBe(415)
    expect((await upload().set('Content-Encoding', 'gzip')).status).toBe(415)
    expect((await upload(Buffer.alloc(MAX_BRIDGE_FILE_BYTES + 1), 'large.bin', 'application/octet-stream')).status).toBe(413)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it('applies live private bucket size and wildcard MIME restrictions, including policy lookup failures', async () => {
    mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: 4, allowed_mime_types: ['text/*'] }, error: null })
    expect((await upload()).status).toBe(413)
    expect((await upload(Buffer.from('x'), 'file.bin', 'application/octet-stream')).status).toBe(415)
    expect((await upload(Buffer.from('x'))).status).toBe(201)
    mocks.bucket.mockResolvedValue({ data: { public: true }, error: null })
    expect((await upload()).status).toBe(503)
    mocks.bucket.mockResolvedValue({ data: null, error: { message: 'https://secret?token=hidden' } })
    const r = await upload(); expect(r.status).toBe(503); expect(r.text).not.toContain('secret')
  })
  it('treats a live zero-byte limit as zero, while null uses the hard fallback', async () => {
    mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: 0, allowed_mime_types: null }, error: null })
    expect((await upload()).status).toBe(413)
    expect((await upload(Buffer.alloc(0), 'empty.bin', 'application/octet-stream')).status).toBe(201)
    expect((await get()).status).toBe(413)
    mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: null, allowed_mime_types: null }, error: null })
    expect((await upload()).status).toBe(201)
  })
  it.each(['application/json', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.oasis.opendocument.presentation'])('supports inert document MIME %s when the bucket permits it', async type => {
    const result = await upload(Buffer.from('ordinary data'), 'data.bin', type)
    expect(result.status).toBe(201); expect(result.body.mimeType).toBe(type); expect(result.body.fileType).toBe('file')
  })
  it('checks plaintext again after raw body parsing, before any storage write', async () => {
    const original = mocks.rpc.getMockImplementation()!
    let checks = 0
    mocks.rpc.mockImplementation((fn, args) => fn === 'channel_messages_encrypted' ? { data: ++checks > 1, error: null } : original(fn, args))
    expect((await upload()).status).toBe(403)
    expect(mocks.upload).not.toHaveBeenCalled()
  })
  it.each(['encryption', 'unpair', 'mime-policy'])('checks %s after canonical object download and before message insert', async change => {
    const part = (await upload()).body
    fetcher.mockImplementationOnce(async () => {
      if (change === 'encryption') encrypted = true
      if (change === 'unpair') platform = null
      if (change === 'mime-policy') mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: MAX_BRIDGE_FILE_BYTES, allowed_mime_types: ['application/json'] }, error: null })
      return new Response('hello', { headers: { 'content-type': 'text/plain' } })
    })
    expect([403, 415]).toContain((await post([part])).status)
    expect(db.writesTo('messages', 'insert')).toHaveLength(0)
  })
  it('rejects more than twenty canonical files or a declared combined size over 50 MiB before fetching', async () => {
    const part = (await upload()).body
    fetcher.mockClear()
    expect((await post(Array.from({ length: 21 }, () => part))).status).toBe(413)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await post([{ ...part, fileSize: MAX_BRIDGE_FILE_BYTES }, { ...part, fileSize: 1 }])).status).toBe(413)
    expect(fetcher).not.toHaveBeenCalled()
    expect(db.writesTo('messages', 'insert')).toHaveLength(0)
  })
  it('caps the next object read by the remaining actual-byte budget, not its claimed fileSize', async () => {
    const large = Buffer.alloc(MAX_BRIDGE_FILE_BYTES / 2 + 1)
    const first = (await upload(large, 'first.bin', 'application/octet-stream')).body
    const second = (await upload(Buffer.alloc(0), 'second.bin', 'application/octet-stream')).body
    objects.set(second.path, { bytes: large, mime: 'application/octet-stream' })
    fetcher.mockClear()
    expect((await post([first, second])).status).toBe(413)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(db.writesTo('messages', 'insert')).toHaveLength(0)
  })
  it('detects stored byte tampering rather than trusting an uploaded namespace alone', async () => {
    const part = (await upload()).body
    objects.set(part.path, { bytes: Buffer.from('HELLO'), mime: 'text/plain' })
    expect((await post([part])).status).toBe(400)
    expect(db.writesTo('messages', 'insert')).toHaveLength(0)
  })
  it.each(['crossbot', 'crosschannel', 'traversal', 'absolute', 'metadata-name', 'metadata-size', 'metadata-type', 'encrypted'])('rejects Matrix create path/metadata forgery %s', async kind => {
    const part = (await upload()).body
    if (kind === 'crossbot') part.path = part.path.replace(BOT, OTHER_BOT)
    if (kind === 'crosschannel') part.path = part.path.replace(CHANNEL, OTHER_CHANNEL)
    if (kind === 'traversal') part.path = `c/${CHANNEL}/bridge/${BOT}/../secret.txt`
    if (kind === 'absolute') part.path = 'https://evil.invalid/private'
    if (kind === 'metadata-name') part.fileName = 'different.txt'
    if (kind === 'metadata-size') part.fileSize++
    if (kind === 'metadata-type') part.fileType = 'image'
    if (kind === 'encrypted') part.key = { k: 'secret' }
    fetcher.mockClear()
    expect((await post([part])).status).toBe(400)
    expect(db.writesTo('messages', 'insert')).toHaveLength(0)
    if (['crossbot', 'crosschannel', 'traversal', 'absolute', 'encrypted'].includes(kind)) expect(fetcher).not.toHaveBeenCalled()
  })
  it('leaves ordinary and Discord path stripping unchanged, and never preserves paths on edits', async () => {
    const part = (await upload()).body
    db.rows('bots')[0].bridge_platform = null; platform = null
    expect((await post([part])).status).toBe(201)
    expect(db.rows('messages').at(-1)!.content[0]).not.toHaveProperty('path')
    platform = 'discord'
    expect((await post([part])).status).toBe(201)
    expect(db.rows('messages').at(-1)!.content[0]).not.toHaveProperty('path')
    platform = 'matrix'; db.rows('bots')[0].bridge_platform = 'matrix'; db.rows('messages')[0].bot_id = BOT
    expect((await supertest(app()).patch('/api/v1/messages/' + MESSAGE).set('Authorization', 'Bearer test').send({ content: [part] })).status).toBe(200)
    expect(db.rows('messages')[0].content[0]).not.toHaveProperty('path')
  })
  it('serves the raw content index with headers and fetches only a newly signed own-storage object', async () => {
    const result = await get(getPath + '?url=http://127.0.0.1/private&path=c/other/secret')
    expect(result.status).toBe(200); expect(result.body).toEqual(Buffer.from('hello'))
    expect(result.headers).toMatchObject({ 'x-file-name': 'hello%20world.txt', 'x-file-type': 'text/plain', 'content-length': '5', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/message_media/' + nativePath), { redirect: 'error', signal: expect.any(AbortSignal) })
    expect((await get(getPath.replace('/2', '/0'))).status).toBe(422)
    expect((await get(getPath.replace('/2', '/1'))).status).toBe(422)
    expect((await get(getPath.replace('/2', '/01'))).status).toBe(400)
  })
  it.each(['optout', 'deleted', 'other-channel', 'encrypted-message', 'encryption-metadata', 'encrypted-file', 'outside-path', 'traversal'])('blocks native %s before storage access', async kind => {
    const message = db.rows('messages')[0]
    if (kind === 'optout') visible = []
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
  it('enforces READ_MESSAGE_HISTORY floors', async () => {
    db.rows('channel_permission_overrides').push({ id: 'history', channel_id: CHANNEL, target_type: 'role', role_id: 'everyone', allow_permissions: 0, deny_permissions: 4194304 })
    db.rows('bot_server_permissions')[0].installed_at = '2026-12-01T00:00:00Z'
    expect((await get()).status).toBe(404); expect(fetcher).not.toHaveBeenCalled()
  })
  it.each(['optout', 'unpair', 'encrypt', 'delete', 'edit'])('rechecks native %s after downloading and before emitting bytes', async kind => {
    fetcher.mockImplementationOnce(async () => {
      if (kind === 'optout') visible = []
      if (kind === 'unpair') platform = null
      if (kind === 'encrypt') encrypted = true
      if (kind === 'delete') db.rows('messages')[0].is_deleted = true
      if (kind === 'edit') db.rows('messages')[0].content[2].path = `c/${CHANNEL}/${USER}/new.txt`
      return new Response('hello', { headers: { 'content-type': 'text/plain' } })
    })
    const result = await get()
    expect([403, 404, 409]).toContain(result.status)
    expect(result.body).not.toEqual(Buffer.from('hello'))
  })
  it('checks native Drive live ownership before download and again before emit', async () => {
    db.rows('messages')[0].content[2].path = drivePath
    expect((await get()).status).toBe(200)
    expect(mocks.rpc.mock.calls.filter(([fn]) => fn === 'drive_file_owned_by')).toEqual([
      ['drive_file_owned_by', { p_path: drivePath, p_profile: USER }], ['drive_file_owned_by', { p_path: drivePath, p_profile: USER }],
    ])
    driveOwner = false; fetcher.mockClear()
    expect((await get()).status).toBe(404); expect(fetcher).not.toHaveBeenCalled()
    driveOwner = 'other'
    expect((await get()).status).toBe(404); expect(fetcher).not.toHaveBeenCalled()
    driveOwner = null
    expect((await get()).status).toBe(503); expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not emit Drive bytes after ownership is revoked in flight', async () => {
    db.rows('messages')[0].content[2].path = drivePath
    fetcher.mockImplementationOnce(async () => { driveOwner = false; return new Response('drive', { headers: { 'content-type': 'text/plain' } }) })
    expect((await get()).status).toBe(404)
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
  it('applies a newly lowered bucket size policy after native bytes download', async () => {
    fetcher.mockImplementationOnce(async () => {
      mocks.bucket.mockResolvedValue({ data: { public: false, file_size_limit: 0, allowed_mime_types: null }, error: null })
      return new Response('hello', { headers: { 'content-type': 'text/plain' } })
    })
    expect((await get()).status).toBe(413)
  })
  it('sets the bounded download timeout and reports aborts without URL details', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    fetcher.mockRejectedValueOnce(new Error('AbortError https://secret?token=hidden'))
    const result = await get()
    expect(result.status).toBe(503); expect(result.text).not.toContain('hidden')
    expect(timeout).toHaveBeenCalledWith(15_000)
    timeout.mockRestore()
  })
  it('refuses forged storage signing URLs and never fetches an external object', async () => {
    mocks.signed.mockResolvedValue({ data: { signedUrl: 'https://evil.invalid/storage/v1/object/sign/message_media/' + nativePath }, error: null })
    const result = await get(); expect(result.status).toBe(503); expect(fetcher).not.toHaveBeenCalled()
  })
})
