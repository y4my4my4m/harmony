<!-- MonyMediaGallery - Display media attachments in posts -->
<template>
  <div 
    v-if="mediaAttachments && mediaAttachments.length > 0" 
    ref="galleryRef"
    class="media-gallery"
    :class="galleryClass"
  >
    <div
      v-for="(media, index) in mediaAttachments"
      :key="media.id"
      class="media-item"
      :class="{ 'media-item-clickable': shouldOpenLightbox(media) }"
      @click.capture="handleMediaClick($event, index, media)"
    >
      <!-- Image -->
      <img
        v-if="media.type === 'image'"
        :src="media.preview_url || media.url"
        :alt="media.description || 'Image'"
        class="media-image"
        loading="lazy"
        @error="handleImageError"
      />

      <!-- Video / GIFV -->
      <video
        v-else-if="media.type === 'video' || media.type === 'gifv' || (media.type === 'unknown' && isVideoUrl(media.url))"
        :src="media.url"
        :poster="media.preview_url"
        class="media-video"
        :controls="media.type !== 'gifv'"
        preload="metadata"
        :loop="media.type === 'gifv'"
        :autoplay="media.type === 'gifv'"
        :muted="media.type === 'gifv'"
        @error="handleVideoError"
      >
        <source :src="media.url" :type="media.mime_type || 'video/mp4'">
        Your browser does not support the video tag.
      </video>

      <!-- Audio -->
      <div v-else-if="media.type === 'audio'" class="media-audio">
        <div class="audio-info">
          <Icon name="music" />
          <span class="audio-title">{{ media.filename || 'Audio file' }}</span>
        </div>
        <audio :src="media.url" controls preload="metadata">
          Your browser does not support the audio tag.
        </audio>
      </div>

      <!-- Other file types -->
      <div v-else class="media-file">
        <Icon name="file" />
        <div class="file-info">
          <span class="file-name">{{ media.filename }}</span>
          <span class="file-size">{{ formatFileSize(media.size) }}</span>
        </div>
        <a :href="media.url" target="_blank" class="download-btn">
          <Icon name="download" />
        </a>
      </div>

      <!-- Sensitive content overlay - tap anywhere to reveal first, then tap again to open lightbox -->
      <div
        v-if="isSensitive && !showSensitive"
        class="sensitive-overlay"
        @click.stop="showSensitive = true"
      >
        <Icon name="eye-off" />
        <span>Sensitive content</span>
        <button class="show-btn">
          Show
        </button>
      </div>

      <!-- Mobile download affordance (no right-click / long-press save on touch) -->
      <button
        v-if="canDownloadMedia(media)"
        type="button"
        class="media-download-overlay"
        aria-label="Download"
        title="Download"
        @click.stop="downloadMedia(media)"
      >
        <Icon name="download" />
      </button>

      <!-- Media description (alt text) -->
      <div v-if="media.description && showAltText" class="media-description">
        {{ media.description }}
      </div>
    </div>

    <!-- Show/Hide sensitive content toggle -->
    <div v-if="isSensitive" class="sensitive-toggle">
      <button @click="showSensitive = !showSensitive" class="toggle-btn">
        <Icon :name="showSensitive ? 'eye-off' : 'eye'" />
        {{ showSensitive ? 'Hide' : 'Show' }} sensitive content
      </button>
    </div>

    <!-- Alt text toggle -->
    <div v-if="hasAltText" class="alt-text-toggle">
      <button @click="showAltText = !showAltText" class="toggle-btn">
        <Icon name="info" />
        {{ showAltText ? 'Hide' : 'Show' }} alt text
      </button>
    </div>
  </div>

  <!-- vue-easy-lightbox: handles images with zoom/pan/rotate/smooth scroll -->
  <vue-easy-lightbox
    teleport="body"
    :visible="showModal"
    :imgs="lightboxImages"
    :index="currentMediaIndex"
    @hide="closeModal"
    @on-index-change="onLightboxIndexChange"
  >
    <!-- Custom toolbar for video: use same structure/icons as vue-easy-lightbox default toolbar -->
    <template v-if="currentLightboxIsVideo" #toolbar>
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

  <!-- Video overlay: centered on top of vue-easy-lightbox when current item is a video -->
  <Teleport to="body">
    <Transition name="vel-fade">
      <div
        v-if="showModal && currentLightboxIsVideo"
        class="video-lightbox-overlay"
      >
        <video
          ref="lightboxVideoRef"
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

  <LightboxDownloadButton
    :visible="showModal"
    :url="currentDownloadUrl"
    :filename="currentDownloadFilename"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { debug } from '@/utils/debug'
