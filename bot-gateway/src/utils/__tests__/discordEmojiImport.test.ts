import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// An imported Discord emoji is stored without metadata.
const uploads = vi.hoisted(() => [] as Array<{ path: string; bytes: Buffer }>)
vi.mock('../../config/supabase.js', () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Buffer) => {
          uploads.push({ path, bytes })
          return { error: null }
        },
      }),
    },
  },
}))
vi.mock('../emojiUrl.js', () => ({ absoluteEmojiUrl: (path: string) => `https://harmony.test/emojis/${path}` }))

import { storeDiscordEmojiImage } from '../discordEmojiImport.js'

describe('storeDiscordEmojiImage', () => {
  it('stores the image without its Exif and text chunks', async () => {
    const png = readFileSync(resolve(__dirname, '../../../../tests/fixtures/media-metadata/gps.png'))
    expect(png.toString('latin1')).toContain('GPSLatitude')
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }))

    const url = await storeDiscordEmojiImage('s1', '123', false, fetchImpl as unknown as typeof fetch)

    expect(url).toBe('https://harmony.test/emojis/s1/discord/123.png')
    const stored = uploads[0].bytes
    expect(stored.length).toBeLessThan(png.length)
    for (const marker of ['HarmonyCam', 'GPSLatitude', 'fixture comment']) expect(stored.toString('latin1')).not.toContain(marker)
  })
})
