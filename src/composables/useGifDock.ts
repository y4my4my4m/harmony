import { onScopeDispose, shallowRef, watch } from 'vue'
import { toStylePx } from '@/utils/appZoom'

export interface GifDockState {
  /** What places the magnification: the pointer, keyboard focus or a touch hold. */
  mode: 'pointer' | 'focus' | 'press'
  /** Pointer x in CSS px; null when the magnification centres on `focusId`. */
  x: number | null
  focusId: string | null
}

export interface GifDockOptions {
  /** True while the pointer is over the strip or a magnified tile. */
  hovering: () => boolean
  /** Result id of the pick button holding :focus-visible focus, if any. */
  keyboardTile: () => string | null
  /** Pointer rest on the strip before magnifying, so a pointer crossing it on the way elsewhere does nothing. */
  enterDelayMs?: number
  /** Touch hold that magnifies. */
  longPressMs?: number
}

export const GIF_DOCK_ENTER_MS = 180
export const GIF_DOCK_LONG_PRESS_MS = 450
/** Pointer gap between the strip and a magnified tile, or between two tiles. */
const LEAVE_GRACE_MS = 80
/** Finger travel that turns a hold into a scroll. */
const LONG_PRESS_SLOP_PX = 10
/** The click a touch release produces after a long-press is swallowed within this window. */
const CLICK_SWALLOW_MS = 700
/** Interval of the check that ends a magnification nothing holds any more. */
const LIVE_CHECK_MS = 250

const TILE_ATTR = 'data-gif-tile'

const isPointer = (e: PointerEvent) => e.pointerType !== 'touch'

/**
 * State of the /gif strip's magnification. A pointer resting on the strip starts it and
 * moving along the strip or over the magnified tiles moves it; keyboard focus
 * (:focus-visible only) and a touch long-press centre it on a result. It ends when
 * nothing holds it: no pointer over the strip or its tiles, no keyboard focus in it, no
 * finger down. A long-press release sends nothing.
 */
