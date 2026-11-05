<template>
  <div class="sticker-library" :data-testid="testId">
    <form
      v-if="canManage && max !== 0"
      class="settings-card sticker-upload"
      data-testid="sticker-upload-form"
      @submit.prevent="upload"
    >
      <h3 class="sticker-upload-title">{{ t('stickers.manage.upload') }}</h3>
      <p v-if="uploadError" class="sticker-error" role="alert" data-testid="sticker-upload-error">{{ uploadError }}</p>
      <p v-if="atCap" class="sticker-cap-notice" role="status" data-testid="sticker-cap-reached">
        {{ t('stickers.errors.limit', { max: max ?? 0 }) }}
      </p>
      <template v-else>
        <label
          class="sticker-drop"
          :class="{ dragover: isDragOver, picked: !!previewUrl }"
          data-testid="sticker-upload-area"
          @drop.prevent="onDrop"
          @dragover.prevent="isDragOver = true"
          @dragleave="isDragOver = false"
        >
          <img v-if="previewUrl" :src="previewUrl" alt="" class="sticker-upload-preview" data-testid="sticker-upload-preview" />
          <Icon v-else name="sticker" :size="40" class="sticker-drop-icon" aria-hidden="true" />
          <span :id="`${uid}-file-label`" class="sticker-drop-text">{{ draft.file ? draft.file.name : t('stickers.manage.choose') }}</span>
          <span :id="`${uid}-limits`" class="sticker-drop-hint">
            {{ t('stickers.manage.limits', { size: '512 KB', side: STICKER_MAX_SIDE, seconds: STICKER_MAX_DURATION_MS / 1000 }) }}
          </span>
          <input
            :id="`${uid}-file`"
            ref="fileInput"
            type="file"
            :accept="STICKER_ACCEPT"
            class="sr-only"
            data-testid="sticker-upload-input"
            :aria-label="t('stickers.manage.file')"
            :aria-describedby="`${uid}-file-label ${uid}-limits`"
            :disabled="busy"
            @change="pick"
          />
        </label>

        <div class="sticker-field">
          <label class="form-label" :for="`${uid}-name`">{{ t('stickers.manage.name') }}</label>
          <input
            :id="`${uid}-name`"
            v-model="draft.name"
            type="text"
            class="form-input"
            :maxlength="STICKER_NAME_MAX"
            required
            autocomplete="off"
            data-testid="sticker-name-input"
            :disabled="busy"
          />
        </div>

        <div class="sticker-field">
          <label class="form-label" :for="`${uid}-description`">{{ t('stickers.manage.description') }}</label>
          <textarea
            :id="`${uid}-description`"
            v-model="draft.description"
            class="form-input sticker-description-input"
            :maxlength="STICKER_DESCRIPTION_MAX"
            rows="2"
            required
            :aria-describedby="`${uid}-description-hint`"
            data-testid="sticker-description-input"
            :disabled="busy"
          ></textarea>
          <span :id="`${uid}-description-hint`" class="form-hint">{{ t('stickers.manage.descriptionHint') }}</span>
        </div>

        <div v-if="progress !== null" class="progress-bar" role="progressbar" :aria-label="t('stickers.manage.uploading')" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="progress">
          <div class="progress-fill" :style="{ width: progress + '%' }"></div>
        </div>
        <div class="sticker-upload-actions">
          <button type="submit" class="btn btn-primary" :disabled="busy || !draft.file" data-testid="sticker-upload-button">
            {{ busy ? t('stickers.manage.uploading') : t('stickers.manage.uploadButton') }}
          </button>
        </div>
      </template>
    </form>
    <p v-else-if="canManage && max === 0" class="settings-card sticker-upload-notice" data-testid="sticker-uploads-off">
      {{ offNotice }}
    </p>

    <div class="settings-card">
      <div class="sticker-list-header">
        <h3 :id="`${uid}-title`" ref="headingRef" class="sticker-card-title" tabindex="-1">{{ title }}</h3>
        <span class="sticker-count" data-testid="sticker-count">{{ countLabel }}</span>
      </div>
      <EmptyState v-if="stickers.length === 0" icon="sticker" :title="t('stickers.manage.empty')" data-testid="sticker-empty" />
      <ul v-else class="sticker-grid" :aria-labelledby="`${uid}-title`">
        <li
          v-for="sticker in stickers"
          :key="sticker.id"
          class="sticker-row"
          :class="{ editing: editing?.id === sticker.id }"
          data-testid="sticker-row"
          :data-sticker-name="sticker.name"
        >
          <img :src="sticker.url" :alt="sticker.description" class="sticker-row-img" loading="lazy" />
          <form v-if="editing?.id === sticker.id" class="sticker-edit" @submit.prevent="saveEdit">
            <label class="sr-only" :for="`${uid}-edit-name`">{{ t('stickers.manage.name') }}</label>
            <input
              :id="`${uid}-edit-name`"
              v-model="editing.name"
              type="text"
              class="form-input sticker-edit-input"
              :maxlength="STICKER_NAME_MAX"
              autocomplete="off"
              data-testid="sticker-edit-name"
            />
            <label class="sr-only" :for="`${uid}-edit-description`">{{ t('stickers.manage.description') }}</label>
            <textarea
              :id="`${uid}-edit-description`"
              v-model="editing.description"
              class="form-input sticker-edit-input sticker-description-input"
              :maxlength="STICKER_DESCRIPTION_MAX"
              rows="2"
              data-testid="sticker-edit-description"
            ></textarea>
            <div class="sticker-edit-actions">
              <button type="button" class="btn btn-secondary btn-sm" @click="editing = null">{{ t('common.cancel') }}</button>
              <button type="submit" class="btn btn-primary btn-sm" :disabled="busy" data-testid="sticker-edit-save">{{ t('common.save') }}</button>
            </div>
          </form>
          <div v-else class="sticker-row-text">
            <span class="sticker-row-name">{{ sticker.name }}</span>
            <span class="sticker-row-description">{{ sticker.description }}</span>
          </div>
          <div v-if="canManage && editing?.id !== sticker.id" class="sticker-row-actions">
            <button
              type="button"
              class="sticker-action"
              :aria-label="t('stickers.manage.editLabel', { name: sticker.name })"
              :title="t('common.edit')"
              data-testid="sticker-edit"
              @click="startEdit(sticker)"
            >
              <Icon name="pencil" :size="16" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="sticker-action sticker-action--danger"
              :aria-label="t('stickers.manage.deleteLabel', { name: sticker.name })"
              :title="t('common.delete')"
              data-testid="sticker-delete"
              :disabled="busy"
              @click="remove(sticker)"
            >
              <Icon name="trash-2" :size="16" aria-hidden="true" />
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import EmptyState from '@/components/common/EmptyState.vue'
import Icon from '@/components/common/Icon.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { uid as makeUid } from '@/utils/a11y/focus'
import { debug } from '@/utils/debug'
import {
  STICKER_ACCEPT,
  STICKER_DESCRIPTION_MAX,
  STICKER_MAX_DURATION_MS,
  STICKER_MAX_SIDE,
  STICKER_NAME_MAX,
  stickerNameFromFile,
} from '@/utils/stickerImage'
import { stickerErrorMessage, type Sticker } from '@/services/stickerService'
import type { StickerLibraryAdapter } from './stickerLibrary'

