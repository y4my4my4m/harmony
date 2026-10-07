import { describe, expect, it } from 'vitest'
import {
  baseCropSize,
  clampCrop,
  cropDrawMatrix,
  cropRect,
  fromRotated,
  initialCrop,
  isIdentityCrop,
  maxZoomFor,
  normalizeRotation,
  outputSize,
  panCrop,
  remapCropUnits,
  rotateCrop,
  rotatedSize,
  sourceRect,
  toRotated,
  zoomCrop,
  type CropState,
  type Rotation,
} from '@/utils/cropGeometry'

const LANDSCAPE = { width: 400, height: 200 }

function apply(m: number[], x: number, y: number) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

describe('rotation mapping', () => {
  it('turns the source clockwise and back', () => {
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      for (const p of [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 37, y: 151 }]) {
        expect(fromRotated(toRotated(p, LANDSCAPE, rotation), LANDSCAPE, rotation)).toEqual(p)
      }
    }
  })

  it('moves the top-left corner clockwise', () => {
    expect(toRotated({ x: 0, y: 0 }, LANDSCAPE, 90)).toEqual({ x: 200, y: 0 })
    expect(toRotated({ x: 0, y: 0 }, LANDSCAPE, 180)).toEqual({ x: 400, y: 200 })
    expect(toRotated({ x: 0, y: 0 }, LANDSCAPE, 270)).toEqual({ x: 0, y: 400 })
    expect(rotatedSize(LANDSCAPE, 90)).toEqual({ width: 200, height: 400 })
  })

  it('normalizes any multiple of 90', () => {
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(360)).toBe(0)
  })
})

describe('crop rect', () => {
  it('is the largest rect of the aspect at zoom 1, centred', () => {
    expect(baseCropSize(LANDSCAPE, 1)).toEqual({ width: 200, height: 200 })
    expect(baseCropSize(LANDSCAPE, 3)).toEqual({ width: 400, height: 400 / 3 })
    expect(cropRect(initialCrop(LANDSCAPE), LANDSCAPE, 1)).toEqual({ x: 100, y: 0, width: 200, height: 200 })
  })

  it('shrinks with zoom around the centre', () => {
    const state = { ...initialCrop(LANDSCAPE), zoom: 2 }
    expect(cropRect(state, LANDSCAPE, 1)).toEqual({ x: 150, y: 50, width: 100, height: 100 })
  })
})

describe('clamping', () => {
  it('keeps zoom within [1, maxZoom]', () => {
    expect(clampCrop({ ...initialCrop(LANDSCAPE), zoom: 0.2 }, LANDSCAPE, 1, 4).zoom).toBe(1)
    expect(clampCrop({ ...initialCrop(LANDSCAPE), zoom: 9 }, LANDSCAPE, 1, 4).zoom).toBe(4)
  })

  it('keeps the crop inside the image', () => {
    const far = clampCrop({ rotation: 0, zoom: 1, cx: -500, cy: 900 }, LANDSCAPE, 1)
    expect(cropRect(far, LANDSCAPE, 1)).toEqual({ x: 0, y: 0, width: 200, height: 200 })
    const right = clampCrop({ rotation: 0, zoom: 2, cx: 10_000, cy: -10 }, LANDSCAPE, 1)
    expect(cropRect(right, LANDSCAPE, 1)).toEqual({ x: 300, y: 0, width: 100, height: 100 })
  })

  it('pins the free axis to the centre when the crop fills it', () => {
    const state = clampCrop({ rotation: 0, zoom: 1, cx: 200, cy: 7 }, LANDSCAPE, 2)
    expect(state.cy).toBe(100)
  })

  it('maxZoomFor stops at the minimum crop width and at MAX_ZOOM', () => {
    expect(maxZoomFor(LANDSCAPE, 1, 50)).toBe(4)
    expect(maxZoomFor(LANDSCAPE, 1, 500)).toBe(1)
    expect(maxZoomFor({ width: 8000, height: 8000 }, 1, 1)).toBe(10)
  })
})

