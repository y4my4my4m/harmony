<!--
  MediaLightbox - full-window viewer for images, video and audio.

  Images zoom by pinch, double tap, double click, the wheel and the toolbar, and rotate in
  90° steps. Video and audio play in Harmony's player (VideoControls), or the browser's own
  controls when Appearance asks for them. On touch, a horizontal swipe steps through the
  items and a downward swipe closes the viewer (leaves fullscreen first while fullscreen).

  `origin` is the inline player of the start item: the viewer starts there, pauses it while
  open, and hands the position back on close. The fullscreen control fills the screen with
  the whole viewer (utils/mediaFullscreen.ts); iOS plays video in the system player.

  The viewer mounts in `to`, else the portal target of its subtree, which can sit in the call
  pop-out window: pointer and resize listeners go on the window that shows the viewer.
-->
<template>
  <Teleport :to="to ?? portalTarget">
    <Transition name="lightbox-fade">
      <div
        v-if="visible"
        ref="overlayEl"
        class="media-lightbox-overlay"
        :class="{ 'is-fullscreen': fullscreen, 'is-dragging': dragging, 'is-zoomed': zoom.scale > 1 }"
        :style="{ '--lightbox-shade': String(shade) }"
        data-testid="media-viewer"
        data-block-sidebar-gestures
        @click.self="onHide"
      >
        <div
          ref="dialogEl"
          class="media-lightbox-dialog"
          role="dialog"
          aria-modal="true"
          :aria-label="dialogLabel"
          tabindex="-1"
        >
          <div class="lightbox-toolbar">
            <div class="lightbox-caption">
              <p v-if="items.length > 1" class="lightbox-position" aria-live="polite">{{ positionText }}</p>
              <p v-if="currentName" class="lightbox-name" :title="currentName">{{ currentName }}</p>
            </div>
            <div class="lightbox-tools">
              <slot name="actions" :src="currentSrc" :index="index" />
              <template v-if="isImage">
                <button
                  type="button"
                  class="lightbox-tool lightbox-tool--zoom"
                  :aria-label="t('a11y.lightbox.zoomOut')"
                  :title="t('a11y.lightbox.zoomOut')"
                  :disabled="zoom.scale <= MIN_SCALE"
                  @click="zoomBy(1 / ZOOM_STEP)"
                >
                  <Icon name="zoom-out" :size="20" />
                </button>
                <button
                  type="button"
                  class="lightbox-tool lightbox-tool--zoom"
                  :aria-label="t('a11y.lightbox.zoomIn')"
                  :title="t('a11y.lightbox.zoomIn')"
                  :disabled="zoom.scale >= MAX_SCALE"
                  data-testid="lightbox-zoom-in"
                  @click="zoomBy(ZOOM_STEP)"
                >
                  <Icon name="zoom-in" :size="20" />
                </button>
                <button
                  type="button"
                  class="lightbox-tool"
                  :aria-label="t('a11y.lightbox.rotateRight')"
                  :title="t('a11y.lightbox.rotateRight')"
                  @click="rotateBy(90)"
                >
                  <Icon name="rotate-cw" :size="20" />
                </button>
              </template>
              <button
                v-if="download && currentSrc && !isEmbed"
                type="button"
                class="lightbox-tool"
                :aria-label="t('a11y.lightbox.download')"
                :title="t('a11y.lightbox.download')"
                data-testid="lightbox-download"
                @click="downloadCurrent"
              >
                <Icon name="download" :size="20" />
              </button>
              <button
                v-if="showFullscreenTool"
                type="button"
                class="lightbox-tool"
                :aria-label="fullscreen ? t('videoPlayer.exitFullscreen') : t('videoPlayer.fullscreen')"
                :title="fullscreen ? t('videoPlayer.exitFullscreen') : t('videoPlayer.fullscreen')"
                data-testid="lightbox-fullscreen"
                @click="toggleViewerFullscreen"
              >
                <Icon :name="fullscreen ? 'minimize' : 'maximize'" :size="20" />
              </button>
              <button
                type="button"
                class="lightbox-tool close-btn"
                :aria-label="t('common.close')"
                :title="t('common.close')"
                @click="onHide"
              >
                <Icon name="x" :size="22" />
              </button>
            </div>
          </div>

          <button
            v-if="hasPrevious"
            type="button"
            class="nav-btn prev"
            :aria-label="t('a11y.lightbox.previous')"
            @click="prev"
          >
            <Icon name="chevron-left" :size="28" />
          </button>
          <button
            v-if="hasNext"
            type="button"
            class="nav-btn next"
            :aria-label="t('a11y.lightbox.next')"
            @click="next"
          >
            <Icon name="chevron-right" :size="28" />
          </button>

          <div
            ref="stageEl"
            class="lightbox-stage"
            @pointerdown="onPointerDown"
            @wheel="onWheel"
            @dblclick="onDoubleClick"
            @click="onStageClick"
          >
            <div class="lightbox-slide" :style="slideStyle">
              <img
                v-if="currentItem && isImage"
                ref="imageEl"
                :key="`image-${index}`"
                :src="currentSrc"
                :alt="currentAlt"
                class="media-content media-image"
                :style="imageStyle"
                draggable="false"
                @load="onImageLoad"
              />
              <!-- An X video this browser plays in X's embedded post, framed on the click. -->
              <div
                v-else-if="currentItem && isEmbed"
                ref="frameEl"
                :key="`embed-${index}`"
                class="media-embed-frame"
              >
                <XPostFrame :src="currentSrc" :poster="currentPoster" :label="mediaLabel" />
              </div>
              <div
                v-else-if="currentItem"
                ref="frameEl"
                :key="`media-${index}`"
                class="media-video-frame"
                :class="isAudio ? 'media-audio-frame' : 'media-video-fit'"
                :style="isAudio ? undefined : { '--media-aspect': String(mediaAspect) }"
              >
                <template v-if="isAudio">
                  <img v-if="currentPoster" :src="currentPoster" alt="" class="audio-art" draggable="false" />
                  <span v-else class="audio-art audio-art--icon" aria-hidden="true"><Icon name="music" :size="56" /></span>
                  <p class="audio-name">{{ currentName || currentAlt || t('a11y.lightbox.audio') }}</p>
                </template>
                <video
                  ref="videoRef"
                  :src="currentSrc"
                  :poster="isAudio ? undefined : currentPoster"
                  :aria-label="mediaLabel"
                  class="media-content media-video"
                  :class="{ 'media-audio-element': isAudio }"
                  :controls="nativeVideoControls || isGifv"
                  preload="auto"
                  :autoplay="autoplayCurrent"
                  playsinline
                  data-vp="1"
                  :loop="isGifv"
                  :muted="isGifv"
                  @loadedmetadata="onMediaLoaded"
                >
                  {{ t('a11y.lightbox.videoUnsupported') }}
                </video>
                <VideoControls
                  v-if="!nativeVideoControls && !isGifv"
                  large
                  :label="mediaLabel"
                  :fullscreen-target="fullscreenTarget"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useT } from '@/composables/useT';
