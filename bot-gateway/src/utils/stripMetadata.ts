/**
 * Removal of location and identifying metadata from photos and videos, on the device, before
 * upload. Lossless: no pixel or sample data is decoded or re-encoded.
 *
 * JPEG  APP0 other than JFIF/JFXX, APP1 (Exif, XMP), APP2 other than ICC_PROFILE (MPF, FPXR),
 *       APP3–APP13 (APP13: IPTC), APP14 other than Adobe, APP15, COM, and every byte after EOI
 *       (MPF secondary images, maker trailers) are dropped. An Exif orientation other than 1 is
 *       kept as a 36-byte APP1 holding IFD0 Orientation alone, after SOI and any leading APP0.
 * PNG   Chunks outside PNG_KEEP (eXIf, tEXt, iTXt, zTXt, tIME, private chunks) and bytes after IEND.
 *       APNG chunks (acTL, fcTL, fdAT) are kept.
 * WebP  Chunks outside WEBP_KEEP (EXIF, XMP, unknown); VP8X flags E (0x08) and X (0x04) cleared;
 *       RIFF size rewritten; bytes after the RIFF payload dropped.
 * GIF   Comment extensions (0x21 0xFE), application extensions other than NETSCAPE2.0, ANIMEXTS1.0
 *       and ICCRGBG1012 (XMP DataXMP among them), and bytes after the trailer (0x3B).
 * HEIF  HEIC/AVIF still images: payloads of items of type Exif, and of mime items with content type
 *       application/rdf+xml (XMP), are zeroed in place (iinf/iloc, construction methods 0 and 1).
 * ISOBMFF video (MP4, MOV, 3GP): moov/udta (©xyz, loci, XMP), moov/meta (mdta keys/ilst:
 *       com.apple.quicktime.location.ISO6709, make, model), trak/udta, trak/meta, top-level non-image
 *       meta, and XMP/USMT/PROF uuid boxes become `free` boxes of the same size with zeroed payload.
 *       No byte moves, so stco/co64 chunk offsets stay valid.
 *
 * Not handled, uploaded unchanged: timed metadata tracks (GoPro gpmd, camm), Matroska/WebM tags,
 * TIFF/DNG, JPEG XL, raster files over IMAGE_MAX_BYTES.
 */

export type MediaContainer = 'jpeg' | 'png' | 'webp' | 'gif' | 'heif' | 'isobmff'

export interface MediaDetails {
  /** Null: a format this module leaves unchanged. */
  container: MediaContainer | null
  /** A GPS position: Exif GPS IFD latitude/longitude, XMP GPS, ©xyz, loci, ISO6709 keys. */
  location: boolean
  /** Anything stripMediaMetadata removes. */
  details: boolean
}

/** Rasters are parsed in memory; larger ones are uploaded unchanged. */
export const IMAGE_MAX_BYTES = 256 * 1024 * 1024

/** moov and HEIF meta boxes are read whole; larger ones are left unchanged. */
const BOX_MAX_BYTES = 256 * 1024 * 1024

/** Rasters read into memory at once; a batch of picked photos queues behind these. */
const RASTER_READ_SLOTS = 2

/** Byte range of the source, or literal bytes. */
type Part = readonly [number, number] | Uint8Array

/** BlobPart, which Node's lib (no DOM) does not name. */
type BlobInput = NonNullable<ConstructorParameters<typeof Blob>[0]>[number]

interface Plan extends MediaDetails {
  /** Null: the output equals the input. */
  parts: Part[] | null
}

const NOTHING: Plan = { container: null, location: false, details: false, parts: null }

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function ascii(b: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > b.length) return ''
  let s = ''
  for (let i = offset; i < offset + length; i++) s += String.fromCharCode(b[i])
  return s
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

function uintBe(b: Uint8Array, o: number, size: number): number {
  let v = 0
  for (let i = 0; i < size; i++) v = v * 256 + b[o + i]
  return v
}

