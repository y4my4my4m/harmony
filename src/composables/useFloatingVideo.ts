/**
 * Floating video player.
 *
 * A playing video embed (YouTube iframe or native <video>) that scrolls out of
 * view moves into the mini player's slot; an in-chat placeholder keeps its
 * footprint. The video docks back, still playing, when the placeholder scrolls
 * into view or is clicked, on the player's return button, or when the setting
 * is turned off. The player closes (pauses) when its source unmounts: channel
 * or route change, message deleted or edited.
 */

import { computed, ref, shallowRef } from 'vue'
import { i18n } from '@/i18n'
import {
  bottomCorner,
  clampAspect,
  clampFrameWidth,
  clampPoint,
  cornerPoint,
  excludeBottomObstacles,
  frameSize,
  frameWidthForLongEdge,
  insetBox,
  longEdgeForFrameWidth,
  nearestCorner,
  parsePlacement,
  serializePlacement,
  type Box,
  type Insets,
  type Placement,
  type Point,
  type Size,
} from '@/utils/floatingVideoGeometry'

export type FloatingVideoType = 'youtube' | 'video'

export interface FloatingVideoOptions {
  type: FloatingVideoType
  messageId?: string
  sourceUrl?: string
  title?: string
}

interface Registration extends FloatingVideoOptions {
  // Last observed intersection ratio of the embed in the chat.
  ratio: number
  // Cleared on every dock; set once the embed is seen again. A docked embed
  // that is still off-screen and playing would otherwise re-float at once.
  armed: boolean
}

interface FloatingVideo {
  element: HTMLElement
  placeholder: HTMLButtonElement
  registration: Registration
  aspect: number
  canPictureInPicture: boolean
}

const ENABLED_KEY = 'floatingVideoEnabled'
const PLACEMENT_KEY = 'floatingVideoPlacement'

// Visibility fractions of the embed (or its placeholder) in the viewport.
const FLOAT_BELOW = 0.2
const ARM_ABOVE = 0.5
const DOCK_ABOVE = 0.75

// Header bar height in px; the bar is static (adds height) on hover-less
// devices and overlays the video elsewhere.
export const FLOATING_VIDEO_BAR_HEIGHT = 32

const MOBILE_BREAKPOINT = 768
const LAYOUT = {
  desktop: { margin: 16, longEdge: 400, min: 240, max: 960 },
  mobile: { margin: 12, longEdge: 240, min: 160, max: 960 },
} as const

