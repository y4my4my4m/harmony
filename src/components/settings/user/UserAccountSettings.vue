<template>
  <div class="user-account-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.account') }}</h2>
      <p class="settings-description">
        Manage your account settings and set e-mail preferences.
      </p>
    </div>

    <div class="settings-section">
      <div class="profile-preview">
        <div 
          class="profile-banner" 
          :style="bannerStyle"
          @click="triggerBannerUpload"
        >
          <div class="banner-overlay">
            <Icon name="camera" />
            <span>{{ $t('user.banner') }}</span>
          </div>
          <input
            ref="bannerInput"
            type="file"
            accept="image/*"
            @change="handleBannerFileSelect"
            style="display: none"
          />
        </div>
        <div class="profile-info">
          <div class="avatar-wrapper">
            <Avatar 
              :src="profile?.avatar_url"
              :alt="$t('user.avatar')"
              size="xl"
              :editable="true"
              :loading="loading"
              @upload="handleAvatarUpload"
            />
          </div>
          <div class="user-info">
            <h3 class="display-name" :style="{ color: profile?.color || '#ffffff' }">
              {{ profile?.display_name || $t('auth.displayName') }}
            </h3>
            <p class="username">{{ profile?.username || $t('auth.username') }}</p>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="form-group">
        <label class="form-label">{{ $t('auth.displayName') }}</label>
        <input
          v-model="localProfile.display_name"
          type="text"
          class="form-input"
          :placeholder="$t('auth.displayName')"
          maxlength="32"
          @input="onProfileChange"
        />
        <div class="form-hint">
          This is how others see you. You can use special characters and emoji.
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">{{ $t('auth.username') }}</label>
        <div class="username-input-container">
          <input
            v-model="localProfile.username"
            type="text"
            class="form-input"
            :placeholder="$t('auth.username')"
            maxlength="32"
            @input="onUsernameChange"
          />
        </div>
        <div class="form-hint">
          This is your unique username. Only letters, numbers, and underscores allowed.
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">{{ $t('user.bio') }}</label>
        <textarea
          v-model="localProfile.bio"
          class="form-textarea"
          :placeholder="$t('user.placeholders.bio')"
          maxlength="190"
          rows="3"
          @input="onProfileChange"
        ></textarea>
        <div class="form-hint">
          {{ (localProfile.bio?.length || 0) }}/190 characters
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Profile Color</label>
        <div class="color-picker-container">
          <div class="color-preview-row">
            <div 
              class="color-preview" 
              :style="{ backgroundColor: localProfile.color || '#5865f2' }"
              ref="colorPreviewRef"
              @click="toggleColorPicker"
            ></div>
            <input
              v-model="localProfile.color"
              type="text"
              class="color-input"
              :placeholder="localProfile.color || '#5865f2'"
              @input="onColorChange"
            />
            <button class="color-reset-btn" @click="resetColor">{{ $t('common.reset') }}</button>
          </div>
          
          <ColorPicker
            v-show="showColorPicker"
            v-click-outside="closeColorPicker"
            ref="colorPickerRef"
            theme="light"
            :color="`#${localProfile.color}`"
            @changeColor="onColorPickerChange"
          />
        </div>
        <div class="form-hint">
          This color will be used for your name and profile accents.
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">{{ $t('user.profile') }}</h3>
      
      <div class="info-row">
        <div class="info-label">{{ $t('auth.email') }}</div>
        <div class="info-value">{{ userEmail || 'Not provided' }}</div>
      </div>
      
      <div class="info-row">
        <div class="info-label">{{ $t('user.since') }}</div>
        <div class="info-value">{{ formatDate(profile?.created_at) }}</div>
      </div>
    </div>

    <div class="settings-actions">
      <button 
        class="btn btn-primary" 
        @click="saveChanges"
        :disabled="loading || !hasChanges"
      >
        <span v-if="loading" class="loading-spinner"></span>
        {{ $t('common.save') }}
      </button>
      <button 
        class="btn btn-secondary" 
        @click="resetChanges"
        :disabled="loading || !hasChanges"
      >
        {{ $t('common.reset') }}
      </button>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import type { User } from '@/types'
import { format } from 'date-fns'
import { getBannerUrl } from '@/utils/bannerUtils'

