<!--
  The one player of the call's activity. It stays mounted while the activity plays and lays
  itself over the element the visible UI registered (stores/activities registerSlot): the
  voice overlay's stage, else the dock card. With no slot, video shows in a corner mini player
  and sound-only activities keep playing unseen. Moving between slots never moves the player
  in the DOM, so frames keep their state.

  Stacking: the player takes the z-index of the slot's root-level stacking ancestor (the voice
  layer, .persistent-voice) and paints after it in tree order (App.vue mounts it next). Panels
  and pickers teleported above that layer cover the player as they cover the call.

  Sync: every TICK_MS the player is brought to the position the row implies at database time
  (position_ms + (now + offset - position_at) * rate). Files drift back through playbackRate
  (±MAX_NUDGE) and seek beyond SEEK_DRIFT_MS; embedded players only seek, past
  EMBED_SEEK_DRIFT_MS and at most once per EMBED_SEEK_COOLDOWN_MS.
-->
<template>
  <div
    v-if="active"
    class="activity-host"
    :class="[`activity-host--${placement}`, { 'is-listen': listen }]"
    :style="boxStyle"
    data-testid="activity-host"
    :data-source="activity!.source"
  >
    <video
      v-if="mediaSource && !listen"
      ref="mediaEl"
      :key="itemKey"
      :src="mediaSource"
      class="activity-host__media"
      playsinline
      preload="auto"
      data-testid="activity-media"
      @loadedmetadata="onMediaMeta"
      @canplay="onCanPlay"
      @waiting="actStore.setStatus({ buffering: true })"
      @playing="actStore.setStatus({ buffering: false, playing: true })"
      @pause="actStore.setStatus({ playing: false })"
      @ended="actStore.itemEnded()"
      @error="actStore.setStatus({ error: 'media' })"
    />
    <audio
      v-else-if="mediaSource && listen"
      ref="mediaEl"
      :key="itemKey"
      :src="mediaSource"
      preload="auto"
      data-testid="activity-media"
      @loadedmetadata="onMediaMeta"
      @canplay="onCanPlay"
      @waiting="actStore.setStatus({ buffering: true })"
      @playing="actStore.setStatus({ buffering: false, playing: true })"
      @pause="actStore.setStatus({ playing: false })"
      @ended="actStore.itemEnded()"
      @error="actStore.setStatus({ error: 'media' })"
    />
    <iframe
      v-else-if="embedded"
      ref="frameEl"
      :key="activity!.source"
      :src="playerPage"
      class="activity-host__frame"
      allow="autoplay *; encrypted-media *; fullscreen *; picture-in-picture"
      referrerpolicy="strict-origin-when-cross-origin"
      :title="activity!.item.title || activity!.source"
      data-testid="activity-frame"
    />
    <div v-if="listen && mediaSource && placement !== 'hidden'" class="activity-host__listen" aria-hidden="true">
      <img v-if="activity!.item.thumbnail" :src="activity!.item.thumbnail" alt="" class="activity-host__art" />
      <span v-else class="activity-host__art activity-host__art--empty"><Icon name="music" :size="34" /></span>
      <span class="activity-host__bars" :class="{ 'is-playing': actStore.status.playing }"><i /><i /><i /><i /><i /></span>
    </div>
    <LiveReactionLayer
      v-if="placement !== 'hidden'"
      user-id=""
      source="activity"
      :compact="placement === 'corner'"
    />
    <div v-if="placement === 'corner'" class="activity-host__corner-actions">
      <button type="button" class="activity-host__expand" :aria-label="t('activities.open')" :title="t('activities.open')" @click="openStage">
        <Icon name="maximize-2" :size="15" />
      </button>
      <button
        type="button"
        class="activity-host__expand"
        :aria-label="t('activities.hideForMe')"
        :title="t('activities.hideForMe')"
        data-testid="activity-corner-leave"
        @click="actStore.hide(activity!.channel_id, true)"
      >
        <Icon name="log-out" :size="15" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import LiveReactionLayer from '@/components/voice/LiveReactionLayer.vue'
