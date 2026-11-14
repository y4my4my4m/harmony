import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sign: vi.fn(),
  rpc: vi.fn(),
  remove: vi.fn(),
  bucket: vi.fn(),
  allows: vi.fn(),
  stripBytes: vi.fn(),
  url: { value: 'http://127.0.0.1:1' },
}))

vi.mock('../../config/supabase.js', () => ({
  get supabaseUrl() {
    return mocks.url.value
  },
  supabaseServiceKey: 'service-key',
  supabase: {
    rpc: mocks.rpc,
    storage: {
      from: (bucket: string) => {
        mocks.bucket(bucket)
        return { remove: mocks.remove }
      },
    },
  },
  config: {},
}))

vi.mock('../messageMedia.js', () => ({
  MESSAGE_MEDIA_BUCKET: 'message_media',
  signMessageMediaPaths: mocks.sign,
}))

// stripMediaBytes is the in-memory raster stripper; the spy records what reaches it.
vi.mock('../stripMetadata.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stripMetadata.js')>()
  mocks.stripBytes.mockImplementation(actual.stripMediaBytes)
  return { ...actual, stripMediaBytes: mocks.stripBytes }
})

import {
  GoneError,
  OverQuotaError,
  TooLargeError,
  discordLinkExpiresAt,
  isDiscordLinkExpired,
  mirrorFileToStorage,
  needsDiscordResign,
  storedTypeOf,
} from '../mirrorFile.js'

const CHANNEL = '00000000-0000-4000-8000-0000000000C1'
const BOT = '00000000-0000-4000-8000-0000000000b1'
const URL_OK = 'https://cdn.discordapp.com/attachments/1/2/clip.mp4?ex=6a000000&is=1&hm=2'
const MB = 1024 * 1024
const FIXTURES = resolve(__dirname, '../../../../tests/fixtures/media-metadata')
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(FIXTURES, name)))
const MARKERS = ['HarmonyCam', 'GPSLatitude', '+35.6762', 'Tokyo', 'fixture comment', 'TRAILER', 'ISO6709']
const markersIn = (bytes: Uint8Array) => MARKERS.filter((m) => Buffer.from(bytes).toString('latin1').includes(m))

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
  body: Buffer
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
    const rec: Recorded = { method: req.method, url: req.url, headers: req.headers, bytes: 0, body: Buffer.alloc(0) }
    uploads.push(rec)
    // Bodies up to 1 MB are kept for the tests that read what was stored.
    req.on('data', (chunk: Buffer) => {
      rec.bytes += chunk.length
      if (rec.bytes <= MB) rec.body = Buffer.concat([rec.body, chunk])
    })
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
  mocks.rpc.mockReset()
  mocks.rpc.mockResolvedValue({ data: true, error: null })
  mocks.remove.mockReset()
  mocks.remove.mockImplementation(async (paths: string[]) => ({ data: paths.map((name) => ({ name })), error: null }))
  mocks.bucket.mockReset()
  mocks.allows.mockReset()
  mocks.allows.mockResolvedValue(true)
  mocks.stripBytes.mockClear()
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

const base = { botId: BOT, channelId: CHANNEL, ceiling: 50 * MB, allows: mocks.allows }

/**
 * A fetch over a fixed set of URLs. Like fetch, it follows a Location itself unless called with
 * redirect: 'manual'. `requested` lists every URL a request went to.
 */
