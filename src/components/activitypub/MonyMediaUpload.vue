<!-- Media attachments in the composer: preview, alt text, removal. -->
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
            v-if="supportsAlt(attachment)"
            type="button"
            class="alt-btn"
            :class="{ 'has-alt': !!attachment.description }"
            :aria-expanded="editingIndex === index"
            :aria-controls="`media-alt-${uid}-${index}`"
            :title="t('activitypub.altTextEdit')"
            @click="toggleEditor(index)"
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

        <div
          v-if="editingIndex === index"
          :id="`media-alt-${uid}-${index}`"
          class="alt-editor"
        >
          <label :for="`media-alt-input-${uid}-${index}`" class="alt-label">
            {{ t('activitypub.altTextLabel') }}
          </label>
          <textarea
            :id="`media-alt-input-${uid}-${index}`"
            ref="altInputRef"
            class="alt-input"
            rows="3"
            :maxlength="ALT_TEXT_MAX"
            :placeholder="t('activitypub.altTextPlaceholder')"
            :value="attachment.description || ''"
            @input="updateDescription(index, ($event.target as HTMLTextAreaElement).value)"
            @keydown.esc.stop="editingIndex = null"
          />
          <div class="alt-footer">
            <span class="alt-count">{{ (attachment.description || '').length }} / {{ ALT_TEXT_MAX }}</span>
            <button type="button" class="alt-done" @click="editingIndex = null">
              {{ t('common.done') }}
            </button>
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
import { nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/common/Icon.vue';

// Mastodon's media description limit.
const ALT_TEXT_MAX = 1500;

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

const emit = defineEmits<{
  remove: [index: number];
  'update-description': [index: number, description: string];
}>();

const { t } = useI18n();
const uid = Math.random().toString(36).slice(2, 8);
const editingIndex = ref<number | null>(null);
const altInputRef = ref<HTMLTextAreaElement[] | HTMLTextAreaElement | null>(null);

const supportsAlt = (attachment: MediaAttachment) =>
  attachment.type === 'image' || attachment.type === 'video';

const fallbackName = (type: MediaAttachment['type']) => {
  if (type === 'image') return t('activitypub.image');
  if (type === 'video') return t('activitypub.video');
  if (type === 'audio') return t('activitypub.audio');
  return t('activitypub.file');
};

const toggleEditor = async (index: number) => {
  editingIndex.value = editingIndex.value === index ? null : index;
  if (editingIndex.value === null) return;
  await nextTick();
  const el = Array.isArray(altInputRef.value) ? altInputRef.value[0] : altInputRef.value;
  el?.focus();
};

const updateDescription = (index: number, description: string) => {
  emit('update-description', index, description);
};

const handleRemove = (index: number) => {
  if (editingIndex.value === index) editingIndex.value = null;
  else if (editingIndex.value !== null && editingIndex.value > index) editingIndex.value -= 1;
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

.alt-editor {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.alt-label {
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.alt-input {
  width: 100%;
  min-height: 64px;
  padding: var(--space-2);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  background: var(--background-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  line-height: 1.4;
  resize: vertical;
}

.alt-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.alt-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.alt-count {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.alt-done {
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--radius-full);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
}

.alt-btn:focus-visible,
.remove-btn:focus-visible,
.alt-done:focus-visible {
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
