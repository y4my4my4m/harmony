<template>
  <Teleport to="body">
    <!-- Native mode uses the browser's Picture-in-Picture window; nothing renders here. -->
    <section
      v-if="showFrame"
      ref="frameRef"
      class="pip"
      :class="{ 'pip--interacting': interaction }"
      :style="frameStyle"
      :aria-label="participantName"
      @keydown.esc.stop="closePIP"
    >
      <header class="pip-bar" @pointerdown="onBarPointerDown">
        <span class="pip-live">{{ t('voice.live') }}</span>
        <span class="pip-title">
          <DisplayName :user-id="pipParticipant!.userId" :fallback="participantName" :truncate="true" />
        </span>
        <TileVolumeControl
          v-if="!isSelf"
          class="pip-volume"
          :user-id="pipParticipant!.userId"
          kind="screen"
        />
        <button
          v-if="voiceStore.liveReactionsAvailable"
          ref="reactRef"
          type="button"
          class="pip-btn"
          :class="{ active: showReactions }"
          :title="t('voice.react')"
          :aria-label="t('voice.react')"
          aria-haspopup="dialog"
          :aria-expanded="showReactions"
          @click="showReactions = !showReactions"
        >
          <Icon name="smile-plus" :size="16" />
        </button>
        <button
          type="button"
          class="pip-btn"
          :title="t('voice.focus')"
          :aria-label="t('voice.focus')"
          @click="openInCall"
        >
          <Icon name="maximize" :size="16" />
        </button>
        <button
          type="button"
          class="pip-btn pip-btn--close"
          :title="t('voice.closePopOut')"
          :aria-label="t('voice.closePopOut')"
          @click="closePIP"
        >
          <Icon name="x" :size="16" />
        </button>
      </header>
      <div class="pip-body" @dblclick="openInCall">
        <video
          ref="videoRef"
          autoplay
          playsinline
          muted
          class="pip-video"
          @loadedmetadata="onVideoMetadata"
          @resize="onVideoMetadata"
        />
        <LiveReactionLayer :user-id="pipParticipant!.userId" source="screen" />
      </div>
      <div
        class="pip-grip"
        aria-hidden="true"
        @pointerdown="onGripPointerDown"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <path d="M9 1 1 9M9 5 5 9" />
        </svg>
      </div>
    </section>
    <LiveReactionPopover
      :visible="showFrame && showReactions && !!voiceStore.liveReactionsAvailable"
      :anchor="reactRef"
      :target="voiceStore.pipUserId ? { userId: voiceStore.pipUserId, source: 'screen' } : null"
      @close="showReactions = false"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { debug } from '@/utils/debug';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useUserData } from '@/composables/useUserData';
import Icon from '@/components/common/Icon.vue';
import DisplayName from '@/components/DisplayName.vue';
import TileVolumeControl from './TileVolumeControl.vue';
import LiveReactionLayer from './LiveReactionLayer.vue';
import LiveReactionPopover from './LiveReactionPopover.vue';
import {
  clampAspect,
  clampFrameWidth,
  clampPoint,
  cornerPoint,
  frameSize,
  resizedFrameWidth,
  type Box,
  type Point,
} from '@/utils/floatingVideoGeometry';

const { t } = useI18n();
const voiceStore = useUnifiedVoiceChannelStore();
const { getUserDisplayName } = useUserData();

// Header bar height, px; it sits above the video and does not scale.
const BAR_HEIGHT = 40;
const MARGIN = 12;
const WIDTH_LIMITS = { min: 280, max: 1920 };
const DRAG_THRESHOLD = 4;

const frameRef = ref<HTMLElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const interaction = ref<'drag' | 'resize' | null>(null);
const reactRef = ref<HTMLButtonElement | null>(null);
const showReactions = ref(false);

// Survives close/reopen within the session.
const aspect = ref(16 / 9);
const width = ref(420);
const position = ref<Point | null>(null);
const viewport = ref<Box>({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });

const pipParticipant = computed(() => {
  if (!voiceStore.pipUserId) return null;
  return voiceStore.allParticipants.find(p => p.userId === voiceStore.pipUserId) || null;
});

const isSelf = computed(() => voiceStore.pipUserId === voiceStore.localState.userId);

const participantName = computed(() => {
  if (!pipParticipant.value) return t('voice.live');
  return getUserDisplayName(pipParticipant.value.userId).value || 'User';
});

