<template>
  <div class="server-emoji-management">
    <div class="settings-section">
      <h2 class="section-title">{{ $t('server.emoji') }}</h2>
      <p class="section-description">
        {{ permissions.canUpload ? $t('server.customEmojisDesc') : $t('server.customEmojis') }}
      </p>
    </div>

    <!-- Permission Notice for Read-Only Users -->
    <div v-if="!permissions.canUpload && !permissions.canDelete" class="permission-notice">
      <div class="notice-content">
        <svg class="notice-icon" width="20" height="20" viewBox="0 0 24 24">
          <path fill="currentColor" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
        </svg>
        <div class="notice-text">
          <h3>{{ $t('confirmation.emojiViewOnlyAccess') }}</h3>
          <p>{{ $t('confirmation.emojiViewOnlyMessage') }}</p>
        </div>
      </div>
    </div>
  
    <div class="settings-card" v-if="permissions.canManageCrossServer">
      <div class="form-group">
        <div class="setting-row">
          <div class="setting-info">
            <span :id="`${uid}-cross-label`" class="form-label">{{ $t('server.allowCrossServer') }}</span>
            <div :id="`${uid}-cross-hint`" class="form-hint">
              {{ $t('server.allowCrossServerDesc') }}
            </div>
          </div>
          <div class="setting-control">
            <label class="toggle-switch">
              <input
                type="checkbox"
                role="switch"
                :aria-labelledby="`${uid}-cross-label`"
                :aria-describedby="`${uid}-cross-hint`"
                :checked="allowCrossServer"
                @change="handleCrossServerToggle"
                :disabled="loading"
              />
              <span class="toggle-slider" aria-hidden="true"></span>
            </label>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-card" v-if="permissions.canUpload">
      <div class="form-group">
        <span :id="`${uid}-upload-label`" class="form-label">{{ $t('server.uploadEmoji') }}</span>
        <label
          class="emoji-upload-area file-pick"
          :class="{ 'dragover': isDragOver }"
          data-testid="emoji-upload-area"
          @drop="handleDrop"
          @dragover.prevent="isDragOver = true"
          @dragleave="isDragOver = false"
        >
          <svg class="upload-icon" width="48" height="48" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/>
          </svg>
          <span class="upload-text" aria-hidden="true">{{ $t('files.upload') }}</span>
          <span :id="`${uid}-upload-hint`" class="upload-hint">{{ $t('server.emojiUploadRecommendation') }}</span>

          <input
            ref="emojiFileInput"
            type="file"
            accept="image/png,image/gif,image/webp,image/apng,image/svg+xml,image/jpeg"
            multiple
            class="sr-only"
            data-testid="emoji-upload-input"
            :aria-labelledby="`${uid}-upload-label`"
            :aria-describedby="`${uid}-upload-hint`"
            :aria-busy="uploadingEmoji || undefined"
            :aria-disabled="uploadingEmoji || undefined"
            :disabled="loading"
            @click="uploadingEmoji && $event.preventDefault()"
            @change="handleEmojiUpload"
          />
        </label>

        <!-- Upload Progress -->
        <div v-if="uploadProgress.total > 0" class="upload-progress">
          <div class="progress-header">
            <span :id="`${uid}-progress-label`" class="progress-text">
              {{ $t('server.uploadingEmojis', { current: uploadProgress.current, total: uploadProgress.total }) }}
            </span>
            <span class="progress-count" aria-hidden="true">{{ uploadProgress.completed }}/{{ uploadProgress.total }}</span>
          </div>
          <div
            class="progress-bar"
            role="progressbar"
            :aria-labelledby="`${uid}-progress-label`"
            aria-valuemin="0"
            :aria-valuemax="uploadProgress.total"
            :aria-valuenow="uploadProgress.completed"
          >
            <div 
              class="progress-fill" 
              :style="{ width: (uploadProgress.completed / uploadProgress.total * 100) + '%' }"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-card">
      <div class="emoji-list-header">
        <div class="header-left">
          <h3 class="emoji-list-title">{{ $t('server.customEmojis') }}</h3>
          <div class="emoji-count">{{ emojis.length }} / {{ maxEmojis }}</div>
        </div>
        
        <div class="header-right" v-if="emojis.length > 0">
          <button
            v-if="!selectionMode"
            ref="selectToggle"
            type="button"
            class="btn btn-secondary"
            @click="enterSelectionMode"
            :disabled="!permissions.canDelete && !permissions.canRename"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M19,19H5V5H19V19M17,17H7V16L12,11L17,16V17Z"/>
            </svg>
            {{ $t('common.select') }}
          </button>
          
          <div v-else class="selection-controls">
            <span class="selection-count">{{ $t('common.select') }}: {{ selectedEmojis.length }}</span>
            <div class="selection-actions">
              <button
                type="button"
                class="btn btn-danger"
                @click="bulkDeleteSelected"
                :disabled="selectedEmojis.length === 0 || deletingEmoji === 'bulk'"
                v-if="permissions.canDelete"
              >
                <span v-if="deletingEmoji === 'bulk'" class="btn-spinner" aria-hidden="true"></span>
                <svg v-else width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
                </svg>
                {{ deletingEmoji === 'bulk' ? $t('common.deleting') : $t('common.delete') }} ({{ selectedEmojis.length }})
              </button>
              <button
                type="button"
                class="btn btn-secondary"
                @click="exitSelectionMode"
                :disabled="deletingEmoji === 'bulk'"
              >
                {{ $t('common.cancel') }}
              </button>
            </div>
          </div>
        </div>
      </div>
      
      <EmptyState
        v-if="emojis.length === 0"
        icon="smile"
        :title="$t('server.noEmojis')"
        :description="permissions.canUpload ? $t('server.addFirstEmoji') : undefined"
      />
      
      <div v-else ref="emojiGrid" class="emoji-grid">
        <div 
          v-for="emoji in emojis" 
          :key="emoji.id"
          class="emoji-item"
          :class="{ 
            'selected': selectedEmojis.includes(emoji.id),
            'selection-mode': selectionMode,
            'renaming': renamingEmoji === emoji.id
          }"
          @click="selectionMode ? toggleEmojiSelection(emoji.id) : null"
          @keydown.space.prevent="selectionMode ? toggleEmojiSelection(emoji.id) : null"
          :tabindex="selectionMode ? 0 : undefined"
          :role="selectionMode ? 'checkbox' : undefined"
          :aria-checked="selectionMode ? selectedEmojis.includes(emoji.id) : undefined"
          :aria-label="selectionMode ? emoji.name : undefined"
        >
          <!-- Selection Checkbox -->
          <div v-if="selectionMode" class="selection-checkbox">
            <input
              type="checkbox"
              :checked="selectedEmojis.includes(emoji.id)"
              @change="toggleEmojiSelection(emoji.id)"
              @click.stop
              tabindex="-1"
              :aria-hidden="true"
            />
          </div>
          
          <div class="emoji-preview">
            <img :src="getEmojiUrl(emoji.url, 48)" :alt="emoji.name" class="emoji-image" />
          </div>
          
          <div class="emoji-details">
            <!-- Editable emoji name -->
            <div v-if="renamingEmoji === emoji.id" class="emoji-name-edit">
              <input
                :ref="el => { if (el) emojiRenameInput = el as any }"
                v-model="tempEmojiName"
                type="text"
                class="emoji-name-input"
                data-testid="emoji-rename-input"
                :aria-label="t('server.emojiActions.renameField', { name: `:${emoji.name}:` })"
                :placeholder="emoji.name"
                @keydown.enter.prevent="saveEmojiRename(emoji, true)"
                @keydown.escape.prevent="endRename(emoji.id, true)"
                @blur="saveEmojiRename(emoji)"
              />
            </div>
            <div v-else class="emoji-name">:{{ emoji.name }}:</div>
            
            <div class="emoji-meta">
              <span v-if="emoji.file_size">{{ formatFileSize(emoji.file_size) }}</span>
              <span>{{ formatDate((emoji.created_at ?? '') as any) }}</span>
            </div>
          </div>
          
          <div class="emoji-actions" v-if="!selectionMode">
            <button
              type="button"
              class="action-btn copy-btn"
              @click="copyEmojiName(emoji.name)"
              :aria-label="t('server.emojiActions.copy', { name: `:${emoji.name}:` })"
              :title="$t('server.copyEmojiName')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z"/>
              </svg>
            </button>
            <button
              v-if="permissions.canRename"
              type="button"
              class="action-btn rename-btn"
              :data-emoji-rename="emoji.id"
              @click="startEmojiRename(emoji)"
              :disabled="renamingEmoji === emoji.id"
              :aria-label="t('server.emojiActions.rename', { name: `:${emoji.name}:` })"
              :title="$t('server.renameEmoji')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
              </svg>
            </button>
            <button
              v-if="permissions.canDelete"
              type="button"
              class="action-btn delete-btn"
              @click="confirmDeleteEmoji(emoji)"
              :disabled="deletingEmoji === emoji.id"
              :aria-label="t('server.emojiActions.delete', { name: `:${emoji.name}:` })"
              :title="$t('server.deleteEmojiTitle')"
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

