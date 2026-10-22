/**
 * correctForItemResize driving a real @tanstack/virtual-core Virtualizer, as
 * MessageDisplay wires it: a row above the viewport changes height (an E2E row
 * swapping its placeholder for plaintext, an image loading) and the message at
 * the top of the viewport stays where it was on screen.
 */
import { describe, it, expect } from 'vitest'
import { Virtualizer } from '@tanstack/virtual-core'
import { correctForItemResize } from '@/utils/chatScroll'

const ROW = 100
const COUNT = 50
const VIEWPORT = 600

interface Harness {
  v: Virtualizer<HTMLDivElement, Element>
  scroller: { scrollTop: number }
  /** Delivers a scroll event: virtual-core's cached offset follows scrollTop. */
  fireScroll: () => void
  firstVisible: () => { index: number; offsetInRow: number }
}

function harness(opts: { hook: boolean; listOffset?: number }): Harness {
  const listOffset = opts.listOffset ?? 0
  const scroller = { scrollTop: 0 }
  let onOffset: ((offset: number, isScrolling: boolean) => void) | null = null
  const el = {} as HTMLDivElement

  const v = new Virtualizer<HTMLDivElement, Element>({
    count: COUNT,
    getScrollElement: () => el,
    estimateSize: () => ROW,
    getItemKey: (i) => `msg-${i}`,
    overscan: 2,
    observeElementRect: (_inst, cb) => {
      cb({ width: 400, height: VIEWPORT })
      return () => {}
    },
    observeElementOffset: (_inst, cb) => {
      onOffset = cb
      cb(scroller.scrollTop, false)
      return () => {}
    },
    scrollToFn: (offset, { adjustments = 0 }) => {
      scroller.scrollTop = offset + adjustments
      onOffset?.(scroller.scrollTop, false)
    },
    onChange: () => {},
  })
  if (opts.hook) {
    v.shouldAdjustScrollPositionOnItemSizeChange = (item, delta) =>
      correctForItemResize(scroller, listOffset, item.start, delta)
  }
  v._willUpdate()

  return {
    v,
    scroller,
    fireScroll: () => onOffset?.(scroller.scrollTop, false),
    firstVisible: () => {
      // List coordinates: the list sits listOffset px into the content.
      const top = scroller.scrollTop - listOffset
      const item = v.getVirtualItemForOffset(top)!
      return { index: item.index, offsetInRow: top - item.start }
    },
  }
}

describe('row resize above the viewport, real virtualizer', () => {
  it('keeps the first visible message in place when a row above grows', () => {
    const h = harness({ hook: true })
    h.scroller.scrollTop = 2050
    h.fireScroll()
    const before = h.firstVisible()
    expect(before).toEqual({ index: 20, offsetInRow: 50 })

    h.v.resizeItem(5, ROW + 80)

    expect(h.scroller.scrollTop).toBe(2130)
    expect(h.firstVisible()).toEqual(before)
  })

  it('keeps the first visible message in place when a row above shrinks', () => {
    const h = harness({ hook: true })
    h.scroller.scrollTop = 2050
    h.fireScroll()
    const before = h.firstVisible()

    h.v.resizeItem(3, ROW - 60)

    expect(h.firstVisible()).toEqual(before)
  })

  it('holds the anchor across a scroll the virtualizer has not seen yet', () => {
    const h = harness({ hook: true })
    h.scroller.scrollTop = 2000
    h.fireScroll()
    // User scrolls 50 px; the resize lands before the scroll event.
    h.scroller.scrollTop = 2050
    const before = h.firstVisible()

    h.v.resizeItem(5, ROW + 80)

    expect(h.firstVisible()).toEqual(before)
  })

  it('without the hook, virtual-core corrects from its cached offset and drops that scroll', () => {
    const h = harness({ hook: false })
    h.scroller.scrollTop = 2000
    h.fireScroll()
    h.scroller.scrollTop = 2050
    const before = h.firstVisible()

    h.v.resizeItem(5, ROW + 80)

    expect(h.firstVisible()).not.toEqual(before)
    expect(h.scroller.scrollTop).toBe(2080)
  })

  it('does not move the view for a row inside or below the viewport', () => {
    const h = harness({ hook: true })
    h.scroller.scrollTop = 2050
    h.fireScroll()

    h.v.resizeItem(22, ROW + 80)
    h.v.resizeItem(40, ROW + 80)

    expect(h.scroller.scrollTop).toBe(2050)
    expect(h.firstVisible()).toEqual({ index: 20, offsetInRow: 50 })
  })

  it('accounts for the list offset inside the scrolled content', () => {
    const h = harness({ hook: true, listOffset: 40 })
    h.scroller.scrollTop = 2090
    h.fireScroll()
    const before = h.firstVisible()

    h.v.resizeItem(5, ROW + 80)
    h.v.resizeItem(6, ROW + 20)

    expect(h.firstVisible()).toEqual(before)
  })
})

/**
 * A browser scroller: scrollTop is clamped to the end of the list element, whose height is
 * the total size of the last render, not of the resize being handled.
 */
function clampingHarness(grow: boolean) {
  const list = { height: COUNT * ROW }
  let top = 0
  const scroller = {
    get scrollTop() { return top },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, list.height - VIEWPORT)) },
  }
  const el = {} as HTMLDivElement
  const v = new Virtualizer<HTMLDivElement, Element>({
    count: COUNT,
    getScrollElement: () => el,
    estimateSize: () => ROW,
    getItemKey: (i) => `msg-${i}`,
    overscan: 2,
    observeElementRect: (_inst, cb) => {
      cb({ width: 400, height: VIEWPORT })
      return () => {}
    },
    observeElementOffset: (_inst, cb) => {
      cb(scroller.scrollTop, false)
      return () => {}
    },
    scrollToFn: (offset, { adjustments = 0 }) => { scroller.scrollTop = offset + adjustments },
    onChange: () => {},
  })
  v.shouldAdjustScrollPositionOnItemSizeChange = (item, delta) =>
    correctForItemResize(scroller, 0, item.start, delta, grow ? () => { list.height = v.getTotalSize() + delta } : undefined)
  v._willUpdate()
  return { v, scroller, list }
}

describe('row resize above a view near the end of the list', () => {
  // 78 px above the end, less than the row grows by.
  const nearEnd = COUNT * ROW - VIEWPORT - 78

  it('the list takes its new height first, so the whole correction applies', () => {
    const h = clampingHarness(true)
    h.scroller.scrollTop = nearEnd
    h.v.resizeItem(5, ROW + 150)
    expect(h.scroller.scrollTop).toBe(nearEnd + 150)
    expect(h.list.height).toBe(COUNT * ROW + 150)
  })

  it('without it the browser clamps the correction to the old end', () => {
    const h = clampingHarness(false)
    h.scroller.scrollTop = nearEnd
    h.v.resizeItem(5, ROW + 150)
    expect(h.scroller.scrollTop).toBe(nearEnd + 78)
  })

  it('leaves the list height alone when no correction is due', () => {
    const h = clampingHarness(true)
    h.scroller.scrollTop = nearEnd
    h.v.resizeItem(COUNT - 2, ROW + 150)
    expect(h.scroller.scrollTop).toBe(nearEnd)
    expect(h.list.height).toBe(COUNT * ROW)
  })
})
