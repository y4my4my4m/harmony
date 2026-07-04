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
          maxlength="28"
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

    <!-- Server Banner -->
    <div class="settings-card">
      <div class="form-group">
        <label class="form-label">Server Banner</label>
        <div class="banner-upload-container">
          <div
            class="banner-preview"
            :class="{ 'has-banner': bannerPreviewUrl }"
            :style="bannerPreviewUrl ? { backgroundImage: `url(${bannerPreviewUrl})` } : {}"
            @click="permissions.canChangeServerIcon && triggerBannerInput()"
          >
            <div v-if="!bannerPreviewUrl" class="banner-placeholder">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>
              </svg>
              <span>Click to upload banner</span>
            </div>
            <div v-else class="banner-overlay">
              <span>Change banner</span>
            </div>
          </div>
          <div v-if="permissions.canChangeServerIcon && (server.banner || selectedBannerFile)" class="banner-controls">
            <button
              type="button"
              class="btn btn-danger-outline"
              @click="removeBanner"
              :disabled="loading"
            >
              Remove Banner
            </button>
          </div>
        </div>
        <input
          ref="bannerFileInput"
          type="file"
          accept="image/*"
          class="hidden-file-input"
          @change="handleBannerFileChange"
        />
        <div class="form-hint">
          Recommended: 1280x400px. Displayed at the top of your server.
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Server } from '@/types'
import { useNotificationStore } from '@/stores/useNotification'
import { getServerBannerUrl, getRawServerBannerUrl } from '@/utils/serverUtils'
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
  selectedBannerFile?: File | null
  ownerName: string
  loading: boolean
  permissions: ServerPermissions
}

interface Emits {
  (e: 'update:server', value: Server): void
  (e: 'update:selectedFile', value: File | null): void
  (e: 'file-change', file: File | null): void
  (e: 'banner-change', file: File | null): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const fileInput = ref<HTMLInputElement>()
const bannerFileInput = ref<HTMLInputElement>()
let currentBlobUrl: string | null = null
let currentBannerBlobUrl: string | null = null

// Computed property for icon preview - shows selected file preview or current server icon
const iconPreviewUrl = computed(() => {
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

const bannerTransformFailed = ref(false)

const bannerPreviewUrl = computed(() => {
  if (currentBannerBlobUrl) {
    URL.revokeObjectURL(currentBannerBlobUrl)
    currentBannerBlobUrl = null
  }
  if (props.selectedBannerFile) {
    currentBannerBlobUrl = URL.createObjectURL(props.selectedBannerFile)
    return currentBannerBlobUrl
  }
  if (!props.server.banner) return null
  if (bannerTransformFailed.value) {
    return getRawServerBannerUrl(props.server.banner)
  }
  return getServerBannerUrl(props.server.banner, { width: 640, height: 200 })
})

watch(() => props.server.banner, (bannerPath) => {
  bannerTransformFailed.value = false
  const transformed = getServerBannerUrl(bannerPath, { width: 640, height: 200 })
  if (!transformed) return
  const img = new Image()
  img.onerror = () => { bannerTransformFailed.value = true }
  img.src = transformed
}, { immediate: true })

const triggerBannerInput = () => {
  if (!props.permissions.canChangeServerIcon) return
  bannerFileInput.value?.click()
}

const handleBannerFileChange = (event: Event) => {
  if (!props.permissions.canChangeServerIcon) return
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] || null

  if (file) {
    if (file.size > 10 * 1024 * 1024) {
      notificationStore.showToast('error', t('common.error'), 'Banner file is too large (max 10MB)', 3000)
      return
    }
    if (!file.type.startsWith('image/')) {
      notificationStore.showToast('error', t('common.error'), t('server.selectValidImageFile'), 3000)
      return
    }
  }

  emit('banner-change', file)
  if (input) input.value = ''
}

const removeBanner = () => {
  if (!props.permissions.canChangeServerIcon) return
  const updatedServer = { ...props.server, banner: '' }
  emit('update:server', updatedServer)
  emit('banner-change', null)
}

const triggerFileInput = () => {
  if (!props.permissions.canChangeServerIcon) return
  fileInput.value?.click()
}

const handleFileInputChange = (event: Event) => {
  if (!props.permissions.canChangeServerIcon) return
  
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] || null
  
  if (file) {
    if (file.size > 8 * 1024 * 1024) {
      notificationStore.showToast('error', t('common.error'), t('server.fileSizeTooLarge'), 3000)
      return
    }
    
    if (!file.type.startsWith('image/')) {
      notificationStore.showToast('error', t('common.error'), t('server.selectValidImageFile'), 3000)
      return
    }
  }
  
  emit('file-change', file)
  
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
  // Belt-and-suspenders: maxlength enforces this in the native input, but
  // paste-then-truncate keeps the model in sync with the visible value.
  const newName = (event.target as HTMLInputElement).value.slice(0, 28)
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
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-card {
  background-color: var(--background-secondary);
  border-radius: 8px;
  padding: 24px;
  border: 1px solid var(--background-quaternary);
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
  color: var(--text-secondary);
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
  color: var(--text-secondary);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.form-input,
.form-textarea {
  width: 100%;
  padding: 12px;
  background-color: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  transition: border-color 0.15s ease;
}

.form-input:focus,
.form-textarea:focus {
  outline: none;
  border-color: #0EA5E9;
}

.form-input:disabled,
.form-textarea:disabled,
.form-input.read-only,
.form-textarea.read-only {
  opacity: 0.7;
  cursor: default;
  background-color: var(--input-bg);
}

.form-input.read-only:focus,
.form-textarea.read-only:focus {
  border-color: var(--background-quaternary);
}

.form-textarea {
  resize: vertical;
  min-height: 80px;
}

.form-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 8px;
}

.read-only-hint {
  font-size: 12px;
  color: var(--text-muted);
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
  background-color: var(--surface-inset);
  border-radius: 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
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
  border: 2px solid var(--background-quaternary);
}

.no-icon-placeholder {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background-color: var(--surface-inset);
  border: 2px solid var(--input-border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
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
  background-color: var(--background-quaternary);
  color: var(--text-primary);
  border: 1px solid var(--input-border);
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--background-quaternary);
}

.btn-danger-outline {
  background-color: transparent;
  color: #ed4245;
  border: 1px solid #ed4245;
}

.btn-danger-outline:hover:not(:disabled) {
  background-color: #ed4245;
  color: var(--text-primary);
}

.hidden-file-input {
  display: none;
}

/* Banner upload */
.banner-upload-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 8px;
}

.banner-preview {
  width: 100%;
  height: 120px;
  border-radius: 8px;
  background-size: cover;
  background-position: center;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  border: 2px dashed var(--background-quaternary);
  transition: border-color 0.2s;
}

.banner-preview.has-banner {
  border-style: solid;
}

.banner-preview:hover {
  border-color: #0EA5E9;
}

.banner-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--text-muted);
  font-size: 13px;
}

.banner-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  color: white;
  font-size: 14px;
  font-weight: 500;
  opacity: 0;
  transition: opacity 0.2s;
}

.banner-preview:hover .banner-overlay {
  opacity: 1;
}

.banner-controls {
  display: flex;
  gap: 8px;
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