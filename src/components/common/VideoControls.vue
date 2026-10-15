<!--
  VideoControls - Harmony's player chrome over a <video> rendered without `controls`.

  Placed as the last child of the element that frames the video (its host, positioned and
  sized to the video), so the parent's own CSS keeps styling the <video>:

    <div class="media-frame">
      <video :src="url" :controls="nativeVideoControls" preload="metadata" />
      <VideoControls v-if="!nativeVideoControls" />
    </div>

  The video is the host's <video>, read again on every media event: floating video re-docks
  by moving the playing <video> in place of the host's own. Media events do not bubble; they
  are heard in the host's capture phase.

  Per-frame state (progress, scrub position) is written to CSS variables and text nodes, not
  to reactive state; Vue re-renders only on play/pause, volume, rate, fullscreen and idle
  changes. The rAF loop runs only while the video plays.
-->
<template>
  <div
    ref="rootEl"
    class="hv"
    :class="{
      'hv--playing': playing,
      'hv--started': started,
      'hv--idle': idle,
      'hv--scrubbing': scrubbing,
      'hv--fullscreen': fullscreen,
      'hv--narrow': narrow,
      'hv--compact': compact,
      'hv--tiny': tiny,
    }"
    role="group"
    :aria-label="label || t('videoPlayer.player')"
    data-testid="video-controls"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
    @focusin="wake"
    @keydown="onKeydown"
  >
    <div
      class="hv-hit"
      aria-hidden="true"
      @pointerdown="lastPointer = $event.pointerType"
      @click="onHitClick"
      @dblclick="toggleFullscreen"
    ></div>

    <div v-if="waiting && playing" class="hv-spinner" aria-hidden="true"></div>

    <button
      v-show="!playing && !scrubbing"
      type="button"
      class="hv-big"
      tabindex="-1"
      aria-hidden="true"
      @click.stop="togglePlay"
    >
      <svg v-if="ended" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" /></svg>
      <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z" /></svg>
    </button>

    <div class="hv-dock" @click.stop @dblclick.stop>
      <button
        type="button"
        class="hv-play"
        :aria-label="ended ? t('videoPlayer.replay') : playing ? t('videoPlayer.pause') : t('videoPlayer.play')"
        data-testid="video-play"
        @click="togglePlay"
      >
        <svg v-if="playing" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.4" /><rect x="13.5" y="5" width="4" height="14" rx="1.4" /></svg>
        <svg v-else-if="ended" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" /></svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z" /></svg>
      </button>

      <div class="hv-pill">
        <span ref="currentEl" class="hv-time" aria-hidden="true">0:00</span>

        <div
          ref="seekEl"
          class="hv-seek"
          role="slider"
          tabindex="0"
          :aria-label="t('videoPlayer.seek')"
          aria-valuemin="0"
          :aria-valuemax="Math.round(duration)"
          :aria-valuenow="second"
          :aria-valuetext="t('videoPlayer.seekValue', { current: formatTime(second), total: formatTime(duration) })"
          data-testid="video-seek"
          @pointerdown="onSeekDown"
          @pointermove="onSeekHover"
          @pointerleave="onSeekLeave"
        >
          <div class="hv-track">
            <div class="hv-fill hv-fill--buffered"></div>
            <div class="hv-fill hv-fill--hover"></div>
            <div class="hv-fill hv-fill--played"></div>
          </div>
          <div class="hv-thumb-rail" aria-hidden="true"><span class="hv-thumb"></span></div>
          <div ref="tipEl" class="hv-tip" aria-hidden="true">0:00</div>
        </div>

        <span class="hv-time hv-time--total" aria-hidden="true">{{ formatTime(duration) }}</span>

        <div class="hv-volume">
          <button
            type="button"
            class="hv-btn"
            :aria-label="muted || volume === 0 ? t('videoPlayer.unmute') : t('videoPlayer.mute')"
            data-testid="video-mute"
            @click="toggleMute"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9.5v5a1 1 0 0 0 1 1h3l4.3 3.6a.6.6 0 0 0 1-.46V5.36a.6.6 0 0 0-1-.46L8 8.5H5a1 1 0 0 0-1 1z" />
              <template v-if="muted || volume === 0">
                <path d="M16.5 9.5l5 5m0-5l-5 5" class="hv-stroke" />
              </template>
              <template v-else>
                <path d="M16 9.2a4 4 0 0 1 0 5.6" class="hv-stroke" />
                <path v-if="volume > 0.5" d="M18.6 6.6a7.6 7.6 0 0 1 0 10.8" class="hv-stroke" />
              </template>
            </svg>
          </button>
          <div
            ref="volumeEl"
            class="hv-volume-slider"
            role="slider"
            tabindex="0"
            :aria-label="t('videoPlayer.volume')"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="muted ? 0 : Math.round(volume * 100)"
            :aria-valuetext="`${muted ? 0 : Math.round(volume * 100)}%`"
            :style="{ '--v': muted ? 0 : volume }"
            @pointerdown="onVolumeDown"
          >
            <div class="hv-track"><div class="hv-fill hv-fill--volume"></div></div>
            <div class="hv-thumb-rail hv-thumb-rail--volume" aria-hidden="true"><span class="hv-thumb"></span></div>
          </div>
        </div>

        <button
          type="button"
          class="hv-chip"
          :aria-label="t('videoPlayer.speed', { rate: rateText })"
          data-testid="video-speed"
          @click="cycleRate"
        >{{ rateText }}×</button>

        <button
          v-if="pipSupported"
          type="button"
          class="hv-btn hv-btn--pip"
          :aria-label="pipActive ? t('videoPlayer.exitPip') : t('videoPlayer.pip')"
          @click="togglePip"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2.5" class="hv-stroke" />
            <rect x="12" y="11" width="7" height="6" rx="1.2" />
          </svg>
        </button>

        <button
          type="button"
          class="hv-btn"
          :aria-label="fullscreen ? t('videoPlayer.exitFullscreen') : t('videoPlayer.fullscreen')"
          data-testid="video-fullscreen"
          @click="toggleFullscreen"
        >
          <svg v-if="fullscreen" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" class="hv-stroke" /></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" class="hv-stroke" /></svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useT } from '@/composables/useT'