function network(routes: Record<string, () => Response>) {
  const requested: string[] = []
  const fetchImpl = vi.fn(async (input: any, init?: RequestInit) => {
    let url = String(input)
    for (;;) {
      requested.push(url)
      const response = routes[url]?.() ?? new Response('not found', { status: 404 })
      const location = response.headers.get('location')
      if (init?.redirect === 'manual' || !location || response.status < 300 || response.status > 399) return response
      url = new URL(location, url).href
    }
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls: fetchImpl.mock.calls, requested }
}
const redirect = (location: string, status = 302) => () => new Response(null, { status, headers: { location } })
const video = () => new Response(new Uint8Array(100), { status: 200, headers: { 'content-type': 'video/mp4' } })

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

  it('rejects a scheme other than http and https on a Discord host before fetching', async () => {
    const fetchImpl = serve(new Uint8Array(1))
    for (const url of ['ftp://cdn.discordapp.com/a.png', 'file://cdn.discordapp.com/etc/passwd']) {
      await expect(mirrorFileToStorage(url, { ...base, tmpDir: tmp, fetchImpl })).rejects.toThrow(/disallowed/)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('mirrorFileToStorage redirects', () => {
  it.each([
    'https://evil.example/x.mp4',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:8000/storage/v1/object/message_media/x',
    'https://cdn.discordapp.com.evil.example/x.mp4',
    'https://evil.example/?https://cdn.discordapp.com/x.mp4',
    'ftp://cdn.discordapp.com/x.mp4',
  ])('never requests %s when a Discord URL redirects there', async (target) => {
    const net = network({ [URL_OK]: redirect(target), [new URL(target).href]: video })
    await expect(mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: net.fetchImpl })).rejects.toThrow(/redirected off Discord/)
    expect(net.requested).toEqual([URL_OK])
    expect(uploads).toHaveLength(0)
    expect(await readdir(tmp)).toEqual([])
  })

  it('never requests an outside host reached through a second Discord host', async () => {
    const second = 'https://media.discordapp.net/attachments/1/2/clip.mp4'
    const net = network({ [URL_OK]: redirect(second, 301), [second]: redirect('https://evil.example/x.mp4', 307), 'https://evil.example/x.mp4': video })
    await expect(mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: net.fetchImpl })).rejects.toThrow(/redirected off Discord/)
    expect(net.requested).toEqual([URL_OK, second])
    expect(uploads).toHaveLength(0)
  })

  it('follows a redirect to another Discord host, each hop requested with redirect: manual', async () => {
    const second = 'https://media.discordapp.net/attachments/1/2/clip.mp4'
    const net = network({ [URL_OK]: redirect(second, 301), [second]: video })
    const out = await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: net.fetchImpl })
    expect(net.requested).toEqual([URL_OK, second])
    expect(net.calls.map((call) => call[1])).toEqual([{ redirect: 'manual' }, { redirect: 'manual' }])
    expect(uploads).toHaveLength(1)
    expect(out.bytes).toBe(100)
  })

  it('resolves a relative Location against the hop it came from', async () => {
    const moved = 'https://cdn.discordapp.com/attachments/9/9/moved.mp4'
    const net = network({ [URL_OK]: redirect('/attachments/9/9/moved.mp4', 308), [moved]: video })
    await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: net.fetchImpl })
    expect(net.requested).toEqual([URL_OK, moved])
  })

  it('follows 3 redirects and refuses a 4th', async () => {
    const hop = (n: number) => `https://cdn.discordapp.com/attachments/1/2/hop${n}.mp4`
    const chain = (length: number) => Object.fromEntries([
      [URL_OK, redirect(hop(1))],
      ...Array.from({ length: length - 1 }, (_, i) => [hop(i + 1), redirect(hop(i + 2))]),
      [hop(length), video],
    ])
    const three = network(chain(3))
    await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: three.fetchImpl })
    expect(three.requested).toEqual([URL_OK, hop(1), hop(2), hop(3)])

    const four = network(chain(4))
    await expect(mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: four.fetchImpl })).rejects.toThrow(/too many times/)
    expect(four.requested).toEqual([URL_OK, hop(1), hop(2), hop(3)])
    expect(uploads).toHaveLength(1)
  })

  it('refuses a redirect without a Location', async () => {
    const net = network({ [URL_OK]: () => new Response(null, { status: 302 }) })
    await expect(mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: net.fetchImpl })).rejects.toThrow(/without a Location \(302\)/)
    expect(uploads).toHaveLength(0)
  })
})

