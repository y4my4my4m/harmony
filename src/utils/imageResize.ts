/**
 * Upload preparation for profile, server and emoji images.
 *
 * A file the bucket accepts is uploaded byte for byte. A static image over the
 * bucket's size limit, or in a format the bucket refuses, is redrawn within
 * the kind's bounds: first in its own format, then as WebP, then smaller,
 * until it fits. Animated and undecodable files are never redrawn.
 */

export type ImageUploadKind =
  | 'avatar'
  | 'profile_banner'
  | 'server_icon'
  | 'server_banner'
  | 'group_icon'
  | 'emoji'

/** Largest output size per kind, used only when a file must shrink. */
export const IMAGE_SHRINK_BOUNDS: Record<ImageUploadKind, { maxWidth: number; maxHeight: number }> = {
  avatar: { maxWidth: 1024, maxHeight: 1024 },
  server_icon: { maxWidth: 1024, maxHeight: 1024 },
  group_icon: { maxWidth: 1024, maxHeight: 1024 },
  profile_banner: { maxWidth: 2560, maxHeight: 2560 },
  server_banner: { maxWidth: 2560, maxHeight: 2560 },
  emoji: { maxWidth: 256, maxHeight: 256 },
}

/** What the target bucket accepts; maxBytes <= 0 and allowedMime null mean no limit. */
export interface UploadBudget {
  maxBytes: number
  allowedMime: string[] | null
}

/** Redraw in the source format. */
const SAME_FORMAT_QUALITY = 0.92
export const WEBP_QUALITY = 0.82
const JPEG_QUALITY = 0.85
/** Each further attempt scales the previous size by this factor. */
const STEP_SCALE = 0.75
const SMALLER_STEPS = 4

/** Largest input decoded for shrinking; larger files are uploaded as they are and fail the bucket limit. */
export const MAX_IMAGE_SOURCE_BYTES = 25 * 1024 * 1024

/**
 * Cache-Control max-age, in seconds, for objects written under a fresh name.
 * Storage serves it as `max-age=31536000`; the bytes at a name never change.
 */
export const IMMUTABLE_CACHE_SECONDS = '31536000'

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif'

const FORMAT_MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

const FORMAT_EXTENSION: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
  avif: 'avif',
}

function ascii(b: Uint8Array, offset: number, length: number): string {
  if (offset + length > b.length) return ''
  let s = ''
  for (let i = offset; i < offset + length; i++) s += String.fromCharCode(b[i])
  return s
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}

/** Format from magic bytes; null for anything that is not a raster this module handles. */
export function sniffImageFormat(b: Uint8Array): ImageFormat | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (ascii(b, 0, 4) === 'GIF8') return 'gif'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  if (ascii(b, 4, 4) === 'ftyp' && (ascii(b, 8, 4) === 'avif' || ascii(b, 8, 4) === 'avis')) return 'avif'
  return null
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

/** Image descriptors (0x2C) in a GIF, counted up to 2. */
function gifFrameCount(b: Uint8Array): number {
  if (b.length < 13) return 0
  let p = 13
  const screenFlags = b[10]
  if (screenFlags & 0x80) p += 3 * (1 << ((screenFlags & 0x07) + 1))
  let frames = 0
  while (p < b.length) {
    const block = b[p]
    if (block === 0x2c) {
      frames += 1
      if (frames > 1 || p + 10 > b.length) return frames
      const localFlags = b[p + 9]
      p += 10
      if (localFlags & 0x80) p += 3 * (1 << ((localFlags & 0x07) + 1))
      p = skipGifSubBlocks(b, p + 1)
    } else if (block === 0x21) {
      p = skipGifSubBlocks(b, p + 2)
    } else {
      break
    }
  }
  return frames
}

/** APNG: an acTL chunk with more than one frame ahead of the first IDAT. */
function isAnimatedPng(b: Uint8Array): boolean {
  let p = 8
  while (p + 8 <= b.length) {
    const length = u32be(b, p)
    const type = ascii(b, p + 4, 4)
    if (type === 'IDAT') return false
    if (type === 'acTL') return p + 12 <= b.length && u32be(b, p + 8) > 1
    p += 12 + length
  }
  return false
}

