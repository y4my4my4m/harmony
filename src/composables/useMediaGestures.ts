/**
 * Pointer input on the media viewer's stage (MediaLightbox).
 *
 * Touch: one finger swipes between items (left: next) and down to dismiss, or pans a zoomed
 * image; two fingers pinch an image and hold anything else; a double tap on an image toggles
 * zoom. Mouse: a drag on an image moves it at any scale, free of its edges (useMediaZoom
 * `free`), and never swipes; the wheel zooms, below fit too, and a double click toggles zoom.
 * A click beside the media closes, unless it ends a drag.
 */

import { reactive, ref } from 'vue'
import {
  FIT_SCALE,
  TAP_SLOP,
  classifySwipe,
  isDoubleTap,
  pinchOf,
  wheelFactor,
  type Point,
  type Size,
  type Tap,
  type ZoomState,
} from '@/utils/lightboxGestures'
import type { MediaZoom } from '@/composables/useMediaZoom'

export interface MediaGestureOptions {
  zoomer: MediaZoom
  /** The current item is an image on the stage. */
  zoomable: () => boolean
  stage: () => HTMLElement | null
  /** The client point lies on the shown media. */
  onMedia: (clientX: number, clientY: number) => boolean
  /** Window that shows the viewer: the main one, or the call pop-out's. */
  view: () => Window
  hasPrevious: () => boolean
  hasNext: () => boolean
  previous: () => void
  next: () => void
  /** Downward swipe. */
  dismiss: () => void
  /** Click beside the media. */
  close: () => void
}

/** `hold`: two or more fingers on media that does not zoom; nothing happens until all lift. */
interface Gesture {
  kind: 'swipe' | 'pan' | 'pinch' | 'hold'
  /** A mouse pan: it frees the pan once it moves. */
  mouse: boolean
  start: Point
  time: number
  origin: ZoomState
  moved: boolean
  axis: 'x' | 'y' | null
  pinchDistance: number
  pinchCenter: Point
}

