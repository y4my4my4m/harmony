<template>
  <div v-if="files.length > 0" class="file-preview-container">
    <div class="file-preview-header">
      <span class="file-count">{{ files.length }} file{{ files.length > 1 ? 's' : '' }} attached</span>
      <div v-if="hasUploading" class="upload-status">
        <div class="upload-spinner"></div>
        <span>Uploading...</span>
      </div>
    </div>
    <div class="file-preview-list">
      <div v-for="(file, index) in files" :key="index" class="file-preview-item" :class="{ uploading: file.uploadStatus === 'uploading', error: file.uploadStatus === 'error' }">
        <div class="file-thumbnail">
          <img 
            v-if="isImage(file)" 
            :src="file.preview" 
            :alt="file.name"
            class="thumbnail-image"
          />
          <video
            v-else-if="isVideo(file)"
            :src="videoFrameSrc(file.preview)"
            class="thumbnail-video"
            muted
          />
          <div v-else class="file-icon">
            <span class="file-extension">{{ getFileExtension(file.name) }}</span>
          </div>
          
          <!-- Upload overlay -->
          <div v-if="file.uploadStatus === 'uploading'" class="upload-overlay">
            <div class="upload-progress" :style="{ width: `${file.uploadProgress || 0}%` }"></div>
            <div class="upload-progress-text">{{ Math.round(file.uploadProgress || 0) }}%</div>
          </div>
          
          <!-- Error overlay -->
          <div v-if="file.uploadStatus === 'error'" class="error-overlay">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
              <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2"/>
              <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2"/>
            </svg>
          </div>
        </div>
        
        <div class="file-info">
          <div class="file-name" :title="file.name">{{ file.name }}</div>
          <div class="file-size-status">
            <span class="file-size">{{ formatFileSize(file.size) }}</span>
            <span v-if="file.uploadStatus === 'uploading'" class="status-text uploading">• Uploading</span>
            <span v-else-if="file.uploadStatus === 'completed'" class="status-text completed">• Uploaded</span>
            <span v-else-if="file.uploadStatus === 'error'" class="status-text error">• Failed</span>
          </div>
          <div v-if="file.uploadError" class="error-message">{{ file.uploadError }}</div>
        </div>
        
        <button 
          class="remove-file-btn" 
          @click="removeFile(index)" 
          :disabled="file.uploadStatus === 'uploading'"
          :aria-label="`Remove ${file.name}`"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { videoFrameSrc } from '@/utils/videoThumb';

export interface FilePreviewData {
  file: File;
  name: string;
  size: number;
  type: string;
  preview?: string;
  uploadStatus?: 'pending' | 'uploading' | 'completed' | 'error';
  uploadProgress?: number;
  uploadedUrl?: string;
  uploadError?: string;
}

interface Props {
  files: FilePreviewData[];
}

const props = defineProps<Props>();

interface Emits {
  (e: 'remove-file', index: number): void;
}

const emit = defineEmits<Emits>();

const hasUploading = computed(() => {
  return props.files.some(file => file.uploadStatus === 'uploading');
});

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


</script>

<style scoped>
.file-preview-container {
  background-color: var(--background-quaternary);
  border-radius: 8px 8px 0 0;
  padding: 12px;
}

.file-preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.file-count {
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.upload-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #00aff4;
  font-size: 12px;
  font-weight: 500;
}

.upload-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(0, 175, 244, 0.3);
  border-top: 2px solid #00aff4;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
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

.file-preview-item.uploading {
  background-color: rgba(0, 175, 244, 0.1);
  border: 1px solid rgba(0, 175, 244, 0.3);
}

.file-preview-item.error {
  background-color: rgba(255, 71, 87, 0.1);
  border: 1px solid rgba(255, 71, 87, 0.3);
}

.file-thumbnail {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 4px;
  overflow: hidden;
  background-color: var(--background-tertiary);
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
  background-color: var(--harmony-primary);
  color: var(--text-primary);
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
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.file-size-status {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
}

.file-size {
  color: var(--text-muted);
  font-size: 12px;
  margin-top: 2px;
}

.status-text {
  font-size: 11px;
  font-weight: 500;
}

.status-text.uploading {
  color: #00aff4;
}

.status-text.completed {
  color: #43b581;
}

.status-text.error {
  color: #ff4757;
}

.upload-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
}

.upload-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 3px;
  background-color: #00aff4;
  transition: width 0.3s ease;
  border-radius: 0 0 4px 4px;
}

.upload-progress-text {
  color: var(--text-primary);
  font-size: 10px;
  font-weight: bold;
  z-index: 1;
}

.error-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(255, 71, 87, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--text-primary);
}

.remove-file-btn {
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
}

.remove-file-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.remove-file-btn:disabled:hover {
  color: var(--text-muted);
  background-color: transparent;
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