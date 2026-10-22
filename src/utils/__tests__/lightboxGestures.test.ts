import { describe, expect, it } from 'vitest'
import {
  IDENTITY,
  MAX_SCALE,
  clampPan,
  clampScale,
  classifySwipe,
  isDoubleTap,
  pinchOf,
  zoomAt,
} from '@/utils/lightboxGestures'

const stage = { width: 400, height: 800 }

describe('zoom', () => {
  it('keeps the content point under the focus where it was', () => {
    const focus = { x: 100, y: -50 }
    const zoomed = zoomAt(IDENTITY, 2, focus)
    expect(zoomed.scale).toBe(2)
    // Content point (100, -50) sat under the focus at scale 1; translate + scale * point still lands there.
    expect(zoomed.x + 2 * 100).toBeCloseTo(focus.x)
    expect(zoomed.y + 2 * -50).toBeCloseTo(focus.y)
    const further = zoomAt(zoomed, 4, focus)
    // content point q = (p - t) / s stays fixed
    expect((focus.x - further.x) / 4).toBeCloseTo((focus.x - zoomed.x) / 2)
  })

  it('clamps the scale and recentres at 1', () => {
    expect(clampScale(0.2)).toBe(1)
    expect(clampScale(50)).toBe(MAX_SCALE)
    expect(clampScale(Number.NaN)).toBe(1)
    expect(zoomAt({ scale: 3, x: 40, y: 10, rotation: 0 }, 1, { x: 5, y: 5 })).toEqual({ scale: 1, x: 0, y: 0, rotation: 0 })
  })

  it('pans no further than the scaled content reaches past the stage', () => {
    const content = { width: 400, height: 300 }
    const panned = clampPan({ scale: 2, x: 900, y: -900, rotation: 0 }, content, stage)
    expect(panned.x).toBe(200)
    // 600 high at scale 2 is inside the 800 high stage: centred.
    expect(panned.y).toBeCloseTo(0)
  })

  it('swaps width and height for a quarter turn', () => {
    const content = { width: 400, height: 300 }
    const panned = clampPan({ scale: 2, x: 900, y: 900, rotation: 90 }, content, stage)
    expect(panned.x).toBe(100)
    expect(panned.y).toBeCloseTo(0)
    expect(clampPan({ scale: 2, x: 900, y: 900, rotation: -270 }, content, stage).x).toBe(100)
  })
})

describe('swipes', () => {
  it('steps left to the next item and right to the previous one', () => {
    expect(classifySwipe(-120, 10, 300, stage)).toBe('next')
    expect(classifySwipe(120, -10, 300, stage)).toBe('previous')
  })

  it('closes on a downward swipe, never an upward one', () => {
    expect(classifySwipe(5, 200, 300, stage)).toBe('close')
    expect(classifySwipe(5, -200, 300, stage)).toBeNull()
  })

  it('counts a short fling and ignores a short slow drag', () => {
    expect(classifySwipe(-40, 0, 40, stage)).toBe('next')
    expect(classifySwipe(-40, 0, 400, stage)).toBeNull()
    expect(classifySwipe(0, 50, 40, stage)).toBe('close')
  })

  it('ignores a diagonal drag', () => {
    expect(classifySwipe(-120, 110, 300, stage)).toBeNull()
  })
})

describe('taps and pinches', () => {
  it('pairs taps close in time and place', () => {
    const first = { x: 100, y: 100, time: 1000 }
    expect(isDoubleTap(null, first)).toBe(false)
    expect(isDoubleTap(first, { x: 110, y: 95, time: 1200 })).toBe(true)
    expect(isDoubleTap(first, { x: 110, y: 95, time: 1400 })).toBe(false)
    expect(isDoubleTap(first, { x: 180, y: 100, time: 1100 })).toBe(false)
  })

  it('measures a pinch between two fingers', () => {
    expect(pinchOf({ x: 0, y: 0 }, { x: 30, y: 40 })).toEqual({ distance: 50, center: { x: 15, y: 20 } })
  })
})
