/**
 * The app's media viewer (MediaLightbox), opened from anywhere through openLightbox and
 * rendered once by MediaLightboxHost in App.vue. One viewer is open at a time.
 *
 * The viewer mounts on <body>, or in a portal container (usePortalTarget): opened through
 * useLightbox().open, in the one provided above the caller, so a viewer opened from the
 * call view shows above it and in its pop-out window.
 */

import { computed, hasInjectionContext, shallowRef } from 'vue'
import { usePortalContainer } from '@/composables/usePortalTarget'

/**
 * One item of the viewer.
 *
 * Stable shape for callers: `{ url, type: 'image' | 'video' | 'audio', name?, poster? }`.
 * `alt` and `loop` are optional refinements.
 */
export interface LightboxMedia {
  /** Fetchable source: an http(s), blob: or data: URL. `embed`: X's embed page of a post. */
  url: string
  /** `embed`: a video played in X's embedded post, framed on the viewer's click (XPostFrame). */
  type: 'image' | 'video' | 'audio' | 'embed'
  /** File name: the caption, the download name, and the text alternative when `alt` is absent. */
  name?: string
  /** Still image: a video's poster frame, an audio item's artwork. */
  poster?: string
  /** Text alternative of the item. */
  alt?: string
  /** A muted looping clip without player controls (GIFV). Videos only. */
  loop?: boolean
}

export interface LightboxOptions {
  /**
   * Inline player of the start item. Its position carries into the viewer and it pauses
   * while the viewer is open; on close it takes the viewer's position for that item.
   */
  origin?: HTMLMediaElement | null
  /** Download button for the current item. Default true. */
  download?: boolean
  /** Container the viewer mounts in, or its getter, read while open. Absent, null or detached: <body>. */
  target?: HTMLElement | (() => HTMLElement | null) | null
}

export interface LightboxRequest {
  id: number
  items: LightboxMedia[]
  index: number
  options: LightboxOptions
}

const request = shallowRef<LightboxRequest | null>(null)
let nextId = 0

/**
 * Opens the media viewer over the app at `startIndex` of `items`; previous and next step
 * through the list. Replaces a viewer already open. An empty list does nothing; the index
 * is clamped to the list.
 *
 *   openLightbox([{ url, type: 'video', name: 'clip.mp4', poster }], 0)
 *
 * @param items media in viewing order; each `{ url, type: 'image' | 'video' | 'audio', name?, poster? }`
 * @param startIndex index of the item shown first
 * @param options see LightboxOptions
 */
export function openLightbox(
  items: readonly LightboxMedia[],
  startIndex = 0,
  options: LightboxOptions = {},
): void {
  const usable = (item: LightboxMedia | null | undefined): item is LightboxMedia =>
    !!item && typeof item.url === 'string' && item.url.length > 0
  const list = items.filter(usable)
  if (list.length === 0) return
  const start = Math.min(Math.max(0, Math.trunc(Number.isFinite(startIndex) ? startIndex : 0)), items.length - 1)
  // Items without a source are dropped; the start stays on the requested item, or the next one.
  const index = Math.min(items.slice(0, start).filter(usable).length, list.length - 1)
  request.value = { id: ++nextId, items: list, index, options }
}

/** Closes the viewer. */
export function closeLightbox(): void {
  request.value = null
}

const current = computed(() => request.value)

/**
 * The viewer's request and controls. Called in setup, `open` mounts the viewer in the
 * caller's portal container unless the options name a target.
 */
export function useLightbox() {
  const container = hasInjectionContext() ? usePortalContainer() : null
  const open: typeof openLightbox = container
    ? (items, startIndex, options = {}) => openLightbox(items, startIndex, 'target' in options ? options : { ...options, target: container })
    : openLightbox
  return {
    request: current,
    open,
    close: closeLightbox,
  }
}