<script setup lang="ts">
import { ref, nextTick, computed, useId } from 'vue'
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { uploadEmoji, deleteEmoji, renameEmoji, bulkUploadEmojis, bulkDeleteEmojis } from '@/services/emojiService'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { getEmojiUrl } from '@/utils/emojiUtils'
import { UploadRejectedError, imageSourceError } from '@/utils/uploadValidation'
import { MAX_IMAGE_SOURCE_BYTES } from '@/utils/imageResize'
import type { Emoji } from '@/types'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useProfileStore } from '@/stores/useProfile'
import EmptyState from '@/components/common/EmptyState.vue'

const { t } = useI18n()
const uid = `sem-${useId()}`
const { confirm } = useConfirmDialog()
const instanceSettings = useInstanceSettingsStore()

// Use instance config limit; 0 = unlimited, fallback to 50 when not loaded
const maxEmojis = computed(() => {
  const limit = instanceSettings.settings.maxCustomEmojisPerServer
  return limit > 0 ? limit : 50
})

interface EmojiPermissions {
  canUpload: boolean
  canDelete: boolean
  canRename: boolean
  canManageCrossServer: boolean
}

interface Props {
  emojis: Emoji[]
  allowCrossServer: boolean
  serverId: string
  ownerId: string
  loading: boolean
  permissions: EmojiPermissions
}