/** WebP: VP8X animation flag (0x02 of the first flags byte), or an ANIM chunk. */
function isAnimatedWebp(b: Uint8Array): boolean {
  let p = 12
  while (p + 8 <= b.length) {
    const type = ascii(b, p, 4)
    const length = b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24)
    if (type === 'VP8X' && p + 9 <= b.length && (b[p + 8] & 0x02)) return true
    if (type === 'ANIM' || type === 'ANMF') return true
    p += 8 + length + (length & 1)
  }
  return false
}

export function isAnimatedImage(b: Uint8Array): boolean {
  switch (sniffImageFormat(b)) {
    case 'gif': return gifFrameCount(b) > 1
    case 'png': return isAnimatedPng(b)
    case 'webp': return isAnimatedWebp(b)
    case 'avif': return ascii(b, 8, 4) === 'avis'
    default: return false
  }
}

/** Orientation tag (0x0112) of IFD0 in a TIFF block spanning [start, end). */
function tiffOrientation(b: Uint8Array, start: number, end: number): number {
  if (start + 8 > end) return 1
  const little = ascii(b, start, 2) === 'II'
  if (!little && ascii(b, start, 2) !== 'MM') return 1
  const u16 = (o: number) => (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1])
  const u32 = (o: number) =>
    little ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : u32be(b, o)
  if (u16(start + 2) !== 42) return 1
  const ifd = start + u32(start + 4)
  if (ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return 1
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

/** EXIF orientation (1–8) of a JPEG; 1 when absent or unreadable. */
export function readJpegOrientation(b: Uint8Array): number {
  if (sniffImageFormat(b) !== 'jpeg') return 1
  let p = 2
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return 1
    const marker = b[p + 1]
    if (marker === 0xff) { p += 1; continue }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { p += 2; continue }
    // SOS and EOI: EXIF only precedes the first scan.
    if (marker === 0xda || marker === 0xd9) return 1
    const length = (b[p + 2] << 8) | b[p + 3]
    if (marker === 0xe1 && ascii(b, p + 4, 4) === 'Exif' && b[p + 8] === 0 && b[p + 9] === 0) {
      return tiffOrientation(b, p + 10, Math.min(b.length, p + 2 + length))
    }
    p += 2 + length
  }
  return 1
}

/** Displayed size of a w×h raster under an EXIF orientation; 5–8 transpose. */
export function orientedSize(orientation: number, width: number, height: number): { width: number; height: number } {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height }
}

/**
 * Canvas transform [a, b, c, d, e, f] that draws an unrotated w×h raster at
 * (0, 0) upright into a canvas of orientedSize(orientation, w, h).
 */
export function orientationMatrix(
  orientation: number,
  width: number,
  height: number,
): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, width, 0]
    case 3: return [-1, 0, 0, -1, width, height]
    case 4: return [1, 0, 0, -1, 0, height]
    case 5: return [0, 1, 1, 0, 0, 0]
    case 6: return [0, 1, -1, 0, height, 0]
    case 7: return [0, -1, -1, 0, height, width]
    case 8: return [0, -1, 1, 0, 0, width]
    default: return [1, 0, 0, 1, 0, 0]
  }
}

/** Largest size within maxWidth×maxHeight with the source aspect; never upscales. */
export function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export interface DecodedImage {
  width: number
  height: number
  source: CanvasImageSource
  close(): void
}

/** Output size, and the EXIF orientation still to be applied while drawing (1: none). */
export interface RenderTarget {
  width: number
  height: number
  orientation: number
}

export interface Raster {
  encode(type: string, quality?: number): Promise<Blob | null>
  hasAlpha(): boolean
}

export interface ImageCodec {
  decode(blob: Blob): Promise<DecodedImage | null>
  /** Whether decode() returns EXIF-oriented pixels. */
  appliesOrientation(): Promise<boolean>
  render(image: DecodedImage, target: RenderTarget): Raster | null
}

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function createCanvas(width: number, height: number): { ctx: Canvas2D; encode: Raster['encode'] } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        return {
          ctx,
          encode: (type, quality) => canvas.convertToBlob({ type, quality }).catch(() => null),
        }
      }
    } catch {
      // HTMLCanvasElement below.
    }
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  return {
    ctx,
    encode: (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality)),
  }
}

