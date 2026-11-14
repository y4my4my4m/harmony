<!--
  MediaLightbox - full-window viewer for images, video, audio, PDFs and other files.

  Images zoom by pinch, double tap, double click, the wheel and the toolbar, pan when zoomed,
  move under a mouse drag at any scale, and rotate in 90° steps (composables/useMediaZoom,
  useMediaGestures). The wheel, toolbar and keys also shrink an image below its fit. Video
  and audio play in Harmony's player (VideoControls), or the browser's own controls when
  Appearance asks for them. A PDF shows in the browser's reader; any other file shows its
  name and a download button. On touch, a horizontal swipe steps through the items and a
  downward swipe closes the viewer (leaves fullscreen first while fullscreen).

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
        :class="{ 'is-fullscreen': fullscreen, 'is-dragging': dragging, 'is-zoomed': zoomed }"
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
              <slot name="actions" :index="index" />
              <template v-if="isImage">
                <button
                  type="button"
                  class="lightbox-tool lightbox-tool--zoom"
                  :aria-label="t('a11y.lightbox.zoomOut')"
                  :title="t('a11y.lightbox.zoomOut')"
                  :disabled="zoom.scale <= MIN_SCALE"
                  @click="zoomer.zoomBy(1 / ZOOM_STEP)"
                >
                  <Icon name="zoom-out" :size="20" />
                </button>
                <button
                  type="button"
                  class="lightbox-tool lightbox-tool--zoom"
                  :aria-label="t('a11y.lightbox.zoomIn')"
                  :title="t('a11y.lightbox.zoomIn')"
                  :disabled="zoom.scale >= zoomer.maxScale()"
                  data-testid="lightbox-zoom-in"
                  @click="zoomer.zoomBy(ZOOM_STEP)"
                >
                  <Icon name="zoom-in" :size="20" />
                </button>
                <button
                  type="button"
                  class="lightbox-tool"
                  :aria-label="t('a11y.lightbox.rotateRight')"
                  :title="t('a11y.lightbox.rotateRight')"
                  @click="zoomer.rotateBy(90)"
                >
                  <Icon name="rotate-cw" :size="20" />
                </button>
              </template>
              <button
                v-if="canDownload"
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
            @pointerdown="gestures.onPointerDown"
            @wheel="gestures.onWheel"
            @dblclick="gestures.onDoubleClick"
            @click="gestures.onStageClick"
          >
            <div class="lightbox-slide" :style="slideStyle">
              <LoadingSpinner v-if="currentItem && pending" :key="`pending-${index}`" />
              <img
                v-else-if="currentItem && isImage"
                ref="imageEl"
                :key="`image-${index}`"
                :src="currentSrc"
                :alt="currentAlt"
                class="media-content media-image"
                :style="imageStyle"
                draggable="false"
                @load="zoomer.measure()"
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
              <iframe
                v-else-if="currentItem && isPdf"
                ref="frameEl"
                :key="`pdf-${index}`"
                :src="currentSrc"
                :title="mediaLabel"
                class="media-pdf-frame"
              />
              <div
                v-else-if="currentItem && isFile"
                ref="frameEl"
                :key="`file-${index}`"
                class="media-file-card"
              >
                <Icon name="file" :size="48" />
                <p v-if="currentName" class="media-file-name">{{ currentName }}</p>
                <p class="media-file-note">{{ t('a11y.lightbox.noPreview') }}</p>
                <button v-if="canDownload" type="button" class="media-file-download" @click="downloadCurrent">
                  <Icon name="download" :size="16" />{{ t('a11y.lightbox.download') }}
                </button>
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
                  :loop="isGifv || loop"
                  :muted="isGifv || mutedLast"
                  @loadedmetadata="onMediaLoaded"
                  @volumechange="onVolumeChange"
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
import { computed, nextTick, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { useT } from '@/composables/useT';
import Icon from '@/components/common/Icon.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import VideoControls from '@/components/common/VideoControls.vue';
import XPostFrame from '@/components/embeds/XPostFrame.vue';
import { useNativeVideoControls } from '@/composables/useVideoPlayerPreference';
import { useDialog } from '@/composables/useDialog';
import { useMediaZoom } from '@/composables/useMediaZoom';
import { useMediaGestures } from '@/composables/useMediaGestures';
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
import { MIN_SCALE, ZOOM_STEP, type Size } from '@/utils/lightboxGestures';

/** `unavailable`: no source can be read (signing failed); the item shows as a file card. */
interface ItemFields { src: string; alt?: string; name?: string; unavailable?: boolean }

export type LightboxItem =
  | string
  | (ItemFields & { type?: 'image' })
  | (ItemFields & { type: 'video'; poster?: string; isGifv?: boolean })
  | (ItemFields & { type: 'audio'; poster?: string })
  | (ItemFields & { type: 'embed'; poster?: string })
  | (ItemFields & { type: 'pdf' })
  | (ItemFields & { type: 'file' });

type ItemType = 'image' | 'video' | 'audio' | 'embed' | 'pdf' | 'file';

/** localStorage: 'true' while the viewer's video and audio play muted, under `rememberMute`. */
const MUTE_KEY = 'harmony-lightbox-video-muted';

interface Props {
  visible: boolean;
  imgs: LightboxItem[];
  /** Text alternatives by index, for string items. */
  alts?: string[];
  /** Inline player of the item at the opening index; see the header. */
  origin?: HTMLMediaElement | null;
  /**
   * Download button for the current item. True: the item's `src` saves under its name. A
   * function: called with the index instead, for items whose download URL differs from `src`.
   */
  download?: boolean | ((index: number) => void);
  /** Video and audio start on their own, unless reduced motion is asked for. */
  autoplay?: boolean;
  /** Video and audio repeat. */
  loop?: boolean;
  /** Video and audio start muted when the viewer was last left muted (MUTE_KEY). */
  rememberMute?: boolean;
  /** Teleport target. Default: the portal target of the subtree (usePortalTarget). */
  to?: string | HTMLElement;
}

const props = withDefaults(defineProps<Props>(), {
  alts: undefined,
  origin: null,
  download: false,
  autoplay: false,
  loop: false,
  rememberMute: false,
  to: undefined,
});

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

function itemType(item: LightboxItem | undefined): ItemType {
  if (!item || typeof item === 'string') return 'image';
  if (item.unavailable) return 'file';
  return item.type ?? 'image';
}

const items = computed(() => props.imgs || []);
const currentItem = computed<LightboxItem | undefined>(() => items.value[index.value]);
const currentType = computed(() => itemType(currentItem.value));
const isImage = computed(() => !!currentItem.value && currentType.value === 'image');
const isAudio = computed(() => currentType.value === 'audio');
const isEmbed = computed(() => currentType.value === 'embed');
const isPdf = computed(() => currentType.value === 'pdf');
const isFile = computed(() => currentType.value === 'file');
const currentSrc = computed(() => {
  const item = currentItem.value;
  if (!item) return '';
  return typeof item === 'string' ? item : item.src;
});
/** The source is not known yet (a private object still signing); a file card reads none. */
const pending = computed(() => !isFile.value && !currentSrc.value);
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
const canDownload = computed(
  () => !!props.download && !isEmbed.value && (typeof props.download === 'function' || !!currentSrc.value),
);

// GIF-style clips, and every video and audio item under `autoplay`, start on their own unless
// reduced motion is asked for, by the OS or the appearance setting. Other media wait for the
// play control.
function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-reduce-motion') === 'true') return true;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
const autoplayCurrent = computed(
  () => (isGifv.value || (props.autoplay && isPlayable(currentItem.value))) && !prefersReducedMotion(),
);

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === 'true';
  } catch {
    return false;
  }
}

