/**
 * Focal points, Mastodon convention.
 *
 * Focus (Mastodon `meta.focus`): x and y in [-1, 1], (0, 0) the image centre,
 * x right-positive, y UP-positive. ActivityPub carries it as
 * `focalPoint: [x, y]` (toot:focalPoint) on Document/Image attachments.
 *
 * Normalized units: (0, 0) top-left, (1, 1) bottom-right, y down.
 */

export interface Focus {
  x: number
  y: number
}

export interface Normalized {
  x: number
  y: number
}

/** Mastodon stores and serves focus with two decimals. */
function round2(value: number): number {
  return Math.round(value * 100) / 100 || 0
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(-1, value))
}

export function clampFocus(focus: Focus): Focus {
  return { x: round2(clampUnit(focus.x)), y: round2(clampUnit(focus.y)) }
}

export function isCentredFocus(focus: Focus | null | undefined): boolean {
  return !focus || (focus.x === 0 && focus.y === 0)
}

export function focusFromNormalized(p: Normalized): Focus {
  return clampFocus({ x: p.x * 2 - 1, y: 1 - p.y * 2 })
}

export function focusToNormalized(focus: Focus): Normalized {
  return { x: (clampUnit(focus.x) + 1) / 2, y: (1 - clampUnit(focus.y)) / 2 }
}

function percent(value: number): string {
  return `${Math.round(value * 10000) / 100}%`
}

/** CSS object-position for an `object-fit: cover` thumbnail. */
export function focusToObjectPosition(focus: Focus): string {
  const n = focusToNormalized(focus)
  return `${percent(n.x)} ${percent(n.y)}`
}

function finite(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** AP `focalPoint`: `[x, y]`, or the expanded `{ "@list": [x, y] }`. */
export function focusFromFocalPoint(value: unknown): Focus | null {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>)['@list'])
      ? ((value as Record<string, unknown>)['@list'] as unknown[])
      : null
  if (!list || list.length < 2) return null
  const x = finite(list[0])
  const y = finite(list[1])
  return x === null || y === null ? null : clampFocus({ x, y })
}

export function focusToFocalPoint(focus: Focus): [number, number] {
  const f = clampFocus(focus)
  return [f.x, f.y]
}

function focusFromObject(value: unknown): Focus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const x = finite(v.x)
  const y = finite(v.y)
  return x === null || y === null ? null : clampFocus({ x, y })
}

/**
 * Focus of a stored attachment or content file part: `meta.focus` (composer
 * rows, Mastodon API), `focus`, or `focalPoint` (ActivityPub copies). Null
 * when absent or malformed.
 */
export function attachmentFocus(raw: unknown): Focus | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const meta = a.meta && typeof a.meta === 'object' ? (a.meta as Record<string, unknown>) : null
  return focusFromObject(meta?.focus) ?? focusFromObject(a.focus) ?? focusFromFocalPoint(a.focalPoint)
}

/** object-position for a stored attachment; null when it has no focus or the focus is the centre. */
export function attachmentObjectPosition(raw: unknown): string | null {
  const focus = attachmentFocus(raw)
  return focus && !isCentredFocus(focus) ? focusToObjectPosition(focus) : null
}
