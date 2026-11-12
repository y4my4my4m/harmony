import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createSignedUrls: vi.fn(),
  createSignedUrl: vi.fn(),
  upload: vi.fn(),
  bucket: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  url: { value: 'http://127.0.0.1:1' },
}))

vi.mock('../../config/supabase.js', () => ({
  get supabaseUrl() {
    return mocks.url.value
  },
  supabaseServiceKey: 'service-key',
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
    storage: {
      from: (bucket: string) => {
        mocks.bucket(bucket)
        return { createSignedUrls: mocks.createSignedUrls, createSignedUrl: mocks.createSignedUrl, upload: mocks.upload }
      },
    },
  },
  config: {},
}))

import {
  BOT_MEDIA_URL_TTL_SECONDS,
  messageMediaRoom,
  stripBotSuppliedPaths,
  withSignedMessageMedia,
} from '../messageMedia.js'
import { applyBridgeAttachmentPolicy, isAnimatedPng } from '../mirrorExternalMedia.js'

const CHANNEL = '00000000-0000-4000-8000-0000000000c1'
const OTHER = '00000000-0000-4000-8000-0000000000c2'
const BOT = '00000000-0000-4000-8000-0000000000b1'

const env = { ...process.env }

beforeEach(() => {
  mocks.createSignedUrls.mockReset()
  mocks.createSignedUrl.mockReset()
  mocks.createSignedUrl.mockImplementation(async (path: string) => ({
    data: { signedUrl: `http://kong:8000/storage/v1/render/image/sign/message_media/${path}?token=r` },
    error: null,
  }))
  mocks.upload.mockReset()
  mocks.bucket.mockReset()
  mocks.from.mockReset()
  // bridge_mirror_allows: the server cap has room.
  mocks.rpc.mockReset()
  mocks.rpc.mockResolvedValue({ data: true, error: null })
  mocks.createSignedUrls.mockImplementation(async (paths: string[]) => ({
    data: paths.map((path) => ({ path, signedUrl: `http://kong:8000/storage/v1/object/sign/message_media/${path}?token=t`, error: null })),
    error: null,
  }))
  process.env.SUPABASE_URL = 'http://kong:8000'
  process.env.PUBLIC_URL = 'https://db.harmony.test'
})

afterEach(() => {
  process.env = { ...env }
  vi.unstubAllGlobals()
})

describe('message media for bots', () => {
  it('names rooms by channel or conversation', () => {
    expect(messageMediaRoom({ channel_id: CHANNEL })).toBe(`c/${CHANNEL}`)
    expect(messageMediaRoom({ conversation_id: OTHER })).toBe(`d/${OTHER}`)
    expect(messageMediaRoom({})).toBeNull()
  })

  it('re-signs attachments of the message room only, at the public host', async () => {
    const own = `c/${CHANNEL}/u/a.png`
    const foreign = `c/${OTHER}/u/b.png`
    const content = [
      { type: 'text', text: 'hi' },
      { type: 'file', fileType: 'image', url: 'old', path: own },
      { type: 'file', fileType: 'image', url: 'kept', path: foreign },
      { type: 'file', fileType: 'image', url: 'https://cdn.discordapp.com/x.png' },
    ]
    const out = await withSignedMessageMedia(content, { channel_id: CHANNEL }) as any[]

    expect(mocks.bucket).toHaveBeenCalledWith('message_media')
    expect(mocks.createSignedUrls).toHaveBeenCalledWith([own], BOT_MEDIA_URL_TTL_SECONDS)
    expect(out[1]).toEqual({ type: 'file', fileType: 'image', path: own,
      url: `https://db.harmony.test/storage/v1/object/sign/message_media/${own}?token=t`,
      render_url: `https://db.harmony.test/storage/v1/render/image/sign/message_media/${own}?token=r` })
    expect(mocks.createSignedUrl).toHaveBeenCalledWith(own, BOT_MEDIA_URL_TTL_SECONDS, {
      transform: { width: 1600, height: 1600, resize: 'contain', quality: 82 },
    })
    expect(out[2]).toEqual(content[2])
    expect(out[3]).toEqual(content[3])
  })

  it('renders still images only, and leaves render_url out when signing a rendition fails', async () => {
    const photo = `c/${CHANNEL}/u/photo.jpg`
    const gif = `c/${CHANNEL}/u/party.gif`
    const voice = `c/${CHANNEL}/u/voice.ogg`
    const broken = `c/${CHANNEL}/u/broken.png`
    mocks.createSignedUrl.mockImplementation(async (path: string) =>
      path === broken
        ? { data: null, error: { message: 'image transformation is not enabled' } }
        : { data: { signedUrl: `http://kong:8000/storage/v1/render/image/sign/message_media/${path}?token=r` }, error: null })

    const out = await withSignedMessageMedia([
      { type: 'file', fileType: 'image', url: 'old', path: photo },
      { type: 'file', fileType: 'image', url: 'old', path: gif },
      { type: 'file', fileType: 'audio', url: 'old', path: voice },
      { type: 'file', fileType: 'image', url: 'old', path: broken },
    ], { channel_id: CHANNEL }) as any[]

    expect(mocks.createSignedUrl.mock.calls.map(([path]) => path)).toEqual([photo, broken])
    expect(out.map((part) => 'render_url' in part)).toEqual([true, false, false, false])
    expect(out.every((part) => part.url.startsWith('https://db.harmony.test/storage/v1/object/sign/'))).toBe(true)
  })

  it('leaves content without room attachments untouched', async () => {
    const content = [{ type: 'text', text: 'hi' }]
    await expect(withSignedMessageMedia(content, { channel_id: CHANNEL })).resolves.toBe(content)
    expect(mocks.createSignedUrls).not.toHaveBeenCalled()
  })

  it('drops bot-supplied paths', () => {
    expect(stripBotSuppliedPaths([
      { type: 'file', url: 'https://cdn.example/a.png', path: `d/${OTHER}/u/secret.png` },
      { type: 'text', text: 'x' },
    ])).toEqual([
      { type: 'file', url: 'https://cdn.example/a.png' },
      { type: 'text', text: 'x' },
    ])
  })
})

