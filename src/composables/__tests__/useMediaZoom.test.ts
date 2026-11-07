/**
 * useMediaZoom: the scale stays within MIN_SCALE..MAX_SCALE, the pan within the scaled image,
 * a quarter turn fits the image back into the stage and recentres it, and reset returns to
 * the upright, unzoomed image.
 */
import { describe, expect, it } from 'vitest'
import { useMediaZoom } from '../useMediaZoom'
import { DOUBLE_TAP_SCALE, MAX_SCALE, MIN_SCALE, ZOOM_STEP, type Size } from '@/utils/lightboxGestures'

function setup(content: Size = { width: 400, height: 300 }, stage: Size = { width: 400, height: 800 }) {
  const sizes = { content, stage }
  const zoomer = useMediaZoom({ content: () => sizes.content, stage: () => sizes.stage })
  return { zoomer, sizes }
}

describe('useMediaZoom', () => {
  it('zooms in steps between the bounds', () => {
    const { zoomer } = setup()
    zoomer.zoomBy(1 / ZOOM_STEP)
    expect(zoomer.zoom.scale).toBe(MIN_SCALE)
    expect(zoomer.zoomed.value).toBe(false)
    zoomer.zoomBy(ZOOM_STEP)
    expect(zoomer.zoom.scale).toBe(ZOOM_STEP)
    expect(zoomer.zoomed.value).toBe(true)
    zoomer.zoomBy(100)
    expect(zoomer.zoom.scale).toBe(MAX_SCALE)
    zoomer.zoomBy(ZOOM_STEP)
    expect(zoomer.zoom.scale).toBe(MAX_SCALE)
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
    expect(zoomer.zoom).toMatchObject({ scale: MIN_SCALE, x: 0, y: 0 })
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
