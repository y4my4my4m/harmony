/**
 * Zoom, pan and quarter-turn rotation of the media viewer's image (MediaLightbox).
 *
 * Coordinates are CSS px about the stage centre (utils/lightboxGestures.ts). `content` is the
 * image's layout box before the transform, `stage` the box it is centred in. A quarter-turned
 * image is scaled down by `turnFit` so it fits the stage; pan bounds use the turned box.
 *
 * The pan is held to the image's edges until a mouse drag frees it (`free`); a zoom step
 * down to fit, a double click, a touch and `reset` hold it again. Zoom steps go below fit,
 * down to MIN_SCALE; a touch returns a shrunk image to fit.
 */

import { computed, reactive, ref } from 'vue'
import {
  DOUBLE_TAP_SCALE,
  FIT_SCALE,
  IDENTITY,
  MAX_SCALE,
  MIN_SCALE,
  clampPan,
  maxScaleFor,
  zoomAt,
  type Point,
  type Size,
  type ZoomState,
} from '@/utils/lightboxGestures'

export interface MediaZoomOptions {
  content: () => Size
  stage: () => Size
  /** Pixel size of the image file; without it the scale stops at MAX_SCALE. */
  natural?: () => Size
}

/** Scale steps closer to fit than this land on it: `0.8 * 1.25` is not always 1. */
const FIT_EPSILON = 1e-6

export function useMediaZoom({ content, stage, natural }: MediaZoomOptions) {
  const zoom = reactive<ZoomState>({ ...IDENTITY })
  const turnFit = ref(1)
  const free = ref(false)

  const zoomed = computed(() => zoom.scale > FIT_SCALE)

  /** `transform` of the image: translate, rotate, then scale about its centre. */
  const transform = computed(
    () => `translate3d(${zoom.x}px, ${zoom.y}px, 0) rotate(${zoom.rotation}deg) scale(${zoom.scale * turnFit.value})`,
  )

  /** Sets `turnFit` for the current rotation and sizes: 1 when upright or before layout. */
  function measure(): void {
    const turned = (((Math.round(zoom.rotation / 90) % 4) + 4) % 4) % 2 === 1
    const box = content()
    const area = stage()
    if (!turned || !box.width || !box.height || !area.width || !area.height) {
      turnFit.value = 1
      return
    }
    turnFit.value = Math.min(1, area.width / box.height, area.height / box.width)
  }

  /** Upper bound of `zoom.scale` for the image as laid out now. */
  function maxScale(): number {
    if (!natural) return MAX_SCALE
    const box = content()
    return maxScaleFor({ width: box.width * turnFit.value, height: box.height * turnFit.value }, natural())
  }

  /** `zoomAt` up to this image's scale bound, down to `min`. */
  function scaleAt(state: ZoomState, nextScale: number, focus: Point, min = FIT_SCALE): ZoomState {
    return zoomAt(state, nextScale, focus, maxScale(), min)
  }

  /** Takes `state`, its pan clamped to the stage. */
  function apply(state: ZoomState): void {
    const clamped = clampPan({ ...state, scale: state.scale * turnFit.value }, content(), stage(), free.value)
    zoom.scale = state.scale
    zoom.x = clamped.x
    zoom.y = clamped.y
    zoom.rotation = state.rotation
  }

  /** Frees the pan of the image's edges. */
  function release(): void {
    free.value = true
  }

  /** Holds the pan to the image's edges again; a shrunk image returns to fit. */
  function hold(): void {
    const shrunk = zoom.scale < FIT_SCALE
    if (!free.value && !shrunk) return
    free.value = false
    apply(shrunk ? { ...zoom, scale: FIT_SCALE, x: 0, y: 0 } : { ...zoom })
  }

  /** Fit, centred, the pan held; the rotation stays. */
  function home(): void {
    free.value = false
    apply({ ...zoom, scale: FIT_SCALE, x: 0, y: 0 })
  }

  function reset(): void {
    Object.assign(zoom, IDENTITY)
    turnFit.value = 1
    free.value = false
  }

  /**
   * Multiplies the scale by `factor` about `focus`, within MIN_SCALE..maxScale(). A step that
   * passes fit stops at it; fit reached from above is `home`.
   */
  function zoomBy(factor: number, focus: Point = { x: 0, y: 0 }): void {
    const from = zoom.scale
    let target = from * factor
    const through = (from > FIT_SCALE && target < FIT_SCALE) || (from < FIT_SCALE && target > FIT_SCALE)
    if (through || Math.abs(target - FIT_SCALE) < FIT_EPSILON) target = FIT_SCALE
    if (target === FIT_SCALE && from > FIT_SCALE) home()
    else apply(scaleAt({ ...zoom }, target, focus, MIN_SCALE))
  }

  /** Turns by `degrees`, a multiple of 90; the pan recentres. */
  function rotateBy(degrees: number): void {
    zoom.rotation += degrees
    zoom.x = 0
    zoom.y = 0
    measure()
    apply({ ...zoom })
  }

  /** Double tap and double click: DOUBLE_TAP_SCALE about `point` from fit and centred, else `home`. */
  function toggleAt(point: Point): void {
    if (zoom.scale === FIT_SCALE && !zoom.x && !zoom.y) apply(scaleAt({ ...zoom }, DOUBLE_TAP_SCALE, point))
    else home()
  }

  /** After a resize: fit and pan bounds follow the new stage. */
  function refit(): void {
    measure()
    apply({ ...zoom })
  }

  return {
    zoom,
    turnFit,
    free,
    zoomed,
    transform,
    measure,
    maxScale,
    scaleAt,
    apply,
    release,
    hold,
    reset,
    zoomBy,
    rotateBy,
    toggleAt,
    refit,
  }
}

export type MediaZoom = ReturnType<typeof useMediaZoom>
