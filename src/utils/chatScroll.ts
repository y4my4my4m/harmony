/**
 * Scroll position rules for the chat message list (MessageDisplay).
 *
 * Coordinates are CSS px in the scroll container. scrollTop grows downward;
 * the distance from the bottom is scrollHeight - clientHeight - scrollTop.
 * "List coordinates" are offsets from the top of the virtual list element,
 * which sits `listOffset` px below the top of the scrolled content.
 */

/**
 * Within this distance of the end the list counts as at the bottom and follows
 * new content. One compact message row is 26 px (22 px line + 4 px padding), so
 * a view this close to the end hides less than one line.
 */
export const PIN_THRESHOLD_PX = 24

/**
 * While a freshly opened context settles (late rows measuring, catch-up
 * messages arriving) only an upward scroll that leaves more than this below
 * the viewport releases the pin.
 */
export const SETTLE_RELEASE_PX = 200

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop)
}

/** scrollTop that shows the end of the content. */
export function bottomScrollTop(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight)
}

export interface PinState {
  /** The view follows the end of the list when content or viewport size changes. */
  pinned: boolean
  /** scrollTop seen at the previous scroll event. */
  lastScrollTop: number
}

export interface PinOptions {
  threshold?: number
  /** Post-open settle window; see SETTLE_RELEASE_PX. */
  settling?: boolean
}

/**
 * Pin state after a scroll event.
 *
 * Within `threshold` of the end: pinned. Moved up and further than `threshold`
 * from the end: released. Moved down, or did not move (a scroll event raised by
 * content or viewport resizing and the browser clamping scrollTop): unchanged,
 * so growth below a pinned view never reads as the user scrolling away.
 */
export function nextPinState(state: PinState, m: ScrollMetrics, opts: PinOptions = {}): PinState {
  const threshold = opts.threshold ?? PIN_THRESHOLD_PX
  const dist = distanceFromBottom(m)
  const movedUp = m.scrollTop < state.lastScrollTop - 0.5
  let pinned = state.pinned
  if (dist <= threshold) {
    pinned = true
  } else if (movedUp && (!opts.settling || dist > SETTLE_RELEASE_PX)) {
    pinned = false
  }
  return { pinned, lastScrollTop: m.scrollTop }
}

export interface JumpToPresentState {
  /** distanceFromBottom of the view. */
  distance: number
  /** clientHeight of the scroll container. */
  viewport: number
  pinned: boolean
  /** Messages from others appended while not pinned. */
  unseen: number
  /** The list holds rows loaded by a jump to an older message. */
  jumped: boolean
}

/**
 * Whether the jump-to-present control shows. Never on a pinned view. Otherwise
 * with unseen messages below, after a jump to an older message, or with more
 * than one viewport height between the view and the end.
 */
export function showJumpToPresent(s: JumpToPresentState): boolean {
  if (s.pinned) return false
  return s.unseen > 0 || s.jumped || s.distance > s.viewport
}

/**
 * scrollTop after the row starting at `itemStart` (list coordinates) changed
 * height by `delta`. A row starting above the viewport top moves everything in
 * view, so the scroll position moves with it; a row at or below the top moves
 * only what follows it. Applied to the live scrollTop, not a cached one: a
 * correction computed from the position at the last scroll event discards
 * whatever the user scrolled since.
 *
 * Mirrors the default of @tanstack/virtual-core's
 * shouldAdjustScrollPositionOnItemSizeChange (`item.start < scrollOffset`),
 * with the list's offset inside the scrolled content taken into account.
 */
export function scrollTopAfterResize(
  scrollTop: number,
  listOffset: number,
  itemStart: number,
  delta: number,
): number {
  return itemStart < scrollTop - listOffset ? scrollTop + delta : scrollTop
}

/**
 * Handler for @tanstack/virtual-core's shouldAdjustScrollPositionOnItemSizeChange.
 * Writes the scrollTopAfterResize correction to the live scroller and returns
 * false, so virtual-core applies none of its own: its correction is relative
 * to the offset cached at the last scroll event and would apply the delta a
 * second time.
 */
export function correctForItemResize(
  scroller: { scrollTop: number },
  listOffset: number,
  itemStart: number,
  delta: number,
): false {
  const next = scrollTopAfterResize(scroller.scrollTop, listOffset, itemStart, delta)
  if (next !== scroller.scrollTop) scroller.scrollTop = next
  return false
}

/**
 * scrollTop after older rows were prepended. Everything added sits above the
 * previous first row, so the growth in scrollHeight is exactly how far the
 * content in view was pushed down.
 */
export function scrollTopAfterPrepend(
  prevScrollTop: number,
  prevScrollHeight: number,
  scrollHeight: number,
): number {
  return prevScrollTop + Math.max(0, scrollHeight - prevScrollHeight)
}
