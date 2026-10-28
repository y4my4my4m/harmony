import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { constants, crc32, deflateRawSync, deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IMAGE_MAX_BYTES,
  INFLATE_CHUNK_MAX_BYTES,
  TOP_LEVEL_BOX_MAX,
  orientationSegment,
  readMediaDetails,
  readSourceDetails,
  readTiff,
  stripMediaBytes,
  stripMediaMetadata,
  type ByteSource,
} from '@/utils/stripMetadata'
import { isAnimatedImage, readJpegOrientation } from '@/utils/imageResize'

/**
 * Fixtures in tests/fixtures/media-metadata: Pillow 13 JPEG/PNG/WebP/GIF, libheif HEIC/AVIF and
 * ffmpeg 9 H.264 MP4/MOV, each carrying Exif GPS (35°40'34" N 139°39'01" E), make HarmonyCam,
 * model "Fixture 1" and XMP GPS; JPEGs add APP13 IPTC (City Tokyo), COM, APP2 MPF and a trailer
 * after EOI; MP4s add moov/udta/©xyz; the MOV carries mdta keys and a top-level XMP uuid box.
 */
const FIXTURES = resolve(__dirname, '../../../tests/fixtures/media-metadata')
const LAST_MODIFIED = 1_700_000_000_000

function fixture(name: string, type: string): File {
  return new File([readFileSync(resolve(FIXTURES, name))], name, { type, lastModified: LAST_MODIFIED })
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

function latin1(b: Uint8Array): string {
  return Buffer.from(b).toString('latin1')
}

/** Metadata strings the fixtures carry; none survives stripping. */
const MARKERS = ['HarmonyCam', 'Fixture 1', 'SN-0042', 'GPSLatitude', '+35.6762', 'Tokyo', 'Fixture Photographer', 'fixture comment', 'TRAILER', 'ISO6709', '\xa9xyz']

function markersIn(b: Uint8Array): string[] {
  const s = latin1(b)
  return MARKERS.filter((m) => s.includes(m))
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** JPEG segments up to SOS: [marker, start, end]. */
function jpegSegments(b: Uint8Array): Array<[number, number, number]> {
  const segments: Array<[number, number, number]> = []
  let p = 2
  while (p + 4 <= b.length && b[p] === 0xff) {
    const marker = b[p + 1]
    const end = p + 2 + ((b[p + 2] << 8) | b[p + 3])
    segments.push([marker, p, end])
    if (marker === 0xda) break
    p = end
  }
  return segments
}

/** PNG chunks with their CRC checked. */
function pngChunks(b: Uint8Array): Array<{ type: string; data: Uint8Array }> {
  const chunks: Array<{ type: string; data: Uint8Array }> = []
  let p = 8
  while (p + 12 <= b.length) {
    const view = new DataView(b.buffer, b.byteOffset)
    const length = view.getUint32(p)
    const type = latin1(b.subarray(p + 4, p + 8))
    const data = b.subarray(p + 8, p + 8 + length)
    expect(view.getUint32(p + 8 + length) >>> 0).toBe(crc32(b.subarray(p + 4, p + 8 + length)) >>> 0)
    chunks.push({ type, data })
    p += 12 + length
  }
  expect(p).toBe(b.length)
  return chunks
}

/** WebP chunks; the RIFF size must match the file. */
function webpChunks(b: Uint8Array): Array<{ type: string; data: Uint8Array }> {
  const view = new DataView(b.buffer, b.byteOffset)
  expect(latin1(b.subarray(0, 4))).toBe('RIFF')
  expect(view.getUint32(4, true)).toBe(b.length - 8)
  const chunks: Array<{ type: string; data: Uint8Array }> = []
  let p = 12
  while (p + 8 <= b.length) {
    const length = view.getUint32(p + 4, true)
    chunks.push({ type: latin1(b.subarray(p, p + 4)), data: b.subarray(p + 8, p + 8 + length) })
    p += 8 + length + (length & 1)
  }
  expect(p).toBe(b.length)
  return chunks
}

/** ISO BMFF boxes in [start, end), sizes checked to tile the range exactly. */
function isoBoxes(b: Uint8Array, start = 0, end = b.length): Array<{ type: string; start: number; end: number }> {
  const view = new DataView(b.buffer, b.byteOffset)
  const boxes: Array<{ type: string; start: number; end: number }> = []
  let p = start
  while (p < end) {
    let size = view.getUint32(p)
    let header = 8
    if (size === 1) {
      size = Number(view.getBigUint64(p + 8))
      header = 16
    }
    if (size === 0) size = end - p
    expect(size).toBeGreaterThanOrEqual(header)
    boxes.push({ type: latin1(b.subarray(p + 4, p + 8)), start: p, end: p + size })
    p += size
  }
  expect(p).toBe(end)
  return boxes
}

async function expectStripped(input: File, container: string) {
  const before = await bytesOf(input)
  expect(markersIn(before).length).toBeGreaterThan(0)
  expect(await readMediaDetails(input)).toEqual({ container, location: true, details: true })

  const output = await stripMediaMetadata(input)
  expect(output).not.toBe(input)
  expect(output).toBeInstanceOf(File)
  expect(output.name).toBe(input.name)
  expect(output.type).toBe(input.type)
  expect(output.lastModified).toBe(LAST_MODIFIED)

  const after = await bytesOf(output)
  expect(markersIn(after)).toEqual([])
  expect(await readMediaDetails(output)).toEqual({ container, location: false, details: false })
  // A result is not stripped twice.
  expect(await stripMediaMetadata(output)).toBe(output)
  // A fresh copy of the result has nothing left either.
  const copy = new File([after], output.name, { type: output.type })
  expect(await readMediaDetails(copy)).toMatchObject({ location: false, details: false })
  expect(await stripMediaMetadata(copy)).toBe(copy)
  return { before, after }
}

describe('stripMediaMetadata: JPEG', () => {
  it('drops Exif, XMP, IPTC, COM, MPF and the trailer, keeps a minimal orientation APP1', async () => {
    const { before, after } = await expectStripped(fixture('gps-rotated.jpg', 'image/jpeg'), 'jpeg')
    expect(readJpegOrientation(before)).toBe(6)
    expect(readJpegOrientation(after)).toBe(6)

    const markers = jpegSegments(after).map(([marker]) => marker)
    // SOI, JFIF APP0, orientation APP1, ICC APP2, then the coding segments.
    expect(markers.slice(0, 3)).toEqual([0xe0, 0xe1, 0xe2])
    expect(markers.filter((m) => (m >= 0xe0 && m <= 0xef) || m === 0xfe)).toEqual([0xe0, 0xe1, 0xe2])
    const [, start, end] = jpegSegments(after)[1]
    expect(after.subarray(start, end)).toEqual(orientationSegment(6))
    expect(readTiff(after, start + 10, end)).toEqual({ orientation: 6, gps: false })
    expect(latin1(after)).toContain('ICC_PROFILE\0')
    expect(count(latin1(after), 'Exif\0\0')).toBe(1)

    // Entropy-coded data unchanged: from SOS to EOI, byte for byte; nothing after EOI.
    const sosBefore = jpegSegments(before).at(-1)![1]
    const sosAfter = jpegSegments(after).at(-1)![1]
    const eoi = latin1(before).lastIndexOf('\xff\xd9')
    expect(after.subarray(sosAfter)).toEqual(before.subarray(sosBefore, eoi + 2))
  })

  it('adds no Exif to an upright photo', async () => {
    const { after } = await expectStripped(fixture('gps-upright.jpg', 'image/jpeg'), 'jpeg')
    expect(count(latin1(after), 'Exif')).toBe(0)
    expect(readJpegOrientation(after)).toBe(1)
  })

  it('reads the GPS IFD', async () => {
    const before = await bytesOf(fixture('gps-rotated.jpg', 'image/jpeg'))
    const [, start, end] = jpegSegments(before).find(([m, s]) => m === 0xe1 && latin1(before.subarray(s + 4, s + 10)) === 'Exif\0\0')!
    expect(readTiff(before, start + 10, end)).toEqual({ orientation: 6, gps: true })
  })

  it('keeps an already minimal file as it is', async () => {
    const soi = new Uint8Array([0xff, 0xd8])
    const body = (await bytesOf(await stripMediaMetadata(fixture('gps-rotated.jpg', 'image/jpeg')))).subarray(2)
    const file = new File([soi, body], 'clean.jpg', { type: 'image/jpeg' })
    expect(await readMediaDetails(file)).toEqual({ container: 'jpeg', location: false, details: false })
    expect(await stripMediaMetadata(file)).toBe(file)
  })

  it('drops an Exif segment cut short by the end of the file', async () => {
    const before = await bytesOf(fixture('gps-rotated.jpg', 'image/jpeg'))
    // SOI, JFIF APP0 (18 bytes), then 20 of the Exif APP1's 258.
    const file = new File([before.subarray(0, 40)], 'cut.jpg', { type: 'image/jpeg' })
    expect(await readMediaDetails(file)).toEqual({ container: 'jpeg', location: false, details: true })
    expect(await bytesOf(await stripMediaMetadata(file))).toEqual(before.subarray(0, 20))
  })
})

describe('stripMediaMetadata: PNG', () => {
  it('drops eXIf, tEXt, iTXt, zTXt and tIME', async () => {
    const { before, after } = await expectStripped(fixture('gps.png', 'image/png'), 'png')
    const types = pngChunks(after).map((c) => c.type)
    expect(types).toEqual(['IHDR', 'iCCP', 'pHYs', 'IDAT', 'IEND'])
    const idat = (b: Uint8Array) => pngChunks(b).filter((c) => c.type === 'IDAT').map((c) => Array.from(c.data))
    expect(idat(after)).toEqual(idat(before))
  })

  it('keeps APNG animation chunks', async () => {
    const input = fixture('anim.png', 'image/png')
    const before = await bytesOf(input)
    expect(markersIn(before).length).toBeGreaterThan(0)
    const after = await bytesOf(await stripMediaMetadata(input))
    expect(markersIn(after)).toEqual([])
    expect(isAnimatedImage(after)).toBe(true)
    const animation = (b: Uint8Array) => pngChunks(b).filter((c) => ['acTL', 'fcTL', 'fdAT', 'IDAT'].includes(c.type))
    expect(animation(after).map((c) => c.type)).toEqual(animation(before).map((c) => c.type))
    expect(pngChunks(after).find((c) => c.type === 'acTL')!.data[3]).toBe(2)
    expect(pngChunks(after).some((c) => ['eXIf', 'tEXt'].includes(c.type))).toBe(false)
  })
})

describe('stripMediaMetadata: WebP', () => {
  it('drops EXIF and XMP, clears their VP8X flags and rewrites the RIFF size', async () => {
    const { before, after } = await expectStripped(fixture('gps.webp', 'image/webp'), 'webp')
    expect(webpChunks(before).map((c) => c.type)).toEqual(expect.arrayContaining(['EXIF', 'XMP ']))
    const chunks = webpChunks(after)
    expect(chunks.map((c) => c.type)).toEqual(['VP8X', 'ICCP', 'VP8 '])
    const flags = chunks[0].data[0]
    expect(flags & 0x0c).toBe(0)
    expect(flags & 0x20).toBe(0x20)
    const vp8 = (b: Uint8Array) => Array.from(webpChunks(b).find((c) => c.type === 'VP8 ')!.data)
    expect(vp8(after)).toEqual(vp8(before))
  })

  it('keeps animated WebP frames', async () => {
    const input = fixture('anim.webp', 'image/webp')
    expect(await readMediaDetails(input)).toEqual({ container: 'webp', location: true, details: true })
    const after = await bytesOf(await stripMediaMetadata(input))
    expect(markersIn(after)).toEqual([])
    const chunks = webpChunks(after)
    expect(chunks.map((c) => c.type)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF'])
    expect(chunks[0].data[0] & 0x02).toBe(0x02)
    expect(isAnimatedImage(after)).toBe(true)
  })
})

describe('stripMediaMetadata: GIF', () => {
  it('drops comments and the XMP application extension, keeps frames and looping', async () => {
    const input = fixture('anim.gif', 'image/gif')
    const before = await bytesOf(input)
    expect(latin1(before)).toContain('XMP DataXMP')
    expect(await readMediaDetails(input)).toEqual({ container: 'gif', location: true, details: true })
    const after = await bytesOf(await stripMediaMetadata(input))
    expect(markersIn(after)).toEqual([])
    expect(latin1(after)).not.toContain('XMP DataXMP')
    expect(latin1(after)).toContain('NETSCAPE2.0')
    expect(after.at(-1)).toBe(0x3b)
    expect(isAnimatedImage(after)).toBe(true)
  })
})

describe('stripMediaMetadata: HEIF', () => {
  for (const [name, type] of [['gps.heic', 'image/heic'], ['gps.avif', 'image/avif']] as const) {
    it(`zeroes the Exif and XMP items of ${name} in place`, async () => {
      const { before, after } = await expectStripped(fixture(name, type), 'heif')
      expect(after.length).toBe(before.length)
      isoBoxes(after)
      // Every changed byte is now zero; the coded image is untouched.
      let changed = 0
      for (let i = 0; i < before.length; i++) {
        if (before[i] !== after[i]) {
          changed++
          expect(after[i]).toBe(0)
        }
      }
      expect(changed).toBeGreaterThan(100)
    })
  }
})

describe('stripMediaMetadata: MP4 and MOV', () => {
  for (const name of ['gps.mp4', 'gps-faststart.mp4', 'gps.mov']) {
    it(`turns the metadata boxes of ${name} into free boxes without moving a byte`, async () => {
      const type = name.endsWith('.mov') ? 'video/quicktime' : 'video/mp4'
      const { before, after } = await expectStripped(fixture(name, type), 'isobmff')
      expect(after.length).toBe(before.length)

      const top = isoBoxes(after)
      const topBefore = isoBoxes(before)
      expect(top.map((b) => [b.start, b.end])).toEqual(topBefore.map((b) => [b.start, b.end]))
      const moov = top.find((b) => b.type === 'moov')!
      const children = isoBoxes(after, moov.start + 8, moov.end)
      expect(children.map((c) => c.type)).toEqual(expect.arrayContaining(['mvhd', 'trak']))
      expect(children.some((c) => c.type === 'udta' || c.type === 'meta')).toBe(false)
      expect(children.some((c) => c.type === 'free')).toBe(true)

      // mdat and the sample tables are byte-identical, so chunk offsets still point at the samples.
      const mdat = top.find((b) => b.type === 'mdat')!
      expect(after.subarray(mdat.start, mdat.end)).toEqual(before.subarray(mdat.start, mdat.end))
      const trak = children.find((c) => c.type === 'trak')!
      expect(after.subarray(trak.start, trak.end)).toEqual(before.subarray(trak.start, trak.end))
    })
  }
})

describe('stripMediaMetadata: other files', () => {
  it('returns files it does not handle unchanged', async () => {
    const text = new File(['hello'], 'note.txt', { type: 'text/plain' })
    expect(await readMediaDetails(text)).toEqual({ container: null, location: false, details: false })
    expect(await stripMediaMetadata(text)).toBe(text)
    const pdf = new File(['%PDF-1.7\n'], 'a.pdf', { type: 'application/pdf' })
    expect(await stripMediaMetadata(pdf)).toBe(pdf)
  })

  it('keeps a plain Blob a Blob', async () => {
    const blob = new Blob([readFileSync(resolve(FIXTURES, 'gps-upright.jpg'))], { type: 'image/jpeg' })
    const out = await stripMediaMetadata(blob)
    expect(out).not.toBeInstanceOf(File)
    expect(out.type).toBe('image/jpeg')
    expect(markersIn(await bytesOf(out))).toEqual([])
  })
})

describe('malformed HEIF', () => {
  const box = (type: string, body: number[]): number[] => {
    const size = 8 + body.length
    return [size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body]
  }
  const text = (s: string) => [...s].map((c) => c.charCodeAt(0))

  it('an iloc item count past its box ends the plan at once, the bytes unchanged', async () => {
    // iloc version 2: item_count is a u32. 0xFFFFFFFF items with no item bytes in the box.
    const iloc = box('iloc', [2, 0, 0, 0, 0x44, 0x40, 0xff, 0xff, 0xff, 0xff])
    const infe = box('infe', [2, 0, 0, 0, 0, 1, 0, 0, ...text('Exif'), 0])
    const iinf = box('iinf', [0, 0, 0, 0, 0, 1, ...infe])
    const hdlr = box('hdlr', [0, 0, 0, 0, 0, 0, 0, 0, ...text('pict'), ...new Array(12).fill(0), 0])
    const meta = box('meta', [0, 0, 0, 0, ...hdlr, ...iinf, ...iloc])
    const ftyp = box('ftyp', [...text('heic'), 0, 0, 0, 0, ...text('mif1'), ...text('heic')])
    const input = new Uint8Array([...ftyp, ...meta])
    const started = performance.now()
    const out = await stripMediaBytes(input)
    expect(performance.now() - started).toBeLessThan(1000)
    expect([...out]).toEqual([...input])
  }, 5000)
})

// ---------------------------------------------------------------------------
// Crafted inputs
// ---------------------------------------------------------------------------

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let o = 0
  for (const part of parts) {
    out.set(part, o)
    o += part.length
  }
  return out
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  chunk.set(ascii(type), 4)
  chunk.set(data, 8)
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)))
  return chunk
}