interface Emits {
  (e: 'update:emojis', value: Emoji[]): void
  (e: 'update:allowCrossServer', value: boolean): void
  (e: 'emoji-uploaded', emoji: Emoji): void
  (e: 'emoji-deleted', emojiId: string): void
  (e: 'emojis-bulk-deleted', emojiIds: string[]): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const toast = useToast()
const emojiCache = useEmojiCacheStore()
const emojiFileInput = ref<HTMLInputElement>()
const uploadingEmoji = ref(false)
const deletingEmoji = ref<string | null>(null)
const isDragOver = ref(false)

// Selection mode state
const selectionMode = ref(false)
const selectedEmojis = ref<string[]>([])

// Renaming state  
const renamingEmoji = ref<string | null>(null)
const tempEmojiName = ref('')
const renameSaving = ref(false)
const emojiRenameInput = ref<HTMLInputElement>()

// Upload progress tracking
const uploadProgress = ref({
  total: 0,
  current: 0,
  completed: 0,
  currentFile: ''
})

// The uploader is whoever uploads; ownerId stands in only before the profile loads.
const profileStore = useProfileStore()
const uploaderId = (): string => profileStore.profile?.id ?? props.ownerId

const handleCrossServerToggle = (event: Event) => {
  if (!props.permissions.canManageCrossServer) return
  const target = event.target as HTMLInputElement
  emit('update:allowCrossServer', target.checked)
}

const handleDrop = (event: DragEvent) => {
  if (!props.permissions.canUpload) return
  event.preventDefault()
  isDragOver.value = false
  const files = event.dataTransfer?.files
  if (files && files.length > 0) {
    const fileArray = Array.from(files)
    if (fileArray.length === 1) {
      handleEmojiFile(fileArray[0])
    } else {
      handleBulkEmojiUpload(fileArray)
    }
  }
}

const handleEmojiUpload = (event: Event) => {
  const input = event.target as HTMLInputElement
  if (!props.permissions.canUpload || uploadingEmoji.value) {
    input.value = ''
    return
  }
  const files = input.files
  if (files && files.length > 0) {
    const fileArray = Array.from(files)
    if (fileArray.length === 1) {
      handleEmojiFile(fileArray[0])
    } else {
      handleBulkEmojiUpload(fileArray)
    }
  }
  if (input) {
    input.value = ''
  }
}

const handleEmojiFile = async (file: File) => {
  if (!props.permissions.canUpload) {
    toast.error(t('server.noPermissionUploadEmojis'))
    return
  }

  // uploadEmoji applies the emojis bucket limits to the file it uploads; those
  // reject SVG, an XSS vector (<script>, event handlers).
  const sourceError = imageSourceError(file)
  if (sourceError) {
    toast.error(sourceError)
    return
  }

  if (props.emojis.length >= maxEmojis.value) {
    toast.error(t('server.maxEmojisReached', { max: maxEmojis.value }))
    return
  }

  try {
    uploadingEmoji.value = true
    debug.log('Uploading emoji with cache integration...')
    
    const newEmoji = await uploadEmoji(props.serverId, uploaderId(), file)
    
    if (newEmoji) {
      emit('emoji-uploaded', newEmoji)
      toast.success(t('server.emojiUploadedSuccess', { name: newEmoji.name }))
    }
  } catch (error) {
    debug.error('Error uploading emoji:', error)
    toast.error(error instanceof UploadRejectedError ? error.message : t('server.failedToUploadEmoji'))
  } finally {
    uploadingEmoji.value = false
  }
}

const confirmDeleteEmoji = async (emoji: Emoji) => {
  if (!props.permissions.canDelete) {
    toast.error(t('server.noPermissionDeleteEmojis'))
    return
  }

  if (!(await confirm({ title: t('server.deleteEmoji', 'Delete emoji'), message: t('server.confirmDeleteEmoji', { name: emoji.name }), confirmButtonText: t('common.delete', 'Delete'), dangerAction: true }))) {
    return
  }

  try {
    deletingEmoji.value = emoji.id
    debug.log('Deleting emoji with cache integration...')
    
    // deleteEmoji's current signature only takes emojiId; the second argument is
    // tolerated for backwards compatibility, so cast to bypass the strict check.
    const success = await (deleteEmoji as any)(emoji.id, props.serverId)
    
    if (success) {
      emit('emoji-deleted', emoji.id)
      toast.success(t('server.emojiDeletedSuccess', { name: emoji.name }))
    }
  } catch (error) {
    debug.error('Error deleting emoji:', error)
    toast.error(t('server.failedToDeleteEmoji'))
  } finally {
    deletingEmoji.value = null
  }
}

const handleBulkEmojiUpload = async (files: File[]) => {
  if (!props.permissions.canUpload) {
    toast.error(t('server.noPermissionUploadEmojis'))
    return
  }

  const skippedNotImage: string[] = []
  const skippedTooLarge: string[] = []
  const validFiles = files.filter(file => {
    // Reject non-images and SVGs (SVGs are an XSS vector for emoji).
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
      skippedNotImage.push(file.name)
      return false
    }
    if (file.size > MAX_IMAGE_SOURCE_BYTES) {
      skippedTooLarge.push(file.name)
      return false
    }
    return true
  })

