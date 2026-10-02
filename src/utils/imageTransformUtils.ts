/**
 * Canonical imgproxy transform dimensions.
 *
 * UI code requests many semantic sizes (reaction chips 32, tooltips 48, pickers
 * 42, …). Each distinct width/height pair is a separate transform URL, a
 * separate browser cache entry, and often a separate imgproxy regeneration.
 * Snapping up to a small set of shared sizes lets surfaces reuse the same
 * cached variant while CSS controls on-screen size (downscale only).
 */

export const CANONICAL_SQUARE_SIZES = [32, 64, 128, 256, 512] as const
/** Emoji chips/tooltips/pickers all land on 64 so hover reuses the chip fetch. */
export const CANONICAL_EMOJI_SIZES = [64, 128] as const
/** Banner boxes in device pixels; uploads are at most 2560 wide. */
export const CANONICAL_BANNER_WIDTHS = [480, 640, 960, 1280, 1920, 2560] as const
export const CANONICAL_BANNER_HEIGHTS = [140, 200, 280, 400, 560, 800, 1080, 1440] as const

function snapUp(size: number, buckets: readonly number[]): number {
  const normalized = Math.max(1, Math.round(size))
  for (const bucket of buckets) {
    if (normalized <= bucket) return bucket
  }
  return buckets[buckets.length - 1]
}

/** Device pixels covering `cssPx` at the current devicePixelRatio, clamped to 1–3. */
export function devicePixels(cssPx: number): number {
  const ratio = typeof window !== 'undefined' ? Number(window.devicePixelRatio) : 1
  const clamped = Number.isFinite(ratio) ? Math.min(3, Math.max(1, ratio)) : 1
  return Math.round(cssPx * clamped)
}

export function canonicalSquareSize(size: number): number {
  return snapUp(size, CANONICAL_SQUARE_SIZES)
}

export function canonicalEmojiSize(size: number): number {
  return snapUp(size, CANONICAL_EMOJI_SIZES)
}

/** Snaps a banner box given in device pixels. */
export function canonicalBannerSize(
  width: number,
  height: number,
): { width: number; height: number } {
  return {
    width: snapUp(width, CANONICAL_BANNER_WIDTHS),
    height: snapUp(height, CANONICAL_BANNER_HEIGHTS),
  }
}

/** Snapped device-pixel box for a banner displayed at cssWidth×cssHeight. */
export function bannerRenderSize(cssWidth: number, cssHeight: number): { width: number; height: number } {
  return canonicalBannerSize(devicePixels(cssWidth), devicePixels(cssHeight))
}