// Components
import { ColorPicker } from 'vue-color-kit'
import 'vue-color-kit/dist/vue-color-kit.css'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'

// Props
interface Props {
  profile: User | null
  loading: boolean
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'update-profile': [profile: Partial<User>]
  'upload-avatar': [file: File]
  'upload-banner': [file: File]
}>()

// Composables
const authStore = useAuthStore()

// State
const localProfile = ref<Partial<User>>({})
const showColorPicker = ref(false)
const bannerKey = ref(0) // For forcing banner reload

// Refs
const colorPickerRef = ref<InstanceType<typeof ColorPicker>>()
const colorPreviewRef = ref<HTMLElement | null>(null)
const bannerInput = ref<HTMLInputElement>()

// Computed
const userEmail = computed(() => authStore.session?.user?.email)

const hasChanges = computed(() => {
  if (!props.profile) return false
  
  return (
    localProfile.value.display_name !== props.profile.display_name ||
    localProfile.value.username !== props.profile.username ||
    localProfile.value.bio !== props.profile.bio ||
    localProfile.value.color !== props.profile.color
  )
})

const bannerStyle = computed(() => {
  // Include bannerKey to force reactivity when banner changes
  bannerKey.value
  const bannerUrl = getBannerUrl(props.profile?.banner_url, { width: 1280, height: 720, quality: 80 })
  if (bannerUrl) {
    return {
      backgroundImage: `url(${bannerUrl})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center'
    }
  }
  return {
    backgroundColor: props.profile?.color || '#5865f2'
  }
})

// Methods
const syncLocalProfile = () => {
  if (props.profile) {
    localProfile.value = {
      display_name: props.profile.display_name || '',
      username: props.profile.username || '',
      bio: props.profile.bio || '',
      color: props.profile.color || '#5865f2'
    }
  }
}

const onProfileChange = () => {
  // Debounce could be added here if needed
}

const onUsernameChange = () => {
  // Format username (remove special characters, convert to lowercase)
  if (localProfile.value.username) {
    localProfile.value.username = localProfile.value.username
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
  }
}

const onColorChange = () => {
  // Validate hex color
  const color = localProfile.value.color
  if (color && !color.startsWith('#')) {
    localProfile.value.color = '#' + color
  }
}

const onColorPickerChange = (colorObject: { hex: string }) => {
  localProfile.value.color = colorObject.hex
}

const toggleColorPicker = () => {
  showColorPicker.value = !showColorPicker.value
}

const closeColorPicker = () => {
  showColorPicker.value = false
}

const resetColor = () => {
  localProfile.value.color = '#5865f2'
}

const handleAvatarUpload = (file: File) => {
  emit('upload-avatar', file)
}

const triggerBannerUpload = () => {
  console.log('🖼️ Banner upload triggered')
  bannerInput.value?.click()
}

const handleBannerFileSelect = (event: Event) => {
  console.log('📁 Banner file selected')
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) {
    console.log('📤 Emitting banner upload event:', file.name, file.size)
    emit('upload-banner', file)
    // Reset the input to allow re-uploading the same file
    target.value = ''
  } else {
    console.log('❌ No file selected')
  }
}

const saveChanges = () => {
  if (hasChanges.value) {
    emit('update-profile', localProfile.value)
  }
}

const resetChanges = () => {
  syncLocalProfile()
}

const formatDate = (dateString?: string) => {
  if (!dateString) return 'Unknown'
  return format(new Date(dateString), 'MMMM d, yyyy')
}

// Click outside directive implementation
const vClickOutside = {
  beforeMount(el: HTMLElement & { __vueClickOutside__?: any }, binding: any) {
    const onClick = (event: MouseEvent) => {
      // Check if the click is outside the color picker and not on the color preview
      if (el && !el.contains(event.target as Node) &&
          (!colorPreviewRef.value || !colorPreviewRef.value.contains(event.target as Node))) {
        binding.value()
      }
    }
    el.__vueClickOutside__ = onClick
    document.addEventListener('click', onClick)
  },
  unmounted(el: HTMLElement & { __vueClickOutside__?: any }) {
    document.removeEventListener('click', el.__vueClickOutside__)
    el.__vueClickOutside__ = null
  }
}

// Watchers
watch(() => props.profile, syncLocalProfile, { immediate: true })

// Watch for banner URL changes to trigger UI refresh
watch(() => props.profile?.banner_url, (newBannerUrl, oldBannerUrl) => {
  if (newBannerUrl !== oldBannerUrl) {
    bannerKey.value++
  }
}, { immediate: false })

onMounted(() => {
  syncLocalProfile()
})
</script>

<style scoped>
.user-account-settings {
  max-width: 600px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--h-chat);
  border-radius: 8px;
  border: 1px solid var(--h-chat-light);
}

.profile-preview {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  background-color: var(--h-chat-darker);
}

.profile-banner {
  height: 120px;
  background: linear-gradient(135deg, var(--color) 0%, var(--color) 100%);
  position: relative;
  cursor: pointer;
  transition: all 0.2s ease;
}

.profile-banner:hover {
  filter: brightness(0.9);
}

.banner-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s ease;
  color: white;
  font-size: 12px;
  font-weight: 500;
}

.profile-banner:hover .banner-overlay {
  opacity: 1;
}

.profile-info {
  display: flex;
  align-items: flex-end;
  padding: 16px 20px 20px;
  margin-top: -32px;
  position: relative;
}

.avatar-wrapper {
  margin-right: 16px;
}

.user-info {
  flex: 1;
}

.display-name {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 4px 0;
}

.username {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
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

.form-textarea {
  resize: vertical;
  min-height: 80px;
}

.form-hint {
  font-size: 12px;
  color: #72767d;
  margin-top: 8px;
}

.color-picker-container {
  position: relative;
}

.color-preview-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.color-preview {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  cursor: pointer;
  border: 2px solid var(--h-chat-light);
  transition: all 0.15s ease;
}

.color-preview:hover {
  transform: scale(1.1);
}

.color-input {
  flex: 1;
  max-width: 120px;
}

.color-reset-btn {
  padding: 8px 16px;
  background-color: var(--h-chat-darker);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  color: #b9bbbe;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s ease;
}

.color-reset-btn:hover {
  background-color: var(--h-chat-light);
  color: #ffffff;
}

/* Professional Color Picker Styling */
:deep(.hu-color-picker) {
  position: absolute !important;
  top: 100% !important;
  left: 0 !important;
  z-index: 1000 !important;
  margin-top: 8px !important;
  background-color: var(--h-chat) !important;
  border: 1px solid var(--h-chat-light) !important;
  border-radius: 8px !important;
  padding: 16px !important;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4) !important;
  width: 280px !important;
}

:deep(.hu-color-picker .color-set) {
  background-color: var(--h-chat-darker) !important;
  border: 1px solid var(--h-chat-light) !important;
}

:deep(.hu-color-picker .color-show) {
  border: 1px solid var(--h-chat-light) !important;
}

:deep(.hu-color-picker .sucker) {
  background-color: var(--h-chat-darker) !important;
  border: 1px solid var(--h-chat-light) !important;
}

:deep(.hu-color-picker .color-type .name) {
  color: #ffffff !important;
}

:deep(.hu-color-picker .color-type .value) {
  background-color: var(--h-chat-darker) !important;
  border: 1px solid var(--h-chat-light) !important;
  color: #ffffff !important;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 16px 0;
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--h-chat-light);
}

.info-row:last-child {
  border-bottom: none;
}

.info-label {
  font-size: 14px;
  font-weight: 500;
  color: #b9bbbe;
}

.info-value {
  font-size: 14px;
  color: #ffffff;
}

.settings-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}

.btn {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background-color: #5865f2;
  color: #ffffff;
}

.btn-primary:hover:not(:disabled) {
  background-color: #4752c4;
}

.btn-secondary {
  background-color: transparent;
  color: #b9bbbe;
  border: 1px solid #4f545c;
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--h-chat-light);
  color: #ffffff;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid #ffffff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .settings-section {
    padding: 16px;
  }
  
  .profile-info {
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 20px;
  }
  
  .avatar-wrapper {
    margin-right: 0;
    margin-bottom: 12px;
  }
  
  .color-preview-row {
    flex-direction: column;
    align-items: stretch;
  }
  
  .color-input {
    max-width: none;
  }
}
</style>