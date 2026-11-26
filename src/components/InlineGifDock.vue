<template>
  <Teleport to="body">
    <div
      v-if="frame && boxes"
      class="gif-dock"
      :class="{ animate: easing, collapsing: !state }"
      :style="{
        left: `${frame.left}px`,
        top: `${frame.top}px`,
        width: `${frame.width}px`,
        height: `${frame.height}px`,
      }"
      data-testid="gif-dock"
      aria-hidden="true"
    >
      <template v-for="(entry, i) in rendered" :key="entry.item.id">
        <div
          v-if="entry.item.kind === 'gif'"
          class="gif-dock-tile"
          :class="{ focus: i === focusRendered, keyboard: i === focusRendered && keyboard }"
          :style="entry.style"
          :data-dock-tile="entry.item.id"
          v-bind="tileListeners"
          @click="emit('select', entry.item.id)"
          @wheel="emit('wheel', $event)"
        >
          <img
            v-if="!(i === focusRendered && loadedFor === entry.item.id)"
            class="gif-dock-media"
            :src="entry.item.thumb"
            alt=""
            draggable="false"
          >
          <template v-if="i === focusRendered && fullFor === entry.item.id">
            <video
              v-if="entry.item.video"
              class="gif-dock-media gif-dock-full"
              :src="entry.item.full"
              autoplay
              loop
              playsinline
              :muted="audioFor !== entry.item.id"
              @loadeddata="onFullLoaded(entry.item.id, $event)"
            ></video>
            <img
              v-else
              class="gif-dock-media gif-dock-full"
              :src="entry.item.full"
              alt=""
              draggable="false"
              @load="onFullLoaded(entry.item.id, $event)"
            >
            <button
              v-if="entry.item.video"
              type="button"
              class="gif-dock-audio"
              tabindex="-1"
              :title="audioFor === entry.item.id ? $t('gif.clipMute') : $t('gif.clipUnmute')"
              @click.stop="audioFor = audioFor === entry.item.id ? null : entry.item.id"
            >
              <svg v-if="audioFor === entry.item.id" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
              <svg v-else viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
            </button>
          </template>
        </div>
        <span v-else-if="entry.item.kind === 'attribution'" class="gif-dock-slot gif-dock-attribution" :style="entry.style">KLIPY</span>
        <span v-else class="gif-dock-slot" :style="entry.style"></span>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { styleRect, type StyleRect } from '@/utils/appZoom'
import { DOCK_MAX_LONG_PX, dockFocusIndex, dockLayout, type DockBox, type DockItem } from '@/utils/gifDock'
import type { GifDockState } from '@/composables/useGifDock'

export interface DockMedia {
  id: string
  kind: 'gif' | 'ad' | 'attribution'
  /** Thumbnail the strip already shows. */
  thumb?: string
  /** Largest rendition the proxy sends: the `gif` format, the mp4 for clips. */
  full?: string
  video?: boolean
}

const props = defineProps<{
  /** The strip; each item's element carries data-dock-item with its id. */
  strip: HTMLElement | null
  /** The results area; the magnification is clipped to its sides. */
  bounds: HTMLElement | null
  items: DockMedia[]
  state: GifDockState | null
  tileListeners: Record<string, (event: never) => void>
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'wheel', event: WheelEvent): void
  /** True from the first magnified frame until the strip is back to rest. */
  (e: 'active', active: boolean): void
}>()

/** Dwell on a result before its full rendition loads, so a sweep along the strip loads none. */
const FULL_DWELL_MS = 120
/** Length of the CSS transition; a collapse keeps the overlay this long. */
const SETTLE_MS = 140
/** Room kept between the magnified tiles and the viewport's top edge. */
const TOP_MARGIN_PX = 8
/** Results this far beyond the strip's sides are laid out, for the ones the spread pulls in. */
const CULL_MARGIN_PX = 320

const reducedMotion = ref(false)
const shown = shallowRef<GifDockState | null>(null)
const amount = ref(0)
const rects = shallowRef<Map<string, StyleRect>>(new Map())
const boundsRect = shallowRef<StyleRect | null>(null)
const aspects = new Map<string, number>()
const aspectVersion = ref(0)
const fullFor = ref<string | null>(null)
/** The focus whose full rendition has loaded; its thumbnail is dropped so transparent media shows once. */
const loadedFor = ref<string | null>(null)
const audioFor = ref<string | null>(null)

let collapseTimer: ReturnType<typeof setTimeout> | null = null
let dwellTimer: ReturnType<typeof setTimeout> | null = null
let raf = 0