function readStorage(storage: 'localStorage' | 'sessionStorage', key: string): string | null {
  try {
    return globalThis[storage]?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStorage(storage: 'localStorage' | 'sessionStorage', key: string, value: string): void {
  try {
    globalThis[storage]?.setItem(key, value)
  } catch {
    // Storage blocked or full; the value lives in memory for this page.
  }
}

// Singleton state.
const enabled = ref(readStorage('localStorage', ENABLED_KEY) !== 'false')
const current = shallowRef<FloatingVideo | null>(null)
const placement = ref<Placement>(
  parsePlacement(readStorage('sessionStorage', PLACEMENT_KEY)) ?? { corner: 'bottom-right', longEdge: 0 },
)
// Viewport minus safe-area insets and the composer.
const safeBounds = ref<Box>({ left: 0, top: 0, width: 0, height: 0 })
const compact = ref(false)
const staticBar = ref(false)
const livePosition = ref<Point | null>(null)
const interaction = ref<'drag' | 'resize' | null>(null)

const registry = new Map<HTMLElement, Registration>()
let observer: IntersectionObserver | null = null
let host: { slot: HTMLElement; probe: HTMLElement } | null = null
let slotObserver: MutationObserver | null = null
let layoutFrame = 0

// moveBefore (Chrome 133+) relocates a node without resetting iframe or media
// state. insertBefore reloads iframes; ProviderEmbedSwitch then restores
// YouTube playback through its seek-on-reload path.
function moveNode(parent: Node, el: HTMLElement, before: Node | null): void {
  const mover = (parent as Node & { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore
  if (typeof mover === 'function') {
    try {
      mover.call(parent, el, before)
      return
    } catch {
      // moveBefore throws when either side is disconnected; fall through.
    }
  }
  parent.insertBefore(el, before)
}

function movePreservingPlayback(parent: Node, el: HTMLElement, before: Node | null): void {
  const video = el.querySelector('video')
  const wasPlaying = video ? !video.paused : false
  const time = video?.currentTime ?? 0
  moveNode(parent, el, before)
  if (video && wasPlaying && video.paused) {
    video.currentTime = time
    void video.play().catch(() => {})
  }
}

function isPlaying(el: HTMLElement, type: FloatingVideoType): boolean {
  if (type === 'video') {
    const video = el.querySelector('video')
    return !!video && !video.paused && !video.ended && document.pictureInPictureElement !== video
  }
  // A collapsed embed keeps the flag but has no iframe.
  return el.dataset.isPlaying === 'true' && !!el.querySelector('iframe')
}

function pause(el: HTMLElement, type: FloatingVideoType): void {
  if (type === 'video') {
    el.querySelector('video')?.pause()
    return
  }
  el.querySelector('iframe')?.contentWindow?.postMessage(
    '{"event":"command","func":"pauseVideo","args":""}',
    '*',
  )
  // A fallback move reloads the iframe before the pause lands; the flag keeps
  // the seek-restore path from resuming playback.
  el.dataset.isPlaying = 'false'
}

function mediaAspect(el: HTMLElement): number {
  const video = el.querySelector('video')
  if (video && video.videoWidth > 0 && video.videoHeight > 0) {
    return clampAspect(video.videoWidth / video.videoHeight)
  }
  const rect = (video ?? el.querySelector('iframe'))?.getBoundingClientRect()
  if (rect && rect.width > 0 && rect.height > 0) return clampAspect(rect.width / rect.height)
  return 16 / 9
}

function prefersReducedMotion(): boolean {
  if (document.documentElement.getAttribute('data-reduce-motion') === 'true') return true
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// True when at least `fraction` of the target, or of the viewport height, is
// covered. The second test lets targets taller than the viewport qualify.
function visibleEnough(entry: IntersectionObserverEntry, fraction: number): boolean {
  if (!entry.isIntersecting) return false
  if (entry.intersectionRatio >= fraction) return true
  return !!entry.rootBounds && entry.intersectionRect.height >= fraction * entry.rootBounds.height
}

function getObserver(): IntersectionObserver | null {
  if (observer) return observer
  if (typeof IntersectionObserver === 'undefined') return null
  observer = new IntersectionObserver(onIntersect, {
    threshold: [0, FLOAT_BELOW, ARM_ABOVE, DOCK_ABOVE, 1],
  })
  return observer
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const target = entry.target as HTMLElement
    const cur = current.value
    if (cur && target === cur.placeholder) {
      if (!interaction.value && visibleEnough(entry, DOCK_ABOVE)) dock()
      continue
    }
    const reg = registry.get(target)
    // A floating embed reports the player frame, not the chat.
    if (!reg || cur?.element === target) continue
    reg.ratio = entry.isIntersecting ? entry.intersectionRatio : 0
    if (visibleEnough(entry, ARM_ABOVE)) reg.armed = true
    if (reg.ratio < FLOAT_BELOW) maybeFloat(target, reg)
  }
}

function maybeFloat(el: HTMLElement, reg: Registration): void {
  if (!enabled.value || current.value || !reg.armed || !host || !el.isConnected) return
  // Embeds inside teleported overlays (threads, search, pinned) sit above
  // the player's layer; only the main app tree floats.
  const appRoot = document.getElementById('app')
  if (appRoot && !appRoot.contains(el)) return
  if (!isPlaying(el, reg.type)) return
  float(el, reg)
}

// Takes the embed's exact box, margins included, so the message does not
// reflow while the video floats.
function createPlaceholder(el: HTMLElement): HTMLButtonElement {
  const t = i18n.global.t
  const rect = el.getBoundingClientRect()
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'floating-video-placeholder'
  button.style.width = `${Math.round(rect.width)}px`
  button.style.height = `${Math.round(rect.height)}px`
  button.style.margin = getComputedStyle(el).margin
  // lucide picture-in-picture-2
  button.innerHTML =
    '<svg class="floating-video-placeholder__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/></svg>'
  const label = document.createElement('span')
  label.className = 'floating-video-placeholder__label'
  label.textContent = t('floatingVideo.placeholder')
  const hint = document.createElement('span')
  hint.className = 'floating-video-placeholder__hint'
  hint.textContent = t('floatingVideo.placeholderHint')
  button.append(label, hint)
  button.addEventListener('click', (e) => {
    e.stopPropagation()
    dock()
  })
  return button
}

function float(el: HTMLElement, reg: Registration): void {
  const slot = host!.slot
  const placeholder = createPlaceholder(el)
  el.parentNode?.insertBefore(placeholder, el)

  const video = reg.type === 'video' ? el.querySelector('video') : null
  current.value = {
    element: el,
    placeholder,
    registration: reg,
    aspect: mediaAspect(el),
    canPictureInPicture: !!video && document.pictureInPictureEnabled === true && !video.disablePictureInPicture,
  }
  refreshLayout()

  movePreservingPlayback(slot, el, null)
  el.classList.add('floating-video')
  getObserver()?.observe(placeholder)
  attachViewportListeners()
}

/**
 * Put the floating video back in the chat. Playback continues; closing is
 * what pauses. With `scroll`, the chat scrolls to the returned embed.
 */
function dock(options: { scroll?: boolean } = {}): void {
  const cur = current.value
  if (!cur) return
  const { element, placeholder, registration } = cur

  observer?.unobserve(placeholder)
  current.value = null
  livePosition.value = null
  endInteraction()
  detachViewportListeners()
  element.classList.remove('floating-video')
  registration.armed = false

  if (!host || element.parentNode !== host.slot) {
    // The owner removed the element itself.
    placeholder.remove()
    return
  }
  if (!placeholder.isConnected || !placeholder.parentNode) {
    // The placeholder left with its message; there is nowhere to return to.
    placeholder.remove()
    element.remove()
    return
  }

  movePreservingPlayback(placeholder.parentNode, element, placeholder)
  placeholder.remove()

  // Re-observing delivers a fresh ratio for the returned embed.
  if (observer && registry.get(element) === registration) {
    observer.unobserve(element)
    observer.observe(element)
  }
  if (options.scroll) {
    element.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }
}

function close(): void {
  const cur = current.value
  if (!cur) return
  pause(cur.element, cur.registration.type)
  dock()
}

function enterPictureInPicture(): void {
  const cur = current.value
  const video = cur?.canPictureInPicture ? cur.element.querySelector('video') : null
  if (!video) return
  void video
    .requestPictureInPicture()
    .then(() => dock())
    .catch(() => {})
}

// --- Layout ---------------------------------------------------------------

function readSafeAreaInsets(): Insets {
  const probe = host?.probe
  if (!probe) return { top: 0, right: 0, bottom: 0, left: 0 }
  const style = getComputedStyle(probe)
  return {
    top: parseFloat(style.paddingTop) || 0,
    right: parseFloat(style.paddingRight) || 0,
    bottom: parseFloat(style.paddingBottom) || 0,
    left: parseFloat(style.paddingLeft) || 0,
  }
}

function measureSafeBounds(): Box {
  // The visual viewport excludes the on-screen keyboard.
  const vv = window.visualViewport
  const viewport: Box = vv
    ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
  const obstacles = Array.from(document.querySelectorAll<HTMLElement>('[data-floating-video-avoid]'), (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  })
  return excludeBottomObstacles(insetBox(viewport, readSafeAreaInsets()), obstacles)
}

let hoverNoneQuery: MediaQueryList | null = null

function refreshLayout(): void {
  if (typeof window === 'undefined') return
  if (!hoverNoneQuery && typeof window.matchMedia === 'function') {
    hoverNoneQuery = window.matchMedia('(hover: none)')
  }
  compact.value = window.innerWidth <= MOBILE_BREAKPOINT
  staticBar.value = !!hoverNoneQuery?.matches
  safeBounds.value = measureSafeBounds()
  if (livePosition.value) {
    livePosition.value = clampPoint(livePosition.value, size.value, safeBounds.value)
  }
}

function scheduleLayout(): void {
  if (layoutFrame) return
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0
    refreshLayout()
  })
}

function attachViewportListeners(): void {
  window.addEventListener('resize', scheduleLayout, { passive: true })
  window.addEventListener('orientationchange', scheduleLayout)
  window.visualViewport?.addEventListener('resize', scheduleLayout)
  window.visualViewport?.addEventListener('scroll', scheduleLayout)
  hoverNoneQuery?.addEventListener('change', scheduleLayout)
}

function detachViewportListeners(): void {
  window.removeEventListener('resize', scheduleLayout)
  window.removeEventListener('orientationchange', scheduleLayout)
  window.visualViewport?.removeEventListener('resize', scheduleLayout)
  window.visualViewport?.removeEventListener('scroll', scheduleLayout)
  hoverNoneQuery?.removeEventListener('change', scheduleLayout)
  if (layoutFrame) {
    cancelAnimationFrame(layoutFrame)
    layoutFrame = 0
  }
}

const layout = computed(() => (compact.value ? LAYOUT.mobile : LAYOUT.desktop))
const chrome = computed(() => (staticBar.value ? FLOATING_VIDEO_BAR_HEIGHT : 0))
const snapBounds = computed(() => insetBox(safeBounds.value, layout.value.margin))
// Compact layouts keep the top edge clear for the channel header.
const corner = computed(() => (compact.value ? bottomCorner(placement.value.corner) : placement.value.corner))

const frameWidth = computed(() => {
  const cur = current.value
  if (!cur) return 0
  const { longEdge, min, max } = layout.value
  const aspect = cur.aspect
  return clampFrameWidth(
    frameWidthForLongEdge(placement.value.longEdge || longEdge, aspect),
    aspect,
    chrome.value,
    snapBounds.value,
    { min: frameWidthForLongEdge(min, aspect), max: frameWidthForLongEdge(max, aspect) },
  )
})

const size = computed<Size>(() => {
  const cur = current.value
  if (!cur) return { width: 0, height: 0 }
  return frameSize(frameWidth.value, cur.aspect, chrome.value)
})

const position = computed<Point>(
  () => livePosition.value ?? cornerPoint(corner.value, size.value, snapBounds.value),
)

function persistPlacement(): void {
  writeStorage('sessionStorage', PLACEMENT_KEY, serializePlacement(placement.value))
}

function beginInteraction(kind: 'drag' | 'resize'): void {
  interaction.value = kind
  document.documentElement.classList.add('floating-video-interacting')
}

function endInteraction(): void {
  interaction.value = null
  document.documentElement.classList.remove('floating-video-interacting')
}

function dragTo(point: Point): void {
  livePosition.value = clampPoint(point, size.value, safeBounds.value)
}

function endDrag(): void {
  const live = livePosition.value
  endInteraction()
  if (!live) return
  refreshLayout()
  const snapped = nearestCorner(live, size.value, snapBounds.value)
  placement.value = { ...placement.value, corner: compact.value ? bottomCorner(snapped) : snapped }
  livePosition.value = null
  persistPlacement()
}

function resizeTo(width: number): void {
  const cur = current.value
  if (!cur) return
  const { min, max } = layout.value
  const clamped = clampFrameWidth(width, cur.aspect, chrome.value, snapBounds.value, {
    min: frameWidthForLongEdge(min, cur.aspect),
    max: frameWidthForLongEdge(max, cur.aspect),
  })
  placement.value = { ...placement.value, longEdge: longEdgeForFrameWidth(clamped, cur.aspect) }
}

function endResize(): void {
  endInteraction()
  persistPlacement()
}

function onSlotMutation(): void {
  const cur = current.value
  if (cur && host && cur.element.parentNode !== host.slot) dock()
}

// --- Public API -------------------------------------------------------------

function setEnabled(value: boolean): void {
  enabled.value = value
  writeStorage('localStorage', ENABLED_KEY, String(value))
  if (!value) dock()
}

/**
 * Observe `element` (the embed's root) for floating. The returned cleanup
 * belongs in the owner's unmount; a floating element closes with it.
 */
function registerVideo(element: HTMLElement, options: FloatingVideoOptions): () => void {
  const previous = registry.get(element)
  const reg: Registration = { ...options, ratio: previous?.ratio ?? 1, armed: previous?.armed ?? true }
  registry.set(element, reg)
  if (current.value?.element === element) {
    current.value = { ...current.value, registration: reg }
  }
  getObserver()?.observe(element)

  return () => {
    if (registry.get(element) !== reg) return
    registry.delete(element)
    observer?.unobserve(element)
    if (current.value?.element === element) close()
  }
}

/**
 * Playback started on `el` or a video inside it. One video plays at a time:
 * any other start closes the player. A registered embed that starts while
 * mostly out of view floats on the next intersection report.
 */
function notifyPlaybackStarted(el: HTMLElement): void {
  const cur = current.value
  if (cur && !cur.element.contains(el)) close()

  let node: HTMLElement | null = el
  while (node && !registry.has(node)) node = node.parentElement
  if (!node || !observer || node === current.value?.element) return
  // The stored ratio can predate a scroll in the same frame; re-observing
  // delivers a fresh one.
  observer.unobserve(node)
  observer.observe(node)
}

export function useFloatingVideo() {
  return {
    isEnabled: computed(() => enabled.value),
    setEnabled,
    registerVideo,
    notifyPlaybackStarted,
    floatingMessageId: computed(() => current.value?.registration.messageId ?? null),
  }
}

/** Player frame state and actions. */
export function useFloatingVideoPlayer() {
  return {
    current,
    corner,
    size,
    position,
    chrome,
    interaction,
    attachHost(slot: HTMLElement, probe: HTMLElement): void {
      host = { slot, probe }
      slotObserver?.disconnect()
      if (typeof MutationObserver !== 'undefined') {
        slotObserver = new MutationObserver(onSlotMutation)
        slotObserver.observe(slot, { childList: true })
      }
    },
    detachHost(): void {
      close()
      slotObserver?.disconnect()
      slotObserver = null
      host = null
    },
    dock,
    close,
    enterPictureInPicture,
    beginInteraction,
    dragTo,
    endDrag,
    resizeTo,
    endResize,
  }
}