/** 1×1 greyscale PNG with `extra` between IHDR and IDAT. */
function png(...extra: Uint8Array[]): Uint8Array {
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  const ihdr = Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0)
  const idat = new Uint8Array(deflateSync(Uint8Array.of(0, 0)))
  return concat(signature, pngChunk('IHDR', ihdr), ...extra, pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0)))
}

/**
 * zlib data inflating to `prefix` then `mib` MiB of zeros, about 1 KiB per MiB: one raw deflate
 * run per MiB (Z_SYNC_FLUSH ends each byte-aligned and not final), a final empty fixed-Huffman
 * block (03 00), then the Adler-32.
 */
function zlibBomb(prefix: Uint8Array, mib: number): Uint8Array {
  const zeros = Buffer.alloc(1 << 20)
  const sync = { finishFlush: constants.Z_SYNC_FLUSH }
  const first = new Uint8Array(deflateRawSync(concat(prefix, zeros), sync))
  const next = new Uint8Array(deflateRawSync(zeros, sync))
  let a = 1
  let b = 0
  for (const x of prefix) {
    a = (a + x) % 65521
    b = (b + a) % 65521
  }
  // Each zero byte adds `a` to `b`.
  b = (b + a * ((mib * (1 << 20)) % 65521)) % 65521
  const adler = Uint8Array.of(b >>> 8, b & 0xff, a >>> 8, a & 0xff)
  return concat(Uint8Array.of(0x78, 0x9c), first, ...new Array<Uint8Array>(mib - 1).fill(next), Uint8Array.of(0x03, 0x00), adler)
}