const keyboard = computed(() => shown.value?.mode === 'focus')

// Easing runs while the strip grows or settles back and for keyboard and touch moves; a pointer is followed at once.
const settling = ref(false)
let settleTimer: ReturnType<typeof setTimeout> | null = null
function markSettling() {
  settling.value = true
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = null
    settling.value = false
  }, SETTLE_MS + 40)
}
const easing = computed(() => !reducedMotion.value && (settling.value || shown.value?.mode !== 'pointer'))

function readReducedMotion(): boolean {
  if (typeof window === 'undefined') return true
  return (
    document.documentElement.getAttribute('data-reduce-motion') === 'true' ||
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
}

/** Width / height of what a strip item shows, from its loaded thumbnail; null before it loads. */
function mediaAspect(el: Element): number | null {
  const video = el.querySelector('video')
  if (video && video.videoWidth > 0 && video.videoHeight > 0) return video.videoWidth / video.videoHeight
  const img = el.querySelector('img')
  if (img && img.naturalWidth > 0 && img.naturalHeight > 0) return img.naturalWidth / img.naturalHeight
  return null
}

function measure() {
  raf = 0
  const strip = props.strip
  if (!strip || !strip.isConnected) return
  const next = new Map<string, StyleRect>()
  strip.querySelectorAll<HTMLElement>('[data-dock-item]').forEach((el) => {
    const id = el.getAttribute('data-dock-item')!
    next.set(id, styleRect(el))
    if (!aspects.has(id)) {
      const a = mediaAspect(el)
      if (a !== null) aspects.set(id, a)
    }
  })
  rects.value = next
  boundsRect.value = props.bounds?.isConnected ? styleRect(props.bounds) : styleRect(strip)
}

function scheduleMeasure() {
  if (!raf) raf = requestAnimationFrame(measure)
}

let listening = false
function listen(on: boolean) {
  if (on === listening || typeof window === 'undefined') return
  listening = on
  const method = on ? 'addEventListener' : 'removeEventListener'
  window[method]('scroll', scheduleMeasure, { capture: true, passive: true } as AddEventListenerOptions)
  window[method]('resize', scheduleMeasure)
}

/** Strip items with a measured box, in strip order. */
const laidOut = computed(() => {
  void aspectVersion.value
  const out: { item: DockMedia; dock: DockItem; rect: StyleRect }[] = []
  for (const item of props.items) {
    const rect = rects.value.get(item.id)
    if (!rect) continue
    out.push({
      item,
      rect,
      dock: { left: rect.left, width: rect.width, aspect: aspects.get(item.id) ?? 1, magnify: item.kind === 'gif' },
    })
  }
  return out
})

const baseTile = computed(() => laidOut.value.find((e) => e.item.kind === 'gif')?.rect ?? null)

const focusIndex = computed(() => {
  const s = shown.value
  if (!s) return -1
  if (s.focusId) return laidOut.value.findIndex((e) => e.item.id === s.focusId)
  return s.x === null ? -1 : dockFocusIndex(laidOut.value.map((e) => e.dock), s.x)
})

const frame = computed(() => {
  const tile = baseTile.value
  const b = boundsRect.value
  if (!tile || !b) return null
  const bottom = tile.top + tile.height
  const maxLong = Math.max(tile.height, Math.min(DOCK_MAX_LONG_PX, bottom - TOP_MARGIN_PX))
  const top = bottom - maxLong - TOP_MARGIN_PX / 2
  return { left: b.left, width: b.width, top, height: Math.max(b.top + b.height, bottom) - top, bottom, maxLong }
})

const boxes = computed<DockBox[] | null>(() => {
  const s = shown.value
  const f = frame.value
  const i = focusIndex.value
  const tile = baseTile.value
  if (!s || !f || !tile || i < 0) return null
  const focus = laidOut.value[i].rect
  const x = s.x ?? focus.left + focus.width / 2
  return dockLayout(laidOut.value.map((e) => e.dock), i, x, {
    base: tile.height,
    maxLong: f.maxLong,
    bounds: { left: f.left + 4, right: f.left + f.width - 4 },
    amount: amount.value,
  })
})

const rendered = computed(() => {
  const f = frame.value
  const all = boxes.value
  if (!f || !all) return []
  const out: { item: DockMedia; style: Record<string, string>; index: number }[] = []
  laidOut.value.forEach((e, index) => {
    const b = all[index]
    if (b.left + b.width < f.left - CULL_MARGIN_PX || b.left > f.left + f.width + CULL_MARGIN_PX) return
    const height = e.item.kind === 'gif' ? b.height : e.rect.height
    const bottom = e.item.kind === 'gif' ? f.bottom : e.rect.top + e.rect.height
    out.push({
      item: e.item,
      index,
      style: {
        left: `${b.left - f.left}px`,
        top: `${bottom - height - f.top}px`,
        width: `${b.width}px`,
        height: `${height}px`,
        zIndex: String(Math.round(b.height)),
      },
    })
  })
  return out
})

/** Position of the focus within `rendered`. */
const focusRendered = computed(() => rendered.value.findIndex((r) => r.index === focusIndex.value))

const focusId = computed(() => (focusIndex.value >= 0 ? laidOut.value[focusIndex.value]?.item.id ?? null : null))

watch(focusId, (id) => {
  if (dwellTimer) clearTimeout(dwellTimer)
  dwellTimer = null
  if (fullFor.value !== id) fullFor.value = null
  if (loadedFor.value !== id) loadedFor.value = null
  if (audioFor.value !== id) audioFor.value = null
  if (!id) return
  dwellTimer = setTimeout(() => {
    dwellTimer = null
    fullFor.value = id
  }, FULL_DWELL_MS)
})

function onFullLoaded(id: string, event: Event) {
  const el = event.target as HTMLImageElement | HTMLVideoElement
  const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth
  const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight
  loadedFor.value = id
  if (w > 0 && h > 0 && Math.abs(w / h - (aspects.get(id) ?? 1)) > 0.01) {
    aspects.set(id, w / h)
    aspectVersion.value++
  }
}

watch(
  () => props.state,
  (next) => {
    if (collapseTimer) {
      clearTimeout(collapseTimer)
      collapseTimer = null
    }
    if (next) {
      const starting = !shown.value
      shown.value = next
      if (!starting) {
        amount.value = 1
        return
      }
      reducedMotion.value = readReducedMotion()
      measure()
      listen(true)
      emit('active', true)
      if (reducedMotion.value) {
        amount.value = 1
        return
      }
      // One frame at rest, then the transition to full magnification.
      amount.value = 0
      markSettling()
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (shown.value) {
          markSettling()
          amount.value = 1
        }
      }))
      return
    }
    if (!shown.value) return
    const finish = () => {
      collapseTimer = null
      shown.value = null
      fullFor.value = null
      loadedFor.value = null
      audioFor.value = null
      listen(false)
      emit('active', false)
    }
    markSettling()
    amount.value = 0
    if (reducedMotion.value) finish()
    else collapseTimer = setTimeout(finish, SETTLE_MS)
  },
)

