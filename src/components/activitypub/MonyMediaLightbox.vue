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
        <div role="button" aria-label="zoom in button" class="toolbar-btn toolbar-btn__zoomin" @click="videoZoomIn">
          <svg class="vel-icon" aria-hidden="true"><use href="#icon-zoomin" /></svg>
        </div>
        <div role="button" aria-label="zoom out button" class="toolbar-btn toolbar-btn__zoomout" @click="videoZoomOut">
          <svg class="vel-icon" aria-hidden="true"><use href="#icon-zoomout" /></svg>
        </div>
        <div role="button" aria-label="resize image button" class="toolbar-btn toolbar-btn__resize" @click="resetVideoTransforms">
          <svg class="vel-icon" aria-hidden="true"><use href="#icon-resize" /></svg>
        </div>
        <div role="button" aria-label="image rotate left button" class="toolbar-btn toolbar-btn__rotate" @click="videoRotateLeft">
          <svg class="vel-icon" aria-hidden="true"><use href="#icon-rotate-left" /></svg>
        </div>
        <div role="button" aria-label="image rotate right button" class="toolbar-btn toolbar-btn__rotate" @click="videoRotateRight">
          <svg class="vel-icon" aria-hidden="true"><use href="#icon-rotate-right" /></svg>
        </div>
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
          Your browser does not support the video tag.
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
import { computed, ref } from 'vue';
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
  max-width: 80vw;
  max-height: 80vh;
  background: #000;
  box-shadow: 0 5px 20px 2px rgba(0, 0, 0, 0.7);
  pointer-events: auto;
  transform-origin: center center;
  transition: transform 0.3s ease;
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
    max-width: 95vw;
    max-height: 85vh;
  }
}

@media (max-width: 750px) {
  .lightbox-actions {
    left: calc(12px + env(safe-area-inset-left, 0px));
    top: calc(12px + env(safe-area-inset-top, 0px));
  }
}
</style>
