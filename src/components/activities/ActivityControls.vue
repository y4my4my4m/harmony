<!-- Shared controls of the call's activity: play/pause, seek, time, volume, queue, host lock,
     stop (compact form). Every change goes to the row; the player follows. -->
<template>
  <div class="activity-controls" :class="{ compact }" data-testid="activity-controls">
    <button
      type="button"
      class="activity-controls__play"
      :disabled="!canControl || actStore.busy"
      :aria-label="activity.playing ? t('activities.pause') : t('activities.play')"
      data-testid="activity-play"
      @click="actStore.togglePlay()"
    >
      <Icon :name="activity.playing ? 'pause' : 'play'" :size="compact ? 16 : 18" />
    </button>

    <span class="activity-controls__time" aria-hidden="true">{{ clock(position) }}</span>
    <div
      ref="track"
      class="activity-controls__seek"
      role="slider"
      tabindex="0"
      :aria-label="t('activities.seek')"
      aria-valuemin="0"
      :aria-valuemax="Math.round(duration / 1000)"
      :aria-valuenow="Math.round(position / 1000)"
      :aria-valuetext="t('activities.seekValue', { position: clock(position), duration: clock(duration) })"
      :aria-disabled="!canControl || duration <= 0"
      :style="{ '--p': duration > 0 ? Math.min(1, position / duration) : 0 }"
      data-testid="activity-seek"
      @pointerdown="startScrub"
      @keydown="onSeekKey"
    >
      <span class="activity-controls__rail"><span class="activity-controls__fill" /></span>
      <span class="activity-controls__thumb" />
    </div>
    <span class="activity-controls__time activity-controls__time--total" aria-hidden="true">{{ duration > 0 ? clock(duration) : '–:––' }}</span>

    <div v-if="!compact" class="activity-controls__volume">
      <button type="button" class="activity-controls__btn" :aria-label="actStore.muted ? t('activities.unmute') : t('activities.mute')" @click="actStore.muted = !actStore.muted">
        <Icon :name="actStore.muted || actStore.volume === 0 ? 'volume-off' : 'volume-2'" :size="16" />
      </button>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="actStore.muted ? 0 : actStore.volume"
        :aria-label="t('activities.volume')"
        class="activity-controls__range"
        @input="actStore.setVolume(Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <slot name="extra" />

    <button
      v-if="!compact && isHost"
      type="button"
      class="activity-controls__btn"
      :aria-pressed="activity.controls === 'host'"
      :title="activity.controls === 'host' ? t('activities.controlsEveryone') : t('activities.controlsHost')"
      :aria-label="activity.controls === 'host' ? t('activities.controlsEveryone') : t('activities.controlsHost')"
      data-testid="activity-host-lock"
      @click="actStore.control({ action: 'controls', mode: activity.controls === 'host' ? 'everyone' : 'host' })"
    >
      <Icon :name="activity.controls === 'host' ? 'lock' : 'unlock'" :size="16" />
    </button>
    <button
      v-if="!compact"
      type="button"
      class="activity-controls__btn"
      :disabled="!canControl || activity.queue.length === 0"
      :title="t('activities.next')"
      :aria-label="t('activities.next')"
      data-testid="activity-next"
      @click="actStore.control({ action: 'next' })"
    >
      <Icon name="skip-forward" :size="16" />
    </button>
    <!-- The stage names this in its header; the dock card has room for the icon only. -->
    <button
      v-if="compact"
      type="button"
      class="activity-controls__btn activity-controls__btn--stop"
      :disabled="!canControl"
      :title="t('activities.stop')"
      :aria-label="t('activities.stop')"
      data-testid="activity-stop"
      @click="actStore.stop()"
    >
      <Icon name="x" :size="16" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { useActivitiesStore } from '@/stores/activities'
import type { VoiceActivity } from '@/services/activities/activityService'
import { useActivityControl } from './useActivityControl'

const props = withDefaults(defineProps<{ activity: VoiceActivity; compact?: boolean }>(), { compact: false })

