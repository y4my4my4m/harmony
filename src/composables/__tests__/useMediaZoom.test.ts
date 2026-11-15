/**
 * useMediaZoom: the scale stays within MIN_SCALE..MAX_SCALE, or up to NATURAL_ZOOM times the
 * file's pixels for an image shown small, a step through fit stops at it, the pan stays
 * within the scaled image unless freed, a quarter turn fits the image back into the stage
 * and recentres it, and reset returns to the upright, unzoomed image.
 */
import { describe, expect, it } from 'vitest'
import { useMediaZoom } from '../useMediaZoom'
import { DOUBLE_TAP_SCALE, FIT_SCALE, MAX_SCALE, MIN_SCALE, NATURAL_ZOOM, PAN_KEEP, ZOOM_STEP, type Size } from '@/utils/lightboxGestures'

function setup(content: Size = { width: 400, height: 300 }, stage: Size = { width: 400, height: 800 }) {
  const sizes = { content, stage }
  const zoomer = useMediaZoom({ content: () => sizes.content, stage: () => sizes.stage })
  return { zoomer, sizes }
}

describe('useMediaZoom', () => {
  it('zooms in steps between the bounds', () => {
    const { zoomer } = setup()
    zoomer.zoomBy(ZOOM_STEP)
    expect(zoomer.zoom.scale).toBe(ZOOM_STEP)
    expect(zoomer.zoomed.value).toBe(true)
    zoomer.zoomBy(100)
    expect(zoomer.zoom.scale).toBe(MAX_SCALE)
    zoomer.zoomBy(ZOOM_STEP)
    expect(zoomer.zoom.scale).toBe(MAX_SCALE)
  })

  it('shrinks below fit, stopping at fit on the way through', () => {
    const { zoomer } = setup()
    zoomer.zoomBy(1 / ZOOM_STEP)
    expect(zoomer.zoom.scale).toBeCloseTo(0.8)
    expect(zoomer.zoomed.value).toBe(false)
    zoomer.zoomBy(1 / ZOOM_STEP)
    zoomer.zoomBy(ZOOM_STEP)
    zoomer.zoomBy(ZOOM_STEP)
    expect(zoomer.zoom.scale).toBe(FIT_SCALE)

    zoomer.zoomBy(0.5)
    zoomer.zoomBy(100)
    expect(zoomer.zoom.scale).toBe(FIT_SCALE)
    zoomer.zoomBy(3)
    zoomer.zoomBy(0.001)
    expect(zoomer.zoom.scale).toBe(FIT_SCALE)
    zoomer.zoomBy(0.001)
    expect(zoomer.zoom.scale).toBe(MIN_SCALE)
    zoomer.zoomBy(1 / ZOOM_STEP)
    expect(zoomer.zoom.scale).toBe(MIN_SCALE)
  })

  it('keeps a freed image in place through fit on the way up, and brings it home on the way down', () => {
    const { zoomer } = setup()
    zoomer.zoomBy(0.5)
    zoomer.release()
    zoomer.apply({ ...zoomer.zoom, x: 120, y: -80 })
    zoomer.zoomBy(4)
    expect(zoomer.zoom).toMatchObject({ scale: 1, x: 240, y: -160 })
    expect(zoomer.free.value).toBe(true)
    zoomer.zoomBy(2)
    zoomer.zoomBy(0.25)
    expect(zoomer.zoom).toMatchObject({ scale: 1, x: 0, y: 0 })
    expect(zoomer.free.value).toBe(false)
  })

  it('returns a shrunk image to fit when held', () => {
    const { zoomer } = setup()
    zoomer.zoomBy(0.5)
    zoomer.hold()
    expect(zoomer.zoom).toMatchObject({ scale: 1, x: 0, y: 0 })
  })

  it('zooms an image shown small up to three times its own pixels', () => {
    // A 1080 x 8000 screenshot fitted 108 px wide.
    const zoomer = useMediaZoom({
      content: () => ({ width: 108, height: 800 }),
      stage: () => ({ width: 400, height: 800 }),
      natural: () => ({ width: 1080, height: 8000 }),
    })
    expect(zoomer.maxScale()).toBe(NATURAL_ZOOM * 10)
    zoomer.zoomBy(1000)
    expect(zoomer.zoom.scale).toBe(30)

    // Shown at its own size: MAX_SCALE stands.
    const small = useMediaZoom({
      content: () => ({ width: 200, height: 200 }),
      stage: () => ({ width: 400, height: 800 }),
      natural: () => ({ width: 200, height: 200 }),
    })
    expect(small.maxScale()).toBe(MAX_SCALE)
  })

  it('lets a freed pan leave the edges and holds it again', () => {
    const { zoomer } = setup()
    zoomer.release()
    zoomer.apply({ ...zoomer.zoom, x: 900, y: 900 })
    expect(zoomer.zoom.x).toBe(400 - PAN_KEEP)
    expect(zoomer.zoom.y).toBe(550 - PAN_KEEP)
    zoomer.hold()
    expect(zoomer.zoom).toMatchObject({ x: 0, y: 0 })
  })

  it('keeps the pan inside the scaled image', () => {
    const { zoomer } = setup()
    zoomer.zoomBy(2)
    zoomer.apply({ ...zoomer.zoom, x: 900, y: -900 })
    // 800 px wide at scale 2 over a 400 px stage: 200 px either way. 600 px high fits 800: centred.
    expect(zoomer.zoom.x).toBe(200)
    expect(zoomer.zoom.y).toBeCloseTo(0)
    zoomer.apply({ ...zoomer.zoom, x: -900 })
    expect(zoomer.zoom.x).toBe(-200)
  })

  it('zooms about the focus point and recentres back at 1', () => {
    const { zoomer } = setup()
    zoomer.zoomBy(2, { x: 100, y: 0 })
    expect(zoomer.zoom.x).toBe(-100)
    zoomer.zoomBy(1 / 2, { x: 100, y: 0 })
    expect(zoomer.zoom).toMatchObject({ scale: 1, x: 0, y: 0 })
  })

  it('fits a quarter-turned image into the stage and recentres it', () => {
    const { zoomer } = setup({ width: 600, height: 400 }, { width: 500, height: 500 })
    zoomer.zoomBy(2)
    zoomer.apply({ ...zoomer.zoom, x: 300 })
    zoomer.rotateBy(90)
    expect(zoomer.zoom.rotation).toBe(90)
    expect(zoomer.zoom.x).toBe(0)
    // Turned, the 600 px width stands in 500 px of stage height.
    expect(zoomer.turnFit.value).toBeCloseTo(500 / 600)
    expect(zoomer.transform.value).toBe(`translate3d(0px, 0px, 0) rotate(90deg) scale(${2 * (500 / 600)})`)
    zoomer.rotateBy(90)
    expect(zoomer.zoom.rotation).toBe(180)
    expect(zoomer.turnFit.value).toBe(1)
  })

  it('pans a turned image within its turned box', () => {
    const { zoomer } = setup({ width: 400, height: 300 }, { width: 400, height: 800 })
    zoomer.rotateBy(90)
    zoomer.zoomBy(2)
    zoomer.apply({ ...zoomer.zoom, x: 900, y: 900 })
    // Turned: 300 wide and 400 high, at scale 2 600 by 800 over 400 by 800.
    expect(zoomer.zoom.x).toBe(100)
    expect(zoomer.zoom.y).toBeCloseTo(0)
  })

  it('toggles between fit and the double-tap scale', () => {
    const { zoomer } = setup()
    zoomer.toggleAt({ x: 40, y: 20 })
    expect(zoomer.zoom.scale).toBe(DOUBLE_TAP_SCALE)
    zoomer.toggleAt({ x: 40, y: 20 })
    expect(zoomer.zoom).toMatchObject({ scale: FIT_SCALE, x: 0, y: 0 })
  })

  it('toggles a shrunk or moved image back to fit', () => {
    const { zoomer } = setup()
    zoomer.zoomBy(0.5)
    zoomer.toggleAt({ x: 40, y: 20 })
    expect(zoomer.zoom).toMatchObject({ scale: FIT_SCALE, x: 0, y: 0 })

    zoomer.release()
    zoomer.apply({ ...zoomer.zoom, x: 120 })
    zoomer.toggleAt({ x: 40, y: 20 })
    expect(zoomer.zoom).toMatchObject({ scale: FIT_SCALE, x: 0, y: 0 })
    expect(zoomer.free.value).toBe(false)
  })

  it('resets scale, pan and rotation', () => {
    const { zoomer } = setup({ width: 600, height: 400 }, { width: 500, height: 500 })
    zoomer.rotateBy(90)
    zoomer.zoomBy(3)
    zoomer.reset()
    expect(zoomer.zoom).toEqual({ scale: 1, x: 0, y: 0, rotation: 0 })
    expect(zoomer.turnFit.value).toBe(1)
    expect(zoomer.transform.value).toBe('translate3d(0px, 0px, 0) rotate(0deg) scale(1)')
  })

  it('reclamps the pan when the stage changes size', () => {
    const { zoomer, sizes } = setup()
    zoomer.zoomBy(2)
    zoomer.apply({ ...zoomer.zoom, x: 200 })
    sizes.stage = { width: 700, height: 800 }
    zoomer.refit()
    expect(zoomer.zoom.x).toBe(50)
  })
})