import Icon from '@/components/common/Icon.vue';
import VideoControls from '@/components/common/VideoControls.vue';
import XPostFrame from '@/components/embeds/XPostFrame.vue';
import { useNativeVideoControls } from '@/composables/useVideoPlayerPreference';
import { useDialog } from '@/composables/useDialog';
import { isTopLayerElement } from '@/utils/a11y/layers';
import { focusProgrammatically } from '@/utils/a11y/focus';
import { usePortalTarget } from '@/composables/usePortalTarget';
import { downloadMediaFromUrl, filenameFromUrl } from '@/utils/downloadMedia';
import {
  NATIVE_VIDEO_FULLSCREEN_EVENTS,
  canFullscreen,
  exitFullscreen,
  isFullscreen,
  onFullscreenChange,
  toggleFullscreen,
} from '@/utils/mediaFullscreen';
import {
  DOUBLE_TAP_SCALE,
  IDENTITY,
  MAX_SCALE,
  MIN_SCALE,
  TAP_SLOP,
  ZOOM_STEP,
  clampPan,
  classifySwipe,
  isDoubleTap,
  pinchOf,
  zoomAt,
  type Point,
  type Size,
  type Tap,
  type ZoomState,
} from '@/utils/lightboxGestures';

export type LightboxItem =
  | string
  | { src: string; type?: 'image'; alt?: string; name?: string }
  | { src: string; type: 'video'; poster?: string; isGifv?: boolean; alt?: string; name?: string }
  | { src: string; type: 'audio'; poster?: string; alt?: string; name?: string }
  | { src: string; type: 'embed'; poster?: string; alt?: string; name?: string };

