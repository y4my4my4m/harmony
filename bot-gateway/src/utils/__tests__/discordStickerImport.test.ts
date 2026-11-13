import { beforeEach, describe, expect, it, vi } from 'vitest'

const uploads = vi.hoisted(() => [] as Array<{ bucket: string; path: string; bytes: Buffer; options: Record<string, unknown> }>)
vi.mock('../../config/supabase.js', () => ({
  supabase: {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, bytes: Buffer, options: Record<string, unknown>) => {
          uploads.push({ bucket, path, bytes, options })
          return { error: null }
        },
        remove: async () => ({ error: null }),
      }),
    },
  },
}))

import { StickerFileError, discordStickerCdnUrl, storeDiscordSticker } from '../discordStickerImport.js'

const SERVER = '11111111-2222-3333-4444-555555555555'

function chunk(type: string, data: number[]): number[] {
  const len = data.length
  return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
    ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]
}
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

/** PNG signature, IHDR, optional acTL + one fcTL per delay (ms), IEND. */
function png(width: number, height: number, delaysMs: number[] = []): Uint8Array {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be32(width), ...be32(height), 8, 6, 0, 0, 0])]
  if (delaysMs.length) {
    out.push(...chunk('acTL', [...be32(delaysMs.length), ...be32(0)]))
    delaysMs.forEach((ms, i) => {
      out.push(...chunk('fcTL', [...be32(i), ...be32(width), ...be32(height), ...be32(0), ...be32(0),
        (ms >>> 8) & 255, ms & 255, 0x03, 0xe8, 0, 0]))
    })
  }
  out.push(...chunk('IEND', []))
  return new Uint8Array(out)
}

/** GIF89a with `frames` image frames, each delayed `cs` centiseconds. */
function gif(width: number, height: number, frames: number, cs: number): Uint8Array {
  const out = [...'GIF89a'].map((c) => c.charCodeAt(0))
  out.push(width & 255, width >> 8, height & 255, height >> 8, 0, 0, 0)
  for (let i = 0; i < frames; i++) {
    out.push(0x21, 0xf9, 4, 0, cs & 255, cs >> 8, 0, 0)
    out.push(0x2c, 0, 0, 0, 0, width & 255, width >> 8, height & 255, height >> 8, 0, 2, 1, 0, 0)
  }
  out.push(0x3b)
  return new Uint8Array(out)
}

const ok = (body: Uint8Array, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(body, { status: 200, headers })) as unknown as typeof fetch

beforeEach(() => {
  uploads.length = 0
  process.env.PUBLIC_URL = 'https://harmony.test'
})

describe('discordStickerCdnUrl', () => {
  it('uses .gif for format 4 and .png otherwise', () => {
    expect(discordStickerCdnUrl('9', 1)).toBe('https://media.discordapp.net/stickers/9.png?size=320')
    expect(discordStickerCdnUrl('9', 2)).toBe('https://media.discordapp.net/stickers/9.png?size=320')
    expect(discordStickerCdnUrl('9', 4)).toBe('https://media.discordapp.net/stickers/9.gif?size=320')
  })
})

describe('storeDiscordSticker', () => {
  it('stores a still PNG as .png image/png with null duration', async () => {
    const r = await storeDiscordSticker(SERVER, '9', 1, ok(png(160, 120)))
    expect(r.path).toMatch(new RegExp(`^server/${SERVER}/[0-9a-f-]{36}\\.png$`))
    expect(r.url).toBe(`https://harmony.test/storage/v1/object/public/stickers/${r.path}`)
    expect([r.width, r.height, r.durationMs]).toEqual([160, 120, null])
    expect(uploads).toHaveLength(1)
    expect(uploads[0].bucket).toBe('stickers')
    expect(uploads[0].options).toMatchObject({ contentType: 'image/png', upsert: false })
  })

  it('stores an animated PNG as .apng image/apng with its loop duration', async () => {
    const r = await storeDiscordSticker(SERVER, '9', 2, ok(png(64, 64, [300, 700])))
    expect(r.path).toMatch(/\.apng$/)
    expect(r.durationMs).toBe(1000)
    expect(uploads[0].options.contentType).toBe('image/apng')
    // The frame chunks survive metadata stripping.
    expect(uploads[0].bytes.includes(Buffer.from('fcTL'))).toBe(true)
    expect(uploads[0].bytes.includes(Buffer.from('acTL'))).toBe(true)
  })

  it('stores a GIF as .gif', async () => {
    const r = await storeDiscordSticker(SERVER, '9', 4, ok(gif(100, 100, 3, 10)))
    expect(r.path).toMatch(/\.gif$/)
    expect(r.durationMs).toBe(300)
    expect(uploads[0].options.contentType).toBe('image/gif')
  })

  it('refuses Lottie without fetching', async () => {
    const fetchImpl = ok(png(10, 10))
    await expect(storeDiscordSticker(SERVER, '9', 3, fetchImpl)).rejects.toMatchObject({ reason: 'lottie' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses over 512 KB by content-length and by body', async () => {
    await expect(storeDiscordSticker(SERVER, '9', 1, ok(png(10, 10), { 'content-length': '524289' })))
      .rejects.toMatchObject({ reason: 'size' })
    const big = new Uint8Array(524289)
    big.set(png(10, 10))
    await expect(storeDiscordSticker(SERVER, '9', 1, ok(big))).rejects.toMatchObject({ reason: 'size' })
    expect(uploads).toHaveLength(0)
  })

  it('refuses 321 px', async () => {
    await expect(storeDiscordSticker(SERVER, '9', 1, ok(png(321, 100)))).rejects.toMatchObject({ reason: 'dimensions' })
    expect(uploads).toHaveLength(0)
  })

  it('refuses an animation over 5000 ms', async () => {
    await expect(storeDiscordSticker(SERVER, '9', 2, ok(png(64, 64, [2500, 2501]))))
      .rejects.toMatchObject({ reason: 'duration' })
    expect(uploads).toHaveLength(0)
  })

  it('refuses bytes that are no image', async () => {
    const err = await storeDiscordSticker(SERVER, '9', 1, ok(new TextEncoder().encode('<html>no</html>'))).catch((e) => e)
    expect(err).toBeInstanceOf(StickerFileError)
    expect(err.reason).toBe('type')
  })

  it('throws a plain Error when the CDN fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    const err = await storeDiscordSticker(SERVER, '9', 1, fetchImpl).catch((e) => e)
    expect(err).not.toBeInstanceOf(StickerFileError)
    expect(err.message).toContain('404')
  })
})
