<template>
  <div class="sticker-library" :data-testid="testId">
    <form
      v-if="canManage && max !== 0"
      class="settings-card sticker-upload"
      data-testid="sticker-upload-form"
      @submit.prevent="upload"
    >
      <h3 class="sticker-library-subtitle">{{ t('stickers.manage.upload') }}</h3>
      <p :id="`${uid}-limits`" class="setting-hint">
        {{ t('stickers.manage.limits', { size: '512 KB', side: STICKER_MAX_SIDE, seconds: STICKER_MAX_DURATION_MS / 1000 }) }}
      </p>
      <p v-if="uploadError" class="sticker-error" role="alert" data-testid="sticker-upload-error">{{ uploadError }}</p>
      <div v-if="atCap" class="sticker-cap-notice" role="status" data-testid="sticker-cap-reached">
        {{ t('stickers.errors.limit', { max: max ?? 0 }) }}
      </div>
      <template v-else>
        <label class="form-label" :for="`${uid}-file`">{{ t('stickers.manage.file') }}</label>
        <input
          :id="`${uid}-file`"
          ref="fileInput"
          type="file"
          :accept="STICKER_ACCEPT"
          class="sticker-file-input"
          data-testid="sticker-upload-input"
          :aria-describedby="`${uid}-limits`"
          :disabled="busy"
          @change="pick"
        />
        <img v-if="previewUrl" :src="previewUrl" alt="" class="sticker-upload-preview" />

        <label class="form-label" :for="`${uid}-name`">{{ t('stickers.manage.name') }}</label>
        <input
          :id="`${uid}-name`"
          v-model="draft.name"
          type="text"
          class="cyber-input"
          :maxlength="STICKER_NAME_MAX"
          required
          data-testid="sticker-name-input"
          :disabled="busy"
        />

        <label class="form-label" :for="`${uid}-description`">{{ t('stickers.manage.description') }}</label>
        <textarea
          :id="`${uid}-description`"
          v-model="draft.description"
          class="cyber-input sticker-description-input"
          :maxlength="STICKER_DESCRIPTION_MAX"
          rows="2"
          required
          :aria-describedby="`${uid}-description-hint`"
          data-testid="sticker-description-input"
          :disabled="busy"
        ></textarea>
        <span :id="`${uid}-description-hint`" class="setting-hint">{{ t('stickers.manage.descriptionHint') }}</span>

        <div v-if="progress !== null" class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="progress">
          <div class="progress-fill" :style="{ width: progress + '%' }"></div>
        </div>
        <button type="submit" class="btn btn-primary" :disabled="busy || !draft.file" data-testid="sticker-upload-button">
          {{ busy ? t('stickers.manage.uploading') : t('stickers.manage.uploadButton') }}
        </button>
      </template>
    </form>
    <p v-else-if="canManage && max === 0" class="settings-card sticker-upload-notice" data-testid="sticker-uploads-off">
      {{ offNotice }}
    </p>

    <div class="settings-card">
      <div class="sticker-list-header">
        <h3 ref="headingRef" class="sticker-library-subtitle" tabindex="-1">{{ title }}</h3>
        <span class="sticker-count" data-testid="sticker-count">{{ countLabel }}</span>
      </div>
      <p v-if="stickers.length === 0" class="setting-hint" data-testid="sticker-empty">{{ t('stickers.manage.empty') }}</p>
      <ul v-else class="sticker-list">
        <li v-for="sticker in stickers" :key="sticker.id" class="sticker-row" data-testid="sticker-row" :data-sticker-name="sticker.name">
          <img :src="sticker.url" :alt="sticker.description" class="sticker-row-img" loading="lazy" />
          <form v-if="editing?.id === sticker.id" class="sticker-edit" @submit.prevent="saveEdit">
            <label class="sr-only" :for="`${uid}-edit-name`">{{ t('stickers.manage.name') }}</label>
            <input
              :id="`${uid}-edit-name`"
              v-model="editing.name"
              type="text"
              class="cyber-input"
              :maxlength="STICKER_NAME_MAX"
              data-testid="sticker-edit-name"
            />
            <label class="sr-only" :for="`${uid}-edit-description`">{{ t('stickers.manage.description') }}</label>
            <textarea
              :id="`${uid}-edit-description`"
              v-model="editing.description"
              class="cyber-input"
              :maxlength="STICKER_DESCRIPTION_MAX"
              rows="2"
              data-testid="sticker-edit-description"
            ></textarea>
            <div class="sticker-row-actions">
              <button type="submit" class="btn btn-primary" :disabled="busy" data-testid="sticker-edit-save">{{ t('common.save') }}</button>
              <button type="button" class="btn btn-secondary" @click="editing = null">{{ t('common.cancel') }}</button>
            </div>
          </form>
          <div v-else class="sticker-row-text">
            <span class="sticker-row-name">{{ sticker.name }}</span>
            <span class="sticker-row-description">{{ sticker.description }}</span>
          </div>
          <div v-if="canManage && editing?.id !== sticker.id" class="sticker-row-actions">
            <button
              type="button"
              class="btn btn-secondary"
              :aria-label="t('stickers.manage.editLabel', { name: sticker.name })"
              data-testid="sticker-edit"
              @click="startEdit(sticker)"
            >{{ t('common.edit') }}</button>
            <button
              type="button"
              class="btn btn-danger"
              :aria-label="t('stickers.manage.deleteLabel', { name: sticker.name })"
              data-testid="sticker-delete"
              :disabled="busy"
              @click="remove(sticker)"
            >{{ t('common.delete') }}</button>
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
const editing = ref<{ id: string; name: string; description: string } | null>(null)

const atCap = computed(() => props.max !== null && props.max > 0 && props.stickers.length >= props.max)
const countLabel = computed(() => (props.max ? `${props.stickers.length} / ${props.max}` : String(props.stickers.length)))

function setPreview(file: File | null) {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = file ? URL.createObjectURL(file) : null
}

function pick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  draft.file = file
  uploadError.value = null
  setPreview(file)
  if (file && !draft.name.trim()) draft.name = stickerNameFromFile(file.name)
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
  gap: 16px;
}

.sticker-upload {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sticker-library-subtitle {
  margin: 0;
  font-size: 1rem;
}

.sticker-upload-preview {
  max-width: 160px;
  max-height: 160px;
  object-fit: contain;
}

.sticker-description-input {
  resize: vertical;
}

.sticker-error {
  color: var(--error-color, #e5484d);
  margin: 0;
}

.sticker-cap-notice {
  padding: 8px 0;
}

.sticker-list-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.sticker-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sticker-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.sticker-row-img {
  width: 64px;
  height: 64px;
  object-fit: contain;
  flex-shrink: 0;
}

.sticker-row-text,
.sticker-edit {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 160px;
}

.sticker-row-name {
  font-weight: 600;
}

.sticker-row-description {
  color: var(--text-muted, inherit);
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}

.sticker-row-actions {
  display: flex;
  gap: 6px;
}

.progress-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--border-color, rgba(127, 127, 127, 0.3));
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent-color, #0ea5e9);
}
</style>
