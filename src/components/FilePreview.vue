<template>
  <div v-if="files.length > 0" class="file-preview-container">
    <div class="file-preview-header">
      <span class="file-count">{{ t('messageA11y.upload.attachedCount', { count: files.length }, files.length) }}</span>
      <div v-if="hasUploading" class="upload-status">
        <div class="upload-spinner" aria-hidden="true"></div>
        <span>{{ t('messageA11y.upload.uploading') }}</span>
      </div>
    </div>
    <ul class="file-preview-list" :aria-label="t('messageA11y.upload.listLabel')">
      <li v-for="(file, index) in files" :key="index" class="file-preview-item" :class="{ uploading: file.uploadStatus === 'uploading', error: file.uploadStatus === 'error' }" data-testid="file-preview-item">
        <div class="file-thumbnail">
          <img 
            v-if="isImage(file)" 
            :src="file.preview" 
            alt=""
            class="thumbnail-image"
            :class="{ 'thumbnail-spoiler': isSpoilerFileName(file.name) }"
          />
          <video
            v-else-if="isVideo(file)"
            :src="file.preview"
            class="thumbnail-video"
            :class="{ 'thumbnail-spoiler': isSpoilerFileName(file.name) }"
            muted
          />
          <div v-else class="file-icon">
            <span class="file-extension">{{ getFileExtension(file.name) }}</span>
          </div>
          
          <!-- Upload overlay -->
          <div
            v-if="file.uploadStatus === 'uploading'"
            class="upload-overlay"
            role="progressbar"
            :aria-label="t('messageA11y.upload.progressLabel', { name: file.name })"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="Math.round(file.uploadProgress || 0)"
          >
            <div class="upload-progress" :style="{ width: `${file.uploadProgress || 0}%` }"></div>
            <div class="upload-progress-text" aria-hidden="true">{{ Math.round(file.uploadProgress || 0) }}%</div>
          </div>
          <span v-if="isImage(file) && file.altText" class="alt-badge" aria-hidden="true">ALT</span>
          
          <!-- Error overlay -->
          <div v-if="file.uploadStatus === 'error'" class="error-overlay" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
              <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2"/>
              <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2"/>
            </svg>
          </div>
        </div>
        
        <div class="file-info">
          <div :id="`${idBase}-name-${index}`" class="file-name" :title="file.name">{{ file.name }}</div>
          <div class="file-size-status">
            <span class="file-size">{{ formatFileSize(file.size) }}</span>
            <span v-if="file.uploadStatus === 'uploading'" class="status-text uploading">• Uploading</span>
            <span v-else-if="file.fromDrive" class="status-text completed" data-testid="file-from-drive">• {{ t('drive.composer.fromDrive') }}</span>
            <span v-else-if="file.uploadStatus === 'completed' && file.reused" class="status-text completed" data-testid="file-reused" :title="t('drive.composer.reusedHint')">• {{ t('drive.composer.reused') }}</span>
            <span v-else-if="file.uploadStatus === 'completed'" class="status-text completed">• Uploaded</span>
            <span v-else-if="file.uploadStatus === 'error'" class="status-text error">• Failed</span>
            <span v-if="file.temporary || forceTemporary" class="status-text temporary" data-testid="file-temporary">• {{ t('drive.composer.temporaryDays', { count: temporaryDays }, temporaryDays) }}</span>
          </div>
          <div v-if="file.uploadError" class="error-message">{{ file.uploadError }}</div>
          <div v-if="isImage(file) && file.altText" class="file-alt-text">{{ file.altText }}</div>
          <PhotoDetailsControl
            v-if="!file.recorded"
            :details="file.photoDetails"
            :keep="!!file.keepDetails"
            :locked="!file.keepDetails && file.file.size === 0 && !file.driveSource"
            :describedby="`${idBase}-name-${index}`"
            @update:keep="(keep) => emit('set-keep-details', index, keep)"
          />
        </div>

        <button
          v-if="isImage(file)"
          type="button"
          class="alt-file-btn"
          :class="{ active: !!file.altText }"
          :aria-label="file.altText ? t('messageA11y.alt.edit', { name: file.name }) : t('messageA11y.alt.add', { name: file.name })"
          :title="file.altText ? t('messageA11y.alt.editShort') : t('messageA11y.alt.addShort')"
          data-testid="alt-text-button"
          @click="altIndex = index"
        >
          <Icon name="pencil" :size="16" />
        </button>
        
        <button
          v-if="isImage(file) || isVideo(file)"
          type="button"
          class="spoiler-file-btn"
          :class="{ active: isSpoilerFileName(file.name) }"
          :aria-pressed="isSpoilerFileName(file.name)"
          :title="isSpoilerFileName(file.name) ? $t('message.spoiler.unmark') : $t('message.spoiler.mark')"
          :aria-label="isSpoilerFileName(file.name) ? $t('message.spoiler.unmark') : $t('message.spoiler.mark')"
          @click="emit('toggle-spoiler', index)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 3l18 18M10.6 5.1A10.9 10.9 0 0 1 12 5c5 0 9 4.5 10 7a13.2 13.2 0 0 1-3.2 4.2M6.6 6.6C4.4 8 2.8 10.1 2 12c1 2.5 5 7 10 7 1.7 0 3.3-.5 4.6-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button
          v-if="driveEnabled && !file.reused && !file.fromDrive"
          type="button"
          class="temporary-file-btn"
          :class="{ active: file.temporary || forceTemporary }"
          :aria-pressed="!!(file.temporary || forceTemporary)"
          :disabled="forceTemporary"
          :title="forceTemporary ? t('drive.composer.fullHint') : (file.temporary ? t('drive.composer.keep') : t('drive.composer.makeTemporary', { count: temporaryDays }, temporaryDays))"
          :aria-label="file.temporary ? t('drive.composer.keepFile', { name: file.name }) : t('drive.composer.makeTemporaryFile', { name: file.name })"
          data-testid="temporary-file-button"
          @click="emit('toggle-temporary', index)"
        >
          <Icon name="clock" :size="16" />
        </button>
        <button
          type="button"
          class="remove-file-btn"
          @click="removeFile(index)"
          :aria-label="t('messageA11y.upload.remove', { name: file.name })"
          :title="t('messageA11y.upload.remove', { name: file.name })"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </li>
    </ul>
    <AltTextDialog
      v-if="altFile"
      :name="altFile.name"
      :preview="altFile.preview"
      :initial="altFile.altText"
      @save="saveAlt"
      @cancel="altIndex = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MessageMediaUpload } from '@/services/messageMediaUpload';
