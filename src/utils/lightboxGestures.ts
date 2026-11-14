// Geometry of the media viewer's gestures: zoom about a point, pan bounds, swipe and
// double-tap recognition. Coordinates are CSS px relative to the stage centre; the
// content's transform is `translate(x, y) rotate(rotation) scale(scale)` about its centre.

/** Scale of the image as laid out: fitted to the stage, the resting state. */
export const FIT_SCALE = 1
/** Lower scale bound of the wheel, toolbar and keys (vue-easy-lightbox `minZoom`). A pinch stops at FIT_SCALE. */
export const MIN_SCALE = 0.1
/** Upper scale bound of an image shown at its own size or larger. */
export const MAX_SCALE = 5
/** Upper scale bound in multiples of the image's own pixel size (vue-easy-lightbox `maxZoom`). */
export const NATURAL_ZOOM = 3
/** Scale a double tap or double click zooms to. */
export const DOUBLE_TAP_SCALE = 2.5
/** Factor of one zoom button press or wheel notch. */
export const ZOOM_STEP = 1.25
/** Wheel travel (px of deltaY) of one ZOOM_STEP. More in one event is one step; less zooms in proportion. */
export const WHEEL_NOTCH = 40
/** Width and height (px) of the content a free pan leaves on the stage. */
export const PAN_KEEP = 64

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

export const IDENTITY: ZoomState = { scale: FIT_SCALE, x: 0, y: 0, rotation: 0 }

export function clampScale(scale: number, max = MAX_SCALE, min = FIT_SCALE): number {
  if (!Number.isFinite(scale)) return FIT_SCALE
  return Math.min(max, Math.max(min, scale))
}

/**
 * Upper scale bound of an image laid out `shown` px wide whose file is `natural` px wide:
 * NATURAL_ZOOM times its own size, and never less than MAX_SCALE.
 */
export function maxScaleFor(shown: Size, natural: Size): number {
  if (!(shown.width > 0) || !(natural.width > 0)) return MAX_SCALE
  return Math.max(MAX_SCALE, (NATURAL_ZOOM * natural.width) / shown.width)
}

/** Zoom factor of a wheel event; up zooms in. `deltaMode` 1 counts lines, 2 pages: one step each. */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const steps = deltaMode === 0 ? Math.max(-1, Math.min(1, deltaY / WHEEL_NOTCH)) : Math.sign(deltaY)
  return ZOOM_STEP ** -steps
}

/** Scales to `nextScale` within `min`..`max`, keeping the content point under `focus` in place. */
export function zoomAt(state: ZoomState, nextScale: number, focus: Point, max = MAX_SCALE, min = FIT_SCALE): ZoomState {
  const scale = clampScale(nextScale, max, min)
  const ratio = scale / state.scale
  return {
    ...state,
    scale,
    x: focus.x - ratio * (focus.x - state.x),
    y: focus.y - ratio * (focus.y - state.y),
  }
}

/**
 * Bounds the pan. Held: the scaled content covers the stage, no pan past its edges, centred
 * when smaller. `free`: the content goes anywhere that leaves PAN_KEEP px of it on the stage.
 */
export function clampPan(state: ZoomState, content: Size, stage: Size, free = false): ZoomState {
  const quarter = ((Math.round(state.rotation / 90) % 4) + 4) % 4
  const turned = quarter % 2 === 1
  const width = (turned ? content.height : content.width) * state.scale
  const height = (turned ? content.width : content.height) * state.scale
  const reach = (size: number, room: number) =>
    free ? (size + room) / 2 - Math.min(PAN_KEEP, size, room) : (size - room) / 2
  const maxX = Math.max(0, reach(width, stage.width))
  const maxY = Math.max(0, reach(height, stage.height))
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
