// Geometry of the media viewer's gestures: zoom about a point, pan bounds, swipe and
// double-tap recognition. Coordinates are CSS px relative to the stage centre; the
// content's transform is `translate(x, y) rotate(rotation) scale(scale)` about its centre.

export const MIN_SCALE = 1
export const MAX_SCALE = 5
/** Scale a double tap or double click zooms to. */
export const DOUBLE_TAP_SCALE = 2.5
/** Factor of one zoom button press or wheel notch. */
export const ZOOM_STEP = 1.25

/** Taps closer in time (ms) and space (px) than these form a double tap. */
export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_SLOP = 30
/** Movement (px) below which a pointer press is a tap. */
export const TAP_SLOP = 10

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface ZoomState {
  scale: number
  x: number
  y: number
  /** Degrees, a multiple of 90. */
  rotation: number
}

export const IDENTITY: ZoomState = { scale: 1, x: 0, y: 0, rotation: 0 }

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** Scales to `nextScale` keeping the content point under `focus` in place. */
export function zoomAt(state: ZoomState, nextScale: number, focus: Point): ZoomState {
  const scale = clampScale(nextScale)
  if (scale === MIN_SCALE) return { ...state, scale, x: 0, y: 0 }
  const ratio = scale / state.scale
  return {
    ...state,
    scale,
    x: focus.x - ratio * (focus.x - state.x),
    y: focus.y - ratio * (focus.y - state.y),
  }
}

/** Keeps the scaled content covering the stage: no pan past its edges, centred when smaller. */
export function clampPan(state: ZoomState, content: Size, stage: Size): ZoomState {
  const quarter = ((Math.round(state.rotation / 90) % 4) + 4) % 4
  const turned = quarter % 2 === 1
  const width = (turned ? content.height : content.width) * state.scale
  const height = (turned ? content.width : content.height) * state.scale
  const maxX = Math.max(0, (width - stage.width) / 2)
  const maxY = Math.max(0, (height - stage.height) / 2)
  return {
    ...state,
    x: Math.min(maxX, Math.max(-maxX, state.x)),
    y: Math.min(maxY, Math.max(-maxY, state.y)),
  }
}

export type SwipeAction = 'previous' | 'next' | 'close' | null

/**
 * What a one-finger drag at scale 1 asks for: a horizontal swipe steps through the items
 * (left: next), a downward swipe closes. Distance past a fraction of the stage, or a fling,
 * counts; the dominant axis must lead the other by 30%.
 */
export function classifySwipe(dx: number, dy: number, ms: number, stage: Size): SwipeAction {
  const speed = Math.hypot(dx, dy) / Math.max(1, ms)
  const fling = speed > 0.5
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax > ay * 1.3 && (ax > Math.max(56, stage.width * 0.18) || (fling && ax > 30))) {
    return dx < 0 ? 'next' : 'previous'
  }
  if (dy > 0 && ay > ax * 1.3 && (ay > Math.max(80, stage.height * 0.15) || (fling && ay > 40))) {
    return 'close'
  }
  return null
}

export interface Tap extends Point {
  time: number
}

export function isDoubleTap(previous: Tap | null, tap: Tap): boolean {
  if (!previous) return false
  return tap.time - previous.time <= DOUBLE_TAP_MS && Math.hypot(tap.x - previous.x, tap.y - previous.y) <= DOUBLE_TAP_SLOP
}

/** Pinch: distance and midpoint of two pointers. */
export function pinchOf(a: Point, b: Point): { distance: number; center: Point } {
  return { distance: Math.hypot(a.x - b.x, a.y - b.y), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
}
