<template>
  <div class="user-settings">
    <div class="user-settings-container">
      <!--          <UserAccountSettings 
            v-if="activeSection === 'account'"
            :profile="profile"
            :loading="loading"
            @update-profile="handleProfileUpdate"
            @upload-avatar="handleAvatarUpload"
            @upload-banner="handleBannerUpload"
          /> Navigation Header -->
      <div class="mobile-nav" v-if="isMobile">
        <button class="mobile-menu-btn" @click="toggleSidebar" aria-label="Toggle navigation">
          <div class="hamburger-icon" :class="{ active: showSidebar }">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </button>
        <h2 class="mobile-title">{{ currentSectionLabel }}</h2>
        <button class="mobile-close-btn" @click="closeSettings" aria-label="Close settings">
          <CloseIcon />
        </button>
      </div>

      <!-- Sidebar Navigation -->
      <div 
        class="settings-sidebar" 
        :class="{ 'mobile-hidden': isMobile && !showSidebar }"
        v-touch:swipe.left="handleSidebarSwipe"
      >
        <div class="settings-sidebar-content">
          <h2 class="settings-title" v-if="!isMobile">{{ $t('settings.userSettings') }}</h2>
          
          <nav class="settings-nav">
            <div class="nav-section">
              <h3 class="nav-section-title">{{ $t('settings.userSettings') }}</h3>
              <button 
                v-for="section in userSections" 
                :key="section.id"
                class="nav-item"
                :class="{ active: activeSection === section.id }"
                @click="setActiveSection(section.id)"
              >
                <component :is="section.icon" class="nav-icon" />
                {{ $t(section.label) }}
              </button>
            </div>

            <div class="nav-section">
              <h3 class="nav-section-title">{{ $t('navigation.settings') }}</h3>
              <button 
                v-for="section in appSections" 
                :key="section.id"
                class="nav-item"
                :class="{ active: activeSection === section.id }"
                @click="setActiveSection(section.id)"
              >
                <component :is="section.icon" class="nav-icon" />
                {{ $t(section.label) }}
                <span
                  v-if="section.id === 'announcements' && announcementUnreadCount > 0"
                  class="nav-badge"
                  :aria-label="`${announcementUnreadCount} unread announcement${announcementUnreadCount === 1 ? '' : 's'}`"
                >
                  {{ announcementUnreadCount > 99 ? '99+' : announcementUnreadCount }}
                </span>
              </button>
            </div>

            <div class="nav-section" v-if="adminSections.length > 0 && isAdmin">
              <h3 class="nav-section-title">Administration</h3>
              <router-link
                v-for="section in adminSections" 
                :key="section.id"
                :to="section.path"
                class="nav-item admin-link"
              >
                <component :is="section.icon" class="nav-icon" />
                {{ $t(section.label) }}
              </router-link>
            </div>

            <div class="nav-section">
              <button 
                class="nav-item logout-btn"
                @click="handleLogout"
              >
                <LogoutIcon class="nav-icon" />
                {{ $t('auth.logout') }}
              </button>
            </div>
          </nav>
        </div>
      </div>

      <!-- Sidebar Overlay (mobile) -->
      <div 
        v-if="isMobile && showSidebar" 
        class="sidebar-overlay"
        @click="closeSidebar"
      ></div>

      <!-- Main Content Area -->
      <div class="settings-main">
        <div class="settings-content">
          <!-- My Account Section -->
          <UserAccountSettings
            v-if="activeSection === 'account'"
            :profile="profile"
            :loading="loading"
            :banner-uploading="bannerUploading"
            @update-profile="handleProfileUpdate"
            @upload-avatar="handleAvatarUpload"
            @upload-banner="handleBannerUpload"
          />

          <!-- Privacy & Safety Section (includes security/encryption) -->
          <PrivacySettings 
            v-if="activeSection === 'privacy'"
            :profile="profile"
            :loading="loading"
            @update-privacy="handlePrivacyUpdate"
          />

          <!-- My Bots -->
          <UserBotsManagement
            v-else-if="activeSection === 'bots'"
            :loading="loading"
          />

          <!-- Appearance Section -->
          <AppearanceSettings 
            v-else-if="activeSection === 'appearance'"
            :profile="profile"
            :loading="loading"
            @update-appearance="handleAppearanceUpdate"
          />

          <!-- Audio Themes Section -->
          <AudioThemeSettings 
            v-else-if="activeSection === 'audio'"
            :loading="loading"
          />

          <!-- Unified Notifications Section -->
          <NotificationSettings 
            v-else-if="activeSection === 'notifications'"
            :loading="loading"
            @update-notifications="handleNotificationsUpdate"
          />

          <!-- Instance Announcements Archive -->
          <AnnouncementsSettings
            v-else-if="activeSection === 'announcements'"
            :loading="loading"
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

      <!-- Close Button (desktop only) -->
      <button 
        v-if="!isMobile"
        class="settings-close" 
        @click="closeSettings" 
        aria-label="Close settings"
      >
        <CloseIcon />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, watch, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { getProfileWithAvatarUrl, updateProfile, uploadAvatar, uploadBanner } from '@/services/ProfileService'