import type { MediaAttachment } from '@/types';
import Icon from '@/components/common/Icon.vue';
import LightboxDownloadButton from '@/components/common/LightboxDownloadButton.vue';
import VueEasyLightbox from 'vue-easy-lightbox';
import { downloadMediaFromUrl, filenameFromUrl } from '@/utils/downloadMedia';

interface Props {
  mediaAttachments: MediaAttachment[];
  isSensitive?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isSensitive: false
});

const MUTE_KEY = 'harmony-lightbox-video-muted';

// State
const galleryRef = ref<HTMLElement | null>(null);
const lightboxVideoRef = ref<HTMLVideoElement | null>(null);
const showSensitive = ref(!props.isSensitive);
const showAltText = ref(false);
const showModal = ref(false);
const currentMediaIndex = ref(0);
const videoMuted = ref(localStorage.getItem(MUTE_KEY) === 'true');
const videoPositions = new Map<string, number>();

// Pause all gallery videos when lightbox opens to avoid double audio
watch(showModal, (visible) => {
  if (visible && galleryRef.value) {
    galleryRef.value.querySelectorAll<HTMLVideoElement>('video').forEach((v) => v.pause());
  }
});

function onVideoVolumeChange() {
  if (lightboxVideoRef.value) {
    videoMuted.value = lightboxVideoRef.value.muted;
    try { localStorage.setItem(MUTE_KEY, String(videoMuted.value)); } catch { /* ignore */ }
  }
}

// -- Playback position persistence --

function saveCurrentVideoPosition() {
  const video = lightboxVideoRef.value;
  const src = currentVideoSrc.value;
  if (video && src && !isNaN(video.currentTime) && video.currentTime > 0) {
    videoPositions.set(src, video.currentTime);
  }
}

function onVideoLoadedData() {
  const video = lightboxVideoRef.value;
  const src = currentVideoSrc.value;
  if (video && src) {
    const saved = videoPositions.get(src);
    if (saved !== undefined && saved > 0) {
      video.currentTime = saved;
    }
  }
}

function onLightboxIndexChange(_oldIdx: number, newIdx: number) {
  saveCurrentVideoPosition();
  resetVideoTransforms();
  currentMediaIndex.value = newIdx;
}

// -- Video transform controls (self-contained zoom/rotate applied directly to the video) --

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
  if (videoZoom.value !== 1) {
    resetVideoTransforms();
  } else {
    videoZoom.value = 2;
  }
}

// Computed
const galleryClass = computed(() => {
  const count = props.mediaAttachments.length;
  return {
    'single': count === 1,
    'double': count === 2,
    'triple': count === 3,
    'quad': count >= 4,
    'sensitive': props.isSensitive && !showSensitive.value
  };
});

const hasAltText = computed(() => {
  return props.mediaAttachments.some(media => media.description);
});

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|ogv|mov|gif)(\?|$)/i.test(url);
}

const viewableCount = computed(() =>
  props.mediaAttachments.filter(
    (m) =>
      m.type === 'image' ||
      m.type === 'video' ||
      m.type === 'gifv' ||
      (m.type === 'unknown' && isVideoUrl(m.url))
  ).length
);

const viewableMedia = computed(() =>
  props.mediaAttachments.filter(
    (m) => m.type === 'image' || m.type === 'video' || m.type === 'gifv' || (m.type === 'unknown' && isVideoUrl(m.url))
  )
);

const lightboxImages = computed(() =>
  viewableMedia.value.map((media) => {
    if (isVideoMedia(media)) {
      return { src: media.preview_url || media.url, title: media.description };
    }
    return { src: media.url, title: media.description };
  })
);

const currentLightboxIsVideo = computed(() => {
  const media = viewableMedia.value[currentMediaIndex.value];
  return media ? isVideoMedia(media) : false;
});

const currentVideoSrc = computed(() => {
  const media = viewableMedia.value[currentMediaIndex.value];
  return media?.url ?? '';
});

const currentVideoPoster = computed(() => {
  const media = viewableMedia.value[currentMediaIndex.value];
  return media?.preview_url;
});

const currentDownloadUrl = computed(() => {
  const media = viewableMedia.value[currentMediaIndex.value] ?? props.mediaAttachments[currentMediaIndex.value];
  return media?.url ?? '';
});

const currentDownloadFilename = computed(() => {
  const media = viewableMedia.value[currentMediaIndex.value] ?? props.mediaAttachments[currentMediaIndex.value];
  if (!media) return undefined;
  return media.filename || filenameFromUrl(media.url, media.type || 'media');
});

function canDownloadMedia(media: MediaAttachment): boolean {
  return Boolean(media.url);
}

async function downloadMedia(media: MediaAttachment) {
  if (!media.url) return;
  const filename = media.filename || filenameFromUrl(media.url, media.type || 'media');
  await downloadMediaFromUrl(media.url, filename);
}