/** PNG bytes: signature, then each chunk as length, type, `size` zero bytes of data and a CRC. */
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
const STATIC_PNG = png([['IHDR', 13], ['IDAT', 10], ['IEND', 0]])

describe('isAnimatedPng', () => {
  it('finds an acTL chunk ahead of the image data', () => {
    expect(isAnimatedPng(Buffer.from(APNG))).toBe(true)
    expect(isAnimatedPng(Buffer.from(STATIC_PNG))).toBe(false)
  })

  it('ignores an acTL after IDAT, truncated data and other formats', () => {
    expect(isAnimatedPng(Buffer.from(png([['IHDR', 13], ['IDAT', 10], ['acTL', 8]])))).toBe(false)
    expect(isAnimatedPng(Buffer.from(APNG).subarray(0, 20))).toBe(false)
    expect(isAnimatedPng(Buffer.from('GIF89a........'))).toBe(false)
  })
})

describe('bridge mirror', () => {
  // Files go to Storage over node:http (uploadFileToStorage), so a local server stands in for it.
  const stored: Array<{ path: string; contentType: string; body: Buffer }> = []
  let server: Server
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        stored.push({
          path: req.url!.replace('/storage/v1/object/message_media/', ''),
          contentType: String(req.headers['content-type']),
          body: Buffer.concat(chunks),
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    mocks.url.value = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  beforeEach(() => { stored.length = 0 })

  function attachmentMode(mode: string) {
    const q: any = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: { config_value: JSON.stringify(mode) }, error: null }),
    }
    mocks.from.mockReturnValue(q)
  }
  const mirrorMode = () => attachmentMode('mirror')

  function serve(body: Uint8Array, contentType: string) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': contentType } })))
  }

  const VOICE = {
    type: 'file',
    fileType: 'audio',
    url: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg?ex=1&is=2&hm=3',
    fileName: 'voice-message.ogg',
    contentType: 'audio/ogg',
  }
  const STICKER = { type: 'file', fileType: 'image', url: 'https://media.discordapp.net/stickers/749054660769218631.png?size=160' }

  it('passes audio and sticker parts through unchanged in link mode', async () => {
    attachmentMode('link')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(applyBridgeAttachmentPolicy([VOICE, STICKER], BOT, CHANNEL)).resolves.toEqual({ parts: [VOICE, STICKER], deferred: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('mirrors a voice message as an audio part', async () => {
    mirrorMode()
    serve(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), 'audio/ogg')

    const { parts: [part] } = await applyBridgeAttachmentPolicy([VOICE], BOT, CHANNEL)

    const { path, contentType } = stored[0]
    const options = { contentType }
    expect(path).toMatch(new RegExp(`^c/${CHANNEL}/bridge/${BOT}/[0-9a-f-]{36}\\.ogg$`))
    expect(options).toMatchObject({ contentType: 'audio/ogg' })
    expect(part).toMatchObject({ type: 'file', fileType: 'audio', fileName: 'voice-message.ogg', path })
  })

  it('stores an animated sticker as .apng so clients render the original, not a static thumbnail', async () => {
    mirrorMode()
    serve(APNG, 'image/png')

    const { parts: [part] } = await applyBridgeAttachmentPolicy([STICKER], BOT, CHANNEL)

    const { path, contentType } = stored[0]
    const options = { contentType }
    expect(path).toMatch(/\.apng$/)
    expect(options).toMatchObject({ contentType: 'image/apng' })
    expect(part).toMatchObject({ type: 'file', fileType: 'image', path })
  })

  it('keeps a static sticker as .png', async () => {
    mirrorMode()
    serve(STATIC_PNG, 'image/png')

    await applyBridgeAttachmentPolicy([STICKER], BOT, CHANNEL)

    const { path, contentType } = stored[0]
    const options = { contentType }
    expect(path).toMatch(/\.png$/)
    expect(options).toMatchObject({ contentType: 'image/png' })
  })

  it('stores a mirrored photo without its location and camera details', async () => {
    mirrorMode()
    const photo = readFileSync(resolve(__dirname, '../../../../tests/fixtures/media-metadata/gps-rotated.jpg'))
    expect(photo.toString('latin1')).toContain('HarmonyCam')
    serve(new Uint8Array(photo), 'image/jpeg')

    await applyBridgeAttachmentPolicy(
      [{ type: 'url', url: 'https://cdn.discordapp.com/attachments/1/2/IMG_0420.jpg?ex=1' }], BOT, CHANNEL)

    const body = stored[0].body
    expect(body.length).toBeLessThan(photo.length)
    for (const marker of ['HarmonyCam', 'GPSLatitude', 'Tokyo', 'TRAILER']) expect(body.toString('latin1')).not.toContain(marker)
    expect(body.subarray(0, 2).toString('hex')).toBe('ffd8')
  })

  it('defers a file over the inline limit without downloading it', async () => {
    mirrorMode()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const part = { type: 'file', fileType: 'video', url: 'https://cdn.discordapp.com/attachments/1/2/big.mp4', fileSize: 30 * 1024 * 1024 }

    await expect(applyBridgeAttachmentPolicy([part], BOT, CHANNEL)).resolves.toEqual({ parts: [part], deferred: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('defers a file whose Content-Length is over the inline limit and aborts the download', async () => {
    mirrorMode()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(30 * 1024 * 1024) },
    })))
    const part = { type: 'url', url: 'https://cdn.discordapp.com/attachments/1/2/big.mp4' }

    await expect(applyBridgeAttachmentPolicy([part], BOT, CHANNEL)).resolves.toEqual({ parts: [part], deferred: true })
    expect(stored).toHaveLength(0)
  })

  it('mirrors a small file inline and does not defer', async () => {
    mirrorMode()
    serve(STATIC_PNG, 'image/png')
    const result = await applyBridgeAttachmentPolicy(
      [{ type: 'file', fileType: 'image', url: 'https://cdn.discordapp.com/attachments/1/2/s.png', fileSize: 1024 * 1024 }], BOT, CHANNEL)

    expect(result.deferred).toBe(false)
    expect(result.parts[0].path).toMatch(/\.png$/)
  })

  it('defers a part whose inline mirror fails on the network', async () => {
    mirrorMode()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up') }))
    const part = { type: 'url', url: 'https://cdn.discordapp.com/attachments/1/2/cat.png' }

    await expect(applyBridgeAttachmentPolicy([part], BOT, CHANNEL)).resolves.toEqual({ parts: [part], deferred: true })
  })

  it('copies a Discord attachment into the channel room and names it by path', async () => {
    mirrorMode()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(STATIC_PNG, {
      status: 200, headers: { 'content-type': 'image/png' },
    })))

    const { parts: [part] } = await applyBridgeAttachmentPolicy(
      [{ type: 'url', url: 'https://cdn.discordapp.com/attachments/1/2/cat.png?ex=1' }], BOT, CHANNEL)

    const path = stored[0].path
    expect(path).toMatch(new RegExp(`^c/${CHANNEL}/bridge/${BOT}/[0-9a-f-]{36}\\.png$`))
    expect(part).toEqual({
      type: 'file',
      fileType: 'image',
      path,
      url: `https://db.harmony.test/storage/v1/object/sign/message_media/${path}?token=t`,
    })
  })
})
