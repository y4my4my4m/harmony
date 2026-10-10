/**
 * Floating video player.
 *
 * A playing video embed (YouTube iframe or native <video>) that scrolls out of
 * view moves into the mini player's slot; an in-chat placeholder keeps its
 * footprint. The video docks back, still playing, when the placeholder scrolls
 * into view or is clicked, on the player's return button, or when the setting
 * is turned off.
 *
 * The player outlives the component that registered the embed. When that
 * component unmounts (route, server or channel change) the player keeps the
 * floating element and playback continues. A later registration with the same
 * source key (message id, media type and source) becomes the dock target: it
 * is hidden behind a placeholder, and docking moves the playing <video> or
 * <iframe> into it in place of its own media node. Closing pauses; a video with
 * no mounted source is removed on close. The player also closes when the
 * element is removed from its slot (message edited) or the message is deleted
 * (releaseFloatingVideo).
 *
 * popOut floats a registered embed on request, in view or not, playing or
 * not. Its placeholder does not dock while it stays in view; docking by
 * visibility resumes once the placeholder has left the view.
 */

import { computed, nextTick, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { i18n } from '@/i18n'
import { isYouTubePlayerOrigin } from '@/utils/embedDetection'
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
  // type|messageId|source; equal keys denote the same media in the same message.
  key: string
  // Last observed intersection ratio of the embed in the chat.
  ratio: number
  // Cleared on every dock; set once the embed is seen again. A docked embed
  // that is still off-screen and playing would otherwise re-float at once.
  armed: boolean
}

interface DockTarget {
  // Re-mounted source embed, hidden behind the placeholder while the video floats.
  element: HTMLElement
  // Its inline display value before hiding.
  display: string
}

interface FloatingVideo {
  element: HTMLElement
  // In-chat stand-in; null while no source is mounted.
  placeholder: HTMLButtonElement | null
  registration: Registration
  aspect: number
  canPictureInPicture: boolean
  // The registering component unmounted; the player owns `element`.
  orphaned: boolean
  target: DockTarget | null
  // location path + search when the video floated.
  sourcePath: string
  // Floated by popOut; cleared once the placeholder reports less than
  // FLOAT_BELOW visible. While set, placeholder visibility does not dock.
  manual: boolean
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
// After "return to message" navigates, a source mounted within this window is
// scrolled to and docks once any of it shows.
const RETURN_WINDOW_MS = 8000
// Time a re-mounted source's placeholder stays in view before the video docks into it.
const TARGET_DOCK_DWELL_MS = 400
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
let returnUntil = 0
let targetDockTimer: ReturnType<typeof setTimeout> | null = null

function sourceKey(el: HTMLElement, options: FloatingVideoOptions): string {
  const media = el.querySelector(options.type === 'video' ? 'video' : 'iframe')
  const source = options.sourceUrl ?? media?.getAttribute('src') ?? ''
  return `${options.type}|${options.messageId ?? ''}|${source}`
}

function inAppRoot(el: HTMLElement): boolean {
  const appRoot = document.getElementById('app')
  return !appRoot || appRoot.contains(el)
}

// --- YouTube IFrame API ----------------------------------------------------
// Messages from every YouTube player window are tracked so a reloaded iframe
// can resume where it stopped. The protocol: the parent posts
// {"event":"listening"}; the player answers with initialDelivery, onReady,
// onStateChange (info: 1 = playing) and infoDelivery ({currentTime, playerState}).

interface YouTubePlayback {
  time: number
  playing: boolean
}

const youtubeState = new WeakMap<object, YouTubePlayback>()
const youtubeRestores = new Map<HTMLIFrameElement, YouTubePlayback>()
let youtubeListening = false

function postYouTube(iframe: HTMLIFrameElement, message: Record<string, unknown>): void {
  iframe.contentWindow?.postMessage(JSON.stringify(message), '*')
}

function onYouTubeMessage(event: MessageEvent): void {
  if (!event.source || !isYouTubePlayerOrigin(event.origin)) return
  let data: any = event.data
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return
    }
  }
  if (!data || typeof data !== 'object') return

  const state = youtubeState.get(event.source) ?? { time: 0, playing: false }
  if (data.event === 'infoDelivery' && data.info) {
    if (typeof data.info.currentTime === 'number') state.time = data.info.currentTime
    if (typeof data.info.playerState === 'number') state.playing = data.info.playerState === 1
  } else if (data.event === 'onStateChange' && typeof data.info === 'number') {
    state.playing = data.info === 1
  }
  youtubeState.set(event.source, state)

  // A floating video without a mounted source has no ProviderEmbedSwitch
  // keeping its play flag current.
  const cur = current.value
  if (cur?.orphaned && cur.registration.type === 'youtube'
    && cur.element.querySelector('iframe')?.contentWindow === event.source) {
    cur.element.dataset.isPlaying = String(state.playing)
  }

  if (data.event !== 'onReady') return
  for (const [iframe, restore] of youtubeRestores) {
    if (iframe.contentWindow !== event.source) continue
    youtubeRestores.delete(iframe)
    postYouTube(iframe, { event: 'command', func: 'seekTo', args: [restore.time, true] })
    postYouTube(iframe, { event: 'command', func: restore.playing ? 'playVideo' : 'pauseVideo', args: [] })
  }
}

