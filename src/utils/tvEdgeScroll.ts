/**
 * Fire TV browsers (Amazon Silk, the "Internet" app) move a pointer with the remote's d-pad
 * and scroll the document when it rests at the screen's top or bottom edge. The chat columns
 * are scroll containers inside a screen-high layout, out of reach of that. On Fire TV only:
 *
 *   - the pointer resting in the top or bottom EDGE_BAND_PX of a vertical scroll container
 *     scrolls it, faster nearer the edge, until the pointer leaves the band or the container
 *     its end;
 *   - the column scroll areas (TV_SCROLL_AREAS) take tabindex 0, so a focused one scrolls
 *     with the arrow keys.
 *
 * Fire TV devices report an Android Build.MODEL starting with AFT (Amazon's Fire TV
 * user-agent guidance; AFTMM Fire TV Stick 4K, AFTSSS Fire TV Stick 3rd gen). Silk's tablet
 * and mobile views carry it; its desktop view (X11; Linux x86_64) does not, and is not
 * detected.
 */

export const EDGE_BAND_PX = 48
/** Scroll step, pixels per frame, with the pointer on the container's edge. */
export const EDGE_MAX_STEP_PX = 24

export const TV_SCROLL_AREAS = [
  '.message-display',
  '.servers-scroll-area',
  '.user-groups',
  '.conversations-list',
  '.chat-content',
  '.social-sidebar',
].join(', ')

/** Android model token of a Fire TV device: `; AFTMM Build/`, `; AFTB)`, `en-us; AFTB Build/`. */
const FIRE_TV_MODEL = /\bAndroid [^;)]*;(?:[^;)]*;)?\s*AFT[A-Z0-9]{1,10}(?=[\s;)])/

export function isFireTvUserAgent(ua: string | null | undefined): boolean {
  return typeof ua === 'string' && FIRE_TV_MODEL.test(ua)
}

export interface EdgeBox {
  top: number
  bottom: number
}

/**
 * Scroll step for a pointer at `y` over a container spanning `box`, both in client pixels:
 * negative in the top band, positive in the bottom band, 0 elsewhere. The step grows
 * linearly from 1 at the band's inner edge to `maxStep` at the container's edge.
 */
export function edgeScrollStep(y: number, box: EdgeBox, band = EDGE_BAND_PX, maxStep = EDGE_MAX_STEP_PX): number {
  const height = box.bottom - box.top
  if (!(height > 0) || y < box.top || y > box.bottom) return 0
  // Bands of a container shorter than two bands meet in the middle.
  const reach = Math.min(band, height / 2)
  const depthTop = reach - (y - box.top)
  const depthBottom = reach - (box.bottom - y)
  const step = (depth: number) => Math.max(1, Math.round((maxStep * depth) / reach))
  if (depthTop > 0) return -step(depthTop)
  if (depthBottom > 0) return step(depthBottom)
  return 0
}

function scrollsVertically(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight) return false
  const overflow = getComputedStyle(el).overflowY
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay'
}

/** The nearest element from `start` up that scrolls vertically; the document is not one. */
export function verticalScroller(start: Element | null): HTMLElement | null {
  for (let el: Element | null = start; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (scrollsVertically(el)) return el
  }
  return null
}

/** Whether `el` can still move by `step`: not at its top for a negative step, its bottom for a positive one. */
function canScroll(el: HTMLElement, step: number): boolean {
  if (step < 0) return el.scrollTop > 0
  return Math.ceil(el.scrollTop + el.clientHeight) < el.scrollHeight
}

/** Installs edge scrolling and the focusable scroll areas on `win`; returns the uninstaller. */
export function installTvEdgeScroll(win: Window = window): () => void {
  const doc = win.document
  let pointer: { x: number; y: number } | null = null
  let scroller: HTMLElement | null = null
  let frame = 0

  const tick = () => {
    frame = 0
    if (!pointer || !scroller || !scroller.isConnected) return
    const rect = scroller.getBoundingClientRect()
    const box = { top: Math.max(rect.top, 0), bottom: Math.min(rect.bottom, win.innerHeight) }
    const step = edgeScrollStep(pointer.y, box)
    if (step === 0 || !canScroll(scroller, step)) return
    scroller.scrollTop += step
    frame = win.requestAnimationFrame(tick)
  }

  const stop = () => {
    pointer = null
    scroller = null
    if (frame) win.cancelAnimationFrame(frame)
    frame = 0
  }

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return
    pointer = { x: event.clientX, y: event.clientY }
    scroller = verticalScroller(event.target instanceof Element ? event.target : null)
    if (!frame) frame = win.requestAnimationFrame(tick)
  }

  // relatedTarget null: the pointer left the page.
  const onPointerOut = (event: PointerEvent) => {
    if (!event.relatedTarget) stop()
  }

  const markScrollAreas = () => {
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(TV_SCROLL_AREAS))) {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0')
    }
  }
  let markFrame = 0
  const observer = new MutationObserver(() => {
    if (!markFrame) markFrame = win.requestAnimationFrame(() => { markFrame = 0; markScrollAreas() })
  })
  observer.observe(doc.documentElement, { childList: true, subtree: true })
  markScrollAreas()

  doc.addEventListener('pointermove', onPointerMove, { passive: true })
  doc.addEventListener('pointerout', onPointerOut)
  win.addEventListener('blur', stop)
  return () => {
    stop()
    observer.disconnect()
    if (markFrame) win.cancelAnimationFrame(markFrame)
    doc.removeEventListener('pointermove', onPointerMove)
    doc.removeEventListener('pointerout', onPointerOut)
    win.removeEventListener('blur', stop)
  }
}
