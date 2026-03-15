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
    class="lightbox"
    :visible="showModal"
    :imgs="lightboxImages"
    :index="currentMediaIndex"
    :move-disabled="currentLightboxIsVideo"
    :zoom-disabled="currentLightboxIsVideo"
    :rotate-disabled="currentLightboxIsVideo"
    :dblclick-disabled="currentLightboxIsVideo"
    @hide="closeModal"
    @on-index-change="onLightboxIndexChange"
  />

  <!-- Video overlay: shown on top of vue-easy-lightbox when current item is a video -->
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
          controls
          autoplay
          preload="auto"
          playsinline
          :muted="videoMuted"
          @volumechange="onVideoVolumeChange"
        >
          Your browser does not support the video tag.
        </video>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from 'vue';
import { debug } from '@/utils/debug'
import type { MediaAttachment } from '@/types';
import Icon from '@/components/common/Icon.vue';
import VueEasyLightbox from 'vue-easy-lightbox';

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

function onLightboxIndexChange(_old: number, newIdx: number) {
  currentMediaIndex.value = newIdx;
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

// Prepare items for MediaLightbox (images + videos)
const viewableCount = computed(() =>
  props.mediaAttachments.filter(
    (m) =>
      m.type === 'image' ||
      m.type === 'video' ||
      m.type === 'gifv' ||
      (m.type === 'unknown' && isVideoUrl(m.url))
  ).length
);

// Viewable media items with their original data preserved for video overlay
const viewableMedia = computed(() =>
  props.mediaAttachments.filter(
    (m) => m.type === 'image' || m.type === 'video' || m.type === 'gifv' || (m.type === 'unknown' && isVideoUrl(m.url))
  )
);

// For vue-easy-lightbox: pass poster/preview for videos so it shows a thumbnail (no error state)
const lightboxImages = computed(() =>
  viewableMedia.value.map((media) => {
    if (isVideoMedia(media)) {
      return { src: media.preview_url || media.url, title: media.description };
    }
    return { src: media.url, title: media.description };
  })
);

// Video overlay state
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

// Hide lightbox toolbar when video overlay is active (zoom/rotate don't apply to video)
watch([showModal, currentLightboxIsVideo], ([visible, isVideo]) => {
  document.body.classList.toggle('vel-video-active', !!(visible && isVideo));
});
onUnmounted(() => document.body.classList.remove('vel-video-active'));

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
  // Single video: play in place, no lightbox
  if (viewableCount.value === 1 && isVideoMedia(media)) return false;
  return true;
}

function handleMediaClick(e: MouseEvent, index: number, media: MediaAttachment) {
  if (!isViewableMedia(media)) return;
  // Single video: don't open lightbox, let the video play in place
  if (viewableCount.value === 1 && isVideoMedia(media)) return;
  e.preventDefault();
  e.stopPropagation();
  openMedia(index);
}

const openMedia = (index: number) => {
  const media = props.mediaAttachments[index];
  if (!isViewableMedia(media)) return;
  // Find the corresponding index in the lightbox images array
  let lightboxIndex = 0;
  for (let i = 0; i < index; i++) {
    const m = props.mediaAttachments[i];
    if (isViewableMedia(m)) lightboxIndex++;
  }
  currentMediaIndex.value = lightboxIndex;
  showModal.value = true;
};

const closeModal = () => {
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
  background: var(--h-chat, #313338);
  overflow: hidden;
  transition: opacity 0.2s;
}

.media-item-clickable {
  cursor: pointer;
}

.media-item-clickable:hover {
  opacity: 0.9;
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
  color: var(--h-brand, #5865f2);
  text-decoration: none;
  padding: 0.5rem;
  border-radius: 6px;
  transition: background 0.2s;
}

.download-btn:hover {
  background: rgba(88, 101, 242, 0.1);
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
  background: var(--h-brand, #5865f2);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-weight: 500;
  transition: background 0.2s;
}

.show-btn:hover {
  background: #4752c4;
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

/* Video overlay on top of vue-easy-lightbox (covers the poster image, lets chrome show through) */
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

<style>
/* Global (unscoped): hide lightbox toolbar when video overlay is active */
body.vel-video-active .vel-toolbar {
  display: none !important;
}
</style>