describe('pan', () => {
  it('moves the image with the pointer: dragging right shows more of the left', () => {
    const start: CropState = { rotation: 0, zoom: 2, cx: 200, cy: 100 }
    // Frame 300 px wide over a 100 px crop: 3 frame px per image px.
    const next = panCrop(start, 30, -15, 3, LANDSCAPE, 1)
    expect(next.cx).toBeCloseTo(190)
    expect(next.cy).toBeCloseTo(105)
  })

  it('stops at the image edge', () => {
    const next = panCrop(initialCrop(LANDSCAPE), 10_000, 0, 1, LANDSCAPE, 1)
    expect(cropRect(next, LANDSCAPE, 1).x).toBe(0)
  })
})

describe('zoom', () => {
  it('keeps the anchored image point under the anchor', () => {
    const start: CropState = { rotation: 0, zoom: 1, cx: 200, cy: 100 }
    const anchor = { x: 0.25, y: 0.5 }
    const before = cropRect(start, LANDSCAPE, 1)
    const point = { x: before.x + anchor.x * before.width, y: before.y + anchor.y * before.height }
    const next = zoomCrop(start, 2, anchor, LANDSCAPE, 1)
    const after = cropRect(next, LANDSCAPE, 1)
    expect(after.x + anchor.x * after.width).toBeCloseTo(point.x)
    expect(after.y + anchor.y * after.height).toBeCloseTo(point.y)
    expect(after.width).toBeCloseTo(100)
  })

  it('zooming out past 1 recentres into a covering crop', () => {
    const next = zoomCrop({ rotation: 0, zoom: 3, cx: 330, cy: 30 }, 0.5, { x: 0, y: 0 }, LANDSCAPE, 1)
    expect(next.zoom).toBe(1)
    const r = cropRect(next, LANDSCAPE, 1)
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.x + r.width).toBeLessThanOrEqual(400)
    expect(r).toMatchObject({ y: 0, height: 200 })
  })
})

describe('rotate', () => {
  it('keeps the source pixel at the crop centre and the crop inside the turned image', () => {
    const start: CropState = { rotation: 0, zoom: 2, cx: 120, cy: 80 }
    const next = rotateCrop(start, 90, LANDSCAPE, 1)
    expect(next.rotation).toBe(90)
    const centre = fromRotated({ x: next.cx, y: next.cy }, LANDSCAPE, 90)
    expect(centre.x).toBeCloseTo(120)
    expect(centre.y).toBeCloseTo(80)
    const r = cropRect(next, LANDSCAPE, 1)
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.y).toBeGreaterThanOrEqual(0)
    expect(r.x + r.width).toBeLessThanOrEqual(200 + 1e-9)
    expect(r.y + r.height).toBeLessThanOrEqual(400 + 1e-9)
  })

  it('four quarter turns return to the start', () => {
    let state: CropState = { rotation: 0, zoom: 2.5, cx: 150, cy: 90 }
    for (let i = 0; i < 4; i++) state = rotateCrop(state, -90, LANDSCAPE, 1)
    expect(state.rotation).toBe(0)
    expect(state.cx).toBeCloseTo(150)
    expect(state.cy).toBeCloseTo(90)
  })
})

describe('source rect', () => {
  const state = (rotation: Rotation): CropState => clampCrop({ rotation, zoom: 2, cx: 0, cy: 0 }, LANDSCAPE, 1)

  it('equals the crop rect without rotation', () => {
    const s = state(0)
    expect(sourceRect(s, LANDSCAPE, 1)).toEqual(cropRect(s, LANDSCAPE, 1))
  })

  it('maps the turned crop back to unturned source pixels', () => {
    // Turned 90°: the crop at the turned top-left corner is the source's bottom-left.
    expect(sourceRect(state(90), LANDSCAPE, 1)).toEqual({ x: 0, y: 100, width: 100, height: 100 })
    // 180°: turned top-left is the source bottom-right.
    expect(sourceRect(state(180), LANDSCAPE, 1)).toEqual({ x: 300, y: 100, width: 100, height: 100 })
    // 270°: turned top-left is the source top-right.
    expect(sourceRect(state(270), LANDSCAPE, 1)).toEqual({ x: 300, y: 0, width: 100, height: 100 })
  })

  it('swaps width and height for a non-square crop under a quarter turn', () => {
    const s = clampCrop({ rotation: 90, zoom: 1, cx: 100, cy: 200 }, LANDSCAPE, 2)
    const turned = cropRect(s, LANDSCAPE, 2)
    const src = sourceRect(s, LANDSCAPE, 2)
    expect(src.width).toBeCloseTo(turned.height)
    expect(src.height).toBeCloseTo(turned.width)
  })
})