defineProps<{
  /** Accessible name of the player, e.g. the file name. */
  label?: string
}>()

const { t } = useT()

// Host widths below which the dock drops controls: picture in picture under NARROW; speed,
// total time and the volume slider under COMPACT; the current time under TINY.
const NARROW_WIDTH = 380
const COMPACT_WIDTH = 320
const TINY_WIDTH = 220
const IDLE_MS = 2200
const SEEK_STEP = 5
const SEEK_JUMP = 10
const RATES = [1, 1.25, 1.5, 2, 0.5, 0.75]
const VOLUME_KEY = 'harmony:video-volume'

const rootEl = ref<HTMLElement | null>(null)
const seekEl = ref<HTMLElement | null>(null)
const volumeEl = ref<HTMLElement | null>(null)
const tipEl = ref<HTMLElement | null>(null)
const currentEl = ref<HTMLElement | null>(null)

const video = shallowRef<HTMLVideoElement | null>(null)
const host = shallowRef<HTMLElement | null>(null)

const playing = ref(false)
const started = ref(false)
const ended = ref(false)
const waiting = ref(false)
const duration = ref(0)
const second = ref(0)
const muted = ref(false)
const volume = ref(1)
const rate = ref(1)
const fullscreen = ref(false)
const pipActive = ref(false)
const idle = ref(false)
const scrubbing = ref(false)
const narrow = ref(false)
const compact = ref(false)
const tiny = ref(false)

const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled === true
const rateText = computed(() => String(rate.value))

const formatTime = (value: number): string => {
  const total = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

// --- Saved volume ---------------------------------------------------------------------
interface SavedVolume { volume: number; muted: boolean }
const readSavedVolume = (): SavedVolume | null => {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedVolume>
    if (typeof parsed.volume !== 'number' || parsed.volume < 0 || parsed.volume > 1) return null
    return { volume: parsed.volume, muted: parsed.muted === true }
  } catch {
    return null
  }
}
const saveVolume = () => {
  try { localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume: volume.value, muted: muted.value })) } catch { /* storage unavailable */ }
}