watch(() => props.items, () => {
  if (shown.value) scheduleMeasure()
})

onBeforeUnmount(() => {
  listen(false)
  if (raf) cancelAnimationFrame(raf)
  if (collapseTimer) clearTimeout(collapseTimer)
  if (dwellTimer) clearTimeout(dwellTimer)
  if (settleTimer) clearTimeout(settleTimer)
  if (shown.value) emit('active', false)
})
</script>

<style scoped>
.gif-dock {
  position: fixed;
  z-index: 10010;
  overflow: hidden;
  pointer-events: none;
}

.gif-dock-tile,
.gif-dock-slot {
  position: absolute;
  box-sizing: border-box;
  border-radius: 4px;
  overflow: hidden;
}

.gif-dock-tile {
  pointer-events: auto;
  cursor: pointer;
  background: #000;
}

.gif-dock.collapsing .gif-dock-tile {
  pointer-events: none;
}

.gif-dock-tile.focus {
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

/* Over the media, which covers the tile's own outline. */
.gif-dock-tile.keyboard::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  border: 2px solid var(--border-focus);
  border-radius: inherit;
  pointer-events: none;
}

.gif-dock.animate .gif-dock-tile,
.gif-dock.animate .gif-dock-slot {
  transition: left 0.14s ease-out, top 0.14s ease-out, width 0.14s ease-out, height 0.14s ease-out;
}

.gif-dock-media {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  -webkit-user-drag: none;
  user-select: none;
}

.gif-dock-slot {
  background: var(--background-senary-alpha);
}

.gif-dock-attribution {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.gif-dock-audio {
  position: absolute;
  z-index: 2;
  bottom: 6px;
  right: 6px;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.gif-dock-audio:hover {
  background: rgba(0, 0, 0, 0.85);
}

@media (prefers-reduced-motion: reduce) {
  .gif-dock.animate .gif-dock-tile,
  .gif-dock.animate .gif-dock-slot {
    transition: none;
  }
}
</style>