function startsWith(b: Uint8Array, offset: number, text: string): boolean {
  return ascii(b, offset, text.length) === text
}

function latin1(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return s
}

/** XMP and QuickTime text naming a position. */
const TEXT_LOCATION = /GPS(?:Latitude|Longitude|Coordinates|Position)|location\.ISO6709/

function textHasLocation(b: Uint8Array): boolean {
  return TEXT_LOCATION.test(latin1(b))
}

/** Concatenated ranges kept between dropped spans, as a JPEG/PNG/GIF walk emits them. */
class Splicer {
  readonly parts: Part[] = []
  private cursor = 0
  dropped = false

  drop(start: number, end: number): void {
    if (start > this.cursor) this.parts.push([this.cursor, start])
    this.cursor = Math.max(this.cursor, end)
    this.dropped = true
  }

  finish(size: number): Part[] {
    if (this.cursor < size) this.parts.push([this.cursor, size])
    this.cursor = size
    return this.parts
  }
}

// ---------------------------------------------------------------------------
// TIFF (Exif payload)
// ---------------------------------------------------------------------------

interface TiffInfo {
  orientation: number
  gps: boolean
}

/** IFD0 Orientation (0x0112) and a GPS IFD (0x8825) holding latitude (2) or longitude (4). */
export function readTiff(b: Uint8Array, start: number, end = b.length): TiffInfo {
  const info: TiffInfo = { orientation: 1, gps: false }
  if (start < 0 || start + 8 > end) return info
  const little = startsWith(b, start, 'II')
  if (!little && !startsWith(b, start, 'MM')) return info
  const u16 = (o: number) => (little ? b[o] | (b[o + 1] << 8) : u16be(b, o))
  const u32 = (o: number) => (little ? u32le(b, o) : u32be(b, o))
  if (u16(start + 2) !== 42) return info
  const entries = (ifd: number, visit: (tag: number, entry: number) => void) => {
    if (ifd + 2 > end) return
    const count = u16(ifd)
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12
      if (entry + 12 > end) return
      visit(u16(entry), entry)
    }
  }
  entries(start + u32(start + 4), (tag, entry) => {
    if (tag === 0x0112) {
      const value = u16(entry + 8)
      if (value >= 1 && value <= 8) info.orientation = value
    } else if (tag === 0x8825) {
      entries(start + u32(entry + 8), (gpsTag) => {
        if (gpsTag === 2 || gpsTag === 4) info.gps = true
      })
    }
  })
  return info
}

/** Exif blob: optional `Exif\0\0`, then TIFF. */
function exifInfo(b: Uint8Array): TiffInfo {
  return readTiff(b, startsWith(b, 0, 'Exif\0\0') ? 6 : 0)
}

/**
 * APP1 Exif segment, big-endian TIFF, IFD0 with Orientation alone (SHORT, count 1), no IFD1.
 * 36 bytes: FF E1, length 0x0022, `Exif\0\0`, `MM` 002A 00000008, count 0001,
 * entry 0112 0003 00000001 000N 0000, next IFD 00000000.
 */
export function orientationSegment(orientation: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation & 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ])
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

