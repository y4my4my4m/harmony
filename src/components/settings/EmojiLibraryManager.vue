<template>
  <div class="emoji-library">
    <div v-if="canUpload" class="settings-card">
      <span :id="`${uid}-upload-label`" class="form-label">{{ t('server.uploadEmoji') }}</span>
      <label
        class="emoji-upload-area file-pick"
        :class="{ dragover: isDragOver }"
        data-testid="emoji-upload-area"
        @drop="handleDrop"
        @dragover.prevent="isDragOver = true"
        @dragleave="isDragOver = false"
      >
        <svg class="upload-icon" width="48" height="48" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/>
        </svg>
        <span class="upload-text" aria-hidden="true">{{ t('files.upload') }}</span>
        <span :id="`${uid}-upload-hint`" class="upload-hint">{{ t('server.emojiUploadRecommendation') }}</span>

        <input
          type="file"
          accept="image/png,image/gif,image/webp,image/apng,image/jpeg"
          multiple
          class="sr-only"
          data-testid="emoji-upload-input"
          :aria-labelledby="`${uid}-upload-label`"
          :aria-describedby="`${uid}-upload-hint`"
          :aria-busy="uploading || undefined"
          :aria-disabled="uploading || undefined"
          :disabled="disabled"
          @click="uploading && $event.preventDefault()"
          @change="handlePick"
        />
      </label>

      <div v-if="progress.total > 0" class="upload-progress">
        <div class="progress-header">
          <span :id="`${uid}-progress-label`" class="progress-text">
            {{ t('server.uploadingEmojis', { current: progress.current, total: progress.total }) }}
          </span>
          <span class="progress-count" aria-hidden="true">{{ progress.completed }}/{{ progress.total }}</span>
        </div>
        <div
          class="progress-bar"
          role="progressbar"
          :aria-labelledby="`${uid}-progress-label`"
          aria-valuemin="0"
          :aria-valuemax="progress.total"
          :aria-valuenow="progress.completed"
        >
          <div class="progress-fill" :style="{ width: (progress.completed / progress.total * 100) + '%' }"></div>
        </div>
      </div>
    </div>
    <p v-else-if="uploadNotice" class="settings-card emoji-upload-notice" data-testid="emoji-upload-notice">{{ uploadNotice }}</p>

    <div class="settings-card">
      <div class="emoji-list-header">
        <div class="header-left">
          <h3 :id="`${uid}-title`" ref="headingRef" class="emoji-list-title" tabindex="-1">{{ texts.title }}</h3>
          <div class="emoji-count" data-testid="emoji-count">{{ countLabel }}</div>
        </div>

        <div v-if="emojis.length > 0 && canDelete" class="header-right">
          <button
            v-if="!selectionMode"
            ref="selectToggle"
            type="button"
            class="btn btn-secondary"
            @click="enterSelectionMode"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M19,19H5V5H19V19M17,17H7V16L12,11L17,16V17Z"/>
            </svg>
            {{ t('common.select') }}
          </button>

          <div v-else class="selection-controls">
            <span class="selection-count">{{ t('common.select') }}: {{ selected.length }}</span>
            <div class="selection-actions">
              <button
                type="button"
                class="btn btn-danger"
                data-testid="emoji-bulk-delete"
                :disabled="selected.length === 0 || deletingId === BULK"
                @click="deleteSelected"
              >
                <span v-if="deletingId === BULK" class="btn-spinner" aria-hidden="true"></span>
                <svg v-else width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
                </svg>
                {{ deletingId === BULK ? t('common.deleting') : t('common.delete') }} ({{ selected.length }})
              </button>
              <button type="button" class="btn btn-secondary" :disabled="deletingId === BULK" @click="exitSelectionMode">
                {{ t('common.cancel') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <EmptyState v-if="emojis.length === 0" icon="smile" :title="texts.empty" :description="texts.emptyHint" />

      <div
        v-else
        ref="gridRef"
        class="emoji-grid"
        :role="selectionMode ? 'group' : 'list'"
        :aria-labelledby="`${uid}-title`"
      >
        <div
          v-for="emoji in emojis"
          :key="emoji.id"
          class="emoji-item"
          :class="{ selected: selected.includes(emoji.id), 'selection-mode': selectionMode, renaming: renamingId === emoji.id }"
          :data-emoji-id="emoji.id"
          :role="selectionMode ? 'checkbox' : 'listitem'"
          :tabindex="selectionMode ? 0 : undefined"
          :aria-checked="selectionMode ? selected.includes(emoji.id) : undefined"
          :aria-label="selectionMode ? `:${emoji.name}:` : undefined"
          @click="selectionMode && toggleSelection(emoji.id)"
          @keydown.space="onItemSpace($event, emoji.id)"
        >
          <div v-if="selectionMode" class="selection-checkbox" aria-hidden="true">
            <input type="checkbox" :checked="selected.includes(emoji.id)" tabindex="-1" @click.stop="toggleSelection(emoji.id)" />
          </div>

          <div class="emoji-preview">
            <img v-if="emoji.url" :src="getEmojiUrl(emoji.url, 48)" alt="" class="emoji-image" loading="lazy" />
          </div>

          <div class="emoji-details">
            <template v-if="renamingId === emoji.id">
              <input
                ref="renameInput"
                v-model="renameValue"
                type="text"
                class="emoji-name-input"
                data-testid="emoji-rename-input"
                maxlength="64"
                autocomplete="off"
                spellcheck="false"
                :aria-label="t('server.emojiActions.renameField', { name: `:${emoji.name}:` })"
                :aria-invalid="renameError ? 'true' : undefined"
                :aria-describedby="`${uid}-rename-note`"
                :placeholder="emoji.name"
                @keydown.enter.prevent="saveRename(emoji, true)"
                @keydown.escape.prevent="endRename(emoji.id, true)"
                @blur="saveRename(emoji, false)"
              />
              <p :id="`${uid}-rename-note`" class="emoji-rename-note" :class="{ error: renameError }">
                {{ renameError || t('settings.myEmojis.nameHint') }}
              </p>
            </template>
            <div v-else class="emoji-name">:{{ emoji.name }}:</div>

            <div class="emoji-meta">
              <span v-if="emoji.is_ai_generated" class="emoji-badge" :title="t('settings.myEmojis.aiGenerated')">
                <span aria-hidden="true">{{ t('settings.myEmojis.aiBadge') }}</span>
                <span class="sr-only">{{ t('settings.myEmojis.aiGenerated') }}</span>
              </span>
              <span v-if="emoji.usage_count != null">
                {{ t('settings.myEmojis.uses', { count: emoji.usage_count }, emoji.usage_count) }}
              </span>
              <span v-if="emoji.file_size">{{ formatEmojiFileSize(emoji.file_size) }}</span>
              <span v-if="emoji.created_at">{{ formatDate(emoji.created_at) }}</span>
            </div>
          </div>

          <div v-if="!selectionMode && renamingId !== emoji.id" class="emoji-actions">
            <button
              type="button"
              class="action-btn copy-btn"
              data-action="copy"
              :aria-label="t('server.emojiActions.copy', { name: `:${emoji.name}:` })"
              :title="t('server.copyEmojiName')"
              @click="copyName(emoji.name)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z"/>
              </svg>
            </button>
            <button
              v-if="canRename"
              type="button"
              class="action-btn rename-btn"
              data-action="rename"
              :aria-label="t('server.emojiActions.rename', { name: `:${emoji.name}:` })"
              :title="t('server.renameEmoji')"
              @click="startRename(emoji)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
              </svg>
            </button>
            <button
              v-if="canDelete"
              type="button"
              class="action-btn delete-btn"
              data-action="delete"
              :disabled="deletingId === emoji.id"
              :aria-label="t('server.emojiActions.delete', { name: `:${emoji.name}:` })"
              :title="t('server.deleteEmojiTitle')"
              @click="deleteOne(emoji)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts" generic="E extends LibraryEmoji">
import { computed, nextTick, ref, useId } from 'vue'
import { useToast } from 'vue-toastification'
import EmptyState from '@/components/common/EmptyState.vue'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useT } from '@/composables/useT'
import { debug } from '@/utils/debug'
import { getEmojiUrl } from '@/utils/emojiUtils'
import { UploadRejectedError, imageSourceError } from '@/utils/uploadValidation'
import {
  EMOJI_NAME,
  emojiUploadCandidates,
  formatEmojiFileSize,
  hasRoomFor,
  type EmojiLibraryAdapter,
  type EmojiLibraryOperation,
  type EmojiLibraryTexts,
  type LibraryEmoji,
} from './emojiLibrary'

/**
 * Upload, list, rename, copy and delete for one emoji library. Everything that
 * differs between libraries is in the adapter, the limit and the texts.
 */
const props = withDefaults(defineProps<{
  emojis: E[]
  adapter: EmojiLibraryAdapter<E>
  /** null: no limit. */
  max: number | null
  texts: EmojiLibraryTexts
  canUpload?: boolean
  canRename?: boolean
  canDelete?: boolean
  disabled?: boolean
  /** Shown in place of the upload area when canUpload is false. */
  uploadNotice?: string
}>(), {
  canUpload: true,
  canRename: true,
  canDelete: true,
  disabled: false,
  uploadNotice: undefined,
})

const emit = defineEmits<{
  (e: 'uploaded', emoji: E): void
  (e: 'renamed', emoji: E, name: string): void
  (e: 'deleted', ids: string[]): void
}>()

const BULK = '__bulk__'

const { t } = useT()
const toast = useToast()
const { confirm } = useConfirmDialog()
const { polite, assertive } = useAnnouncer()
const uid = `elm-${useId()}`

const isDragOver = ref(false)
const uploading = ref(false)
const progress = ref({ total: 0, current: 0, completed: 0 })
const deletingId = ref<string | null>(null)
const selectionMode = ref(false)
const selected = ref<string[]>([])
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const renameError = ref('')
const renameSaving = ref(false)
const renameInput = ref<HTMLInputElement[] | null>(null)
const headingRef = ref<HTMLElement | null>(null)
const gridRef = ref<HTMLElement | null>(null)
const selectToggle = ref<HTMLButtonElement | null>(null)

const countLabel = computed(() =>
  props.max === null ? String(props.emojis.length) : `${props.emojis.length} / ${props.max}`,
)

function describe(operation: EmojiLibraryOperation, error: unknown, fallback: string): string {
  if (error instanceof UploadRejectedError) return error.message
  return props.adapter.describeError?.(operation, error) ?? fallback
}

function control(id: string, action: 'rename' | 'delete'): HTMLElement | null {
  return gridRef.value?.querySelector<HTMLElement>(`[data-emoji-id="${CSS.escape(id)}"] [data-action="${action}"]`) ?? null
}

// Upload -------------------------------------------------------------------------------
function upload(files: File[]) {
  if (!props.canUpload || uploading.value || files.length === 0) return
  if (files.length === 1) void uploadOne(files[0])
  else void uploadMany(files)
}

function handleDrop(event: DragEvent) {
  event.preventDefault()
  isDragOver.value = false
  upload(Array.from(event.dataTransfer?.files ?? []))
}

function handlePick(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  upload(files)
}

async function uploadOne(file: File) {
  const sourceError = imageSourceError(file)
  if (sourceError) {
    toast.error(sourceError)
    return
  }
  if (!hasRoomFor(props.emojis.length, 1, props.max)) {
    toast.error(t('server.maxEmojisReached', { max: props.max }))
    return
  }
  uploading.value = true
  try {
    const emoji = await props.adapter.upload(file)
    if (!emoji) {
      toast.error(t('server.failedToUploadEmoji'))
      return
    }
    emit('uploaded', emoji)
    toast.success(t('server.emojiUploadedSuccess', { name: emoji.name }))
  } catch (error) {
    debug.error('Emoji upload failed:', error)
    toast.error(describe('upload', error, t('server.failedToUploadEmoji')))
  } finally {
    uploading.value = false
  }
}

async function uploadMany(picked: File[]) {
  const { files, notImage, tooLarge } = emojiUploadCandidates(picked)
  if (notImage.length > 0) toast.warning(t('server.filesNotImageSkipped', { count: notImage.length }))
  if (tooLarge.length > 0) toast.warning(t('server.filesTooLargeSkipped', { count: tooLarge.length }))
  if (files.length === 0) {
    toast.error(t('server.noValidImageFiles'))
    return
  }
  if (!hasRoomFor(props.emojis.length, files.length, props.max)) {
    toast.error(t('server.cannotUploadEmojisLimit', { count: files.length, current: props.emojis.length, max: props.max }))
    return
  }

  uploading.value = true
  progress.value = { total: files.length, current: 0, completed: 0 }
  let failed = 0
  let reason: string | null = null
  try {
    for (const [i, file] of files.entries()) {
      progress.value.current = i + 1
      try {
        const emoji = await props.adapter.upload(file)
        if (emoji) {
          emit('uploaded', emoji)
          progress.value.completed++
        } else {
          failed++
        }
      } catch (error) {
        debug.error(`Emoji upload failed: ${file.name}`, error)
        failed++
        reason ??= describe('upload', error, '') || null
      }
    }
    const succeeded = progress.value.completed
    if (succeeded > 0) toast.success(t('server.emojisUploadedSuccess', { count: succeeded, plural: succeeded > 1 ? 's' : '' }))
    if (failed > 0) toast.warning(t('server.emojisFailedToUpload', { count: failed, plural: failed > 1 ? 's' : '' }))
    if (reason) toast.error(reason)
  } finally {
    uploading.value = false
    progress.value = { total: 0, current: 0, completed: 0 }
  }
}

// Selection and delete -----------------------------------------------------------------
async function enterSelectionMode() {
  selectionMode.value = true
  selected.value = []
  await nextTick()
  gridRef.value?.querySelector<HTMLElement>('[role="checkbox"]')?.focus()
}

async function exitSelectionMode() {
  selectionMode.value = false
  selected.value = []
  await nextTick()
  selectToggle.value?.focus()
}

/** Space toggles an item in selection mode only; elsewhere it types, as in the rename field. */
function onItemSpace(event: KeyboardEvent, id: string) {
  if (!selectionMode.value) return
  event.preventDefault()
  toggleSelection(id)
}

function toggleSelection(id: string) {
  const index = selected.value.indexOf(id)
  if (index > -1) selected.value.splice(index, 1)
  else selected.value.push(id)
}

async function deleteOne(emoji: E) {
  const ok = await confirm({
    title: t('server.deleteEmoji'),
    message: props.texts.confirmDelete(emoji.name),
    confirmButtonText: t('common.delete'),
    dangerAction: true,
  })
  if (!ok) return
  deletingId.value = emoji.id
  try {
    await props.adapter.remove(emoji)
    const index = props.emojis.findIndex((e) => e.id === emoji.id)
    emit('deleted', [emoji.id])
    polite(t('settings.myEmojis.deleted', { name: emoji.name }))
    await nextTick()
    const next = props.emojis[Math.min(index, props.emojis.length - 1)]
    ;(next ? control(next.id, 'delete') : headingRef.value)?.focus()
  } catch (error) {
    debug.error('Emoji delete failed:', error)
    toast.error(describe('delete', error, t('server.failedToDeleteEmoji')))
  } finally {
    deletingId.value = null
  }
}

async function deleteSelected() {
  const chosen = props.emojis.filter((e) => selected.value.includes(e.id))
  if (chosen.length === 0) return
  const ok = await confirm({
    title: t('server.deleteEmoji'),
    message: t('server.confirmDeleteEmojis', { count: chosen.length, plural: chosen.length > 1 ? 's' : '' }),
    confirmButtonText: t('common.delete'),
    dangerAction: true,
  })
  if (!ok) return
  deletingId.value = BULK
  try {
    const { success, failed } = await props.adapter.removeMany(chosen)
    if (success.length > 0) {
      emit('deleted', success)
      toast.success(t('server.emojisDeletedSuccess', { count: success.length, plural: success.length > 1 ? 's' : '' }))
    }
    if (failed.length > 0) {
      toast.warning(t('server.emojisFailedToDelete', { count: failed.length, plural: failed.length > 1 ? 's' : '' }))
    }
    await exitSelectionMode()
    if (props.emojis.length === 0) headingRef.value?.focus()
  } catch (error) {
    debug.error('Bulk emoji delete failed:', error)
    toast.error(describe('delete', error, t('server.failedToDeleteEmojis')))
  } finally {
    deletingId.value = null
  }
}

// Rename -------------------------------------------------------------------------------
async function startRename(emoji: E) {
  if (!props.canRename) return
  renamingId.value = emoji.id
  renameValue.value = emoji.name
  renameError.value = ''
  await nextTick()
  const input = renameInput.value?.[0]
  input?.focus()
  input?.select()
}

async function endRename(id: string, restoreFocus: boolean) {
  if (renamingId.value !== id) return
  renamingId.value = null
  renameValue.value = ''
  renameError.value = ''
  if (!restoreFocus) return
  await nextTick()
  control(id, 'rename')?.focus()
}

function failRename(message: string, refocus: boolean) {
  renameError.value = message
  assertive(message)
  if (refocus) renameInput.value?.[0]?.focus()
}

/** Enter saves and keeps focus on the row; blur saves where the user went. */
async function saveRename(emoji: E, fromKeyboard: boolean) {
  if (renamingId.value !== emoji.id || renameSaving.value) return
  const name = renameValue.value.trim()
  if (!name || name === emoji.name) return endRename(emoji.id, fromKeyboard)
  if (!EMOJI_NAME.test(name)) return failRename(t('settings.myEmojis.errors.invalidName'), fromKeyboard)

  renameSaving.value = true
  try {
    await props.adapter.rename(emoji, name)
    const from = emoji.name
    emit('renamed', emoji, name)
    polite(t('settings.myEmojis.renamed', { from, to: name }))
    await endRename(emoji.id, fromKeyboard)
  } catch (error) {
    debug.error('Emoji rename failed:', error)
    failRename(describe('rename', error, t('server.failedToRenameEmoji')), fromKeyboard)
  } finally {
    renameSaving.value = false
  }
}

// Misc ---------------------------------------------------------------------------------
function copyName(name: string) {
  void navigator.clipboard?.writeText(`:${name}:`)
  toast.success(t('server.emojiActions.copied', { name: `:${name}:` }))
}

function formatDate(value: string | Date): string {
  return new Date(value).toLocaleDateString()
}
</script>

<style scoped>
.emoji-library {
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

.form-label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 8px;
}

.emoji-upload-notice {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.emoji-upload-area {
  display: block;
  border: 2px dashed var(--input-border);
  border-radius: var(--radius-md);
  padding: 32px;
  text-align: center;
  cursor: pointer;
  transition: all 0.15s ease;
  background-color: var(--input-bg);
}

.emoji-upload-area:focus-within {
  border-color: var(--harmony-primary);
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.emoji-upload-area:hover,
.emoji-upload-area.dragover {
  border-color: var(--harmony-primary);
  background-color: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
}

.upload-icon {
  color: var(--text-muted);
  margin-bottom: 12px;
}

.upload-text {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.upload-hint {
  display: block;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  margin: 0;
}

.upload-progress {
  margin-top: 16px;
  padding: 12px;
  background-color: var(--surface-inset);
  border-radius: var(--radius-base);
  border: 1px solid var(--background-quaternary);
}

.progress-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.progress-text {
  font-size: 13px;
  color: var(--text-secondary);
}

.progress-count {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.progress-bar {
  width: 100%;
  height: 6px;
  background-color: var(--background-quaternary);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background-color: var(--harmony-primary);
  transition: width 0.3s ease;
}

.emoji-list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.header-left,
.header-right,
.selection-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.emoji-list-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0;
}

.emoji-list-title:focus {
  outline: none;
}

.emoji-count {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  background-color: var(--surface-inset);
  padding: 4px 8px;
  border-radius: var(--radius-lg);
}

.selection-count {
  font-size: 13px;
  color: var(--text-secondary);
}

.selection-actions {
  display: flex;
  gap: 8px;
}

.btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-secondary {
  background-color: var(--background-quaternary);
  color: var(--text-secondary);
  border: 1px solid var(--input-border);
}

.btn-secondary:hover:not(:disabled) {
  color: var(--text-primary);
}

.btn-danger {
  background-color: var(--error-fill);
  color: var(--text-on-primary);
}

.btn-danger:hover:not(:disabled) {
  background-color: var(--error-fill-hover);
}

.btn-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: btn-spin 0.6s linear infinite;
}

@keyframes btn-spin {
  to { transform: rotate(360deg); }
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.emoji-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background-color: var(--surface-inset);
  border-radius: var(--radius-base);
  border: 1px solid var(--background-quaternary);
  transition: all 0.15s ease;
}

.emoji-item.selection-mode {
  cursor: pointer;
}

.emoji-item.selection-mode:hover {
  background-color: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.emoji-item.selected {
  background-color: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  border-color: var(--harmony-primary);
}

.emoji-item.renaming {
  border-color: var(--harmony-primary);
  background-color: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
}

.emoji-item:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.selection-checkbox {
  flex-shrink: 0;
}

.selection-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  pointer-events: none;
}

.emoji-preview {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
}

.emoji-image {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.emoji-details {
  flex: 1;
  min-width: 0;
}

.emoji-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.emoji-name-input {
  width: 100%;
  padding: 4px 8px;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  background-color: var(--background-secondary);
  border: 1px solid var(--harmony-primary);
  border-radius: var(--radius-sm);
  outline: none;
}

.emoji-name-input:focus {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--harmony-primary) 25%, transparent);
}

.emoji-name-input[aria-invalid='true'] {
  border-color: var(--text-danger);
}

.emoji-rename-note {
  margin: 4px 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.emoji-rename-note.error {
  color: var(--text-danger);
}

.emoji-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.emoji-badge {
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: var(--background-tertiary);
  color: var(--text-link);
  font-weight: var(--font-weight-semibold);
}

.emoji-actions {
  display: flex;
  gap: 4px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s ease;
  color: var(--text-secondary);
}

.action-btn:hover {
  background-color: var(--background-quaternary);
}

.copy-btn:hover,
.rename-btn:hover {
  color: var(--text-primary);
}

.delete-btn:hover {
  color: var(--text-danger);
}

.action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .emoji-grid {
    grid-template-columns: 1fr;
  }

  .settings-card {
    padding: 16px;
  }
}
</style>
