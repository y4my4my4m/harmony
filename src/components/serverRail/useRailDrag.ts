/**
 * Pointer-driven drag for the server rail. Mouse drags start after a 4 px
 * move; touch drags start after a 350 ms press that moves under 8 px, and a
 * press released without moving opens the context menu instead.
 *
 * Every per-frame effect (ghost, drop indicator, autoscroll) writes the DOM
 * directly; no reactive state changes until the drop, so a drag re-renders
 * nothing in the rail.
 */

import { onBeforeUnmount, type Ref } from 'vue'
import { resolveDropTarget, type DragSource, type DropTarget, type RailRect } from './railModel'

export const MOUSE_DRAG_THRESHOLD_PX = 4
export const TOUCH_SLOP_PX = 8
export const LONG_PRESS_MS = 350
/** Distance from the scroll area edge where autoscroll engages, px. */
export const AUTOSCROLL_EDGE_PX = 48
/** Autoscroll speed at the very edge, px per frame. */
export const AUTOSCROLL_MAX_PX = 14
/** Half the vertical gap between rail entries, px; indicator lines sit in it. */
const GAP_HALF_PX = 4
/** Distance beside the rail at which a release cancels the drop, px. */
export const DROP_SLACK_PX = 24

export interface RailDragOptions {
  container: Ref<HTMLElement | null>
  indicator: Ref<HTMLElement | null>
  onDrop: (source: DragSource, target: DropTarget) => void
  /** Touch press released without moving. */
  onLongPress: (source: DragSource, el: HTMLElement) => void
}

interface Pending {
  pointerId: number
  pointerType: string
  startX: number
  startY: number
  source: DragSource
  el: HTMLElement
  timer: ReturnType<typeof setTimeout> | null
  armed: boolean
}

interface Active {
  source: DragSource
  el: HTMLElement
  ghost: HTMLElement
  offsetX: number
  offsetY: number
  rects: RailRect[]
  clientX: number
  clientY: number
  target: DropTarget | null
  frame: number
}

export function sourceFromElement(el: HTMLElement): DragSource | null {
  const id = el.dataset.railId
  const kind = el.dataset.railKind
  if (!id || (kind !== 'server' && kind !== 'folder')) return null
  return { kind, id }
}

/** Snapshot of every rail entry in content coordinates, in visual order. */
export function measureRail(container: HTMLElement): RailRect[] {
  const box = container.getBoundingClientRect()
  const scroll = container.scrollTop
  const rects: RailRect[] = []
  container.querySelectorAll<HTMLElement>('[data-rail-kind]').forEach((el) => {
    const source = sourceFromElement(el)
    if (!source) return
    const r = el.getBoundingClientRect()
    const folderId = el.dataset.railFolder ?? null
    rects.push({
      top: r.top - box.top + scroll,
      height: r.height || 48,
      entry: source,
      folderId,
      accepts: source.kind === 'folder' ? 'into-folder' : folderId ? null : 'combine',
    })
  })
  return rects
}

