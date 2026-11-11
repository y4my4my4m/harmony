import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sign: vi.fn(),
  url: { value: 'http://127.0.0.1:1' },
}))

vi.mock('../../config/supabase.js', () => ({
  get supabaseUrl() {
    return mocks.url.value
  },
  supabaseServiceKey: 'service-key',
  supabase: {},
  config: {},
}))

vi.mock('../messageMedia.js', () => ({
  MESSAGE_MEDIA_BUCKET: 'message_media',
  signMessageMediaPaths: mocks.sign,
}))

import {
  GoneError,
  TooLargeError,
  discordLinkExpiresAt,
  isDiscordLinkExpired,
  mirrorFileToStorage,
  needsDiscordResign,
} from '../mirrorFile.js'

const CHANNEL = '00000000-0000-4000-8000-0000000000C1'
const BOT = '00000000-0000-4000-8000-0000000000b1'
const URL_OK = 'https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=6a000000&is=1&hm=2'
const MB = 1024 * 1024

function png(chunks: Array<[type: string, size: number]>): Uint8Array {
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  for (const [type, size] of chunks) {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(size, 0)
    head.write(type, 4, 'latin1')
    parts.push(head, Buffer.alloc(size), Buffer.alloc(4))
  }
  return new Uint8Array(Buffer.concat(parts))
}
const APNG = png([['IHDR', 13], ['acTL', 8], ['fcTL', 26], ['IDAT', 10], ['IEND', 0]])

let tmp: string

interface Recorded {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  bytes: number
}
const uploads: Recorded[] = []
type Reply = { status: number; body: string; headers?: Record<string, string>; reset?: boolean }
let reply: Reply = { status: 200, body: '{}' }
/** Replies used once each, in order, before `reply`. */
const replyQueue: Reply[] = []
let server: Server
const currentReply = () => reply

