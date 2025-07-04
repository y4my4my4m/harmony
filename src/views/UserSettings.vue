<template>
  <div class="user-settings">
    <div class="user-settings-container">
      <!-- Sidebar Navigation -->
      <div class="settings-sidebar">
        <div class="settings-sidebar-content">
          <h2 class="settings-title">User Settings</h2>
          
          <nav class="settings-nav">
            <div class="nav-section">
              <h3 class="nav-section-title">User Settings</h3>
              <button 
                v-for="section in userSections" 
                :key="section.id"
                class="nav-item"
                :class="{ active: activeSection === section.id }"
                @click="setActiveSection(section.id)"
              >
                <component :is="section.icon" class="nav-icon" />
                {{ section.label }}
              </button>
            </div>

            <div class="nav-section">
              <h3 class="nav-section-title">App Settings</h3>
              <button 
                v-for="section in appSections" 
                :key="section.id"
                class="nav-item"
                :class="{ active: activeSection === section.id }"
                @click="setActiveSection(section.id)"
              >
                <component :is="section.icon" class="nav-icon" />
                {{ section.label }}
              </button>
            </div>

            <div class="nav-section">
              <button 
                class="nav-item logout-btn"
                @click="handleLogout"
              >
                <LogoutIcon class="nav-icon" />
                Log Out
              </button>
            </div>
          </nav>
        </div>
      </div>

      <!-- Main Content Area -->
      <div class="settings-main">
        <div class="settings-content">
          <!-- My Account Section -->
          <UserAccountSettings
            v-if="activeSection === 'account'"
            :profile="profile"
            :loading="loading"
            @update-profile="handleProfileUpdate"
            @upload-avatar="handleAvatarUpload"
          />

          <!-- Privacy & Safety Section -->
          <PrivacySettings 
            v-else-if="activeSection === 'privacy'"
            :profile="profile"
            :loading="loading"
            @update-privacy="handlePrivacyUpdate"
          />

          <!-- Appearance Section -->
          <AppearanceSettings 
            v-else-if="activeSection === 'appearance'"
            :profile="profile"
            :loading="loading"
            @update-appearance="handleAppearanceUpdate"
          />

          <!-- Notifications Section -->
          <NotificationSettings 
            v-else-if="activeSection === 'notifications'"
            :loading="loading"
            @update-notifications="handleNotificationsUpdate"
          />

          <!-- Voice & Video Section -->
          <VoiceVideoSettings 
            v-else-if="activeSection === 'voice'"
            :loading="loading"
            @update-voice-settings="handleVoiceSettingsUpdate"
          />

          <!-- Keybinds Section -->
          <KeybindSettings 
            v-else-if="activeSection === 'keybinds'"
            :loading="loading"
            @update-keybinds="handleKeybindsUpdate"
          />

          <!-- Language Section -->
          <LanguageSettings 
            v-else-if="activeSection === 'language'"
            :loading="loading"
            @update-language="handleLanguageUpdate"
          />

          <!-- Advanced Settings -->
          <AdvancedSettings 
            v-else-if="activeSection === 'advanced'"
            :loading="loading"
            @update-advanced="handleAdvancedUpdate"
          />
        </div>
      </div>

      <!-- Close Button -->
      <button class="settings-close" @click="closeSettings" aria-label="Close settings">
        <CloseIcon />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { getProfileWithAvatarUrl, updateProfile, uploadAvatar } from '@/services/profileService'
import { normalizeAvatarForStorage } from '@/utils/avatarUtils'
import { createSettingsNavigator, type SettingsSection } from '@/utils/settingsUtils'
import type { User } from '@/types'
import { useToast } from 'vue-toastification'

// Components
import UserAccountSettings from '@/components/settings/user/UserAccountSettings.vue'
import PrivacySettings from '@/components/settings/user/PrivacySettings.vue'
import AppearanceSettings from '@/components/settings/user/AppearanceSettings.vue'
import NotificationSettings from '@/components/settings/user/NotificationSettings.vue'
import VoiceVideoSettings from '@/components/settings/user/VoiceVideoSettings.vue'
import KeybindSettings from '@/components/settings/user/KeybindSettings.vue'
import LanguageSettings from '@/components/settings/user/LanguageSettings.vue'
import AdvancedSettings from '@/components/settings/user/AdvancedSettings.vue'

