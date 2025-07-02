<template>
  <div v-if="files.length > 0" class="file-preview-container">
    <div class="file-preview-header">
      <span class="file-count">{{ files.length }} file{{ files.length > 1 ? 's' : '' }} attached</span>
    </div>
    <div class="file-preview-list">
      <div v-for="(file, index) in files" :key="index" class="file-preview-item">
        <div class="file-thumbnail">
          <img 
            v-if="isImage(file)" 
            :src="file.preview" 
            :alt="file.name"
            class="thumbnail-image"
          />
          <video 
            v-else-if="isVideo(file)" 
            :src="file.preview" 
            class="thumbnail-video"
            muted
          />
          <div v-else class="file-icon">
            <span class="file-extension">{{ getFileExtension(file.name) }}</span>
          </div>
        </div>
        <div class="file-info">
          <div class="file-name" :title="file.name">{{ file.name }}</div>
          <div class="file-size">{{ formatFileSize(file.size) }}</div>
        </div>
        <button class="remove-file-btn" @click="removeFile(index)" :aria-label="`Remove ${file.name}`">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import type { PropType } from 'vue';

export interface FilePreviewData {
  file: File;
  name: string;
  size: number;
  type: string;
  preview?: string;
}

export default defineComponent({
  name: 'FilePreview',
  props: {
    files: {
      type: Array as PropType<FilePreviewData[]>,
      required: true
    }
  },
  emits: ['remove-file'],
  setup(props, { emit }) {
    const isImage = (file: FilePreviewData) => {
      return file.type.startsWith('image/');
    };

    const isVideo = (file: FilePreviewData) => {
      return file.type.startsWith('video/');
    };

    const getFileExtension = (filename: string) => {
      const ext = filename.split('.').pop()?.toLowerCase();
      return ext ? ext.toUpperCase() : 'FILE';
    };

    const formatFileSize = (bytes: number) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    const removeFile = (index: number) => {
      emit('remove-file', index);
    };

    return {
      isImage,
      isVideo,
      getFileExtension,
      formatFileSize,
      removeFile
    };
  }
});
</script>

<style scoped>
.file-preview-container {
  background-color: var(--h-chat-light);
  border-radius: 8px 8px 0 0;
  padding: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.file-preview-header {
  margin-bottom: 8px;
}

.file-count {
  color: #b9bbbe;
  font-size: 12px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.file-preview-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.file-preview-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
  background-color: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  transition: background-color 0.2s;
}

.file-preview-item:hover {
  background-color: rgba(0, 0, 0, 0.3);
}

.file-thumbnail {
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  background-color: var(--h-chat-dark);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.thumbnail-image,
.thumbnail-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.file-icon {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #5865f2;
  color: white;
}

.file-extension {
  font-size: 10px;
  font-weight: bold;
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  color: #dcddde;
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.file-size {
  color: #72767d;
  font-size: 12px;
  margin-top: 2px;
}

.remove-file-btn {
  background: none;
  border: none;
  color: #72767d;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.remove-file-btn:hover {
  color: #ff4757;
  background-color: rgba(255, 71, 87, 0.1);
}

@media (max-width: 768px) {
  .file-preview-item {
    gap: 8px;
    padding: 6px;
  }
  
  .file-thumbnail {
    width: 40px;
    height: 40px;
  }
  
  .file-name {
    font-size: 13px;
    max-width: 150px;
  }
}
</style>