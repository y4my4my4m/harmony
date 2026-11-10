import { describe, expect, it, vi } from 'vitest'

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

import { audioDurationMs, discordSoundCdnUrl, soundFormat, storeDiscordSound } from '../discordSoundImport.js'

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz frames (417 bytes, 1152 samples each) with a zero payload. */
function syntheticMp3(frames: number): Uint8Array {
  const out = new Uint8Array(frames * 417)
  for (let i = 0; i < frames; i++) out.set([0xff, 0xfb, 0x90, 0x64], i * 417)
  return out
}
const ok = (body: Uint8Array) => vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch
const SERVER = '11111111-2222-3333-4444-555555555555'

describe('soundFormat', () => {
  it('recognizes ogg, mp3 with ID3, and mp3 frame sync', () => {
    expect(soundFormat(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2]))).toBe('ogg')
    expect(soundFormat(new Uint8Array([0x49, 0x44, 0x33, 4, 0]))).toBe('mp3')
    expect(soundFormat(new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe('mp3')
  })
  it('rejects other containers', () => {
    expect(soundFormat(new TextEncoder().encode('RIFF....WAVEfmt '))).toBeNull()
    expect(soundFormat(new Uint8Array([1, 2, 3, 4]))).toBeNull()
    expect(soundFormat(new Uint8Array([]))).toBeNull()
  })
})

describe('discordSoundCdnUrl', () => {
  it('builds the CDN url from the id', () => {
    expect(discordSoundCdnUrl('123')).toBe('https://cdn.discordapp.com/soundboard-sounds/123')
  })
})

describe('audioDurationMs', () => {
  it('measures a synthetic mp3', async () => {
    const ms = await audioDurationMs(syntheticMp3(77), 'mp3')
    expect(ms).toBeGreaterThanOrEqual(1950)
    expect(ms).toBeLessThanOrEqual(2050)
  })
})

describe('storeDiscordSound', () => {
  it('uploads the clip and returns its path and duration', async () => {
    uploads.length = 0
    const result = await storeDiscordSound(SERVER, '123', ok(syntheticMp3(77)))
    expect(result.storagePath).toMatch(new RegExp(`^${SERVER}/[0-9a-f-]{36}\\.mp3$`))
    expect(result.durationMs).toBeGreaterThanOrEqual(1950)
    expect(uploads).toHaveLength(1)
    expect(uploads[0].bucket).toBe('soundboard')
    expect(uploads[0].path).toBe(result.storagePath)
    expect(uploads[0].options).toMatchObject({ contentType: 'audio/mpeg', upsert: false, cacheControl: '31536000' })
  })

  it.each([
    ['an HTTP 404', () => vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch],
    ['an oversize body', () => ok(new Uint8Array(524289).fill(0xff))],
    ['an empty body', () => ok(new Uint8Array(0))],
    ['WAV bytes', () => ok(new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt '))],
    ['a clip longer than 5.2 s', () => ok(syntheticMp3(230))],
  ])('throws without uploading on %s', async (_label, make) => {
    uploads.length = 0
    await expect(storeDiscordSound(SERVER, '123', make())).rejects.toThrow()
    expect(uploads).toHaveLength(0)
  })

  it('clamps a parser overshoot just above 5.2 s to 5200', async () => {
    uploads.length = 0
    const parsed = await audioDurationMs(syntheticMp3(200), 'mp3')
    expect(parsed).toBeGreaterThan(5200)
    expect(parsed).toBeLessThanOrEqual(5300)
    const result = await storeDiscordSound(SERVER, '123', ok(syntheticMp3(200)))
    expect(result.durationMs).toBe(5200)
    expect(uploads).toHaveLength(1)
  })

  it('passes an abort signal to the fetch', async () => {
    uploads.length = 0
    const fetchImpl = ok(syntheticMp3(77))
    await storeDiscordSound(SERVER, '123', fetchImpl)
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects an oversize content-length before reading the body or uploading', async () => {
    uploads.length = 0
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(10))
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '524289' }),
      arrayBuffer,
    })) as unknown as typeof fetch
    await expect(storeDiscordSound(SERVER, '123', fetchImpl)).rejects.toThrow(/524289/)
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(uploads).toHaveLength(0)
  })
})