// Icons (you'll need to create or import these)
import UserIcon from '@/components/icons/User.vue'
import ShieldIcon from '@/components/icons/Shield.vue'
import PaletteIcon from '@/components/icons/Palette.vue'
import BellIcon from '@/components/icons/Bell.vue'
import MicIcon from '@/components/icons/Mic.vue'
import KeyboardIcon from '@/components/icons/Keyboard.vue'
import GlobeIcon from '@/components/icons/Globe.vue'
import CogIcon from '@/components/icons/Cog.vue'
import LogoutIcon from '@/components/icons/Logout.vue'
import CloseIcon from '@/components/icons/Close.vue'

// Props
interface Props {
  section?: string
}

const props = withDefaults(defineProps<Props>(), {
  section: 'account'
})

// Composables
const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const toast = useToast()
const settingsNav = createSettingsNavigator(router)

// State
const loading = ref(false)
const profile = ref<User | null>(null)
const activeSection = ref(props.section || 'account')

// Navigation sections
const userSections = computed(() => [
  { id: 'account', label: 'My Account', icon: UserIcon },
  { id: 'privacy', label: 'Privacy & Safety', icon: ShieldIcon },
])

const appSections = computed(() => [
  { id: 'appearance', label: 'Appearance', icon: PaletteIcon },
  { id: 'notifications', label: 'Notifications', icon: BellIcon },
  { id: 'voice', label: 'Voice & Video', icon: MicIcon },
  { id: 'keybinds', label: 'Keybinds', icon: KeyboardIcon },
  { id: 'language', label: 'Language', icon: GlobeIcon },
  { id: 'advanced', label: 'Advanced', icon: CogIcon },
])

// Valid sections
const validSections = computed(() => [
  ...userSections.value.map(s => s.id),
  ...appSections.value.map(s => s.id)
])

// Methods
const setActiveSection = (sectionId: string) => {
  activeSection.value = sectionId
  // Update URL to reflect the active section
  settingsNav.replaceSection(sectionId as SettingsSection)
}

const closeSettings = () => {
  router.push({ name: 'Chat' })
}

const handleLogout = async () => {
  try {
    await authStore.logout()
    toast.success('Logged out successfully')
  } catch (error) {
    console.error('Error logging out:', error)
    toast.error('Failed to log out')
  }
}

const handleProfileUpdate = async (updatedProfile: Partial<User>) => {
  if (!authStore.session?.user) return
  
  try {
    loading.value = true
    await updateProfile(authStore.session.user.id, updatedProfile)
    profile.value = { ...profile.value, ...updatedProfile } as User
    toast.success('Profile updated successfully')
  } catch (error) {
    console.error('Error updating profile:', error)
    toast.error('Failed to update profile')
  } finally {
    loading.value = false
  }
}

const handleAvatarUpload = async (file: File) => {
  if (!authStore.session?.user) return
  
  try {
    loading.value = true
    const filePath = await uploadAvatar(authStore.session.user.id, file)
    // Ensure we normalize the avatar URL for storage
    const normalizedPath = normalizeAvatarForStorage(filePath)
    await updateProfile(authStore.session.user.id, { avatar_url: normalizedPath })
    profile.value = { ...profile.value, avatar_url: normalizedPath } as User
    toast.success('Avatar updated successfully')
  } catch (error) {
    console.error('Error uploading avatar:', error)
    toast.error('Failed to upload avatar')
  } finally {
    loading.value = false
  }
}

const handlePrivacyUpdate = async (privacySettings: any) => {
  // Handle privacy settings update
  console.log('Privacy settings updated:', privacySettings)
}

const handleAppearanceUpdate = async (appearanceSettings: any) => {
  // Handle appearance settings update
  console.log('Appearance settings updated:', appearanceSettings)
}