/** DecompressionStream stand-in that counts the streams made and the bytes they inflate. */
function countInflation(): { streams: number; bytes: number } {
  const Real = globalThis.DecompressionStream
  const counter = { streams: 0, bytes: 0 }
  vi.stubGlobal('DecompressionStream', class {
    readonly writable: WritableStream
    readonly readable: ReadableStream
    constructor(format: 'deflate') {
      counter.streams++
      const inner = new Real(format)
      this.writable = inner.writable
      this.readable = inner.readable.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          counter.bytes += chunk.byteLength
          controller.enqueue(chunk)
        },
      }))
    }
  })
  return counter
}

/** The fixture's Exif TIFF: orientation 6, a GPS IFD, make HarmonyCam. */
async function exifTiff(): Promise<Uint8Array> {
  const jpeg = await bytesOf(fixture('gps-rotated.jpg', 'image/jpeg'))
  const [, start, end] = jpegSegments(jpeg).find(([m, s]) => m === 0xe1 && latin1(jpeg.subarray(s + 4, s + 10)) === 'Exif\0\0')!
  return jpeg.slice(start + 10, end)
}

function jpegSegment(marker: number, body: Uint8Array): Uint8Array {
  const length = body.length + 2
  return concat(Uint8Array.of(0xff, marker, length >>> 8, length & 0xff), body)
}

