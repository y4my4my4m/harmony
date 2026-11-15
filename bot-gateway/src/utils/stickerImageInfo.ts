/**
 * Sticker image facts read from file headers. A port of readStickerImageInfo and its readers
 * from src/utils/stickerImage.ts, which the gateway cannot import. The two must agree: change
 * both, with the same limits (the database enforces them too, 20261031200001_custom_stickers.sql).
 */

export const STICKER_MAX_BYTES = 512 * 1024
export const STICKER_MAX_SIDE = 320
export const STICKER_MAX_DURATION_MS = 5000

export type StickerFormat = 'png' | 'gif' | 'webp'

export interface StickerImageInfo {
  format: StickerFormat
  width: number
  height: number
  animated: boolean
  /** One loop, in ms; null for a still image. */
  durationMs: number | null
}

/**
 * Frame delays at or under 10 ms play at 100 ms in Chromium and Firefox (GIF, APNG and
 * animated WebP alike); the duration counts what viewers see.
 */
const MIN_PLAYED_DELAY_MS = 10
const CLAMPED_DELAY_MS = 100

function playedDelay(ms: number): number {
  return ms <= MIN_PLAYED_DELAY_MS ? CLAMPED_DELAY_MS : ms
}

function ascii(b: Uint8Array, offset: number, length: number): string {
  if (offset + length > b.length) return ''
  let s = ''
  for (let i = offset; i < offset + length; i++) s += String.fromCharCode(b[i])
  return s
}

function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8)
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1]
}

function u24le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

/** PNG and APNG: IHDR at offset 8; acTL frame count; fcTL delay_num/delay_den (0 den is 100). */
function readPng(b: Uint8Array): StickerImageInfo | null {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null
  const width = u32be(b, 16)
  const height = u32be(b, 20)
  let frames = 0
  let durationMs = 0
  let p = 8
  while (p + 8 <= b.length) {
    const length = u32be(b, p)
    const type = ascii(b, p + 4, 4)
    if (type === 'acTL' && p + 12 <= b.length) frames = u32be(b, p + 8)
    if (type === 'fcTL' && p + 8 + 24 <= b.length) {
      const num = u16be(b, p + 8 + 20)
      const den = u16be(b, p + 8 + 22) || 100
      durationMs += playedDelay((num * 1000) / den)
    }
    if (type === 'IEND') break
    p += 12 + length
  }
  const animated = frames > 1
  return { format: 'png', width, height, animated, durationMs: animated ? Math.round(durationMs) : null }
}

function skipGifSubBlocks(b: Uint8Array, p: number): number {
  while (p < b.length) {
    const size = b[p]
    p += 1
    if (size === 0) return p
    p += size
  }
  return p
}

/** GIF: logical screen size at 6; Graphic Control Extension delays, in centiseconds. */
function readGif(b: Uint8Array): StickerImageInfo | null {
  if (b.length < 13) return null
  const width = u16le(b, 6)
  const height = u16le(b, 8)
  let p = 13
  const screenFlags = b[10]
  if (screenFlags & 0x80) p += 3 * (1 << ((screenFlags & 0x07) + 1))
  let frames = 0
  let durationMs = 0
  let pendingDelay = 0
  while (p < b.length) {
    const block = b[p]
    if (block === 0x2c) {
      frames += 1
      durationMs += playedDelay(pendingDelay)
      pendingDelay = 0
      if (p + 10 > b.length) break
      const localFlags = b[p + 9]
      p += 10
      if (localFlags & 0x80) p += 3 * (1 << ((localFlags & 0x07) + 1))
      p = skipGifSubBlocks(b, p + 1)
    } else if (block === 0x21) {
      if (b[p + 1] === 0xf9 && p + 6 <= b.length) pendingDelay = u16le(b, p + 4) * 10
      p = skipGifSubBlocks(b, p + 2)
    } else {
      break
    }
  }
  const animated = frames > 1
  return { format: 'gif', width, height, animated, durationMs: animated ? durationMs : null }
}

/** WebP: VP8X canvas, else the VP8 or VP8L frame header; ANMF frame durations in ms. */
function readWebp(b: Uint8Array): StickerImageInfo | null {
  let width = 0
  let height = 0
  let frames = 0
  let durationMs = 0
  let p = 12
  while (p + 8 <= b.length) {
    const type = ascii(b, p, 4)
    const length = u32le(b, p + 4)
    const data = p + 8
    if (type === 'VP8X' && data + 10 <= b.length) {
      width = u24le(b, data + 4) + 1
      height = u24le(b, data + 7) + 1
    } else if (type === 'VP8 ' && !width && data + 10 <= b.length) {
      width = u16le(b, data + 6) & 0x3fff
      height = u16le(b, data + 8) & 0x3fff
    } else if (type === 'VP8L' && !width && data + 5 <= b.length && b[data] === 0x2f) {
      const bits = u32le(b, data + 1)
      width = (bits & 0x3fff) + 1
      height = ((bits >>> 14) & 0x3fff) + 1
    } else if (type === 'ANMF' && data + 16 <= b.length) {
      frames += 1
      durationMs += playedDelay(u24le(b, data + 12))
    }
    p = data + length + (length & 1)
  }
  if (!width || !height) return null
  const animated = frames > 1
  return { format: 'webp', width, height, animated, durationMs: animated ? durationMs : null }
}

/** Size, animation and loop duration of a PNG, APNG, GIF or WebP; null for anything else. */
export function readStickerImageInfo(b: Uint8Array): StickerImageInfo | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return readPng(b)
  if (ascii(b, 0, 4) === 'GIF8') return readGif(b)
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return readWebp(b)
  return null
}
