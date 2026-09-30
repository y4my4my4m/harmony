import { describe, it, expect } from 'vitest'
import {
  bottomCorner,
  clampAspect,
  clampFrameWidth,
  clampPoint,
  cornerPoint,
  excludeBottomObstacles,
  frameSize,
  frameWidthForLongEdge,
  insetBox,
  longEdgeForFrameWidth,
  nearestCorner,
  oppositeCorner,
  parsePlacement,
  resizedFrameWidth,
  serializePlacement,
  type Box,
} from '../floatingVideoGeometry'

const viewport: Box = { left: 0, top: 0, width: 1000, height: 800 }

describe('insetBox', () => {
  it('applies a uniform margin', () => {
    expect(insetBox(viewport, 16)).toEqual({ left: 16, top: 16, width: 968, height: 768 })
  })

  it('applies per-edge insets and never goes negative', () => {
    expect(insetBox(viewport, { top: 44, bottom: 34 })).toEqual({ left: 0, top: 44, width: 1000, height: 722 })
    expect(insetBox({ left: 0, top: 0, width: 10, height: 10 }, 20)).toEqual({ left: 20, top: 20, width: 0, height: 0 })
  })
})

describe('excludeBottomObstacles', () => {
  it('stops the area at the top of a composer in the lower half', () => {
    const composer: Box = { left: 0, top: 720, width: 1000, height: 80 }
    expect(excludeBottomObstacles(viewport, [composer]).height).toBe(720)
  })

  it('ignores obstacles in the upper half and hidden ones', () => {
    const header: Box = { left: 0, top: 100, width: 1000, height: 50 }
    const hidden: Box = { left: 0, top: 700, width: 0, height: 0 }
    expect(excludeBottomObstacles(viewport, [header, hidden]).height).toBe(800)
  })

  it('uses the highest qualifying obstacle', () => {
    const a: Box = { left: 0, top: 700, width: 10, height: 10 }
    const b: Box = { left: 0, top: 650, width: 10, height: 10 }
    expect(excludeBottomObstacles(viewport, [a, b]).height).toBe(650)
  })
})

describe('clampPoint', () => {
  const size = { width: 200, height: 100 }

  it('leaves an in-bounds point alone', () => {
    expect(clampPoint({ x: 50, y: 60 }, size, viewport)).toEqual({ x: 50, y: 60 })
  })

  it('pulls a frame back inside every edge', () => {
    expect(clampPoint({ x: -40, y: -10 }, size, viewport)).toEqual({ x: 0, y: 0 })
    expect(clampPoint({ x: 950, y: 790 }, size, viewport)).toEqual({ x: 800, y: 700 })
  })

  it('pins an oversized frame to the top-left of the bounds', () => {
    const bounds: Box = { left: 10, top: 20, width: 100, height: 50 }
    expect(clampPoint({ x: 500, y: 500 }, size, bounds)).toEqual({ x: 10, y: 20 })
  })
})

describe('nearestCorner / cornerPoint', () => {
  const size = { width: 200, height: 120 }

  it('picks the quadrant of the frame centre', () => {
    expect(nearestCorner({ x: 10, y: 10 }, size, viewport)).toBe('top-left')
    expect(nearestCorner({ x: 700, y: 10 }, size, viewport)).toBe('top-right')
    expect(nearestCorner({ x: 10, y: 600 }, size, viewport)).toBe('bottom-left')
    expect(nearestCorner({ x: 700, y: 600 }, size, viewport)).toBe('bottom-right')
  })

  it('decides by centre, not by the top-left point', () => {
    // top-left at x=350 but centre at 450 < 500
    expect(nearestCorner({ x: 350, y: 10 }, size, viewport)).toBe('top-left')
  })

  it('places a frame flush in each corner of the bounds', () => {
    const bounds = insetBox(viewport, 16)
    expect(cornerPoint('top-left', size, bounds)).toEqual({ x: 16, y: 16 })
    expect(cornerPoint('top-right', size, bounds)).toEqual({ x: 784, y: 16 })
    expect(cornerPoint('bottom-left', size, bounds)).toEqual({ x: 16, y: 664 })
    expect(cornerPoint('bottom-right', size, bounds)).toEqual({ x: 784, y: 664 })
  })

  it('round-trips: a cornered frame reports its own corner', () => {
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      expect(nearestCorner(cornerPoint(corner, size, viewport), size, viewport)).toBe(corner)
    }
  })

  it('keeps the side and moves to the bottom edge', () => {
    expect(bottomCorner('top-left')).toBe('bottom-left')
    expect(bottomCorner('top-right')).toBe('bottom-right')
    expect(bottomCorner('bottom-left')).toBe('bottom-left')
    expect(bottomCorner('bottom-right')).toBe('bottom-right')
  })

  it('maps each corner to its diagonal opposite', () => {
    expect(oppositeCorner('top-left')).toBe('bottom-right')
    expect(oppositeCorner('top-right')).toBe('bottom-left')
    expect(oppositeCorner('bottom-left')).toBe('top-right')
    expect(oppositeCorner('bottom-right')).toBe('top-left')
  })
})

