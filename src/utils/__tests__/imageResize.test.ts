import { describe, expect, it, vi } from 'vitest'
import {
  IMAGE_UPLOAD_LIMITS,
  MAX_IMAGE_SOURCE_BYTES,
  fitWithin,
  immutableObjectPath,
  immutableUploadOptions,
  isAnimatedImage,
  orientationMatrix,
  orientedSize,
  prepareImageUpload,
  readJpegOrientation,
  sniffImageFormat,
  type ImageCodec,
  type RenderTarget,
} from '@/utils/imageResize'

const bytes = (...parts: Array<number[] | Uint8Array | string>): Uint8Array => {
  const arrays = parts.map(p =>
    typeof p === 'string' ? Uint8Array.from(p, c => c.charCodeAt(0)) : Uint8Array.from(p),
  )
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0))
  let o = 0
  for (const a of arrays) { out.set(a, o); o += a.length }
  return out
}
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
const padding = (n: number) => new Uint8Array(n)

const pngChunk = (type: string, data: number[] = []) => bytes(be32(data.length), type, data, [0, 0, 0, 0])
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const IHDR = pngChunk('IHDR', [...be32(3000), ...be32(1000), 8, 6, 0, 0, 0])
const png = (...chunks: Uint8Array[]) =>
  bytes(PNG_SIGNATURE, IHDR, ...chunks, pngChunk('IDAT', [1, 2, 3]), pngChunk('IEND'))
const apng = (frames: number) => png(pngChunk('acTL', [...be32(frames), ...be32(0)]))

const gifFrame = bytes(
  [0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00],
  [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00],
  [0x02, 0x02, 0x44, 0x01, 0x00],
)
const gif = (frames: number) =>
  bytes('GIF89a', [1, 0, 1, 0, 0x80, 0, 0], [0, 0, 0, 255, 255, 255], ...Array(frames).fill(gifFrame), [0x3b])

const webpChunk = (type: string, data: number[]) =>
  bytes(type, le32(data.length), data, data.length & 1 ? [0] : [])
const webp = (...chunks: Uint8Array[]) => {
  const body = bytes('WEBP', ...chunks)
  return bytes('RIFF', le32(body.length), body)
}

/** JPEG whose APP1 carries IFD0 Orientation, in either byte order. */
const jpegWithOrientation = (orientation: number, order: 'II' | 'MM' = 'MM') => {
  const u16 = (n: number) => (order === 'II' ? [n & 255, n >> 8] : [n >> 8, n & 255])
  const u32 = (n: number) => (order === 'II' ? le32(n) : be32(n))
  const tiff = bytes(order, u16(42), u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(orientation), [0, 0], u32(0))
  const app1 = bytes('Exif', [0, 0], tiff)
  return bytes([0xff, 0xd8], [0xff, 0xe1], [(app1.length + 2) >> 8, (app1.length + 2) & 255], app1,
    [0xff, 0xdb, 0x00, 0x04, 0x00, 0x00], [0xff, 0xda, 0x00, 0x02], [0xff, 0xd9])
}
const JPEG_NO_EXIF = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46], [0xff, 0xda, 0x00, 0x02], [0xff, 0xd9])

const fileOf = (data: Uint8Array, name: string, type: string, extra = 4000) =>
  new File([bytes(data, padding(extra))], name, { type })

interface FakeCodecOptions {
  width: number
  height: number
  rotates?: boolean
  alpha?: boolean
  /** Bytes produced for each requested type; a type absent here comes back as image/png. */
  sizes?: Partial<Record<string, number>>
}

function fakeCodec(o: FakeCodecOptions) {
  const renders: RenderTarget[] = []
  const requested: string[] = []
  const decode = vi.fn(async () => ({ width: o.width, height: o.height, source: {} as CanvasImageSource, close: () => {} }))
  const codec: ImageCodec = {
    decode,
    appliesOrientation: async () => o.rotates ?? true,
    render: (_image, target) => {
      renders.push(target)
      return {
        encode: async type => {
          requested.push(type)
          const size = o.sizes?.[type]
          if (size === undefined) return new Blob([padding(o.sizes?.['image/png'] ?? 500)], { type: 'image/png' })
          return new Blob([padding(size)], { type })
        },
        hasAlpha: () => o.alpha ?? false,
      }
    },
  }
  return { codec, renders, requested, decode }
}