import { useT } from '@/composables/useT'
import { useActivitiesStore } from '@/stores/activities'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { isListenActivity } from '@/services/activities/activityService'
import { mediaPartSource } from '@/services/privateMedia'
import { embedRelayOrigin, EMBED_RELAY_PATH } from '@/utils/embedDetection'
import { suspendGlass } from '@/composables/useVisualTheme'

const TICK_MS = 250
const SEEK_DRIFT_MS = 1500
const NUDGE_DRIFT_MS = 80
const MAX_NUDGE = 0.08
const EMBED_SEEK_DRIFT_MS = 2000
const EMBED_SEEK_COOLDOWN_MS = 3000

const { t } = useT()
const actStore = useActivitiesStore()
const voice = useUnifiedVoiceChannelStore()

const mediaEl = ref<HTMLMediaElement | null>(null)
const frameEl = ref<HTMLIFrameElement | null>(null)
const rect = ref<{ left: number; top: number; width: number; height: number } | null>(null)
const layer = ref<number | null>(null)
let layerFor: Element | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let rafId = 0
let lastEmbedSeek = 0
let embedReady = false
let embedLoadedFor = ''
let endedFor = -1

const activity = computed(() => (actStore.playingHere ? actStore.current : null))
const active = computed(() => !!activity.value)
const embedded = computed(() => !!activity.value && ['youtube', 'soundcloud', 'spotify'].includes(activity.value.source))
const listen = computed(() => !!activity.value && isListenActivity(activity.value.source, activity.value.item) && !embedded.value)

/** Changes when the item changes, so the media element starts over. */
const itemKey = computed(() => {
  const a = activity.value
  if (!a) return ''
  return `${a.source}:${a.item.path ?? a.item.url ?? a.item.video_id ?? a.item.uri ?? ''}:${a.started_at}`
})

const mediaSource = computed(() => {
  const a = activity.value
  if (!a) return undefined
  if (a.source === 'file' && a.item.path) return mediaPartSource({ path: a.item.path })
  if (a.source === 'url') return a.item.url
  return undefined
})

const playerPage = computed(() => `${embedRelayOrigin() ?? ''}${EMBED_RELAY_PATH}?activity=1`)
const playerOrigin = computed(() => embedRelayOrigin() ?? window.location.origin)

const placement = computed<'slot' | 'corner' | 'hidden'>(() => {
  if (actStore.slot && rect.value) return 'slot'
  return listen.value || activity.value?.source === 'spotify' || activity.value?.source === 'soundcloud' ? 'hidden' : 'corner'
})

const boxStyle = computed(() => {
  if (placement.value !== 'slot' || !rect.value) return undefined
  const r = rect.value
  return {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    ...(layer.value !== null ? { zIndex: String(layer.value) } : {}),
  }
})

/** z-index of the outermost positioned ancestor with one; null when none sets it. */
function rootLayer(el: Element): number | null {
  let z: number | null = null
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n)
    if (s.position !== 'static' && s.zIndex !== 'auto') z = Number(s.zIndex) || 0
  }
  return z
}

function trackSlot(): void {
  cancelAnimationFrame(rafId)
  const follow = () => {
    const el = actStore.slot
    if (el && el.isConnected) {
      if (el !== layerFor) {
        layerFor = el
        layer.value = rootLayer(el)
      }
      const r = el.getBoundingClientRect()
      const prev = rect.value
      if (!prev || prev.left !== r.left || prev.top !== r.top || prev.width !== r.width || prev.height !== r.height) {
        rect.value = { left: r.left, top: r.top, width: r.width, height: r.height }
      }
    } else if (rect.value) {
      rect.value = null
    }
    rafId = requestAnimationFrame(follow)
  }
  rafId = requestAnimationFrame(follow)
}

function openStage(): void {
  voice.isOverlayVisible = true
}

// ---- embedded players -------------------------------------------------------------------

function sendEmbed(command: Record<string, unknown>): void {
  // JSON copy: postMessage throws DataCloneError on a reactive Proxy such as the activity's item.
  const message = JSON.parse(JSON.stringify({ harmonyPlayer: 1, ...command }))
  frameEl.value?.contentWindow?.postMessage(message, playerOrigin.value)
}

