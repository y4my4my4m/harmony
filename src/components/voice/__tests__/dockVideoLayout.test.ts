import { describe, expect, it } from 'vitest'
import { FALLBACK_ASPECT, layoutDockVideoTiles, normalizeAspect, videoAspect } from '../dockVideoLayout'

// Desktop strip constants from DockVideoStrip.
const base = { maxHeight: 260, minHeight: 72, gap: 8, minTileWidth: 72 }

describe('layoutDockVideoTiles', () => {
  it('sizes a lone landscape share to its aspect at the height cap', () => {
    const { height, widths } = layoutDockVideoTiles({ ...base, containerWidth: 800, aspects: [16 / 9] })
    expect(height).toBe(260)
    expect(widths).toEqual([462])
  })

  it('shrinks a share that is too wide for the container to fit exactly', () => {
    const { height, widths } = layoutDockVideoTiles({ ...base, containerWidth: 400, aspects: [16 / 9] })
    expect(height).toBe(225)
    expect(widths).toEqual([400])
    expect(widths[0] / height).toBeCloseTo(16 / 9, 2)
  })

  it('keeps a portrait camera narrow', () => {
    const { height, widths } = layoutDockVideoTiles({ ...base, maxHeight: 140, containerWidth: 800, aspects: [9 / 16] })
    expect(height).toBe(140)
    expect(widths).toEqual([78])
  })

  it('gives multiple tiles one row height and per-tile aspect widths', () => {
    const { height, widths } = layoutDockVideoTiles({
      ...base,
      containerWidth: 600,
      aspects: [16 / 9, 4 / 3, 9 / 16],
    })
    // (600 - 2 * 8) / (16/9 + 4/3 + 9/16) = 158.97
    expect(height).toBe(158)
    expect(widths).toEqual([280, 210, 88])
    expect(widths.reduce((a, w) => a + w, 0) + 2 * 8).toBeLessThanOrEqual(600)
  })

  it('stops shrinking at the minimum height and lets the row scroll', () => {
    const { height, widths } = layoutDockVideoTiles({
      ...base,
      containerWidth: 400,
      aspects: Array(8).fill(16 / 9),
    })
    expect(height).toBe(72)
    expect(widths.every(w => w === 128)).toBe(true)
  })

  it('clamps an ultra-wide share to the container and letterboxes minimally', () => {
    const { height, widths } = layoutDockVideoTiles({ ...base, containerWidth: 300, aspects: [32 / 9] })
    // Fit height 84 is above the minimum: no bars.
    expect(height).toBe(84)
    expect(widths).toEqual([298])

    const narrow = layoutDockVideoTiles({ ...base, containerWidth: 200, aspects: [32 / 9] })
    // Fit height 56 is below the minimum: width clamps, 16px of letterbox.
    expect(narrow.height).toBe(72)
    expect(narrow.widths).toEqual([200])
  })

  it('pillarboxes a very tall video at the minimum tile width', () => {
    const { widths } = layoutDockVideoTiles({ ...base, maxHeight: 140, containerWidth: 800, aspects: [1 / 4] })
    expect(widths).toEqual([72])
  })

  it('uses the height cap when the container is unmeasured', () => {
    const { height, widths } = layoutDockVideoTiles({ ...base, containerWidth: 0, aspects: [16 / 9, 16 / 9] })
    expect(height).toBe(260)
    expect(widths).toEqual([462, 462])
  })

  it('falls back to 16:9 for unknown aspects', () => {
    const a = layoutDockVideoTiles({ ...base, containerWidth: 800, aspects: [null, undefined, 0, NaN] })
    const b = layoutDockVideoTiles({ ...base, containerWidth: 800, aspects: Array(4).fill(FALLBACK_ASPECT) })
    expect(a).toEqual(b)
  })

  it('returns an empty layout for no tiles', () => {
    expect(layoutDockVideoTiles({ ...base, containerWidth: 800, aspects: [] })).toEqual({ height: 0, widths: [] })
  })
})

describe('aspect helpers', () => {
  it('reads null before metadata', () => {
    expect(videoAspect(0, 0)).toBeNull()
    expect(videoAspect(1920, 1080)).toBeCloseTo(16 / 9)
  })

  it('normalizes invalid aspects', () => {
    expect(normalizeAspect(-1)).toBe(FALLBACK_ASPECT)
    expect(normalizeAspect(Infinity)).toBe(FALLBACK_ASPECT)
    expect(normalizeAspect(0.5)).toBe(0.5)
  })
})
