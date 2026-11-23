<!--
  The frame of the joined play-together session. Mounted once (App.vue) and laid over the element a
  visible panel registered (stores/playTogether registerSlot); moving between panels never moves
  the frame in the DOM, so the activity keeps its state. With no slot the frame stays loaded off
  screen at its last size and the mini card offers the way back.

  Stacking: the frame is teleported to <body> and paints one above the slot's root-level stacking
  ancestor (the call view, teleported to the end of <body> at its own z-index), else at FRAME_Z,
  under menus and dialogs. Over the call view it carries data-a11y-persistent: the call view makes
  every other top-level element inert (utils/a11y/layers inertOthers), the game included.

  The frame is sandboxed with allow-scripts and allow-pointer-lock only (no allow-same-origin): an
  opaque origin, no storage, no popups, no top navigation, no downloads, no modal dialogs. Its
  document is expected to load once per element: the element is keyed by session and retry, so a
  new session or a retry gets a fresh browsing context. Leaving the document (the loader's `gone`)
  or a load this component did not start (the activity navigating its frame away) detaches the
  runtime and blanks the frame.
-->
<template>
  <Teleport to="body">
  <div
    v-if="joined"
    ref="hostEl"
    class="pt-host"
    :class="{ 'is-hidden': !placed }"
    :style="boxStyle"
    :data-a11y-persistent="onStage ? '' : undefined"
    data-testid="play-together-host"
  >
    <iframe
      ref="frameEl"
      :key="`${joined.session.id}:${frameKey}`"
      :src="frameSrc"
      class="pt-host__frame"
      :class="{ 'is-ready': store.view.frameReady }"
      sandbox="allow-scripts allow-pointer-lock"
      allow="fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-write 'none'"
      referrerpolicy="no-referrer"
      :title="label"
      data-testid="play-together-frame"
      @load="onLoad"
    />
    <div v-if="overlay" class="pt-host__overlay" role="status" aria-live="polite">
      <template v-if="overlay === 'loading'">
        <img :src="joined.app.iconUrl" alt="" class="pt-host__icon" />
        <span class="pt-host__spinner" aria-hidden="true" />
        <span>{{ t('playTogether.loading', { name: label }) }}</span>
      </template>
      <template v-else-if="overlay === 'reconnecting'">
        <span class="pt-host__spinner" aria-hidden="true" />
        <span>{{ t('playTogether.reconnecting') }}</span>
      </template>
      <template v-else-if="overlay === 'failed'">
        <Icon name="alert-triangle" :size="28" />
        <span>{{ t('playTogether.loadFailed', { name: label }) }}</span>
        <div class="pt-host__actions">
          <button type="button" class="pt-btn" @click="reload">{{ t('playTogether.retry') }}</button>
          <button type="button" class="pt-btn pt-btn--ghost" @click="store.leave()">{{ t('playTogether.close') }}</button>
        </div>
      </template>
      <template v-else-if="overlay === 'escaped'">
        <Icon name="shield" :size="28" />
        <span>{{ t('playTogether.escaped', { name: label }) }}</span>
        <button type="button" class="pt-btn pt-btn--ghost" @click="store.leave()">{{ t('playTogether.close') }}</button>
      </template>
    </div>
  </div>

  <aside
    v-if="joined && !store.slot"
    class="pt-mini"
    :aria-label="label"
    data-testid="play-together-mini"
  >
    <img :src="joined.app.iconUrl" alt="" class="pt-mini__icon" />
    <div class="pt-mini__text">
      <span class="pt-mini__name">{{ label }}</span>
      <span class="pt-mini__meta">{{ t('playTogether.playing', { n: store.view.members.length }, store.view.members.length) }}</span>
    </div>
    <button
      type="button"
      class="pt-btn"
      data-testid="play-together-return"
      @click="store.returnTo()"
    >{{ t('playTogether.return') }}</button>
    <button
      type="button"
      class="pt-icon-btn"
      :aria-label="t('playTogether.leave')"
      :title="t('playTogether.leave')"
      data-testid="play-together-mini-leave"
      @click="store.leave()"
    ><Icon name="log-out" :size="16" /></button>
  </aside>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { usePlayTogetherStore } from '@/stores/playTogether'
import { activityFrameUrl } from '@/services/playTogether/catalog'
import { styleRect } from '@/utils/appZoom'

const FRAME_Z = 20
const LOAD_TIMEOUT_MS = 20_000
const OFFSCREEN = { width: 800, height: 600 }

const { t } = useT()
const store = usePlayTogetherStore()

const hostEl = ref<HTMLElement | null>(null)
const frameEl = ref<HTMLIFrameElement | null>(null)
const rect = ref<{ left: number; top: number; width: number; height: number } | null>(null)
const layer = ref<number>(FRAME_Z)
const frameKey = ref(0)
const escaped = computed(() => store.view.escaped)
const timedOut = ref(false)
let loadsExpected = 1
let rafId = 0
let loadTimer: ReturnType<typeof setTimeout> | null = null

const joined = computed(() => store.joined)
const label = computed(() => (joined.value ? store.appLabel(joined.value.app).name : ''))
const frameSrc = computed(() => (joined.value && !escaped.value ? activityFrameUrl(joined.value.app) : 'about:blank'))
const placed = computed(() => !!store.slot && !!rect.value)
const onStage = computed(() => placed.value && layer.value > FRAME_Z)

const overlay = computed<null | 'loading' | 'reconnecting' | 'failed' | 'escaped'>(() => {
  if (escaped.value) return 'escaped'
  if (timedOut.value && !store.view.frameReady) return 'failed'
  if (store.view.status === 'reconnecting' || store.view.status === 'offline') return store.view.frameReady ? 'reconnecting' : 'loading'
  if (!store.view.frameReady || store.view.status === 'connecting') return 'loading'
  return null
})

const boxStyle = computed(() => {
  const r = rect.value
  if (!store.slot || !r) return { left: '-10000px', top: '0px', width: `${OFFSCREEN.width}px`, height: `${OFFSCREEN.height}px` }
  return { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: String(layer.value) }
})

/** One above the outermost positioned ancestor of `el` with a z-index, else FRAME_Z. */
function layerFor(el: HTMLElement): number {
  let z: number | null = null
  for (let node: HTMLElement | null = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.position !== 'static' && style.zIndex !== 'auto') {
      const value = Number(style.zIndex)
      if (Number.isFinite(value)) z = value
    }
  }
  return z === null ? FRAME_Z : z + 1
}

