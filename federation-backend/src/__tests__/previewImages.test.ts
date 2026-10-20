import { describe, it, expect, vi, beforeEach } from 'vitest'

// Link preview images copied to the instance's storage: raster images only, one retry on a
// rate limit or server error, stored once per source URL, and no copy for anything else.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', PUBLIC_SUPABASE_URL: 'https://harmony.test/', SUPABASE_URL: 'http://kong:8000' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
const upload = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<{ error: { message: string } | null }> => ({ error: null })))
const from = vi.hoisted(() => vi.fn((_bucket: string) => ({ upload })))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({ storage: { from } }) }))
const safeFetch = vi.hoisted(() => vi.fn())
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch }))

const { previewImageStore, sniffImageType, PREVIEW_IMAGE_BUCKET } = await import('../services/previewImages.js')

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const GIF = new TextEncoder().encode('GIF89a....')
const WEBP = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')
const AVIF = new Uint8Array([0, 0, 0, 28, ...new TextEncoder().encode('ftypavif')])
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

const reply = (body: Uint8Array | string, status = 200, type = 'image/png') =>
  new Response(typeof body === 'string' ? body : new Blob([body as Uint8Array<ArrayBuffer>]), { status, headers: { 'content-type': type } })

let n = 0
const fresh = () => `https://img${++n}.example/card.png`

beforeEach(() => {
  safeFetch.mockReset()
  upload.mockClear()
  upload.mockResolvedValue({ error: null })
  vi.useRealTimers()
})

describe('sniffImageType', () => {
  it('knows the raster formats by their bytes, and nothing else', () => {
    expect(sniffImageType(PNG)).toEqual({ mime: 'image/png', ext: 'png' })
    expect(sniffImageType(JPEG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' })
    expect(sniffImageType(GIF)).toEqual({ mime: 'image/gif', ext: 'gif' })
    expect(sniffImageType(WEBP)).toEqual({ mime: 'image/webp', ext: 'webp' })
    expect(sniffImageType(AVIF)).toEqual({ mime: 'image/avif', ext: 'avif' })
    expect(sniffImageType(SVG)).toBeNull()
    expect(sniffImageType(new TextEncoder().encode('Too many requests, please try again later.'))).toBeNull()
  })
})

describe('previewImageStore.host', () => {
  it('stores the image under a name taken from its URL and answers with its public URL', async () => {
    const url = fresh()
    safeFetch.mockResolvedValueOnce(reply(PNG))
    const hosted = await previewImageStore.host(url)
    expect(hosted).toMatch(/^https:\/\/harmony\.test\/storage\/v1\/object\/public\/link-preview-images\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/)
    expect(from).toHaveBeenCalledWith(PREVIEW_IMAGE_BUCKET)
    const [path, bytes, options] = upload.mock.calls[0]
    expect(hosted!.endsWith(path as string)).toBe(true)
    expect(bytes).toEqual(PNG)
    expect(options).toMatchObject({ contentType: 'image/png', upsert: true })
    const [, init] = safeFetch.mock.calls[0]
    expect(init.maxBodyBytes).toBe(5 * 1024 * 1024)
  })

  it('tries once more after a rate limit (GitHub answers cache misses with 429)', async () => {
    vi.useFakeTimers()
    const url = fresh()
    safeFetch
      .mockResolvedValueOnce(reply('Too many requests, please try again later.', 429, 'text/html; charset=utf-8'))
      .mockResolvedValueOnce(reply(JPEG, 200, 'image/jpeg'))
    const job = previewImageStore.host(url)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await job).toMatch(/\.jpg$/)
    expect(safeFetch).toHaveBeenCalledTimes(2)
  })

  it('gives up after a second refusal, and does not ask again for a while', async () => {
    vi.useFakeTimers()
    const url = fresh()
    safeFetch.mockResolvedValue(reply('busy', 503, 'text/plain'))
    const job = previewImageStore.host(url)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await job).toBeNull()
    expect(safeFetch).toHaveBeenCalledTimes(2)
    expect(await previewImageStore.host(url)).toBeNull()
    expect(safeFetch).toHaveBeenCalledTimes(2)
    expect(upload).not.toHaveBeenCalled()
  })

  it('stores no SVG, HTML or missing image', async () => {
    safeFetch.mockResolvedValueOnce(reply(SVG, 200, 'image/svg+xml'))
    expect(await previewImageStore.host(fresh())).toBeNull()
    safeFetch.mockResolvedValueOnce(reply('<html></html>', 200, 'text/html'))
    expect(await previewImageStore.host(fresh())).toBeNull()
    safeFetch.mockResolvedValueOnce(reply('', 404, 'text/plain'))
    expect(await previewImageStore.host(fresh())).toBeNull()
    safeFetch.mockRejectedValueOnce(new Error('safeFetch: blocked address'))
    expect(await previewImageStore.host(fresh())).toBeNull()
    expect(upload).not.toHaveBeenCalled()
  })

  it('fetches and stores an image once for concurrent and later previews', async () => {
    const url = fresh()
    safeFetch.mockResolvedValue(reply(GIF, 200, 'image/gif'))
    const [a, b] = await Promise.all([previewImageStore.host(url), previewImageStore.host(url)])
    expect(a).toBe(b)
    expect(await previewImageStore.host(url)).toBe(a)
    expect(safeFetch).toHaveBeenCalledTimes(1)
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('answers null when storage refuses the upload', async () => {
    safeFetch.mockResolvedValueOnce(reply(WEBP, 200, 'image/webp'))
    upload.mockResolvedValueOnce({ error: { message: 'mime type not allowed' } })
    expect(await previewImageStore.host(fresh())).toBeNull()
  })
})
