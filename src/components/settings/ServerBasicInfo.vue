<template>
  <div class="server-basic-info">
    <div class="settings-section">
      <h2 class="section-title">{{ $t('server.serverOverview') }}</h2>
      <p class="section-description">
        {{ permissions.canEditBasicInfo ? $t('server.basicInformation') : $t('server.viewBasicInformation') }}
      </p>
    </div>

    <!-- Permission Warning for Read-Only Users -->
    <div v-if="!permissions.canEditBasicInfo" class="permission-notice">
      <div class="notice-content">
        <svg class="notice-icon" width="20" height="20" viewBox="0 0 24 24">
          <path fill="#faa61a" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
        </svg>
        <div class="notice-text">
          <h4>{{ $t('server.viewOnlyAccess') }}</h4>
          <p>{{ $t('server.viewOnlyMessage') }}</p>
        </div>
      </div>
    </div>

    <div class="settings-card">
      <div class="form-group">
        <label class="form-label" for="server-name">{{ $t('server.serverName') }}</label>
        <input
          id="server-name"
          :value="server.name"
          @input="updateServerName"
          type="text"
          class="form-input"
          :class="{ 'read-only': !permissions.canChangeServerName }"
          :placeholder="$t('server.enterServerName')"
          :disabled="loading || !permissions.canChangeServerName"
          :readonly="!permissions.canChangeServerName"
          maxlength="100"
        />
        <div class="form-hint">
          {{ permissions.canEditBasicInfo ? $t('server.serverNameAppearance') : $t('server.serverNameAppearanceView') }}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="server-description">{{ $t('server.description') }}</label>
        <textarea
          id="server-description"
          :value="server.description"
          @input="updateServerDescription"
          class="form-textarea"
          :class="{ 'read-only': !permissions.canChangeServerDescription }"
          :placeholder="$t('server.tellPeopleAbout')"
          :disabled="loading || !permissions.canChangeServerDescription"
          :readonly="!permissions.canChangeServerDescription"
          maxlength="500"
          rows="4"
        />
        <div class="form-hint">
          {{ $t('server.charactersRemaining', { current: server.description?.length || 0, max: 500 }) }}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">{{ $t('server.serverOwner') }}</label>
        <div class="owner-info">
          <div class="owner-badge">
            <svg class="crown-icon" width="16" height="16" viewBox="0 0 24 24">
              <path fill="#faa61a" d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zM12 13l-3-3l-2 2l5 5l5-5l-2-2l-3 3z"/>
            </svg>
            {{ ownerName }}
          </div>
        </div>
        <div class="form-hint">
          {{ $t('server.serverOwnerPrivileges') }}
        </div>
      </div>
    </div>

    <div class="settings-card">
      <div class="form-group">
        <label class="form-label">{{ $t('server.serverIcon') }}</label>
        <div class="icon-upload-container">
          <div class="current-icon">
            <ServerIcon
              v-if="iconPreviewUrl"
              :src="iconPreviewUrl"
              alt="Server icon"
              class="server-icon-preview"
            />
            <div v-else class="no-icon-placeholder">
              <svg width="48" height="48" viewBox="0 0 24 24">
                <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
            </div>
          </div>
          <div class="icon-upload-controls" v-if="permissions.canChangeServerIcon">
            <button
              type="button"
              class="btn btn-secondary"
              @click="triggerFileInput"
              :disabled="loading"
            >
              {{ $t('server.uploadImage') }}
            </button>
            <button
              v-if="server.icon || props.selectedFile"
              type="button"
              class="btn btn-danger-outline"
              @click="removeIcon"
              :disabled="loading"
            >
              {{ $t('server.remove') }}
            </button>
          </div>
          <div v-else-if="!server.icon && !props.selectedFile" class="no-icon-info">
            <p class="read-only-hint">{{ $t('server.noServerIconSet') }}</p>
          </div>
        </div>
        <input
          ref="fileInput"
          type="file"
          accept="image/*"
          class="hidden-file-input"
          @change="handleFileInputChange"
        />
        <div class="form-hint">
          {{ permissions.canChangeServerIcon 
            ? $t('server.iconRecommendation')
            : $t('server.iconRestriction')
          }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Server } from '@/types'
import { useNotificationStore } from '@/stores/useNotification'
import ServerIcon from '@/components/common/ServerIcon.vue'

const { t } = useI18n()
const notificationStore = useNotificationStore()

interface ServerPermissions {
  canEditBasicInfo: boolean
  canChangeServerName: boolean
  canChangeServerDescription: boolean
  canChangeServerIcon: boolean
  canChangePrivacySettings: boolean
}

interface Props {
  server: Server
  selectedFile: File | null
  ownerName: string
  loading: boolean
  permissions: ServerPermissions
}

interface Emits {
  (e: 'update:server', value: Server): void
  (e: 'update:selectedFile', value: File | null): void
  (e: 'file-change', file: File | null): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const fileInput = ref<HTMLInputElement>()
let currentBlobUrl: string | null = null

// Computed property for icon preview - shows selected file preview or current server icon
const iconPreviewUrl = computed(() => {
  // Clean up previous blob URL
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl)
    currentBlobUrl = null
  }
  
