/**
 * A vertical mouse wheel over a horizontal strip scrolls the strip sideways.
 *
 * Returns the pixels to add to the strip's scrollLeft, or null to leave the event to the
 * browser: a gesture that is mostly horizontal (trackpads, tilt wheels), a strip that does not
 * overflow, and a wheel pushing past either end, which then scrolls whatever is around the strip.
 */

/** px per WheelEvent.DOM_DELTA_LINE; Firefox reports mouse wheels in lines. */
const LINE_PX = 40

export interface WheelDelta {
  deltaX: number
  deltaY: number
  deltaMode: number
}

export interface StripScroll {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}

export function horizontalWheelDelta(event: WheelDelta, strip: StripScroll): number | null {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return null
  const max = strip.scrollWidth - strip.clientWidth
  if (max <= 0) return null
  const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? strip.clientWidth : 1
  const px = event.deltaY * unit
  // 1px of slack: scrollLeft is fractional under zoom and stops short of max.
  if (px < 0 && strip.scrollLeft <= 0) return null
  if (px > 0 && strip.scrollLeft >= max - 1) return null
  return px
}
