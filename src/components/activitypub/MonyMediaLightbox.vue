<!-- MonyMediaLightbox - Full-screen viewer for post media: vue-easy-lightbox for images, a centred player for video -->
<template>
  <vue-easy-lightbox
    teleport="body"
    :visible="visible"
    :imgs="lightboxImages"
    :index="index"
    @hide="close"
    @on-index-change="onLightboxIndexChange"
  >
    <!-- Video toolbar: same structure and icons as the vue-easy-lightbox default toolbar -->
    <template v-if="currentIsVideo" #toolbar>
      <div class="vel-toolbar">
        <button type="button" :aria-label="t('a11y.lightbox.zoomIn')" :title="t('a11y.lightbox.zoomIn')" class="toolbar-btn toolbar-btn__zoomin" @click="videoZoomIn">
          <svg class="vel-icon" aria-hidden="true"><use href="#icon-zoomin" /></svg>
        </button>
        <button type="button" :aria-label="t('a11y.lightbox.zoomOut')" :title="t('a11y.lightbox.zoomOut')" class="toolbar-btn toolbar-btn__zoomout" @click="videoZoomOut">
          <svg class="vel-icon" aria-hidden="true"><use href="#icon-zoomout" /></svg>
        </button>
        <button type="button" :aria-label="t('a11y.lightbox.resetZoom')" :title="t('a11y.lightbox.resetZoom')" class="toolbar-btn toolbar-btn__resize" @click="resetVideoTransforms">
          <svg class="vel-icon" aria-hidden="true"><use href="#icon-resize" /></svg>
        </button>
        <button type="button" :aria-label="t('a11y.lightbox.rotateLeft')" :title="t('a11y.lightbox.rotateLeft')" class="toolbar-btn toolbar-btn__rotate" @click="videoRotateLeft">
          <svg class="vel-icon" aria-hidden="true"><use href="#icon-rotate-left" /></svg>
        </button>
        <button type="button" :aria-label="t('a11y.lightbox.rotateRight')" :title="t('a11y.lightbox.rotateRight')" class="toolbar-btn toolbar-btn__rotate" @click="videoRotateRight">
          <svg class="vel-icon" aria-hidden="true"><use href="#icon-rotate-right" /></svg>
        </button>
      </div>
    </template>
  </vue-easy-lightbox>

  <!-- Video layer above vue-easy-lightbox; its close, arrows and toolbar stay clickable around it. -->
  <Teleport to="body">
    <Transition name="vel-fade">
      <div
        v-if="visible && currentIsVideo"
        class="video-lightbox-overlay"
      >
        <video
          ref="videoRef"
          :key="currentVideoSrc"
          :src="currentVideoSrc"
          :poster="currentVideoPoster"
          class="video-lightbox-player"
          :style="{ transform: videoTransformStyle }"
          controls
          autoplay
          preload="auto"
          playsinline
          loop
          :muted="videoMuted"
          @volumechange="onVideoVolumeChange"
          @loadeddata="onVideoLoadedData"
          @wheel.prevent="onVideoWheel"
          @dblclick.prevent="onVideoDblClick"
        >
          {{ t('a11y.lightbox.videoUnsupported') }}
        </video>
      </div>
    </Transition>
  </Teleport>

  <Teleport v-if="$slots.actions" to="body">
    <div v-if="visible" class="lightbox-actions">
      <slot name="actions" :index="index" />
    </div>
  </Teleport>

  <LightboxDownloadButton
    :visible="visible"
    :url="currentDownloadUrl"
    :filename="currentDownloadFilename"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useT } from '@/composables/useT';
import { patchRoleButtons, roleButtonKeyActivation } from '@/utils/a11y/roleButtons';
import type { MediaAttachment } from '@/types';
import LightboxDownloadButton from '@/components/common/LightboxDownloadButton.vue';
import VueEasyLightbox from 'vue-easy-lightbox';
import { filenameFromUrl } from '@/utils/downloadMedia';

interface Props {
  visible: boolean;
  /** Viewable items only: image, video, gifv. */
  media: MediaAttachment[];
}

const props = defineProps<Props>();
const index = defineModel<number>('index', { default: 0 });
const emit = defineEmits<{ hide: [] }>();

const MUTE_KEY = 'harmony-lightbox-video-muted';

const { t } = useT();

// vue-easy-lightbox renders <div role="button"> without a tab stop and with
// English names; the modal is patched while it is open.
const LIBRARY_LABELS: Record<string, string> = {
  'close image preview button': 'common.close',
  'previous image button': 'a11y.lightbox.previous',
  'next image button': 'a11y.lightbox.next',
  'zoom in button': 'a11y.lightbox.zoomIn',
  'zoom out button': 'a11y.lightbox.zoomOut',
  'resize image button': 'a11y.lightbox.resetZoom',
  'image rotate left button': 'a11y.lightbox.rotateLeft',
  'image rotate right button': 'a11y.lightbox.rotateRight',
};
const libraryModal = () => document.querySelector('.vel-modal');
const onLibraryKeydown = roleButtonKeyActivation(libraryModal);
let libraryObserver: MutationObserver | null = null;

function patchLibrary() {
  const modal = libraryModal();
  if (!modal) return;
  patchRoleButtons(modal, (original) => (LIBRARY_LABELS[original] ? t(LIBRARY_LABELS[original]) : undefined));
}