import { normalizeAvatarForStorage } from '@/utils/avatarUtils'
import { invalidateBannerCache } from '@/utils/bannerUtils'
import { createSettingsNavigator, type SettingsSection } from '@/utils/settingsUtils'
import { useUserData } from '@/composables/useUserData'
import { useMobileGestures } from '@/composables/useMobileGestures'
import type { User } from '@/types'
import { useToast } from 'vue-toastification'

// Components
import UserAccountSettings from '@/components/settings/user/UserAccountSettings.vue'
import PrivacySettings from '@/components/settings/user/PrivacySettings.vue'
import AppearanceSettings from '@/components/settings/user/AppearanceSettings.vue'
import AudioThemeSettings from '@/components/settings/user/AudioThemeSettings.vue'
import NotificationSettings from '@/components/settings/user/NotificationSettings.vue'
import VoiceVideoSettings from '@/components/settings/user/VoiceVideoSettings.vue'
import KeybindSettings from '@/components/settings/user/KeybindSettings.vue'
import LanguageSettings from '@/components/settings/user/LanguageSettings.vue'
import AdvancedSettings from '@/components/settings/user/AdvancedSettings.vue'
import EncryptionSettings from '@/components/encryption/EncryptionSettings.vue'
import UserBotsManagement from '@/components/settings/user/UserBotsManagement.vue'
import AnnouncementsSettings from '@/components/settings/user/AnnouncementsSettings.vue'
import { useAnnouncementUnreadCount } from '@/composables/useAnnouncementUnreadCount'

// Icons
import UserIcon from '@/components/icons/User.vue'
import ShieldIcon from '@/components/icons/Shield.vue'
import PaletteIcon from '@/components/icons/Palette.vue'
import VoiceIcon from '@/components/icons/VoiceIcon.vue'
import BellIcon from '@/components/icons/Bell.vue'
import MegaphoneIcon from '@/components/icons/Megaphone.vue'
import MicIcon from '@/components/icons/Mic.vue'
import KeyboardIcon from '@/components/icons/Keyboard.vue'
import GlobeIcon from '@/components/icons/Globe.vue'
import CogIcon from '@/components/icons/Cog.vue'
import RobotIcon from '@/components/icons/Robot.vue'
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
const { t } = useI18n()
const settingsNav = createSettingsNavigator(router)
const { updateCurrentUserProfile } = useUserData()
const { handleTouchStart, handleTouchMove, handleTouchEnd, touchState } = useMobileGestures()

// Reactive state
const loading = ref(false)
const bannerUploading = ref(false)
const profile = ref<User | null>(null)
const activeSection = ref(props.section || 'account')
const showSidebar = ref(false)
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024)

// Computed properties
const isMobile = computed(() => windowWidth.value <= 768)

const currentSectionLabel = computed(() => {
  const allSections = [...userSections.value, ...appSections.value]
  const section = allSections.find(s => s.id === activeSection.value)
  return section ? t(section.label) : t('settings.title')
})

// Navigation sections
const userSections = computed(() => [
  { id: 'account', label: 'settings.account', icon: UserIcon },
  { id: 'privacy', label: 'settings.privacy', icon: ShieldIcon },
  { id: 'bots', label: 'settings.myBots', icon: RobotIcon }
])

const appSections = computed(() => [
  { id: 'notifications', label: 'settings.notifications.title', icon: BellIcon },
  { id: 'announcements', label: 'settings.announcements.title', icon: MegaphoneIcon },
  { id: 'appearance', label: 'settings.appearance.title', icon: PaletteIcon },
  { id: 'voice', label: 'settings.voice.title', icon: MicIcon },
  { id: 'keybinds', label: 'settings.keybinds.title', icon: KeyboardIcon },
  { id: 'audio', label: 'settings.audio.title', icon: VoiceIcon },
  { id: 'language', label: 'settings.language.title', icon: GlobeIcon },
  { id: 'advanced', label: 'settings.advanced.title', icon: CogIcon },
])