describe('frame sizing', () => {
  const limits = { min: 240, max: 960 }

  it('keeps the aspect ratio plus fixed chrome', () => {
    expect(frameSize(400, 16 / 9, 0)).toEqual({ width: 400, height: 225 })
    expect(frameSize(400, 16 / 9, 32)).toEqual({ width: 400, height: 257 })
  })

  it('clamps width to the limits', () => {
    expect(clampFrameWidth(100, 16 / 9, 0, viewport, limits)).toBe(240)
    expect(clampFrameWidth(5000, 16 / 9, 0, { ...viewport, height: 2000 }, limits)).toBe(960)
  })

  it('shrinks to fit a short viewport by height', () => {
    const short: Box = { left: 0, top: 0, width: 1000, height: 180 }
    // (180 - 32) * 16/9 = 263.1
    expect(clampFrameWidth(400, 16 / 9, 32, short, limits)).toBeCloseTo(263.11, 1)
  })

  it('lets the viewport win over the minimum when both cannot hold', () => {
    const tiny: Box = { left: 0, top: 0, width: 150, height: 600 }
    expect(clampFrameWidth(400, 16 / 9, 0, tiny, limits)).toBe(150)
  })

  it('treats a non-finite width as the minimum', () => {
    expect(clampFrameWidth(Number.NaN, 16 / 9, 0, viewport, limits)).toBe(240)
  })

  it('maps the long edge to frame width for portrait video', () => {
    expect(frameWidthForLongEdge(400, 16 / 9)).toBe(400)
    expect(frameWidthForLongEdge(400, 9 / 16)).toBe(225)
    expect(longEdgeForFrameWidth(225, 9 / 16)).toBe(400)
    expect(longEdgeForFrameWidth(400, 16 / 9)).toBe(400)
  })

  it('clamps aspect ratios to a sane range', () => {
    expect(clampAspect(0)).toBeCloseTo(16 / 9)
    expect(clampAspect(Number.NaN)).toBeCloseTo(16 / 9)
    expect(clampAspect(0.1)).toBeCloseTo(9 / 16)
    expect(clampAspect(10)).toBeCloseTo(21 / 9)
  })
})

describe('resizedFrameWidth', () => {
  const aspect = 16 / 9
  const start = frameSize(400, aspect, 0)

  it('is the identity for zero movement', () => {
    expect(resizedFrameWidth(start, aspect, 0, 'bottom-right', 0, 0)).toBeCloseTo(400)
    const withChrome = frameSize(400, aspect, 32)
    expect(resizedFrameWidth(withChrome, aspect, 32, 'top-left', 0, 0)).toBeCloseTo(400, 0)
  })

  it('grows when the grip moves away from the anchored corner', () => {
    expect(resizedFrameWidth(start, aspect, 0, 'bottom-right', 40, 0)).toBeGreaterThan(400)
    expect(resizedFrameWidth(start, aspect, 0, 'top-left', -40, 0)).toBeGreaterThan(400)
    expect(resizedFrameWidth(start, aspect, 0, 'top-right', 0, -40)).toBeGreaterThan(400)
    expect(resizedFrameWidth(start, aspect, 0, 'bottom-left', 0, 40)).toBeGreaterThan(400)
  })

  it('shrinks when the grip moves toward the anchored corner on one axis only', () => {
    expect(resizedFrameWidth(start, aspect, 0, 'bottom-right', -40, 0)).toBeLessThan(400)
    expect(resizedFrameWidth(start, aspect, 0, 'bottom-right', 0, -40)).toBeLessThan(400)
  })

  it('tracks a pointer that moves exactly along the diagonal', () => {
    // Grip at 400x225 moved to 480x270 lies on the constraint line.
    expect(resizedFrameWidth(start, aspect, 0, 'bottom-right', 80, 45)).toBeCloseTo(480)
    expect(resizedFrameWidth(start, aspect, 0, 'top-left', -80, -45)).toBeCloseTo(480)
  })
})

describe('placement persistence', () => {
  it('round-trips a placement', () => {
    const raw = serializePlacement({ corner: 'top-left', longEdge: 321.6 })
    expect(parsePlacement(raw)).toEqual({ corner: 'top-left', longEdge: 322 })
  })

  it('keeps a moved but never resized placement (long edge 0)', () => {
    const raw = serializePlacement({ corner: 'bottom-left', longEdge: 0 })
    expect(parsePlacement(raw)).toEqual({ corner: 'bottom-left', longEdge: 0 })
  })

  it('rejects missing, malformed and out-of-range values', () => {
    expect(parsePlacement(null)).toBeNull()
    expect(parsePlacement('')).toBeNull()
    expect(parsePlacement('{not json')).toBeNull()
    expect(parsePlacement('null')).toBeNull()
    expect(parsePlacement(JSON.stringify({ corner: 'middle', longEdge: 300 }))).toBeNull()
    expect(parsePlacement(JSON.stringify({ corner: 'top-left', longEdge: -1 }))).toBeNull()
    expect(parsePlacement(JSON.stringify({ corner: 'top-left', longEdge: '300' }))).toBeNull()
  })
})
