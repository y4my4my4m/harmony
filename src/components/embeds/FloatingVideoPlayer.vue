<template>
  <Teleport to="body">
    <div ref="probeRef" class="floating-video-safe-area" aria-hidden="true" />
    <section
      v-show="video"
      class="mini-player"
      :class="[
        `mini-player--grip-${gripCorner}`,
        {
          'mini-player--static-bar': chrome > 0,
          'mini-player--interacting': interaction,
          'mini-player--animated': !interaction,
        },
      ]"
      :style="frameStyle"
      :aria-label="t('floatingVideo.region')"
      @keydown.escape.stop="close"
    >
      <div class="mini-player__bar" @pointerdown="onBarPointerDown">
        <span class="mini-player__title" :title="title">{{ title }}</span>
        <button
          v-if="video?.registration.sourceUrl"
          type="button"
          class="mini-player__btn"
          :title="t('floatingVideo.openSource')"
          :aria-label="t('floatingVideo.openSource')"
          @click="openSource"
        >
          <Icon name="external-link" :size="16" />
        </button>
        <button
          v-if="video?.canPictureInPicture && canDock"
          type="button"
          class="mini-player__btn"
          :title="t('floatingVideo.pictureInPicture')"
          :aria-label="t('floatingVideo.pictureInPicture')"
          @click="enterPictureInPicture"
        >
          <Icon name="picture-in-picture" :size="16" />
        </button>
        <button
          type="button"
          class="mini-player__btn"
          :title="t('floatingVideo.returnToMessage')"
          :aria-label="t('floatingVideo.returnToMessage')"
          @click="returnToSource"
        >
          <Icon name="corner-down-left" :size="16" />
        </button>
        <button
          type="button"
          class="mini-player__btn mini-player__btn--close"
          :title="t('floatingVideo.close')"
          :aria-label="t('floatingVideo.close')"
          @click="close"
        >
          <Icon name="x" :size="16" />
        </button>
      </div>
      <div ref="slotRef" class="mini-player__body" />
      <div
        class="mini-player__grip"
        :class="`mini-player__grip--${gripCorner}`"
        aria-hidden="true"
        @pointerdown="onGripPointerDown"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M9 1 1 9M9 5 5 9" />
        </svg>
      </div>
    </section>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import { FLOATING_VIDEO_BAR_HEIGHT, useFloatingVideoPlayer } from '@/composables/useFloatingVideo'
import { oppositeCorner, resizedFrameWidth } from '@/utils/floatingVideoGeometry'

const { t } = useI18n()
const router = useRouter()
const player = useFloatingVideoPlayer()
const {
  current: video,
  corner,
  size,
  position,
  chrome,
  interaction,
  canDock,
  close,
  enterPictureInPicture,
} = player

const slotRef = ref<HTMLElement | null>(null)
const probeRef = ref<HTMLElement | null>(null)

// Pointer travel in px before a press on the bar becomes a drag.
const DRAG_THRESHOLD = 4

const gripCorner = computed(() => oppositeCorner(corner.value))

const title = computed(() => {
  const reg = video.value?.registration
  if (!reg) return ''
  return reg.title || (reg.type === 'youtube' ? 'YouTube' : t('floatingVideo.video'))
})

const frameStyle = computed(() => ({
  width: `${size.value.width}px`,
  height: `${size.value.height}px`,
  transform: `translate3d(${Math.round(position.value.x)}px, ${Math.round(position.value.y)}px, 0)`,
  '--floating-video-bar': `${FLOATING_VIDEO_BAR_HEIGHT}px`,
}))

// With the source unmounted, the button navigates to where the video floated from.
function returnToSource(): void {
  const path = player.returnToSource()
  if (path && path !== router.currentRoute.value.fullPath) void router.push(path)
}

function openSource(): void {
  const url = video.value?.registration.sourceUrl
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}