describe('mirrorFileToStorage sniffs the leading bytes', () => {
  const photo = (name: string) => `https://cdn.discordapp.com/attachments/1/2/${name}?ex=6a000000&is=1&hm=2`
  const run = (name: string, bytes: Uint8Array, contentType: string, fileName = name) =>
    mirrorFileToStorage(photo(name), { ...base, tmpDir: tmp, fileName, fetchImpl: serve(bytes, { 'content-type': contentType }) })

  it('strips a JPEG declared as application/octet-stream and stores it as image/jpeg', async () => {
    const original = fixture('gps-rotated.jpg')
    expect(markersIn(original)).not.toEqual([])
    const out = await run('data.bin', original, 'application/octet-stream')
    expect(markersIn(uploads[0].body)).toEqual([])
    expect(uploads[0].body.length).toBeLessThan(original.length)
    expect(uploads[0].headers['content-type']).toBe('image/jpeg')
    expect(out.contentType).toBe('image/jpeg')
    expect(out.path).toMatch(/\.jpg$/)
    expect(out.bytes).toBe(uploads[0].body.length)
  })

  it('strips a JPEG whose part declares no type and whose response says text/plain', async () => {
    await run('notes.txt', fixture('gps-upright.jpg'), 'text/plain')
    expect(markersIn(uploads[0].body)).toEqual([])
    expect(uploads[0].headers['content-type']).toBe('image/jpeg')
  })

  it('strips a WebP declared as video/mp4 and stores it as image/webp', async () => {
    const out = await run('clip.mp4', fixture('gps.webp'), 'video/mp4')
    expect(markersIn(uploads[0].body)).toEqual([])
    expect(uploads[0].headers['content-type']).toBe('image/webp')
    expect(out.path).toMatch(/\.webp$/)
  })

  it('stores a GIF named .png as image/gif', async () => {
    const out = await run('sticker.png', fixture('anim.gif'), 'image/png')
    expect(markersIn(uploads[0].body)).toEqual([])
    expect(out.contentType).toBe('image/gif')
    expect(out.path).toMatch(/\.gif$/)
  })

  it('keeps the extension of a JPEG that goes by .jpeg', async () => {
    const out = await run('photo.jpeg', fixture('gps-upright.jpg'), 'image/jpeg')
    expect(out.path).toMatch(/\.jpeg$/)
  })

  it('strips an MP4 declared as image/png on disk, never in memory, and stores it as a download', async () => {
    const original = fixture('gps.mp4')
    expect(markersIn(original)).not.toEqual([])
    const out = await run('photo.png', original, 'image/png')
    expect(mocks.stripBytes).not.toHaveBeenCalled()
    expect(markersIn(uploads[0].body)).toEqual([])
    expect(uploads[0].body.length).toBe(original.length)
    expect(uploads[0].headers['content-type']).toBe('application/octet-stream')
    expect(out.path).toMatch(/\.bin$/)
  })

  it.each([
    ['gps.mp4', 'application/octet-stream', 'upload.dat', /\.dat$/],
    ['gps.mov', 'video/quicktime', 'clip.mov', /\.mov$/],
    ['gps.heic', 'image/heic', 'photo.heic', /\.heic$/],
    ['gps.avif', 'image/avif', 'photo.avif', /\.avif$/],
  ])('strips %s declared as %s on disk and keeps its declared type', async (name, contentType, fileName, extension) => {
    const out = await run(name, fixture(name), contentType, fileName)
    expect(mocks.stripBytes).not.toHaveBeenCalled()
    expect(markersIn(uploads[0].body)).toEqual([])
    expect(uploads[0].headers['content-type']).toBe(contentType)
    expect(out.path).toMatch(extension)
  })

  it('keeps text declared as image/jpeg away from the image stripper and stores it as a download', async () => {
    const out = await run('page.jpg', new TextEncoder().encode('<html><script>alert(1)</script></html>'), 'image/jpeg')
    expect(mocks.stripBytes).not.toHaveBeenCalled()
    expect(uploads[0].headers['content-type']).toBe('application/octet-stream')
    expect(out.contentType).toBe('application/octet-stream')
    expect(out.path).toMatch(/\.bin$/)
  })

  it('passes a real image through the image stripper once', async () => {
    await run('photo.jpg', fixture('gps-upright.jpg'), 'image/jpeg')
    expect(mocks.stripBytes).toHaveBeenCalledTimes(1)
  })

  it('names the stored type and extension from the sniffed container', () => {
    expect(storedTypeOf('jpeg', 'image/png', 'png')).toEqual({ contentType: 'image/jpeg', extension: 'jpg' })
    expect(storedTypeOf('jpeg', 'application/octet-stream', 'jfif')).toEqual({ contentType: 'image/jpeg', extension: 'jfif' })
    expect(storedTypeOf('png', 'image/png', 'apng')).toEqual({ contentType: 'image/png', extension: 'png' })
    expect(storedTypeOf('webp', 'image/jpeg', 'jpg')).toEqual({ contentType: 'image/webp', extension: 'webp' })
    expect(storedTypeOf('gif', 'video/mp4', 'mp4')).toEqual({ contentType: 'image/gif', extension: 'gif' })
    expect(storedTypeOf('isobmff', 'video/mp4', 'mp4')).toEqual({ contentType: 'video/mp4', extension: 'mp4' })
    expect(storedTypeOf('isobmff', 'image/heic', 'heic')).toEqual({ contentType: 'image/heic', extension: 'heic' })
    expect(storedTypeOf('isobmff', 'IMAGE/PNG; charset=binary', 'png')).toEqual({ contentType: 'application/octet-stream', extension: 'bin' })
    expect(storedTypeOf(null, 'image/gif', 'gif')).toEqual({ contentType: 'application/octet-stream', extension: 'bin' })
    expect(storedTypeOf(null, 'text/markdown; charset=utf-8', 'md')).toEqual({ contentType: 'text/markdown; charset=utf-8', extension: 'md' })
    expect(storedTypeOf(null, 'audio/ogg', 'ogg')).toEqual({ contentType: 'audio/ogg', extension: 'ogg' })
  })
})

