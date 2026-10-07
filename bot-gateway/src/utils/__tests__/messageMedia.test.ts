import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createSignedUrls: vi.fn(),
  createSignedUrl: vi.fn(),
  upload: vi.fn(),
  bucket: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: {
    from: mocks.from,
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

    await expect(applyBridgeAttachmentPolicy([VOICE, STICKER], BOT, CHANNEL)).resolves.toEqual([VOICE, STICKER])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('mirrors a voice message as an audio part', async () => {
    mirrorMode()
    mocks.upload.mockResolvedValue({ data: {}, error: null })
    serve(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), 'audio/ogg')

    const [part] = await applyBridgeAttachmentPolicy([VOICE], BOT, CHANNEL)

    const [path, , options] = mocks.upload.mock.calls[0]
    expect(path).toMatch(new RegExp(`^c/${CHANNEL}/bridge/${BOT}/[0-9a-f-]{36}\\.ogg$`))
    expect(options).toMatchObject({ contentType: 'audio/ogg' })
    expect(part).toMatchObject({ type: 'file', fileType: 'audio', fileName: 'voice-message.ogg', path })
  })

  it('stores an animated sticker as .apng so clients render the original, not a static thumbnail', async () => {
    mirrorMode()
    mocks.upload.mockResolvedValue({ data: {}, error: null })
    serve(APNG, 'image/png')

    const [part] = await applyBridgeAttachmentPolicy([STICKER], BOT, CHANNEL)

    const [path, , options] = mocks.upload.mock.calls[0]
    expect(path).toMatch(/\.apng$/)
    expect(options).toMatchObject({ contentType: 'image/apng' })
    expect(part).toMatchObject({ type: 'file', fileType: 'image', path })
  })

  it('keeps a static sticker as .png', async () => {
    mirrorMode()
    mocks.upload.mockResolvedValue({ data: {}, error: null })
    serve(STATIC_PNG, 'image/png')

    await applyBridgeAttachmentPolicy([STICKER], BOT, CHANNEL)

    const [path, , options] = mocks.upload.mock.calls[0]
    expect(path).toMatch(/\.png$/)
    expect(options).toMatchObject({ contentType: 'image/png' })
  })

  it('copies a Discord attachment into the channel room and names it by path', async () => {
    mirrorMode()
    mocks.upload.mockResolvedValue({ data: {}, error: null })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200, headers: { 'content-type': 'image/png' },
    })))

    const [part] = await applyBridgeAttachmentPolicy(
      [{ type: 'url', url: 'https://cdn.discordapp.com/attachments/1/2/cat.png?ex=1' }], BOT, CHANNEL)

    const path = mocks.upload.mock.calls[0][0] as string
    expect(mocks.bucket).toHaveBeenCalledWith('message_media')
    expect(path).toMatch(new RegExp(`^c/${CHANNEL}/bridge/${BOT}/[0-9a-f-]{36}\\.png$`))
    expect(part).toEqual({
      type: 'file',
      fileType: 'image',
      path,
      url: `https://db.harmony.test/storage/v1/object/sign/message_media/${path}?token=t`,
    })
  })
})
