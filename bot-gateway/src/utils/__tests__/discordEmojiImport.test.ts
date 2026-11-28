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

  it('bounds the download with an abort signal', async () => {
    const png = readFileSync(resolve(__dirname, '../../../../tests/fixtures/media-metadata/gps.png'))
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(new Uint8Array(png), { status: 200, headers: { 'content-type': 'image/png' } }))
    await storeDiscordEmojiImage('s1', '124', false, fetchImpl as unknown as typeof fetch)
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses an oversize content-length before reading the body', async () => {
    const before = uploads.length
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(10))
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/png', 'content-length': '524289' }),
      arrayBuffer,
    })) as unknown as typeof fetch
    await expect(storeDiscordEmojiImage('s1', '125', false, fetchImpl)).rejects.toThrow(/524289/)
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(uploads.length).toBe(before)
  })
})