describe('mirrorFileToStorage and the server cap', () => {
  it('asks with the known size before any request and refuses with OverQuotaError', async () => {
    mocks.allows.mockResolvedValue(false)
    const fetchImpl = serve(new Uint8Array(100), { 'content-type': 'video/mp4' })
    const err = await mirrorFileToStorage(URL_OK, { ...base, knownSize: 100, tmpDir: tmp, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(OverQuotaError)
    expect(err.bytes).toBe(100)
    expect(mocks.allows.mock.calls).toEqual([[100]])
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(uploads).toHaveLength(0)
  })

  it('asks with Content-Length before reading the body, and cancels it when refused', async () => {
    mocks.allows.mockResolvedValue(false)
    const cancel = vi.fn(async () => {})
    const body = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(4)) }, cancel })
    const fetchImpl = serve(body, { 'content-type': 'video/mp4', 'content-length': '20' })
    const err = await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(OverQuotaError)
    expect(mocks.allows.mock.calls).toEqual([[20]])
    expect(cancel).toHaveBeenCalled()
    expect(uploads).toHaveLength(0)
    expect(await readdir(tmp)).toEqual([])
  })

  it('asks with the stored size when none was known, and uploads nothing when refused', async () => {
    mocks.allows.mockResolvedValue(false)
    const body = Readable.toWeb(Readable.from([Buffer.alloc(8), Buffer.alloc(8)])) as ReadableStream<Uint8Array>
    const err = await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: serve(body, { 'content-type': 'video/mp4' }) }).catch((e) => e)
    expect(err).toBeInstanceOf(OverQuotaError)
    expect(mocks.allows.mock.calls).toEqual([[16]])
    expect(uploads).toHaveLength(0)
    expect(await readdir(tmp)).toEqual([])
  })

  it('asks once when the file is no larger than the size it was admitted with', async () => {
    await mirrorFileToStorage(URL_OK, {
      ...base, knownSize: 100, tmpDir: tmp, fetchImpl: serve(new Uint8Array(100), { 'content-type': 'video/mp4', 'content-length': '100' }),
    })
    expect(mocks.allows.mock.calls).toEqual([[100]])
    expect(uploads).toHaveLength(1)
  })

  it('asks in whole bytes when the known size is a fraction', async () => {
    await mirrorFileToStorage(URL_OK, {
      ...base, knownSize: 99.5, tmpDir: tmp, fetchImpl: serve(new Uint8Array(100), { 'content-type': 'video/mp4' }),
    })
    expect(mocks.allows.mock.calls).toEqual([[100]])
  })

  it('asks again when the file is larger than the size it was admitted with', async () => {
    mocks.allows.mockImplementation(async (bytes: number) => bytes <= 10)
    const body = Readable.toWeb(Readable.from([Buffer.alloc(60), Buffer.alloc(40)])) as ReadableStream<Uint8Array>
    const err = await mirrorFileToStorage(URL_OK, { ...base, knownSize: 10, tmpDir: tmp, fetchImpl: serve(body, { 'content-type': 'video/mp4' }) }).catch((e) => e)
    expect(err).toBeInstanceOf(OverQuotaError)
    expect(err.bytes).toBe(100)
    expect(mocks.allows.mock.calls).toEqual([[10], [100]])
    expect(uploads).toHaveLength(0)
  })

  it('asks bridge_mirror_allows for the channel when no check is passed', async () => {
    const { allows: _allows, ...defaults } = base
    const run = () => mirrorFileToStorage(URL_OK, { ...defaults, tmpDir: tmp, fetchImpl: serve(new Uint8Array(100), { 'content-type': 'video/mp4' }) })

    await run()
    expect(mocks.rpc.mock.calls).toEqual([['bridge_mirror_allows', { p_channel_id: CHANNEL, p_bytes: 100 }]])
    expect(uploads).toHaveLength(1)

    mocks.rpc.mockResolvedValue({ data: false, error: null })
    await expect(run()).rejects.toBeInstanceOf(OverQuotaError)

    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } })
    const err = await run().catch((e) => e)
    expect(err).not.toBeInstanceOf(OverQuotaError)
    expect(err.message).toMatch(/bridge_mirror_allows failed: connection refused/)
    expect(uploads).toHaveLength(1)
  })
})

