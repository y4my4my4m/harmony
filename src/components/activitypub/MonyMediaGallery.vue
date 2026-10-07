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
      :role="shouldOpenLightbox(media) && showSensitive ? 'button' : undefined"
      :tabindex="shouldOpenLightbox(media) && showSensitive ? 0 : undefined"
      :aria-label="shouldOpenLightbox(media) && showSensitive ? (media.description || t('activitypub.openMedia')) : undefined"
      @click.capture="handleMediaClick($event, index, media)"
      @keydown.enter.self="shouldOpenLightbox(media) && showSensitive && openMedia(index)"
    >
      <!-- Image -->
      <img
        v-if="media.type === 'image'"
        :src="media.preview_url || media.url"
        :alt="media.description || 'Image'"
        class="media-image"
        :style="coverStyle(media)"
        loading="lazy"
        @error="handleImageError"
      />

      <!-- Video / GIFV -->
      <video
        v-else-if="media.type === 'video' || media.type === 'gifv' || (media.type === 'unknown' && isVideoUrl(media.url))"
        :src="media.url"
        :poster="media.preview_url"
        class="media-video"
        :style="coverStyle(media)"
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
        <a :href="safeHref(media.url)" target="_blank" class="download-btn">
          <Icon name="download" />
        </a>
      </div>

      <!-- Mobile download affordance (no right-click / long-press save on touch) -->
      <button
        v-if="canDownloadMedia(media) && showSensitive"
        type="button"
        class="media-download-overlay"
        aria-label="Download"
        title="Download"
        @click.stop="downloadMedia(media)"
      >
        <Icon name="download" />
      </button>

      <button
        v-if="media.description && showSensitive"
        type="button"
        class="alt-badge"
        :aria-expanded="showAltText"
        :title="t('activitypub.altTextShow')"
        @click.stop="showAltText = !showAltText"
      >
        ALT
      </button>

      <!-- Media description (alt text) -->
      <div v-if="media.description && showAltText && showSensitive" class="media-description">
        {{ media.description }}
      </div>
    </div>

    <!-- One overlay for the whole gallery; the media stays blurred until revealed. -->
    <button
      v-if="isSensitive && !showSensitive"
      type="button"
      class="sensitive-overlay"
      @click.stop="showSensitive = true"
    >
      <span class="sensitive-title">{{ t('activitypub.sensitiveContent') }}</span>
      <span class="sensitive-hint">{{ t('activitypub.clickToShow') }}</span>
    </button>
    <button
      v-else-if="isSensitive"
      type="button"
      class="sensitive-hide-btn"
      :aria-label="t('activitypub.hideMedia')"
      :title="t('activitypub.hideMedia')"
      @click.stop="showSensitive = false"
    >
      <Icon name="eye-off" :size="16" />
    </button>
  </div>

  <MonyMediaLightbox
    v-model:index="currentMediaIndex"
    :visible="showModal"
    :media="viewableMedia"
    @hide="showModal = false"
  />
</template>

<script setup lang="ts">
import { safeHref } from '@/utils/sanitize';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { debug } from '@/utils/debug'
import type { MediaAttachment } from '@/types';
import Icon from '@/components/common/Icon.vue';
import MonyMediaLightbox from './MonyMediaLightbox.vue';
import { downloadMediaFromUrl, filenameFromUrl } from '@/utils/downloadMedia';
import { attachmentObjectPosition } from '@/utils/focalPoint';

interface Props {
  mediaAttachments: MediaAttachment[];
  isSensitive?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isSensitive: false
});

const { t } = useI18n();

// State
const galleryRef = ref<HTMLElement | null>(null);
const showSensitive = ref(!props.isSensitive);
const showAltText = ref(false);
const showModal = ref(false);
const currentMediaIndex = ref(0);

// Pause all gallery videos when lightbox opens to avoid double audio
watch(showModal, (visible) => {
  if (visible && galleryRef.value) {
    galleryRef.value.querySelectorAll<HTMLVideoElement>('video').forEach((v) => v.pause());
  }
});

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

// Multi-item cells are object-fit: cover; a single item is contain and stays centred.
function coverStyle(media: MediaAttachment): Record<string, string> | undefined {
  if (props.mediaAttachments.length < 2) return undefined;
  const position = attachmentObjectPosition(media);
  return position ? { objectPosition: position } : undefined;
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|ogv|mov|gif)(\?|$)/i.test(url);
}

const viewableMedia = computed(() => props.mediaAttachments.filter(isViewableMedia));
const viewableCount = computed(() => viewableMedia.value.length);

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
  if (props.isSensitive && !showSensitive.value) return;
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
</script>

<style scoped>
.media-gallery {
  margin-top: 0.75rem;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
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
  aspect-ratio: 16 / 9;
}

.media-gallery.triple {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 2px;
  aspect-ratio: 16 / 9;
}

.media-gallery.triple .media-item:first-child {
  grid-row: 1 / 3;
}

.media-gallery.quad {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 2px;
  aspect-ratio: 16 / 9;
}

.media-item {
  position: relative;
  min-height: 0;
  background: var(--background-secondary);
  overflow: hidden;
  transition: opacity 0.2s;
}

.media-gallery.sensitive .media-image,
.media-gallery.sensitive .media-video {
  filter: blur(28px);
  transform: scale(1.1);
}

.media-item-clickable {
  cursor: pointer;
}

.media-item-clickable:hover {
  opacity: 0.9;
}

.media-item-clickable:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: -2px;
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
  background: var(--background-tertiary);
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
  color: var(--h-brand, var(--harmony-primary));
  text-decoration: none;
  padding: 0.5rem;
  border-radius: 6px;
  transition: background 0.2s;
}

.download-btn:hover {
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
}

.sensitive-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 120px;
  border: none;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font: inherit;
  cursor: pointer;
}

.sensitive-overlay:hover {
  background: rgba(0, 0, 0, 0.55);
}

.media-gallery.single.sensitive {
  min-height: 160px;
}

.sensitive-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
}

.sensitive-hint {
  font-size: var(--font-size-sm);
  opacity: 0.85;
}

.sensitive-hide-btn {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-md);
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  cursor: pointer;
}

.alt-badge {
  position: absolute;
  left: 8px;
  bottom: 8px;
  z-index: 2;
  padding: 2px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  cursor: pointer;
}

.sensitive-overlay:focus-visible,
.sensitive-hide-btn:focus-visible,
.alt-badge:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.media-description {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 1;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  padding: 0.75rem 0.75rem 2.25rem;
  font-size: 0.875rem;
  max-height: 100%;
  overflow-y: auto;
}
</style>