async function decodeWithImageElement(blob: Blob): Promise<DecodedImage | null> {
  if (typeof Image === 'undefined') return null
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  try {
    await img.decode()
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
  return {
    width: img.naturalWidth,
    height: img.naturalHeight,
    source: img,
    close: () => URL.revokeObjectURL(url),
  }
}

async function browserDecode(blob: Blob): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
      return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close() }
    } catch {
      // <img> below.
    }
  }
  return decodeWithImageElement(blob)
}

/** APP1 segment carrying IFD0 Orientation = 6 (rotate 90° clockwise), big-endian TIFF. */
const EXIF_ORIENTATION_6 = new Uint8Array([
  0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
  0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
  0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
])

let orientationProbe: Promise<boolean> | null = null

/**
 * Decodes a 2×1 JPEG tagged orientation 6: 1×2 means the decoder rotates.
 * Unknown (no JPEG encoder, decode failure) reads as rotating, which every
 * current engine does for both createImageBitmap('from-image') and <img>.
 */
function probeOrientation(): Promise<boolean> {
  orientationProbe ??= (async () => {
    const canvas = createCanvas(2, 1)
    if (!canvas) return true
    canvas.ctx.fillStyle = '#fff'
    canvas.ctx.fillRect(0, 0, 2, 1)
    const jpeg = await canvas.encode('image/jpeg', 0.9)
    if (!jpeg || jpeg.type !== 'image/jpeg') return true
    const body = new Uint8Array(await jpeg.arrayBuffer())
    const tagged = new Uint8Array(2 + EXIF_ORIENTATION_6.length + body.length - 2)
    tagged.set(body.subarray(0, 2), 0)
    tagged.set(EXIF_ORIENTATION_6, 2)
    tagged.set(body.subarray(2), 2 + EXIF_ORIENTATION_6.length)
    const decoded = await browserDecode(new Blob([tagged], { type: 'image/jpeg' }))
    if (!decoded) return true
    const rotated = decoded.width === 1 && decoded.height === 2
    decoded.close()
    return rotated
  })()
  return orientationProbe
}