describe('PNG compressed text', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads a location from compressed XMP', async () => {
    const xmp = ascii('<x:xmpmeta><rdf:Description exif:GPSLatitude="35,40.57N"/></x:xmpmeta>')
    // keyword\0, compression flag 1, method 0, empty language\0, empty translated keyword\0.
    const itxt = concat(ascii('XML:com.adobe.xmp'), Uint8Array.of(0, 1, 0, 0, 0), new Uint8Array(deflateSync(xmp)))
    const file = new File([png(pngChunk('iTXt', itxt))], 'xmp.png', { type: 'image/png' })
    expect(await readMediaDetails(file)).toEqual({ container: 'png', location: true, details: true })
  })

  it('inflates a zTXt bomb only to INFLATE_CHUNK_MAX_BYTES, and finds the location ahead of it', async () => {
    const counter = countInflation()
    const bomb = zlibBomb(ascii('exif:GPSLatitude="35,40.57N" '), 256)
    const input = png(pngChunk('zTXt', concat(ascii('Comment'), Uint8Array.of(0, 0), bomb)))
    expect(input.length).toBeLessThan(400 * 1024)
    const file = new File([input], 'bomb.png', { type: 'image/png' })
    const started = performance.now()
    expect(await readMediaDetails(file)).toEqual({ container: 'png', location: true, details: true })
    expect(performance.now() - started).toBeLessThan(2000)
    expect(counter.streams).toBe(1)
    expect(counter.bytes).toBeLessThanOrEqual(2 * INFLATE_CHUNK_MAX_BYTES)
    const after = await bytesOf(await stripMediaMetadata(file))
    expect(pngChunks(after).map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
  }, 30000)

  it('stripMediaBytes drops compressed text without inflating it', async () => {
    const counter = countInflation()
    const input = png(pngChunk('zTXt', concat(ascii('Comment'), Uint8Array.of(0, 0), zlibBomb(ascii('GPSLatitude '), 64))))
    const out = await stripMediaBytes(input)
    expect(counter.streams).toBe(0)
    expect(pngChunks(out).map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
  }, 30000)
})

