import { describe, it, expect } from 'vitest'
import QRCode from 'qrcode'
import { classifyCameraError, decodeQrRgba, type RgbaImage } from '../qrCode'
import {
  NewDevicePairingSession,
  decodePairingCode,
  encodePairingCode,
} from '@/services/encryption/devicePairing'

/** Draws a QR code: `scale` px per module, `margin` modules of quiet zone. */
function rasterize(text: string, scale = 4, margin = 4): RgbaImage {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const side = (modules.size + margin * 2) * scale
  const data = new Uint8ClampedArray(side * side * 4).fill(255)
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (!modules.get(row, col)) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((row + margin) * scale + dy) * side + (col + margin) * scale + dx) * 4
          data[i] = data[i + 1] = data[i + 2] = 0
        }
      }
    }
  }
  return { width: side, height: side, data }
}

/** Places `img` at (x, y) on a mid-grey, noisy canvas: a phone photo, roughly. */
function embed(img: RgbaImage, width: number, height: number, x: number, y: number, seed = 7): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < width * height; i++) {
    const v = 120 + Math.floor(rand() * 40)
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v
    data[i * 4 + 3] = 255
  }
  for (let row = 0; row < img.height; row++) {
    for (let col = 0; col < img.width; col++) {
      const src = (row * img.width + col) * 4
      const dst = ((row + y) * width + col + x) * 4
      const jitter = Math.floor(rand() * 30)
      const v = img.data[src] === 0 ? 20 + jitter : 235 - jitter
      data[dst] = data[dst + 1] = data[dst + 2] = v
    }
  }
  return { width, height, data }
}

describe('QR decoding', () => {
  it('decodes a generated pairing code image', async () => {
    const session = await NewDevicePairingSession.create()
    const text = encodePairingCode(await session.code('0f8fad5b-d9cb-469f-a165-70867728950e', Date.now() + 600_000))
    const decoded = await decodeQrRgba(rasterize(text))
    expect(decoded).toBe(text)
    const code = decodePairingCode(decoded!)
    expect(code.mode).toBe('new-device')
  })

  it('decodes a code off-centre in a larger, noisy frame', async () => {
    const text = 'HMP:' + 'A'.repeat(92)
    const decoded = await decodeQrRgba(embed(rasterize(text, 3), 640, 480, 233, 101))
    expect(decoded).toBe(text)
  })

  it('decodes the recovery-key QR payload', async () => {
    const payload = btoa(JSON.stringify({ v: 1, m: 'abandon ability able about above absent absorb abstract absurd abuse access accident', t: 1 }))
    expect(await decodeQrRgba(rasterize(payload, 3))).toBe(payload)
  })

  it('returns null when the image holds no QR code', async () => {
    const blank: RgbaImage = { width: 320, height: 240, data: new Uint8ClampedArray(320 * 240 * 4).fill(200) }
    expect(await decodeQrRgba(blank)).toBeNull()
    expect(await decodeQrRgba(embed({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, 320, 240, 0, 0))).toBeNull()
  })
})

describe('camera errors', () => {
  it('maps getUserMedia failures to what the user can do about them', () => {
    expect(classifyCameraError({ name: 'NotAllowedError' })).toBe('denied')
    expect(classifyCameraError({ name: 'SecurityError' })).toBe('denied')
    expect(classifyCameraError({ name: 'NotFoundError' })).toBe('no-camera')
    expect(classifyCameraError({ name: 'OverconstrainedError' })).toBe('no-camera')
    expect(classifyCameraError({ name: 'NotReadableError' })).toBe('in-use')
    expect(classifyCameraError({ name: 'TypeError' })).toBe('unsupported')
    expect(classifyCameraError(new Error('x'))).toBe('failed')
    expect(classifyCameraError(null)).toBe('failed')
  })
})