function loadEmbed(): void {
  const a = activity.value
  if (!a || !embedded.value) return
  const key = itemKey.value
  if (embedLoadedFor === key) return
  embedLoadedFor = key
  embedReady = false
  actStore.setStatus({ ready: false, positionMs: 0, durationMs: 0, error: null })
  sendEmbed({ cmd: 'load', source: a.source, item: a.item, startMs: Math.round(actStore.position()), autoplay: a.playing })
}

function onMessage(event: MessageEvent): void {
  if (!frameEl.value || event.source !== frameEl.value.contentWindow) return
  if (event.origin !== playerOrigin.value) return
  const data = event.data as { harmonyPlayer?: number; ev?: string; playing?: boolean; buffering?: boolean; positionMs?: number; durationMs?: number; message?: string }
  if (data?.harmonyPlayer !== 1) return
  if (data.ev === 'host-ready') {
    embedLoadedFor = ''
    loadEmbed()
  } else if (data.ev === 'ready') {
    embedReady = true
    actStore.setStatus({ ready: true, error: null })
    sendEmbed({ cmd: 'volume', value: actStore.muted ? 0 : actStore.volume })
  } else if (data.ev === 'state') {
    actStore.setStatus({
      playing: !!data.playing,
      buffering: !!data.buffering,
      positionMs: Number(data.positionMs) || 0,
      durationMs: Number(data.durationMs) || actStore.status.durationMs,
    })
  } else if (data.ev === 'ended') {
    if (endedFor !== activity.value?.revision) {
      endedFor = activity.value?.revision ?? -1
      actStore.itemEnded()
    }
  } else if (data.ev === 'error') {
    actStore.setStatus({ error: data.message ?? 'player' })
  }
}

// ---- sync ---------------------------------------------------------------------------------

function onMediaMeta(): void {
  const el = mediaEl.value
  if (!el) return
  actStore.setStatus({ durationMs: Number.isFinite(el.duration) ? el.duration * 1000 : 0 })
}

function onCanPlay(): void {
  actStore.setStatus({ ready: true, buffering: false, error: null })
  tick()
}

function tick(): void {
  const a = activity.value
  if (!a) return
  const expected = actStore.position()

  const el = mediaEl.value
  if (el && mediaSource.value) {
    el.volume = actStore.muted ? 0 : actStore.volume
    if (el.readyState < 1) return
    const durationMs = Number.isFinite(el.duration) ? el.duration * 1000 : 0
    const target = durationMs > 0 ? Math.min(expected, durationMs) : expected
    const actual = el.currentTime * 1000
    actStore.setStatus({ positionMs: actual })
    if (a.playing && el.paused && (durationMs === 0 || target < durationMs - 250)) {
      void el.play().catch(() => actStore.setStatus({ error: 'autoplay' }))
    } else if (!a.playing && !el.paused) {
      el.pause()
    }
    const drift = actual - target
    if (Math.abs(drift) > SEEK_DRIFT_MS || (!a.playing && Math.abs(drift) > NUDGE_DRIFT_MS)) {
      el.currentTime = target / 1000
      el.playbackRate = a.rate
    } else if (a.playing && Math.abs(drift) > NUDGE_DRIFT_MS) {
      const nudge = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, -drift / 2500))
      el.playbackRate = a.rate * (1 + nudge)
    } else {
      el.playbackRate = a.rate
    }
    return
  }

  if (embedded.value && embedReady) {
    const s = actStore.status
    if (a.playing && !s.playing && !s.buffering) sendEmbed({ cmd: 'play' })
    else if (!a.playing && s.playing) sendEmbed({ cmd: 'pause' })
    const now = Date.now()
    if (Math.abs(s.positionMs - expected) > EMBED_SEEK_DRIFT_MS && now - lastEmbedSeek > EMBED_SEEK_COOLDOWN_MS && !s.buffering) {
      lastEmbedSeek = now
      sendEmbed({ cmd: 'seek', ms: Math.round(expected) })
    }
  }
}