// Reactive unread-announcement count for the sidebar badge. The composable
// is module-level so this stays in sync with any other consumer (e.g. the
// "View past announcements" link in the AnnouncementPopup footer) without
// extra plumbing. `autoRefresh` triggers an initial fetch on mount.
const {
  unreadCount: announcementUnreadCount,
} = useAnnouncementUnreadCount({ autoRefresh: true })

const adminSections = computed(() => {
  // Check if user has admin permissions
  if (!authStore.session?.user?.id) return []
  
  // You'll need to implement admin check logic here
  // For now, we'll show to all users - you can modify this
  return [
    { id: 'admin', label: 'Instance Admin', icon: CogIcon, isExternal: true, path: '/admin' },
  ]
})

// Valid sections
const validSections = computed(() => [
  ...userSections.value.map(s => s.id),
  ...appSections.value.map(s => s.id)
])

// Methods
const handleResize = () => {
  if (typeof window !== 'undefined') {
    windowWidth.value = window.innerWidth
    if (!isMobile.value) {
      showSidebar.value = false
    }
  }
}

const toggleSidebar = () => {
  showSidebar.value = !showSidebar.value
}

const closeSidebar = () => {
  showSidebar.value = false
}

const handleSidebarSwipe = () => {
  if (isMobile.value) {
    closeSidebar()
  }
}

// Touch gesture handlers for opening sidebar from anywhere
const onSettingsTouchStart = (event: TouchEvent) => {
  handleTouchStart(event, isMobile.value)
}

const onSettingsTouchMove = (event: TouchEvent) => {
  handleTouchMove(event, isMobile.value, showSidebar.value, {
    onSwipeRight: () => {},
    onSwipeLeft: () => {},
    onDragStart: () => {},
    onDragMove: () => {}
  })
}

const onSettingsTouchEnd = (event: TouchEvent) => {
  handleTouchEnd(event, isMobile.value, {
    onSwipeRight: () => {
      // Swipe right to open sidebar
      if (!showSidebar.value) {
        showSidebar.value = true
      }
    },
    onSwipeLeft: () => {
      // Swipe left to close sidebar
      if (showSidebar.value) {
        showSidebar.value = false
      }
    },
    onDragEnd: () => {}
  })
}

const setActiveSection = (sectionId: string) => {
  activeSection.value = sectionId
  // Close sidebar on mobile after selection
  if (isMobile.value) {
    closeSidebar()
  }
  // Update URL to reflect the active section
  settingsNav.replaceSection(sectionId as SettingsSection)
}

const closeSettings = () => {
  router.back()
}

const handleLogout = async () => {
  try {
    await authStore.logout()
    toast.success('Logged out successfully')
  } catch (error) {
    debug.error('Error logging out:', error)
    toast.error('Failed to log out')
  }
}

const handleProfileUpdate = async (updatedProfile: Partial<User>) => {
  if (!authStore.session?.user) return
  
  try {
    loading.value = true
    // Exclude username from updates - it cannot be changed until federation is fixed
    const { username, ...profileToUpdate } = updatedProfile
    await updateProfile(profileToUpdate)
    profile.value = { ...profile.value, ...profileToUpdate } as User
    
    // Broadcast profile updates to all connected clients for real-time updates
    await updateCurrentUserProfile({
      displayName: updatedProfile.display_name,
      avatarUrl: updatedProfile.avatar_url,
      color: (updatedProfile as any).color,
      bio: (updatedProfile as any).bio,
      // Note: verified field not included as it's not in UserPresence interface
    })
    
    toast.success('Profile updated successfully')
  } catch (error) {
    debug.error('Error updating profile:', error)
    toast.error('Failed to update profile')
  } finally {
    loading.value = false
  }
}

const handleAvatarUpload = async (file: File) => {
  if (!authStore.session?.user) return
  
  try {
    loading.value = true
    const result = await uploadAvatar(file, authStore.session.user.id)
    
    if (!result.success) {
      throw new Error(result.error || 'Upload failed')
    }
    
    // Ensure we normalize the avatar URL for storage
    const normalizedPath = normalizeAvatarForStorage(result.url || '')
    await updateProfile({ avatar_url: normalizedPath || undefined })
    profile.value = { ...profile.value, avatar_url: normalizedPath } as User
    
    // Broadcast avatar update to all connected clients for real-time updates
    await updateCurrentUserProfile({
      avatarUrl: normalizedPath || undefined
    })
    
    toast.success('Avatar updated successfully')
  } catch (error) {
    debug.error('Error uploading avatar:', error)
    toast.error('Failed to upload avatar')
  } finally {
    loading.value = false
  }
}