interface Props {
  visible: boolean;
  imgs: LightboxItem[];
  /** Text alternatives by index, for string items. */
  alts?: string[];
  /** Inline player of the item at the opening index; see the header. */
  origin?: HTMLMediaElement | null;
  /** Download button for the current item. */
  download?: boolean;
  /** Teleport target. Default: the portal target of the subtree (usePortalTarget). */
  to?: string | HTMLElement;
}

const props = withDefaults(defineProps<Props>(), { alts: undefined, origin: null, download: false, to: undefined });

const emit = defineEmits<{
  hide: [];
}>();

// `index` is a v-model: the parent drives which item shows.
const index = defineModel<number>('index', { default: 0 });

const portalTarget = usePortalTarget();
const { t } = useT();
const nativeVideoControls = useNativeVideoControls();

const overlayEl = ref<HTMLElement | null>(null);
const dialogEl = ref<HTMLElement | null>(null);
const stageEl = ref<HTMLElement | null>(null);
const imageEl = ref<HTMLImageElement | null>(null);
const frameEl = ref<HTMLElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);

function itemType(item: LightboxItem | undefined): 'image' | 'video' | 'audio' | 'embed' {
  if (!item || typeof item === 'string') return 'image';
  return item.type ?? 'image';
}

const items = computed(() => props.imgs || []);
const currentItem = computed<LightboxItem | undefined>(() => items.value[index.value]);
const currentType = computed(() => itemType(currentItem.value));
const isImage = computed(() => !!currentItem.value && currentType.value === 'image');
const isAudio = computed(() => currentType.value === 'audio');
const isEmbed = computed(() => currentType.value === 'embed');
const currentSrc = computed(() => {
  const item = currentItem.value;
  if (!item) return '';
  return typeof item === 'string' ? item : item.src;
});
const currentName = computed(() => {
  const item = currentItem.value;
  return item && typeof item === 'object' && item.name ? item.name : '';
});
const currentAlt = computed(() => {
  const item = currentItem.value;
  if (item && typeof item === 'object' && item.alt) return item.alt;
  return props.alts?.[index.value] ?? currentName.value;
});
const currentPoster = computed(() => {
  const item = currentItem.value;
  return item && typeof item === 'object' && 'poster' in item ? item.poster : undefined;
});
const isGifv = computed(() => {
  const item = currentItem.value;
  return !!item && typeof item === 'object' && 'isGifv' in item && item.isGifv === true;
});
const mediaLabel = computed(() => currentAlt.value || currentName.value || undefined);
const hasPrevious = computed(() => items.value.length > 1 && index.value > 0);
const hasNext = computed(() => items.value.length > 1 && index.value < items.value.length - 1);
const positionText = computed(() => t('a11y.lightbox.position', { current: index.value + 1, total: items.value.length }));
const dialogLabel = computed(() =>
  items.value.length > 1 ? `${t('a11y.lightbox.label')}, ${positionText.value}` : t('a11y.lightbox.label'),
);

// GIF-style clips start on their own unless reduced motion is asked for, by the OS or the
// appearance setting. Other media wait for the play control.
function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-reduce-motion') === 'true') return true;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
const autoplayCurrent = computed(() => isGifv.value && !prefersReducedMotion());

useDialog({
  open: () => props.visible,
  element: dialogEl,
  onClose: () => onHide(),
});

// --- Playback positions and the inline origin ------------------------------------------
// Seconds per item index; the item at `originIndex` started from, and returns to, `origin`.
const positions = new Map<number, number>();
let originIndex = -1;
let resumeIndex = -1;
let sessionOpen = false;

function isPlayable(item: LightboxItem | undefined): boolean {
  const type = itemType(item);
  return type === 'video' || type === 'audio';
}

function beginSession() {
  if (sessionOpen) return;
  sessionOpen = true;
  positions.clear();
  originIndex = -1;
  resumeIndex = -1;
  const origin = props.origin;
  if (!origin || !isPlayable(currentItem.value)) return;
  originIndex = index.value;
  const time = origin.currentTime;
  if (Number.isFinite(time) && time > 0) positions.set(originIndex, time);
  if (!origin.paused && !origin.ended) resumeIndex = originIndex;
  origin.pause();
}

function saveCurrentPosition(at = index.value) {
  const media = videoRef.value;
  const item = items.value[at];
  if (!media || !isPlayable(item) || (typeof item === 'object' && 'isGifv' in item && item.isGifv)) return;
  const time = media.currentTime;
  if (Number.isFinite(time)) positions.set(at, time);
}