describe('fitWithin', () => {
  it('scales down to the binding bound and keeps the aspect', () => {
    expect(fitWithin(3000, 1000, 2560, 2560)).toEqual({ width: 2560, height: 853 })
    expect(fitWithin(2000, 2000, 1024, 1024)).toEqual({ width: 1024, height: 1024 })
    expect(fitWithin(1000, 4000, 2560, 2560)).toEqual({ width: 640, height: 2560 })
    expect(fitWithin(300, 1200, 256, 256)).toEqual({ width: 64, height: 256 })
  })

  it('never upscales and never rounds an edge to zero', () => {
    expect(fitWithin(500, 300, 1024, 1024)).toEqual({ width: 500, height: 300 })
    expect(fitWithin(10000, 1, 256, 256)).toEqual({ width: 256, height: 1 })
  })

  it('bounds each kind', () => {
    expect(IMAGE_UPLOAD_LIMITS.server_banner.maxWidth).toBe(2560)
    expect(IMAGE_UPLOAD_LIMITS.profile_banner.maxWidth).toBe(2560)
    expect(IMAGE_UPLOAD_LIMITS.avatar.maxWidth).toBe(1024)
    expect(IMAGE_UPLOAD_LIMITS.server_icon.maxWidth).toBe(1024)
    expect(IMAGE_UPLOAD_LIMITS.group_icon.maxWidth).toBe(1024)
    expect(IMAGE_UPLOAD_LIMITS.emoji).toMatchObject({ maxWidth: 256, maxHeight: 256, reencodeWithinBounds: false })
  })
})

