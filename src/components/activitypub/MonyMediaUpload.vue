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
        <!-- Image/Video Preview -->
        <template v-if="attachment.type === 'image' || attachment.type === 'video'">
          <div v-if="attachment.type === 'image'" class="image-preview">
            <img
              :src="attachment.preview_url || attachment.url"
              :alt="attachment.description || 'Uploaded image'"
              class="preview-image"
            />
          </div>
          <div v-else class="video-preview">
            <video
              :src="attachment.preview_url || attachment.url"
              class="preview-video"
              muted
            />
          </div>
          
          <!-- Media Info -->
          <div class="media-info">
            <div class="media-name">{{ attachment.filename || (attachment.type === 'image' ? 'Image' : 'Video') }}</div>
            <div class="media-size">{{ formatFileSize(attachment.size) }}</div>
          </div>
          
          <!-- Remove Button -->
          <button
            @click="$emit('remove', index)"
            class="remove-btn"
            :title="`Remove ${attachment.type}`"
          >
            <Icon name="x" />
          </button>
        </template>

        <!-- Audio Preview -->
        <template v-else-if="attachment.type === 'audio'">
          <div class="audio-preview">
            <Icon name="music" class="audio-icon" />
          </div>
          
          <div class="media-info">
            <div class="media-name">{{ attachment.filename || 'Audio file' }}</div>
            <div class="media-size">{{ formatFileSize(attachment.size) }}</div>
          </div>
          
          <!-- Remove Button -->
          <button
            @click="$emit('remove', index)"
            class="remove-btn"
            title="Remove audio"
          >
            <Icon name="x" />
          </button>
        </template>

        <!-- Generic File Preview -->
        <template v-else>
          <div class="file-preview">
            <Icon name="file" />
          </div>
          
          <div class="media-info">
            <div class="media-name">{{ attachment.filename || 'File' }}</div>
            <div class="media-size">{{ formatFileSize(attachment.size) }}</div>
          </div>
          
          <!-- Remove Button -->
          <button
            @click="$emit('remove', index)"
            class="remove-btn"
            title="Remove file"
          >
            <Icon name="x" />
          </button>
        </template>

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
// eslint-disable-next-line unused-imports/no-unused-vars
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
  margin-bottom: 0.75rem;
}

.media-preview-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.media-preview-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  background-color: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  transition: background-color 0.2s;
}

.media-preview-item:hover {
  background-color: rgba(0, 0, 0, 0.3);
}

/* Image Preview */
.image-preview {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
}

.preview-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* Video Preview */
.video-preview {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
}

.preview-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* Media Info */
.media-info {
  flex: 1;
  min-width: 0;
}

.media-name {
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.media-size {
  color: var(--text-muted);
  font-size: 12px;
  margin-top: 2px;
}

/* Audio Preview */
.audio-preview {
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  background-color: rgba(14, 165, 233, 0.2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.audio-icon {
  width: 24px;
  height: 24px;
  color: #0EA5E9;
}

/* File Preview */
.file-preview {
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  background-color: rgba(114, 118, 125, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

/* Remove Button */
.remove-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-left: auto;
}

.remove-btn:hover {
  color: #ff4757;
  background-color: rgba(255, 71, 87, 0.1);
}

/* Description Overlay */
.description-overlay {
  display: none;
}

/* Upload Progress */
.upload-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  background-color: #00aff4;
  transition: width 0.3s ease;
  border-radius: 0 0 4px 4px;
}

.progress-bar {
  width: 75%;
  height: 8px;
  background-color: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 8px;
}

.progress-fill {
  height: 100%;
  background-color: var(--harmony-primary);
  transition: width 0.3s ease;
}

.progress-text {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}
</style>