const { t } = useT()
const actStore = useActivitiesStore()
const track = ref<HTMLElement | null>(null)
const now = ref(Date.now())
const scrubMs = ref<number | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

const { isHost, canControl } = useActivityControl(() => props.activity)

const duration = computed(() => actStore.status.durationMs || props.activity.item.duration_ms || 0)
const position = computed(() => {
  void now.value
  if (scrubMs.value !== null) return scrubMs.value
  const p = actStore.position()
  return duration.value > 0 ? Math.min(p, duration.value) : p
})

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

function msAt(clientX: number): number {
  const el = track.value
  if (!el || duration.value <= 0) return 0
  const r = el.getBoundingClientRect()
  return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration.value
}

function startScrub(event: PointerEvent): void {
  if (!canControl.value || duration.value <= 0) return
  const el = track.value
  if (!el) return
  el.setPointerCapture(event.pointerId)
  scrubMs.value = msAt(event.clientX)
  const move = (e: PointerEvent) => { scrubMs.value = msAt(e.clientX) }
  const up = (e: PointerEvent) => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
    const target = msAt(e.clientX)
    void actStore.seek(target).finally(() => { scrubMs.value = null })
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}

function onSeekKey(event: KeyboardEvent): void {
  if (!canControl.value) return
  const step = event.shiftKey ? 30_000 : 5_000
  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); void actStore.seek(position.value + step) }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); void actStore.seek(position.value - step) }
  else if (event.key === 'Home') { event.preventDefault(); void actStore.seek(0) }
  else if (event.key === ' ' || event.key === 'k') { event.preventDefault(); void actStore.togglePlay() }
}

onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 250) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.activity-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  color: var(--text-primary);
}

.activity-controls__play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  background: var(--harmony-primary-fill, var(--harmony-primary));
  border: none;
  border-radius: var(--radius-full);
  color: var(--text-on-primary, #fff);
  cursor: pointer;
  transition: transform 0.12s ease, background-color 0.12s ease;
}

.activity-controls.compact .activity-controls__play {
  width: 30px;
  height: 30px;
}

.activity-controls__play:hover:not(:disabled) {
  transform: scale(1.05);
}

.activity-controls__play:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.activity-controls__time {
  flex-shrink: 0;
  min-width: 34px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

.activity-controls__time--total {
  text-align: right;
}

.activity-controls__seek {
  position: relative;
  flex: 1;
  min-width: 60px;
  height: 20px;
  cursor: pointer;
  touch-action: none;
  outline: none;
}

.activity-controls__seek[aria-disabled='true'] {
  cursor: default;
}

.activity-controls__rail {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: 4px;
  overflow: hidden;
  background: var(--background-modifier-active);
  border-radius: 2px;
  transform: translateY(-50%);
}

.activity-controls__fill {
  position: absolute;
  inset: 0;
  background: var(--harmony-primary);
  transform: scaleX(var(--p));
  transform-origin: left center;
}

.activity-controls__thumb {
  position: absolute;
  top: 50%;
  left: calc(var(--p) * 100%);
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
  transform: translate(-50%, -50%) scale(0);
  transition: transform 0.12s ease;
}

.activity-controls__seek:hover .activity-controls__thumb,
.activity-controls__seek:focus-visible .activity-controls__thumb {
  transform: translate(-50%, -50%) scale(1);
}

.activity-controls__seek:focus-visible .activity-controls__rail {
  box-shadow: 0 0 0 2px var(--border-focus);
}

.activity-controls__volume {
  display: flex;
  align-items: center;
  gap: 4px;
}

.activity-controls__range {
  width: 84px;
  accent-color: var(--harmony-primary);
}

.activity-controls__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
}

.activity-controls__btn:hover:not(:disabled),
.activity-controls__btn[aria-pressed='true'] {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.activity-controls__btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.activity-controls__btn--stop:hover:not(:disabled) {
  color: var(--danger);
}

@media (prefers-reduced-motion: reduce) {
  .activity-controls__play,
  .activity-controls__thumb { transition: none; }
}
</style>