const mutedLast = ref(props.rememberMute && readMuted());

function onVolumeChange() {
  const media = videoRef.value;
  if (!props.rememberMute || !media || isGifv.value) return;
  mutedLast.value = media.muted;
  try {
    localStorage.setItem(MUTE_KEY, String(media.muted));
  } catch {
    /* storage unavailable */
  }
}

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
  zoomer.reset();
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
function stageSize(): Size {
  const box = stageEl.value?.getBoundingClientRect();
  return { width: box?.width ?? 0, height: box?.height ?? 0 };
}

function contentSize(): Size {
  const img = imageEl.value;
  return { width: img?.offsetWidth ?? 0, height: img?.offsetHeight ?? 0 };
}

/** Window of the document that shows the viewer: the main one, or the call pop-out's. */
function viewWindow(): Window {
  return overlayEl.value?.ownerDocument.defaultView ?? window;
}

// Touch adjustment retargets taps to the nearest clickable ancestor (the stage), so the
// media is found by position, not by event target.
function onMedia(clientX: number, clientY: number): boolean {
  const el = isImage.value ? imageEl.value : frameEl.value;
  if (!el) return false;
  const box = el.getBoundingClientRect();
  return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
}

function naturalSize(): Size {
  const img = imageEl.value;
  return { width: img?.naturalWidth ?? 0, height: img?.naturalHeight ?? 0 };
}