function planJpeg(b: Uint8Array): Plan | null {
  const n = b.length
  const out = new Splicer()
  let location = false
  let orientation = 1
  let exifSeen = false
  let minimalExif = false
  // The orientation APP1 goes after SOI and the APP0 segments that directly follow it.
  let insertAt = 2
  let leading = true
  let p = 2
  for (;;) {
    if (p >= n) break
    if (b[p] !== 0xff) return null
    const marker = b[p + 1]
    if (marker === 0xff) { p += 1; continue }
    if (marker === 0xd9) {
      p += 2
      if (p < n) out.drop(p, n)
      break
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; leading = false; continue }
    if (p + 4 > n) return null
    const end = p + 2 + u16be(b, p + 2)
    if (end > n) return null
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker: FF followed by neither 00, FF nor RSTn.
      let q = end
      while (q + 1 < n && !(b[q] === 0xff && b[q + 1] !== 0 && b[q + 1] !== 0xff && (b[q + 1] < 0xd0 || b[q + 1] > 0xd7))) q++
      p = q + 1 < n ? q : n
      leading = false
      continue
    }
    const app = marker >= 0xe0 && marker <= 0xef
    if (app || marker === 0xfe) {
      const body = p + 4
      let keep = false
      if (marker === 0xe0) keep = startsWith(b, body, 'JFIF\0') || startsWith(b, body, 'JFXX\0')
      else if (marker === 0xe2) keep = startsWith(b, body, 'ICC_PROFILE\0')
      else if (marker === 0xee) keep = startsWith(b, body, 'Adobe')
      else if (marker === 0xe1 && startsWith(b, body, 'Exif\0\0')) {
        const info = readTiff(b, body + 6, end)
        if (!exifSeen) {
          exifSeen = true
          orientation = info.orientation
          keep = minimalExif = equalBytes(b.subarray(p, end), orientationSegment(info.orientation))
        }
        location ||= info.gps
      } else if (marker === 0xe1) {
        location ||= textHasLocation(b.subarray(body, end))
      }
      if (keep) {
        if (marker === 0xe0 && leading) insertAt = end
      } else {
        out.drop(p, end)
      }
      if (marker !== 0xe0 || !keep) leading = false
      p = end
      continue
    }
    leading = false
    p = end
  }
  if (!out.dropped) return { container: 'jpeg', location, details: false, parts: null }
  const parts = out.finish(n)
  if (orientation !== 1 && !minimalExif) {
    // Every dropped span starts at or after insertAt, so the first part covers it.
    const first = parts[0] as readonly [number, number]
    parts.splice(0, 1, [first[0], insertAt], orientationSegment(orientation), [insertAt, first[1]])
  }
  return { container: 'jpeg', location, details: true, parts }
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV',
  'cLLI', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT',
])

