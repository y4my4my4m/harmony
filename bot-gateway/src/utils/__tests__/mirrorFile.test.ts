import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  bucket: vi.fn(),
  sign: vi.fn(),
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: {
    storage: {
      from: (bucket: string) => {
        mocks.bucket(bucket)
        return { upload: mocks.upload }
      },
    },
  },
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

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'mirror-test-'))
  mocks.upload.mockReset()
  mocks.bucket.mockReset()
  mocks.sign.mockReset()
  mocks.sign.mockImplementation(async (paths: string[]) => new Map(paths.map((p) => [p, `https://signed.test/${p}`])))
  process.env.SUPABASE_URL = 'http://kong:8000'
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
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(await readdir(tmp)).toEqual([])
  })

  it('rejects a body that streams past the ceiling and removes the temp file', async () => {
    const body = Readable.toWeb(Readable.from([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)])) as ReadableStream<Uint8Array>
    const fetchImpl = serve(body, { 'content-type': 'video/mp4' })
    const err = await mirrorFileToStorage(URL_OK, { ...base, ceiling: 10, tmpDir: tmp, fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(TooLargeError)
    expect(mocks.upload).not.toHaveBeenCalled()
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

  it('uploads a 3 MB video as a stream and leaves no temp files', async () => {
    let seen: unknown
    let received = 0
    mocks.upload.mockImplementation(async (_path: string, body: unknown) => {
      seen = body
      for await (const chunk of body as AsyncIterable<Buffer>) received += chunk.length
      return { data: {}, error: null }
    })
    const fetchImpl = serve(new Uint8Array(3 * MB), { 'content-type': 'video/mp4' })

    const out = await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl })

    const [path, , options] = mocks.upload.mock.calls[0]
    expect(mocks.bucket).toHaveBeenCalledWith('message_media')
    expect(path).toMatch(new RegExp(`^c/${CHANNEL.toLowerCase()}/bridge/${BOT}/[0-9a-f-]{36}\\.mp4$`))
    expect(options).toEqual({ contentType: 'video/mp4', upsert: false, cacheControl: '31536000', duplex: 'half' })
    expect(Buffer.isBuffer(seen)).toBe(false)
    expect(typeof (seen as Readable).pipe).toBe('function')
    expect(received).toBe(3 * MB)
    expect(out).toEqual({ path, url: `https://signed.test/${path}`, contentType: 'video/mp4', bytes: 3 * MB })
    expect(await readdir(tmp)).toEqual([])
  })

  it('removes the temp file when the upload fails', async () => {
    mocks.upload.mockImplementation(async (_path: string, body: Readable) => {
      body.destroy()
      return { data: null, error: { message: 'boom' } }
    })
    await expect(mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: serve(new Uint8Array(100), { 'content-type': 'video/mp4' }) }))
      .rejects.toThrow('Storage upload failed: boom')
    expect(await readdir(tmp)).toEqual([])
  })

  it('maps a storage 413 to TooLargeError with the file size', async () => {
    mocks.upload.mockImplementation(async (_p: string, body: Readable) => {
      body.destroy()
      return { data: null, error: { message: 'The object exceeded the maximum allowed size', statusCode: '413' } }
    })
    const err = await mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: serve(new Uint8Array(100), { 'content-type': 'video/mp4' }) }).catch((e) => e)
    expect(err).toBeInstanceOf(TooLargeError)
    expect(err.bytes).toBe(100)
    expect(await readdir(tmp)).toEqual([])
  })

  it('maps an HTML error body from the proxy to TooLargeError, also when upload throws', async () => {
    mocks.upload.mockImplementation(async (_p: string, body: Readable) => {
      body.destroy()
      return { data: null, error: { message: `Unexpected token '<', "<html><h"... is not valid JSON` } }
    })
    const html = () => serve(new Uint8Array(100), { 'content-type': 'video/mp4' })
    await expect(mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: html() })).rejects.toBeInstanceOf(TooLargeError)

    mocks.upload.mockImplementation(async () => { throw Object.assign(new Error('Request Entity Too Large'), { status: 413 }) })
    await expect(mirrorFileToStorage(URL_OK, { ...base, tmpDir: tmp, fetchImpl: html() })).rejects.toBeInstanceOf(TooLargeError)
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
    expect(mocks.upload).not.toHaveBeenCalled()
    expect(await readdir(tmp)).toEqual([])
  })

  it('stores an animated PNG as .apng', async () => {
    mocks.upload.mockImplementation(async (_p: string, body: Readable) => { body.resume(); return { data: {}, error: null } })
    const out = await mirrorFileToStorage('https://media.discordapp.net/stickers/1.png', {
      ...base, tmpDir: tmp, fetchImpl: serve(APNG, { 'content-type': 'image/png' }),
    })
    expect(out.contentType).toBe('image/apng')
    expect(out.path).toMatch(/\.apng$/)
    expect(mocks.upload.mock.calls[0][2]).toMatchObject({ contentType: 'image/apng' })
  })

  it('rejects a disallowed host before fetching', async () => {
    const fetchImpl = serve(new Uint8Array(1))
    await expect(mirrorFileToStorage('https://evil.example/a.png', { ...base, tmpDir: tmp, fetchImpl })).rejects.toThrow(/disallowed/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