describe('animated detection', () => {
  it('sniffs formats from magic bytes', () => {
    expect(sniffImageFormat(png())).toBe('png')
    expect(sniffImageFormat(gif(1))).toBe('gif')
    expect(sniffImageFormat(webp(webpChunk('VP8 ', [1, 2])))).toBe('webp')
    expect(sniffImageFormat(JPEG_NO_EXIF)).toBe('jpeg')
    expect(sniffImageFormat(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  })

  it('counts GIF frames', () => {
    expect(isAnimatedImage(gif(1))).toBe(false)
    expect(isAnimatedImage(gif(2))).toBe(true)
  })

  it('finds an APNG acTL ahead of IDAT', () => {
    expect(isAnimatedImage(png())).toBe(false)
    expect(isAnimatedImage(apng(3))).toBe(true)
    expect(isAnimatedImage(apng(1))).toBe(false)
  })

  it('reads the VP8X animation flag and ANIM chunks', () => {
    const vp8x = (flags: number) => webpChunk('VP8X', [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(isAnimatedImage(webp(webpChunk('VP8 ', [1, 2, 3])))).toBe(false)
    expect(isAnimatedImage(webp(vp8x(0x10), webpChunk('VP8 ', [1])))).toBe(false)
    expect(isAnimatedImage(webp(vp8x(0x02)))).toBe(true)
    expect(isAnimatedImage(webp(webpChunk('ANIM', [0, 0, 0, 0, 0, 0])))).toBe(true)
  })

  it('treats JPEG as static', () => {
    expect(isAnimatedImage(JPEG_NO_EXIF)).toBe(false)
  })
})

describe('orientation', () => {
  it('reads the EXIF orientation in both byte orders', () => {
    expect(readJpegOrientation(jpegWithOrientation(6, 'MM'))).toBe(6)
    expect(readJpegOrientation(jpegWithOrientation(8, 'II'))).toBe(8)
    expect(readJpegOrientation(jpegWithOrientation(3, 'II'))).toBe(3)
  })

  it('defaults to 1 without EXIF, outside JPEG, and for out-of-range values', () => {
    expect(readJpegOrientation(JPEG_NO_EXIF)).toBe(1)
    expect(readJpegOrientation(png())).toBe(1)
    expect(readJpegOrientation(jpegWithOrientation(9))).toBe(1)
  })

  it('transposes the size for 5–8 only', () => {
    expect(orientedSize(1, 4000, 3000)).toEqual({ width: 4000, height: 3000 })
    expect(orientedSize(3, 4000, 3000)).toEqual({ width: 4000, height: 3000 })
    expect(orientedSize(6, 4000, 3000)).toEqual({ width: 3000, height: 4000 })
    expect(orientedSize(8, 4000, 3000)).toEqual({ width: 3000, height: 4000 })
  })

  const apply = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

  it('maps raster corners to the upright canvas', () => {
    // 4×3 raster. Orientation 6: the top row becomes the right column.
    const m6 = orientationMatrix(6, 4, 3)
    expect(apply(m6, 0, 0)).toEqual([3, 0])
    expect(apply(m6, 4, 0)).toEqual([3, 4])
    expect(apply(m6, 0, 3)).toEqual([0, 0])
    // Orientation 8: the top row becomes the left column, bottom to top.
    const m8 = orientationMatrix(8, 4, 3)
    expect(apply(m8, 0, 0)).toEqual([0, 4])
    expect(apply(m8, 4, 0)).toEqual([0, 0])
    // Orientation 3: 180°.
    expect(apply(orientationMatrix(3, 4, 3), 0, 0)).toEqual([4, 3])
    expect(orientationMatrix(1, 4, 3)).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('draws EXIF rotation itself when the decoder does not', async () => {
    const { codec, renders } = fakeCodec({ width: 4000, height: 3000, rotates: false, sizes: { 'image/webp': 900 } })
    const result = await prepareImageUpload(fileOf(jpegWithOrientation(6), 'photo.jpg', 'image/jpeg'), 'avatar', codec)
    expect(renders).toEqual([{ width: 768, height: 1024, orientation: 6 }])
    expect(result.reencoded).toBe(true)
  })

  it('leaves rotation to a decoder that already applies it', async () => {
    const { codec, renders } = fakeCodec({ width: 3000, height: 4000, rotates: true, sizes: { 'image/webp': 900 } })
    await prepareImageUpload(fileOf(jpegWithOrientation(6), 'photo.jpg', 'image/jpeg'), 'avatar', codec)
    expect(renders).toEqual([{ width: 768, height: 1024, orientation: 1 }])
  })
})

describe('prepareImageUpload', () => {
  it('shrinks a large banner to WebP', async () => {
    const { codec, renders } = fakeCodec({ width: 3000, height: 1000, sizes: { 'image/webp': 1200 } })
    const original = fileOf(png(), 'banner.png', 'image/png')
    const result = await prepareImageUpload(original, 'server_banner', codec)
    expect(renders).toEqual([{ width: 2560, height: 853, orientation: 1 }])
    expect(result).toMatchObject({ extension: 'webp', contentType: 'image/webp', reencoded: true })
    expect(result.file.name).toBe('banner.webp')
    expect(result.file.type).toBe('image/webp')
    expect(result.file.size).toBe(1200)
  })

  it('keeps the original when the WebP is not smaller', async () => {
    const original = fileOf(png(), 'icon.png', 'image/png', 100)
    const { codec } = fakeCodec({ width: 800, height: 800, sizes: { 'image/webp': original.size + 1 } })
    const result = await prepareImageUpload(original, 'server_icon', codec)
    expect(result.file).toBe(original)
    expect(result).toMatchObject({ extension: 'png', contentType: 'image/png', reencoded: false })
  })

  it('keeps an oversized original when the downscaled WebP is still larger', async () => {
    const original = fileOf(png(), 'flat.png', 'image/png', 100)
    const { codec, renders } = fakeCodec({ width: 3000, height: 1000, sizes: { 'image/webp': original.size * 3 } })
    const result = await prepareImageUpload(original, 'profile_banner', codec)
    expect(renders).toHaveLength(1)
    expect(result.file).toBe(original)
  })

  it('never decodes animated images', async () => {
    const { codec, decode } = fakeCodec({ width: 2000, height: 2000, sizes: { 'image/webp': 10 } })
    for (const [data, name, type] of [
      [gif(2), 'party.gif', 'image/gif'],
      [apng(4), 'spin.png', 'image/png'],
      [webp(webpChunk('VP8X', [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'loop.webp', 'image/webp'],
    ] as const) {
      const original = fileOf(data, name, type)
      const result = await prepareImageUpload(original, 'emoji', codec)
      expect(result.file).toBe(original)
      expect(result.reencoded).toBe(false)
    }
    expect(decode).not.toHaveBeenCalled()
  })

  it('leaves emoji within 256 px alone and downscales larger ones', async () => {
    const small = fakeCodec({ width: 200, height: 200, sizes: { 'image/webp': 10 } })
    const kept = fileOf(png(), 'small.png', 'image/png')
    expect((await prepareImageUpload(kept, 'emoji', small.codec)).file).toBe(kept)
    expect(small.renders).toHaveLength(0)

    const large = fakeCodec({ width: 512, height: 384, sizes: { 'image/webp': 10 } })
    const shrunk = await prepareImageUpload(fileOf(png(), 'large.png', 'image/png'), 'emoji', large.codec)
    expect(large.renders).toEqual([{ width: 256, height: 192, orientation: 1 }])
    expect(shrunk.extension).toBe('webp')
  })

  it('re-encodes icons already within bounds when that is smaller', async () => {
    const { codec, renders } = fakeCodec({ width: 512, height: 512, sizes: { 'image/webp': 300 } })
    const result = await prepareImageUpload(fileOf(png(), 'icon.png', 'image/png'), 'server_icon', codec)
    expect(renders).toEqual([{ width: 512, height: 512, orientation: 1 }])
    expect(result.contentType).toBe('image/webp')
  })

  it('falls back to JPEG for opaque pixels where WebP encoding is absent', async () => {
    const { codec, requested } = fakeCodec({ width: 3000, height: 1000, alpha: false, sizes: { 'image/jpeg': 700 } })
    const result = await prepareImageUpload(fileOf(png(), 'shot.png', 'image/png'), 'server_banner', codec)
    expect(requested).toEqual(['image/webp', 'image/jpeg'])
    expect(result).toMatchObject({ extension: 'jpg', contentType: 'image/jpeg', reencoded: true })
    expect(result.file.name).toBe('shot.jpg')
  })

  it('falls back to PNG for transparent pixels where WebP encoding is absent', async () => {
    const { codec, requested } = fakeCodec({ width: 2000, height: 2000, alpha: true, sizes: { 'image/png': 600 } })
    const result = await prepareImageUpload(fileOf(png(), 'logo.png', 'image/png'), 'server_icon', codec)
    expect(requested).toEqual(['image/webp', 'image/png'])
    expect(result).toMatchObject({ extension: 'png', contentType: 'image/png', reencoded: true })
  })

  it('never reads or decodes files past the source bound', async () => {
    const { codec, decode } = fakeCodec({ width: 6000, height: 4000, sizes: { 'image/webp': 10 } })
    const huge = new File([png(), padding(MAX_IMAGE_SOURCE_BYTES)], 'huge.png', { type: 'image/png' })
    const read = vi.spyOn(huge, 'arrayBuffer')
    const result = await prepareImageUpload(huge, 'avatar', codec)
    expect(result.file).toBe(huge)
    expect(read).not.toHaveBeenCalled()
    expect(decode).not.toHaveBeenCalled()
  })

  it('keeps files it cannot decode or does not recognise', async () => {
    const undecodable: ImageCodec = { ...fakeCodec({ width: 1, height: 1 }).codec, decode: async () => null }
    const broken = fileOf(png(), 'broken.png', 'image/png')
    expect((await prepareImageUpload(broken, 'avatar', undecodable)).file).toBe(broken)

    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', { type: 'image/svg+xml' })
    const result = await prepareImageUpload(svg, 'avatar', undecodable)
    expect(result).toMatchObject({ file: svg, extension: 'svg', contentType: 'image/svg+xml', reencoded: false })
  })
})

describe('immutable object names', () => {
  it('stamps each name with the upload time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_790_000_000_123)
    expect(immutableObjectPath('srv', 'banner', 'webp')).toBe('srv/banner-1790000000123.webp')
    vi.useRealTimers()
  })

  it('never upserts and caches for a year', () => {
    const options = immutableUploadOptions({ file: new File([], 'a.webp'), extension: 'webp', contentType: 'image/webp', reencoded: true })
    expect(options).toEqual({ contentType: 'image/webp', cacheControl: '31536000', upsert: false })
  })
})
