/**
 * instance_config federate_image_max_px: longest side, in pixels, of the photos a local post
 * federates; 0 sends originals. Default and bounds as in federation-backend
 * utils/federatedImages.ts.
 */

export const DEFAULT_FEDERATE_IMAGE_MAX_PX = 1920
/** storage-api clamps render width and height to IMAGE_TRANSFORMATION_LIMIT_MAX_SIZE, default 2000. */
export const FEDERATE_IMAGE_RENDER_MAX = 2000

/** 0 to FEDERATE_IMAGE_RENDER_MAX, rounded; anything that is not a number is the default. */
export function parseFederateImageMaxPx(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < 0) return DEFAULT_FEDERATE_IMAGE_MAX_PX
  return Math.min(FEDERATE_IMAGE_RENDER_MAX, Math.round(n))
}
