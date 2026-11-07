/**
 * Pixel size of a post image as shown, read from its header: JPEG SOFn with the Exif
 * orientation applied, PNG IHDR, GIF logical screen, WebP VP8X, VP8 or VP8L. Browsers and
 * imgproxy apply the same JPEG orientation, so the size of a render follows from this one.
 */

import { isAnimatedImage, orientedSize, readJpegOrientation } from './imageResize'
import { readStickerImageInfo } from './stickerImage'

export interface PhotoSize {
  width: number
  height: number
  /** APNG, GIF of more than one frame, or WebP with the VP8X animation flag or frames. */
  animated: boolean
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1]
}

/** SOF0–SOF15 other than DHT (C4), JPG (C8) and DAC (CC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

/** Stored size of a JPEG, from its first frame header; null when absent before the scan. */
function jpegFrameSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let p = 2
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null
    const marker = b[p + 1]
    // Fill bytes, and markers without a length (TEM, RSTn).
    if (marker === 0xff) { p += 1; continue }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue }
    if (marker === 0xda || marker === 0xd9) return null
    const length = u16be(b, p + 2)
    if (length < 2) return null
    if (isStartOfFrame(marker)) {
      if (p + 9 > b.length) return null
      return { height: u16be(b, p + 5), width: u16be(b, p + 7) }
    }
    p += 2 + length
  }
  return null
}

export function readPhotoSize(b: Uint8Array): PhotoSize | null {
  const frame = jpegFrameSize(b)
  if (frame) {
    if (!frame.width || !frame.height) return null
    return { ...orientedSize(readJpegOrientation(b), frame.width, frame.height), animated: false }
  }
  const info = readStickerImageInfo(b)
  if (!info || !info.width || !info.height) return null
  return { width: info.width, height: info.height, animated: info.animated || isAnimatedImage(b) }
}
