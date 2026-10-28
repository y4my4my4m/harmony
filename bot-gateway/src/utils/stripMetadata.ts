/**
 * Removal of location and identifying metadata from photos and videos, on the device, before
 * upload. Lossless: no pixel or sample data is decoded or re-encoded.
 *
 * JPEG  APP0 other than JFIF, APP1 (Exif, XMP), APP2 other than ICC_PROFILE (MPF, FPXR),
 *       APP3–APP13 (APP13: IPTC), APP14 other than Adobe, APP15, COM, and every byte after EOI
 *       (MPF secondary images, maker trailers) are dropped. JFIF APP0 is cut to its 16-byte form,
 *       thumbnail 0×0; JFXX APP0 (thumbnail) is dropped. An Exif orientation other than 1 is kept as
 *       a 36-byte APP1 holding IFD0 Orientation alone, after SOI and any leading APP0. Bytes between
 *       segments that start no marker are skipped as libjpeg's next_marker() skips them, and kept.
 * PNG   Chunks outside PNG_KEEP (eXIf, tEXt, iTXt, zTXt, tIME, private chunks) and bytes after IEND.
 *       APNG chunks (acTL, fcTL, fdAT) are kept. An eXIf orientation other than 1 is kept as an
 *       eXIf holding IFD0 Orientation alone, in place of the first eXIf: Chromium 148 and Firefox 150
 *       rotate by it, WebKitGTK 26.4 does not (measured 2026-10-29). A missing IEND is accepted.
 * WebP  Chunks outside WEBP_KEEP (EXIF, XMP, unknown); VP8X flags E (0x08) and X (0x04) cleared;
 *       RIFF size rewritten; bytes after the RIFF payload dropped. EXIF orientation is not kept:
 *       Chromium 148, Firefox 150 and WebKitGTK 26.4 ignore it (measured 2026-10-29).
 * GIF   Comment extensions (0x21 0xFE), application extensions other than NETSCAPE2.0, ANIMEXTS1.0
 *       and ICCRGBG1012 (XMP DataXMP among them), and bytes after the trailer (0x3B). A block other
 *       than image, extension or trailer ends the stream, as in Chromium's GIFImageReader.
 * HEIF  HEIC/AVIF still images: payloads of items of type Exif, and of mime items with content type
 *       application/rdf+xml (XMP), are zeroed in place (iinf/iloc, construction methods 0 and 1).
 * ISOBMFF video (MP4, MOV, 3GP): moov/udta (©xyz, loci, XMP), moov/meta (mdta keys/ilst:
 *       com.apple.quicktime.location.ISO6709, make, model), trak/udta, trak/meta, top-level non-image
 *       meta, and XMP/USMT/PROF uuid boxes become `free` boxes of the same size with zeroed payload.
 *       No byte moves, so stco/co64 chunk offsets stay valid.
 *
 * A segment, chunk or box cut short by the end of the file runs to it. A recognised file that is not
 * walked to its end (a structure decoders reject, a size or count limit, a failed read) reports
 * `details` true and `location` as far as read: what it carries is unknown.
 *
 * Not handled, uploaded unchanged: timed metadata tracks (GoPro gpmd, camm), Matroska/WebM tags,
 * TIFF/DNG, JPEG XL, raster files over IMAGE_MAX_BYTES, and audio (audio/* types, ISOBMFF major
 * brands in AUDIO_BRANDS), whose tags stay as MP3 ID3 tags do.
 */

export type MediaContainer = 'jpeg' | 'png' | 'webp' | 'gif' | 'heif' | 'isobmff'

export interface MediaDetails {
  /** Null: a format this module leaves unchanged. */
  container: MediaContainer | null
  /** A GPS position: Exif GPS IFD latitude/longitude, XMP GPS, ©xyz, loci, ISO6709 keys. */
  location: boolean
  /** Anything stripMediaMetadata removes; also true when what a recognised file carries is unknown. */
  details: boolean
  /** Present when the file was not read through: `details` is true, `location` as far as read. */
  unknown?: true
}

/** Rasters are parsed in memory; larger ones are uploaded unchanged. */
export const IMAGE_MAX_BYTES = 256 * 1024 * 1024

