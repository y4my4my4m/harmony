/**
 * Canonical imgproxy transform dimensions.
 *
 * UI code requests many semantic sizes (reaction chips 32, tooltips 48, pickers
 * 42, …). Each distinct width/height pair is a separate transform URL, a
 * separate browser cache entry, and often a separate imgproxy regeneration.
 * Snapping up to a small set of shared sizes lets surfaces reuse the same
 * cached variant while CSS controls on-screen size (downscale only).
 */

export const CANONICAL_SQUARE_SIZES = [32, 64, 128, 256] as const
/** Emoji chips/tooltips/pickers all land on 64 so hover reuses the chip fetch. */
export const CANONICAL_EMOJI_SIZES = [64, 128] as const
export const CANONICAL_BANNER_WIDTHS = [480, 640, 1280] as const
export const CANONICAL_BANNER_HEIGHTS = [140, 200, 400] as const

function snapUp(size: number, buckets: readonly number[]): number {
  const normalized = Math.max(1, Math.round(size))
  for (const bucket of buckets) {
    if (normalized <= bucket) return bucket
  }
  return buckets[buckets.length - 1]
}

export function canonicalSquareSize(size: number): number {
  return snapUp(size, CANONICAL_SQUARE_SIZES)
}

export function canonicalEmojiSize(size: number): number {
  return snapUp(size, CANONICAL_EMOJI_SIZES)
}

export function canonicalBannerSize(
  width: number,
  height: number,
): { width: number; height: number } {
  return {
    width: snapUp(width, CANONICAL_BANNER_WIDTHS),
    height: snapUp(height, CANONICAL_BANNER_HEIGHTS),
  }
}