function listenToYouTube(): void {
  if (youtubeListening || typeof window === 'undefined') return
  window.addEventListener('message', onYouTubeMessage)
  youtubeListening = true
}

// The reloaded player answers onReady once it hears "listening".
function restoreYouTubeAfterReload(iframe: HTMLIFrameElement, playback: YouTubePlayback): void {
  if (playback.time <= 0 && !playback.playing) return
  youtubeRestores.set(iframe, playback)
  iframe.addEventListener('load', () => postYouTube(iframe, { event: 'listening', id: iframe.id }), { once: true })
}

// moveBefore (Chrome 133+) relocates a node without resetting iframe or media
// state. insertBefore reloads iframes. Returns true when state was kept.
function moveNode(parent: Node, el: HTMLElement, before: Node | null): boolean {
  const mover = (parent as Node & { moveBefore?: (node: Node, child: Node | null) => void }).moveBefore
  if (typeof mover === 'function') {
    try {
      mover.call(parent, el, before)
      return true
    } catch {
      // moveBefore throws when either side is disconnected; fall through.
    }
  }
  parent.insertBefore(el, before)
  return false
}

/**
 * Moves `node` (an embed, or its <video>/<iframe>) and resumes playback the
 * move reset. `owner` carries the YouTube play flag (data-is-playing).
 */
function movePreservingPlayback(parent: Node, node: HTMLElement, before: Node | null, owner: HTMLElement = node): void {
  const video = node instanceof HTMLVideoElement ? node : node.querySelector('video')
  const iframe = node instanceof HTMLIFrameElement ? node : node.querySelector('iframe')
  const wasPlaying = video ? !video.paused : false
  const time = video?.currentTime ?? 0
  const youtube: YouTubePlayback | null = iframe
    ? {
        time: (iframe.contentWindow && youtubeState.get(iframe.contentWindow)?.time) || 0,
        playing: owner.dataset.isPlaying === 'true',
      }
    : null
  const preserved = moveNode(parent, node, before)
  if (video && wasPlaying && video.paused) {
    video.currentTime = time
    void video.play().catch(() => {})
  }
  if (iframe && youtube && !preserved) restoreYouTubeAfterReload(iframe, youtube)
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
      if (cur.manual) {
        if (!visibleEnough(entry, FLOAT_BELOW)) current.value = { ...cur, manual: false }
        continue
      }
      if (!cur.target) {
        if (!interaction.value && visibleEnough(entry, DOCK_ABOVE)) dock()
      } else if (!interaction.value && visibleEnough(entry, targetDockFraction())) {
        scheduleTargetDock(cur.placeholder)
      } else {
        cancelTargetDock()
      }
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
  if (!inAppRoot(el)) return
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

function float(el: HTMLElement, reg: Registration, manual = false): void {
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
    orphaned: false,
    target: null,
    sourcePath: `${window.location.pathname}${window.location.search}`,
    manual,
  }
  refreshLayout()

  movePreservingPlayback(slot, el, null)
  el.classList.add('floating-video')
  getObserver()?.observe(placeholder)
  attachViewportListeners()
}