export function useMediaGestures(options: MediaGestureOptions) {
  const { zoomer } = options
  const zoom = zoomer.zoom

  /** Offset of the slide during a swipe, px. */
  const drag = reactive({ x: 0, y: 0 })
  const dragging = ref(false)
  /** A pan or pinch is in progress: the image follows without transition. */
  const gestureActive = ref(false)

  const pointers = new Map<number, Point>()
  let gesture: Gesture | null = null
  let lastTap: Tap | null = null
  let suppressClick = false
  // Time of the last touch release; Chrome follows a double tap with a dblclick.
  let lastTouchAt = -Infinity

  function stageBox(): DOMRect | null {
    return options.stage()?.getBoundingClientRect() ?? null
  }

  function stageSize(): Size {
    const box = stageBox()
    return { width: box?.width ?? 0, height: box?.height ?? 0 }
  }

  function toStage(clientX: number, clientY: number): Point {
    const box = stageBox()
    if (!box) return { x: 0, y: 0 }
    return { x: clientX - (box.left + box.width / 2), y: clientY - (box.top + box.height / 2) }
  }

  function startGesture(kind: Gesture['kind'], point: Point, time: number, extra: Partial<Gesture> = {}) {
    gesture = {
      kind,
      mouse: false,
      start: point,
      time,
      origin: { ...zoom },
      moved: false,
      axis: null,
      pinchDistance: 0,
      pinchCenter: { x: 0, y: 0 },
      ...extra,
    }
    gestureActive.value = kind !== 'swipe'
  }

  // The call pop-out forwards no pointermove or pointerup to the main window (callPopout.ts).
  let listening: Window | null = null
  function listen(on: boolean) {
    if (listening) {
      listening.removeEventListener('pointermove', onPointerMove)
      listening.removeEventListener('pointerup', onPointerUp)
      listening.removeEventListener('pointercancel', onPointerUp)
      listening = null
    }
    if (!on) return
    listening = options.view()
    listening.addEventListener('pointermove', onPointerMove)
    listening.addEventListener('pointerup', onPointerUp)
    listening.addEventListener('pointercancel', onPointerUp)
  }

  function onPointerDown(event: PointerEvent) {
    // A touch swipe or pinch is followed by no click; its suppression ends with the next press.
    suppressClick = false
    const mouse = event.pointerType === 'mouse'
    if (mouse && event.button !== 0) return
    const target = event.target as Element | null
    // The player's controls, the browser's video controls, the toolbar and nav buttons keep
    // their own pointer handling.
    if (target?.closest('.hv-dock, button, a, input, video, [role="slider"]')) return
    if (mouse && !(options.zoomable() && options.onMedia(event.clientX, event.clientY))) return
    if (!mouse) zoomer.hold()
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 1) {
      const kind = mouse || zoom.scale > FIT_SCALE ? 'pan' : 'swipe'
      startGesture(kind, { x: event.clientX, y: event.clientY }, event.timeStamp, { mouse })
      listen(true)
    } else if (pointers.size === 2) {
      // A second finger ends the swipe: it pinches an image and holds anything else.
      drag.x = 0
      drag.y = 0
      dragging.value = false
      if (!options.zoomable()) {
        startGesture('hold', { x: event.clientX, y: event.clientY }, event.timeStamp)
        return
      }
      const [a, b] = [...pointers.values()]
      const pinch = pinchOf(a, b)
      startGesture('pinch', pinch.center, event.timeStamp, {
        moved: true,
        pinchDistance: pinch.distance,
        pinchCenter: toStage(pinch.center.x, pinch.center.y),
      })
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (!gesture || !pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (gesture.kind === 'hold') return

    if (gesture.kind === 'pinch') {
      if (pointers.size < 2 || gesture.pinchDistance <= 0) return
      const [a, b] = [...pointers.values()]
      const pinch = pinchOf(a, b)
      const center = toStage(pinch.center.x, pinch.center.y)
      const scaled = zoomer.scaleAt(gesture.origin, gesture.origin.scale * (pinch.distance / gesture.pinchDistance), gesture.pinchCenter)
      zoomer.apply({
        ...scaled,
        x: scaled.x + center.x - gesture.pinchCenter.x,
        y: scaled.y + center.y - gesture.pinchCenter.y,
      })
      return
    }

    const dx = event.clientX - gesture.start.x
    const dy = event.clientY - gesture.start.y
    if (!gesture.moved && Math.hypot(dx, dy) < TAP_SLOP) return
    gesture.moved = true

    if (gesture.kind === 'pan') {
      if (gesture.mouse) zoomer.release()
      zoomer.apply({ ...gesture.origin, x: gesture.origin.x + dx, y: gesture.origin.y + dy })
      return
    }

    gesture.axis ??= Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
    dragging.value = true
    if (gesture.axis === 'x') {
      // Past either end the slide resists.
      const edge = (dx > 0 && !options.hasPrevious()) || (dx < 0 && !options.hasNext())
      drag.x = edge ? dx * 0.25 : dx
      drag.y = 0
    } else {
      drag.x = 0
      drag.y = Math.max(0, dy)
    }
  }

  function onPointerUp(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return
    pointers.delete(event.pointerId)
    const current = gesture
    if (!current) {
      if (pointers.size === 0) listen(false)
      return
    }

    if (current.kind === 'hold') {
      suppressClick = true
      if (pointers.size === 0) endGesture()
      return
    }

    if (current.kind === 'pinch') {
      suppressClick = true
      if (pointers.size === 1) {
        // The finger left on the glass pans on.
        const [rest] = [...pointers.values()]
        startGesture('pan', rest, event.timeStamp, { moved: true })
        return
      }
      if (zoom.scale < FIT_SCALE * 1.02) zoomer.apply({ ...zoom, scale: FIT_SCALE, x: 0, y: 0 })
      endGesture()
      return
    }
    if (pointers.size > 0) return
    if (event.pointerType !== 'mouse') lastTouchAt = event.timeStamp

    if (!current.moved) {
      if (event.pointerType !== 'mouse' && options.zoomable() && options.onMedia(event.clientX, event.clientY)) {
        const tap: Tap = { x: event.clientX, y: event.clientY, time: event.timeStamp }
        if (isDoubleTap(lastTap, tap)) {
          lastTap = null
          zoomer.toggleAt(toStage(tap.x, tap.y))
        } else {
          lastTap = tap
        }
      }
      endGesture()
      return
    }

    suppressClick = true
    let stepped = false
    if (current.kind === 'swipe') {
      const action = classifySwipe(drag.x, drag.y, event.timeStamp - current.time, stageSize())
      if (action === 'previous' && options.hasPrevious()) {
        options.previous()
        stepped = true
      } else if (action === 'next' && options.hasNext()) {
        options.next()
        stepped = true
      } else if (action === 'close') {
        options.dismiss()
      }
    }
    endGesture(stepped)
  }

  /** `stepped`: the swipe changed the item, which shows in place instead of sliding back. */
  function endGesture(stepped = false) {
    gesture = null
    gestureActive.value = false
    drag.x = 0
    drag.y = 0
    if (stepped) options.view().requestAnimationFrame(() => { dragging.value = false })
    else dragging.value = false
    pointers.clear()
    listen(false)
  }

  function onWheel(event: WheelEvent) {
    if (!options.zoomable()) return
    event.preventDefault()
    // A drag or pinch in progress holds the scale it started at.
    if (gesture || !event.deltaY) return
    zoomer.zoomBy(wheelFactor(event.deltaY, event.deltaMode), toStage(event.clientX, event.clientY))
  }

  function onDoubleClick(event: MouseEvent) {
    if (!options.zoomable() || !options.onMedia(event.clientX, event.clientY)) return
    // Touch double taps are recognised from pointer events.
    if (event.timeStamp - lastTouchAt < 800) return
    zoomer.toggleAt(toStage(event.clientX, event.clientY))
  }

  function onStageClick(event: MouseEvent) {
    if (suppressClick) {
      suppressClick = false
      return
    }
    if (!options.onMedia(event.clientX, event.clientY)) options.close()
  }

  /** Removes the window listeners of a gesture in progress. */
  function stop() {
    listen(false)
  }

  return { drag, dragging, gestureActive, onPointerDown, onWheel, onDoubleClick, onStageClick, stop }
}
