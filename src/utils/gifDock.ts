// Dock-style magnification of the /gif result strip, after the macOS Dock: the result
// under the pointer grows to full size with its own aspect, neighbours grow with
// distance falloff, the row spreads apart around it, and every box keeps the strip's
// bottom edge. Lengths are CSS px in the styleRect space of utils/appZoom.

export interface DockItem {
  /** Left edge in the unmagnified strip. */
  left: number
  width: number
  /** Media width / height. Non-finite or non-positive reads as 1. */
  aspect: number
  /** False for ad slots and the attribution tile: they keep their size and only move. */
  magnify: boolean
}

export interface DockBox {
  left: number
  width: number
  height: number
}

export interface DockOptions {
  /** Height of an unmagnified tile. */
  base: number
  /** Long side of the result in focus at full magnification. */
  maxLong: number
  /** Neighbours stop growing this many tile pitches from the pointer. */
  radius?: number
  /** Growth of the nearest neighbour relative to the focus, 0-1. */
  neighbourMax?: number
  /** The focused box stays inside these edges, or inside its own unmagnified box when that pokes out. */
  bounds: { left: number; right: number }
  /** 0 is the strip as laid out, 1 full magnification; values between animate the change. */
  amount?: number
}

/** Long side the result in focus grows to: about three unmagnified tiles. */
export const DOCK_MAX_LONG_PX = 280
export const DOCK_RADIUS = 2
export const DOCK_NEIGHBOUR_MAX = 0.42
/** The pointer stays at least this far inside the focus when the row is pulled back to an end. */
const PIN_MARGIN_PX = 12

/** Largest box of `aspect` with long side `long`. */
export function fitLong(aspect: number, long: number): { width: number; height: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  return a >= 1 ? { width: long, height: long / a } : { width: long * a, height: long }
}

/** Index of the magnifiable item under `x` (half a gap either side counts), else the nearest one; -1 when none. */
export function dockFocusIndex(items: DockItem[], x: number): number {
  let best = -1
  let bestDistance = Infinity
  items.forEach((item, i) => {
    if (!item.magnify) return
    const next = items[i + 1]
    const prev = items[i - 1]
    const gapRight = next ? Math.max(0, next.left - (item.left + item.width)) : 0
    const gapLeft = prev ? Math.max(0, item.left - (prev.left + prev.width)) : 0
    if (x >= item.left - gapLeft / 2 && x <= item.left + item.width + gapRight / 2) {
      best = i
      bestDistance = -1
      return
    }
    if (bestDistance < 0) return
    const distance = Math.abs(item.left + item.width / 2 - x)
    if (distance < bestDistance) {
      best = i
      bestDistance = distance
    }
  })
  return best
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

/**
 * Boxes of the magnified strip, item for item. The focus reaches full size; another
 * magnifiable item grows by `neighbourMax` times a raised-cosine falloff of its distance
 * from `x` in tile pitches. The focus is anchored at `x` (the pointer sits at the same
 * fraction of it as of its unmagnified box), the rest follow on either side with their
 * original gaps, so the item under the pointer stays under it. The focus is kept inside
 * `bounds`. When one end of a scrolled strip is in view, or both are and the magnified
 * row fits, the row is pulled back towards that end as far as the pointer stays inside
 * the focus, so the spread does not push the strip's end out of view. At amount 0 every
 * box is the unmagnified one.
 */
export function dockLayout(items: DockItem[], focus: number, x: number, options: DockOptions): DockBox[] {
  const f0 = items[focus]
  if (!f0) return items.map((it) => ({ left: it.left, width: it.width, height: options.base }))
  const amount = Math.max(0, Math.min(1, options.amount ?? 1))
  const radius = options.radius ?? DOCK_RADIUS
  const neighbourMax = options.neighbourMax ?? DOCK_NEIGHBOUR_MAX
  const pitch = f0.width + Math.max(0, (items[focus + 1]?.left ?? f0.left + f0.width) - (f0.left + f0.width))

  const sizes = items.map((it, i) => {
    if (!it.magnify) return { width: it.width, height: options.base }
    let growth: number
    if (i === focus) growth = 1
    else {
      const d = Math.abs(it.left + it.width / 2 - x) / Math.max(1, pitch)
      growth = d < radius ? (neighbourMax * (1 + Math.cos((Math.PI * d) / radius))) / 2 : 0
    }
    growth *= amount
    const full = fitLong(it.aspect, options.maxLong)
    return { width: lerp(it.width, full.width, growth), height: lerp(options.base, full.height, growth) }
  })

  const t = Math.max(0, Math.min(1, (x - f0.left) / f0.width))
  const lefts = new Array<number>(items.length)
  lefts[focus] = x - t * sizes[focus].width
  for (let i = focus - 1; i >= 0; i--) {
    const gap = items[i + 1].left - (items[i].left + items[i].width)
    lefts[i] = lefts[i + 1] - gap - sizes[i].width
  }
  for (let i = focus + 1; i < items.length; i++) {
    const gap = items[i].left - (items[i - 1].left + items[i - 1].width)
    lefts[i] = lefts[i - 1] + sizes[i - 1].width + gap
  }

  const lo = Math.min(options.bounds.left, f0.left)
  const hi = Math.max(options.bounds.right, f0.left + f0.width)
  const focusWidth = sizes[focus].width
  let shift = 0
  if (lefts[focus] < lo) shift = lo - lefts[focus]
  else if (lefts[focus] + focusWidth > hi) shift = Math.max(lo - lefts[focus], hi - lefts[focus] - focusWidth)

  // Pull the row back towards an end of the strip that is in view, keeping the pointer inside the focus.
  const last = items.length - 1
  const startEdge = items[0].left
  const endEdge = items[last].left + items[last].width
  const startVisible = startEdge >= options.bounds.left - 0.5
  const endVisible = endEdge <= options.bounds.right + 0.5
  const span = lefts[last] + sizes[last].width - lefts[0]
  const pin = startVisible && endVisible
    ? span <= options.bounds.right - startEdge ? 'start' : null
    : startVisible ? 'start' : endVisible ? 'end' : null
  const focusLeft = lefts[focus] + shift
  if (pin === 'start') {
    const need = startEdge - (lefts[0] + shift)
    const room = Math.min(x - focusLeft - PIN_MARGIN_PX, hi - focusLeft - focusWidth)
    if (need > 0) shift += Math.max(0, Math.min(need, room))
  } else if (pin === 'end') {
    const need = lefts[last] + sizes[last].width + shift - endEdge
    const room = Math.min(focusLeft + focusWidth - x - PIN_MARGIN_PX, focusLeft - lo)
    if (need > 0) shift -= Math.max(0, Math.min(need, room))
  }

  return items.map((_, i) => ({ left: lefts[i] + shift, width: sizes[i].width, height: sizes[i].height }))
}