  if (skippedNotImage.length > 0) {
    toast.warning(t('server.filesNotImageSkipped', { count: skippedNotImage.length }))
  }
  if (skippedTooLarge.length > 0) {
    toast.warning(t('server.filesTooLargeSkipped', { count: skippedTooLarge.length }))
  }

  if (validFiles.length === 0) {
    toast.error(t('server.noValidImageFiles'))
    return
  }

  if (props.emojis.length + validFiles.length > maxEmojis.value) {
    toast.error(t('server.cannotUploadEmojisLimit', { count: validFiles.length, current: props.emojis.length, max: maxEmojis.value }))
    return
  }

  try {
    uploadingEmoji.value = true
    uploadProgress.value = {
      total: validFiles.length,
      current: 0,
      completed: 0,
      currentFile: ''
    }

    debug.log('Starting bulk emoji upload...')
    const results = await bulkUploadEmojis(props.serverId, uploaderId(), validFiles, (progress) => {
      uploadProgress.value = {
        total: progress.total,
        current: progress.current,
        completed: progress.completed,
        currentFile: progress.currentFile
      }
    })
    
    const successCount = results.filter(r => r !== null).length
    const failedCount = results.length - successCount
    
    results.forEach(emoji => {
      if (emoji) {
        emit('emoji-uploaded', emoji)
      }
    })

    if (successCount > 0) {
      toast.success(t('server.emojisUploadedSuccess', { count: successCount, plural: successCount > 1 ? 's' : '' }))
    }
    if (failedCount > 0) {
      toast.warning(t('server.emojisFailedToUpload', { count: failedCount, plural: failedCount > 1 ? 's' : '' }))
    }
  } catch (error) {
    debug.error('Error in bulk emoji upload:', error)
    toast.error(t('server.failedToUploadEmojis'))
  } finally {
    uploadingEmoji.value = false
    uploadProgress.value = { total: 0, current: 0, completed: 0, currentFile: '' }
  }
}