// --- Per-frame writes ------------------------------------------------------------------
let frame = 0
let lastSecond = -1

const writeProgress = (time: number) => {
  const v = video.value
  const d = v && Number.isFinite(v.duration) ? v.duration : duration.value
  const p = d > 0 ? Math.min(1, Math.max(0, time / d)) : 0
  seekEl.value?.style.setProperty('--p', String(p))
  const whole = Math.floor(time)
  if (whole !== lastSecond) {
    lastSecond = whole
    second.value = whole
    if (currentEl.value) currentEl.value.textContent = formatTime(time)
  }
}

const writeBuffered = () => {
  const v = video.value
  if (!v || !seekEl.value) return
  const d = v.duration
  let end = 0
  if (Number.isFinite(d) && d > 0) {
    // The range holding the playhead; ranges ahead of a seek gap are not yet playable.
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i))
    }
    end /= d
  }
  seekEl.value.style.setProperty('--b', String(Math.min(1, end)))
}

const tick = () => {
  frame = 0
  const v = video.value
  if (!v) return
  if (!scrubbing.value) writeProgress(v.currentTime)
  if (!v.paused && !v.ended) frame = requestAnimationFrame(tick)
}
const startLoop = () => { if (!frame) frame = requestAnimationFrame(tick) }
const stopLoop = () => { if (frame) cancelAnimationFrame(frame); frame = 0 }

// --- Video adoption and media events --------------------------------------------------
const syncFromVideo = (v: HTMLVideoElement) => {
  playing.value = !v.paused && !v.ended
  ended.value = v.ended
  started.value = started.value || v.currentTime > 0 || playing.value
  duration.value = Number.isFinite(v.duration) ? v.duration : 0
  muted.value = v.muted
  volume.value = v.volume
  rate.value = v.playbackRate
  writeProgress(v.currentTime)
  writeBuffered()
  if (playing.value) startLoop()
}

const adopt = (v: HTMLVideoElement) => {
  if (video.value === v) return
  video.value = v
  v.controls = false
  syncFromVideo(v)
}

const onMedia = (event: Event) => {
  const v = event.target
  if (!(v instanceof HTMLVideoElement) || !host.value?.contains(v)) return
  adopt(v)
  switch (event.type) {
    case 'play':
    case 'playing':
      playing.value = true
      started.value = true
      ended.value = false
      if (event.type === 'playing') waiting.value = false
      scheduleIdle()
      startLoop()
      break
    case 'pause':
      playing.value = false
      showControls()
      writeProgress(v.currentTime)
      break
    case 'ended':
      playing.value = false
      ended.value = true
      showControls()
      writeProgress(v.duration)
      break
    case 'waiting':
      waiting.value = true
      break
    case 'canplay':
      waiting.value = false
      break
    case 'loadedmetadata':
    case 'durationchange':
      duration.value = Number.isFinite(v.duration) ? v.duration : 0
      writeProgress(v.currentTime)
      writeBuffered()
      break
    case 'progress':
      writeBuffered()
      break
    case 'seeked':
    case 'timeupdate':
      if (!scrubbing.value && !frame) writeProgress(v.currentTime)
      if (event.type === 'seeked') writeBuffered()
      break
    case 'volumechange':
      muted.value = v.muted
      volume.value = v.volume
      break
    case 'ratechange':
      rate.value = v.playbackRate
      break
    case 'enterpictureinpicture':
      pipActive.value = true
      break
    case 'leavepictureinpicture':
      pipActive.value = false
      break
  }
}

const MEDIA_EVENTS = [
  'play', 'playing', 'pause', 'ended', 'waiting', 'canplay', 'loadedmetadata', 'durationchange',
  'progress', 'seeked', 'timeupdate', 'volumechange', 'ratechange',
  'enterpictureinpicture', 'leavepictureinpicture',
] as const

