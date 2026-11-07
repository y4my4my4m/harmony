/**
 * Zoom, pan and quarter-turn rotation of the media viewer's image (MediaLightbox).
 *
 * Coordinates are CSS px about the stage centre (utils/lightboxGestures.ts). `content` is the
 * image's layout box before the transform, `stage` the box it is centred in. A quarter-turned
 * image is scaled down by `turnFit` so it fits the stage; pan bounds use the turned box.
 */

import { computed, reactive, ref } from 'vue'
import {
  DOUBLE_TAP_SCALE,
  IDENTITY,
  MIN_SCALE,
  clampPan,
  zoomAt,
  type Point,
  type Size,
  type ZoomState,
} from '@/utils/lightboxGestures'

export interface MediaZoomOptions {
  content: () => Size
  stage: () => Size
}

export function useMediaZoom({ content, stage }: MediaZoomOptions) {
  const zoom = reactive<ZoomState>({ ...IDENTITY })
  const turnFit = ref(1)

  const zoomed = computed(() => zoom.scale > MIN_SCALE)

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

  /** Takes `state`, its pan clamped to the stage. */
  function apply(state: ZoomState): void {
    const clamped = clampPan({ ...state, scale: state.scale * turnFit.value }, content(), stage())
    zoom.scale = state.scale
    zoom.x = clamped.x
    zoom.y = clamped.y
    zoom.rotation = state.rotation
  }

  function reset(): void {
    Object.assign(zoom, IDENTITY)
    turnFit.value = 1
  }

  /** Multiplies the scale by `factor` about `focus`, within MIN_SCALE..MAX_SCALE. */
  function zoomBy(factor: number, focus: Point = { x: 0, y: 0 }): void {
    apply(zoomAt({ ...zoom }, zoom.scale * factor, focus))
  }

  /** Turns by `degrees`, a multiple of 90; the pan recentres. */
  function rotateBy(degrees: number): void {
    zoom.rotation += degrees
    zoom.x = 0
    zoom.y = 0
    measure()
    apply({ ...zoom })
  }

  /** Double tap and double click: back to fit when zoomed, else DOUBLE_TAP_SCALE about `point`. */
  function toggleAt(point: Point): void {
    if (zoom.scale > MIN_SCALE) apply({ ...zoom, scale: MIN_SCALE, x: 0, y: 0 })
    else apply(zoomAt({ ...zoom }, DOUBLE_TAP_SCALE, point))
  }

  /** After a resize: fit and pan bounds follow the new stage. */
  function refit(): void {
    measure()
    apply({ ...zoom })
  }

  return { zoom, turnFit, zoomed, transform, measure, apply, reset, zoomBy, rotateBy, toggleAt, refit }
}

export type MediaZoom = ReturnType<typeof useMediaZoom>
