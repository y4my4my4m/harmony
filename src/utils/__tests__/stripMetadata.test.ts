import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  orientationSegment,
  readMediaDetails,
  readTiff,
  stripMediaBytes,
  stripMediaMetadata,
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

  it('leaves a truncated JPEG unchanged', async () => {
    const before = await bytesOf(fixture('gps-rotated.jpg', 'image/jpeg'))
    const file = new File([before.subarray(0, 40)], 'cut.jpg', { type: 'image/jpeg' })
    expect(await stripMediaMetadata(file)).toBe(file)
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