const handleBannerUpload = async (file: File) => {
  debug.log('🖼️ Banner upload started:', file.name, file.size)
  
  if (!authStore.session?.user) {
    debug.error('❌ No authenticated user for banner upload')
    return
  }
  
  try {
    bannerUploading.value = true
    debug.log('📤 Uploading banner to storage...')
    const result = await uploadBanner(file, authStore.session.user.id)
    
    if (!result.success) {
      toast.error(result.error || 'Failed to upload banner')
      return
    }
    
    debug.log('✅ Banner uploaded to:', result.url)
    
    const storagePath = result.url || ''
    
    invalidateBannerCache()
    profile.value = { ...profile.value, banner_url: storagePath } as User
    
    // Broadcast banner update (non-blocking - don't let broadcast failure undo a successful upload)
    try {
      await updateCurrentUserProfile({
        bannerUrl: storagePath || undefined
      })
    } catch (broadcastError) {
      debug.error('⚠️ Banner broadcast failed (upload still succeeded):', broadcastError)
    }
    
    toast.success('Banner updated successfully')
    debug.log('🎉 Banner upload completed successfully')
  } catch (error: any) {
    debug.error('❌ Error uploading banner:', error)
    toast.error(error?.message || 'Failed to upload banner')
  } finally {
    bannerUploading.value = false
  }
}

const isAdmin = computed(() => {
  return profile.value?.is_admin || false
})

const handlePrivacyUpdate = async (privacySettings: any) => {
  // Handle privacy settings update
  debug.log('Privacy settings updated:', privacySettings)
}

const handleAppearanceUpdate = async (appearanceSettings: any) => {
  // Handle appearance settings update
  debug.log('Appearance settings updated:', appearanceSettings)
}

const handleNotificationsUpdate = async (notificationSettings: any) => {
  // Handle notification settings update
  debug.log('Notification settings updated:', notificationSettings)
}


const handleVoiceSettingsUpdate = async (voiceSettings: any) => {
  // Handle voice settings update
  debug.log('Voice settings updated:', voiceSettings)
}

const handleKeybindsUpdate = async (keybinds: any) => {
  // Handle keybinds update
  debug.log('Keybinds updated:', keybinds)
}

const handleLanguageUpdate = async (language: string) => {
  // Handle language update
  debug.log('Language updated:', language)
}

const handleAdvancedUpdate = async (advancedSettings: any) => {
  // Handle advanced settings update
  debug.log('Advanced settings updated:', advancedSettings)
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

// Escape closes the settings view (matches mobile/desktop close-button
// behavior). Bound to keydown so it fires regardless of which child input
// currently has focus.
const handleSettingsKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return
  // If an input/textarea/contenteditable currently has focus AND it has
  // unsubmitted text, the user probably wanted to clear the field, not
  // close the entire settings view. Browsers handle that case for us in
  // <select> dropdowns; for free-text fields we still close because the
  // user can re-open the settings, but we make sure we're not stealing
  // Escape from a modal that has it open on top of us.
  const target = event.target as HTMLElement | null
  if (target?.closest('.modal-overlay')) return
  closeSettings()
}

// Lifecycle
onMounted(async () => {
  // Setup resize listener with SSR safety
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', handleResize)
    handleResize() // Set initial width
    
    // Add touch event listeners for swipe gestures
    window.addEventListener('touchstart', onSettingsTouchStart, { passive: true })
    window.addEventListener('touchmove', onSettingsTouchMove, { passive: false })
    window.addEventListener('touchend', onSettingsTouchEnd, { passive: true })

    document.addEventListener('keydown', handleSettingsKeydown)
  }

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
      profile.value = await getProfileWithAvatarUrl(authStore.session.user.id) as User
    } catch (error) {
      debug.error('Error fetching profile:', error)
      toast.error('Failed to load profile')
    } finally {
      loading.value = false
    }
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', handleResize)
    // Clean up touch event listeners
    window.removeEventListener('touchstart', onSettingsTouchStart)
    window.removeEventListener('touchmove', onSettingsTouchMove)
    window.removeEventListener('touchend', onSettingsTouchEnd)
    document.removeEventListener('keydown', handleSettingsKeydown)
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

/* Mobile Navigation */
.mobile-nav {
  display: none;
  height: 60px;
  background-color: var(--h-chat);
  border-bottom: 1px solid var(--h-chat-light);
  padding: 0 16px;
  align-items: center;
  justify-content: space-between;
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1001;
}