// Tracks one pointer on `target` with capture until release or cancel.
// Movement below `threshold` px never starts the gesture.
function trackPointer(
  e: PointerEvent,
  threshold: number,
  handlers: { start: () => void; move: (dx: number, dy: number) => void; end: () => void },
): void {
  const target = e.currentTarget as HTMLElement
  const { pointerId, clientX: startX, clientY: startY } = e
  let active = false
  let finished = false

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    if (!active) {
      if (Math.hypot(dx, dy) < threshold) return
      active = true
      handlers.start()
    }
    handlers.move(dx, dy)
  }
  const onEnd = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId || finished) return
    finished = true
    target.removeEventListener('pointermove', onMove)
    target.removeEventListener('pointerup', onEnd)
    target.removeEventListener('pointercancel', onEnd)
    target.removeEventListener('lostpointercapture', onEnd)
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    if (active) handlers.end()
  }

  target.setPointerCapture(pointerId)
  target.addEventListener('pointermove', onMove)
  target.addEventListener('pointerup', onEnd)
  target.addEventListener('pointercancel', onEnd)
  target.addEventListener('lostpointercapture', onEnd)
  e.preventDefault()
}

function onBarPointerDown(e: PointerEvent): void {
  if (!e.isPrimary || e.button !== 0) return
  if ((e.target as Element).closest('button')) return
  const origin = { ...position.value }
  trackPointer(e, DRAG_THRESHOLD, {
    start: () => player.beginInteraction('drag'),
    move: (dx, dy) => player.dragTo({ x: origin.x + dx, y: origin.y + dy }),
    end: () => player.endDrag(),
  })
}

function onGripPointerDown(e: PointerEvent): void {
  const cur = video.value
  if (!cur || !e.isPrimary || e.button !== 0) return
  const start = { ...size.value }
  const grip = gripCorner.value
  const extra = chrome.value
  trackPointer(e, 0, {
    start: () => player.beginInteraction('resize'),
    move: (dx, dy) => player.resizeTo(resizedFrameWidth(start, cur.aspect, extra, grip, dx, dy)),
    end: () => player.endResize(),
  })
}

onMounted(() => {
  if (slotRef.value && probeRef.value) player.attachHost(slotRef.value, probeRef.value)
})

onBeforeUnmount(() => {
  player.detachHost()
})
</script>

<style scoped>
.floating-video-safe-area {
  position: fixed;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  visibility: hidden;
  pointer-events: none;
}

/* Below modals and the voice dock (z-index 1000), above layout drawers. */
.mini-player {
  --floating-video-grip: 18px;
  position: fixed;
  top: 0;
  left: 0;
  z-index: 999;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
}

.mini-player--animated {
  transition:
    transform var(--transition-base),
    width var(--transition-base),
    height var(--transition-base);
}

:root[data-reduce-motion="true"] .mini-player {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .mini-player {
    transition: none;
  }
}

/* Overlays the top of the video; shown on hover or focus. */
.mini-player__bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
  box-sizing: border-box;
  height: var(--floating-video-bar);
  padding: 0 3px 0 10px;
  background: var(--background-floating);
  border-bottom: 1px solid var(--border-primary);
  cursor: grab;
  touch-action: none;
  user-select: none;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

:root:not([data-disable-blur="true"]) .mini-player__bar {
  background: color-mix(in srgb, var(--background-floating) 90%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.mini-player:hover .mini-player__bar,
.mini-player:focus-within .mini-player__bar,
.mini-player--interacting .mini-player__bar {
  opacity: 1;
}

.mini-player--interacting .mini-player__bar {
  cursor: grabbing;
}

/* Hover-less devices: the bar sits above the video and is always shown. */
.mini-player--static-bar .mini-player__bar {
  position: relative;
  flex: none;
  opacity: 1;
}

.mini-player--grip-top-left .mini-player__bar {
  padding-left: calc(var(--floating-video-grip) + 6px);
}

.mini-player--grip-top-right .mini-player__bar {
  padding-right: calc(var(--floating-video-grip) + 3px);
}

.mini-player__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.mini-player__btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.mini-player__btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.mini-player__btn--close:hover {
  color: var(--error);
}

.mini-player__body {
  position: relative;
  z-index: 0;
  flex: 1 1 auto;
  min-height: 0;
  background: #000;
}

/* Iframes swallow pointer events; the gesture must keep receiving them. */
.mini-player--interacting .mini-player__body {
  pointer-events: none;
}

.mini-player__grip {
  position: absolute;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--floating-video-grip);
  height: var(--floating-video-grip);
  color: var(--text-secondary);
  background: var(--background-floating);
  touch-action: none;
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast);
}