// --- Idle chrome -----------------------------------------------------------------------
let idleTimer: ReturnType<typeof setTimeout> | null = null
const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null }
const showControls = () => { clearIdle(); idle.value = false }
const scheduleIdle = () => {
  clearIdle()
  idleTimer = setTimeout(() => {
    idleTimer = null
    const focusInside = !!rootEl.value?.contains(document.activeElement) && rootEl.value !== document.activeElement
    if (playing.value && !scrubbing.value && !focusInside) idle.value = true
  }, IDLE_MS)
}
const wake = () => {
  idle.value = false
  if (playing.value) scheduleIdle()
}
const onPointerMove = (event: PointerEvent) => {
  if (event.pointerType === 'mouse') wake()
}
const onPointerLeave = (event: PointerEvent) => {
  if (event.pointerType === 'mouse' && playing.value && !scrubbing.value) {
    clearIdle()
    idle.value = true
  }
}

// --- Commands --------------------------------------------------------------------------
const play = () => {
  const v = video.value
  if (!v) return
  if (v.ended) v.currentTime = 0
  void v.play().catch(() => {
    // Autoplay policy refused sound: play muted rather than not at all.
    if (!v.muted) {
      v.muted = true
      void v.play().catch(() => {})
    }
  })
}
const pause = () => video.value?.pause()
const togglePlay = () => {
  const v = video.value
  if (!v) return
  if (v.paused || v.ended) play()
  else pause()
}

const seekTo = (time: number) => {
  const v = video.value
  if (!v) return
  const d = Number.isFinite(v.duration) ? v.duration : 0
  const target = Math.min(Math.max(0, time), d || 0)
  if (scrubbing.value && typeof v.fastSeek === 'function') v.fastSeek(target)
  else v.currentTime = target
  if (ended.value && target < d) ended.value = false
  writeProgress(target)
}
const seekBy = (delta: number) => {
  const v = video.value
  if (v) seekTo(v.currentTime + delta)
}

const setVolume = (value: number) => {
  const v = video.value
  if (!v) return
  const next = Math.min(1, Math.max(0, value))
  v.volume = next
  v.muted = next === 0
  volume.value = next
  muted.value = v.muted
  saveVolume()
}
const toggleMute = () => {
  const v = video.value
  if (!v) return
  if (v.muted || v.volume === 0) {
    v.muted = false
    if (v.volume === 0) v.volume = 0.5
  } else {
    v.muted = true
  }
  muted.value = v.muted
  volume.value = v.volume
  saveVolume()
}

const cycleRate = () => {
  const v = video.value
  if (!v) return
  const next = RATES[(RATES.indexOf(v.playbackRate) + 1) % RATES.length] ?? 1
  v.playbackRate = next
  rate.value = next
}

const togglePip = async () => {
  const v = video.value
  if (!v || !pipSupported) return
  try {
    if (document.pictureInPictureElement === v) await document.exitPictureInPicture()
    else await v.requestPictureInPicture()
  } catch { /* refused: not playing yet, or disabled */ }
}

type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void }
const toggleFullscreen = async () => {
  const el = host.value
  const v = video.value as WebkitVideo | null
  if (!el || !v) return
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
    } else if (typeof el.requestFullscreen === 'function') {
      await el.requestFullscreen()
    } else if (typeof v.webkitEnterFullscreen === 'function') {
      // iOS Safari: only the video element itself goes fullscreen, with the system player.
      v.webkitEnterFullscreen()
    }
  } catch { /* refused */ }
}
const onFullscreenChange = () => {
  fullscreen.value = !!host.value && document.fullscreenElement === host.value
  wake()
}

// --- Pointer: hit area, seek and volume sliders ----------------------------------------
// A tap shows hidden chrome first; with the chrome up it plays or pauses.
const lastPointer = ref('mouse')
const onHitClick = () => {
  if (lastPointer.value === 'touch' && idle.value) {
    wake()
    return
  }
  togglePlay()
  wake()
}

const ratioAt = (el: HTMLElement, clientX: number): number => {
  const box = el.getBoundingClientRect()
  return box.width > 0 ? Math.min(1, Math.max(0, (clientX - box.left) / box.width)) : 0
}

let resumeAfterScrub = false
let pendingSeek = 0
let seekFrame = 0
const flushSeek = () => {
  seekFrame = 0
  seekTo(pendingSeek)
}
const queueSeek = (time: number) => {
  pendingSeek = time
  if (!seekFrame) seekFrame = requestAnimationFrame(flushSeek)
}

