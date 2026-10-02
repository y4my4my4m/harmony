import { describe, it, expect } from 'vitest'
import {
  PIN_THRESHOLD_PX,
  SETTLE_RELEASE_PX,
  bottomScrollTop,
  distanceFromBottom,
  nextPinState,
  scrollTopAfterPrepend,
  scrollTopAfterResize,
  type PinState,
} from '../chatScroll'

const m = (scrollTop: number, scrollHeight = 5000, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight })
const pinned = (lastScrollTop: number): PinState => ({ pinned: true, lastScrollTop })
const free = (lastScrollTop: number): PinState => ({ pinned: false, lastScrollTop })

describe('distanceFromBottom / bottomScrollTop', () => {
  it('measures from the end of the content', () => {
    expect(distanceFromBottom(m(4400))).toBe(0)
    expect(distanceFromBottom(m(4000))).toBe(400)
    expect(bottomScrollTop(m(0))).toBe(4400)
  })

  it('never goes negative', () => {
    expect(distanceFromBottom(m(4400.6))).toBe(0)
    expect(bottomScrollTop(m(0, 300, 600))).toBe(0)
  })
})

describe('nextPinState', () => {
  it('pins within the threshold of the end, in either direction', () => {
    expect(nextPinState(free(3000), m(4400 - PIN_THRESHOLD_PX)).pinned).toBe(true)
    expect(nextPinState(free(4400), m(4400 - PIN_THRESHOLD_PX)).pinned).toBe(true)
  })

  it('releases on an upward scroll past the threshold', () => {
    expect(nextPinState(pinned(4400), m(4400 - PIN_THRESHOLD_PX - 1)).pinned).toBe(false)
  })

  it('stays pinned when content grows below without the view moving', () => {
    // Last row grew by 300 px: no movement, distance 300.
    expect(nextPinState(pinned(4400), m(4400, 5300)).pinned).toBe(true)
  })

  it('stays pinned when the viewport shrinks under it', () => {
    // Composer grew by 110 px: clientHeight 600 -> 490, scrollTop unchanged.
    expect(nextPinState(pinned(4400), m(4400, 5000, 490)).pinned).toBe(true)
  })

  it('stays pinned on a downward move short of the end', () => {
    expect(nextPinState(pinned(3000), m(3500)).pinned).toBe(true)
  })

  it('stays released on a downward move short of the end', () => {
    expect(nextPinState(free(3000), m(3500)).pinned).toBe(false)
  })

  it('ignores sub-pixel jitter in the up direction', () => {
    expect(nextPinState(pinned(4000), m(3999.7)).pinned).toBe(true)
  })

  it('holds the pin through small upward moves while settling', () => {
    const settling = { settling: true }
    expect(nextPinState(pinned(4400), m(4400 - SETTLE_RELEASE_PX), settling).pinned).toBe(true)
    expect(nextPinState(pinned(4400), m(4400 - SETTLE_RELEASE_PX - 1), settling).pinned).toBe(false)
  })

  it('records the scroll position for the next event', () => {
    expect(nextPinState(free(0), m(1234)).lastScrollTop).toBe(1234)
  })

  it('honours a custom threshold', () => {
    expect(nextPinState(pinned(4400), m(4300), { threshold: 100 }).pinned).toBe(true)
    expect(nextPinState(pinned(4400), m(4299), { threshold: 100 }).pinned).toBe(false)
  })
})

describe('scrollTopAfterResize', () => {
  // List starts 21 px into the content (20 px padding + 1 px sentinel).
  const listOffset = 21

  it('moves with a row that starts above the viewport', () => {
    expect(scrollTopAfterResize(1000, listOffset, 500, 150)).toBe(1150)
    expect(scrollTopAfterResize(1000, listOffset, 500, -60)).toBe(940)
  })

  it('holds for a row at or below the viewport top', () => {
    expect(scrollTopAfterResize(1000, listOffset, 979, 150)).toBe(1000)
    expect(scrollTopAfterResize(1000, listOffset, 1200, 150)).toBe(1000)
  })

  it('moves for a row that straddles the viewport top', () => {
    expect(scrollTopAfterResize(1000, listOffset, 978, 42)).toBe(1042)
  })

  it('applies each correction once: consecutive resizes accumulate', () => {
    // Six images above the viewport loading in one task, 150 px each.
    let top = 3000
    for (let i = 0; i < 6; i++) top = scrollTopAfterResize(top, listOffset, 1000 + i * 300, 150)
    expect(top).toBe(3900)
  })
})

describe('scrollTopAfterPrepend', () => {
  it('pushes the view down by the growth', () => {
    expect(scrollTopAfterPrepend(250, 4000, 5400)).toBe(1650)
  })

  it('never moves up when the content did not grow', () => {
    expect(scrollTopAfterPrepend(250, 4000, 3956)).toBe(250)
  })
})
