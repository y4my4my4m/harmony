/**
 * Decode, inspect and export for the image crop editor.
 *
 * Sources decode upright (EXIF orientation applied) into an ImageBitmap where
 * the engine has createImageBitmap; a downscaled copy drives the interactive
 * preview and the full image is drawn only on export.
 */

import {
  browserImageCodec,
  createCanvas,
  isAnimatedImage,
  orientationMatrix,
  orientedSize,
  readJpegOrientation,
  replaceExtension,
  sniffImageFormat,
  type ImageCodec,
  type ImageFormat,
} from './imageResize'
import { cropDrawMatrix, cropRect, outputSize, sourceRect, type CropState, type Size } from './cropGeometry'

export type CropPresetKind = 'avatar' | 'profile_banner' | 'server_icon' | 'server_banner' | 'group_icon'

export type FrameShape = 'circle' | 'rounded' | 'rect'

export interface CropPreset {
  /** Width over height. */
  aspect: number
  /** Output pixels; scaled down to the crop when the crop has fewer. */
  output: Size
  shape: FrameShape
  /** Corner radius over frame width; 'rounded' only. */
  radius?: number
  /** Smallest crop width in source pixels: a quarter of the output width, so at most 4× upscale. */
  minCropWidth: number
}

/**
 * Avatars and icons: 512, the largest canonical square render size
 * (CANONICAL_SQUARE_SIZES). Avatar.vue and the server rail draw circles;
 * GroupIcon draws a 4 px radius at its 32 px list size. Profile banners: 3:1,
 * the profile page header (UserProfileView .profile-banner) and Mastodon's
 * 1500×500 header. Server banners: 16:5, ServerBasicInfo's 1280×400
 * recommendation.
 */
export const CROP_PRESETS: Record<CropPresetKind, CropPreset> = {
  avatar: { aspect: 1, output: { width: 512, height: 512 }, shape: 'circle', minCropWidth: 128 },
  server_icon: { aspect: 1, output: { width: 512, height: 512 }, shape: 'circle', minCropWidth: 128 },
  group_icon: { aspect: 1, output: { width: 512, height: 512 }, shape: 'rounded', radius: 4 / 32, minCropWidth: 128 },
  profile_banner: { aspect: 3, output: { width: 1500, height: 500 }, shape: 'rect', minCropWidth: 375 },
  server_banner: { aspect: 16 / 5, output: { width: 1600, height: 500 }, shape: 'rect', minCropWidth: 400 },
}

/** Long edge of the interactive preview copy, px. */
export const PREVIEW_MAX_EDGE = 2048

/** Long edge cap of a free-size (post media) export, px; 4096² is the iOS canvas area limit. */
export const FREE_EXPORT_MAX_EDGE = 4096

export const CROP_WEBP_QUALITY = 0.9
export const CROP_JPEG_QUALITY = 0.9

/** Formats whose pixels can carry alpha. */
const ALPHA_FORMATS = new Set<ImageFormat>(['png', 'webp', 'gif', 'avif', 'bmp'])

export interface ImageFileInfo {
  format: ImageFormat | null
  animated: boolean
}

/** Format and animation from the file bytes; the name and declared type are not consulted. */
export async function inspectImageFile(file: Blob): Promise<ImageFileInfo> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    return { format: null, animated: false }
  }
  return { format: sniffImageFormat(bytes), animated: isAnimatedImage(bytes) }
}

export interface CropSource {
  /** Upright pixels at full size. */
  image: CanvasImageSource
  /** Upright pixels, long edge at most PREVIEW_MAX_EDGE. */
  preview: CanvasImageSource
  width: number
  height: number
  format: ImageFormat | null
  close(): void
}

function drawUpright(source: CanvasImageSource, width: number, height: number, orientation: number): CanvasImageSource | null {
  const upright = orientedSize(orientation, width, height)
  const canvas = createCanvas(upright.width, upright.height)
  if (!canvas) return null
  canvas.ctx.setTransform(...orientationMatrix(orientation, width, height))
  canvas.ctx.drawImage(source, 0, 0, width, height)
  return canvas.ctx.canvas as CanvasImageSource
}

function downscale(source: CanvasImageSource, width: number, height: number, maxEdge: number): CanvasImageSource {
  const scale = maxEdge / Math.max(width, height)
  if (scale >= 1) return source
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = createCanvas(w, h)
  if (!canvas) return source
  canvas.ctx.imageSmoothingEnabled = true
  canvas.ctx.imageSmoothingQuality = 'high'
  canvas.ctx.drawImage(source, 0, 0, w, h)
  return canvas.ctx.canvas as CanvasImageSource
}