  if (props.selectedFile) {
    currentBlobUrl = URL.createObjectURL(props.selectedFile)
    return currentBlobUrl
  }
  return props.server.icon || null
})

const triggerFileInput = () => {
  if (!props.permissions.canChangeServerIcon) return
  fileInput.value?.click()
}

const handleFileInputChange = (event: Event) => {
  if (!props.permissions.canChangeServerIcon) return
  
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] || null
  
  if (file) {
    // Validate file size (8MB limit)
    if (file.size > 8 * 1024 * 1024) {
      notificationStore.showToast('error', t('common.error'), t('server.fileSizeTooLarge'), 3000)
      return
    }
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
      notificationStore.showToast('error', t('common.error'), t('server.selectValidImageFile'), 3000)
      return
    }
  }
  
  emit('file-change', file)
  
  // Clear the input so the same file can be selected again
  if (input) {
    input.value = ''
  }
}

const removeIcon = () => {
  if (!props.permissions.canChangeServerIcon) return
  const updatedServer = { ...props.server, icon: '' }
  emit('update:server', updatedServer)
  emit('update:selectedFile', null)
}

const updateServerName = (event: Event) => {
  if (!props.permissions.canChangeServerName) return
  const newName = (event.target as HTMLInputElement).value
  const updatedServer = { ...props.server, name: newName }
  emit('update:server', updatedServer)
}

const updateServerDescription = (event: Event) => {
  if (!props.permissions.canChangeServerDescription) return
  const newDescription = (event.target as HTMLTextAreaElement).value
  const updatedServer = { ...props.server, description: newDescription }
  emit('update:server', updatedServer)
}
</script>

<style scoped>
.server-basic-info {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-section {
  margin-bottom: 8px;
}

.section-title {
  font-size: 24px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.section-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.settings-card {
  background-color: var(--h-chat);
  border-radius: 8px;
  padding: 24px;
  border: 1px solid var(--h-chat-light);
}

/* Permission Notice */
.permission-notice {
  margin-bottom: 24px;
  padding: 16px;
  background-color: rgba(250, 166, 26, 0.1);
  border: 1px solid rgba(250, 166, 26, 0.3);
  border-radius: 8px;
}

.notice-content {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.notice-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: #faa61a;
}

.notice-text h4 {
  margin: 0 0 4px 0;
  font-size: 14px;
  font-weight: 600;
  color: #faa61a;
}

.notice-text p {
  margin: 0;
  font-size: 13px;
  color: #b9bbbe;
  line-height: 1.4;
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: #b9bbbe;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.form-input,
.form-textarea {
  width: 100%;
  padding: 12px;
  background-color: var(--h-chat-darker);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  color: #ffffff;
  font-size: 14px;
  transition: border-color 0.15s ease;
}

.form-input:focus,
.form-textarea:focus {
  outline: none;
  border-color: #5865f2;
}

.form-input:disabled,
.form-textarea:disabled,
.form-input.read-only,
.form-textarea.read-only {
  opacity: 0.7;
  cursor: default;
  background-color: var(--h-chat-darker);
}

.form-input.read-only:focus,
.form-textarea.read-only:focus {
  border-color: var(--h-chat-light);
}

.form-textarea {
  resize: vertical;
  min-height: 80px;
}

.form-hint {
  font-size: 12px;
  color: #72767d;
  margin-top: 8px;
}

.read-only-hint {
  font-size: 12px;
  color: #72767d;
  margin: 0;
  font-style: italic;
}

.owner-info {
  margin-bottom: 8px;
}

.owner-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background-color: var(--h-chat-darker);
  border-radius: 16px;
  font-size: 14px;
  font-weight: 500;
  color: #ffffff;
}

.crown-icon {
  flex-shrink: 0;
}

.icon-upload-container {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 8px;
}

.current-icon {
  flex-shrink: 0;
}

.server-icon-preview {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid var(--h-chat-light);
}

.no-icon-placeholder {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background-color: var(--h-chat-darker);
  border: 2px solid var(--h-chat-light);
  display: flex;
  align-items: center;
  justify-content: center;
  color: #72767d;
}

.icon-upload-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.no-icon-info {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.btn {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-secondary {
  background-color: var(--h-chat-darker);
  color: #ffffff;
  border: 1px solid var(--h-chat-light);
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--h-chat-light);
}

.btn-danger-outline {
  background-color: transparent;
  color: #ed4245;
  border: 1px solid #ed4245;
}

.btn-danger-outline:hover:not(:disabled) {
  background-color: #ed4245;
  color: #ffffff;
}

.hidden-file-input {
  display: none;
}

@media (max-width: 768px) {
  .icon-upload-container {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
  
  .icon-upload-controls {
    flex-direction: row;
    width: 100%;
  }
  
  .settings-card {
    padding: 16px;
  }
}
</style>