const props = defineProps<{
  stickers: Sticker[]
  adapter: StickerLibraryAdapter
  /** The scope's cap; 0 is off, null unknown. */
  max: number | null
  canManage: boolean
  title: string
  /** Shown to a manager while the cap is 0. */
  offNotice: string
  testId: string
}>()

const emit = defineEmits<{
  (e: 'uploaded', sticker: Sticker): void
  (e: 'updated', sticker: Sticker): void
  (e: 'deleted', sticker: Sticker): void
}>()

const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()
const { polite } = useAnnouncer()
const uid = makeUid('stickers')

const fileInput = ref<HTMLInputElement | null>(null)
const headingRef = ref<HTMLElement | null>(null)
const draft = reactive<{ file: File | null; name: string; description: string }>({ file: null, name: '', description: '' })
const previewUrl = ref<string | null>(null)
const uploadError = ref<string | null>(null)
const progress = ref<number | null>(null)
const busy = ref(false)
const isDragOver = ref(false)
const editing = ref<{ id: string; name: string; description: string } | null>(null)

const atCap = computed(() => props.max !== null && props.max > 0 && props.stickers.length >= props.max)
const countLabel = computed(() => (props.max ? `${props.stickers.length} / ${props.max}` : String(props.stickers.length)))

function setPreview(file: File | null) {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = file ? URL.createObjectURL(file) : null
}

function choose(file: File | null) {
  draft.file = file
  uploadError.value = null
  setPreview(file)
  if (file && !draft.name.trim()) draft.name = stickerNameFromFile(file.name)
}

function pick(event: Event) {
  choose((event.target as HTMLInputElement).files?.[0] ?? null)
}

function onDrop(event: DragEvent) {
  isDragOver.value = false
  if (busy.value) return
  const file = event.dataTransfer?.files?.[0]
  if (file) choose(file)
}

function reset() {
  draft.file = null
  draft.name = ''
  draft.description = ''
  setPreview(null)
  if (fileInput.value) fileInput.value.value = ''
}