function canDock(cur: FloatingVideo): boolean {
  return !cur.orphaned || !!cur.target
}

function clearCurrent(): void {
  cancelTargetDock()
  returnUntil = 0
  current.value = null
  livePosition.value = null
  endInteraction()
  detachViewportListeners()
}

/**
 * Put the floating video back in the chat. Playback continues; closing is
 * what pauses. With `scroll`, the chat scrolls to the returned embed. A video
 * whose source is not mounted stays floating.
 */
function dock(options: { scroll?: boolean } = {}): void {
  const cur = current.value
  if (!cur || !canDock(cur)) return
  const { element, placeholder, registration, target } = cur

  if (placeholder) observer?.unobserve(placeholder)
  clearCurrent()
  element.classList.remove('floating-video')
  registration.armed = false

  if (!host || element.parentNode !== host.slot) {
    // The owner removed the element itself.
    placeholder?.remove()
    if (target) target.element.style.display = target.display
    return
  }

  const home = target ? settleIntoTarget(element, placeholder, target, registration.type) : returnHome(element, placeholder)
  if (!home) return

  // Re-observing delivers a fresh ratio for the returned embed.
  if (observer && registry.get(home) === registration) {
    observer.unobserve(home)
    observer.observe(home)
  }
  if (options.scroll) {
    home.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }
}

// Original source still mounted: the element goes back where the placeholder is.
function returnHome(element: HTMLElement, placeholder: HTMLButtonElement | null): HTMLElement | null {
  if (!placeholder?.isConnected || !placeholder.parentNode) {
    // The placeholder left with its message; there is nowhere to return to.
    placeholder?.remove()
    element.remove()
    return null
  }
  movePreservingPlayback(placeholder.parentNode, element, placeholder)
  placeholder.remove()
  return element
}

// Re-mounted source: its own media node is replaced by the playing one, and
// the floating element, whose component is gone, is dropped.
function settleIntoTarget(
  element: HTMLElement,
  placeholder: HTMLButtonElement | null,
  target: DockTarget,
  type: FloatingVideoType,
): HTMLElement {
  const into = target.element
  into.style.display = target.display
  placeholder?.remove()
  const selector = type === 'video' ? 'video' : 'iframe'
  const media = element.querySelector<HTMLElement>(selector)
  const stale = into.querySelector<HTMLElement>(selector)
  if (media && stale?.parentNode) {
    if (type === 'youtube') into.dataset.isPlaying = element.dataset.isPlaying ?? 'false'
    movePreservingPlayback(stale.parentNode, media, stale, into)
    stale.remove()
  }
  element.remove()
  return into
}

// Drops the floating video without returning it anywhere.
function discard(): void {
  const cur = current.value
  if (!cur) return
  if (cur.placeholder) {
    observer?.unobserve(cur.placeholder)
    cur.placeholder.remove()
  }
  if (cur.target) cur.target.element.style.display = cur.target.display
  clearCurrent()
  cur.element.classList.remove('floating-video')
  cur.element.remove()
}

function close(): void {
  const cur = current.value
  if (!cur) return
  pause(cur.element, cur.registration.type)
  if (canDock(cur)) dock()
  else discard()
}

/**
 * The registering component unmounted while its element floats. The player
 * keeps the element; Vue removes only the top node of an unmounted subtree,
 * so the element is still in the slot unless it was that node.
 */
function orphan(cur: FloatingVideo): void {
  if (!host || cur.element.parentNode !== host.slot) {
    discard()
    return
  }
  if (cur.placeholder) {
    observer?.unobserve(cur.placeholder)
    cur.placeholder.remove()
  }
  current.value = { ...cur, placeholder: null, target: null, orphaned: true }
}