function stopLibraryPatching() {
  libraryObserver?.disconnect();
  libraryObserver = null;
  document.removeEventListener('keydown', onLibraryKeydown, true);
}

watch(
  () => props.visible,
  async (open) => {
    stopLibraryPatching();
    if (!open) return;
    await nextTick();
    patchLibrary();
    const modal = libraryModal();
    if (modal && typeof MutationObserver !== 'undefined') {
      libraryObserver = new MutationObserver(patchLibrary);
      libraryObserver.observe(modal, { childList: true, subtree: true });
    }
    document.addEventListener('keydown', onLibraryKeydown, true);
  },
  { immediate: true },
);

onBeforeUnmount(stopLibraryPatching);

const videoRef = ref<HTMLVideoElement | null>(null);
const videoMuted = ref(readMuted());
const videoPositions = new Map<string, number>();

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === 'true';
  } catch {
    return false;
  }
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|ogv|mov|gif)(\?|$)/i.test(url);
}

function isVideoMedia(media: MediaAttachment): boolean {
  return media.type === 'video' || media.type === 'gifv' || (media.type === 'unknown' && isVideoUrl(media.url));
}

const lightboxImages = computed(() =>
  props.media.map((media) => ({
    src: isVideoMedia(media) ? (media.preview_url || media.url) : media.url,
    title: media.description,
    alt: media.description || '',
  }))
);

const current = computed<MediaAttachment | undefined>(() => props.media[index.value]);
const currentIsVideo = computed(() => (current.value ? isVideoMedia(current.value) : false));
const currentVideoSrc = computed(() => current.value?.url ?? '');
const currentVideoPoster = computed(() => current.value?.preview_url);
const currentDownloadUrl = computed(() => current.value?.url ?? '');
const currentDownloadFilename = computed(() => {
  const media = current.value;
  if (!media) return undefined;
  return media.filename || filenameFromUrl(media.url, media.type || 'media');
});

function onVideoVolumeChange() {
  if (!videoRef.value) return;
  videoMuted.value = videoRef.value.muted;
  try { localStorage.setItem(MUTE_KEY, String(videoMuted.value)); } catch { /* storage unavailable */ }
}

function saveCurrentVideoPosition() {
  const video = videoRef.value;
  const src = currentVideoSrc.value;
  if (video && src && !isNaN(video.currentTime) && video.currentTime > 0) {
    videoPositions.set(src, video.currentTime);
  }
}

function onVideoLoadedData() {
  const video = videoRef.value;
  const saved = videoPositions.get(currentVideoSrc.value);
  if (video && saved !== undefined && saved > 0) video.currentTime = saved;
}

function onLightboxIndexChange(_oldIdx: number, newIdx: number) {
  saveCurrentVideoPosition();
  resetVideoTransforms();
  index.value = newIdx;
}

function close() {
  saveCurrentVideoPosition();
  resetVideoTransforms();
  emit('hide');
}

// Zoom and rotate apply to the video element directly; vue-easy-lightbox transforms only its <img>.
const videoZoom = ref(1);
const videoRotation = ref(0);

const videoTransformStyle = computed(() => {
  if (videoZoom.value === 1 && videoRotation.value === 0) return '';
  return `scale(${videoZoom.value}) rotate(${videoRotation.value}deg)`;
});

function videoZoomIn() {
  videoZoom.value = Math.min(videoZoom.value * 1.25, 10);
}
function videoZoomOut() {
  videoZoom.value = Math.max(videoZoom.value / 1.25, 0.1);
}
function videoRotateLeft() {
  videoRotation.value -= 90;
}
function videoRotateRight() {
  videoRotation.value += 90;
}
function resetVideoTransforms() {
  videoZoom.value = 1;
  videoRotation.value = 0;
}

function onVideoWheel(e: WheelEvent) {
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  videoZoom.value = Math.max(0.1, Math.min(10, videoZoom.value * factor));
}

function onVideoDblClick() {
  if (videoZoom.value !== 1) resetVideoTransforms();
  else videoZoom.value = 2;
}
</script>

<style scoped>
.video-lightbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.video-lightbox-player {
  max-width: calc(80 * var(--app-vw));
  max-height: calc(80 * var(--app-vh));
  background: #000;
  box-shadow: 0 5px 20px 2px rgba(0, 0, 0, 0.7);
  pointer-events: auto;
  transform-origin: center center;
  transition: transform 0.3s ease;
}

/* The video toolbar uses <button>s; the library styles divs. */
:global(.vel-toolbar button.toolbar-btn) {
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  margin: 0;
}

:global(.vel-modal [role='button']:focus-visible),
:global(.vel-toolbar button.toolbar-btn:focus-visible) {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

/* Top-left: the close button holds top-right, the toolbar and title the bottom centre.
   Above the video layer (9999). */
.lightbox-actions {
  position: fixed;
  left: 16px;
  top: 16px;
  z-index: 10001;
  display: flex;
  gap: var(--space-2);
}

@media (max-width: 768px) {
  .video-lightbox-player {
    max-width: calc(95 * var(--app-vw));
    max-height: calc(85 * var(--app-vh));
  }
}

@media (max-width: 750px) {
  .lightbox-actions {
    left: calc(12px + env(safe-area-inset-left, 0px));
    top: calc(12px + env(safe-area-inset-top, 0px));
  }
}
</style>