.mobile-menu-btn {
  background: none;
  border: none;
  padding: 8px;
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.15s ease;
}

.mobile-menu-btn:hover {
  background-color: var(--h-chat-light);
}

.hamburger-icon {
  width: 24px;
  height: 18px;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.hamburger-icon span {
  display: block;
  height: 2px;
  width: 100%;
  background-color: var(--text-secondary);
  border-radius: 1px;
  transition: all 0.3s ease;
}

.hamburger-icon.active span:nth-child(1) {
  transform: rotate(45deg) translate(6px, 6px);
}

.hamburger-icon.active span:nth-child(2) {
  opacity: 0;
}

.hamburger-icon.active span:nth-child(3) {
  transform: rotate(-45deg) translate(6px, -6px);
}

.mobile-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  text-align: center;
  flex: 1;
}

.mobile-close-btn {
  background: none;
  border: none;
  padding: 8px;
  cursor: pointer;
  border-radius: 4px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.mobile-close-btn:hover {
  background-color: var(--h-chat-light);
  color: var(--text-primary);
}

/* Sidebar */
.settings-sidebar {
  width: 260px;
  background-color: var(--h-chat);
  border-right: 1px solid var(--h-chat-light);
  display: flex;
  flex-direction: column;
  transition: transform 0.3s ease;
}

.settings-sidebar-content {
  padding: 24px 16px;
  flex: 1;
  overflow-y: auto;
}

.settings-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
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
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin: 0 0 8px 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.15s ease;
  min-height: 44px; /* Better touch target */
}

.nav-item:hover {
  background-color: var(--h-chat-light);
  color: var(--text-primary);
}

.nav-item.active {
  background-color: var(--harmony-primary);
  color: var(--text-on-primary, #ffffff);
}

.nav-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.nav-badge {
  /* Pushes itself to the right edge of the nav item without affecting
     other items (which don't render a badge). Sized small enough that it
     doesn't fight the label visually but still readable for "99+". */
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--harmony-primary, #0EA5E9);
  color: var(--text-primary, #ffffff);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}

.nav-item.active .nav-badge {
  /* Already inside a primary-colored active nav item; flip to a neutral
     pill so the badge stays visible against the accent background. */
  background: rgba(255, 255, 255, 0.22);
  color: var(--text-on-primary, #ffffff);
}

.logout-btn {
  color: #ed4245 !important;
  margin-top: 16px;
}

.logout-btn:hover {
  background-color: rgba(237, 66, 69, 0.1) !important;
  color: #ed4245 !important;
}

/* Main Content */
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

/* Close Button */
.settings-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background-color: rgba(79, 84, 92, 0.12);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  z-index: 1002;
}

.settings-close:hover {
  background-color: rgba(79, 84, 92, 0.24);
  color: var(--text-primary);
}

/* Sidebar Overlay */
.sidebar-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  z-index: 999;
}

/* Mobile Styles */
@media (max-width: 768px) {
  .user-settings {
    padding: 0;
  }
  
  .user-settings-container {
    height: 100vh;
    border-radius: 0;
    max-width: none;
  }

  .mobile-nav {
    display: flex;
  }
  
  .settings-sidebar {
    position: fixed;
    top: 60px; /* Below mobile nav */
    left: 0;
    width: 280px;
    height: calc(100vh - 60px);
    z-index: 1000;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.3);
  }

  .settings-sidebar.mobile-hidden {
    transform: translateX(-100%);
  }
  
  .settings-main {
    margin-top: 60px; /* Space for mobile nav */
  }
  
  .settings-content {
    padding: 20px 16px;
  }
  
  .settings-title {
    font-size: 18px;
  }

  /* Hide desktop close button on mobile */
  .settings-close {
    display: none;
  }

  /* Improve touch targets on mobile */
  .nav-item {
    padding: 16px 20px;
    min-height: 48px;
    font-size: 15px;
  }

  .nav-icon {
    width: 22px;
    height: 22px;
  }

  .nav-section-title {
    font-size: 13px;
    margin: 0 0 12px 12px;
  }

  .settings-nav {
    gap: 20px;
  }
}

/* Extra small screens */
@media (max-width: 480px) {
  .settings-sidebar {
    width: 100vw;
  }
  
  .settings-content {
    padding: 16px 12px;
  }

  .mobile-title {
    font-size: 16px;
  }
}

/* Transitions and animations */
@media (prefers-reduced-motion: no-preference) {
  .settings-sidebar {
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .hamburger-icon span {
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .sidebar-overlay {
    animation: fadeIn 0.3s ease;
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>