function endSession() {
  if (!sessionOpen) return;
  sessionOpen = false;
  saveCurrentPosition();
  const origin = props.origin;
  const time = positions.get(originIndex);
  if (origin && origin.isConnected && time !== undefined) {
    try {
      origin.currentTime = time;
    } catch {
      /* not seekable yet */
    }
  }
}

// Width over height of the current video; the frame scales the video up to fill the stage.
const mediaAspect = ref(16 / 9);
watch(index, () => {
  mediaAspect.value = 16 / 9;
});

function onMediaLoaded() {
  const media = videoRef.value;
  if (!media) return;
  if (media.videoWidth > 0 && media.videoHeight > 0) mediaAspect.value = media.videoWidth / media.videoHeight;
  const time = positions.get(index.value);
  if (time !== undefined && time > 0 && !isGifv.value) {
    const end = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : time;
    media.currentTime = Math.min(time, end);
  }
  if (resumeIndex === index.value) {
    resumeIndex = -1;
    void media.play().catch(() => {});
  } else if (autoplayCurrent.value) {
    void media.play().catch(() => {});
  }
}

// --- Navigation ------------------------------------------------------------------------
function onHide() {
  if (fullscreen.value) void exitFullscreen(videoRef.value);
  endSession();
  emit('hide');
}

// Focus on a nav button that unmounts at the end of the list moves to the dialog.
function keepFocusInside() {
  nextTick(() => {
    const dialog = dialogEl.value;
    const active = document.activeElement;
    if (dialog && (!active || active === document.body || !dialog.contains(active))) focusProgrammatically(dialog);
  });
}

function prev() {
  if (index.value > 0) index.value--;
  keepFocusInside();
}

function next() {
  if (index.value < items.value.length - 1) index.value++;
  keepFocusInside();
}

// The leaving item's position is read before its element is replaced.
watch(index, (_now, before) => {
  saveCurrentPosition(before);
  resetZoom();
}, { flush: 'pre' });

watch(
  () => props.visible,
  (visible) => {
    if (visible) beginSession();
    else endSession();
  },
  { immediate: true },
);

// --- Zoom, pan and swipe ---------------------------------------------------------------
const zoom = reactive<ZoomState>({ ...IDENTITY });
const drag = reactive({ x: 0, y: 0 });
const dragging = ref(false);
const gestureActive = ref(false);

function stageBox(): DOMRect | null {
  return stageEl.value?.getBoundingClientRect() ?? null;
}

function stageSize(): Size {
  const box = stageBox();
  return { width: box?.width ?? 0, height: box?.height ?? 0 };
}

function contentSize(): Size {
  const img = imageEl.value;
  return { width: img?.offsetWidth ?? 0, height: img?.offsetHeight ?? 0 };
}

/** Scale that fits a quarter-turned image back into the stage. */
const turnFit = ref(1);
function measureTurnFit() {
  const turned = (((Math.round(zoom.rotation / 90) % 4) + 4) % 4) % 2 === 1;
  const content = contentSize();
  const stage = stageSize();
  if (!turned || !content.width || !content.height || !stage.width || !stage.height) {
    turnFit.value = 1;
    return;
  }
  turnFit.value = Math.min(1, stage.width / content.height, stage.height / content.width);
}

// Touch adjustment retargets taps to the nearest clickable ancestor (the stage), so the
// media is found by position, not by event target.
function onMedia(clientX: number, clientY: number): boolean {
  const el = isImage.value ? imageEl.value : frameEl.value;
  if (!el) return false;
  const box = el.getBoundingClientRect();
  return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
}

function toStage(clientX: number, clientY: number): Point {
  const box = stageBox();
  if (!box) return { x: 0, y: 0 };
  return { x: clientX - (box.left + box.width / 2), y: clientY - (box.top + box.height / 2) };
}

function applyZoom(state: ZoomState) {
  const fit = turnFit.value;
  const clamped = clampPan({ ...state, scale: state.scale * fit }, contentSize(), stageSize());
  zoom.scale = state.scale;
  zoom.x = clamped.x;
  zoom.y = clamped.y;
  zoom.rotation = state.rotation;
}

function resetZoom() {
  Object.assign(zoom, IDENTITY);
  turnFit.value = 1;
}

function zoomBy(factor: number, focus: Point = { x: 0, y: 0 }) {
  applyZoom(zoomAt({ ...zoom }, zoom.scale * factor, focus));
}

