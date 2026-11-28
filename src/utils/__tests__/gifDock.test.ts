import { describe, expect, it } from 'vitest'
import { dockFocusIndex, dockLayout, fitLong, type DockItem } from '../gifDock'

// The /gif strip: 88px tiles 4px apart from x = 0, inside a 648px results area.
const strip = (n: number, aspect = 16 / 9): DockItem[] =>
  Array.from({ length: n }, (_, i) => ({ left: i * 92, width: 88, aspect, magnify: true }))
const options = { base: 88, maxLong: 280, bounds: { left: 0, right: 648 } }
const centre = (i: number) => i * 92 + 44

describe('fitLong', () => {
  it('puts the long side at the given length, aspect kept', () => {
    expect(fitLong(16 / 9, 280)).toEqual({ width: 280, height: 157.5 })
    expect(fitLong(3 / 4, 280)).toEqual({ width: 210, height: 280 })
    expect(fitLong(NaN, 100)).toEqual({ width: 100, height: 100 })
  })
})

describe('dockFocusIndex', () => {
  const items = strip(5)

  it('picks the tile under x, half a gap either side included', () => {
    expect(dockFocusIndex(items, centre(2))).toBe(2)
    expect(dockFocusIndex(items, 2 * 92 + 89)).toBe(2)
    expect(dockFocusIndex(items, 2 * 92 + 91)).toBe(3)
  })

  it('takes the nearest tile beyond the ends and skips fixed slots', () => {
    expect(dockFocusIndex(items, -50)).toBe(0)
    expect(dockFocusIndex(items, 1000)).toBe(4)
    const withAd = [...strip(2), { left: 184, width: 200, aspect: 1, magnify: false }]
    expect(dockFocusIndex(withAd, 250)).toBe(1)
  })
})

describe('dockLayout', () => {
  it('is the strip as laid out at amount 0', () => {
    const items = strip(7)
    const boxes = dockLayout(items, 3, centre(3) + 20, { ...options, amount: 0 })
    boxes.forEach((b, i) => {
      expect(b.left).toBeCloseTo(items[i].left, 6)
      expect(b.width).toBe(88)
      expect(b.height).toBe(88)
    })
  })

  it('grows the focus to full size with its own aspect, under the pointer', () => {
    const boxes = dockLayout(strip(7), 3, centre(3), options)
    expect(boxes[3].width).toBe(280)
    expect(boxes[3].height).toBe(157.5)
    expect(boxes[3].left).toBe(centre(3) - 140)
  })

  it('grows neighbours by distance and leaves far tiles alone', () => {
    const boxes = dockLayout(strip(9), 4, centre(4), options)
    expect(boxes[3].width).toBeGreaterThan(88)
    expect(boxes[3].width).toBeLessThan(boxes[4].width)
    expect(boxes[3].width).toBeCloseTo(boxes[5].width, 6)
    expect(boxes[2].width).toBe(88)
    expect(boxes[6].height).toBe(88)
  })

  it('spreads the row with the original gaps, no overlaps', () => {
    const boxes = dockLayout(strip(9), 4, centre(4) - 30, options)
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].left).toBeCloseTo(boxes[i - 1].left + boxes[i - 1].width + 4, 6)
    }
  })

  it('keeps the pointer at the same fraction of the focus', () => {
    const x = 3 * 92 + 22
    const boxes = dockLayout(strip(7), 3, x, options)
    expect(boxes[3].left).toBeCloseTo(x - 0.25 * boxes[3].width, 6)
  })

  it('keeps the focus inside the results area at its ends', () => {
    const first = dockLayout(strip(7), 0, centre(0), options)
    expect(first[0].left).toBe(0)
    expect(first[0].width).toBe(280)
    expect(first[1].left).toBeCloseTo(first[0].width + 4, 6)

    const last = dockLayout(strip(7), 6, centre(6), { ...options, bounds: { left: 0, right: 640 } })
    expect(last[6].left + last[6].width).toBeCloseTo(640, 6)
  })

  it('pulls the row back to the start of a scrolled strip, the pointer still inside the focus', () => {
    const items = strip(16)
    const x = centre(1)
    const boxes = dockLayout(items, 1, x, options)
    expect(boxes[0].left).toBeGreaterThan(-12)
    expect(boxes[1].left).toBeLessThanOrEqual(x - 12)
    expect(boxes[1].left + boxes[1].width).toBeGreaterThan(x)
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].left).toBeCloseTo(boxes[i - 1].left + boxes[i - 1].width + 4, 6)
    }
  })

  it('pulls the row back to the end of a strip scrolled to its end', () => {
    // 16 tiles scrolled by 824px: the last ends at 648.
    const items = strip(16).map((it) => ({ ...it, left: it.left - 824 }))
    const x = 14 * 92 - 824 + 44
    const boxes = dockLayout(items, 14, x, options)
    expect(boxes[15].left + boxes[15].width).toBeLessThan(648 + 12)
    expect(boxes[14].left).toBeLessThan(x)
    expect(boxes[14].left + boxes[14].width).toBeGreaterThanOrEqual(x + 12)
  })

  it('pulls a short row that fits back towards its start, the pointer still inside the focus', () => {
    const x = centre(1)
    const boxes = dockLayout(strip(3), 1, x, options)
    // Anchored at the pointer alone the first tile would start at x - 140 - 4 - its width (-136).
    expect(boxes[0].left).toBeGreaterThan(-12)
    expect(boxes[1].left).toBeCloseTo(x - 12, 6)
  })

  it('lets a focus that pokes out unmagnified stay where it is', () => {
    const boxes = dockLayout(strip(7), 0, centre(0), { ...options, bounds: { left: 40, right: 648 }, amount: 0 })
    expect(boxes[0].left).toBe(0)
  })

  it('moves fixed slots without resizing them', () => {
    const items: DockItem[] = [...strip(3), { left: 276, width: 200, aspect: 1, magnify: false }]
    const boxes = dockLayout(items, 2, centre(2), options)
    expect(boxes[3].width).toBe(200)
    expect(boxes[3].height).toBe(88)
    expect(boxes[3].left).toBeCloseTo(boxes[2].left + boxes[2].width + 4, 6)
  })

  it('sizes a tall result by its height', () => {
    const boxes = dockLayout(strip(5, 3 / 4), 2, centre(2), options)
    expect(boxes[2].width).toBe(210)
    expect(boxes[2].height).toBe(280)
  })
})
