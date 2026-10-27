import { describe, expect, it } from 'vitest'
import {
  STICKER_MAX_BYTES,
  readStickerImageInfo,
  stickerFileProblem,
  stickerNameFromFile,
  stickerTextProblem,
} from '@/utils/stickerImage'

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
const be16 = (n: number) => [(n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]

const pngChunk = (type: string, data: number[] = []) => bytes(be32(data.length), type, data, [0, 0, 0, 0])
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const ihdr = (w: number, h: number) => pngChunk('IHDR', [...be32(w), ...be32(h), 8, 6, 0, 0, 0])
/** fcTL: sequence, size, offset, delay_num/delay_den, dispose, blend. */
const fctl = (num: number, den: number) =>
  pngChunk('fcTL', [...be32(0), ...be32(1), ...be32(1), ...be32(0), ...be32(0), ...be16(num), ...be16(den), 0, 0])
const png = (w: number, h: number, ...chunks: Uint8Array[]) =>
  bytes(PNG_SIGNATURE, ihdr(w, h), ...chunks, pngChunk('IDAT', [1, 2, 3]), pngChunk('IEND'))
const apng = (w: number, h: number, delays: Array<[number, number]>) =>
  png(w, h, pngChunk('acTL', [...be32(delays.length), ...be32(0)]), ...delays.map(([n, d]) => fctl(n, d)))

/** GIF frame with a Graphic Control Extension delay in centiseconds. */
const gifFrame = (cs: number) => bytes(
  [0x21, 0xf9, 0x04, 0x00, ...le16(cs), 0x00, 0x00],
  [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00],
  [0x02, 0x02, 0x44, 0x01, 0x00],
)
const gif = (w: number, h: number, delays: number[]) =>
  bytes('GIF89a', [...le16(w), ...le16(h), 0x80, 0, 0], [0, 0, 0, 255, 255, 255], ...delays.map(gifFrame), [0x3b])

const webpChunk = (type: string, data: number[]) => bytes(type, le32(data.length), data, data.length & 1 ? [0] : [])
const webp = (...chunks: Uint8Array[]) => {
  const body = bytes('WEBP', ...chunks)
  return bytes('RIFF', le32(body.length), body)
}
const vp8x = (w: number, h: number, animated: boolean) => webpChunk('VP8X', [animated ? 0x02 : 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)])
const anmf = (ms: number) => webpChunk('ANMF', [...le24(0), ...le24(0), ...le24(0), ...le24(0), ...le24(ms), 0])
/** VP8L: signature 0x2f, then 14-bit width-1 and height-1. */
const vp8l = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)
  return webpChunk('VP8L', [0x2f, ...le32(bits)])
}

describe('readStickerImageInfo', () => {
  it('reads a still PNG', () => {
    expect(readStickerImageInfo(png(320, 200))).toEqual({ format: 'png', width: 320, height: 200, animated: false, durationMs: null })
  })

  it('sums APNG frame delays; a zero denominator is hundredths', () => {
    expect(readStickerImageInfo(apng(160, 160, [[1, 2], [50, 0], [250, 1000]])))
      .toEqual({ format: 'png', width: 160, height: 160, animated: true, durationMs: 1250 })
  })

  it('reads one APNG frame as still', () => {
    expect(readStickerImageInfo(apng(64, 64, [[1, 1]]))?.animated).toBe(false)
  })

  it('sums GIF delays, counting delays at or under 10 ms as 100 ms', () => {
    expect(readStickerImageInfo(gif(300, 240, [50, 50, 0, 1]))).toEqual({
      format: 'gif', width: 300, height: 240, animated: true, durationMs: 500 + 500 + 100 + 100,
    })
    expect(readStickerImageInfo(gif(10, 10, [20]))).toMatchObject({ animated: false, durationMs: null })
  })

  it('reads an animated WebP canvas and frame durations', () => {
    expect(readStickerImageInfo(webp(vp8x(320, 320, true), webpChunk('ANIM', [0, 0, 0, 0, 0, 0]), anmf(2000), anmf(2500), anmf(5))))
      .toEqual({ format: 'webp', width: 320, height: 320, animated: true, durationMs: 4600 })
  })

  it('reads a lossless WebP without VP8X', () => {
    expect(readStickerImageInfo(webp(vp8l(200, 100)))).toEqual({ format: 'webp', width: 200, height: 100, animated: false, durationMs: null })
  })

  it('refuses JPEG, SVG and unknown bytes', () => {
    expect(readStickerImageInfo(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBeNull()
    expect(readStickerImageInfo(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(readStickerImageInfo(bytes('RIFF', le32(4), 'WEBP'))).toBeNull()
  })
})

describe('stickerFileProblem', () => {
  const still = { format: 'png' as const, width: 320, height: 320, animated: false, durationMs: null }
  it('accepts a file at every limit', () => {
    expect(stickerFileProblem(still, STICKER_MAX_BYTES)).toBeNull()
    expect(stickerFileProblem({ ...still, animated: true, durationMs: 5000 }, 1)).toBeNull()
  })
  it('names the first limit broken', () => {
    expect(stickerFileProblem(null, 1)).toBe('type')
    expect(stickerFileProblem(still, STICKER_MAX_BYTES + 1)).toBe('size')
    expect(stickerFileProblem({ ...still, width: 321 }, 1)).toBe('dimensions')
    expect(stickerFileProblem({ ...still, animated: true, durationMs: 5001 }, 1)).toBe('duration')
  })
})

describe('stickerTextProblem', () => {
  it('mirrors sticker_check_text', () => {
    expect(stickerTextProblem('Cat wave', 'A cat waving')).toBeNull()
    expect(stickerTextProblem(' w ', 'x')).toBe('nameLength')
    expect(stickerTextProblem('w'.repeat(31), 'x')).toBe('nameLength')
    expect(stickerTextProblem('tab\there', 'x')).toBe('nameLength')
    expect(stickerTextProblem('Cat', '   ')).toBe('descriptionMissing')
    expect(stickerTextProblem('Cat', 'x'.repeat(301))).toBe('descriptionLength')
  })
  it('counts characters, not UTF-16 units', () => {
    expect(stickerTextProblem('😀'.repeat(30), 'x')).toBeNull()
  })
})

describe('stickerNameFromFile', () => {
  it('turns a file stem into a name of at most 30 characters', () => {
    expect(stickerNameFromFile('cat_wave-final.png')).toBe('cat wave final')
    expect(stickerNameFromFile(`${'a'.repeat(40)}.gif`)).toHaveLength(30)
  })
})