const selectToggle = ref<HTMLButtonElement | null>(null)
const emojiGrid = ref<HTMLElement | null>(null)

const enterSelectionMode = async () => {
  selectionMode.value = true
  selectedEmojis.value = []
  await nextTick()
  emojiGrid.value?.querySelector<HTMLElement>('[role="checkbox"]')?.focus()
}

const exitSelectionMode = async () => {
  selectionMode.value = false
  selectedEmojis.value = []
  await nextTick()
  selectToggle.value?.focus()
}

const toggleEmojiSelection = (emojiId: string) => {
  const index = selectedEmojis.value.indexOf(emojiId)
  if (index > -1) {
    selectedEmojis.value.splice(index, 1)
  } else {
    selectedEmojis.value.push(emojiId)
  }
}

const bulkDeleteSelected = async () => {
  if (!props.permissions.canDelete || selectedEmojis.value.length === 0) return
  
  const confirmMessage = t('server.confirmDeleteEmojis', { 
    count: selectedEmojis.value.length, 
    plural: selectedEmojis.value.length > 1 ? 's' : '' 
  })
  if (!(await confirm({ title: t('server.deleteEmoji', 'Delete emojis'), message: confirmMessage, confirmButtonText: t('common.delete', 'Delete'), dangerAction: true }))) return

  try {
    deletingEmoji.value = 'bulk'
    debug.log('Starting bulk emoji deletion...')
    
    const results = await bulkDeleteEmojis(selectedEmojis.value)
    
    if (results.success.length > 0) {
      emit('emojis-bulk-deleted', results.success)
      toast.success(t('server.emojisDeletedSuccess', { 
        count: results.success.length, 
        plural: results.success.length > 1 ? 's' : '' 
      }))
    }
    if (results.failed.length > 0) {
      toast.warning(t('server.emojisFailedToDelete', { 
        count: results.failed.length, 
        plural: results.failed.length > 1 ? 's' : '' 
      }))
    }

    // Exit selection mode
    exitSelectionMode()
  } catch (error) {
    debug.error('Error in bulk emoji deletion:', error)
    toast.error(t('server.failedToDeleteEmojis'))
  } finally {
    deletingEmoji.value = null
  }
}

// Renaming methods
const startEmojiRename = async (emoji: Emoji) => {
  if (!props.permissions.canRename) return
  
  renamingEmoji.value = emoji.id
  tempEmojiName.value = emoji.name
  
  await nextTick()
  emojiRenameInput.value?.focus()
  emojiRenameInput.value?.select()
}

