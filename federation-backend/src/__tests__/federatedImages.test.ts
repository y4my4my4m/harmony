import { describe, it, expect, vi, beforeEach } from 'vitest'

// Photos of a local post federate as their storage render when larger than the instance's
// cap (federate_image_max_px); the stamped cap of the post wins over the current setting.

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    SUPABASE_URL: 'http://supabase-kong:8000',
    PUBLIC_SUPABASE_URL: 'https://api.harmony.test',
  },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/urlUtils.js', () => ({
  getFullAvatarUrl: vi.fn((url: string | null) => url || null),
  getFullBannerUrl: vi.fn((url: string | null) => url || null),
  getFullEmojiUrl: vi.fn((url: string | null) => url || null),
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const store = vi.hoisted(() => ({ config: [] as Array<{ config_key: string; config_value: unknown }>, reads: 0 }))

function query(table: string) {
  const filters: Array<(row: any) => boolean> = []
  const all = () => (table === 'instance_config' ? store.config : []).filter((r: any) => filters.every((f) => f(r)))
  const q: any = {
    select: () => q,
    eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
    in: () => q,
    maybeSingle: async () => {
      if (table === 'instance_config') store.reads++
      return { data: all()[0] ?? null, error: null }
    },
    single: async () => ({ data: all()[0] ?? null, error: null }),
    then: (resolve: any) => resolve({ data: all(), error: null }),
  }
  return q
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from: (t: string) => query(t) }),
}))

const { postToNote } = await import('../activitypub/converters/toActivityPub.js')
const { buildLocalNote } = await import('../listeners/FederationHandlers.js')
const {
  federatedImage,
  getFederateImageMaxPx,
  parseImageMaxPx,
  postImageMaxPx,
  resetFederateImageMaxPxCache,
} = await import('../utils/federatedImages.js')

const author = { username: 'alice' }
const OBJECT = 'https://api.harmony.test/storage/v1/object/public/user_media/u1/posts/photo.jpg'
const RENDER = 'https://api.harmony.test/storage/v1/render/image/public/user_media/u1/posts/photo.jpg'

function postWith(media: any[], extra: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    content: [{ type: 'text', text: 'photo' }],
    visibility: 'public',
    created_at: '2026-11-07T00:00:00Z',
    media_attachments: media,
    ...extra,
  }
}

function attachments(media: any[], imageMaxPx?: number, content?: any[]) {
  const post = postWith(media, content ? { content } : {})
  return postToNote(post, author, undefined, undefined, { imageMaxPx }).attachment ?? []
}

const jpeg = (width?: number, height?: number, extra: Record<string, unknown> = {}) => ({
  type: 'Image', url: OBJECT, mediaType: 'image/jpeg', name: 'photo.jpg', width, height, ...extra,
})

beforeEach(() => {
  store.config = []
  store.reads = 0
  resetFederateImageMaxPxCache()
})