const onSeekDown = (event: PointerEvent) => {
  const el = seekEl.value
  const v = video.value
  if (!el || !v || event.button !== 0) return
  event.preventDefault()
  el.setPointerCapture(event.pointerId)
  el.focus({ preventScroll: true })
  scrubbing.value = true
  showControls()
  resumeAfterScrub = !v.paused
  if (resumeAfterScrub) v.pause()
  const d = Number.isFinite(v.duration) ? v.duration : 0
  const move = (e: PointerEvent) => {
    const time = ratioAt(el, e.clientX) * d
    el.style.setProperty('--p', String(d > 0 ? time / d : 0))
    showTip(e.clientX, time)
    queueSeek(time)
  }
  const up = (e: PointerEvent) => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    if (seekFrame) { cancelAnimationFrame(seekFrame); seekFrame = 0 }
    scrubbing.value = false
    seekTo(ratioAt(el, e.clientX) * d)
    if (resumeAfterScrub) play()
    else showControls()
    hideTip()
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  move(event)
}

const showTip = (clientX: number, time: number) => {
  const el = seekEl.value
  const tip = tipEl.value
  if (!el || !tip) return
  const box = el.getBoundingClientRect()
  tip.textContent = formatTime(time)
  const half = tip.offsetWidth / 2
  const x = Math.min(Math.max(clientX - box.left, half), box.width - half)
  tip.style.transform = `translateX(${x - half}px)`
  el.style.setProperty('--h', String(box.width > 0 ? (clientX - box.left) / box.width : 0))
  el.classList.add('hv-seek--hover')
}
const hideTip = () => {
  seekEl.value?.classList.remove('hv-seek--hover')
}
const onSeekHover = (event: PointerEvent) => {
  if (scrubbing.value || event.pointerType !== 'mouse' || !seekEl.value) return
  const v = video.value
  const d = v && Number.isFinite(v.duration) ? v.duration : 0
  showTip(event.clientX, ratioAt(seekEl.value, event.clientX) * d)
}
const onSeekLeave = () => { if (!scrubbing.value) hideTip() }

const onVolumeDown = (event: PointerEvent) => {
  const el = volumeEl.value
  if (!el || event.button !== 0) return
  event.preventDefault()
  el.setPointerCapture(event.pointerId)
  el.focus({ preventScroll: true })
  const move = (e: PointerEvent) => setVolume(ratioAt(el, e.clientX))
  const up = (e: PointerEvent) => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
  move(event)
}

// --- Keyboard --------------------------------------------------------------------------
const onKeydown = (event: KeyboardEvent) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const v = video.value
  if (!v) return
  const target = event.target as HTMLElement
  const onButton = target.tagName === 'BUTTON'
  const onVolume = target === volumeEl.value
  let handled = true
  switch (event.key) {
    case ' ':
    case 'Enter':
      if (onButton) { handled = false; break }
      togglePlay()
      break
    case 'k':
    case 'K':
      togglePlay()
      break
    case 'ArrowLeft':
      if (onVolume) setVolume(v.volume - 0.05)
      else seekBy(-SEEK_STEP)
      break
    case 'ArrowRight':
      if (onVolume) setVolume(v.volume + 0.05)
      else seekBy(SEEK_STEP)
      break
    case 'j':
    case 'J':
      seekBy(-SEEK_JUMP)
      break
    case 'l':
    case 'L':
      seekBy(SEEK_JUMP)
      break
    case 'ArrowUp':
      setVolume((v.muted ? 0 : v.volume) + 0.05)
      break
    case 'ArrowDown':
      setVolume((v.muted ? 0 : v.volume) - 0.05)
      break
    case 'Home':
      seekTo(0)
      break
    case 'End':
      seekTo(v.duration)
      break
    case 'm':
    case 'M':
      toggleMute()
      break
    case 'f':
    case 'F':
      void toggleFullscreen()
      break
    default:
      if (/^[0-9]$/.test(event.key) && Number.isFinite(v.duration)) seekTo((Number(event.key) / 10) * v.duration)
      else handled = false
  }
  if (handled) {
    event.preventDefault()
    // Keys the player used do not also navigate an enclosing list or lightbox.
    event.stopPropagation()
    wake()
  }
}

