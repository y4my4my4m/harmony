<template>
  <div class="voice-player" :class="{ playing: isPlaying }">
    <button class="play-btn" @click="togglePlay">
      <svg v-if="!isPlaying" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
        <rect x="6" y="4" width="4" height="16"/>
        <rect x="14" y="4" width="4" height="16"/>
      </svg>
    </button>

    <div class="player-body" ref="waveformContainer" @click="seek">
      <div class="waveform-track">
        <div
          v-for="(bar, i) in displayWaveform"
          :key="i"
          class="waveform-bar"
          :class="{ played: i / displayWaveform.length <= progress }"
          :style="{ height: bar + '%' }"
        />
      </div>
      <div class="time-row">
        <span class="time-current">{{ formattedCurrentTime }}</span>
        <button class="speed-btn" @click.stop="cycleSpeed">{{ playbackSpeed }}x</button>
        <span class="time-total">{{ formattedDuration }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'

interface Props {
  src: string
  duration?: number
  waveform?: number[]
}

const props = withDefaults(defineProps<Props>(), {
  duration: 0,
  waveform: () => [],
})

const DISPLAY_BARS = 48
const SPEEDS = [1, 1.5, 2]

const audio = ref<HTMLAudioElement | null>(null)
const isPlaying = ref(false)
const currentTime = ref(0)
const audioDuration = ref(props.duration)
const playbackSpeed = ref(1)

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

const togglePlay = () => {
  if (!audio.value) return
  if (isPlaying.value) {
    audio.value.pause()
  } else {
    audio.value.play()
  }
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

onMounted(() => {
  const el = new Audio(props.src)
  el.preload = 'metadata'
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
  if (audio.value) {
    audio.value.pause()
    audio.value.src = newSrc
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

.play-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: var(--harmony-primary, #0EA5E9);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s ease, transform 0.12s ease;
  box-shadow: 0 2px 8px rgba(14, 165, 233, 0.25);
}

.play-btn:hover {
  background: var(--harmony-primary-hover, #0284C7);
  transform: scale(1.06);
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
  background: rgba(255, 255, 255, 0.18);
  transition: background 0.1s ease, height 0.15s ease;
}

.waveform-bar.played {
  background: var(--harmony-primary, #0EA5E9);
}

.time-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-secondary, #94a3b8);
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
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-secondary, #94a3b8);
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
  letter-spacing: 0.02em;
}

.speed-btn:hover {
  background: rgba(255, 255, 255, 0.14);
  color: var(--text-primary, #e2e8f0);
}
</style>