const saveEmojiRename = async (emoji: Emoji, restoreFocus = false) => {
  if (renamingEmoji.value !== emoji.id || renameSaving.value) return
  if (!tempEmojiName.value.trim() || tempEmojiName.value === emoji.name) {
    endRename(emoji.id, restoreFocus)
    return
  }

  renameSaving.value = true
  try {
    const success = await renameEmoji(emoji.id, tempEmojiName.value.trim(), props.serverId)
    
    if (success) {
      const updatedEmojis = props.emojis.map(e => 
        e.id === emoji.id ? { ...e, name: tempEmojiName.value.trim() } : e
      )
      emit('update:emojis', updatedEmojis)
      toast.success(t('server.emojiRenamedSuccess', { name: tempEmojiName.value.trim() }))
    } else {
      toast.error(t('server.failedToRenameEmoji'))
    }
  } catch (error) {
    debug.error('Error renaming emoji:', error)
    toast.error(t('server.failedToRenameEmoji'))
  } finally {
    renameSaving.value = false
    endRename(emoji.id, restoreFocus)
  }
}

const endRename = async (emojiId: string, restoreFocus: boolean) => {
  if (renamingEmoji.value !== emojiId) return
  renamingEmoji.value = null
  tempEmojiName.value = ''
  if (!restoreFocus) return
  await nextTick()
  document.querySelector<HTMLElement>(`[data-emoji-rename="${CSS.escape(emojiId)}"]`)?.focus()
}

const copyEmojiName = (name: string) => {
  navigator.clipboard.writeText(`:${name}:`)
  toast.success(t('server.emojiActions.copied', { name: `:${name}:` }))
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleDateString()
}

// Get cache statistics
// eslint-disable-next-line unused-imports/no-unused-vars
const getCacheStats = () => {
  return emojiCache.getCacheStats
}

// Get emoji analytics for this server
// eslint-disable-next-line unused-imports/no-unused-vars
const getEmojiAnalytics = () => {
  return emojiCache.getServerEmojis(props.serverId).length
}
</script>

<style scoped>
.server-emoji-management {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-section {
  margin-bottom: 8px;
}

.section-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

.permission-notice {
  padding: 16px;
  background-color: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: var(--radius-md);
}

.notice-content {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.notice-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--warning);
}

.notice-text h3 {
  margin: 0 0 4px 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--warning);
}

.notice-text p {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.settings-card {
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
  padding: 24px;
  border: 1px solid var(--background-quaternary);
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 8px;
}

.form-hint {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  margin-top: 4px;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.setting-info {
  flex: 1;
}

.setting-control {
  flex-shrink: 0;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--text-muted);
  transition: 0.3s;
  border-radius: 24px;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: var(--text-primary);
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .toggle-slider {
  background-color: var(--harmony-primary);
}

input:checked + .toggle-slider:before {
  transform: translateX(20px);
}

.toggle-switch input:focus-visible + .toggle-slider {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
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

.emoji-list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.header-left {
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

.emoji-count {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  background-color: var(--surface-inset);
  padding: 4px 8px;
  border-radius: var(--radius-lg);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Upload Progress */
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

/* Selection Controls */
.selection-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.selection-count {
  font-size: 13px;
  color: var(--text-secondary);
}

.selection-actions {
  display: flex;
  gap: 8px;
}

/* Buttons */
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
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.btn-danger {
  background-color: var(--error-fill);
  color: var(--text-on-primary);
}

.btn-danger:hover:not(:disabled) {
  background-color: var(--error-fill-hover);
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

/* Selection Checkbox */
.selection-checkbox {
  flex-shrink: 0;
}

.selection-checkbox input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
  pointer-events: none;
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

.emoji-preview {
  flex-shrink: 0;
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
}

.emoji-name-edit {
  margin-bottom: 2px;
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
  border-color: var(--harmony-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--harmony-primary) 25%, transparent);
}

.emoji-meta {
  display: flex;
  gap: 8px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
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

.copy-btn:hover {
  color: var(--text-primary);
}

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
  
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .settings-card {
    padding: 16px;
  }
}
</style>