async function upload() {
  if (!draft.file || busy.value) return
  busy.value = true
  uploadError.value = null
  progress.value = 0
  try {
    const sticker = await props.adapter.upload(draft.file, draft.name, draft.description, (f) => {
      progress.value = Math.round(f * 100)
    })
    emit('uploaded', sticker)
    toast.success(t('stickers.manage.uploaded', { name: sticker.name }))
    polite(t('stickers.manage.uploaded', { name: sticker.name }))
    reset()
  } catch (error) {
    debug.warn('Sticker upload failed:', error)
    uploadError.value = stickerErrorMessage(error)
    toast.error(uploadError.value)
  } finally {
    busy.value = false
    progress.value = null
  }
}

function startEdit(sticker: Sticker) {
  editing.value = { id: sticker.id, name: sticker.name, description: sticker.description }
}

async function saveEdit() {
  const current = editing.value
  const sticker = current && props.stickers.find((s) => s.id === current.id)
  if (!current || !sticker || busy.value) return
  busy.value = true
  try {
    const updated = await props.adapter.update(sticker, { name: current.name, description: current.description })
    emit('updated', updated)
    editing.value = null
    polite(t('stickers.manage.saved', { name: updated.name }))
  } catch (error) {
    toast.error(stickerErrorMessage(error))
  } finally {
    busy.value = false
  }
}

async function remove(sticker: Sticker) {
  const ok = await confirm({
    title: t('stickers.manage.deleteTitle'),
    message: t('stickers.manage.deleteConfirm', { name: sticker.name }),
    confirmButtonText: t('common.delete'),
    dangerAction: true,
  })
  if (!ok) return
  busy.value = true
  try {
    await props.adapter.remove(sticker)
    emit('deleted', sticker)
    polite(t('stickers.manage.deleted', { name: sticker.name }))
    headingRef.value?.focus()
  } catch (error) {
    toast.error(stickerErrorMessage(error))
  } finally {
    busy.value = false
  }
}

onBeforeUnmount(() => setPreview(null))
</script>

<style scoped>
.sticker-library {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-card {
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
  padding: 24px;
  border: 1px solid var(--background-quaternary);
}

.sticker-upload {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.sticker-card-title {
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.sticker-card-title:focus {
  outline: none;
}

/* EmojiLibraryManager's upload label (.form-label). */
.sticker-upload-title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.sticker-upload-notice,
.sticker-cap-notice {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.sticker-error {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-danger);
}

.sticker-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 24px 16px;
  border: 2px dashed var(--input-border);
  border-radius: var(--radius-md);
  background-color: var(--input-bg);
  text-align: center;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.sticker-drop:focus-within {
  border-color: var(--harmony-primary);
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.sticker-drop:hover,
.sticker-drop.dragover {
  border-color: var(--harmony-primary);
  background-color: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
}

.sticker-drop-icon {
  color: var(--text-muted);
  margin-bottom: 8px;
}

.sticker-upload-preview {
  width: 96px;
  height: 96px;
  margin-bottom: 8px;
  object-fit: contain;
}

.sticker-drop-text {
  max-width: 100%;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.sticker-drop-hint {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.sticker-field {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.sticker-field .form-hint {
  color: var(--text-muted);
}

.sticker-description-input {
  resize: vertical;
  min-height: 64px;
  font-family: inherit;
}

.sticker-upload-actions {
  display: flex;
  justify-content: flex-end;
}

.progress-bar {
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background-color: var(--background-quaternary);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background-color: var(--harmony-primary);
  transition: width 0.3s ease;
}

.sticker-list-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.sticker-count {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  background-color: var(--surface-inset);
  padding: 4px 8px;
  border-radius: var(--radius-lg);
}

.sticker-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.sticker-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 12px;
  background-color: var(--surface-inset);
  border: 1px solid var(--background-quaternary);
  border-radius: var(--radius-base);
}

.sticker-row.editing {
  align-items: flex-start;
  border-color: var(--harmony-primary);
  background-color: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
}

.sticker-row-img {
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  object-fit: contain;
}

.sticker-row-text,
.sticker-edit {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.sticker-edit {
  gap: 8px;
}

.sticker-row-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sticker-row-description {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.sticker-edit-input {
  padding: 6px 10px;
  font-size: var(--font-size-sm);
}

.sticker-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.sticker-row-actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}

.sticker-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.sticker-action:hover {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.sticker-action--danger:hover {
  color: var(--text-danger);
}

.sticker-action:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.sticker-action:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .settings-card {
    padding: 16px;
  }

  .sticker-grid {
    grid-template-columns: 1fr;
  }
}
</style>