function browserRender(image: DecodedImage, target: RenderTarget): Raster | null {
  const canvas = createCanvas(target.width, target.height)
  if (!canvas) return null
  const { ctx } = canvas
  const oriented = orientedSize(target.orientation, image.width, image.height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.setTransform(target.width / oriented.width, 0, 0, target.height / oriented.height, 0, 0)
  ctx.transform(...orientationMatrix(target.orientation, image.width, image.height))
  ctx.drawImage(image.source, 0, 0, image.width, image.height)
  return {
    encode: canvas.encode,
    hasAlpha: () => {
      const { data } = ctx.getImageData(0, 0, target.width, target.height)
      for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true
      return false
    },
  }
}

export const browserImageCodec: ImageCodec = {
  decode: browserDecode,
  appliesOrientation: probeOrientation,
  render: browserRender,
}

export interface PreparedImage {
  file: File
  /** Object name extension, without the dot. */
  extension: string
  contentType: string
  reencoded: boolean
}

function replaceExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name || 'image'}.${extension}`
}

/** The file as picked; a type the bytes contradict is replaced by the sniffed one. */
function keepOriginal(file: File, format: ImageFormat | null): PreparedImage {
  const fromName = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : ''
  const contentType = format ? FORMAT_MIME[format] : file.type || 'application/octet-stream'
  return {
    file: format && file.type !== contentType ? new File([file], file.name, { type: contentType }) : file,
    extension: format ? FORMAT_EXTENSION[format] : fromName || 'bin',
    contentType,
    reencoded: false,
  }
}

/** Formats the canvas encoders write. */
const ENCODABLE: Partial<Record<ImageFormat, { type: string; extension: string; quality?: number }>> = {
  png: { type: 'image/png', extension: 'png' },
  jpeg: { type: 'image/jpeg', extension: 'jpg', quality: SAME_FORMAT_QUALITY },
  webp: { type: 'image/webp', extension: 'webp', quality: SAME_FORMAT_QUALITY },
}

interface Encoded {
  blob: Blob
  type: string
  extension: string
}

async function encodeAs(raster: Raster, type: string, extension: string, quality?: number): Promise<Encoded | null> {
  const blob = await raster.encode(type, quality)
  // Engines without an encoder for `type` return PNG.
  return blob?.type === type ? { blob, type, extension } : null
}

/**
 * WebP; where the engine has no WebP encoder (WebKit returns PNG), JPEG for
 * opaque pixels and PNG otherwise.
 */
async function encodeCompact(raster: Raster, source: ImageFormat): Promise<Encoded | null> {
  const webp = await encodeAs(raster, 'image/webp', 'webp', WEBP_QUALITY)
  if (webp) return webp
  if (source === 'jpeg' || source === 'bmp' || !raster.hasAlpha()) {
    const jpeg = await encodeAs(raster, 'image/jpeg', 'jpg', JPEG_QUALITY)
    if (jpeg) return jpeg
  }
  return encodeAs(raster, 'image/png', 'png')
}

function accepts(budget: UploadBudget, type: string): boolean {
  return !budget.allowedMime || budget.allowedMime.includes(type)
}

function fits(budget: UploadBudget, type: string, size: number): boolean {
  return accepts(budget, type) && (budget.maxBytes <= 0 || size <= budget.maxBytes)
}

/**
 * The file to upload for `kind` into a bucket with `budget`. The original
 * when the bucket accepts it as is, when it is animated, or when it cannot be
 * decoded; otherwise the first redraw that fits (see the module comment). An
 * original that never fits is returned unchanged for the bucket check to refuse.
 */
export async function prepareImageUpload(
  file: File,
  kind: ImageUploadKind,
  budget: UploadBudget,
  codec: ImageCodec = browserImageCodec,
): Promise<PreparedImage> {
  if (file.size > MAX_IMAGE_SOURCE_BYTES) return keepOriginal(file, null)
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    return keepOriginal(file, null)
  }
  const format = sniffImageFormat(bytes)
  const original = keepOriginal(file, format)
  if (fits(budget, original.contentType, file.size)) return original
  if (!format || isAnimatedImage(bytes)) return original

  const decoded = await codec.decode(file).catch(() => null)
  if (!decoded) return original

  try {
    const exif = format === 'jpeg' ? readJpegOrientation(bytes) : 1
    const pending = exif > 1 && !(await codec.appliesOrientation()) ? exif : 1
    const upright = orientedSize(pending, decoded.width, decoded.height)
    const bounds = IMAGE_SHRINK_BOUNDS[kind]
    let target = fitWithin(upright.width, upright.height, bounds.maxWidth, bounds.maxHeight)

    const sameFormat = ENCODABLE[format]
    for (let step = 0; step <= SMALLER_STEPS; step++) {
      const raster = codec.render(decoded, { ...target, orientation: pending })
      if (!raster) return original
      const attempts: Array<() => Promise<Encoded | null>> = []
      if (step === 0 && sameFormat && accepts(budget, sameFormat.type)) {
        attempts.push(() => encodeAs(raster, sameFormat.type, sameFormat.extension, sameFormat.quality))
      }
      attempts.push(() => encodeCompact(raster, format))
      for (const attempt of attempts) {
        const encoded = await attempt()
        if (encoded && fits(budget, encoded.type, encoded.blob.size)) {
          return {
            file: new File([encoded.blob], replaceExtension(file.name, encoded.extension), { type: encoded.type }),
            extension: encoded.extension,
            contentType: encoded.type,
            reencoded: true,
          }
        }
      }
      target = {
        width: Math.max(1, Math.round(target.width * STEP_SCALE)),
        height: Math.max(1, Math.round(target.height * STEP_SCALE)),
      }
    }
    return original
  } finally {
    decoded.close()
  }
}

/** `<folder>/<stem>-<ms>.<ext>`: a name no later upload reuses. */
export function immutableObjectPath(folder: string, stem: string, extension: string): string {
  return `${folder}/${stem}-${Date.now()}.${extension}`
}

/** supabase-js upload options for an object written under a fresh name. */
export function immutableUploadOptions(prepared: PreparedImage) {
  return { contentType: prepared.contentType, cacheControl: IMMUTABLE_CACHE_SECONDS, upsert: false }
}