watch(itemKey, () => {
  endedFor = -1
  actStore.setStatus({ ready: false, playing: false, buffering: false, positionMs: 0, durationMs: 0, error: null })
  if (embedded.value) {
    embedLoadedFor = ''
    loadEmbed()
  }
})

watch(() => [actStore.volume, actStore.muted] as const, ([v, m]) => {
  if (embedded.value && embedReady) sendEmbed({ cmd: 'volume', value: m ? 0 : v })
})

watch(() => activity.value?.rate, (rate) => {
  if (embedded.value && embedReady && rate) sendEmbed({ cmd: 'rate', value: rate })
})

// Seeks and play/pause from others apply at once rather than on the next tick.
watch(() => activity.value?.revision, () => tick())

watch(() => actStore.voiceChannelId, () => {
  void actStore.enterCall()
}, { immediate: true })

onMounted(() => {
  window.addEventListener('message', onMessage)
  tickTimer = setInterval(tick, TICK_MS)
  trackSlot()
})

// Blurred panels re-render under every video frame; the skins' blur-off look stands in meanwhile.
const showsVideo = computed(() => active.value && !listen.value && placement.value !== 'hidden')
watch(showsVideo, (on) => suspendGlass('activity-video', on), { immediate: true })

onBeforeUnmount(() => {
  suspendGlass('activity-video', false)
  window.removeEventListener('message', onMessage)
  if (tickTimer) clearInterval(tickTimer)
  cancelAnimationFrame(rafId)
})
</script>

<style scoped>
.activity-host {
  position: fixed;
  /* The voice layer (.persistent-voice); a slot's own root layer overrides it inline. */
  z-index: 9998;
  overflow: hidden;
  background: #000;
  border-radius: 12px;
  transition: border-radius 0.15s ease;
}

.activity-host--slot {
  border-radius: 10px;
}

.activity-host--corner {
  right: 16px;
  bottom: 96px;
  width: min(360px, calc(100 * var(--app-vw) - 32px));
  aspect-ratio: 16 / 9;
  box-shadow: 0 16px 40px rgb(0 0 0 / 0.45);
}

.activity-host--hidden {
  left: -10000px;
  top: 0;
  width: 320px;
  height: 180px;
  opacity: 0;
  pointer-events: none;
}

.activity-host__media,
.activity-host__frame {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  border: 0;
  background: #000;
}

.activity-host.is-listen {
  background: radial-gradient(120% 120% at 20% 0%, color-mix(in srgb, var(--harmony-primary) 30%, #0b0d12), #0b0d12 70%);
}

.activity-host__listen {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.activity-host__art {
  width: min(44%, 220px);
  aspect-ratio: 1 / 1;
  object-fit: cover;
  border-radius: 14px;
  box-shadow: 0 18px 40px rgb(0 0 0 / 0.5);
}

.activity-host__art--empty {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgb(255 255 255 / 0.06);
  color: rgb(255 255 255 / 0.7);
}

.activity-host__bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 22px;
}

.activity-host__bars i {
  width: 4px;
  height: 30%;
  background: var(--harmony-primary);
  border-radius: 2px;
  opacity: 0.85;
}

.activity-host__bars.is-playing i {
  animation: activity-bars 0.9s ease-in-out infinite;
}

.activity-host__bars.is-playing i:nth-child(2) { animation-delay: -0.2s; }
.activity-host__bars.is-playing i:nth-child(3) { animation-delay: -0.45s; }
.activity-host__bars.is-playing i:nth-child(4) { animation-delay: -0.1s; }
.activity-host__bars.is-playing i:nth-child(5) { animation-delay: -0.6s; }

.activity-host__corner-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 6px;
}

.activity-host__expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  background: rgb(12 14 20 / 0.72);
  border: 1px solid rgb(255 255 255 / 0.12);
  border-radius: 8px;
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.activity-host:hover .activity-host__expand,
.activity-host__corner-actions:focus-within .activity-host__expand {
  opacity: 1;
}

@keyframes activity-bars {
  0%, 100% { height: 25%; }
  50% { height: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .activity-host__bars.is-playing i { animation: none; height: 70%; }
}
</style>