const handleNotificationsUpdate = async (notificationSettings: any) => {
  // Handle notification settings update
  console.log('Notification settings updated:', notificationSettings)
}

const handleVoiceSettingsUpdate = async (voiceSettings: any) => {
  // Handle voice settings update
  console.log('Voice settings updated:', voiceSettings)
}

const handleKeybindsUpdate = async (keybinds: any) => {
  // Handle keybinds update
  console.log('Keybinds updated:', keybinds)
}

const handleLanguageUpdate = async (language: string) => {
  // Handle language update
  console.log('Language updated:', language)
}

const handleAdvancedUpdate = async (advancedSettings: any) => {
  // Handle advanced settings update
  console.log('Advanced settings updated:', advancedSettings)
}

// Watchers
watch(() => route.params.section, (newSection) => {
  const sectionStr = Array.isArray(newSection) ? newSection[0] : newSection
  if (sectionStr && validSections.value.includes(sectionStr)) {
    activeSection.value = sectionStr
  } else if (sectionStr && !validSections.value.includes(sectionStr)) {
    // Invalid section, redirect to default
    router.replace({ name: 'UserSettings', params: { section: 'account' } })
  }
}, { immediate: true })

watch(() => props.section, (newSection) => {
  if (newSection && validSections.value.includes(newSection)) {
    activeSection.value = newSection
  }
}, { immediate: true })

// Initialize
onMounted(async () => {
  // Validate and set initial section
  const routeSection = Array.isArray(route.params.section) ? route.params.section[0] : route.params.section
  const initialSection = routeSection || props.section || 'account'
  
  if (validSections.value.includes(initialSection)) {
    activeSection.value = initialSection
  } else {
    activeSection.value = 'account'
    router.replace({ name: 'UserSettings', params: { section: 'account' } })
  }

  if (authStore.session?.user) {
    try {
      loading.value = true
      profile.value = await getProfileWithAvatarUrl(authStore.session.user.id)
    } catch (error) {
      console.error('Error fetching profile:', error)
      toast.error('Failed to load profile')
    } finally {
      loading.value = false
    }
  }
})
</script>

<style scoped>
.user-settings {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  width: 100vw;
  height: 100vh;
  background-color: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 0;
  margin: 0;
}

.user-settings-container {
  width: 100vw;
  height: 100vh;
  max-width: none;
  background-color: var(--h-chat-dark);
  border-radius: 0;
  display: flex;
  position: relative;
  overflow: hidden;
  box-shadow: none;
}

.settings-sidebar {
  width: 260px;
  background-color: var(--h-chat);
  border-right: 1px solid var(--h-chat-light);
  display: flex;
  flex-direction: column;
}

.settings-sidebar-content {
  padding: 24px 16px;
  flex: 1;
  overflow-y: auto;
}

.settings-title {
  font-size: 20px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 24px 0;
  padding: 0 8px;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.nav-section {
  display: flex;
  flex-direction: column;
}

.nav-section-title {
  font-size: 12px;
  font-weight: 700;
  color: #72767d;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin: 0 0 8px 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: none;
  border: none;
  color: #b9bbbe;
  font-size: 14px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.nav-item:hover {
  background-color: var(--h-chat-light);
  color: #ffffff;
}

.nav-item.active {
  background-color: #5865f2;
  color: #ffffff;
}

.nav-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.logout-btn {
  color: #ed4245 !important;
  margin-top: 16px;
}

.logout-btn:hover {
  background-color: rgba(237, 66, 69, 0.1) !important;
  color: #ed4245 !important;
}

.settings-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}

.settings-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background-color: rgba(79, 84, 92, 0.12);
  color: #b9bbbe;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.settings-close:hover {
  background-color: rgba(79, 84, 92, 0.24);
  color: #ffffff;
}

@media (max-width: 768px) {
  .user-settings {
    padding: 0;
  }
  
  .user-settings-container {
    height: 100vh;
    border-radius: 0;
    max-width: none;
  }
  
  .settings-sidebar {
    width: 200px;
  }
  
  .settings-content {
    padding: 16px 20px;
  }
  
  .settings-title {
    font-size: 18px;
  }
}
</style>