// --- Lifecycle -------------------------------------------------------------------------
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  const el = rootEl.value?.parentElement ?? null
  host.value = el
  if (!el) return
  el.classList.add('hv-host')
  for (const type of MEDIA_EVENTS) el.addEventListener(type, onMedia, true)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  const v = el.querySelector('video')
  if (v) {
    const saved = readSavedVolume()
    // A video the parent mutes (looping clips) stays muted.
    if (saved && !v.muted) {
      v.volume = saved.volume
      v.muted = saved.muted
    }
    adopt(v)
  }
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(([entry]) => {
      narrow.value = entry.contentRect.width < NARROW_WIDTH
      compact.value = entry.contentRect.width < COMPACT_WIDTH
      tiny.value = entry.contentRect.width < TINY_WIDTH
    })
    resizeObserver.observe(el)
  }
})

onBeforeUnmount(() => {
  stopLoop()
  clearIdle()
  if (seekFrame) cancelAnimationFrame(seekFrame)
  const el = host.value
  if (el) {
    for (const type of MEDIA_EVENTS) el.removeEventListener(type, onMedia, true)
    el.classList.remove('hv-host')
  }
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  resizeObserver?.disconnect()
})

defineExpose({ togglePlay, seekTo })
</script>

<style>
/* Host rules are global: the host belongs to the parent component. */
.hv-host:fullscreen {
  display: flex !important;
  align-items: center;
  justify-content: center;
  background: #000;
  max-width: none !important;
  max-height: none !important;
}

/* Fullscreen lifts the parent's layout caps on the video. */
.hv-host:fullscreen > video {
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  max-height: none !important;
  object-fit: contain !important;
  border-radius: 0 !important;
}
</style>

<style scoped>
.hv {
  --hv-accent: var(--harmony-primary, #0ea5e9);
  --hv-glass: rgb(12 14 20 / 0.76);
  --hv-edge: rgb(255 255 255 / 0.1);
  --hv-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --hv-inset: 8px;
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  border-radius: inherit;
  color: #fff;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  font-variant-numeric: tabular-nums;
}

/* Bottom shade under the dock for contrast on bright frames. */
.hv::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 96px;
  background: linear-gradient(to top, rgb(0 0 0 / 0.42), rgb(0 0 0 / 0));
  pointer-events: none;
  opacity: 1;
  transition: opacity 240ms ease;
}

.hv:not(.hv--started)::after,
.hv--idle::after {
  opacity: 0;
}

.hv-hit {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  cursor: pointer;
}

.hv--fullscreen.hv--idle .hv-hit {
  cursor: none;
}

/* --- Big play ------------------------------------------------------------------- */
.hv-big {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 1;
  width: 64px;
  height: 64px;
  margin: -32px 0 0 -32px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: var(--hv-accent);
  color: #fff;
  pointer-events: auto;
  cursor: pointer;
  box-shadow:
    0 0 0 6px color-mix(in srgb, var(--hv-accent) 28%, transparent),
    0 10px 30px rgb(0 0 0 / 0.45);
  transition: transform 180ms var(--hv-ease), box-shadow 180ms ease;
}

/* The play triangle's centroid is the viewBox centre (12, 12): no offset. */
.hv-big svg {
  width: 28px;
  height: 28px;
  fill: currentColor;
}

.hv-big:hover {
  transform: scale(1.07);
  box-shadow:
    0 0 0 9px color-mix(in srgb, var(--hv-accent) 32%, transparent),
    0 12px 34px rgb(0 0 0 / 0.5);
}

.hv-big:active {
  transform: scale(0.96);
}

/* Paused mid-clip: a quieter glass button, the dock still shows the accent key. */
.hv--started .hv-big {
  width: 56px;
  height: 56px;
  margin: -28px 0 0 -28px;
  background: var(--hv-glass);
  border: 1px solid var(--hv-edge);
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.45);
}

.hv--started .hv-big:hover {
  background: var(--hv-accent);
  border-color: transparent;
}

/* --- Spinner -------------------------------------------------------------------- */
.hv-spinner {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 40px;
  height: 40px;
  margin: -20px 0 0 -20px;
  border-radius: 50%;
  border: 3px solid rgb(255 255 255 / 0.2);
  border-top-color: var(--hv-accent);
  animation: hv-spin 0.75s linear infinite;
}

