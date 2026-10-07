/**
 * Mastodon focal points.
 *
 * ActivityPub carries `focalPoint: [x, y]` (toot:focalPoint) on Document and
 * Image attachments; Mastodon's API and Harmony's composer rows carry
 * `meta.focus: { x, y }`. Both are in [-1, 1], (0, 0) the centre, x
 * right-positive, y UP-positive.
 */

export type FocalPoint = [number, number];

/** Mastodon ActivityPub::Adapter CONTEXT_EXTENSION_MAP[:focal_point]. */
export const FOCAL_POINT_CONTEXT = {
  toot: 'http://joinmastodon.org/ns#',
  focalPoint: { '@container': '@list', '@id': 'toot:focalPoint' },
} as const;

/** Clamped to [-1, 1] at two decimals, Mastodon's stored precision. */
function unit(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.round(Math.min(1, Math.max(-1, n)) * 100) / 100 || 0;
}

/** `[x, y]`, or the JSON-LD expanded `{ "@list": [x, y] }`; null when malformed. */
export function parseFocalPoint(value: unknown): FocalPoint | null {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as any)['@list'])
      ? (value as any)['@list']
      : null;
  if (!list || list.length < 2) return null;
  const x = unit(list[0]);
  const y = unit(list[1]);
  return x === null || y === null ? null : [x, y];
}

function fromFocus(value: unknown): FocalPoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = unit((value as any).x);
  const y = unit((value as any).y);
  return x === null || y === null ? null : [x, y];
}

/**
 * Focal point of a stored attachment row or content file part: `focalPoint`
 * (ActivityPub copies), `meta.focus` (composer rows, Mastodon API) or `focus`.
 */
export function storedFocalPoint(item: any): FocalPoint | null {
  if (!item || typeof item !== 'object') return null;
  return parseFocalPoint(item.focalPoint) ?? fromFocus(item.meta?.focus) ?? fromFocus(item.focus);
}
