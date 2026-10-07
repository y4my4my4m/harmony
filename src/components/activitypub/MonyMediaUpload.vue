<!-- Media attachments in the composer: preview, edit (crop, focal point, alt text), removal. -->
<template>
  <div class="media-upload">
    <div class="media-preview-grid">
      <div
        v-for="(attachment, index) in attachments"
        :key="attachment.id || index"
        class="media-preview-item"
      >
        <div class="media-row">
          <div v-if="attachment.type === 'image'" class="media-thumb">
            <img
              :src="attachment.preview_url || attachment.url"
              :alt="attachment.description || ''"
              class="preview-image"
              :style="thumbStyle(attachment)"
            />
          </div>
          <div v-else-if="attachment.type === 'video'" class="media-thumb">
            <video
              :src="attachment.preview_url || attachment.url"
              class="preview-video"
              muted
            />
          </div>
          <div v-else class="media-thumb media-thumb--icon">
            <Icon :name="attachment.type === 'audio' ? 'music' : 'file'" />
          </div>

          <div class="media-info">
            <div class="media-name">{{ attachment.filename || fallbackName(attachment.type) }}</div>
            <div class="media-meta">
              <span v-if="attachment.size">{{ formatFileSize(attachment.size) }}</span>
              <span v-if="supportsAlt(attachment) && !attachment.description" class="alt-missing">
                {{ t('activitypub.altTextMissing') }}
              </span>
            </div>
          </div>

          <button
            v-if="attachment.type === 'image'"
            type="button"
            class="edit-btn"
            :aria-label="t('imageEditor.editMedia')"
            :title="t('imageEditor.editMedia')"
            data-testid="media-edit-open"
            @click="openEditor(index, 'crop')"
          >
            <Icon name="edit" :size="14" />
            <span class="edit-btn-label">{{ t('imageEditor.edit') }}</span>
          </button>

          <button
            v-if="supportsAlt(attachment)"
            type="button"
            class="alt-btn"
            :class="{ 'has-alt': !!attachment.description }"
            aria-haspopup="dialog"
            :title="t('activitypub.altTextEdit')"
            @click="openEditor(index, 'alt')"
          >
            <Icon v-if="attachment.description" name="check" :size="14" />
            ALT
          </button>

          <button
            type="button"
            class="remove-btn"
            :aria-label="t('activitypub.removeAttachment')"
            :title="t('activitypub.removeAttachment')"
            @click="handleRemove(index)"
          >
            <Icon name="x" :size="16" />
          </button>
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

    <MediaEditDialog
      v-if="editing && attachments[editing.index]"
      :attachment="attachments[editing.index]"
      :initial-focus="editing.target"
      @save="saveEdit"
      @cancel="editing = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/common/Icon.vue';
import MediaEditDialog from './MediaEditDialog.vue';
import { attachmentObjectPosition } from '@/utils/focalPoint';
import type { EditableMedia, MediaEdit } from '@/utils/mediaEdit';

type UploadAttachment = EditableMedia & {
  id?: string;
  filename?: string;
  size?: number;
  uploading?: boolean;
  progress?: number;
};

interface Props {
  attachments: UploadAttachment[];
}

defineProps<Props>();

const emit = defineEmits<{
  remove: [index: number];
  edit: [index: number, edit: MediaEdit];
}>();

const { t } = useI18n();
const editing = ref<{ index: number; target: 'crop' | 'alt' } | null>(null);

const supportsAlt = (attachment: UploadAttachment) =>
  attachment.type === 'image' || attachment.type === 'video';

const thumbStyle = (attachment: UploadAttachment) => {
  const position = attachmentObjectPosition(attachment);
  return position ? { objectPosition: position } : undefined;
};

const fallbackName = (type: UploadAttachment['type']) => {
  if (type === 'image') return t('activitypub.image');
  if (type === 'video') return t('activitypub.video');
  if (type === 'audio') return t('activitypub.audio');
  return t('activitypub.file');
};

const openEditor = (index: number, target: 'crop' | 'alt') => {
  editing.value = { index, target };
};

const saveEdit = (edit: MediaEdit) => {
  if (editing.value) emit('edit', editing.value.index, edit);
  editing.value = null;
};

const handleRemove = (index: number) => {
  if (editing.value?.index === index) editing.value = null;
  else if (editing.value && editing.value.index > index) editing.value = { ...editing.value, index: editing.value.index - 1 };
  emit('remove', index);
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
  margin-bottom: var(--space-3);
}

.media-preview-grid {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.media-preview-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
}

.media-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.media-thumb {
  position: relative;
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--background-secondary);
}

.media-thumb--icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.preview-image,
.preview-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.media-info {
  flex: 1;
  min-width: 0;
}

.media-name {
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.media-meta {
  display: flex;
  gap: var(--space-2);
  margin-top: 2px;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}

.alt-missing {
  color: var(--warning);
}

.edit-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 28px;
  padding: 0 var(--space-2);
  flex-shrink: 0;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast);
}

.edit-btn:hover {
  background: var(--background-modifier-hover);
}

@media (max-width: 380px) {
  .edit-btn-label {
    display: none;
  }
}

.alt-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 28px;
  padding: 0 var(--space-2);
  flex-shrink: 0;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.03em;
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast);
}

.alt-btn:hover {
  background: var(--background-modifier-hover);
}

.alt-btn.has-alt {
  border-color: var(--success);
  color: var(--success);
}

.remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--transition-fast), background-color var(--transition-fast);
}

.remove-btn:hover {
  color: var(--error);
  background-color: color-mix(in srgb, var(--error) 12%, transparent);
}

.edit-btn:focus-visible,
.alt-btn:focus-visible,
.remove-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.upload-progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.progress-bar {
  flex: 1;
  height: 4px;
  background-color: var(--background-modifier-active);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background-color: var(--harmony-primary);
  transition: width 0.3s ease;
}

.progress-text {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}
</style>
