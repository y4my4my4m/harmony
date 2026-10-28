<!-- The app's one emoji info card: renders the request openEmojiInfo / hoverEmojiInfo (composables/useEmojiInfo) made. -->
<template>
  <Teleport :to="portalTarget">
    <div v-if="request && sheet" class="emoji-info-scrim" aria-hidden="true" />
    <div
      v-if="request"
      ref="cardRef"
      :key="request.id"
      class="emoji-info"
      :class="{ 'emoji-info--sheet': sheet, 'emoji-info--hover': hover }"
      role="dialog"
      :aria-modal="sheet ? 'true' : undefined"
      :aria-labelledby="titleId"
      :aria-describedby="descriptionId"
      tabindex="-1"
      data-testid="emoji-info"
      :data-mode="request.mode"
      :style="sheet ? undefined : { left: `${position.x}px`, top: `${position.y}px` }"
      @mouseenter="hold"
      @mouseleave="leave"
    >
      <div v-if="sheet" class="emoji-info-handle" aria-hidden="true" />
      <EmojiInfoCard
        :target="request.target"
        :reactions="request.reactions"
        :title-id="titleId"
        :description-id="descriptionId"
      />
      <button
        v-if="!hover"
        type="button"
        class="emoji-info-close"
        :aria-label="t('common.close')"
        :title="t('common.close')"
        data-testid="emoji-info-close"
        @click="close"
      >
        <Icon name="x" :size="16" aria-hidden="true" />
      </button>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import EmojiInfoCard from '@/components/emoji/EmojiInfoCard.vue'
import Icon from '@/components/common/Icon.vue'
import { useEmojiInfo } from '@/composables/useEmojiInfo'
import { useDialog } from '@/composables/useDialog'
import { usePortalTarget } from '@/composables/usePortalTarget'
import { useT } from '@/composables/useT'
import { placePopover } from '@/components/voice/voiceMenuModel'
import { styleRect, styleViewport } from '@/utils/appZoom'

const { t } = useT()
const portalTarget = usePortalTarget()
const { request, close, hold, leave } = useEmojiInfo()

const cardRef = ref<HTMLElement | null>(null)
const position = ref({ x: -9999, y: -9999 })

const sheet = computed(() => request.value?.mode === 'sheet')
const hover = computed(() => request.value?.mode === 'hover')
const returnFocus = () => request.value?.anchor ?? null

// Pinned: a non-modal dialog. Sheet: modal, background inert and still.
const { titleId, descriptionId } = useDialog({
  open: () => request.value?.mode === 'pinned',
  element: cardRef,
  onClose: close,
  initialFocus: 'dialog',
  returnFocus,
  inertBackground: false,
  lockScroll: false,
})
useDialog({
  open: sheet,
  element: cardRef,
  onClose: close,
  initialFocus: 'dialog',
  returnFocus,
})

function place(): void {
  const card = cardRef.value
  const anchor = request.value?.anchor
  if (!card || !anchor || sheet.value) return
  if (!anchor.isConnected) {
    close()
    return
  }
  const box = styleRect(card)
  position.value = placePopover(styleRect(anchor), { width: box.width, height: box.height }, styleViewport(card))
}

let frame = 0
function schedulePlace(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    place()
  })
}

// Card height changes as the source loads.
let resizeObserver: ResizeObserver | null = null
watch(cardRef, (el) => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (!el || typeof ResizeObserver === 'undefined') return
  resizeObserver = new ResizeObserver(schedulePlace)
  resizeObserver.observe(el)
})

watch(
  () => request.value?.id,
  async (id) => {
    position.value = { x: -9999, y: -9999 }
    if (!id) return
    await nextTick()
    place()
  },
)

// A pinned card or sheet closes on a press outside it and its emoji; Escape is useDialog's.
// The scrim is inert under a sheet, so a press on it reaches here with another target.
function onPointerDown(event: PointerEvent): void {
  const current = request.value
  if (!current || current.mode === 'hover') return
  const target = event.target
  if (!(target instanceof Node)) return
  if (cardRef.value?.contains(target) || current.anchor.contains(target)) return
  close()
}

// A scroll under a hover card moves its emoji away; a pinned card follows.
function onScroll(event: Event): void {
  const current = request.value
  if (!current || current.mode === 'sheet') return
  if (event.target instanceof Node && cardRef.value?.contains(event.target)) return
  if (current.mode === 'hover') close()
  else schedulePlace()
}

watch(
  () => !!request.value,
  (open) => {
    if (open) {
      document.addEventListener('pointerdown', onPointerDown, true)
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('resize', schedulePlace)
    } else {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', schedulePlace)
    }
  },
)

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', schedulePlace)
  resizeObserver?.disconnect()
  if (frame) cancelAnimationFrame(frame)
})
</script>

<style scoped>
.emoji-info {
  position: fixed;
  z-index: 10007;
  box-sizing: border-box;
  width: 300px;
  max-width: calc(100 * var(--app-vw) - 16px);
  max-height: calc(100 * var(--app-vh) - 16px);
  overflow-y: auto;
  padding: 14px;
  background: var(--background-floating);
  color: var(--text-primary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
  outline: none;
  animation: emoji-info-in 0.12s ease-out;
}

.emoji-info:focus-visible {
  outline: 2px solid var(--focus-ring, var(--harmony-primary));
  outline-offset: 2px;
}

.emoji-info--hover {
  padding-right: 14px;
}

.emoji-info:not(.emoji-info--hover) :deep(.eic-head) {
  padding-right: 24px;
}

.emoji-info-close {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.emoji-info-close:hover {
  color: var(--text-primary);
  background: var(--background-secondary);
}

.emoji-info-close:focus-visible {
  outline: 2px solid var(--focus-ring, var(--harmony-primary));
  outline-offset: 1px;
}

.emoji-info-scrim {
  position: fixed;
  inset: 0;
  z-index: 10006;
  background: rgb(0 0 0 / 0.4);
}

.emoji-info--sheet {
  left: 0;
  right: 0;
  bottom: 0;
  top: auto;
  width: auto;
  max-width: none;
  max-height: 80%;
  padding: 8px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  border-bottom: none;
  animation: emoji-info-sheet-in 0.18s ease-out;
}

.emoji-info--sheet .emoji-info-close {
  top: 14px;
}

.emoji-info-handle {
  width: 36px;
  height: 4px;
  margin: 0 auto 10px;
  border-radius: 2px;
  background: var(--border-primary);
}

@keyframes emoji-info-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

@keyframes emoji-info-sheet-in {
  from { transform: translateY(100%); }
  to { transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .emoji-info,
  .emoji-info--sheet {
    animation: none;
  }
}
</style>