describe('draw matrix', () => {
  it('maps the crop corners onto the destination box', () => {
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const s = clampCrop({ rotation, zoom: 1.6, cx: 50, cy: 300 }, LANDSCAPE, 1.5)
      const m = cropDrawMatrix(s, LANDSCAPE, 1.5, { width: 300, height: 200 })
      const src = sourceRect(s, LANDSCAPE, 1.5)
      const corners = [
        apply(m, src.x, src.y),
        apply(m, src.x + src.width, src.y),
        apply(m, src.x, src.y + src.height),
        apply(m, src.x + src.width, src.y + src.height),
      ]
      const round = (v: number) => Math.round(v * 1000) / 1000 + 0
      const xs = corners.map((c) => round(c.x)).sort((a, b) => a - b)
      const ys = corners.map((c) => round(c.y)).sort((a, b) => a - b)
      expect([xs[0], xs[3], ys[0], ys[3]]).toEqual([0, 300, 0, 200])
    }
  })

  it('puts the turned top-left of the crop at the destination origin', () => {
    const s = clampCrop({ rotation: 90, zoom: 2, cx: 0, cy: 0 }, LANDSCAPE, 1)
    const m = cropDrawMatrix(s, LANDSCAPE, 1, { width: 100, height: 100 })
    const topLeft = fromRotated(cropRect(s, LANDSCAPE, 1), LANDSCAPE, 90)
    const p = apply(m, topLeft.x, topLeft.y)
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(0)
  })
})

describe('output size', () => {
  it('uses the fixed target when the crop has the pixels', () => {
    expect(outputSize({ width: 2000, height: 2000 }, { width: 512, height: 512 })).toEqual({ width: 512, height: 512 })
  })

  it('never upscales past the crop', () => {
    expect(outputSize({ width: 300, height: 300 }, { width: 512, height: 512 })).toEqual({ width: 300, height: 300 })
    expect(outputSize({ width: 900, height: 300 }, { width: 1500, height: 500 })).toEqual({ width: 900, height: 300 })
  })

  it('keeps the crop size without a target, long edge capped', () => {
    expect(outputSize({ width: 1234.4, height: 800.2 }, null)).toEqual({ width: 1234, height: 800 })
    expect(outputSize({ width: 8000, height: 4000 }, null, 4096)).toEqual({ width: 4096, height: 2048 })
  })
})

describe('identity', () => {
  it('holds for the whole image at its own aspect only', () => {
    expect(isIdentityCrop(initialCrop(LANDSCAPE), LANDSCAPE, 2)).toBe(true)
    expect(isIdentityCrop(initialCrop(LANDSCAPE), LANDSCAPE, 1)).toBe(false)
    expect(isIdentityCrop({ ...initialCrop(LANDSCAPE), zoom: 1.2 }, LANDSCAPE, 2)).toBe(false)
    expect(isIdentityCrop(initialCrop(LANDSCAPE, 180), LANDSCAPE, 2)).toBe(false)
  })
})

describe('remapCropUnits', () => {
  it('keeps a point on the same source pixel across crops', () => {
    const from = { state: initialCrop(LANDSCAPE), aspect: 2 }
    const to = { state: { rotation: 0 as Rotation, zoom: 2, cx: 300, cy: 100 }, aspect: 2 }
    // Source (300, 100) is (0.75, 0.5) of the full image and the centre of the zoomed crop.
    expect(remapCropUnits({ x: 0.75, y: 0.5 }, LANDSCAPE, from, to)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('follows a quarter turn', () => {
    const from = { state: initialCrop(LANDSCAPE), aspect: 2 }
    const to = { state: initialCrop(LANDSCAPE, 90), aspect: 0.5 }
    // Source top-left lands at the turned top-right.
    expect(remapCropUnits({ x: 0, y: 0 }, LANDSCAPE, from, to)).toEqual({ x: 1, y: 0 })
  })

  it('clamps a point the new crop leaves out', () => {
    const from = { state: initialCrop(LANDSCAPE), aspect: 2 }
    const to = { state: { rotation: 0 as Rotation, zoom: 2, cx: 300, cy: 100 }, aspect: 2 }
    expect(remapCropUnits({ x: 0, y: 0 }, LANDSCAPE, from, to)).toEqual({ x: 0, y: 0 })
  })
})