// 'fixed' is the fallback when the browser refuses native Picture-in-Picture.
const showFrame = computed(() =>
  voiceStore.pipActive &&
  (voiceStore.pipMode === 'draggable' || voiceStore.pipMode === 'fixed') &&
  !!pipParticipant.value?.isScreenSharing
);

const bounds = computed<Box>(() => ({
  left: viewport.value.left + MARGIN,
  top: viewport.value.top + MARGIN,
  width: Math.max(0, viewport.value.width - 2 * MARGIN),
  height: Math.max(0, viewport.value.height - 2 * MARGIN),
}));

const clampedWidth = computed(() =>
  clampFrameWidth(width.value, aspect.value, BAR_HEIGHT, bounds.value, WIDTH_LIMITS)
);

const size = computed(() => frameSize(clampedWidth.value, aspect.value, BAR_HEIGHT));

const resolvedPosition = computed<Point>(() => {
  if (position.value) return clampPoint(position.value, size.value, bounds.value);
  return cornerPoint('bottom-right', size.value, bounds.value);
});

const frameStyle = computed(() => ({
  width: `${size.value.width}px`,
  height: `${size.value.height}px`,
  transform: `translate3d(${Math.round(resolvedPosition.value.x)}px, ${Math.round(resolvedPosition.value.y)}px, 0)`,
}));

function closePIP(): void {
  voiceStore.togglePIP(null);
}

function openInCall(): void {
  const userId = voiceStore.pipUserId;
  if (!userId) return;
  voiceStore.togglePIP(null);
  voiceStore.isOverlayVisible = true;
  voiceStore.enterFullscreen(userId, 'screen');
}

function onVideoMetadata(): void {
  const v = videoRef.value;
  if (v && v.videoWidth > 0 && v.videoHeight > 0) {
    aspect.value = clampAspect(v.videoWidth / v.videoHeight);
  }
}

// One pointer, captured, until release or cancel. Movement under
// `threshold` px never starts the gesture. Mirrors FloatingVideoPlayer.
function trackPointer(
  e: PointerEvent,
  threshold: number,
  handlers: { start: () => void; move: (dx: number, dy: number) => void; end: () => void },
): void {
  const target = e.currentTarget as HTMLElement;
  const { pointerId, clientX: startX, clientY: startY } = e;
  let active = false;
  let finished = false;

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!active) {
      if (Math.hypot(dx, dy) < threshold) return;
      active = true;
      handlers.start();
    }
    handlers.move(dx, dy);
  };
  const onEnd = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId || finished) return;
    finished = true;
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onEnd);
    target.removeEventListener('pointercancel', onEnd);
    target.removeEventListener('lostpointercapture', onEnd);
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    if (active) handlers.end();
  };

  target.setPointerCapture(pointerId);
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onEnd);
  target.addEventListener('pointercancel', onEnd);
  target.addEventListener('lostpointercapture', onEnd);
  e.preventDefault();
}

function onBarPointerDown(e: PointerEvent): void {
  if (!e.isPrimary || e.button !== 0) return;
  if ((e.target as Element).closest('button, input, .pip-volume')) return;
  const origin = { ...resolvedPosition.value };
  trackPointer(e, DRAG_THRESHOLD, {
    start: () => { interaction.value = 'drag'; },
    move: (dx, dy) => {
      position.value = clampPoint({ x: origin.x + dx, y: origin.y + dy }, size.value, bounds.value);
    },
    end: () => { interaction.value = null; },
  });
}

function onGripPointerDown(e: PointerEvent): void {
  if (!e.isPrimary || e.button !== 0) return;
  const start = { ...size.value };
  const origin = { ...resolvedPosition.value };
  trackPointer(e, 0, {
    start: () => { interaction.value = 'resize'; },
    move: (dx, dy) => {
      // Top-left stays put; the grip is the bottom-right corner.
      const next = resizedFrameWidth(start, aspect.value, BAR_HEIGHT, 'bottom-right', dx, dy);
      const room: Box = {
        left: origin.x,
        top: origin.y,
        width: bounds.value.left + bounds.value.width - origin.x,
        height: bounds.value.top + bounds.value.height - origin.y,
      };
      width.value = clampFrameWidth(next, aspect.value, BAR_HEIGHT, room, WIDTH_LIMITS);
      position.value = origin;
    },
    end: () => { interaction.value = null; },
  });
}