beforeAll(async () => {
  server = createServer((req, res) => {
    const rec: Recorded = { method: req.method, url: req.url, headers: req.headers, bytes: 0 }
    uploads.push(rec)
    req.on('data', (chunk: Buffer) => { rec.bytes += chunk.length })
    req.on('error', () => {})
    req.on('end', () => {
      const reply = replyQueue.shift() ?? currentReply()
      if (reply.reset) return void req.socket.destroy()
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers })
      res.end(reply.body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  mocks.url.value = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mirror-test-'))
  mocks.sign.mockReset()
  mocks.sign.mockImplementation(async (paths: string[]) => new Map(paths.map((p) => [p, `https://signed.test/${p}`])))
  uploads.length = 0
  replyQueue.length = 0
  reply = { status: 200, body: '{}' }
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

function serve(body: Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}, status = 200) {
  return vi.fn(async () => new Response(body as any, { status, headers }))
}

const base = { botId: BOT, channelId: CHANNEL, ceiling: 50 * MB }

describe('discord link expiry', () => {
  it('reads ex as hex Unix seconds', () => {
    expect(discordLinkExpiresAt('https://cdn.discordapp.com/a/b.png?ex=6a000000&is=1&hm=2')).toEqual(new Date(0x6a000000 * 1000))
    expect(discordLinkExpiresAt('https://cdn.discordapp.com/a/b.png')).toBeNull()
    expect(discordLinkExpiresAt('https://cdn.discordapp.com/a/b.png?ex=zzz')).toBeNull()
    expect(discordLinkExpiresAt('not a url')).toBeNull()
  })

  it('treats a link with under 10 minutes left, or none, as expired', () => {
    const now = Date.now()
    const at = (ms: number) => `https://cdn.discordapp.com/a/b.png?ex=${Math.floor((now + ms) / 1000).toString(16)}`
    expect(isDiscordLinkExpired(at(9 * 60_000), now)).toBe(true)
    expect(isDiscordLinkExpired(at(11 * 60_000), now)).toBe(false)
    expect(isDiscordLinkExpired(at(-60_000), now)).toBe(true)
  })

  it('does not treat a link without ex as expired', () => {
    expect(isDiscordLinkExpired('https://cdn.discordapp.com/a/b.png')).toBe(false)
  })

  it('needs a re-sign for an expired link or an unsigned attachment link only', () => {
    const now = Date.now()
    const ex = (ms: number) => Math.floor((now + ms) / 1000).toString(16)
    expect(needsDiscordResign(`https://cdn.discordapp.com/attachments/1/2/a.png?ex=${ex(-60_000)}`, now)).toBe(true)
    expect(needsDiscordResign(`https://cdn.discordapp.com/attachments/1/2/a.png?ex=${ex(86_400_000)}`, now)).toBe(false)
    expect(needsDiscordResign('https://cdn.discordapp.com/attachments/1/2/a.png', now)).toBe(true)
    expect(needsDiscordResign('https://media.discordapp.net/attachments/1/2/a.png?width=10', now)).toBe(true)
    expect(needsDiscordResign('https://cdn.discordapp.com/ephemeral-attachments/1/2/a.png', now)).toBe(true)
    expect(needsDiscordResign('https://images-ext-1.discordapp.net/external/x/https/example.com/a.png', now)).toBe(false)
    expect(needsDiscordResign('https://cdn.discordapp.com/emojis/1.png', now)).toBe(false)
    expect(needsDiscordResign('not a url', now)).toBe(false)
  })
})

describe('mirrorFileToStorage', () => {
  it('rejects a known size over the ceiling without fetching', async () => {
    const fetchImpl = serve(new Uint8Array(1))
    const err = await mirrorFileToStorage(URL_OK, { ...base, ceiling: 10, knownSize: 11, tmpDir: tmp, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(TooLargeError)
    expect(err.bytes).toBe(11)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a Content-Length over the ceiling without uploading', async () => {
    const fetchImpl = serve(new Uint8Array(20), { 'content-length': '20', 'content-type': 'video/mp4' })
    const err = await mirrorFileToStorage(URL_OK, { ...base, ceiling: 10, tmpDir: tmp, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(TooLargeError)
    expect(err.bytes).toBe(20)
    expect(uploads).toHaveLength(0)
    expect(await readdir(tmp)).toEqual([])
  })

  it('rejects a body that streams past the ceiling and removes the temp file', async () => {
    const body = Readable.toWeb(Readable.from([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)])) as ReadableStream<Uint8Array>
    const fetchImpl = serve(body, { 'content-type': 'video/mp4' })
    const err = await mirrorFileToStorage(URL_OK, { ...base, ceiling: 10, tmpDir: tmp, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(TooLargeError)
    expect(uploads).toHaveLength(0)
    expect(await readdir(tmp)).toEqual([])
  })

  it('maps 403, 404 and 410 to GoneError and other failures to a plain Error', async () => {
    for (const status of [403, 404, 410]) {
      await expect(mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: serve(new Uint8Array(0), {}, status) }))
        .rejects.toBeInstanceOf(GoneError)
    }
    const err = await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: serve(new Uint8Array(0), {}, 500) }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(GoneError)
    expect(err).not.toBeInstanceOf(TooLargeError)
    expect(await readdir(tmp)).toEqual([])
  })

  it('uploads a 3 MB video over http with the storage headers and leaves no temp files', async () => {
    const fetchImpl = serve(new Uint8Array(3 * MB), { 'content-type': 'video/mp4' })

    const out = await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl })

    expect(uploads).toHaveLength(1)
    const [rec] = uploads
    expect(rec.method).toBe('POST')
    expect(rec.url).toMatch(new RegExp(`^/storage/v1/object/message_media/c/${CHANNEL.toLowerCase()}/bridge/${BOT}/[0-9a-f-]{36}\\.mp4$`))
    expect(rec.headers).toMatchObject({
      authorization: 'Bearer service-key',
      apikey: 'service-key',
      'x-upsert': 'false',
      'content-type': 'video/mp4',
      'cache-control': 'max-age=31536000',
      'content-length': String(3 * MB),
    })
    expect(rec.bytes).toBe(3 * MB)
    const path = rec.url!.replace('/storage/v1/object/message_media/', '')
    expect(out).toEqual({ path, url: `https://signed.test/${path}`, contentType: 'video/mp4', bytes: 3 * MB })
    expect(await readdir(tmp)).toEqual([])
  })

  it('removes the temp file when the upload fails with a 500', async () => {
    reply = { status: 500, body: '{"message":"boom"}' }
    const err = await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: serve(new Uint8Array(100), { 'content-type': 'video/mp4' }) }).catch((e) => e)
    expect(err).not.toBeInstanceOf(TooLargeError)
    expect(err.message).toMatch(/^Storage upload failed: 500 .*boom/)
    expect(await readdir(tmp)).toEqual([])
  })

  it('stores a type the bucket refuses as application/octet-stream', async () => {
    replyQueue.push({
      status: 400,
      body: '{"statusCode":"415","error":"invalid_mime_type","message":"mime type text/markdown; charset=utf-8 is not supported","code":"InvalidMimeType"}',
    })
    const fetchImpl = serve(new Uint8Array(100), { 'content-type': 'text/markdown; charset=utf-8' })

    const out = await mirrorFileToStorage(URL_OK.replace('clip.mp4', 'notes.md'), { ...base, tmpDir: tmp, fileName: 'notes.md', fetchImpl })

    expect(uploads.map((u) => u.headers['content-type'])).toEqual(['text/markdown; charset=utf-8', 'application/octet-stream'])
    expect(uploads[0].url).toBe(uploads[1].url)
    expect(out.path).toMatch(/\.md$/)
    expect(out.contentType).toBe('application/octet-stream')
    expect(await readdir(tmp)).toEqual([])
  })

  it('does not retry when application/octet-stream itself is refused', async () => {
    reply = { status: 400, body: '{"statusCode":"415","error":"invalid_mime_type","code":"InvalidMimeType"}' }
    const err = await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, contentType: 'application/octet-stream', fetchImpl: serve(new Uint8Array(100)) }).catch((e) => e)
    expect(err.message).toMatch(/^Storage upload failed: 400 .*InvalidMimeType/)
    expect(uploads).toHaveLength(1)
  })

  it('maps a storage 413 to TooLargeError with the file size', async () => {
    reply = { status: 413, body: '{"message":"The object exceeded the maximum allowed size"}' }
    const err = await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: serve(new Uint8Array(100), { 'content-type': 'video/mp4' }) }).catch((e) => e)
    expect(err).toBeInstanceOf(TooLargeError)
    expect(err.bytes).toBe(100)
    expect(await readdir(tmp)).toEqual([])
  })

  it('maps an HTML 413 from the proxy to TooLargeError but an HTML 502 to a plain Error', async () => {
    const run = () => mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: serve(new Uint8Array(100), { 'content-type': 'video/mp4' }) }).catch((e) => e)
    reply = { status: 413, body: '<html><h1>413 Request Entity Too Large</h1></html>', headers: { 'content-type': 'text/html' } }
    expect(await run()).toBeInstanceOf(TooLargeError)

    reply = { status: 502, body: '<html><h1>502 Bad Gateway: payload exceeded</h1></html>', headers: { 'content-type': 'text/html' } }
    const err = await run()
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(TooLargeError)
    expect(err.message).toMatch(/^Storage upload failed: 502 /)
    expect(await readdir(tmp)).toEqual([])
  })

  it('maps a connection reset without a response to a plain Error', async () => {
    reply = { status: 200, body: '', reset: true }
    const err = await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: serve(new Uint8Array(100), { 'content-type': 'video/mp4' }) }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(TooLargeError)
    expect(err.message).toMatch(/^Storage upload failed: /)
    expect(await readdir(tmp)).toEqual([])
  })

  it('refuses a download that redirected off Discord and cancels the body', async () => {
    const cancel = vi.fn(async () => {})
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(4)) }, cancel })
    const fetchImpl = vi.fn(async () => {
      const response = new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } })
      Object.defineProperty(response, 'url', { value: 'https://evil.example/x.mp4' })
      return response
    })
    await expect(mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl })).rejects.toThrow(/redirected off Discord/)
    expect(cancel).toHaveBeenCalled()
    expect(uploads).toHaveLength(0)
    expect(await readdir(tmp)).toEqual([])
  })

  it('stores an animated PNG as .apng', async () => {
    const out = await mirrorFileToStorage('https://media.discordapp.net/stickers/1.png', {
      ...base, tmpDir: tmp, fetchImpl: serve(APNG, { 'content-type': 'image/png' }),
    })
    expect(out.contentType).toBe('image/apng')
    expect(out.path).toMatch(/\.apng$/)
    expect(uploads[0].headers['content-type']).toBe('image/apng')
  })

  it('rejects a disallowed host before fetching', async () => {
    const fetchImpl = serve(new Uint8Array(1))
    await expect(mirrorFileToStorage('https://evil.example/a.png', { ...base, tmpDir: tmp, fetchImpl })).rejects.toThrow(/disallowed/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  describe('target bucket', () => {
    const AVATAR = 'https://cdn.discordapp.com/avatars/1/abc.png?size=512'
    const pngBytes = png([['IHDR', 13], ['IDAT', 10], ['IEND', 0]])
    const image = () => serve(pngBytes, { 'content-type': 'image/png' })

    it('uploads to the target bucket as <folder>/<stem>-<ms>.<ext>, outside any channel room', async () => {
      const before = Date.now()
      const out = await mirrorFileToStorage(AVATAR, {
        ceiling: 50 * MB, tmpDir: tmp, fetchImpl: image(),
        target: { bucket: 'avatars', folder: 'user-1', stem: 'avatar' },
      })
      const after = Date.now()
      expect(uploads).toHaveLength(1)
      const m = /^\/storage\/v1\/object\/avatars\/user-1\/avatar-(\d+)\.png$/.exec(uploads[0].url ?? '')
      expect(m).not.toBeNull()
      expect(Number(m![1])).toBeGreaterThanOrEqual(before)
      expect(Number(m![1])).toBeLessThanOrEqual(after)
      expect(uploads[0].url).not.toContain('message_media')
      expect(uploads[0].url).not.toContain('/bridge/')
      expect(uploads[0].headers).toMatchObject({ 'x-upsert': 'false', 'cache-control': 'max-age=31536000' })
      expect(out.path).toBe(`user-1/avatar-${m![1]}.png`)
      expect(out.url).toBe('')
      expect(mocks.sign).not.toHaveBeenCalled()
      expect(await readdir(tmp)).toEqual([])
    })

    it('requires botId and channelId without a target', async () => {
      await expect(mirrorFileToStorage(AVATAR, { ceiling: 50 * MB, tmpDir: tmp, fetchImpl: image() }))
        .rejects.toThrow(/botId and channelId are required/)
      expect(uploads).toHaveLength(0)
    })

    it('without a target still stores in the channel room and signs the path', async () => {
      const out = await mirrorFileToStorage(AVATAR, { ...base, tmpDir: tmp, fetchImpl: image() })
      expect(uploads[0].url).toMatch(
        new RegExp(`^/storage/v1/object/message_media/c/${CHANNEL.toLowerCase()}/bridge/${BOT}/[0-9a-f-]{36}\\.png$`),
      )
      expect(out.url).toBe(`https://signed.test/${out.path}`)
    })
  })
})
