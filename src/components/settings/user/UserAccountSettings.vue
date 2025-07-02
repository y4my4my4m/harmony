<template>
  <div class="user-account-settings">
    <div class="settings-header">
      <h2 class="settings-title">My Account</h2>
      <p class="settings-description">
        Manage your account settings and set e-mail preferences.
      </p>
    </div>

    <div class="settings-section">
      <div class="profile-preview">
        <div class="profile-banner" :style="{ backgroundColor: profile?.color || '#5865f2' }"></div>
        <div class="profile-info">
          <div class="avatar-container">
            <img 
              :src="profile?.avatar_url || '/default_avatar.png'" 
              alt="Profile Avatar" 
              class="profile-avatar"
            />
            <button class="avatar-edit-btn" @click="triggerAvatarUpload">
              <CameraIcon />
            </button>
          </div>
          <div class="user-info">
            <h3 class="display-name" :style="{ color: profile?.color || '#ffffff' }">
              {{ profile?.display_name || 'Display Name' }}
            </h3>
            <p class="username">{{ profile?.username || 'username' }}</p>
          </div>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="form-group">
        <label class="form-label">Display Name</label>
        <input
          v-model="localProfile.display_name"
          type="text"
          class="form-input"
          placeholder="Enter your display name"
          maxlength="32"
          @input="onProfileChange"
        />
        <div class="form-hint">
          This is how others see you. You can use special characters and emoji.
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Username</label>
        <div class="username-input-container">
          <input
            v-model="localProfile.username"
            type="text"
            class="form-input"
            placeholder="Enter your username"
            maxlength="32"
            @input="onUsernameChange"
          />
        </div>
        <div class="form-hint">
          This is your unique username. Only letters, numbers, and underscores allowed.
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">About Me</label>
        <textarea
          v-model="localProfile.about"
          class="form-textarea"
          placeholder="Tell others about yourself"
          maxlength="190"
          rows="3"
          @input="onProfileChange"
        ></textarea>
        <div class="form-hint">
          {{ (localProfile.about?.length || 0) }}/190 characters
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Profile Color</label>
        <div class="color-picker-container">
          <div class="color-preview-row">
            <div 
              class="color-preview" 
              :style="{ backgroundColor: localProfile.color || '#5865f2' }"
              @click="toggleColorPicker"
            ></div>
            <input
              v-model="localProfile.color"
              type="text"
              class="color-input"
              placeholder="#5865f2"
              @input="onColorChange"
            />
            <button class="color-reset-btn" @click="resetColor">Reset</button>
          </div>
          
          <div v-if="showColorPicker" class="color-picker-popup" v-click-outside="closeColorPicker">
            <ColorPicker
              v-model:color="localProfile.color"
              @change="onColorPickerChange"
            />
          </div>
        </div>
        <div class="form-hint">
          This color will be used for your name and profile accents.
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Account Information</h3>
      
      <div class="info-row">
        <div class="info-label">Email</div>
        <div class="info-value">{{ userEmail || 'Not provided' }}</div>
      </div>
      
      <div class="info-row">
        <div class="info-label">Member Since</div>
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
        Save Changes
      </button>
      <button 
        class="btn btn-secondary" 
        @click="resetChanges"
        :disabled="loading || !hasChanges"
      >
        Reset
      </button>
    </div>

    <!-- Hidden file input for avatar upload -->
    <input
      ref="avatarInput"
      type="file"
      accept="image/*"
      style="display: none"
      @change="handleAvatarUpload"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import type { User } from '@/types'
import { format } from 'date-fns'

// Components
import ColorPicker from '@/components/common/ColorPicker.vue'
import CameraIcon from '@/components/icons/Camera.vue'

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
}>()

// Composables
const authStore = useAuthStore()

// State
const localProfile = ref<Partial<User>>({})
const showColorPicker = ref(false)
const avatarInput = ref<HTMLInputElement>()

// Computed
const userEmail = computed(() => authStore.session?.user?.email)

const hasChanges = computed(() => {
  if (!props.profile) return false
  
  return (
    localProfile.value.display_name !== props.profile.display_name ||
    localProfile.value.username !== props.profile.username ||
    localProfile.value.about !== props.profile.about ||
    localProfile.value.color !== props.profile.color
  )
})

// Methods
const syncLocalProfile = () => {
  if (props.profile) {
    localProfile.value = {
      display_name: props.profile.display_name || '',
      username: props.profile.username || '',
      about: props.profile.about || '',
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

const onColorPickerChange = (color: string) => {
  localProfile.value.color = color
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

const triggerAvatarUpload = () => {
  avatarInput.value?.click()
}

const handleAvatarUpload = (event: Event) => {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  
  if (file) {
    // Validate file size (max 8MB)
    if (file.size > 8 * 1024 * 1024) {
      alert('File size must be less than 8MB')
      return
    }
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
      alert('Please select a valid image file')
      return
    }
    
    emit('upload-avatar', file)
  }
  
  // Reset input
  target.value = ''
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

// Click outside directive
const vClickOutside = {
  beforeMount(el: HTMLElement, binding: any) {
    const onClick = (event: MouseEvent) => {
      if (el && !el.contains(event.target as Node)) {
        binding.value()
      }
    }
    el.__vueClickOutside__ = onClick
    document.addEventListener('click', onClick)
  },
  unmounted(el: HTMLElement) {
    document.removeEventListener('click', el.__vueClickOutside__)
    el.__vueClickOutside__ = null
  }
}

// Watchers
watch(() => props.profile, syncLocalProfile, { immediate: true })

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
  height: 80px;
  background: linear-gradient(135deg, var(--color) 0%, var(--color) 100%);
}

.profile-info {
  display: flex;
  align-items: flex-end;
  padding: 16px 20px 20px;
  margin-top: -32px;
  position: relative;
}

.avatar-container {
  position: relative;
  margin-right: 16px;
}

.profile-avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  border: 4px solid var(--h-chat);
  object-fit: cover;
}

.avatar-edit-btn {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background-color: #5865f2;
  color: #ffffff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.avatar-edit-btn:hover {
  background-color: #4752c4;
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

.color-picker-popup {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 1000;
  margin-top: 8px;
  background-color: var(--h-chat);
  border: 1px solid var(--h-chat-light);
  border-radius: 8px;
  padding: 16px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
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
  
  .avatar-container {
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