async function inflate(b: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') return null
  try {
    const stream = new Blob([b as BlobInput]).stream().pipeThrough(new DecompressionStream('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

/** ImageMagick `Raw profile type exif|APP1`: newline, name, length, then hex lines. */
function rawProfileBytes(text: string): Uint8Array | null {
  const hex = text.split('\n').slice(3).join('').replace(/\s+/g, '')
  if (!hex || hex.length % 2 || /[^0-9a-f]/i.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** tEXt: key\0text. zTXt: key\0 method text(deflate). iTXt: key\0 flag method lang\0 tkey\0 text. */
async function pngTextHasLocation(type: string, data: Uint8Array): Promise<boolean> {
  const nul = data.indexOf(0)
  if (nul < 0) return false
  const key = ascii(data, 0, nul)
  let text: Uint8Array | null = null
  if (type === 'tEXt') text = data.subarray(nul + 1)
  else if (type === 'zTXt') text = await inflate(data.subarray(nul + 2))
  else {
    const compressed = data[nul + 1] === 1
    const lang = data.indexOf(0, nul + 3)
    const tkey = lang < 0 ? -1 : data.indexOf(0, lang + 1)
    if (tkey < 0) return false
    text = compressed ? await inflate(data.subarray(tkey + 1)) : data.subarray(tkey + 1)
  }
  if (!text) return false
  if (/^Raw profile type (exif|APP1)$/i.test(key)) {
    const raw = rawProfileBytes(latin1(text))
    return !!raw && exifInfo(raw).gps
  }
  return textHasLocation(text)
}

async function planPng(b: Uint8Array): Promise<Plan | null> {
  const n = b.length
  const out = new Splicer()
  let location = false
  let p = 8
  for (;;) {
    if (p + 12 > n) return null
    const length = u32be(b, p)
    const type = ascii(b, p + 4, 4)
    const end = p + 12 + length
    if (end > n) return null
    if (!PNG_KEEP.has(type)) {
      const data = b.subarray(p + 8, p + 8 + length)
      if (type === 'eXIf') location ||= exifInfo(data).gps
      else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') location ||= await pngTextHasLocation(type, data)
      out.drop(p, end)
    }
    p = end
    if (type === 'IEND') break
  }
  if (p < n) out.drop(p, n)
  return { container: 'png', location, details: out.dropped, parts: out.dropped ? out.finish(n) : null }
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP'])

function planWebp(b: Uint8Array): Plan | null {
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4))
  const kept: Part[] = []
  let size = 4
  let location = false
  let details = riffEnd < b.length
  let p = 12
  while (p + 8 <= riffEnd) {
    const type = ascii(b, p, 4)
    const length = u32le(b, p + 4)
    // An odd chunk is followed by one pad byte; a final chunk may lack it.
    if (p + 8 + length > riffEnd) return null
    const end = Math.min(p + 8 + length + (length & 1), riffEnd)
    if (type === 'VP8X') {
      const chunk = b.slice(p, end)
      chunk[8] &= ~0x0c
      kept.push(chunk)
      size += chunk.length
    } else if (WEBP_KEEP.has(type)) {
      kept.push([p, end])
      size += end - p
    } else {
      const data = b.subarray(p + 8, p + 8 + length)
      if (type === 'EXIF') location ||= exifInfo(data).gps
      else location ||= textHasLocation(data)
      details = true
    }
    p = end
  }
  if (p !== riffEnd) return null
  if (!details) return { container: 'webp', location, details: false, parts: null }
  const header = b.slice(0, 12)
  header[4] = size & 0xff
  header[5] = (size >>> 8) & 0xff
  header[6] = (size >>> 16) & 0xff
  header[7] = (size >>> 24) & 0xff
  return { container: 'webp', location, details: true, parts: [header, ...kept] }
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

const GIF_KEEP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012'])

/** End of a run of data sub-blocks starting at p (length byte, data), after its 0 terminator. */
function gifSubBlocksEnd(b: Uint8Array, p: number): number {
  while (p < b.length) {
    const size = b[p]
    p += 1
    if (size === 0) return p
    p += size
  }
  return -1
}

function planGif(b: Uint8Array): Plan | null {
  const n = b.length
  if (n < 13) return null
  const out = new Splicer()
  let location = false
  let p = 13
  const flags = b[10]
  if (flags & 0x80) p += 3 * (1 << ((flags & 0x07) + 1))
  for (;;) {
    if (p >= n) return null
    const block = b[p]
    if (block === 0x3b) {
      p += 1
      break
    }
    if (block === 0x2c) {
      if (p + 10 > n) return null
      const local = b[p + 9]
      let q = p + 10
      if (local & 0x80) q += 3 * (1 << ((local & 0x07) + 1))
      const end = gifSubBlocksEnd(b, q + 1)
      if (end < 0) return null
      p = end
    } else if (block === 0x21) {
      const label = b[p + 1]
      const end = gifSubBlocksEnd(b, p + 2)
      if (end < 0) return null
      const app = label === 0xff && b[p + 2] === 11 ? ascii(b, p + 3, 11) : null
      if (label === 0xfe || (label === 0xff && !(app && GIF_KEEP_APPS.has(app)))) {
        if (app?.startsWith('XMP Data')) location ||= textHasLocation(b.subarray(p + 14, end))
        out.drop(p, end)
      }
      p = end
    } else {
      return null
    }
  }
  if (p < n) out.drop(p, n)
  return { container: 'gif', location, details: out.dropped, parts: out.dropped ? out.finish(n) : null }
}

// ---------------------------------------------------------------------------
// ISOBMFF: MP4, MOV, 3GP, HEIF, AVIF
// ---------------------------------------------------------------------------

interface Box {
  type: string
  start: number
  /** Payload start: after size, type, largesize and uuid usertype. */
  body: number
  end: number
  uuid?: string
}

/** Boxes in b[start, end); null when a size runs past `end`. */
function boxesIn(b: Uint8Array, start: number, end: number, base = 0): Box[] | null {
  const boxes: Box[] = []
  let p = start
  while (p + 8 <= end) {
    let size = u32be(b, p)
    const type = ascii(b, p + 4, 4)
    let header = 8
    if (size === 1) {
      if (p + 16 > end) return null
      size = uintBe(b, p + 8, 8)
      header = 16
    } else if (size === 0) {
      size = end - p
    }
    if (size < header || p + size > end) return null
    const box: Box = { type, start: base + p, body: base + p + header, end: base + p + size }
    if (type === 'uuid' && p + header + 16 <= end) {
      box.uuid = Array.from(b.subarray(p + header, p + header + 16), (x) => x.toString(16).padStart(2, '0')).join('')
      box.body += 16
    }
    boxes.push(box)
    p += size
  }
  return p === end ? boxes : null
}

/** uuid user types of metadata boxes: XMP, Sony USMT, Sony PROF. */
const METADATA_UUIDS = new Set([
  'be7acfcb97a942e89c71999491e3afac',
  '55534d5421d24fcebb88695cfac9c740',
  '50524f4621d24fcebb88695cfac9c740',
])

const HEIF_BRANDS = new Set(['mif1', 'mif2', 'heic', 'heix', 'heim', 'heis', 'avif', 'avio', 'jpeg', 'avci', 'MiPr'])

/** Location boxes and keys in a metadata box's bytes: ©xyz, loci, ISO6709 keys, XMP GPS. */
function boxHasLocation(b: Uint8Array): boolean {
  for (let i = 0; i + 4 <= b.length; i++) {
    if (b[i] === 0xa9 && b[i + 1] === 0x78 && b[i + 2] === 0x79 && b[i + 3] === 0x7a) return true
    if (b[i] === 0x6c && b[i + 1] === 0x6f && b[i + 2] === 0x63 && b[i + 3] === 0x69) return true
  }
  return textHasLocation(b)
}

/** The box in `copy` turned into a `free` box of the same size with a zeroed payload. */
function neutralize(copy: Uint8Array, box: Box, base: number): void {
  const at = box.start - base
  copy.set([0x66, 0x72, 0x65, 0x65], at + 4) // 'free'
  const header = u32be(copy, at) === 1 ? 16 : 8
  copy.fill(0, at + header, box.end - base)
}

/** Random access to a file's bytes: a Blob, or a stored object read by HTTP range. */
export interface ByteSource {
  readonly size: number
  /** Bytes [start, end). */
  read(start: number, end: number): Promise<Uint8Array>
}

export function blobSource(blob: Blob): ByteSource {
  return { size: blob.size, read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()) }
}

/** Top-level boxes, from a 32-byte read per header; null when a size runs past the file. */
async function topLevelBoxes(file: ByteSource): Promise<Box[] | null> {
  const boxes: Box[] = []
  let p = 0
  while (p + 8 <= file.size) {
    const head = await file.read(p, Math.min(file.size, p + 32))
    let size = u32be(head, 0)
    let header = 8
    if (size === 1) {
      if (head.length < 16) return null
      size = uintBe(head, 8, 8)
      header = 16
    } else if (size === 0) {
      size = file.size - p
    }
    if (size < header || p + size > file.size) return null
    const box: Box = { type: ascii(head, 4, 4), start: p, body: p + header, end: p + size }
    if (box.type === 'uuid' && head.length >= header + 16) {
      box.uuid = Array.from(head.subarray(header, header + 16), (x) => x.toString(16).padStart(2, '0')).join('')
      box.body += 16
    }
    boxes.push(box)
    p += size
  }
  return boxes
}

interface Patch {
  start: number
  bytes: Uint8Array
}

/** Patches applied over the source; `bytes` replace [start, start + bytes.length). */
function patchedParts(size: number, patches: Patch[]): Part[] {
  const parts: Part[] = []
  let cursor = 0
  for (const patch of [...patches].sort((a, b) => a.start - b.start)) {
    if (patch.start > cursor) parts.push([cursor, patch.start])
    parts.push(patch.bytes)
    cursor = patch.start + patch.bytes.length
  }
  if (cursor < size) parts.push([cursor, size])
  return parts
}

/**
 * Neutralizes, in `copy` (the bytes of moov), its udta, meta and metadata uuid boxes and those of
 * each trak. True when there was one.
 */
function scrubMovie(copy: Uint8Array, box: Box, report: { location: boolean }): boolean {
  let changed = false
  const visit = (start: number, end: number, depth: number) => {
    const children = boxesIn(copy, start - box.start, end - box.start, box.start)
    if (!children) return
    for (const child of children) {
      const metadata = child.type === 'udta' || child.type === 'meta'
        || (child.type === 'uuid' && !!child.uuid && METADATA_UUIDS.has(child.uuid))
      if (metadata) {
        report.location ||= boxHasLocation(copy.subarray(child.start - box.start, child.end - box.start))
        neutralize(copy, child, box.start)
        changed = true
      } else if (child.type === 'trak' && depth === 0) {
        visit(child.body, child.end, depth + 1)
      }
    }
  }
  visit(box.body, box.end, 0)
  return changed
}

/** hdlr handler_type of a meta box (FullBox: 4 bytes version/flags ahead of its children). */
function metaHandler(meta: Uint8Array, box: Box): string | null {
  const children = boxesIn(meta, box.body - box.start + 4, box.end - box.start, box.start)
  const hdlr = children?.find((c) => c.type === 'hdlr')
  return hdlr ? ascii(meta, hdlr.body - box.start + 8, 4) : null
}

/** File byte spans of Exif and XMP items of a HEIF meta box. */
function heifMetadataExtents(meta: Uint8Array, box: Box): Array<{ start: number; end: number; exif: boolean }> | null {
  const base = box.start
  const children = boxesIn(meta, box.body - base + 4, box.end - base, base)
  if (!children) return null
  const targets = new Map<number, boolean>()
  const iinf = children.find((c) => c.type === 'iinf')
  if (iinf) {
    const at = iinf.body - base
    const version = meta[at]
    const first = at + 4 + (version === 0 ? 2 : 4)
    for (const infe of boxesIn(meta, first, iinf.end - base, base) ?? []) {
      if (infe.type !== 'infe') continue
      const q = infe.body - base
      const v = meta[q]
      if (v < 2) continue
      const idSize = v === 2 ? 2 : 4
      const id = uintBe(meta, q + 4, idSize)
      const itemType = ascii(meta, q + 4 + idSize + 2, 4)
      if (itemType === 'Exif') targets.set(id, true)
      else if (itemType === 'mime') {
        const name = q + 4 + idSize + 6
        const nameEnd = meta.indexOf(0, name)
        const typeEnd = nameEnd < 0 ? -1 : meta.indexOf(0, nameEnd + 1)
        if (typeEnd > 0 && ascii(meta, nameEnd + 1, typeEnd - nameEnd - 1) === 'application/rdf+xml') targets.set(id, false)
      }
    }
  }
  if (!targets.size) return []
  const iloc = children.find((c) => c.type === 'iloc')
  const idat = children.find((c) => c.type === 'idat')
  if (!iloc) return null
  let q = iloc.body - base
  const version = meta[q]
  q += 4
  const offsetSize = meta[q] >> 4
  const lengthSize = meta[q] & 15
  const baseOffsetSize = meta[q + 1] >> 4
  const indexSize = version === 1 || version === 2 ? meta[q + 1] & 15 : 0
  q += 2
  const count = version < 2 ? u16be(meta, q) : u32be(meta, q)
  q += version < 2 ? 2 : 4
  const spans: Array<{ start: number; end: number; exif: boolean }> = []
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? u16be(meta, q) : u32be(meta, q)
    q += version < 2 ? 2 : 4
    let method = 0
    if (version === 1 || version === 2) {
      method = u16be(meta, q) & 15
      q += 2
    }
    q += 2 // data_reference_index
    const baseOffset = uintBe(meta, q, baseOffsetSize)
    q += baseOffsetSize
    const extents = u16be(meta, q)
    q += 2
    for (let e = 0; e < extents; e++) {
      q += indexSize
      const offset = uintBe(meta, q, offsetSize)
      q += offsetSize
      const length = uintBe(meta, q, lengthSize)
      q += lengthSize
      if (q > iloc.end - base) return null
      const exif = targets.get(id)
      if (exif === undefined || length === 0) continue
      if (method === 0) spans.push({ start: baseOffset + offset, end: baseOffset + offset + length, exif })
      else if (method === 1 && idat) spans.push({ start: idat.body + baseOffset + offset, end: idat.body + baseOffset + offset + length, exif })
    }
  }
  return spans
}

async function planIsoBmff(file: ByteSource): Promise<Plan | null> {
  const top = await topLevelBoxes(file)
  if (!top?.length) return null
  const ftyp = top.find((box) => box.type === 'ftyp')
  let heif = false
  if (ftyp && ftyp.end - ftyp.start <= 4096) {
    const f = await file.read(ftyp.body, ftyp.end)
    for (let i = 0; i + 4 <= f.length; i += 4) if (i !== 4 && HEIF_BRANDS.has(ascii(f, i, 4))) heif = true
  }
  const report = { location: false }
  const patches: Patch[] = []
  for (const box of top) {
    if (box.type === 'moov' || box.type === 'meta') {
      if (box.end - box.start > BOX_MAX_BYTES) return null
      const copy = await file.read(box.start, box.end)
      if (box.type === 'meta' && (heif || metaHandler(copy, box) === 'pict')) {
        const spans = heifMetadataExtents(copy, box)
        if (!spans) return null
        for (const span of spans) {
          if (span.end > file.size || span.end - span.start > BOX_MAX_BYTES) return null
          const data = await file.read(span.start, span.end)
          if (data.every((x) => x === 0)) continue
          // Exif item payload: 4-byte exif_tiff_header_offset, then TIFF.
          report.location ||= span.exif ? readTiff(data, 4 + u32be(data, 0)).gps : textHasLocation(data)
          patches.push({ start: span.start, bytes: new Uint8Array(data.length) })
        }
      } else if (box.type === 'meta') {
        report.location ||= boxHasLocation(copy)
        neutralize(copy, box, box.start)
        patches.push({ start: box.start, bytes: copy })
      } else if (scrubMovie(copy, box, report)) {
        patches.push({ start: box.start, bytes: copy })
      }
    } else if (box.type === 'uuid' && box.uuid && METADATA_UUIDS.has(box.uuid)) {
      if (box.end - box.start > BOX_MAX_BYTES) return null
      const copy = await file.read(box.start, box.end)
      report.location ||= textHasLocation(copy)
      neutralize(copy, box, box.start)
      patches.push({ start: box.start, bytes: copy })
    }
  }
  const container: MediaContainer = heif && !top.some((box) => box.type === 'moov') ? 'heif' : 'isobmff'
  if (!patches.length) return { container, location: false, details: false, parts: null }
  return { container, location: report.location, details: true, parts: patchedParts(file.size, patches) }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const ISOBMFF_FIRST = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot'])

let rasterReads = 0
const rasterQueue: Array<() => void> = []

/** Runs `read` in one of RASTER_READ_SLOTS; a finished read hands its slot to the next queued. */
async function inRasterSlot<T>(read: () => Promise<T>): Promise<T> {
  if (rasterReads < RASTER_READ_SLOTS) rasterReads++
  else await new Promise<void>((resolve) => rasterQueue.push(resolve))
  try {
    return await read()
  } finally {
    const next = rasterQueue.shift()
    if (next) next()
    else rasterReads--
  }
}

async function plan(file: ByteSource): Promise<Plan> {
  if (file.size < 8) return NOTHING
  const head = await file.read(0, Math.min(file.size, 16))
  const raster = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? 'jpeg'
    : head[0] === 0x89 && ascii(head, 1, 3) === 'PNG' ? 'png'
      : startsWith(head, 0, 'RIFF') && startsWith(head, 8, 'WEBP') ? 'webp'
        : startsWith(head, 0, 'GIF8') ? 'gif'
          : null
  try {
    if (raster) {
      if (file.size > IMAGE_MAX_BYTES) return { ...NOTHING, container: raster }
      const result = await inRasterSlot(async () => {
        const b = await file.read(0, file.size)
        return raster === 'jpeg' ? planJpeg(b)
          : raster === 'png' ? await planPng(b)
            : raster === 'webp' ? planWebp(b)
              : planGif(b)
      })
      return result ?? { ...NOTHING, container: raster }
    }
    if (ISOBMFF_FIRST.has(ascii(head, 4, 4))) return (await planIsoBmff(file)) ?? NOTHING
  } catch {
    // Unreadable: unchanged.
  }
  return NOTHING
}

const plans = new WeakMap<Blob, Promise<Plan>>()
const outputs = new WeakMap<Blob, Promise<Blob>>()

function planOf(file: Blob): Promise<Plan> {
  let pending = plans.get(file)
  if (!pending) {
    pending = plan(blobSource(file))
    plans.set(file, pending)
  }
  return pending
}

/** What the file carries: read once per Blob. */
export async function readMediaDetails(file: Blob): Promise<MediaDetails> {
  const { container, location, details } = await planOf(file)
  return { container, location, details }
}

/** What a file read through `source` carries; a video reads its box headers and moov only. */
export async function readSourceDetails(source: ByteSource): Promise<MediaDetails> {
  const { container, location, details } = await plan(source)
  return { container, location, details }
}

/**
 * The file without its metadata (see the module comment); the same Blob when there is none.
 * A File keeps its name, type and lastModified. Stripping a result again returns it unchanged.
 */
export function stripMediaMetadata<T extends Blob>(file: T): Promise<T> {
  let pending = outputs.get(file)
  if (!pending) {
    pending = planOf(file).then((result) => {
      if (!result.parts) return file
      const parts = result.parts.map((part) => (part instanceof Uint8Array ? part : file.slice(part[0], part[1])))
      const whole = new Blob(parts as BlobInput[], { type: file.type })
      // Node 18 has no global File.
      const blob = typeof File !== 'undefined' && file instanceof File
        ? new File([whole], file.name, { type: file.type, lastModified: file.lastModified })
        : whole
      plans.set(blob, Promise.resolve({ container: result.container, location: false, details: false, parts: null }))
      outputs.set(blob, Promise.resolve(blob))
      return blob
    })
    outputs.set(file, pending)
  }
  return pending as Promise<T>
}

/** `bytes` without their metadata; the same array when there is none. */
export async function stripMediaBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobInput])
  const out = await stripMediaMetadata(blob)
  return out === blob ? bytes : new Uint8Array(await out.arrayBuffer())
}

/** Image or video by type or name: the files the keep-details choice applies to. */
export function isPhotoOrVideo(file: { type?: string; name?: string }): boolean {
  if (file.type?.startsWith('image/') || file.type?.startsWith('video/')) return true
  return /\.(jpe?g|png|apng|webp|gif|heic|heif|avif|mp4|m4v|mov|3gp)$/i.test(file.name ?? '')
}