@keyframes hv-spin {
  to { transform: rotate(360deg); }
}

/* --- Dock: accent play key and the control pill ------------------------------------ */
.hv-dock {
  position: absolute;
  left: var(--hv-inset);
  right: var(--hv-inset);
  bottom: var(--hv-inset);
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: auto;
  opacity: 1;
  transform: translateY(0);
  transition: opacity 200ms ease, transform 260ms var(--hv-ease);
  will-change: opacity, transform;
}

/* Before the first play the dock waits for the pointer or focus. */
.hv:not(.hv--started) .hv-dock {
  opacity: 0;
  transform: translateY(8px);
}

.hv:not(.hv--started):hover .hv-dock,
.hv:not(.hv--started):focus-within .hv-dock {
  opacity: 1;
  transform: none;
}

.hv--idle .hv-dock {
  opacity: 0;
  transform: translateY(10px);
  pointer-events: none;
}

.hv-play {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: 11px;
  background: var(--hv-accent);
  color: #fff;
  cursor: pointer;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--hv-accent) 45%, transparent);
  transition: transform 140ms var(--hv-ease), filter 140ms ease;
}

.hv-play svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
}

.hv-play:hover {
  filter: brightness(1.1);
}

.hv-play:active {
  transform: scale(0.93);
}

.hv-pill {
  flex: 1;
  min-width: 0;
  height: 36px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--hv-edge);
  border-radius: 11px;
  background: var(--hv-glass);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
}

.hv-time {
  flex: none;
  min-width: 30px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  color: rgb(255 255 255 / 0.95);
}

.hv-time--total {
  margin-right: 2px;
  text-align: right;
  color: rgb(255 255 255 / 0.55);
}

.hv-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: rgb(255 255 255 / 0.9);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, transform 120ms var(--hv-ease);
}

.hv-btn svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
}

.hv-stroke {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.hv-btn:hover {
  background: rgb(255 255 255 / 0.12);
  color: #fff;
}

.hv-btn:active {
  transform: scale(0.9);
}

.hv-chip {
  flex: none;
  height: 22px;
  min-width: 34px;
  margin: 0 3px;
  padding: 0 6px;
  border: 1px solid rgb(255 255 255 / 0.2);
  border-radius: 6px;
  background: transparent;
  color: rgb(255 255 255 / 0.9);
  font: inherit;
  font-size: 11px;
  font-weight: 700;
  line-height: 20px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.hv-chip:hover {
  background: rgb(255 255 255 / 0.12);
  border-color: rgb(255 255 255 / 0.35);
}

.hv-play:focus-visible,
.hv-btn:focus-visible,
.hv-chip:focus-visible,
.hv-seek:focus-visible,
.hv-volume-slider:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 1px;
}

/* --- Sliders: --p played, --b buffered, --h hover, --v volume, each 0..1 -------- */
.hv-seek,
.hv-volume-slider {
  position: relative;
  touch-action: none;
  cursor: pointer;
}

.hv-seek {
  --p: 0;
  --b: 0;
  --h: 0;
  flex: 1;
  min-width: 48px;
  height: 28px;
  margin: 0 8px;
  display: flex;
  align-items: center;
}

.hv-track {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: 999px;
  background: rgb(255 255 255 / 0.18);
  overflow: hidden;
  transition: height 140ms var(--hv-ease);
}

.hv-seek:hover .hv-track,
.hv--scrubbing .hv-seek .hv-track,
.hv-seek:focus-visible .hv-track {
  height: 6px;
}

.hv-fill {
  position: absolute;
  inset: 0;
  transform-origin: left center;
  border-radius: inherit;
}

.hv-fill--buffered {
  background: rgb(255 255 255 / 0.22);
  transform: scaleX(var(--b));
}

.hv-fill--hover {
  background: rgb(255 255 255 / 0.22);
  transform: scaleX(var(--h));
  opacity: 0;
  transition: opacity 120ms ease;
}

.hv-seek--hover .hv-fill--hover {
  opacity: 1;
}

.hv-fill--played {
  background: linear-gradient(90deg, var(--hv-accent), color-mix(in srgb, var(--hv-accent) 55%, #fff));
  transform: scaleX(var(--p));
}

/* Full-width rail moved by the fraction: translateX % is of the rail's own width. */
.hv-thumb-rail {
  position: absolute;
  inset: 0;
  pointer-events: none;
  transform: translateX(calc(var(--p) * 100%));
}

.hv-thumb {
  position: absolute;
  left: -6px;
  top: 50%;
  width: 12px;
  height: 12px;
  margin-top: -6px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--hv-accent) 40%, transparent), 0 2px 6px rgb(0 0 0 / 0.45);
  transform: scale(0);
  transition: transform 140ms var(--hv-ease);
}

.hv-seek:hover .hv-thumb,
.hv--scrubbing .hv-seek .hv-thumb,
.hv-seek:focus-visible .hv-thumb {
  transform: scale(1);
}

.hv-tip {
  position: absolute;
  left: 0;
  bottom: 30px;
  padding: 4px 8px;
  border: 1px solid var(--hv-edge);
  border-radius: 7px;
  background: var(--hv-glass);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 120ms ease;
  box-shadow: 0 6px 16px rgb(0 0 0 / 0.35);
}

.hv-seek--hover .hv-tip {
  opacity: 1;
}

/* --- Volume --------------------------------------------------------------------- */
.hv-volume {
  flex: none;
  display: flex;
  align-items: center;
}

.hv-volume-slider {
  --v: 1;
  width: 0;
  height: 28px;
  display: flex;
  align-items: center;
  opacity: 0;
  overflow: hidden;
  transition: width 200ms var(--hv-ease), opacity 160ms ease, margin 200ms var(--hv-ease);
}

.hv-volume:hover .hv-volume-slider,
.hv-volume:focus-within .hv-volume-slider {
  width: 56px;
  margin: 0 8px 0 4px;
  opacity: 1;
  overflow: visible;
}

.hv-fill--volume {
  background: #fff;
  transform: scaleX(var(--v));
}

.hv-thumb-rail--volume {
  transform: translateX(calc(var(--v) * 100%));
}

.hv-volume-slider .hv-thumb {
  transform: scale(1);
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.45);
}

