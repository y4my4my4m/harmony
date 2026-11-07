import { describe, it, expect } from 'vitest'
import { readPhotoSize } from '../photoSize'

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff]
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** APP1 Exif, big-endian TIFF, IFD0 Orientation = `orientation`. */
function exif(orientation: number): number[] {
  const tiff = [...ascii('MM'), 0x00, 0x2a, ...u32(8), ...u16(1), 0x01, 0x12, 0x00, 0x03, ...u32(1), ...u16(orientation), 0, 0, ...u32(0)]
  const body = [...ascii('Exif'), 0, 0, ...tiff]
  return [0xff, 0xe1, ...u16(body.length + 2), ...body]
}

function jpeg(width: number, height: number, before: number[] = [], sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, ...u16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
  const dqt = [0xff, 0xdb, ...u16(4), 0, 0]
  const frame = [0xff, sof, ...u16(17), 8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  return new Uint8Array([0xff, 0xd8, ...app0, ...before, ...dqt, 0xff, 0xff, ...frame, 0xff, 0xda, ...u16(2), 0xff, 0xd9])
}

function png(width: number, height: number, frames = 0): Uint8Array {
  const chunk = (type: string, data: number[]) => [...u32(data.length), ...ascii(type), ...data, 0, 0, 0, 0]
  const ihdr = chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0])
  const actl = frames ? chunk('acTL', [...u32(frames), ...u32(0)]) : []
  return new Uint8Array([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...actl, ...chunk('IDAT', [0]), ...chunk('IEND', [])])
}

function webpVp8x(width: number, height: number, animated: boolean): Uint8Array {
  const vp8x = [...ascii('VP8X'), ...le32(10), animated ? 0x02 : 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]
  const body = [...ascii('WEBP'), ...vp8x]
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body])
}

describe('readPhotoSize', () => {
  it('reads a JPEG frame header', () => {
    expect(readPhotoSize(jpeg(3000, 2000))).toEqual({ width: 3000, height: 2000, animated: false })
  })

  it('reads a progressive JPEG (SOF2)', () => {
    expect(readPhotoSize(jpeg(4032, 3024, [], 0xc2))).toEqual({ width: 4032, height: 3024, animated: false })
  })

  it('applies the Exif orientation of a JPEG', () => {
    expect(readPhotoSize(jpeg(4032, 3024, exif(6)))).toEqual({ width: 3024, height: 4032, animated: false })
    expect(readPhotoSize(jpeg(4032, 3024, exif(3)))).toEqual({ width: 4032, height: 3024, animated: false })
  })

  it('reads PNG and APNG', () => {
    expect(readPhotoSize(png(2560, 1440))).toEqual({ width: 2560, height: 1440, animated: false })
    expect(readPhotoSize(png(2560, 1440, 4))).toEqual({ width: 2560, height: 1440, animated: true })
  })

  it('reads still and animated WebP', () => {
    expect(readPhotoSize(webpVp8x(3000, 2000, false))).toEqual({ width: 3000, height: 2000, animated: false })
    expect(readPhotoSize(webpVp8x(3000, 2000, true))).toMatchObject({ animated: true })
  })

  it('reads nothing from a JPEG without a frame header, or bytes that are no image', () => {
    expect(readPhotoSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]))).toBeNull()
    expect(readPhotoSize(new TextEncoder().encode('not an image'))).toBeNull()
  })
})
