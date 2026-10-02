import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createSignedUrls: vi.fn(),
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
        return { createSignedUrls: mocks.createSignedUrls, upload: mocks.upload }
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
import { applyBridgeAttachmentPolicy } from '../mirrorExternalMedia.js'

const CHANNEL = '00000000-0000-4000-8000-0000000000c1'
const OTHER = '00000000-0000-4000-8000-0000000000c2'
const BOT = '00000000-0000-4000-8000-0000000000b1'

const env = { ...process.env }

beforeEach(() => {
  mocks.createSignedUrls.mockReset()
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
      url: `https://db.harmony.test/storage/v1/object/sign/message_media/${own}?token=t` })
    expect(out[2]).toEqual(content[2])
    expect(out[3]).toEqual(content[3])
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

describe('bridge mirror', () => {
  function mirrorMode() {
    const q: any = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: { config_value: '"mirror"' }, error: null }),
    }
    mocks.from.mockReturnValue(q)
  }

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