// A dock target appears by mounting, not by the user scrolling to it; a chat
// that opens and then jumps to its newest message shows the placeholder for a
// frame. Docking waits until the placeholder has stayed in view.
function scheduleTargetDock(placeholder: HTMLButtonElement): void {
  cancelTargetDock()
  targetDockTimer = setTimeout(() => {
    targetDockTimer = null
    if (current.value?.placeholder !== placeholder || interaction.value) return
    const r = placeholder.getBoundingClientRect()
    const top = Math.max(r.top, 0)
    const bottom = Math.min(r.bottom, window.innerHeight)
    if (r.height > 0 && (bottom - top) / r.height >= targetDockFraction()) dock()
  }, TARGET_DOCK_DWELL_MS)
}

// After the return button navigated here, any visible part of the placeholder
// docks: a message near the top of a channel cannot scroll fully into view.
function targetDockFraction(): number {
  return Date.now() < returnUntil ? FLOAT_BELOW : DOCK_ABOVE
}

function cancelTargetDock(): void {
  if (targetDockTimer !== null) {
    clearTimeout(targetDockTimer)
    targetDockTimer = null
  }
}

// A re-mount of the floating video's source: it waits hidden behind a
// placeholder until docking hands it the playing media.
function adopt(cur: FloatingVideo, el: HTMLElement, reg: Registration): void {
  const placeholder = createPlaceholder(el)
  el.parentNode?.insertBefore(placeholder, el)
  const target: DockTarget = { element: el, display: el.style.display }
  el.style.display = 'none'
  current.value = { ...cur, registration: reg, placeholder, target }
  getObserver()?.observe(placeholder)

  if (Date.now() < returnUntil) {
    requestAnimationFrame(() => {
      if (current.value?.placeholder === placeholder && placeholder.isConnected) {
        placeholder.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
      }
    })
  }
}

// The dock target unmounted before the video docked into it.
function releaseTarget(cur: FloatingVideo): void {
  cancelTargetDock()
  if (cur.placeholder) {
    observer?.unobserve(cur.placeholder)
    cur.placeholder.remove()
  }
  if (cur.target) cur.target.element.style.display = cur.target.display
  current.value = { ...cur, placeholder: null, target: null }
}

function enterPictureInPicture(): void {
  const cur = current.value
  const video = cur?.canPictureInPicture && canDock(cur) ? cur.element.querySelector('video') : null
  if (!video) return
  void video
    .requestPictureInPicture()
    .then(() => dock())
    .catch(() => {})
}

/**
 * Return button. Docks when a source is mounted and returns null; otherwise
 * returns the path the video floated from, and the next adopting source
 * scrolls its placeholder into view.
 */
function returnToSource(): string | null {
  const cur = current.value
  if (!cur) return null
  if (canDock(cur)) {
    dock({ scroll: true })
    return null
  }
  returnUntil = Date.now() + RETURN_WINDOW_MS
  if (cur.manual) current.value = { ...cur, manual: false }
  return cur.sourcePath
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
  if (cur && host && cur.element.parentNode !== host.slot) {
    if (canDock(cur)) dock()
    else discard()
  }
}

// --- Public API -------------------------------------------------------------

function setEnabled(value: boolean): void {
  enabled.value = value
  writeStorage('localStorage', ENABLED_KEY, String(value))
  if (value) return
  const cur = current.value
  if (cur && !canDock(cur)) close()
  else dock()
}

/**
 * Observe `element` (the embed's root) for floating. The returned cleanup
 * belongs in the owner's unmount; a floating element outlives it. A
 * registration matching a floating video whose source unmounted becomes
 * its dock target.
 */
function registerVideo(element: HTMLElement, options: FloatingVideoOptions): () => void {
  const previous = registry.get(element)
  const reg: Registration = {
    ...options,
    key: sourceKey(element, options),
    ratio: previous?.ratio ?? 1,
    armed: previous?.armed ?? true,
  }
  registry.set(element, reg)
  if (options.type === 'youtube') listenToYouTube()

  const cur = current.value
  if (cur?.element === element) {
    current.value = { ...cur, registration: reg }
  } else if (
    cur?.orphaned
    && !cur.target
    && reg.messageId
    && reg.key === cur.registration.key
    && element.isConnected
    && inAppRoot(element)
  ) {
    adopt(cur, element, reg)
  }
  getObserver()?.observe(element)

  return () => {
    if (registry.get(element) !== reg) return
    registry.delete(element)
    observer?.unobserve(element)
    const now = current.value
    if (now?.element === element) orphan(now)
    else if (now?.target?.element === element) releaseTarget(now)
  }
}