function rotateBy(degrees: number) {
  zoom.rotation += degrees;
  zoom.x = 0;
  zoom.y = 0;
  measureTurnFit();
  applyZoom({ ...zoom });
}

function toggleZoomAt(point: Point) {
  if (zoom.scale > MIN_SCALE) applyZoom({ ...zoom, scale: MIN_SCALE, x: 0, y: 0 });
  else applyZoom(zoomAt({ ...zoom }, DOUBLE_TAP_SCALE, point));
}

function onImageLoad() {
  measureTurnFit();
}

const imageStyle = computed(() => ({
  transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) rotate(${zoom.rotation}deg) scale(${zoom.scale * turnFit.value})`,
  transition: gestureActive.value ? 'none' : undefined,
  cursor: zoom.scale > MIN_SCALE ? 'grab' : 'zoom-in',
}));

const slideStyle = computed(() =>
  drag.x || drag.y ? { transform: `translate3d(${drag.x}px, ${drag.y}px, 0)` } : undefined,
);

/** Backdrop opacity, 1 at rest; a downward swipe fades it. */
const shade = computed(() => {
  const height = stageSize().height || 1;
  return drag.y > 0 ? Math.max(0.35, 1 - drag.y / height) : 1;
});

/** `hold`: two or more fingers on media that does not zoom; nothing happens until all lift. */
interface Gesture {
  kind: 'swipe' | 'pan' | 'pinch' | 'hold';
  start: Point;
  time: number;
  origin: ZoomState;
  moved: boolean;
  axis: 'x' | 'y' | null;
  pinchDistance: number;
  pinchCenter: Point;
}

const pointers = new Map<number, Point>();
let gesture: Gesture | null = null;
let lastTap: Tap | null = null;
let suppressClick = false;
// Time of the last touch release; Chrome follows a double tap with a dblclick.
let lastTouchAt = -Infinity;

function startGesture(kind: Gesture['kind'], point: Point, time: number, extra: Partial<Gesture> = {}) {
  gesture = {
    kind,
    start: point,
    time,
    origin: { ...zoom },
    moved: false,
    axis: null,
    pinchDistance: 0,
    pinchCenter: { x: 0, y: 0 },
    ...extra,
  };
  gestureActive.value = kind !== 'swipe';
}

/** Window of the document that shows the viewer: the main one, or the call pop-out's. */
function viewWindow(): Window {
  return overlayEl.value?.ownerDocument.defaultView ?? window;
}

// The call pop-out forwards no pointermove or pointerup to the main window (callPopout.ts).
let listening: Window | null = null;
function listen(on: boolean) {
  if (listening) {
    listening.removeEventListener('pointermove', onPointerMove);
    listening.removeEventListener('pointerup', onPointerUp);
    listening.removeEventListener('pointercancel', onPointerUp);
    listening = null;
  }
  if (!on) return;
  listening = viewWindow();
  listening.addEventListener('pointermove', onPointerMove);
  listening.addEventListener('pointerup', onPointerUp);
  listening.addEventListener('pointercancel', onPointerUp);
}

function onPointerDown(event: PointerEvent) {
  // A touch swipe or pinch is followed by no click; its suppression ends with the next press.
  suppressClick = false;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const target = event.target as Element | null;
  // The player's controls, the browser's video controls, the toolbar and nav buttons keep
  // their own pointer handling.
  if (target?.closest('.hv-dock, button, a, input, video, [role="slider"]')) return;
  // A mouse drags a zoomed image; it never swipes.
  if (event.pointerType === 'mouse' && zoom.scale <= MIN_SCALE) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 1) {
    startGesture(zoom.scale > MIN_SCALE ? 'pan' : 'swipe', { x: event.clientX, y: event.clientY }, event.timeStamp);
    listen(true);
  } else if (pointers.size === 2) {
    // A second finger ends the swipe: it pinches an image and holds anything else.
    drag.x = 0;
    drag.y = 0;
    dragging.value = false;
    if (!isImage.value) {
      startGesture('hold', { x: event.clientX, y: event.clientY }, event.timeStamp);
      return;
    }
    const [a, b] = [...pointers.values()];
    const pinch = pinchOf(a, b);
    startGesture('pinch', pinch.center, event.timeStamp, {
      moved: true,
      pinchDistance: pinch.distance,
      pinchCenter: toStage(pinch.center.x, pinch.center.y),
    });
  }
}

function onPointerMove(event: PointerEvent) {
  if (!gesture || !pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (gesture.kind === 'hold') return;

  if (gesture.kind === 'pinch') {
    if (pointers.size < 2 || gesture.pinchDistance <= 0) return;
    const [a, b] = [...pointers.values()];
    const pinch = pinchOf(a, b);
    const center = toStage(pinch.center.x, pinch.center.y);
    const scaled = zoomAt(gesture.origin, gesture.origin.scale * (pinch.distance / gesture.pinchDistance), gesture.pinchCenter);
    applyZoom({
      ...scaled,
      x: scaled.x + center.x - gesture.pinchCenter.x,
      y: scaled.y + center.y - gesture.pinchCenter.y,
    });
    return;
  }

  const dx = event.clientX - gesture.start.x;
  const dy = event.clientY - gesture.start.y;
  if (!gesture.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
  gesture.moved = true;

  if (gesture.kind === 'pan') {
    applyZoom({ ...gesture.origin, x: gesture.origin.x + dx, y: gesture.origin.y + dy });
    return;
  }

  gesture.axis ??= Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  dragging.value = true;
  if (gesture.axis === 'x') {
    // Past either end the slide resists.
    const edge = (dx > 0 && !hasPrevious.value) || (dx < 0 && !hasNext.value);
    drag.x = edge ? dx * 0.25 : dx;
    drag.y = 0;
  } else {
    drag.x = 0;
    drag.y = Math.max(0, dy);
  }
}

function onPointerUp(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  const current = gesture;
  if (!current) {
    if (pointers.size === 0) listen(false);
    return;
  }

  if (current.kind === 'hold') {
    suppressClick = true;
    if (pointers.size === 0) endGesture();
    return;
  }

  if (current.kind === 'pinch') {
    suppressClick = true;
    if (pointers.size === 1) {
      // The finger left on the glass pans on.
      const [rest] = [...pointers.values()];
      startGesture('pan', rest, event.timeStamp, { moved: true });
      return;
    }
    if (zoom.scale < MIN_SCALE * 1.02) applyZoom({ ...zoom, scale: MIN_SCALE, x: 0, y: 0 });
    endGesture();
    return;
  }
  if (pointers.size > 0) return;
  if (event.pointerType !== 'mouse') lastTouchAt = event.timeStamp;

  if (!current.moved) {
    if (event.pointerType !== 'mouse' && isImage.value && onMedia(event.clientX, event.clientY)) {
      const tap: Tap = { x: event.clientX, y: event.clientY, time: event.timeStamp };
      if (isDoubleTap(lastTap, tap)) {
        lastTap = null;
        toggleZoomAt(toStage(tap.x, tap.y));
      } else {
        lastTap = tap;
      }
    }
    endGesture();
    return;
  }

  suppressClick = true;
  let stepped = false;
  if (current.kind === 'swipe') {
    const action = classifySwipe(drag.x, drag.y, event.timeStamp - current.time, stageSize());
    if (action === 'previous' && hasPrevious.value) {
      prev();
      stepped = true;
    } else if (action === 'next' && hasNext.value) {
      next();
      stepped = true;
    } else if (action === 'close') {
      if (fullscreen.value) void exitFullscreen(videoRef.value);
      else onHide();
    }
  }
  endGesture(stepped);
}

/** `stepped`: the swipe changed the item, which shows in place instead of sliding back. */
function endGesture(stepped = false) {
  gesture = null;
  gestureActive.value = false;
  drag.x = 0;
  drag.y = 0;
  if (stepped) viewWindow().requestAnimationFrame(() => { dragging.value = false; });
  else dragging.value = false;
  pointers.clear();
  listen(false);
}

function onWheel(event: WheelEvent) {
  if (!isImage.value || !imageEl.value) return;
  event.preventDefault();
  const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
  zoomBy(factor, toStage(event.clientX, event.clientY));
}

function onDoubleClick(event: MouseEvent) {
  if (!isImage.value || !onMedia(event.clientX, event.clientY)) return;
  // Touch double taps are recognised from pointer events.
  if (event.timeStamp - lastTouchAt < 800) return;
  toggleZoomAt(toStage(event.clientX, event.clientY));
}

// A click on the stage outside the media closes, unless it ended a drag.
function onStageClick(event: MouseEvent) {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (!onMedia(event.clientX, event.clientY)) onHide();
}

// --- Fullscreen ------------------------------------------------------------------------
const fullscreen = ref(false);
const fullscreenTarget = () => overlayEl.value;

const canFullscreenCurrent = ref(false);
function measureFullscreen() {
  canFullscreenCurrent.value = canFullscreen(isImage.value ? null : videoRef.value);
  fullscreen.value = isFullscreen(overlayEl.value, videoRef.value);
}

// Videos in Harmony's player carry their own fullscreen control.
const showFullscreenTool = computed(
  () => canFullscreenCurrent.value && (isImage.value || isAudio.value || isGifv.value || nativeVideoControls.value),
);

function toggleViewerFullscreen() {
  const target = overlayEl.value;
  if (!target) return;
  void toggleFullscreen(target, isImage.value ? null : videoRef.value);
}

function onNativeFullscreen() {
  fullscreen.value = isFullscreen(overlayEl.value, videoRef.value);
}

watch([currentItem, videoRef, overlayEl], measureFullscreen, { flush: 'post' });
watch(overlayEl, (el, old) => {
  for (const type of NATIVE_VIDEO_FULLSCREEN_EVENTS) {
    old?.removeEventListener(type, onNativeFullscreen, true);
    el?.addEventListener(type, onNativeFullscreen, true);
  }
});

function downloadCurrent() {
  const src = currentSrc.value;
  if (!src) return;
  void downloadMediaFromUrl(src, currentName.value || filenameFromUrl(src, 'media'));
}

// --- Keys ------------------------------------------------------------------------------
// Left/Right step through the items, +/- and 0 zoom an image, while this viewer is the
// topmost layer; a focused player keeps its keys. Escape is the dialog stack's.
function handleKeydown(e: KeyboardEvent) {
  if (!props.visible || !isTopLayerElement(dialogEl.value)) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if ((e.target as Element | null)?.closest?.('video, .hv')) return;
  if (e.key === 'ArrowLeft') prev();
  else if (e.key === 'ArrowRight') next();
  else if (isImage.value && (e.key === '+' || e.key === '=')) zoomBy(ZOOM_STEP);
  else if (isImage.value && e.key === '-') zoomBy(1 / ZOOM_STEP);
  else if (isImage.value && e.key === '0') resetZoom();
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

// Rotation and orientation changes keep the zoomed image inside the stage.
function onResize() {
  measureTurnFit();
  applyZoom({ ...zoom });
}

let resizing: Window | null = null;
function listenResize(view: Window | null) {
  resizing?.removeEventListener('resize', onResize);
  resizing = view;
  resizing?.addEventListener('resize', onResize);
}

let removeFullscreenListener: (() => void) | null = null;

onMounted(() => {
  // Keys of the call pop-out reach the main window (callPopout.ts forwardEvents).
  window.addEventListener('keydown', handleKeydown, true);
  listenResize(viewWindow());
  removeFullscreenListener = onFullscreenChange(measureFullscreen);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown, true);
  listenResize(null);
  removeFullscreenListener?.();
  listen(false);
  if (fullscreen.value) void exitFullscreen(videoRef.value);
  endSession();
});
</script>

<style scoped>
.media-lightbox-overlay {
  --lightbox-shade: 1;
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgb(0 0 0 / calc(0.95 * var(--lightbox-shade)));
  color: #fff;
  transition: background-color 0.2s ease;
}

.media-lightbox-overlay.is-dragging {
  transition: none;
}

.media-lightbox-dialog {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
}

.media-lightbox-dialog:focus {
  outline: none;
}

/* --- Toolbar: caption left, tools right, under the status bar and notch --------------- */
.lightbox-toolbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 12px;
  padding:
    calc(12px + env(safe-area-inset-top, 0px))
    calc(12px + env(safe-area-inset-right, 0px))
    12px
    calc(16px + env(safe-area-inset-left, 0px));
  background: linear-gradient(to bottom, rgb(0 0 0 / 0.55), rgb(0 0 0 / 0));
  pointer-events: none;
}

.lightbox-caption {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.lightbox-position {
  flex: none;
  margin: 0;
  padding: 4px 12px;
  border-radius: var(--radius-full);
  background: rgb(0 0 0 / 0.6);
  font-size: var(--font-size-sm);
}

.lightbox-name {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  color: rgb(255 255 255 / 0.85);
}

.lightbox-tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: auto;
}

.lightbox-tool,
.nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgb(255 255 255 / 0.1);
  color: #fff;
  cursor: pointer;
  transition: background 0.2s;
  -webkit-tap-highlight-color: transparent;
}

.lightbox-tool {
  width: 44px;
  height: 44px;
}

.lightbox-tool:hover:not(:disabled),
.nav-btn:hover {
  background: rgb(255 255 255 / 0.2);
}

.lightbox-tool:disabled {
  opacity: 0.4;
  cursor: default;
}

.lightbox-tool:focus-visible,
.nav-btn:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

/* Rendered by the actions slot: sits in the toolbar row. */
.lightbox-tools :deep(.lightbox-download-btn) {
  position: static;
}

.nav-btn {
  position: absolute;
  top: 50%;
  z-index: 10;
  width: 48px;
  height: 48px;
  margin-top: -24px;
}

.nav-btn.prev {
  left: calc(16px + env(safe-area-inset-left, 0px));
}

.nav-btn.next {
  right: calc(16px + env(safe-area-inset-right, 0px));
}

/* --- Stage ---------------------------------------------------------------------------- */
.lightbox-stage {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding:
    calc(68px + env(safe-area-inset-top, 0px))
    calc(72px + env(safe-area-inset-right, 0px))
    calc(24px + env(safe-area-inset-bottom, 0px))
    calc(72px + env(safe-area-inset-left, 0px));
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.lightbox-slide {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  container-type: size;
  transition: transform 0.22s ease;
}

.is-dragging .lightbox-slide {
  transition: none;
}

.media-content {
  max-width: 100cqw;
  max-height: 100cqh;
  object-fit: contain;
}

.media-image {
  transform-origin: center center;
  transition: transform 0.18s ease;
  -webkit-user-drag: none;
}

.is-zoomed .media-image {
  cursor: grab;
}

/* Shrinks to the video so the player chrome covers the video only. */
.media-video-frame {
  position: relative;
  display: inline-flex;
  max-width: 100cqw;
  max-height: 100cqh;
  line-height: 0;
}

.media-embed-frame {
  width: min(550px, 100cqw);
  max-height: 100cqh;
  overflow: auto;
}

.media-video-frame .media-video {
  display: block;
}

/* The largest box of the video's aspect inside the stage, small videos included. */
.media-video-fit {
  width: min(100cqw, calc(100cqh * var(--media-aspect)));
  aspect-ratio: var(--media-aspect);
}

.media-video-fit .media-video {
  width: 100%;
  height: 100%;
}

/* Audio: the name on top, the artwork centred under the play button, the dock below; the
   <video> playing the sound stays out of sight. */
.media-audio-frame {
  display: block;
  width: min(520px, 100cqw);
  max-height: 100cqh;
  aspect-ratio: 4 / 3;
  border-radius: 16px;
  background: linear-gradient(160deg, rgb(255 255 255 / 0.1), rgb(255 255 255 / 0.03));
  line-height: normal;
}

.audio-art {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 128px;
  height: 128px;
  margin: -64px 0 0 -64px;
  border-radius: 16px;
  object-fit: cover;
}

.audio-art--icon {
  display: grid;
  place-items: center;
  background: rgb(255 255 255 / 0.08);
  color: rgb(255 255 255 / 0.8);
}

.audio-name {
  position: absolute;
  top: 20px;
  left: 20px;
  right: 20px;
  margin: 0;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.media-audio-element {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

/* --- Fullscreen: the media takes the whole screen, the toolbar floats over it --------- */
.media-lightbox-overlay.is-fullscreen {
  background: #000;
}

.is-fullscreen .lightbox-stage {
  padding: 0;
}

.lightbox-fade-enter-active,
.lightbox-fade-leave-active {
  transition: opacity 0.2s ease;
}
.lightbox-fade-enter-from,
.lightbox-fade-leave-to {
  opacity: 0;
}

/* Phones: swipe steps through the items; the arrows shrink to the edges. */
@media (max-width: 768px) {
  .nav-btn {
    width: 40px;
    height: 40px;
    margin-top: -20px;
  }
  .nav-btn.prev { left: calc(8px + env(safe-area-inset-left, 0px)); }
  .nav-btn.next { right: calc(8px + env(safe-area-inset-right, 0px)); }
  .lightbox-stage {
    padding:
      calc(64px + env(safe-area-inset-top, 0px))
      env(safe-area-inset-right, 0px)
      calc(12px + env(safe-area-inset-bottom, 0px))
      env(safe-area-inset-left, 0px);
  }
}

/* Pinch replaces the zoom buttons on touch screens. */
@media (pointer: coarse) {
  .lightbox-tool--zoom {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lightbox-slide,
  .media-image,
  .media-lightbox-overlay {
    transition: none;
  }
}
</style>
