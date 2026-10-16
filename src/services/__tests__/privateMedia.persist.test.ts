import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'

const CHANNEL = '66666666-0000-4000-8000-000000000006'
const UID = 'aaaaaaaa-0000-4000-8000-000000000001'
const PNG = `c/${CHANNEL}/${UID}/photo.png`
const WEBP = `c/${CHANNEL}/${UID}/sticker.webp`
const KEY = 'harmony.signedMediaUrls'

const signed = (path: string, tag: string) => `http://localhost:54321/storage/v1/object/sign/message_media/${path}?token=${tag}`

let release: Array<() => void> = []
const bucket = {
  createSignedUrls: vi.fn(async (paths: string[]) => ({
    data: paths.map((path) => ({ path, signedUrl: signed(path, 'view'), error: null })),
    error: null,
  })),
  createSignedUrl: vi.fn((path: string) => new Promise((resolve) => {
    release.push(() => resolve({ data: { signedUrl: signed(path, 'thumb') }, error: null }))
  })),
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A fresh module, as after a reload. */
async function load() {
  vi.resetModules()
  return import('@/services/privateMedia')
}

beforeEach(() => {
  localStorage.clear()
  release = []
  bucket.createSignedUrls.mockClear()
  bucket.createSignedUrl.mockClear()
  vi.mocked(supabase.storage.from).mockReturnValue(bucket as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('signed URLs across reloads', () => {
  it('a reload serves the URLs signed before it without signing again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const before = await load()
    expect(before.mediaPartSource({ path: WEBP })).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(before.mediaPartSource({ path: WEBP })).toBe(signed(WEBP, 'view'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(1)

    const after = await load()
    expect(after.mediaPartSource({ path: WEBP })).toBe(signed(WEBP, 'view'))
    await vi.advanceTimersByTimeAsync(0)
    expect(bucket.createSignedUrls).toHaveBeenCalledTimes(1)
  })

  it('does not load a URL within the refresh margin of its expiry', async () => {
    localStorage.setItem(KEY, JSON.stringify([
      [`original:${WEBP}`, signed(WEBP, 'old'), Date.now() + 5 * 60 * 1000],
    ]))
    const media = await load()
    expect(media.mediaPartSource({ path: WEBP })).toBeUndefined()
    await tick()
    expect(media.mediaPartSource({ path: WEBP })).toBe(signed(WEBP, 'view'))
  })

  it('sign-out forgets them, in memory and in storage', async () => {
    localStorage.setItem(KEY, JSON.stringify([
      [`original:${WEBP}`, signed(WEBP, 'kept'), Date.now() + 60 * 60 * 1000],
    ]))
    const media = await load()
    expect(media.mediaPartSource({ path: WEBP })).toBe(signed(WEBP, 'kept'))
    media.forgetSignedMediaUrls()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(media.mediaPartSource({ path: WEBP })).toBeUndefined()
  })

  it('never signs a thumbnail twice while its signing is in flight', async () => {
    const media = await load()
    media.mediaPartSource({ path: PNG }, 'thumbnail')
    await tick()
    media.mediaPartSource({ path: PNG }, 'thumbnail')
    await tick()
    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(1)
    release.forEach((r) => r())
    await tick()
    expect(media.mediaPartSource({ path: PNG }, 'thumbnail')).toBe(signed(PNG, 'thumb'))
    expect(bucket.createSignedUrl).toHaveBeenCalledTimes(1)
  })
})