describe('PNG orientation', () => {
  it('keeps an eXIf orientation as an eXIf holding it alone, in place of the original', async () => {
    const tiff = await exifTiff()
    expect(readTiff(tiff, 0)).toEqual({ orientation: 6, gps: true })
    const input = new File([png(pngChunk('eXIf', tiff), pngChunk('tEXt', ascii('Comment\0fixture comment')))], 'rotated.png', { type: 'image/png', lastModified: LAST_MODIFIED })
    const { after } = await expectStripped(input, 'png')
    const chunks = pngChunks(after)
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'eXIf', 'IDAT', 'IEND'])
    expect(chunks[1].data.length).toBe(26)
    expect(chunks[1].data).toEqual(orientationSegment(6).subarray(10))
    expect(readTiff(chunks[1].data, 0)).toEqual({ orientation: 6, gps: false })
    expect(await stripMediaBytes(after)).toBe(after)
  })
})

describe('JPEG thumbnails', () => {
  it('cuts JFIF APP0 to its 16-byte form and drops JFXX APP0', async () => {
    const jpeg = await bytesOf(fixture('gps-rotated.jpg', 'image/jpeg'))
    // JFIF 1.02, dots per inch, 72×72, a 2×1 RGB thumbnail.
    const jfifHead = concat(ascii('JFIF\0'), Uint8Array.of(1, 2, 1, 0, 72, 0, 72))
    const jfif = jpegSegment(0xe0, concat(jfifHead, Uint8Array.of(2, 1), ascii('THUMB!')))
    // JFXX extension 0x10: a JPEG thumbnail.
    const jfxx = jpegSegment(0xe0, concat(ascii('JFXX\0'), Uint8Array.of(0x10), ascii('JFXX THUMBNAIL')))
    const input = new File([jpeg.subarray(0, 2), jfif, jfxx, jpeg.subarray(20)], 'thumb.jpg', { type: 'image/jpeg' })
    expect(await readMediaDetails(input)).toEqual({ container: 'jpeg', location: true, details: true })

    const after = await bytesOf(await stripMediaMetadata(input))
    expect(latin1(after)).not.toContain('THUMB')
    expect(after.subarray(2, 20)).toEqual(jpegSegment(0xe0, concat(jfifHead, Uint8Array.of(0, 0))))
    expect(after.subarray(20, 56)).toEqual(orientationSegment(6))
    expect(jpegSegments(after).filter(([m]) => m === 0xe0)).toHaveLength(1)
    const again = new File([after], 'again.jpg', { type: 'image/jpeg' })
    expect(await stripMediaMetadata(again)).toBe(again)
  })
})