function track(): void {
  cancelAnimationFrame(rafId)
  const step = () => {
    const slot = store.slot
    if (!slot || !slot.isConnected) {
      rect.value = null
      return
    }
    const r = styleRect(slot)
    const prev = rect.value
    if (!prev || prev.left !== r.left || prev.top !== r.top || prev.width !== r.width || prev.height !== r.height) {
      rect.value = { left: r.left, top: r.top, width: r.width, height: r.height }
    }
    rafId = requestAnimationFrame(step)
  }
  step()
}

watch(() => store.slot, (slot) => {
  if (slot) layer.value = layerFor(slot)
  track()
}, { immediate: true })

// Expanding raises the panel's z-index; post flush reads it after the panel re-renders.
watch(() => store.mode, () => {
  if (store.slot) layer.value = layerFor(store.slot)
}, { flush: 'post' })

// The call view may have made the host inert before the game took its stage.
watch([onStage, hostEl], ([stage, el]) => {
  if (stage && el?.hasAttribute('inert')) el.removeAttribute('inert')
})

watch(frameEl, (el) => store.joined?.runtime.attachFrame(el))
watch(() => store.joined, (current, previous) => {
  if (current !== previous) {
    timedOut.value = false
    loadsExpected = 1
    armLoadTimer()
  }
  current?.runtime.attachFrame(frameEl.value)
})

function armLoadTimer(): void {
  if (loadTimer) clearTimeout(loadTimer)
  loadTimer = setTimeout(() => {
    if (!store.view.frameReady) timedOut.value = true
  }, LOAD_TIMEOUT_MS)
}

function onLoad(): void {
  const el = frameEl.value
  if (!el || !store.joined || el.src === 'about:blank') return
  if (loadsExpected > 0) {
    loadsExpected--
    return
  }
  // A document this component did not ask for: the activity navigated its frame.
  store.joined.runtime.escape()
}

function reload(): void {
  timedOut.value = false
  loadsExpected = 1
  frameKey.value++
  store.joined?.runtime.frameReloaded()
  armLoadTimer()
}

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  if (loadTimer) clearTimeout(loadTimer)
})
</script>

<style scoped>
.pt-host {
  position: fixed;
  overflow: hidden;
  border-radius: 0 0 10px 10px;
  background: #0b0f14;
  contain: strict;
}

.pt-host.is-hidden {
  visibility: hidden;
  pointer-events: none;
}

.pt-host__frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.pt-host__frame.is-ready {
  opacity: 1;
}

.pt-host__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  color: #e6edf3;
  font-size: var(--font-size-sm, 14px);
  background: radial-gradient(circle at 50% 40%, rgba(14, 165, 233, 0.18), transparent 60%), #0b0f14;
}

.pt-host__icon {
  width: 56px;
  height: 56px;
  border-radius: 14px;
}

.pt-host__spinner {
  width: 22px;
  height: 22px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--harmony-primary, #0EA5E9);
  border-radius: 50%;
  animation: pt-spin 0.8s linear infinite;
}

.pt-host__actions {
  display: flex;
  gap: 8px;
}

@keyframes pt-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .pt-host__spinner { animation-duration: 2.4s; }
  .pt-host__frame { transition: none; }
}

.pt-mini {
  position: fixed;
  right: 16px;
  bottom: calc(16px + var(--mobile-bottom-nav-height, 0px) + env(safe-area-inset-bottom, 0px));
  z-index: 900;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100 * var(--app-vw) - 32px);
  padding: 8px 8px 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--background-secondary);
  color: var(--text-primary);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
}

.pt-mini__icon {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  flex-shrink: 0;
}

.pt-mini__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pt-mini__name {
  font-weight: var(--font-weight-semibold, 600);
  font-size: var(--font-size-sm, 14px);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pt-mini__meta {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
}

.pt-btn {
  padding: 6px 12px;
  border: 0;
  border-radius: 8px;
  background: var(--harmony-primary, #0EA5E9);
  color: #fff;
  font-weight: var(--font-weight-semibold, 600);
  font-size: var(--font-size-sm, 14px);
  cursor: pointer;
  white-space: nowrap;
}

.pt-btn--ghost {
  background: rgba(255, 255, 255, 0.1);
  color: inherit;
}

.pt-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.pt-icon-btn:hover,
.pt-icon-btn:focus-visible {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}
</style>