describe('postToNote photo size', () => {
  it('sends a large local JPEG as its render, fitted inside the cap', () => {
    const [a] = attachments([jpeg(3000, 2000)], 1920)
    expect(a).toMatchObject({
      type: 'Document',
      mediaType: 'image/jpeg',
      url: `${RENDER}?width=1920&height=1920&resize=contain&quality=85&format=origin`,
      width: 1920,
      height: 1280,
    })
  })

  it('fits a portrait PNG by its height', () => {
    const [a] = attachments([{ ...jpeg(1500, 4000), url: OBJECT.replace('.jpg', '.png'), mediaType: 'image/png' }], 1920)
    expect(a.url).toBe(`${RENDER.replace('.jpg', '.png')}?width=1920&height=1920&resize=contain&quality=85&format=origin`)
    expect([a.width, a.height]).toEqual([720, 1920])
    expect(a.mediaType).toBe('image/png')
  })

  it('sends a photo within the cap as stored', () => {
    const [a] = attachments([jpeg(1920, 1080)], 1920)
    expect(a).toMatchObject({ url: OBJECT, width: 1920, height: 1080 })
  })

  it('sends a GIF, an animated WebP and an APNG as stored', () => {
    const gif = { ...jpeg(3000, 2000), url: OBJECT.replace('.jpg', '.gif'), mediaType: 'image/gif' }
    const webp = { ...jpeg(3000, 2000, { animated: true }), url: OBJECT.replace('.jpg', '.webp'), mediaType: 'image/webp' }
    const apng = { ...jpeg(3000, 2000), url: OBJECT.replace('.jpg', '.apng'), mediaType: 'image/png' }
    const svg = { ...jpeg(3000, 2000), url: OBJECT.replace('.jpg', '.svg'), mediaType: 'image/svg+xml' }
    const sent = attachments([gif, webp, apng, svg], 1920)
    expect(sent.map((a: any) => a.url)).toEqual([gif.url, webp.url, apng.url, svg.url])
    expect(sent.map((a: any) => [a.width, a.height])).toEqual([[3000, 2000], [3000, 2000], [3000, 2000], [3000, 2000]])
  })

  it('sends originals under a cap of 0 or without one', () => {
    expect(attachments([jpeg(3000, 2000)], 0)[0]).toMatchObject({ url: OBJECT, width: 3000, height: 2000 })
    expect(attachments([jpeg(3000, 2000)])[0]).toMatchObject({ url: OBJECT, width: 3000, height: 2000 })
  })

  it('sends a photo of unknown size, a remote one and one over 50 MP as stored', () => {
    const unknown = attachments([jpeg()], 1920)[0]
    expect(unknown.url).toBe(OBJECT)
    expect(unknown).not.toHaveProperty('width')
    const remote = 'https://elsewhere.example/storage/v1/object/public/user_media/u1/posts/photo.jpg'
    expect(attachments([{ ...jpeg(3000, 2000), url: remote }], 1920)[0].url).toBe(remote)
    expect(attachments([jpeg(10000, 5001)], 1920)[0]).toMatchObject({ url: OBJECT, width: 10000, height: 5001 })
  })

  it('clamps a cap over the render limit to 2000 px', () => {
    const [a] = attachments([jpeg(6000, 4000)], 4000)
    expect(a.url).toBe(`${RENDER}?width=2000&height=2000&resize=contain&quality=85&format=origin`)
    expect([a.width, a.height]).toEqual([2000, 1333])
  })

  it('reads the Mastodon meta.original size of imported rows', () => {
    const [a] = attachments([{ type: 'image', url: OBJECT, mime_type: 'image/jpeg', meta: { original: { width: 4000, height: 3000 } } }], 1000)
    expect([a.width, a.height]).toEqual([1000, 750])
    expect(a.url.startsWith(`${RENDER}?width=1000`)).toBe(true)
  })

  it('maps a content file part the same way and sends it once', () => {
    const content = [
      { type: 'text', text: 'photo' },
      { type: 'file', url: OBJECT, mimeType: 'image/jpeg', width: 3000, height: 2000 },
    ]
    const sent = attachments([jpeg(3000, 2000)], 1920, content)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ width: 1920, height: 1280 })
    expect(sent[0].url.startsWith(`${RENDER}?`)).toBe(true)
  })

  it('accepts storage on the instance domain', () => {
    const own = 'https://harmony.test/storage/v1/object/public/user_media/u1/posts/photo.jpg'
    expect(federatedImage({ url: own, mediaType: 'image/jpeg', width: 3000, height: 2000 }, 1920).url)
      .toBe('https://harmony.test/storage/v1/render/image/public/user_media/u1/posts/photo.jpg?width=1920&height=1920&resize=contain&quality=85&format=origin')
  })
})

describe('the cap a post federates under', () => {
  it('parses the stored setting', () => {
    expect(parseImageMaxPx(1280)).toBe(1280)
    expect(parseImageMaxPx('1024')).toBe(1024)
    expect(parseImageMaxPx(0)).toBe(0)
    expect(parseImageMaxPx(-1)).toBe(1920)
    expect(parseImageMaxPx(null)).toBe(1920)
    expect(parseImageMaxPx('big')).toBe(1920)
  })

  it('reads the setting once per minute', async () => {
    store.config = [{ config_key: 'federate_image_max_px', config_value: 1280 }]
    expect(await getFederateImageMaxPx(1_000)).toBe(1280)
    store.config = [{ config_key: 'federate_image_max_px', config_value: 0 }]
    expect(await getFederateImageMaxPx(30_000)).toBe(1280)
    expect(await getFederateImageMaxPx(62_000)).toBe(0)
    expect(store.reads).toBe(2)
  })

  it('takes the cap stamped on the post over the current setting', async () => {
    store.config = [{ config_key: 'federate_image_max_px', config_value: 0 }]
    expect(await postImageMaxPx({ metadata: { federate_image_max_px: 1920 } })).toBe(1920)
    expect(store.reads).toBe(0)
    expect(await postImageMaxPx({ metadata: {} })).toBe(0)
  })

  it('builds the Note of a stamped post with its render after the setting changed', async () => {
    store.config = [{ config_key: 'federate_image_max_px', config_value: 0 }]
    const stamped = postWith([jpeg(3000, 2000)], { metadata: { federate_image_max_px: 1920 }, author_id: 'a1' })
    const note = await buildLocalNote(stamped, author)
    expect(note.attachment[0]).toMatchObject({ width: 1920, height: 1280 })
    expect(note.attachment[0].url.startsWith(`${RENDER}?`)).toBe(true)

    const unstamped = postWith([jpeg(3000, 2000)], { metadata: {}, author_id: 'a1' })
    expect((await buildLocalNote(unstamped, author)).attachment[0].url).toBe(OBJECT)
  })
})