function onViewportChange(): void {
  const vv = window.visualViewport;
  viewport.value = vv
    ? { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height }
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

// VIDEO

let attached: { userId: string; el: HTMLVideoElement } | null = null;

function detachVideo(): void {
  if (!attached) return;
  voiceStore.detachVideoFromElement(attached.userId, attached.el, 'screen');
  attached.el.srcObject = null;
  attached = null;
}

function attachVideo(): void {
  const userId = voiceStore.pipUserId;
  const el = videoRef.value;
  if (!showFrame.value || !userId || !el) {
    detachVideo();
    return;
  }
  if (attached && (attached.userId !== userId || attached.el !== el)) detachVideo();
  if (voiceStore.attachVideoToElement(userId, el, 'screen')) {
    attached = { userId, el };
  }
}

// A popped-out remote stream must be received.
watch(
  () => [voiceStore.pipActive, voiceStore.pipUserId] as const,
  ([active, userId]) => {
    if (active && userId && userId !== voiceStore.localState.userId) {
      voiceStore.watchStream(userId);
    }
  },
  { immediate: true },
);

watch(
  [showFrame, videoRef, () => voiceStore.pipUserId, () => voiceStore.streamUpdateCounter],
  () => attachVideo(),
  { immediate: true, flush: 'post' },
);

// NATIVE PICTURE-IN-PICTURE

watch(() => [voiceStore.pipActive, voiceStore.pipMode, voiceStore.pipUserId] as const, async ([active, mode, userId]) => {
  if (!active || mode !== 'native' || !userId) return;
  try {
    const videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.muted = true;
    const ok = voiceStore.attachVideoToElement(userId, videoEl, 'screen');
    if (!ok) {
      const stream = voiceStore.getUserStream(userId);
      if (!stream) throw new Error('No stream to show');
      videoEl.srcObject = stream;
    }

    await new Promise(resolve => {
      videoEl.addEventListener('loadedmetadata', resolve, { once: true });
    });

    if (document.pictureInPictureEnabled && !document.pictureInPictureElement) {
      await videoEl.requestPictureInPicture();
      videoEl.addEventListener('leavepictureinpicture', () => {
        voiceStore.togglePIP(null);
        voiceStore.detachVideoFromElement(userId, videoEl, 'screen');
        videoEl.srcObject = null;
        videoEl.remove();
      }, { once: true });
    }
  } catch (error) {
    debug.error('Failed to enter native PIP:', error);
    voiceStore.togglePIP(userId, 'fixed');
  }
}, { immediate: true });

onMounted(() => {
  window.addEventListener('resize', onViewportChange, { passive: true });
  window.visualViewport?.addEventListener('resize', onViewportChange);
  onViewportChange();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportChange);
  window.visualViewport?.removeEventListener('resize', onViewportChange);
  detachVideo();
});
</script>

<style scoped>
.pip {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
  transition: transform var(--transition-base), width var(--transition-base), height var(--transition-base);
}

.pip--interacting {
  transition: none;
  user-select: none;
}

@media (prefers-reduced-motion: reduce) {
  .pip { transition: none; }
}

:root[data-reduce-motion="true"] .pip {
  transition: none;
}

.pip-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  box-sizing: border-box;
  height: 40px;
  padding: 0 4px 0 10px;
  background: var(--background-tertiary);
  border-bottom: 1px solid var(--border-primary);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.pip--interacting .pip-bar {
  cursor: grabbing;
}

.pip-live {
  flex: none;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--error);
  color: var(--text-on-primary);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.pip-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.pip-volume {
  flex: none;
  height: 30px;
  cursor: default;
}

.pip-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.pip-btn:hover,
.pip-btn:focus-visible,
.pip-btn.active {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  outline: none;
}

.pip-btn--close:hover {
  color: var(--error);
}

.pip-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  background: #000;
}

.pip--interacting .pip-body {
  pointer-events: none;
}

.pip-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.pip-grip {
  position: absolute;
  right: 0;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--text-secondary);
  background: var(--background-floating);
  border-top-left-radius: var(--radius-sm);
  cursor: nwse-resize;
  touch-action: none;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.pip:hover .pip-grip,
.pip:focus-within .pip-grip,
.pip--interacting .pip-grip {
  opacity: 1;
}

@media (hover: none), (pointer: coarse) {
  .pip-grip {
    width: 26px;
    height: 26px;
    opacity: 1;
  }
}
</style>
