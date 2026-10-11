<template>
  <div class="voice-player" :class="{ playing: isPlaying }" role="group" :aria-label="t('voiceMessage.label')">
    <button
      class="play-btn"
      type="button"
      :aria-label="isPlaying ? t('voiceMessage.pause') : t('voiceMessage.play', { duration: formattedDuration })"
      :disabled="!src"
      @click="togglePlay"
    >
      <svg v-if="!isPlaying" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
        <rect x="6" y="4" width="4" height="16"/>
        <rect x="14" y="4" width="4" height="16"/>
      </svg>
    </button>

    <div
      class="player-body"
      ref="waveformContainer"
      role="slider"
      tabindex="0"
      :aria-label="t('voiceMessage.position')"
      aria-valuemin="0"
      :aria-valuemax="Math.round(audioDuration)"
      :aria-valuenow="Math.round(currentTime)"
      :aria-valuetext="t('voiceMessage.positionValue', { current: formattedCurrentTime, total: formattedDuration })"
      @click="seek"
      @keydown="onSeekKey"
    >
      <div class="waveform-track" aria-hidden="true">
        <div
          v-for="(bar, i) in displayWaveform"
          :key="i"
          class="waveform-bar"
          :class="{ played: i / displayWaveform.length <= progress }"
          :style="{ height: bar + '%' }"
        />
      </div>
      <div class="time-row">
        <span class="time-current" aria-hidden="true">{{ formattedCurrentTime }}</span>
        <button
          class="speed-btn"
          type="button"
          :aria-label="t('voiceMessage.speed', { speed: playbackSpeed })"
          @click.stop="cycleSpeed"
          @keydown.stop
        >{{ playbackSpeed }}x</button>
        <span class="time-total" aria-hidden="true">{{ formattedDuration }}</span>
      </div>
    </div>
    <span v-if="failed" class="play-failed" role="alert">{{ t('voiceMessage.playFailed') }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { boostGain, measureClip, voiceMessageContext } from '@/services/voice/voiceMessageLevel'

interface Props {
  /** Absent while a private attachment is being signed. */
  src?: string
  duration?: number
  waveform?: number[]
}

const props = withDefaults(defineProps<Props>(), {
  duration: 0,
  waveform: () => [],
})

const DISPLAY_BARS = 48
const SPEEDS = [1, 1.5, 2]
/** Seconds moved by an arrow key on the position slider. */
const SEEK_STEP = 5

const { t } = useI18n()

const audio = ref<HTMLAudioElement | null>(null)
const isPlaying = ref(false)
const currentTime = ref(0)
const audioDuration = ref(props.duration)
const playbackSpeed = ref(1)
const failed = ref(false)
// Set once the element plays through a GainNode; false after a CORS failure.
let graphTried = false
let gain: GainNode | null = null

const progress = computed(() => {
  if (!audioDuration.value) return 0
  return currentTime.value / audioDuration.value
})

const displayWaveform = computed(() => {
  const raw = Array.isArray(props.waveform) && props.waveform.length > 0
    ? props.waveform
    : new Array(DISPLAY_BARS).fill(0.3)
  const result: number[] = []
  const ratio = raw.length / DISPLAY_BARS

  for (let i = 0; i < DISPLAY_BARS; i++) {
    const idx = Math.floor(i * ratio)
    const val = raw[Math.min(idx, raw.length - 1)] || 0.3
    result.push(Math.max(8, val * 100))
  }
  return result
})

const formattedCurrentTime = computed(() => formatTime(currentTime.value))
const formattedDuration = computed(() => formatTime(audioDuration.value))

function formatTime(seconds: number): string {
  const s = Math.floor(seconds)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

/**
 * Routes the element through a GainNode on first play and raises a quiet clip once its peak is
 * known. Runs inside the click, so the context may start.
 */
function ensureGain(el: HTMLAudioElement, src: string): void {
  if (graphTried) return
  graphTried = true
  if (el.crossOrigin !== 'anonymous') return
  const ctx = voiceMessageContext()
  if (!ctx) return
  try {
    const node = ctx.createMediaElementSource(el)
    gain = ctx.createGain()
    node.connect(gain)
    gain.connect(ctx.destination)
  } catch {
    gain = null
    return
  }
  void ctx.resume().catch(() => {})
  void measureClip(src, ctx).then((clip) => {
    if (!clip) return
    if (gain) gain.gain.value = boostGain(clip.peak)
    if (!audioDuration.value && Number.isFinite(clip.duration)) audioDuration.value = clip.duration
  })
}

const togglePlay = () => {
  if (!audio.value || !props.src) return
  if (isPlaying.value) {
    audio.value.pause()
    return
  }
  ensureGain(audio.value, props.src)
  failed.value = false
  audio.value.play().catch(() => {
    failed.value = true
    isPlaying.value = false
  })
}

const cycleSpeed = () => {
  const idx = SPEEDS.indexOf(playbackSpeed.value)
  playbackSpeed.value = SPEEDS[(idx + 1) % SPEEDS.length]
  if (audio.value) audio.value.playbackRate = playbackSpeed.value
}

const waveformContainer = ref<HTMLElement | null>(null)

const seek = (e: MouseEvent) => {
  if (!audio.value || !waveformContainer.value || !audioDuration.value) return
  const rect = waveformContainer.value.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  audio.value.currentTime = pct * audioDuration.value
}

function seekTo(seconds: number): void {
  if (!audio.value || !audioDuration.value) return
  const target = Math.max(0, Math.min(audioDuration.value, seconds))
  audio.value.currentTime = target
  currentTime.value = target
}

/** Slider keys: arrows step SEEK_STEP s, Page keys a quarter, Home/End the ends, Space/Enter play. */
const onSeekKey = (e: KeyboardEvent) => {
  const step = { ArrowRight: SEEK_STEP, ArrowUp: SEEK_STEP, ArrowLeft: -SEEK_STEP, ArrowDown: -SEEK_STEP } as Record<string, number>
  if (e.key in step) {
    seekTo(currentTime.value + step[e.key])
  } else if (e.key === 'PageUp' || e.key === 'PageDown') {
    seekTo(currentTime.value + (e.key === 'PageUp' ? 1 : -1) * audioDuration.value / 4)
  } else if (e.key === 'Home') {
    seekTo(0)
  } else if (e.key === 'End') {
    seekTo(audioDuration.value)
  } else if (e.key === ' ' || e.key === 'Enter') {
    togglePlay()
  } else {
    return
  }
  e.preventDefault()
}

/**
 * Storage serves voice clips with Access-Control-Allow-Origin: *, so the element loads in CORS
 * mode and may feed a GainNode. A source without CORS headers fails that load; it is reloaded
 * without crossOrigin and plays unboosted.
 */
function load(el: HTMLAudioElement, src: string): void {
  el.crossOrigin = 'anonymous'
  el.src = src
  el.addEventListener('error', () => {
    if (el.crossOrigin === 'anonymous' && !graphTried && el.src) {
      el.removeAttribute('crossorigin')
      el.src = src
      el.load()
    }
  }, { once: true })
}

onMounted(() => {
  const el = new Audio()
  el.preload = 'metadata'
  if (props.src) load(el, props.src)
  audio.value = el

  el.addEventListener('loadedmetadata', () => {
    if (el.duration && isFinite(el.duration)) audioDuration.value = el.duration
  })
  el.addEventListener('timeupdate', () => {
    currentTime.value = el.currentTime
  })
  el.addEventListener('play', () => { isPlaying.value = true })
  el.addEventListener('pause', () => { isPlaying.value = false })
  el.addEventListener('ended', () => {
    isPlaying.value = false
    currentTime.value = 0
  })
})

onUnmounted(() => {
  if (audio.value) {
    audio.value.pause()
    audio.value.src = ''
    audio.value = null
  }
})

watch(() => props.src, (newSrc) => {
  if (audio.value && newSrc) {
    audio.value.pause()
    // An element already wired to a GainNode keeps its CORS mode.
    if (graphTried) {
      audio.value.src = newSrc
    } else {
      load(audio.value, newSrc)
    }
    audio.value.load()
    isPlaying.value = false
    currentTime.value = 0
  }
})
</script>

<style scoped>
.voice-player {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 18px;
  background: var(--bg-secondary, rgba(255, 255, 255, 0.06));
  max-width: 360px;
  min-width: 240px;
  user-select: none;
}

.play-btn:focus-visible,
.speed-btn:focus-visible,
.player-body:focus-visible {
  outline: 2px solid var(--text-primary);
  outline-offset: 2px;
}

.play-btn:disabled {
  opacity: 0.5;
  cursor: progress;
}

.play-failed {
  font-size: var(--font-size-xs, 12px);
  color: var(--error);
}

.play-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s ease;
}

.play-btn:hover {
  background: var(--harmony-primary-hover);
}

.player-body {
  flex: 1;
  min-width: 0;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.waveform-track {
  display: flex;
  align-items: flex-end;
  gap: 1.5px;
  height: 28px;
}

.waveform-bar {
  flex: 1;
  min-width: 2px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--text-primary) 18%, transparent);
  transition: background 0.1s ease, height 0.15s ease;
}

.waveform-bar.played {
  background: var(--harmony-primary);
}

.time-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.time-current,
.time-total {
  min-width: 28px;
}

.time-total {
  text-align: right;
}

.speed-btn {
  border: none;
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
  letter-spacing: 0.02em;
}

.speed-btn:hover {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}
</style>