import { isSpoilerFileName } from '@/utils/spoiler';
import Icon from '@/components/common/Icon.vue';
import AltTextDialog from '@/components/messages/AltTextDialog.vue';
import PhotoDetailsControl from '@/components/common/PhotoDetailsControl.vue';
import { useT } from '@/composables/useT';
import { uid } from '@/utils/a11y/focus';
import type { MediaDetails } from '@/utils/stripMetadata';

export interface FilePreviewData {
  file: File;
  name: string;
  size: number;
  type: string;
  preview?: string;
  uploadStatus?: 'pending' | 'uploading' | 'completed' | 'error';
  /** Percent, 0 to 100. */
  uploadProgress?: number;
  uploadedUrl?: string;
  /** message_media object name of a completed upload. */
  uploadedPath?: string;
  uploadError?: string;
  /** The running or settled upload; marked raw. */
  upload?: MessageMediaUpload;
  /** Image description, sent as the file part's altText. */
  altText?: string;
  /** Kept until drive_ephemeral_days instead of in Drive. */
  temporary?: boolean;
  /** The bytes were in Drive already; nothing was uploaded. */
  reused?: boolean;
  /** Attached from Drive; uploadedPath names the Drive object. */
  fromDrive?: boolean;
  /** Recorded in the composer: new bytes, so Drive holds no copy to look up. */
  recorded?: boolean;
  /** What the picked file carries; read after it is attached. */
  photoDetails?: MediaDetails;
  /** Upload the file with its location, camera and other metadata. */
  keepDetails?: boolean;
  /** Drive object of a photo attached from Drive: sent as is while its details are kept. */
  driveSource?: string;
  /** Stored object an upload reads its bytes from when `file` holds none (Drive, restored draft). */
  sourcePath?: string;
}

interface Props {
  files: FilePreviewData[];
  /** The instance has Drive: uploads can be temporary. */
  driveEnabled?: boolean;
  /** Drive is full: new uploads are temporary whatever the toggle says. */
  forceTemporary?: boolean;
  temporaryDays?: number;
}

const props = withDefaults(defineProps<Props>(), { driveEnabled: false, forceTemporary: false, temporaryDays: 30 });

interface Emits {
  (e: 'remove-file', index: number): void;
  (e: 'toggle-temporary', index: number): void;
  (e: 'toggle-spoiler', index: number): void;
  (e: 'update-alt', index: number, altText: string): void;
  (e: 'set-keep-details', index: number, keep: boolean): void;
}

const emit = defineEmits<Emits>();
const { t } = useT();
const idBase = uid('file-preview');

/** Index of the attachment whose description is being edited. */
const altIndex = ref<number | null>(null);
const altFile = computed(() => (altIndex.value === null ? null : props.files[altIndex.value] ?? null));

const saveAlt = (text: string) => {
  if (altIndex.value !== null) emit('update-alt', altIndex.value, text);
  altIndex.value = null;
};

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
  margin: 0;
  padding: 0;
  list-style: none;
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

.thumbnail-spoiler {
  filter: blur(8px);
}

.alt-badge {
  position: absolute;
  left: 2px;
  bottom: 2px;
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 9px;
  font-weight: 700;
  line-height: 1.4;
}

.file-alt-text {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.alt-file-btn,
.spoiler-file-btn,
.temporary-file-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.temporary-file-btn:hover:not(:disabled),
.temporary-file-btn.active,
.spoiler-file-btn:hover,
.spoiler-file-btn.active {
  color: var(--text-primary);
  background: var(--background-modifier-hover, rgba(127, 127, 127, 0.18));
}

.alt-file-btn.active {
  color: var(--text-link);
}

.alt-file-btn:hover,
.alt-file-btn:focus-visible,
.spoiler-file-btn:focus-visible,
.remove-file-btn:focus-visible {
  color: var(--text-primary);
}

.temporary-file-btn.active {
  color: var(--warning);
}

.temporary-file-btn:disabled {
  cursor: default;
}

.status-text.temporary {
  color: var(--warning);
}

.alt-file-btn:focus-visible,
.spoiler-file-btn:focus-visible,
.temporary-file-btn:focus-visible,
.remove-file-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
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