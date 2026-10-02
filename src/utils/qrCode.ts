/**
 * QR rendering and decoding for the device-pairing and recovery-key screens.
 *
 * Decoding uses BarcodeDetector where the browser ships it with qr_code support. Elsewhere,
 * Firefox, Safari, desktop Chromium on Linux and the desktop webviews included, the `qr`
 * decoder (paulmillr/qr, MIT) reads RGBA pixels drawn from a video frame or an image file.
 * Both decoders load on first use.
 */

export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

/** Why the camera cannot be used. */
export type CameraProblem = 'unsupported' | 'insecure' | 'denied' | 'no-camera' | 'in-use' | 'failed'

interface DetectorLike {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>
}

let detectorPromise: Promise<DetectorLike | null> | null = null

/** BarcodeDetector restricted to QR, or null when the browser lacks it. */
export function nativeQrDetector(): Promise<DetectorLike | null> {
  detectorPromise ??= (async () => {
    const BD = (globalThis as { BarcodeDetector?: any }).BarcodeDetector
    if (typeof BD !== 'function') return null
    try {
      const formats: string[] = typeof BD.getSupportedFormats === 'function'
        ? await BD.getSupportedFormats()
        : ['qr_code']
      if (!formats.includes('qr_code')) return null
      return new BD({ formats: ['qr_code'] }) as DetectorLike
    } catch {
      return null
    }
  })()
  return detectorPromise
}

type JsDecode = (img: RgbaImage, effort?: number) => string
let jsDecoderPromise: Promise<JsDecode> | null = null

function jsDecoder(): Promise<JsDecode> {
  jsDecoderPromise ??= import('qr/decode.js').then(m => (img: RgbaImage, effort?: number) =>
    m.decodeQR(img, effort ? { format: 'RGBA', effort, timeLimit: 400 } : { format: 'RGBA' }))
  return jsDecoderPromise
}

/** First QR in an RGBA image, decoded in JavaScript; null when none is found. */
export async function decodeQrRgba(img: RgbaImage, effort?: number): Promise<string | null> {
  const decode = await jsDecoder()
  try {
    return decode(img, effort) || null
  } catch {
    return null
  }
}

function drawToRgba(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxSide: number,
  canvas: HTMLCanvasElement = document.createElement('canvas'),
): RgbaImage | null {
  const scale = Math.min(1, maxSide / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  return { width: w, height: h, data }
}

/** First QR in an image file; null when none is found. Throws when the file is not an image. */
export async function decodeQrFromImageFile(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const detector = await nativeQrDetector()
    if (detector) {
      try {
        const codes = await detector.detect(bitmap)
        if (codes[0]?.rawValue) return codes[0].rawValue
      } catch { /* fall through to the JS decoder */ }
    }
    const longest = Math.max(bitmap.width, bitmap.height)
    // Longest side capped at 1600, 1000 and 600 px in turn: phone photos run to 4000 px.
    const sides = [...new Set([Math.min(longest, 1600), Math.min(longest, 1000), Math.min(longest, 600)])]
    for (const side of sides) {
      const img = drawToRgba(bitmap, bitmap.width, bitmap.height, side)
      if (!img) return null
      const text = await decodeQrRgba(img, 4)
      if (text) return text
    }
    return null
  } finally {
    bitmap.close?.()
  }
}

/** Decodes video frames, reusing one canvas. */
export class VideoQrDecoder {
  private readonly canvas = document.createElement('canvas')

  constructor(private readonly maxSide = 720) {}

  async decode(video: HTMLVideoElement): Promise<string | null> {
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null
    const detector = await nativeQrDetector()
    if (detector) {
      try {
        const codes = await detector.detect(video)
        return codes[0]?.rawValue || null
      } catch {
        return null
      }
    }
    const img = drawToRgba(video, video.videoWidth, video.videoHeight, this.maxSide, this.canvas)
    return img ? decodeQrRgba(img) : null
  }
}

/** A problem known before asking for the camera, or null. */
export function cameraPrecheck(): CameraProblem | null {
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure'
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'unsupported'
  return null
}

/** False when the device lists no video input; null when it cannot tell. */
export async function hasVideoInput(): Promise<boolean | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    if (devices.length === 0) return null
    return devices.some(d => d.kind === 'videoinput')
  } catch {
    return null
  }
}

export function classifyCameraError(err: unknown): CameraProblem {
  switch ((err as { name?: string } | null)?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-camera'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in-use'
    case 'TypeError':
      return 'unsupported'
    default:
      return 'failed'
  }
}

/** Rear camera when there is one. */
export async function openQrCamera(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
  } catch (err) {
    if ((err as { name?: string })?.name !== 'OverconstrainedError') throw err
    return navigator.mediaDevices.getUserMedia({ video: true, audio: false })
  }
}

/** PNG data URL of `text`. Error correction M; 4-module quiet zone. */
export async function renderQrDataUrl(text: string, width = 256): Promise<string> {
  const QRCode = (await import('qrcode')).default
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 4, width })
}