describe('mirrorFileToStorage leaves no unreferenced object', () => {
  const run = () => mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: serve(new Uint8Array(100), { 'content-type': 'video/mp4' }) })
  const uploadedPath = () => uploads[0].url!.replace('/storage/v1/object/message_media/', '')

  it('removes the object when the upload ends without a response', async () => {
    reply = { status: 200, body: '', reset: true }
    await expect(run()).rejects.toThrow(/^Storage upload failed: /)
    expect(mocks.bucket).toHaveBeenCalledWith('message_media')
    expect(mocks.remove.mock.calls).toEqual([[[uploadedPath()]]])
  })

  it('removes the object when the upload fails with a 500', async () => {
    reply = { status: 500, body: '{"message":"boom"}' }
    await expect(run()).rejects.toThrow(/^Storage upload failed: 500 /)
    expect(mocks.remove.mock.calls).toEqual([[[uploadedPath()]]])
  })

  it('still reports the upload failure when the removal fails too', async () => {
    reply = { status: 500, body: '{"message":"boom"}' }
    mocks.remove.mockRejectedValue(new Error('storage down'))
    await expect(run()).rejects.toThrow(/^Storage upload failed: 500 /)
  })

  it('removes nothing when storage refuses the size or the type', async () => {
    reply = { status: 413, body: '{"message":"The object exceeded the maximum allowed size"}' }
    await expect(run()).rejects.toBeInstanceOf(TooLargeError)
    reply = { status: 400, body: '{"statusCode":"415","error":"invalid_mime_type","code":"InvalidMimeType"}' }
    await expect(run()).rejects.toThrow(/InvalidMimeType/)
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('returns the unsigned reference when signing throws, and keeps the object', async () => {
    mocks.sign.mockRejectedValue(new Error('sign failed'))
    const out = await run()
    expect(out.path).toBe(uploadedPath())
    expect(out.url).toMatch(new RegExp(`/storage/v1/object/authenticated/message_media/${out.path}$`))
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})