export function useRailDrag(opts: RailDragOptions) {
  let pending: Pending | null = null
  let active: Active | null = null
  let suppressClickUntil = 0
  let lastTouchAt = Number.NEGATIVE_INFINITY

  const contentY = (container: HTMLElement, clientY: number) =>
    clientY - container.getBoundingClientRect().top + container.scrollTop

  const elementBox = (container: HTMLElement, el: Element) => {
    const box = container.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    return { top: r.top - box.top + container.scrollTop, height: r.height }
  }

  const rootBox = (container: HTMLElement, id: string) => {
    const el = container.querySelector(`[data-rail-root="${CSS.escape(id)}"]`)
    return el ? elementBox(container, el) : null
  }

  const memberBox = (container: HTMLElement, id: string) => {
    const el = container.querySelector(`[data-rail-kind="server"][data-rail-id="${CSS.escape(id)}"]`)
    return el ? elementBox(container, el) : null
  }

  const paintIndicator = (container: HTMLElement, target: DropTarget | null) => {
    const ind = opts.indicator.value
    if (!ind) return
    if (!target) {
      ind.dataset.mode = 'none'
      return
    }
    let mode: 'line' | 'ring' = 'line'
    let top = 0
    let height = 0
    if (target.kind === 'end') {
      const roots = container.querySelectorAll('[data-rail-root]')
      const last = roots[roots.length - 1]
      top = last ? elementBox(container, last).top + elementBox(container, last).height + GAP_HALF_PX : 0
    } else if (target.kind === 'combine') {
      const b = memberBox(container, target.id)
      if (!b) return
      mode = 'ring'
      top = b.top
      height = b.height
    } else if (target.kind === 'into-folder') {
      const b = rootBox(container, target.folderId)
      if (!b) return
      mode = 'ring'
      top = b.top
      height = b.height
    } else {
      const b = target.folderId ? memberBox(container, target.id) : rootBox(container, target.id)
      if (!b) return
      top = target.kind === 'before' ? b.top - GAP_HALF_PX : b.top + b.height + GAP_HALF_PX
    }
    ind.dataset.mode = mode
    ind.style.transform = `translateY(${Math.round(top)}px)`
    ind.style.height = mode === 'ring' ? `${Math.round(height)}px` : ''
  }

  const frame = () => {
    if (!active) return
    const container = opts.container.value
    if (!container) return
    active.ghost.style.transform =
      `translate3d(${active.clientX - active.offsetX}px, ${active.clientY - active.offsetY}px, 0) scale(1.06)`

    const box = container.getBoundingClientRect()
    const fromTop = active.clientY - box.top
    const fromBottom = box.bottom - active.clientY
    if (fromTop < AUTOSCROLL_EDGE_PX) {
      container.scrollTop -= Math.ceil(AUTOSCROLL_MAX_PX * (1 - Math.max(fromTop, 0) / AUTOSCROLL_EDGE_PX))
    } else if (fromBottom < AUTOSCROLL_EDGE_PX) {
      container.scrollTop += Math.ceil(AUTOSCROLL_MAX_PX * (1 - Math.max(fromBottom, 0) / AUTOSCROLL_EDGE_PX))
    }

    const outside = active.clientX < box.left - DROP_SLACK_PX || active.clientX > box.right + DROP_SLACK_PX
    const target = outside ? null : resolveDropTarget(contentY(container, active.clientY), active.rects, active.source)
    if (!sameTarget(target, active.target)) {
      active.target = target
      const onSelf = !!target && (target.kind === 'before' || target.kind === 'after') && target.id === active.source.id
      paintIndicator(container, onSelf ? null : target)
    }
    active.frame = requestAnimationFrame(frame)
  }

  const activate = () => {
    const container = opts.container.value
    if (!pending || !container) return
    const { el, source, startX, startY } = pending
    const r = el.getBoundingClientRect()
    const ghost = el.cloneNode(true) as HTMLElement
    ghost.removeAttribute('data-rail-kind')
    ghost.removeAttribute('data-rail-id')
    ghost.removeAttribute('tabindex')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.classList.add('rail-drag-ghost')
    Object.assign(ghost.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: `${r.width}px`,
      height: `${r.height}px`,
      margin: '0',
      pointerEvents: 'none',
      zIndex: '10002',
      willChange: 'transform',
    })
    document.body.appendChild(ghost)
    el.classList.add('rail-drag-source')
    container.classList.add('rail-dragging')
    active = {
      source,
      el,
      ghost,
      offsetX: startX - r.left,
      offsetY: startY - r.top,
      rects: measureRail(container),
      clientX: startX,
      clientY: startY,
      target: null,
      frame: 0,
    }
    pending = null
    active.frame = requestAnimationFrame(frame)
  }

  const teardown = () => {
    if (pending?.timer) clearTimeout(pending.timer)
    pending = null
    if (active) {
      cancelAnimationFrame(active.frame)
      active.ghost.remove()
      active.el.classList.remove('rail-drag-source')
      opts.container.value?.classList.remove('rail-dragging')
      const ind = opts.indicator.value
      if (ind) ind.dataset.mode = 'none'
      active = null
    }
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
  }

  function onMove(e: PointerEvent) {
    if (active) {
      active.clientX = e.clientX
      active.clientY = e.clientY
      return
    }
    if (!pending || e.pointerId !== pending.pointerId) return
    const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY)
    if (pending.pointerType === 'touch') {
      // Movement before the press arms is a scroll.
      if (!pending.armed && dist > TOUCH_SLOP_PX) teardown()
      else if (pending.armed && dist > TOUCH_SLOP_PX) activate()
      return
    }
    if (dist > MOUSE_DRAG_THRESHOLD_PX) activate()
  }

  function onUp(e: PointerEvent) {
    if (active) {
      const { source, target } = active
      active.clientY = e.clientY
      teardown()
      suppressClickUntil = performance.now() + 50
      if (target) opts.onDrop(source, target)
      return
    }
    if (pending?.armed) {
      const { source, el } = pending
      teardown()
      suppressClickUntil = performance.now() + 50
      opts.onLongPress(source, el)
      return
    }
    teardown()
  }

  function onCancel() {
    teardown()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && (active || pending)) {
      e.preventDefault()
      e.stopPropagation()
      teardown()
    }
  }

  const onPointerDown = (e: PointerEvent) => {
    if (active || pending) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-rail-kind]')
    if (!el || !opts.container.value?.contains(el)) return
    const source = sourceFromElement(el)
    if (!source) return
    if (e.pointerType === 'touch') lastTouchAt = performance.now()
    pending = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      source,
      el,
      timer: null,
      armed: false,
    }
    if (e.pointerType === 'touch') {
      pending.timer = setTimeout(() => {
        if (!pending) return
        pending.armed = true
        pending.timer = null
        pending.el.classList.add('rail-press-armed')
        navigator.vibrate?.(10)
        const armedEl = pending.el
        setTimeout(() => armedEl.classList.remove('rail-press-armed'), 200)
      }, LONG_PRESS_MS)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
  }

  /** Non-passive; blocks the page scroll once a touch drag owns the pointer. */
  const onTouchMove = (e: TouchEvent) => {
    if (active || pending?.armed) e.preventDefault()
  }

  /** True for the click that ends a drag or long-press. */
  const consumeClick = () => performance.now() < suppressClickUntil

  /** Touch long-press already opens the menu; the native contextmenu that follows is dropped. */
  const isTouchContextMenu = () => performance.now() - lastTouchAt < 1500

  const isDragging = () => active !== null

  onBeforeUnmount(teardown)

  return { onPointerDown, onTouchMove, consumeClick, isTouchContextMenu, isDragging, cancel: teardown }
}

function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === 'end' || b.kind === 'end') return true
  if (a.kind === 'into-folder' && b.kind === 'into-folder') return a.folderId === b.folderId
  if (a.kind === 'combine' && b.kind === 'combine') return a.id === b.id
  if ((a.kind === 'before' || a.kind === 'after') && (b.kind === 'before' || b.kind === 'after')) {
    return a.id === b.id && a.folderId === b.folderId
  }
  return false
}
