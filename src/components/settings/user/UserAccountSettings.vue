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
            disabled
            readonly
          />
        </div>
        <div class="form-hint">
          Username cannot be changed until federation username updates are properly implemented.
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

    <!-- Support -->
    <div class="settings-section supporter-section">
      <h3 class="section-title">Support</h3>
      <p class="section-description">Supporting this instance helps keep it running and contributes to its development.<br>Supporters get a badge displayed next to their name.<br><br>Donations are currently not automated, so please be sure to include your FULL username @username@domain.</p>

      <div v-if="supporterLoading" class="supporter-loading">Loading...</div>
      <template v-else>
        <div v-if="supporterBadge" class="supporter-card">
          <span
            class="supporter-badge-preview"
            :style="supporterBadge.badge_color ? {
              backgroundColor: supporterBadge.badge_color + '20',
              borderColor: supporterBadge.badge_color,
              color: supporterBadge.badge_color
            } : {}"
          >{{ supporterBadge.badge_icon || '⭐' }}</span>
          <div class="supporter-details">
            <span class="supporter-tier">{{ supporterBadge.tier_name }} Supporter</span>
            <span class="supporter-active">Active</span>
          </div>
        </div>
        <div v-else class="supporter-card supporter-inactive">
          <span class="supporter-inactive-text">Not currently a supporter</span>
        </div>

        <div v-if="supporterDonations.length > 0" class="supporter-donations">
          <div v-for="donation in supporterDonations" :key="donation.id" class="supporter-donation-row">
            <span class="donation-amt">{{ donation.currency }} {{ donation.amount }}</span>
            <span class="donation-dt">{{ formatDate(donation.donated_at) }}</span>
            <span v-if="donation.platform" class="donation-plat">{{ donation.platform }}</span>
          </div>
        </div>

        <div v-if="fundingLinks.length > 0" class="supporter-links">
          <a
            v-for="(link, i) in fundingLinks"
            :key="i"
            :href="link.url"
            target="_blank"
            rel="noopener noreferrer"
            class="supporter-link"
          >{{ link.label || link.platform }}</a>
        </div>
      </template>
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
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import type { User } from '@/types'
import { format } from 'date-fns'
import { getBannerUrl } from '@/utils/bannerUtils'

// Components
import { ColorPicker } from 'vue-color-kit'
import 'vue-color-kit/dist/vue-color-kit.css'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import { fundingService, type SupporterBadge, type DonationRecord, type FundingLink } from '@/services/FundingService'
import { supabase } from '@/supabase'

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
    localProfile.value.bio !== props.profile.bio ||
    localProfile.value.color !== props.profile.color
  )
  // Note: username is excluded from changes - it cannot be edited until federation is fixed
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

// Username editing is disabled until federation username updates are properly implemented
// const onUsernameChange = () => {
//   // Format username (remove special characters, convert to lowercase)
//   if (localProfile.value.username) {
//     localProfile.value.username = localProfile.value.username
//       .toLowerCase()
//       .replace(/[^a-z0-9_]/g, '')
//   }
// }

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
  debug.log('🖼️ Banner upload triggered')
  bannerInput.value?.click()
}