/** Upright decode of a static image; null when the engine cannot decode it. */
export async function loadCropSource(file: Blob, codec: ImageCodec = browserImageCodec): Promise<CropSource | null> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const format = sniffImageFormat(bytes)
  const decoded = await codec.decode(file).catch(() => null)
  if (!decoded) return null

  let image: CanvasImageSource = decoded.source
  let width = decoded.width
  let height = decoded.height
  let close = () => decoded.close()
  const exif = format === 'jpeg' ? readJpegOrientation(bytes) : 1
  if (exif > 1 && !(await codec.appliesOrientation())) {
    const upright = drawUpright(decoded.source, width, height, exif)
    if (upright) {
      ;({ width, height } = orientedSize(exif, width, height))
      image = upright
      decoded.close()
      close = () => {}
    }
  }

  return {
    image,
    preview: downscale(image, width, height, PREVIEW_MAX_EDGE),
    width,
    height,
    format,
    close,
  }
}

export interface EncodedImage {
  blob: Blob
  type: string
  extension: string
}

type Encoder = (type: string, quality?: number) => Promise<Blob | null>

/** PNG when alpha must survive; otherwise WebP, or JPEG where the engine has no WebP encoder (WebKit returns PNG). */
export async function encodeCropOutput(encode: Encoder, alpha: boolean): Promise<EncodedImage | null> {
  if (!alpha) {
    const webp = await encode('image/webp', CROP_WEBP_QUALITY)
    if (webp?.type === 'image/webp') return { blob: webp, type: 'image/webp', extension: 'webp' }
    const jpeg = await encode('image/jpeg', CROP_JPEG_QUALITY)
    if (jpeg?.type === 'image/jpeg') return { blob: jpeg, type: 'image/jpeg', extension: 'jpg' }
  }
  const png = await encode('image/png')
  return png ? { blob: png, type: 'image/png', extension: 'png' } : null
}

function hasTransparentPixel(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true
  return false
}

/**
 * Draws the crop with drawImage over the computed source rect and encodes it.
 * `target` fixes the output size (avatars, banners); null keeps the crop's
 * pixel size, long edge capped at FREE_EXPORT_MAX_EDGE. Null when the engine
 * has no canvas.
 */
export async function exportCrop(
  source: Pick<CropSource, 'image' | 'width' | 'height' | 'format'>,
  state: CropState,
  aspect: number,
  target: Size | null,
  fileName: string,
): Promise<File | null> {
  const size = { width: source.width, height: source.height }
  const turned = cropRect(state, size, aspect)
  const out = outputSize({ width: turned.width, height: turned.height }, target, FREE_EXPORT_MAX_EDGE)
  const canvas = createCanvas(out.width, out.height)
  if (!canvas) return null
  const { ctx } = canvas
  const src = sourceRect(state, size, aspect)
  const quarter = state.rotation === 90 || state.rotation === 270
  const dw = quarter ? out.height : out.width
  const dh = quarter ? out.width : out.height
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.translate(out.width / 2, out.height / 2)
  ctx.rotate((state.rotation * Math.PI) / 180)
  ctx.drawImage(source.image, src.x, src.y, src.width, src.height, -dw / 2, -dh / 2, dw, dh)

  const alpha = source.format !== null && ALPHA_FORMATS.has(source.format)
    && hasTransparentPixel(ctx.getImageData(0, 0, out.width, out.height).data)
  const encoded = await encodeCropOutput(canvas.encode, alpha)
  if (!encoded) return null
  return new File([encoded.blob], replaceExtension(fileName, encoded.extension), { type: encoded.type })
}

/** Long edge of the focal-point preview render, px. */
export const CROP_PREVIEW_EDGE = 720

/** The crop drawn from the preview copy, long edge CROP_PREVIEW_EDGE; for on-screen previews only. */
export async function renderCropPreview(
  source: Pick<CropSource, 'preview' | 'width' | 'height' | 'format'>,
  state: CropState,
  aspect: number,
): Promise<Blob | null> {
  const width = Math.max(1, Math.round(aspect >= 1 ? CROP_PREVIEW_EDGE : CROP_PREVIEW_EDGE * aspect))
  const height = Math.max(1, Math.round(width / aspect))
  const canvas = createCanvas(width, height)
  if (!canvas) return null
  const { ctx } = canvas
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.setTransform(...cropDrawMatrix(state, { width: source.width, height: source.height }, aspect, { width, height }))
  ctx.drawImage(source.preview, 0, 0, source.width, source.height)
  const encoded = await encodeCropOutput(canvas.encode, source.format !== null && ALPHA_FORMATS.has(source.format))
  return encoded?.blob ?? null
}