const zoomer = useMediaZoom({ content: contentSize, stage: stageSize, natural: naturalSize });
const { zoom, zoomed } = zoomer;

const gestures = useMediaGestures({
  zoomer,
  zoomable: () => isImage.value && !!imageEl.value,
  stage: () => stageEl.value,
  onMedia,
  view: viewWindow,
  hasPrevious: () => hasPrevious.value,
  hasNext: () => hasNext.value,
  previous: prev,
  next,
  dismiss: () => {
    if (fullscreen.value) void exitFullscreen(videoRef.value);
    else onHide();
  },
  close: onHide,
});
const { drag, dragging, gestureActive } = gestures;

const imageStyle = computed(() => ({
  transform: zoomer.transform.value,
  transition: gestureActive.value ? 'none' : undefined,
  cursor: gestureActive.value ? 'grabbing' : zoomed.value || zoomer.free.value ? 'grab' : 'zoom-in',
}));

const slideStyle = computed(() =>
  drag.x || drag.y ? { transform: `translate3d(${drag.x}px, ${drag.y}px, 0)` } : undefined,
);

/** Backdrop opacity, 1 at rest; a downward swipe fades it. */
const shade = computed(() => {
  const height = stageSize().height || 1;
  return drag.y > 0 ? Math.max(0.35, 1 - drag.y / height) : 1;
});

// --- Fullscreen ------------------------------------------------------------------------
const fullscreen = ref(false);
const fullscreenTarget = () => overlayEl.value;
/** Items without a player: fullscreen takes the whole viewer. */
const still = computed(() => isImage.value || isPdf.value);

const canFullscreenCurrent = ref(false);
function measureFullscreen() {
  canFullscreenCurrent.value = canFullscreen(still.value ? null : videoRef.value);
  fullscreen.value = isFullscreen(overlayEl.value, videoRef.value);
}

// Videos in Harmony's player carry their own fullscreen control.
const showFullscreenTool = computed(
  () => canFullscreenCurrent.value && (still.value || isAudio.value || isGifv.value || nativeVideoControls.value),
);

function toggleViewerFullscreen() {
  const target = overlayEl.value;
  if (!target) return;
  void toggleFullscreen(target, still.value ? null : videoRef.value);
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
  if (typeof props.download === 'function') {
    props.download(index.value);
    return;
  }
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
  else if (isImage.value && (e.key === '+' || e.key === '=')) zoomer.zoomBy(ZOOM_STEP);
  else if (isImage.value && e.key === '-') zoomer.zoomBy(1 / ZOOM_STEP);
  else if (isImage.value && e.key === '0') zoomer.reset();
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

// Rotation and orientation changes keep the zoomed image inside the stage.
let resizing: Window | null = null;
function listenResize(view: Window | null) {
  resizing?.removeEventListener('resize', zoomer.refit);
  resizing = view;
  resizing?.addEventListener('resize', zoomer.refit);
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
  gestures.stop();
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
  background: rgb(var(--viewer-scrim) / calc(var(--viewer-scrim-alpha) * var(--lightbox-shade)));
  -webkit-backdrop-filter: blur(var(--viewer-blur));
  backdrop-filter: blur(var(--viewer-blur));
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
  background: var(--viewer-control-bg);
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
  background: var(--viewer-control-bg-hover);
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

.media-pdf-frame {
  width: min(960px, 100cqw);
  height: 100cqh;
  border: none;
  border-radius: var(--radius-sm);
  background: #fff;
}

.media-file-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  max-width: min(420px, 100cqw);
  padding: var(--space-6);
  text-align: center;
  color: rgb(255 255 255 / 0.85);
}

.media-file-card p {
  margin: 0;
}

.media-file-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: #fff;
}

.media-file-download {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 40px;
  padding: 0 var(--space-4);
  border: none;
  border-radius: var(--radius-full);
  background: var(--viewer-control-bg);
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.media-file-download:hover {
  background: var(--viewer-control-bg-hover);
}

.media-file-download:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
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