const handleBannerFileSelect = (event: Event) => {
  debug.log('📁 Banner file selected')
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) {
    debug.log('📤 Emitting banner upload event:', file.name, file.size)
    emit('upload-banner', file)
    // Reset the input to allow re-uploading the same file
    target.value = ''
  } else {
    debug.log('❌ No file selected')
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

// Supporter section
const supporterLoading = ref(true)
const supporterBadge = ref<SupporterBadge | null>(null)
const supporterDonations = ref<DonationRecord[]>([])
const fundingLinks = ref<FundingLink[]>([])

onMounted(async () => {
  syncLocalProfile()

  try {
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
      const [config, badge, donations] = await Promise.all([
        fundingService.getFundingConfig(),
        fundingService.getSupporterBadge(user.id),
        fundingService.getDonationHistory(user.id),
      ])
      supporterBadge.value = badge
      supporterDonations.value = donations
      if (config?.enabled && config.funding_links) {
        fundingLinks.value = config.funding_links
      }
    }
  } finally {
    supporterLoading.value = false
  }
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
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
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
  color: var(--text-primary);
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
  color: var(--text-secondary);
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
  color: var(--text-secondary);
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
  color: var(--text-primary);
  font-size: 14px;
  transition: border-color 0.15s ease;
}

.form-input:focus,
.form-textarea:focus {
  outline: none;
  border-color: #5865f2;
}

.form-input:disabled,
.form-input[readonly] {
  opacity: 0.6;
  cursor: not-allowed;
  background-color: var(--h-chat-dark);
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
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s ease;
}

.color-reset-btn:hover {
  background-color: var(--h-chat-light);
  color: var(--text-primary);
}

/* Professional Color Picker Styling */
:deep(.hu-color-picker) {
  position: absolute !important;
  top: 100% !important;
  left: 0 !important;
  z-index: 1000 !important;
  margin-top: 8px !important;
  backdrop-filter: blur(8px);
  background-color: transparent!important;
  border: 1px solid var(--h-chat-light) !important;
  border-radius: 8px !important;
  padding: 16px !important;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4) !important;
  width: 280px !important;
}

:deep(.hu-color-picker .color-set) {
  background-color: var(--background-secondary-alpha) !important;
  border: 1px solid var(--border-color) !important;
}

:deep(.hu-color-picker .color-show) {
  border: 1px solid var(--border-color) !important;
}

:deep(.hu-color-picker .sucker) {
  background-color: var(--background-secondary-alpha) !important;
  border: 1px solid var(--border-color) !important;
}

:deep(.hu-color-picker .color-type .name) {
  background-color: var(--background-secondary-alpha) !important;
  border: 1px solid var(--border-color) !important;
  color: var(--text-primary) !important;
}

:deep(.hu-color-picker .color-type .value) {
  background-color: var(--background-secondary-alpha) !important;
  border: 1px solid var(--border-color) !important;
  color: var(--text-primary) !important;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
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
  color: var(--text-secondary);
}

.info-value {
  font-size: 14px;
  color: var(--text-primary);
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
  background-color: var(--harmony-primary);
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  background-color: #4752c4;
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border: 1px solid #4f545c;
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--h-chat-light);
  color: var(--text-primary);
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

/* Supporter section */
.supporter-section {
  border-top: 1px solid var(--border-color);
  padding-top: 24px;
}

.section-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: -4px 0 16px;
  line-height: 1.5;
}

.supporter-loading {
  color: var(--text-secondary);
  font-size: 13px;
}

.supporter-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--background-secondary);
  border-radius: 8px;
  margin-bottom: 12px;
}

.supporter-inactive {
  opacity: 0.6;
}

.supporter-badge-preview {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 14px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  line-height: 1;
  background: rgba(255, 255, 255, 0.05);
}

.supporter-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.supporter-tier {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}

.supporter-active {
  font-size: 12px;
  color: #57f287;
  font-weight: 600;
}

.supporter-inactive-text {
  font-size: 14px;
  color: var(--text-secondary);
}

.supporter-donations {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.supporter-donation-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  background: var(--background-secondary);
  border-radius: 6px;
  font-size: 13px;
}

.donation-amt {
  font-weight: 600;
  color: var(--text-primary);
}

.donation-dt, .donation-plat {
  color: var(--text-secondary);
}

.supporter-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.supporter-link {
  display: inline-flex;
  align-items: center;
  padding: 8px 16px;
  background: var(--harmony-primary, #5865f2);
  color: var(--text-primary);
  border-radius: 6px;
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
  transition: opacity 0.15s;
}

.supporter-link:hover {
  opacity: 0.85;
}
</style>