.mini-player:hover .mini-player__grip,
.mini-player:focus-within .mini-player__grip,
.mini-player--interacting .mini-player__grip,
.mini-player--static-bar .mini-player__grip {
  opacity: 1;
}

.mini-player__grip:hover {
  color: var(--text-primary);
}

/* The glyph is drawn for the bottom-right corner and mirrored for the rest. */
.mini-player__grip--bottom-right {
  right: 0;
  bottom: 0;
  cursor: nwse-resize;
  border-top-left-radius: var(--radius-sm);
}

.mini-player__grip--bottom-left {
  left: 0;
  bottom: 0;
  cursor: nesw-resize;
  border-top-right-radius: var(--radius-sm);
}

.mini-player__grip--bottom-left svg {
  transform: scaleX(-1);
}

.mini-player__grip--top-right {
  right: 0;
  top: 0;
  cursor: nesw-resize;
  border-bottom-left-radius: var(--radius-sm);
}

.mini-player__grip--top-right svg {
  transform: scaleY(-1);
}

.mini-player__grip--top-left {
  left: 0;
  top: 0;
  cursor: nwse-resize;
  border-bottom-right-radius: var(--radius-sm);
}

.mini-player__grip--top-left svg {
  transform: scale(-1);
}

@media (pointer: coarse) {
  .mini-player {
    --floating-video-grip: 26px;
  }

  .mini-player__btn {
    width: 30px;
    height: 30px;
  }
}

/* The moved embed fills the body; its in-chat sizing rules are overridden. */
.mini-player__body :deep(.floating-video) {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  margin: 0;
  border: 0;
  border-radius: 0;
  background: #000;
  overflow: hidden;
}

.mini-player__body :deep(.floating-video .provider-embed__header),
.mini-player__body :deep(.floating-video .attachment-remove-btn),
.mini-player__body :deep(.floating-video .floating-video-popout) {
  display: none;
}

.mini-player__body :deep(.floating-video .provider-embed__content),
.mini-player__body :deep(.floating-video .provider-embed__media),
.mini-player__body :deep(.floating-video .media-frame) {
  display: block;
  width: 100%;
  height: 100%;
  max-width: none;
  aspect-ratio: auto;
}

.mini-player__body :deep(.floating-video iframe),
.mini-player__body :deep(.floating-video video) {
  display: block;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  border: 0;
  border-radius: 0;
  object-fit: contain;
  background: #000;
}
</style>

<style>
/* In-chat stand-in for the floating embed; width, height and margin are set
   inline from the embed's box. */
.floating-video-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  background: var(--background-secondary);
  color: var(--text-secondary);
  font: inherit;
  font-size: 13px;
  text-align: center;
  cursor: pointer;
  transition: border-color var(--transition-fast), color var(--transition-fast);
}

.floating-video-placeholder:hover {
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.floating-video-placeholder__icon {
  color: var(--text-muted);
}

.floating-video-placeholder__label {
  font-weight: 600;
}

.floating-video-placeholder__hint {
  color: var(--text-muted);
  font-size: 12px;
}

/* Pop-out control over an in-chat video, top-right of its positioned parent.
   Shown while the parent is hovered; always shown on touch screens. */
.floating-video-popout {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-fast), background-color var(--transition-fast);
}

/* Left of the attachment remove button (32px at right: 8px) or the clip
   favorite button (28px at right: 8px). */
.floating-video-popout--inset {
  right: 44px;
}

.floating-video-popout:hover {
  background: rgba(0, 0, 0, 0.85);
}

:hover > .floating-video-popout,
.floating-video-popout:focus-visible {
  opacity: 1;
}

.floating-video-popout:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

@media (hover: none), (pointer: coarse) {
  .floating-video-popout {
    opacity: 1;
  }
}

html.floating-video-interacting,
html.floating-video-interacting * {
  user-select: none !important;
  -webkit-user-select: none !important;
}

html.floating-video-interacting iframe {
  pointer-events: none !important;
}
</style>