/* --- Narrow hosts --------------------------------------------------------------- */
.hv--compact {
  --hv-inset: 6px;
}

.hv--narrow .hv-btn--pip,
.hv--compact .hv-volume-slider,
.hv--compact .hv-chip,
.hv--compact .hv-time--total {
  display: none;
}

.hv--compact .hv-seek {
  margin: 0 6px;
}

.hv--compact .hv-big {
  width: 52px;
  height: 52px;
  margin: -26px 0 0 -26px;
}

.hv--compact .hv-big svg {
  width: 24px;
  height: 24px;
}

.hv--tiny .hv-big {
  width: 44px;
  height: 44px;
  margin: -22px 0 0 -22px;
}

.hv--tiny .hv-time {
  display: none;
}

.hv--tiny .hv-pill {
  padding-left: 4px;
}

.hv--tiny .hv-play {
  width: 32px;
  height: 32px;
  border-radius: 10px;
}

.hv--tiny .hv-pill {
  height: 32px;
  border-radius: 10px;
}

/* --- Fullscreen ----------------------------------------------------------------- */
.hv--fullscreen {
  --hv-inset: 24px;
}

.hv--fullscreen .hv-dock {
  max-width: 960px;
  margin: 0 auto;
  gap: 8px;
}

.hv--fullscreen .hv-play,
.hv--fullscreen .hv-pill {
  height: 46px;
  border-radius: 14px;
}

.hv--fullscreen .hv-play {
  width: 46px;
}

.hv--fullscreen .hv-btn {
  width: 36px;
  height: 36px;
}

.hv--fullscreen .hv-btn svg {
  width: 22px;
  height: 22px;
}

.hv--fullscreen .hv-time {
  font-size: 13px;
}

@media (hover: none) {
  .hv-volume-slider { display: none; }
  .hv-thumb { transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .hv,
  .hv *,
  .hv::after {
    transition: none !important;
  }
  .hv-spinner {
    animation-duration: 2.4s;
  }
}
</style>