/** moov and HEIF meta boxes are read whole; larger ones are left unchanged. */
const BOX_MAX_BYTES = 256 * 1024 * 1024

/** Top-level boxes walked; boxes past them are left unchanged and the details are unknown. */
export const TOP_LEVEL_BOX_MAX = 4096

/** Top-level box headers read 32 bytes each, up to this many; later ones through BOX_WINDOW_BYTES reads. */
const HEADER_EXACT_READS = 8
const BOX_WINDOW_BYTES = 64 * 1024

/** Text inflated from one zTXt/iTXt chunk, and from all of a file's, for location detection. */
export const INFLATE_CHUNK_MAX_BYTES = 1024 * 1024
const INFLATE_FILE_MAX_BYTES = 4 * 1024 * 1024

/** Compressed bytes per write: deflate expands at most 1032:1, so one write yields at most ~1 MiB. */
const INFLATE_WRITE_BYTES = 1024

/** Rasters read into memory at once; a batch of picked photos queues behind these. */
const RASTER_READ_SLOTS = 2

/** ISOBMFF major brands of audio-only files: iTunes AAC, audiobook, protected AAC, Flash audio. */
const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B '])

/** Byte range of the source, or literal bytes. */
type Part = readonly [number, number] | Uint8Array

/** BlobPart, which Node's lib (no DOM) does not name. */
type BlobInput = NonNullable<ConstructorParameters<typeof Blob>[0]>[number]

interface Plan extends Omit<MediaDetails, 'unknown'> {
  /** Null: the output equals the input. */
  parts: Part[] | null
  /** Part of the file was not walked; `details` is true. */
  unknown: boolean
}

const NOTHING: Plan = { container: null, location: false, details: false, parts: null, unknown: false }

/** State of one walk. */
interface Scan {
  /** Location detection; off where the bytes are only stripped, so no text is inflated or scanned. */
  readonly detect: boolean
  /** Part of a recognised file was not walked. */
  unknown: boolean
}

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

/** Dropped spans and inserted bytes, in source offsets, as a JPEG/PNG/GIF walk emits them. */
class Splicer {
  private readonly edits: Array<{ start: number; end: number; bytes?: Uint8Array }> = []
  dropped = false

  drop(start: number, end: number): void {
    if (end <= start) return
    this.edits.push({ start, end })
    this.dropped = true
  }

  /** `bytes` placed at source offset `at`, ahead of a span dropped from there. */
  insert(at: number, bytes: Uint8Array): void {
    this.edits.push({ start: at, end: at, bytes })
  }