/** Message id the return button navigated to, while that return is pending. */
export function floatingReturnTarget(): string | null {
  const cur = current.value
  if (!cur || Date.now() >= returnUntil) return null
  return cur.registration.messageId ?? null
}

/** Closes the floating video of a deleted message. */
export function releaseFloatingVideo(messageId: string): void {
  if (messageId && current.value?.registration.messageId === messageId) close()
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

/** `el` is registered and renders in the main app tree, below the player's layer. */
function canPopOut(el: HTMLElement): boolean {
  return registry.has(el) && el.isConnected && inAppRoot(el)
}

/**
 * Floats `el` now, whatever its visibility or play state. The enabled
 * setting governs scroll-triggered floating only; a pop-out is an explicit
 * request. A video already floating is closed first: one video plays at a
 * time. Returns false when `el` cannot float.
 */
function popOut(el: HTMLElement): boolean {
  const reg = registry.get(el)
  if (!reg || !host || !canPopOut(el)) return false
  const cur = current.value
  if (cur?.element === el || cur?.target?.element === el) return true
  // A collapsed YouTube embed has no iframe to show.
  if (!el.querySelector(reg.type === 'video' ? 'video' : 'iframe')) return false
  if (cur) close()
  float(el, reg, true)
  return true
}

export function useFloatingVideo() {
  return {
    isEnabled: computed(() => enabled.value),
    setEnabled,
    registerVideo,
    notifyPlaybackStarted,
    canPopOut,
    popOut,
    floatingMessageId: computed(() => current.value?.registration.messageId ?? null),
  }
}

type FloatingVideoRefKey = string | number

interface BoundVideo {
  element: HTMLElement
  cleanup: (() => void) | null
}

/**
 * Registration through function template refs, for embeds rendered in lists:
 * `:ref="el => bind(key, el, options)"`. Vue calls a function ref with the
 * element after every patch and with null on unmount; an unchanged element is
 * a no-op, a new element for a key replaces the old registration, null
 * releases it. Registration waits a tick: the ref fires before a newly
 * mounted subtree is attached to the document, and adoption and canPopOut
 * test document position.
 */
export function useFloatingVideoRefs() {
  const bound = new Map<FloatingVideoRefKey, BoundVideo>()
  const poppable = reactive(new Set<FloatingVideoRefKey>())

  function release(key: FloatingVideoRefKey): void {
    const entry = bound.get(key)
    if (!entry) return
    bound.delete(key)
    poppable.delete(key)
    entry.cleanup?.()
  }

  function bind(key: FloatingVideoRefKey, el: unknown, options: FloatingVideoOptions): void {
    const element = el instanceof HTMLElement ? el : null
    if (element && bound.get(key)?.element === element) return
    release(key)
    if (!element) return
    const entry: BoundVideo = { element, cleanup: null }
    bound.set(key, entry)
    void nextTick(() => {
      if (bound.get(key) !== entry) return
      entry.cleanup = registerVideo(element, options)
      if (canPopOut(element)) poppable.add(key)
    })
  }

  onUnmounted(() => {
    for (const key of [...bound.keys()]) release(key)
  })

  return {
    bind,
    canPopOut: (key: FloatingVideoRefKey): boolean => poppable.has(key),
    popOut: (key: FloatingVideoRefKey): boolean => {
      const entry = bound.get(key)
      return !!entry && popOut(entry.element)
    },
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
    returnToSource,
    canDock: computed(() => !!current.value && canDock(current.value)),
    enterPictureInPicture,
    beginInteraction,
    dragTo,
    endDrag,
    resizeTo,
    endResize,
  }
}