export function useGifDock(options: GifDockOptions) {
  const enterDelay = options.enterDelayMs ?? GIF_DOCK_ENTER_MS
  const longPressDelay = options.longPressMs ?? GIF_DOCK_LONG_PRESS_MS

  const state = shallowRef<GifDockState | null>(null)

  let enterTimer: ReturnType<typeof setTimeout> | null = null
  let leaveTimer: ReturnType<typeof setTimeout> | null = null
  let pressTimer: ReturnType<typeof setTimeout> | null = null
  let pendingX: number | null = null
  let press: { x: number; y: number; pointerId: number } | null = null
  let pressShown = false
  let swallowClickUntil = 0
  // Touch browsers keep :hover on a tapped element; hover counts only after a mouse or pen moved.
  let pointerSeen = false

  const clear = (timer: ReturnType<typeof setTimeout> | null) => {
    if (timer) clearTimeout(timer)
    return null
  }

  const collapse = () => {
    enterTimer = clear(enterTimer)
    leaveTimer = clear(leaveTimer)
    pressTimer = clear(pressTimer)
    pendingX = null
    press = null
    pressShown = false
    state.value = null
  }

  /** Hands the magnification to whatever still holds it, or ends it. */
  const settle = () => {
    leaveTimer = clear(leaveTimer)
    if (pressShown) return
    if (pointerSeen && options.hovering()) return
    enterTimer = clear(enterTimer)
    const id = options.keyboardTile()
    if (id) {
      if (state.value?.mode !== 'focus' || state.value.focusId !== id) state.value = { mode: 'focus', x: null, focusId: id }
      return
    }
    state.value = null
  }

  const settleSoon = () => {
    leaveTimer = clear(leaveTimer)
    leaveTimer = setTimeout(settle, LEAVE_GRACE_MS)
  }

  const pointerAt = (x: number) => {
    leaveTimer = clear(leaveTimer)
    if (state.value && !pressShown) {
      state.value = { mode: 'pointer', x, focusId: null }
      return
    }
    pendingX = x
    if (enterTimer || pressShown) return
    enterTimer = setTimeout(() => {
      enterTimer = null
      if (pendingX === null || !pointerSeen || !options.hovering()) return
      state.value = { mode: 'pointer', x: pendingX, focusId: null }
    }, enterDelay)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!isPointer(event)) {
      if (press && event.pointerId === press.pointerId && !pressShown) {
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP_PX) {
          press = null
          pressTimer = clear(pressTimer)
        }
      }
      return
    }
    pointerSeen = true
    pointerAt(toStylePx(event.clientX))
  }

  const onPointerLeave = (event: PointerEvent) => {
    if (!isPointer(event)) return
    settleSoon()
  }

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target as HTMLElement | null
    const id = target?.getAttribute?.(TILE_ATTR)
    if (!id || !target!.matches(':focus-visible')) return
    leaveTimer = clear(leaveTimer)
    enterTimer = clear(enterTimer)
    state.value = { mode: 'focus', x: null, focusId: id }
  }

  const onFocusOut = (event: FocusEvent) => {
    const strip = event.currentTarget as HTMLElement
    const next = event.relatedTarget as Node | null
    if (next && strip.contains(next)) return
    settleSoon()
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return
    pointerSeen = false
    const id = (event.target as HTMLElement | null)?.closest?.('.inline-gif-item')?.querySelector(`[${TILE_ATTR}]`)?.getAttribute(TILE_ATTR)
    if (!id) return
    press = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    pressShown = false
    pressTimer = clear(pressTimer)
    pressTimer = setTimeout(() => {
      pressTimer = null
      if (!press) return
      pressShown = true
      state.value = { mode: 'press', x: null, focusId: id }
    }, longPressDelay)
  }

  const endPress = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.pointerId) return
    const wasShown = pressShown
    press = null
    pressShown = false
    pressTimer = clear(pressTimer)
    if (wasShown) {
      swallowClickUntil = Date.now() + CLICK_SWALLOW_MS
      settle()
    }
  }

  /** Capture phase: the release of a long-press is not a pick. */
  const onClickCapture = (event: MouseEvent) => {
    if (Date.now() >= swallowClickUntil) return
    swallowClickUntil = 0
    event.preventDefault()
    event.stopPropagation()
  }

  /** The platform's long-press menu (save image) yields to the magnification. */
  const onContextMenu = (event: MouseEvent) => {
    if (press || pressShown || Date.now() < swallowClickUntil) event.preventDefault()
  }

  /** Listeners for the strip, as `v-bind` props. */
  const stripListeners = {
    onPointerenter: onPointerMove,
    onPointermove: onPointerMove,
    onPointerleave: onPointerLeave,
    onFocusin: onFocusIn,
    onFocusout: onFocusOut,
    onPointerdown: onPointerDown,
    onPointerup: endPress,
    onPointercancel: endPress,
    onClickCapture,
    onContextmenu: onContextMenu,
  }

  /** Listeners for each magnified tile: the pointer over one keeps and moves the magnification. */
  const tileListeners = {
    onPointerenter: onPointerMove,
    onPointermove: onPointerMove,
    onPointerleave: onPointerLeave,
    onClickCapture,
  }

  // Removed tiles and tiles moving under a still pointer fire no pointerleave.
  let liveTimer: ReturnType<typeof setInterval> | null = null
  watch(
    state,
    (value) => {
      if (value && !liveTimer) liveTimer = setInterval(settle, LIVE_CHECK_MS)
      else if (!value && liveTimer) {
        clearInterval(liveTimer)
        liveTimer = null
      }
    },
    { flush: 'sync' },
  )

  const onWindowBlur = () => collapse()
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') collapse()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibility)
  }

  onScopeDispose(() => {
    collapse()
    if (liveTimer) clearInterval(liveTimer)
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', onWindowBlur)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  })

  return { state, collapse, stripListeners, tileListeners }
}