  finish(size: number): Part[] {
    const parts: Part[] = []
    let cursor = 0
    for (const edit of [...this.edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
      if (edit.start > cursor) parts.push([cursor, edit.start])
      if (edit.bytes) parts.push(edit.bytes)
      cursor = Math.max(cursor, edit.end)
    }
    if (cursor < size) parts.push([cursor, size])
    return parts
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
 * Big-endian TIFF, IFD0 with Orientation alone (SHORT, count 1), no IFD1. 26 bytes: `MM` 002A
 * 00000008, count 0001, entry 0112 0003 00000001 000N 0000, next IFD 00000000.
 */
function orientationTiff(orientation: number): Uint8Array {
  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation & 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ])
}

/** APP1 Exif segment of orientationTiff. 36 bytes: FF E1, length 0x0022, `Exif\0\0`, TIFF. */
export function orientationSegment(orientation: number): Uint8Array {
  const segment = new Uint8Array(36)
  segment.set([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00])
  segment.set(orientationTiff(orientation), 10)
  return segment
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/**
 * JFIF APP0 at p without its thumbnail: FF E0, length 0x0010, the 12 bytes `JFIF\0`, version,
 * units, Xdensity, Ydensity, then Xthumbnail 0, Ythumbnail 0.
 */
function bareJfif(b: Uint8Array, p: number): Uint8Array {
  const segment = new Uint8Array(18)
  segment.set([0xff, 0xe0, 0x00, 0x10])
  segment.set(b.subarray(p + 4, p + 16), 4)
  return segment
}

function planJpeg(b: Uint8Array, scan: Scan): Plan {
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
    // libjpeg next_marker(): bytes other than FF are skipped, fill FFs swallowed, FF 00 discarded.
    while (p < n && b[p] !== 0xff) p++
    while (p + 1 < n && b[p + 1] === 0xff) p++
    if (p + 1 >= n) break
    const marker = b[p + 1]
    if (marker === 0x00) { p += 2; continue }
    if (marker === 0xd9) {
      p += 2
      if (p < n) out.drop(p, n)
      break
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; leading = false; continue }
    if (p + 4 > n) break
    const length = u16be(b, p + 2)
    const app = marker >= 0xe0 && marker <= 0xef
    // libjpeg skip_variable()/save_marker() take an APPn or COM length under 2 as its 2 length
    // bytes alone; other segments with one stop the decode (JERR_BAD_LENGTH).
    if (length < 2 && !(app || marker === 0xfe)) {
      scan.unknown = true
      break
    }
    const end = Math.min(n, p + 2 + Math.max(2, length))
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker: FF followed by neither 00, FF nor RSTn.
      let q = end
      while (q + 1 < n && !(b[q] === 0xff && b[q + 1] !== 0 && b[q + 1] !== 0xff && (b[q + 1] < 0xd0 || b[q + 1] > 0xd7))) q++
      p = q + 1 < n ? q : n
      leading = false
      continue
    }
    if (app || marker === 0xfe) {
      const body = p + 4
      const id = (text: string) => body + text.length <= end && startsWith(b, body, text)
      let keep = false
      if (marker === 0xe0 && id('JFIF\0')) {
        keep = true
        // Length 16 + 3·Xthumbnail·Ythumbnail; Xthumbnail and Ythumbnail at p + 16, p + 17.
        if (end - p >= 18 && (end - p > 18 || b[p + 16] || b[p + 17])) {
          out.drop(p, end)
          out.insert(p, bareJfif(b, p))
        }
      } else if (marker === 0xe2) keep = id('ICC_PROFILE\0')
      else if (marker === 0xee) keep = id('Adobe')
      else if (marker === 0xe1 && id('Exif\0\0')) {
        const info = readTiff(b, body + 6, end)
        if (!exifSeen) {
          exifSeen = true
          orientation = info.orientation
          keep = minimalExif = equalBytes(b.subarray(p, end), orientationSegment(info.orientation))
        }
        location ||= info.gps
      } else if (marker === 0xe1 && scan.detect) {
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
  if (!out.dropped) return { container: 'jpeg', location, details: false, parts: null, unknown: false }
  if (orientation !== 1 && !minimalExif) out.insert(insertAt, orientationSegment(orientation))
  return { container: 'jpeg', location, details: true, parts: out.finish(n), unknown: false }
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV',
  'cLLI', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT',
])

/**
 * The first `max` bytes zlib data `b` inflates to, or fewer when it ends or breaks first. Input
 * goes in INFLATE_WRITE_BYTES writes and reading stops at `max`, so a bomb costs at most about
 * `max` plus one write's output.
 */
async function inflate(b: Uint8Array, max: number): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined' || max <= 0) return null
  const stream = new DecompressionStream('deflate')
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let stopped = false
  void (async () => {
    for (let i = 0; i < b.length && !stopped; i += INFLATE_WRITE_BYTES) {
      // slice, not subarray: TypeScript 5.7+ types the chunk as an ArrayBuffer-backed view.
      await writer.write(b.slice(i, i + INFLATE_WRITE_BYTES))
    }
    if (!stopped) await writer.close()
  })().catch(() => {})
  try {
    while (total < max) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
  } catch {
    // Corrupt or cut deflate data: the text inflated ahead of the fault.
  } finally {
    stopped = true
    reader.cancel().catch(() => {})
  }
  const text = new Uint8Array(Math.min(total, max))
  let o = 0
  for (const chunk of chunks) {
    if (o >= text.length) break
    text.set(chunk.subarray(0, text.length - o), o)
    o += chunk.length
  }
  return text
}

/** Inflated text for one chunk, charged to the file's remaining `budget`. */
async function inflateText(b: Uint8Array, budget: { bytes: number }): Promise<Uint8Array | null> {
  const text = await inflate(b, Math.min(INFLATE_CHUNK_MAX_BYTES, budget.bytes))
  if (text) budget.bytes -= text.length
  return text
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
async function pngTextHasLocation(type: string, data: Uint8Array, budget: { bytes: number }): Promise<boolean> {
  const nul = data.indexOf(0)
  if (nul < 0) return false
  const key = ascii(data, 0, nul)
  let text: Uint8Array | null = null
  if (type === 'tEXt') text = data.subarray(nul + 1)
  else if (type === 'zTXt') text = await inflateText(data.subarray(nul + 2), budget)
  else {
    const compressed = data[nul + 1] === 1
    const lang = data.indexOf(0, nul + 3)
    const tkey = lang < 0 ? -1 : data.indexOf(0, lang + 1)
    if (tkey < 0) return false
    text = compressed ? await inflateText(data.subarray(tkey + 1), budget) : data.subarray(tkey + 1)
  }
  if (!text) return false
  if (/^Raw profile type (exif|APP1)$/i.test(key)) {
    const raw = rawProfileBytes(latin1(text))
    return !!raw && exifInfo(raw).gps
  }
  return textHasLocation(text)
}

/** PNG chunk: length, type, data, CRC-32 over type and data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length)
  const n = data.length
  chunk.set([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i)
  chunk.set(data, 8)
  // CRC-32, reflected polynomial 0xEDB88320 (PNG specification, annex D).
  let crc = 0xffffffff
  for (let i = 4; i < 8 + n; i++) {
    crc ^= chunk[i]
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  crc = (crc ^ 0xffffffff) >>> 0
  chunk.set([crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff], 8 + n)
  return chunk
}

/** Four ASCII letters (PNG chunk type). */
function isPngType(b: Uint8Array, o: number): boolean {
  for (let i = o; i < o + 4; i++) {
    const c = b[i] | 0x20
    if (c < 0x61 || c > 0x7a) return false
  }
  return true
}

async function planPng(b: Uint8Array, scan: Scan): Promise<Plan> {
  const n = b.length
  const out = new Splicer()
  const budget = { bytes: INFLATE_FILE_MAX_BYTES }
  let location = false
  let exifSeen = false
  let trailing = true
  let p = 8
  while (p < n) {
    // Fewer than 8 bytes left: no chunk, dropped below.
    if (p + 8 > n) break
    // libpng rejects a chunk type other than four letters; the rest is left as it is.
    if (!isPngType(b, p + 4)) {
      scan.unknown = true
      trailing = false
      break
    }
    const length = u32be(b, p)
    const type = ascii(b, p + 4, 4)
    const end = Math.min(n, p + 12 + length)
    if (!PNG_KEEP.has(type)) {
      const data = b.subarray(p + 8, Math.min(end, p + 8 + length))
      if (type === 'eXIf' && !exifSeen) {
        exifSeen = true
        const info = exifInfo(data)
        location ||= info.gps
        const minimal = orientationTiff(info.orientation)
        if (end - p !== 12 + minimal.length || !equalBytes(data, minimal)) {
          out.drop(p, end)
          if (info.orientation !== 1) out.insert(p, pngChunk('eXIf', minimal))
        }
      } else {
        if (type === 'eXIf') location ||= exifInfo(data).gps
        else if (scan.detect && (type === 'tEXt' || type === 'zTXt' || type === 'iTXt')) {
          location ||= await pngTextHasLocation(type, data, budget)
        }
        out.drop(p, end)
      }
    }
    p = end
    if (type === 'IEND') break
  }
  if (trailing && p < n) out.drop(p, n)
  return { container: 'png', location, details: out.dropped, parts: out.dropped ? out.finish(n) : null, unknown: false }
}

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP'])

function planWebp(b: Uint8Array, scan: Scan): Plan {
  const riffEnd = Math.min(b.length, 8 + u32le(b, 4))
  const kept: Part[] = []
  let size = 4
  let location = false
  let details = riffEnd < b.length
  let p = 12
  while (p < riffEnd) {
    // Fewer than 8 bytes left: no chunk, dropped.
    if (p + 8 > riffEnd) {
      details = true
      break
    }
    const type = ascii(b, p, 4)
    const length = u32le(b, p + 4)
    // An odd chunk is followed by one pad byte; a final chunk may lack it.
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
      const data = b.subarray(p + 8, Math.min(end, p + 8 + length))
      if (type === 'EXIF') location ||= exifInfo(data).gps
      else if (scan.detect) location ||= textHasLocation(data)
      details = true
    }
    p = end
  }
  if (!details) return { container: 'webp', location, details: false, parts: null, unknown: false }
  const header = b.slice(0, 12)
  header[4] = size & 0xff
  header[5] = (size >>> 8) & 0xff
  header[6] = (size >>> 16) & 0xff
  header[7] = (size >>> 24) & 0xff
  return { container: 'webp', location, details: true, parts: [header, ...kept], unknown: false }
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

const GIF_KEEP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012'])

/** End of a run of data sub-blocks starting at p (length byte, data), after its 0 terminator; the end of the file when cut short. */
function gifSubBlocksEnd(b: Uint8Array, p: number): number {
  while (p < b.length) {
    const size = b[p]
    p += 1
    if (size === 0) return p
    p += size
  }
  return b.length
}

function planGif(b: Uint8Array, scan: Scan): Plan {
  const n = b.length
  const out = new Splicer()
  let location = false
  let p = 13
  const flags = b[10]
  if (flags & 0x80) p += 3 * (1 << ((flags & 0x07) + 1))
  // Chromium's GIFImageReader ends the stream at a block other than image, extension or trailer;
  // what follows it is dropped with the bytes after the trailer.
  while (p < n) {
    const block = b[p]
    if (block === 0x3b) {
      p += 1
      break
    }
    if (block === 0x2c) {
      const local = p + 9 < n ? b[p + 9] : 0
      let q = p + 10
      if (local & 0x80) q += 3 * (1 << ((local & 0x07) + 1))
      p = gifSubBlocksEnd(b, q + 1)
    } else if (block === 0x21) {
      const label = b[p + 1]
      const end = gifSubBlocksEnd(b, p + 2)
      const app = label === 0xff && b[p + 2] === 11 ? ascii(b, p + 3, 11) : null
      if (label === 0xfe || (label === 0xff && !(app && GIF_KEEP_APPS.has(app)))) {
        if (scan.detect && app?.startsWith('XMP Data')) location ||= textHasLocation(b.subarray(p + 14, end))
        out.drop(p, end)
      }
      p = end
    } else {
      break
    }
  }
  if (p < n) out.drop(p, n)
  return { container: 'gif', location, details: out.dropped, parts: out.dropped ? out.finish(n) : null, unknown: false }
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

/**
 * Boxes in b[start, end); a box running past `end` ends there, and fewer than 8 bytes left over
 * hold no box. Stops at a size smaller than its header, with `intact` false.
 */
function boxesIn(b: Uint8Array, start: number, end: number, base = 0): { boxes: Box[]; intact: boolean } {
  const boxes: Box[] = []
  let p = start
  while (p + 8 <= end) {
    let size = u32be(b, p)
    const type = ascii(b, p + 4, 4)
    let header = 8
    if (size === 1) {
      if (p + 16 > end) return { boxes, intact: false }
      size = uintBe(b, p + 8, 8)
      header = 16
    } else if (size === 0) {
      size = end - p
    }
    if (size < header) return { boxes, intact: false }
    const boxEnd = Math.min(end, p + size)
    const box: Box = { type, start: base + p, body: base + p + header, end: base + boxEnd }
    if (type === 'uuid' && p + header + 16 <= boxEnd) {
      box.uuid = Array.from(b.subarray(p + header, p + header + 16), (x) => x.toString(16).padStart(2, '0')).join('')
      box.body += 16
    }
    boxes.push(box)
    p = boxEnd
  }
  return { boxes, intact: true }
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

/**
 * Top-level boxes. The first HEADER_EXACT_READS headers cost a 32-byte read each; later ones are
 * parsed from BOX_WINDOW_BYTES reads, so a run of small boxes (fragmented MP4) costs one read per
 * window. A box running past the file ends with it. Marks the scan unknown at a size smaller than
 * its header and past TOP_LEVEL_BOX_MAX boxes.
 */
async function topLevelBoxes(file: ByteSource, scan: Scan): Promise<Box[]> {
  const boxes: Box[] = []
  let window: Uint8Array = new Uint8Array(0)
  let windowStart = 0
  let p = 0
  while (p + 8 <= file.size) {
    if (boxes.length === TOP_LEVEL_BOX_MAX) {
      scan.unknown = true
      break
    }
    // Size, type, largesize and uuid usertype: at most 32 bytes.
    const need = Math.min(file.size, p + 32)
    if (need > windowStart + window.length) {
      windowStart = p
      window = await file.read(p, Math.min(file.size, p + (boxes.length < HEADER_EXACT_READS ? 32 : BOX_WINDOW_BYTES)))
    }
    const head = window.subarray(p - windowStart, need - windowStart)
    if (head.length < 8) {
      scan.unknown = true
      break
    }
    let size = u32be(head, 0)
    let header = 8
    if (size === 1) {
      if (head.length < 16) break
      size = uintBe(head, 8, 8)
      header = 16
    } else if (size === 0) {
      size = file.size - p
    }
    if (size < header) {
      scan.unknown = true
      break
    }
    const end = Math.min(file.size, p + size)
    const box: Box = { type: ascii(head, 4, 4), start: p, body: p + header, end }
    if (box.type === 'uuid' && head.length >= header + 16) {
      box.uuid = Array.from(head.subarray(header, header + 16), (x) => x.toString(16).padStart(2, '0')).join('')
      box.body += 16
    }
    boxes.push(box)
    p = end
  }
  return boxes
}

interface Patch {
  start: number
  bytes: Uint8Array
}

/** Patches applied over the source; `bytes` replace [start, start + bytes.length). Overlaps keep the earlier patch. */
function patchedParts(size: number, patches: Patch[]): Part[] {
  const parts: Part[] = []
  let cursor = 0
  for (const patch of [...patches].sort((a, b) => a.start - b.start)) {
    const end = patch.start + patch.bytes.length
    if (end <= cursor) continue
    if (patch.start > cursor) parts.push([cursor, patch.start])
    parts.push(patch.start >= cursor ? patch.bytes : patch.bytes.subarray(cursor - patch.start))
    cursor = end
  }
  if (cursor < size) parts.push([cursor, size])
  return parts
}

/**
 * Neutralizes, in `copy` (the bytes of moov), its udta, meta and metadata uuid boxes and those of
 * each trak. True when there was one.
 */
function scrubMovie(copy: Uint8Array, box: Box, report: { location: boolean }, scan: Scan): boolean {
  let changed = false
  const visit = (start: number, end: number, depth: number) => {
    const { boxes: children, intact } = boxesIn(copy, start - box.start, end - box.start, box.start)
    if (!intact) scan.unknown = true
    for (const child of children) {
      const metadata = child.type === 'udta' || child.type === 'meta'
        || (child.type === 'uuid' && !!child.uuid && METADATA_UUIDS.has(child.uuid))
      if (metadata) {
        if (scan.detect) report.location ||= boxHasLocation(copy.subarray(child.start - box.start, child.end - box.start))
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
  const { boxes } = boxesIn(meta, box.body - box.start + 4, box.end - box.start, box.start)
  const hdlr = boxes.find((c) => c.type === 'hdlr')
  return hdlr ? ascii(meta, hdlr.body - box.start + 8, 4) : null
}

/** File byte spans of Exif and XMP items of a HEIF meta box; marks the scan unknown where iinf/iloc cannot be read through. */
function heifMetadataExtents(meta: Uint8Array, box: Box, scan: Scan): Array<{ start: number; end: number; exif: boolean }> {
  const base = box.start
  const { boxes: children, intact } = boxesIn(meta, box.body - base + 4, box.end - base, base)
  if (!intact) scan.unknown = true
  const targets = new Map<number, boolean>()
  const iinf = children.find((c) => c.type === 'iinf')
  if (iinf) {
    const at = iinf.body - base
    const version = meta[at]
    const first = at + 4 + (version === 0 ? 2 : 4)
    const entries = boxesIn(meta, first, iinf.end - base, base)
    if (!entries.intact) scan.unknown = true
    for (const infe of entries.boxes) {
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
  const spans: Array<{ start: number; end: number; exif: boolean }> = []
  if (!targets.size) return spans
  const iloc = children.find((c) => c.type === 'iloc')
  const idat = children.find((c) => c.type === 'idat')
  if (!iloc) {
    scan.unknown = true
    return spans
  }
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
  // Each item takes at least its fixed fields; the box's size bounds the loop, never `count`
  // (a u32 from the file: 0xFFFFFFFF items past the box end read zeros, never the inner guard).
  const itemMin = (version < 2 ? 2 : 4) + (version === 1 || version === 2 ? 2 : 0) + 2 + baseOffsetSize + 2
  for (let i = 0; i < count; i++) {
    if (q + itemMin > iloc.end - base) {
      scan.unknown = true
      return spans
    }
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
      if (q > iloc.end - base) {
        scan.unknown = true
        return spans
      }
      const exif = targets.get(id)
      if (exif === undefined || length === 0) continue
      if (method === 0) spans.push({ start: baseOffset + offset, end: baseOffset + offset + length, exif })
      else if (method === 1 && idat) spans.push({ start: idat.body + baseOffset + offset, end: idat.body + baseOffset + offset + length, exif })
    }
  }
  return spans
}

async function planIsoBmff(file: ByteSource, scan: Scan): Promise<Plan> {
  const top = await topLevelBoxes(file, scan)
  const ftyp = top.find((box) => box.type === 'ftyp')
  let heif = false
  if (ftyp && ftyp.end - ftyp.start <= 4096) {
    const f = await file.read(ftyp.body, ftyp.end)
    if (AUDIO_BRANDS.has(ascii(f, 0, 4))) return NOTHING
    for (let i = 0; i + 4 <= f.length; i += 4) if (i !== 4 && HEIF_BRANDS.has(ascii(f, i, 4))) heif = true
  }
  const report = { location: false }
  const patches: Patch[] = []
  for (const box of top) {
    if (box.type === 'moov' || box.type === 'meta') {
      if (box.end - box.start > BOX_MAX_BYTES) {
        scan.unknown = true
        continue
      }
      const copy = await file.read(box.start, box.end)
      if (box.type === 'meta' && (heif || metaHandler(copy, box) === 'pict')) {
        for (const span of heifMetadataExtents(copy, box, scan)) {
          const end = Math.min(span.end, file.size)
          if (span.start >= end) continue
          if (end - span.start > BOX_MAX_BYTES) {
            scan.unknown = true
            continue
          }
          const data = await file.read(span.start, end)
          if (data.every((x) => x === 0)) continue
          // Exif item payload: 4-byte exif_tiff_header_offset, then TIFF.
          if (span.exif) report.location ||= readTiff(data, 4 + u32be(data, 0)).gps
          else if (scan.detect) report.location ||= textHasLocation(data)
          patches.push({ start: span.start, bytes: new Uint8Array(data.length) })
        }
      } else if (box.type === 'meta') {
        if (scan.detect) report.location ||= boxHasLocation(copy)
        neutralize(copy, box, box.start)
        patches.push({ start: box.start, bytes: copy })
      } else if (scrubMovie(copy, box, report, scan)) {
        patches.push({ start: box.start, bytes: copy })
      }
    } else if (box.type === 'uuid' && box.uuid && METADATA_UUIDS.has(box.uuid)) {
      if (box.end - box.start > BOX_MAX_BYTES) {
        scan.unknown = true
        continue
      }
      const copy = await file.read(box.start, box.end)
      if (scan.detect) report.location ||= textHasLocation(copy)
      neutralize(copy, box, box.start)
      patches.push({ start: box.start, bytes: copy })
    }
  }
  const container: MediaContainer = heif && !top.some((box) => box.type === 'moov') ? 'heif' : 'isobmff'
  if (!patches.length) return { container, location: false, details: false, parts: null, unknown: false }
  return { container, location: report.location, details: true, parts: patchedParts(file.size, patches), unknown: false }
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

interface PlanOptions {
  detect: boolean
  /** MIME type of a Blob; audio/* is left unchanged. */
  type?: string
}

async function plan(file: ByteSource, options: PlanOptions): Promise<Plan> {
  if (file.size < 8 || options.type?.startsWith('audio/')) return NOTHING
  const head = await file.read(0, Math.min(file.size, 16))
  const raster = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? 'jpeg'
    : head[0] === 0x89 && ascii(head, 1, 3) === 'PNG' ? 'png'
      : startsWith(head, 0, 'RIFF') && startsWith(head, 8, 'WEBP') ? 'webp'
        : startsWith(head, 0, 'GIF8') ? 'gif'
          : null
  const container: MediaContainer | null = raster ?? (ISOBMFF_FIRST.has(ascii(head, 4, 4)) ? 'isobmff' : null)
  if (!container) return NOTHING
  const unknown: Plan = { container, location: false, details: true, parts: null, unknown: true }
  const scan: Scan = { detect: options.detect, unknown: false }
  let result: Plan
  try {
    if (raster) {
      if (file.size > IMAGE_MAX_BYTES) return unknown
      result = await inRasterSlot(async () => {
        const b = await file.read(0, file.size)
        return raster === 'jpeg' ? planJpeg(b, scan)
          : raster === 'png' ? await planPng(b, scan)
            : raster === 'webp' ? planWebp(b, scan)
              : planGif(b, scan)
      })
    } else {
      result = await planIsoBmff(file, scan)
    }
  } catch {
    // A failed read: unchanged, details unknown.
    return unknown
  }
  return result.container && scan.unknown ? { ...result, details: true, unknown: true } : result
}

const plans = new WeakMap<Blob, Promise<Plan>>()
const outputs = new WeakMap<Blob, Promise<Blob>>()

function planOf(file: Blob): Promise<Plan> {
  let pending = plans.get(file)
  if (!pending) {
    pending = plan(blobSource(file), { detect: true, type: file.type })
    plans.set(file, pending)
  }
  return pending
}

function detailsOf({ container, location, details, unknown }: Plan): MediaDetails {
  return unknown ? { container, location, details, unknown } : { container, location, details }
}

/** What the file carries: read once per Blob. */
export async function readMediaDetails(file: Blob): Promise<MediaDetails> {
  return detailsOf(await planOf(file))
}

/** What a file read through `source` carries; a video reads its box headers and moov only. */
export async function readSourceDetails(source: ByteSource): Promise<MediaDetails> {
  return detailsOf(await plan(source, { detect: true }))
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
      const { container, unknown } = result
      plans.set(blob, Promise.resolve({ container, location: false, details: unknown, parts: null, unknown }))
      outputs.set(blob, Promise.resolve(blob))
      return blob
    })
    outputs.set(file, pending)
  }
  return pending as Promise<T>
}

/**
 * `bytes` without their metadata; the same array when there is none. Strips only: no location
 * detection, so no text is inflated or scanned.
 */
export async function stripMediaBytes(bytes: Uint8Array): Promise<Uint8Array> {
  // Copies: the ISOBMFF walk patches the bytes it reads.
  const source: ByteSource = { size: bytes.length, read: async (start, end) => bytes.slice(start, end) }
  const { parts } = await plan(source, { detect: false })
  if (!parts) return bytes
  const pieces = parts.map((part) => (part instanceof Uint8Array ? part : bytes.subarray(part[0], part[1])))
  const out = new Uint8Array(pieces.reduce((n, piece) => n + piece.length, 0))
  let o = 0
  for (const piece of pieces) {
    out.set(piece, o)
    o += piece.length
  }
  return out
}

/** Image or video by type or name: the files the keep-details choice applies to. */
export function isPhotoOrVideo(file: { type?: string; name?: string }): boolean {
  if (file.type?.startsWith('image/') || file.type?.startsWith('video/')) return true
  return /\.(jpe?g|png|apng|webp|gif|heic|heif|avif|mp4|m4v|mov|3gp)$/i.test(file.name ?? '')
}