describe('irregular files', () => {
  it('skips bytes between JPEG segments as libjpeg next_marker() does', async () => {
    const jpeg = await bytesOf(fixture('gps-rotated.jpg', 'image/jpeg'))
    // After the JFIF APP0: a stray 00; FF 00, a stray 12 and a fill FF.
    for (const junk of [Uint8Array.of(0), Uint8Array.of(0xff, 0x00, 0x12, 0xff)]) {
      const input = new File([jpeg.subarray(0, 20), junk, jpeg.subarray(20)], 'pad.jpg', { type: 'image/jpeg' })
      expect(await readMediaDetails(input)).toEqual({ container: 'jpeg', location: true, details: true })
      const after = await bytesOf(await stripMediaMetadata(input))
      expect(markersIn(after)).toEqual([])
      expect(readJpegOrientation(after)).toBe(6)
    }
  })

  it('strips an MP4 whose last box runs past the end of the file', async () => {
    const mp4 = await bytesOf(fixture('gps.mp4', 'video/mp4'))
    // moov is last; its udta ends the file.
    const cut = new File([mp4.subarray(0, mp4.length - 10)], 'cut.mp4', { type: 'video/mp4' })
    expect(await readMediaDetails(cut)).toEqual({ container: 'isobmff', location: true, details: true })
    const after = await bytesOf(await stripMediaMetadata(cut))
    expect(after.length).toBe(mp4.length - 10)
    expect(markersIn(after)).toEqual([])
  })

  it('strips a PNG without IEND', async () => {
    const before = await bytesOf(fixture('gps.png', 'image/png'))
    const cut = new File([before.subarray(0, before.length - 12)], 'cut.png', { type: 'image/png' })
    expect(await readMediaDetails(cut)).toEqual({ container: 'png', location: true, details: true })
    const after = await bytesOf(await stripMediaMetadata(cut))
    expect(markersIn(after)).toEqual([])
    expect(pngChunks(after).map((c) => c.type)).toEqual(['IHDR', 'iCCP', 'pHYs', 'IDAT'])
  })

  it('drops a WebP chunk cut short by the end of the file', async () => {
    const before = await bytesOf(fixture('gps.webp', 'image/webp'))
    // XMP is last.
    const cut = new File([before.subarray(0, before.length - 5)], 'cut.webp', { type: 'image/webp' })
    expect(await readMediaDetails(cut)).toEqual({ container: 'webp', location: true, details: true })
    const after = await bytesOf(await stripMediaMetadata(cut))
    expect(markersIn(after)).toEqual([])
    expect(webpChunks(after).map((c) => c.type)).toEqual(['VP8X', 'ICCP', 'VP8 '])
  })

  it('accepts a GIF without trailer, and ends a GIF at a block that is not image, extension or trailer', async () => {
    const gif = await bytesOf(fixture('anim.gif', 'image/gif'))
    expect(gif.at(-1)).toBe(0x3b)
    const body = gif.subarray(0, gif.length - 1)
    const cut = new File([body], 'cut.gif', { type: 'image/gif' })
    expect(await readMediaDetails(cut)).toEqual({ container: 'gif', location: true, details: true })
    expect(markersIn(await bytesOf(await stripMediaMetadata(cut)))).toEqual([])

    const junk = new File([body, Uint8Array.of(0x99), ascii('AFTER THE STREAM'), Uint8Array.of(0x3b)], 'junk.gif', { type: 'image/gif' })
    const after = latin1(await bytesOf(await stripMediaMetadata(junk)))
    expect(after).not.toContain('AFTER THE STREAM')
    expect(after).toContain('NETSCAPE2.0')
  })

  it('reports unknown details for an MP4 box it cannot walk past, and strips what precedes it', async () => {
    const mp4 = await bytesOf(fixture('gps-faststart.mp4', 'video/mp4'))
    // ftyp 32, moov 909, free 8, mdat 995: the free box claims 4 bytes, less than its header.
    const free = 32 + 909
    expect(latin1(mp4.subarray(free + 4, free + 8))).toBe('free')
    const broken = mp4.slice()
    new DataView(broken.buffer).setUint32(free, 4)
    const input = new File([broken], 'broken.mp4', { type: 'video/mp4' })
    expect(await readMediaDetails(input)).toEqual({ container: 'isobmff', location: true, details: true, unknown: true })
    const output = await stripMediaMetadata(input)
    expect(markersIn(await bytesOf(output))).toEqual([])
    // The bytes past the broken box were not read: the result's details stay unknown.
    expect(await readMediaDetails(output)).toEqual({ container: 'isobmff', location: false, details: true, unknown: true })
  })

  it('reads top-level boxes past the first few through 64 KiB windows, and stops at TOP_LEVEL_BOX_MAX', async () => {
    const mp4 = await bytesOf(fixture('gps.mp4', 'video/mp4'))
    const free = Uint8Array.of(0, 0, 0, 8, ...ascii('free'))
    // ftyp, TOP_LEVEL_BOX_MAX empty free boxes, then the movie: its moov lies past the limit.
    const input = concat(mp4.subarray(0, 32), ...new Array<Uint8Array>(TOP_LEVEL_BOX_MAX).fill(free), mp4.subarray(32))
    let reads = 0
    const source: ByteSource = { size: input.length, read: async (start, end) => (reads++, input.slice(start, end)) }
    expect(await readSourceDetails(source)).toEqual({ container: 'isobmff', location: false, details: true, unknown: true })
    expect(reads).toBeLessThan(20)
    expect(await stripMediaBytes(input)).toBe(input)
  })

  it('reports unknown details when a read fails', async () => {
    const mp4 = await bytesOf(fixture('gps.mp4', 'video/mp4'))
    const source: ByteSource = {
      size: mp4.length,
      read: async (start, end) => {
        if (start > 0) throw new Error('HTTP 500')
        return mp4.slice(start, end)
      },
    }
    expect(await readSourceDetails(source)).toEqual({ container: 'isobmff', location: false, details: true, unknown: true })
  })

  it('reports unknown details for a raster over IMAGE_MAX_BYTES', async () => {
    const jpeg = await bytesOf(fixture('gps-rotated.jpg', 'image/jpeg'))
    const source: ByteSource = { size: IMAGE_MAX_BYTES + 1, read: async (start, end) => jpeg.slice(start, end) }
    expect(await readSourceDetails(source)).toEqual({ container: 'jpeg', location: false, details: true, unknown: true })
  })

  it('reads an APPn or COM length under 2 as libjpeg does, and reports unknown details at any other', async () => {
    const jpeg = await bytesOf(fixture('gps-rotated.jpg', 'image/jpeg'))
    // After the JFIF APP0, ahead of the Exif APP1: a COM of length 0, taken as its length bytes.
    const com = new File([jpeg.subarray(0, 20), Uint8Array.of(0xff, 0xfe, 0, 0), jpeg.subarray(20)], 'com.jpg', { type: 'image/jpeg' })
    expect(await readMediaDetails(com)).toEqual({ container: 'jpeg', location: true, details: true })
    expect(markersIn(await bytesOf(await stripMediaMetadata(com)))).toEqual([])
    // A DQT of length 0: JERR_BAD_LENGTH.
    const dqt = new File([jpeg.subarray(0, 20), Uint8Array.of(0xff, 0xdb, 0, 0), jpeg.subarray(20)], 'dqt.jpg', { type: 'image/jpeg' })
    expect(await readMediaDetails(dqt)).toEqual({ container: 'jpeg', location: false, details: true, unknown: true })
  })

  it('reports unknown details at a PNG chunk type libpng rejects, and strips what precedes it', async () => {
    // Length 0, type 01 02 03 04, CRC: the eXIf after it is never reached.
    const junk = concat(Uint8Array.of(0, 0, 0, 0, 1, 2, 3, 4), new Uint8Array(4))
    const exif = pngChunk('eXIf', await exifTiff())
    const bare = new File([png(junk, exif)], 'junk.png', { type: 'image/png' })
    expect(await readMediaDetails(bare)).toEqual({ container: 'png', location: false, details: true, unknown: true })
    expect(await stripMediaMetadata(bare)).toBe(bare)

    const input = new File([png(pngChunk('tEXt', ascii('Comment\0before')), junk, exif)], 'junk.png', { type: 'image/png' })
    expect(await readMediaDetails(input)).toEqual({ container: 'png', location: false, details: true, unknown: true })
    const after = await bytesOf(await stripMediaMetadata(input))
    expect(latin1(after)).not.toContain('Comment')
  })
})

describe('audio', () => {
  it('leaves an M4A unchanged, tags and all', async () => {
    const m4a = (await bytesOf(fixture('gps.mp4', 'video/mp4'))).slice()
    // ftyp major brand.
    m4a.set(ascii('M4A '), 8)
    for (const type of ['audio/mp4', 'audio/x-m4a', '']) {
      const file = new File([m4a], 'song.m4a', { type })
      expect(await readMediaDetails(file)).toEqual({ container: null, location: false, details: false })
      expect(await stripMediaMetadata(file)).toBe(file)
    }
    expect(await stripMediaBytes(m4a)).toBe(m4a)
  })

  it('leaves an audio/* file unchanged whatever its brand', async () => {
    const file = new File([readFileSync(resolve(FIXTURES, 'gps.mp4'))], 'voice.m4a', { type: 'audio/mp4' })
    expect(await readMediaDetails(file)).toEqual({ container: null, location: false, details: false })
    expect(await stripMediaMetadata(file)).toBe(file)
  })
})
