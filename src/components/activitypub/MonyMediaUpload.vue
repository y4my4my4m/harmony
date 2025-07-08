<!-- Media Upload Component for Mony Composer -->
<!-- Handles display and management of media attachments -->
<template>
  <div class="media-upload">
    <div class="media-preview-grid">
      <div
        v-for="(attachment, index) in attachments"
        :key="attachment.id || index"
        class="media-preview-item"
      >
        <!-- Image Preview -->
        <div v-if="attachment.type === 'image'" class="image-preview">
          <img
            :src="attachment.preview_url || attachment.url"
            :alt="attachment.description || 'Uploaded image'"
            class="preview-image"
          />
          
          <!-- Remove Button -->
          <button
            @click="$emit('remove', index)"
            class="remove-btn"
            title="Remove image"
          >
            <Icon name="close" />
          </button>
          
          <!-- Description Input -->
          <div class="description-overlay">
            <input
              v-model="attachment.description"
              @input="updateDescription(index, attachment.description)"
              :placeholder="`Describe image ${index + 1}...`"
              class="description-input"
              maxlength="1000"
            />
          </div>
        </div>

        <!-- Video Preview -->
        <div v-else-if="attachment.type === 'video'" class="video-preview">
          <video
            :src="attachment.preview_url || attachment.url"
            class="preview-video"
            controls
            muted
          />
          
          <!-- Remove Button -->
          <button
            @click="$emit('remove', index)"
            class="remove-btn"
            title="Remove video"
          >
            <Icon name="close" />
          </button>
          
          <!-- Description Input -->
          <div class="description-overlay">
            <input
              v-model="attachment.description"
              @input="updateDescription(index, attachment.description)"
              :placeholder="`Describe video ${index + 1}...`"
              class="description-input"
              maxlength="1000"
            />
          </div>
        </div>

        <!-- Audio Preview -->
        <div v-else-if="attachment.type === 'audio'" class="audio-preview">
          <div class="audio-info">
            <Icon name="music" class="audio-icon" />
            <span class="audio-name">{{ attachment.filename || 'Audio file' }}</span>
          </div>
          
          <audio
            :src="attachment.url"
            class="preview-audio"
            controls
          />
          
          <!-- Remove Button -->
          <button
            @click="$emit('remove', index)"
            class="remove-btn"
            title="Remove audio"
          >
            <Icon name="close" />
          </button>
          
          <!-- Description Input -->
          <div class="description-overlay">
            <input
              v-model="attachment.description"
              @input="updateDescription(index, attachment.description)"
              :placeholder="`Describe audio ${index + 1}...`"
              class="description-input"
              maxlength="1000"
            />
          </div>
        </div>

        <!-- Generic File Preview -->
        <div v-else class="file-preview">
          <div class="file-info">
            <Icon name="file" class="file-icon" />
            <span class="file-name">{{ attachment.filename || 'File' }}</span>
            <span class="file-size">{{ formatFileSize(attachment.size) }}</span>
          </div>
          
          <!-- Remove Button -->
          <button
            @click="$emit('remove', index)"
            class="remove-btn"
            title="Remove file"
          >
            <Icon name="close" />
          </button>
          
          <!-- Description Input -->
          <div class="description-overlay">
            <input
              v-model="attachment.description"
              @input="updateDescription(index, attachment.description)"
              :placeholder="`Describe file ${index + 1}...`"
              class="description-input"
              maxlength="1000"
            />
          </div>
        </div>

        <!-- Upload Progress -->
        <div v-if="attachment.uploading" class="upload-progress">
          <div class="progress-bar">
            <div 
              class="progress-fill"
              :style="{ width: `${attachment.progress || 0}%` }"
            />
          </div>
          <span class="progress-text">{{ attachment.progress || 0 }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { defineEmits, defineProps } from 'vue';
import Icon from '@/components/common/Icon.vue';

// Props
interface MediaAttachment {
  id?: string;
  type: 'image' | 'video' | 'audio' | 'unknown';
  url: string;
  preview_url?: string;
  description?: string;
  filename?: string;
  size?: number;
  uploading?: boolean;
  progress?: number;
}

interface Props {
  attachments: MediaAttachment[];
}

defineProps<Props>();

// Emits
const emit = defineEmits<{
  remove: [index: number];
  'update-description': [index: number, description: string];
}>();

// Methods
const updateDescription = (index: number, description: string) => {
  emit('update-description', index, description);
};

const formatFileSize = (bytes?: number): string => {
  if (!bytes) return '';
  
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(1);
  
  return `${size} ${sizes[i]}`;
};
</script>

<style scoped>
.media-upload {
  @apply mt-4;
}

.media-preview-grid {
  @apply grid grid-cols-1 md:grid-cols-2 gap-3;
}

.media-preview-item {
  @apply relative rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800;
}

/* Image Preview */
.image-preview {
  @apply relative;
}

.preview-image {
  @apply w-full h-40 object-cover;
}

/* Video Preview */
.video-preview {
  @apply relative;
}

.preview-video {
  @apply w-full h-40 object-cover;
}

/* Audio Preview */
.audio-preview {
  @apply p-4;
}

.audio-info {
  @apply flex items-center gap-2 mb-2;
}

.audio-icon {
  @apply w-5 h-5 text-purple-500;
}

.audio-name {
  @apply text-sm font-medium text-gray-900 dark:text-gray-100 truncate;
}

.preview-audio {
  @apply w-full;
}

/* File Preview */
.file-preview {
  @apply p-4;
}

.file-info {
  @apply flex items-center gap-2;
}

.file-icon {
  @apply w-5 h-5 text-gray-500;
}

.file-name {
  @apply text-sm font-medium text-gray-900 dark:text-gray-100 truncate flex-1;
}

.file-size {
  @apply text-xs text-gray-500 dark:text-gray-400;
}

/* Remove Button */
.remove-btn {
  @apply absolute top-2 right-2 w-6 h-6 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center transition-colors z-10;
}

.remove-btn:hover {
  @apply bg-red-600;
}

/* Description Overlay */
.description-overlay {
  @apply absolute bottom-0 left-0 right-0 p-2 bg-black bg-opacity-50;
}

.description-input {
  @apply w-full px-2 py-1 text-xs bg-transparent text-white placeholder-gray-300 border border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-purple-500;
}

/* Upload Progress */
.upload-progress {
  @apply absolute inset-0 bg-black bg-opacity-50 flex flex-col items-center justify-center text-white;
}

.progress-bar {
  @apply w-3/4 h-2 bg-gray-600 rounded-full overflow-hidden mb-2;
}

.progress-fill {
  @apply h-full bg-purple-500 transition-all duration-300;
}

.progress-text {
  @apply text-sm font-medium;
}

/* Responsive adjustments */
@media (max-width: 768px) {
  .media-preview-grid {
    @apply grid-cols-1;
  }
  
  .preview-image,
  .preview-video {
    @apply h-32;
  }
}
</style>
