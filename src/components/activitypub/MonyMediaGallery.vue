<!-- MonyMediaGallery - Display media attachments in posts -->
<template>
  <div 
    v-if="mediaAttachments && mediaAttachments.length > 0" 
    class="media-gallery"
    :class="galleryClass"
  >
    <div
      v-for="(media, index) in mediaAttachments"
      :key="media.id"
      class="media-item"
      @click="openMedia(index)"
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

      <!-- Video -->
      <video
        v-else-if="media.type === 'video'"
        :src="media.url"
        :poster="media.preview_url"
        class="media-video"
        controls
        preload="metadata"
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

      <!-- Sensitive content overlay -->
      <div v-if="isSensitive && !showSensitive" class="sensitive-overlay">
        <Icon name="eye-off" />
        <span>Sensitive content</span>
        <button @click.stop="showSensitive = true" class="show-btn">
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

  <!-- vue-easy-lightbox for Media Modal -->
  <vue-easy-lightbox
    class="lightbox"
    :visible="showModal"
    :imgs="lightboxImages"
    :index="currentMediaIndex"
    @hide="closeModal"
  />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
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

// State
const showSensitive = ref(!props.isSensitive);
const showAltText = ref(false);
const showModal = ref(false);
const currentMediaIndex = ref(0);

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

const currentMedia = computed(() => {
  return props.mediaAttachments[currentMediaIndex.value];
});

// Prepare images for vue-easy-lightbox
const lightboxImages = computed(() => {
  return props.mediaAttachments
    .filter(media => media.type === 'image' || media.type === 'video')
    .map(media => {
      if (media.type === 'image') {
        return media.url;
      } else if (media.type === 'video') {
        // vue-easy-lightbox supports videos
        return {
          src: media.url,
          type: 'video'
        };
      }
      return media.url;
    });
});

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

const openMedia = (index: number) => {
  const media = props.mediaAttachments[index];
  if (media.type === 'image' || media.type === 'video') {
    // Find the corresponding index in the lightbox images array
    let lightboxIndex = 0;
    for (let i = 0; i < index; i++) {
      if (props.mediaAttachments[i].type === 'image' || props.mediaAttachments[i].type === 'video') {
        lightboxIndex++;
      }
    }
    currentMediaIndex.value = lightboxIndex;
    showModal.value = true;
  }
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
  cursor: pointer;
  transition: opacity 0.2s;
}

.media-item:hover {
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

/* Modal Styles */
.media-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.95);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  padding: 2rem;
}

.media-modal {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.modal-close-btn {
  position: absolute;
  top: -3rem;
  right: 0;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: var(--text-primary);
  width: 40px;
  height: 40px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
  z-index: 10;
}

.modal-close-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.nav-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: var(--text-primary);
  width: 48px;
  height: 48px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
  z-index: 10;
}

.nav-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.prev-btn {
  left: -4rem;
}

.next-btn {
  right: -4rem;
}

.modal-media {
  max-width: 100%;
  max-height: 80vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-image,
.modal-video {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.media-info {
  margin-top: 1rem;
  text-align: center;
  color: var(--text-primary);
}

.media-meta {
  margin-top: 0.5rem;
  color: #80848e;
  font-size: 0.875rem;
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
  
  .media-modal-overlay {
    padding: 1rem;
  }
  
  .nav-btn {
    width: 40px;
    height: 40px;
  }
  
  .prev-btn {
    left: -2.5rem;
  }
  
  .next-btn {
    right: -2.5rem;
  }
  
  .modal-close-btn {
    top: -2.5rem;
  }
}
</style>
