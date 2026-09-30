// Geometry for the floating video player. All coordinates are CSS pixels in
// the layout viewport (the space of position: fixed and getBoundingClientRect).

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export const CORNERS: readonly Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

// Portrait 9:16 to ultrawide 21:9.
const MIN_ASPECT = 9 / 16
const MAX_ASPECT = 21 / 9

export function clampAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return 16 / 9
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect))
}

export function insetBox(box: Box, insets: Partial<Insets> | number): Box {
  const i = typeof insets === 'number'
    ? { top: insets, right: insets, bottom: insets, left: insets }
    : { top: 0, right: 0, bottom: 0, left: 0, ...insets }
  return {
    left: box.left + i.left,
    top: box.top + i.top,
    width: Math.max(0, box.width - i.left - i.right),
    height: Math.max(0, box.height - i.top - i.bottom),
  }
}

// Cuts off the band below the highest obstacle whose top edge lies in the
// lower half of `box`. Obstacles higher up are ignored so a composer rendered
// mid-screen cannot collapse the area.
export function excludeBottomObstacles(box: Box, obstacles: Box[]): Box {
  const midY = box.top + box.height / 2
  let bottom = box.top + box.height
  for (const o of obstacles) {
    if (o.width <= 0 || o.height <= 0) continue
    if (o.top >= midY && o.top < bottom) bottom = o.top
  }
  return { ...box, height: Math.max(0, bottom - box.top) }
}

// The persisted size is the frame's long edge, so one value suits both
// landscape and portrait videos.
export function frameWidthForLongEdge(longEdge: number, aspect: number): number {
  return aspect >= 1 ? longEdge : longEdge * aspect
}

export function longEdgeForFrameWidth(width: number, aspect: number): number {
  return aspect >= 1 ? width : width / aspect
}

// `chrome` is height that does not scale with width (a static header bar).
export function frameSize(width: number, aspect: number, chrome: number): Size {
  return { width: Math.round(width), height: Math.round(width / aspect + chrome) }
}

export function clampFrameWidth(
  width: number,
  aspect: number,
  chrome: number,
  bounds: Box,
  limits: { min: number; max: number },
): number {
  const fit = Math.min(bounds.width, (bounds.height - chrome) * aspect)
  const max = Math.max(0, Math.min(limits.max, fit))
  const min = Math.min(limits.min, max)
  if (!Number.isFinite(width)) return min
  return Math.min(max, Math.max(min, width))
}

// Keeps a frame of `size` inside `bounds`; an oversized frame pins to the
// top-left edge.
export function clampPoint(point: Point, size: Size, bounds: Box): Point {
  const maxX = bounds.left + bounds.width - size.width
  const maxY = bounds.top + bounds.height - size.height
  return {
    x: Math.max(bounds.left, Math.min(point.x, maxX)),
    y: Math.max(bounds.top, Math.min(point.y, maxY)),
  }
}

// Quadrant of the frame's centre.
export function nearestCorner(point: Point, size: Size, bounds: Box): Corner {
  const right = point.x + size.width / 2 > bounds.left + bounds.width / 2
  const bottom = point.y + size.height / 2 > bounds.top + bounds.height / 2
  return `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`
}

export function cornerPoint(corner: Corner, size: Size, bounds: Box): Point {
  const x = corner.endsWith('right') ? bounds.left + bounds.width - size.width : bounds.left
  const y = corner.startsWith('bottom') ? bounds.top + bounds.height - size.height : bounds.top
  return clampPoint({ x, y }, size, bounds)
}

export function bottomCorner(corner: Corner): Corner {
  return corner.endsWith('left') ? 'bottom-left' : 'bottom-right'
}

export function oppositeCorner(corner: Corner): Corner {
  const vertical = corner.startsWith('top') ? 'bottom' : 'top'
  const horizontal = corner.endsWith('left') ? 'right' : 'left'
  return `${vertical}-${horizontal}`
}

// Resize from `grip` with the opposite corner fixed. The target grip offset
// from the anchor is (w0 + sx*dx, h0 + sy*dy); the frame is constrained to
// (w, w/aspect + chrome). Returns the w whose grip lies closest to the target
// (least squares): w = (tx + (ty - chrome)/a) / (1 + 1/a^2).
export function resizedFrameWidth(
  start: Size,
  aspect: number,
  chrome: number,
  grip: Corner,
  dx: number,
  dy: number,
): number {
  const sx = grip.endsWith('right') ? 1 : -1
  const sy = grip.startsWith('bottom') ? 1 : -1
  const tx = start.width + sx * dx
  const ty = start.height + sy * dy
  return (tx + (ty - chrome) / aspect) / (1 + 1 / (aspect * aspect))
}

// longEdge 0 means the layout default.
export interface Placement {
  corner: Corner
  longEdge: number
}

export function parsePlacement(raw: string | null): Placement | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<Placement> | null
    if (
      value &&
      CORNERS.includes(value.corner as Corner) &&
      typeof value.longEdge === 'number' &&
      Number.isFinite(value.longEdge) &&
      value.longEdge >= 0
    ) {
      return { corner: value.corner as Corner, longEdge: value.longEdge }
    }
  } catch {
    // Malformed JSON reads as no stored placement.
  }
  return null
}

export function serializePlacement(placement: Placement): string {
  return JSON.stringify({ corner: placement.corner, longEdge: Math.round(placement.longEdge) })
}