// Methods
const formatFileSize = (bytes?: number): string => {
  if (!bytes) return '';
  
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
};

const handleImageError = (event: Event) => {
  const img = event.target as HTMLImageElement;
  img.style.display = 'none';
  debug.warn('Failed to load image:', img.src);
};

const handleVideoError = (event: Event) => {
  const video = event.target as HTMLVideoElement;
  debug.warn('Failed to load video:', video.src);
};

function isViewableMedia(media: MediaAttachment): boolean {
  return media.type === 'image' || media.type === 'video' || media.type === 'gifv' || (media.type === 'unknown' && isVideoUrl(media.url));
}

function isVideoMedia(media: MediaAttachment): boolean {
  return media.type === 'video' || media.type === 'gifv' || (media.type === 'unknown' && isVideoUrl(media.url));
}

function shouldOpenLightbox(media: MediaAttachment): boolean {
  if (!isViewableMedia(media)) return false;
  if (viewableCount.value === 1 && isVideoMedia(media)) return false;
  return true;
}

function handleMediaClick(e: MouseEvent, index: number, media: MediaAttachment) {
  if (!isViewableMedia(media)) return;
  if (viewableCount.value === 1 && isVideoMedia(media)) return;
  e.preventDefault();
  e.stopPropagation();
  openMedia(index);
}

const openMedia = (index: number) => {
  const media = props.mediaAttachments[index];
  if (!isViewableMedia(media)) return;
  let lightboxIndex = 0;
  for (let i = 0; i < index; i++) {
    const m = props.mediaAttachments[i];
    if (isViewableMedia(m)) lightboxIndex++;
  }
  currentMediaIndex.value = lightboxIndex;
  showModal.value = true;
};

const closeModal = () => {
  saveCurrentVideoPosition();
  resetVideoTransforms();
  showModal.value = false;
};
</script>

<style scoped>
.media-gallery {
  margin-top: 0.75rem;
  border-radius: 12px;
  overflow: hidden;
  position: relative;
}

.media-gallery.single {
  display: block;
}

.media-gallery.double {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
}

.media-gallery.triple {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 2px;
}

.media-gallery.triple .media-item:first-child {
  grid-row: 1 / 3;
}

.media-gallery.quad {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 2px;
}

.media-item {
  position: relative;
  background: var(--background-secondary, #313338);
  overflow: hidden;
  transition: opacity 0.2s;
}

.media-item-clickable {
  cursor: pointer;
}

.media-item-clickable:hover {
  opacity: 0.9;
}

.media-download-overlay {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: none;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

@media (max-width: 768px) {
  .media-download-overlay {
    display: flex;
  }
}

@media (pointer: fine) {
  .media-item:hover .media-download-overlay {
    display: flex;
  }
}

.media-image,
.media-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.media-gallery.single .media-image,
.media-gallery.single .media-video {
  max-height: 400px;
  object-fit: contain;
  background: black;
}

.media-audio {
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 100px;
  justify-content: center;
}

.audio-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-primary);
}

.audio-title {
  font-weight: 500;
}

.media-file {
  padding: 1rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 80px;
  color: var(--text-primary);
}

.file-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.file-name {
  font-weight: 500;
}

.file-size {
  font-size: 0.875rem;
  color: #80848e;
}

.download-btn {
  color: var(--h-brand, #0EA5E9);
  text-decoration: none;
  padding: 0.5rem;
  border-radius: 6px;
  transition: background 0.2s;
}

.download-btn:hover {
  background: rgba(14, 165, 233, 0.1);
}

.sensitive-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
  gap: 0.5rem;
  backdrop-filter: blur(20px);
}

.show-btn {
  background: var(--h-brand, #0EA5E9);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-weight: 500;
  transition: background 0.2s;
}

.show-btn:hover {
  background: #0284C7;
}

.media-description {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.8));
  color: var(--text-primary);
  padding: 1rem;
  font-size: 0.875rem;
}

.sensitive-toggle,
.alt-text-toggle {
  margin-top: 0.5rem;
}

.toggle-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: none;
  border: none;
  color: #80848e;
  cursor: pointer;
  font-size: 0.875rem;
  transition: color 0.2s;
}

.toggle-btn:hover {
  color: var(--text-primary);
}

/* Video overlay: centered on top of lightbox, lets chrome (close, arrows, toolbar) show through */
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

/* Mobile responsiveness */
@media (max-width: 768px) {
  .media-gallery.triple,
  .media-gallery.quad {
    grid-template-columns: 1fr;
    grid-template-rows: auto;
  }
  
  .media-gallery.triple .media-item:first-child {
    grid-row: auto;
  }

  .video-lightbox-player {
    max-width: 95vw;
    max-height: 85vh;
  }
}
</style>
