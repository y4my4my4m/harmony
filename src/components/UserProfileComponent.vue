<template>
  <div class="user-profile" ref="targetRef">
    <div @click.stop="handleAvatarClick">
      <Avatar 
        :src="getUserAvatarUrlCurrent"
        size="md"
        :status="currentStatusForAvatar"
      />
    </div>
    <div class="user-info">
      <p class="user-name">{{ currentUser.displayName }}</p>
      <div class="user-status-container" @click="toggleStatusDropdown">
        <div class="status-dot" :class="currentStatusDisplay.class"></div>
        <span class="status-text">{{ currentStatusDisplay.text }}</span>
        <svg class="dropdown-arrow" :class="{ rotated: showStatusDropdown }" width="12" height="8" viewBox="0 0 12 8" fill="currentColor">
          <path d="M6 6L10.5 1.5L9 0L6 3L3 0L1.5 1.5L6 6Z"/>
        </svg>
      </div>
    </div>

    <div class="buttons">
      <NotificationBell />
      <div 
        class="icon-button" 
        @click="toggleMic" 
        :class="{ 
          muted: !isMicActive,
          'voice-active': isInVoiceChannel
        }"
        :title="isMicActive ? 'Mute' : 'Unmute'"
      >
        <MicIcon v-if="isMicActive" />
        <MicMutedIcon v-else />
      </div>
      <div 
        class="icon-button" 
        @click="toggleHeadphones" 
        :class="{ 
          muted: !isHeadphonesActive,
          'voice-active': isInVoiceChannel
        }"
        :title="isHeadphonesActive ? 'Deafen' : 'Undeafen'"
      >
        <HeadphonesIcon :isHeadphonesActive="isHeadphonesActive" />
      </div>
      <div class="icon-button settings" @click="goToSettings" title="Settings"><SettingsIcon/></div>
    </div>

    <div class="status-dropdown" v-if="showStatusDropdown">
      <div 
        v-for="status in statusOptions" 
        :key="status.value"
        class="status-option"
        :class="{ active: currentStatus === status.value }"
        @click="selectStatus(status.value)"
      >
        <div class="status-dot" :class="status.class"></div>
        <span class="status-text">{{ status.label }}</span>
        <span v-if="currentStatus === status.value" class="checkmark">✓</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed } from 'vue'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useThemeStore } from '@/stores/useTheme'
import { useRouter } from 'vue-router'
import { UserStatus, type UserData } from '@/types'
import { useUserData } from '@/composables/useUserData'
import { useLayoutState } from '@/composables/useLayoutState'
import MicIcon from '@/components/icons/Mic.vue'
import MicMutedIcon from '@/components/icons/MicMuted.vue'
import HeadphonesIcon from '@/components/icons/Headphones.vue'
import SettingsIcon from '@/components/icons/Settings.vue'
import Avatar from '@/components/common/Avatar.vue'
import NotificationBell from '@/components/NotificationBell.vue'

const voiceChannelStore = useUnifiedVoiceChannelStore()
const themeStore = useThemeStore()
const router = useRouter()
const showStatusDropdown = ref(false)
const targetRef = ref<HTMLElement | null>(null)
const { isMobile } = useLayoutState()

// add the optional prop toggle-mobile-profile
const props = defineProps<{
  toggleMobileProfile?: () => void
}>()

// Use new clean user data system - ONE source of truth with full reactivity
const { 
  getCurrentUser,
  getCurrentUserStatus,
  getUserAvatarUrlCurrent,
  updateCurrentUserStatus,
  getStats
} = useUserData()

// Add a local reactive status for immediate UI updates
const localStatus = ref<UserStatus>(UserStatus.Offline)

// Initialize local status from unified system
const initializeLocalStatus = async () => {
  try {
    localStatus.value = getCurrentUserStatus.value
    console.log('🎬 UserProfileComponent - initialized local status:', UserStatus[localStatus.value])
  } catch (error) {
    console.error('Error initializing local status:', error)
    localStatus.value = UserStatus.Offline
  }
}

// Reactive current user from unified system - this will update in real-time
const currentUser = computed(() => {
  const user = getCurrentUser.value
  if (!user || !user.id) {
    return { id: '', displayName: 'Loading...', status: UserStatus.Offline } as UserData
  }
  return user
})
// Get current status reactively - use local status for immediate updates
const currentStatus = computed(() => {
  try {
    // Use local status for immediate UI responsiveness
    const status = localStatus.value
    console.log('UserProfileComponent - Current status from local state:', UserStatus[status])
    return status
    
  } catch (error) {
    console.error('Error getting current user status:', error)
    return UserStatus.Offline
  }
})

// Helper to get status display
const currentStatusDisplay = computed(() => {
  const status = currentStatus.value
  switch (status) {
    case UserStatus.Online:
      return { class: 'status-online', text: 'Online' }
    case UserStatus.Away:
      return { class: 'status-away', text: 'Away' }
    case UserStatus.Busy:
      return { class: 'status-busy', text: 'Do Not Disturb' }
    case UserStatus.Offline:
    default:
      return { class: 'status-offline', text: 'Offline' }
  }
})

// Status for avatar display (current user's actual status)
const currentStatusForAvatar = computed(() => {
  const status = currentStatus.value
  switch (status) {
    case UserStatus.Online:
      return 'online'
    case UserStatus.Away:
      return 'away'
    case UserStatus.Busy:
      return 'busy'
    case UserStatus.Offline:
    default:
      return 'offline'
  }
})

const statusOptions = [
  { value: UserStatus.Online, label: 'Online', class: 'status-online' },
  { value: UserStatus.Away, label: 'Away', class: 'status-away' },
  { value: UserStatus.Busy, label: 'Do Not Disturb', class: 'status-busy' },
  { value: UserStatus.Offline, label: 'Invisible', class: 'status-offline' }
]

// Use unified voice system only
const isMicActive = computed(() => {
  return !voiceChannelStore.localState.isMuted
})

const isHeadphonesActive = computed(() => {
  return !voiceChannelStore.localState.isDeafened
})

const isInVoiceChannel = computed(() => {
  return voiceChannelStore.isConnected
})

const toggleMic = async () => {
  try {
    await voiceChannelStore.toggleMute()
  } catch (error) {
    console.error('Failed to toggle mute:', error)
  }
}

const toggleHeadphones = async () => {
  try {
    const wasDeafened = voiceChannelStore.localState.isDeafened
    await voiceChannelStore.toggleDeafen()
    
    // Play appropriate sound effect using theme system
    if (wasDeafened) {
      themeStore.testAudio('ui_success') // Undeafened - positive sound
    } else {
      themeStore.testAudio('ui_click') // Deafened - neutral sound
    }
  } catch (error) {
    console.error('Failed to toggle deafen:', error)
  }
}

const toggleStatusDropdown = () => {
  showStatusDropdown.value = !showStatusDropdown.value
}

const selectStatus = async (status: UserStatus) => {
  console.log('🔄 Attempting to change status to:', UserStatus[status])
  console.log('🔄 Current local status before change:', UserStatus[localStatus.value])
  
  try {
    // Update local status immediately for instant UI feedback
    localStatus.value = status
    console.log('✅ Local status updated immediately to:', UserStatus[status])
    
    // Update via unified user data system in background
    await updateCurrentUserStatus(status)
    console.log('✅ Backend status updated successfully to:', UserStatus[status])
    
  } catch (error) {
    console.error('❌ Failed to change status:', error)
    
    // Revert local status on error
    try {
      localStatus.value = getCurrentUserStatus.value
      console.log('🔄 Reverted local status due to error')
    } catch (revertError) {
      console.error('Failed to revert status:', revertError)
    }
  } finally {
    showStatusDropdown.value = false
  }
}

const onClickOutside = (event: any) => {
  if (targetRef.value && !targetRef.value.contains(event.target)) {
    showStatusDropdown.value = false
  }
}

const goToSettings = () => {
  router.push({ name: 'UserSettings' })
}

const handleAvatarClick = () => {
  console.log('🔘 Avatar clicked!')
  console.log('📱 isMobile:', isMobile.value)
  console.log('🔧 toggleMobileProfile prop:', props.toggleMobileProfile)
  
  if (isMobile.value && props.toggleMobileProfile) {
    console.log('✅ Calling toggleMobileProfile')
    props.toggleMobileProfile()
  } else {
    console.log('❌ Not calling toggleMobileProfile - conditions not met')
  }
}

onMounted(async () => {
  // Initialize local status for immediate UI updates
  await initializeLocalStatus()
  
  // 🎯 Component now uses ONLY useUserData for real-time profile updates
  // All profile changes (avatar, display name, status, etc.) are handled reactively
  // via the unified user data system - no auth store dependency needed!
  document.addEventListener('click', onClickOutside)
  
  // Debug: Log unified system stats
  const stats = getStats.value
  console.log('🔍 UserData service stats from UserProfileComponent:', stats)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onClickOutside)
})
</script>

<style scoped>
.user-profile {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 345px;
  background: var(--background-quinary);

  backdrop-filter: blur(10px);
  padding: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  height: 72px;
  border-radius: 12px;
}

.avatar-container {
  position: relative;
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
}

.status-indicator {
  width: 10px;
  height: 10px;
  position: absolute;
  bottom: 0;
  right: 0;
  border: 2px solid var(--background-quinary);
  border-radius: 50%;
}

.status-online {
  background-color: #43b581;
}

.status-away {
  background-color: #faa81a;
}

.status-busy {
  background-color: #f04747;
}

.status-offline {
  background-color: #747f8d;
}

.user-info {
  flex-grow: 1;
  margin-left: 4px;
}

.user-name {
  font-weight: bold;
  color: white;
  margin: 0 0 0 6px;
  font-size: 0.9em;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-status-container {
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 0.8em;
  color: #b3b3b3;
  padding: 4px 6px;
  border-radius: 3px;
  transition: background 0.2s;
  margin-right: 10px;
}

.user-status-container:hover {
  background: rgba(255, 255, 255, 0.1);
}

.buttons {
  display: flex;
  gap: 4px;
}

.icon-button {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
  color: #b9bbbe;
}

.icon-button:hover {
  background-color: rgba(79, 84, 92, 0.4);
  color: #dcddde;
}

.icon-button.muted {
  background-color: #f04747;
  color: #ffffff;
}

.icon-button.muted:hover {
  background-color: #d73c3c;
}

.icon-button.voice-active {
  border: 1px solid rgba(88, 101, 242, 0.3);
  box-shadow: 0 0 4px rgba(88, 101, 242, 0.2);
}

.icon-button.voice-active:hover {
  border-color: rgba(88, 101, 242, 0.5);
  box-shadow: 0 0 6px rgba(88, 101, 242, 0.3);
}

.icon-button.settings:hover {
  background-color: rgba(79, 84, 92, 0.6);
}

.status-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  display: flex;
  flex-direction: column;
  left: 0px;
  width: 165px;
  gap: 4px;
  background: #18191c;
  border-radius: 8px;
  padding: 6px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4);
  border: 1px solid #202225;
  z-index: 1000;
  animation: slideUp 0.15s ease-out;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.status-option {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.2s;
  font-size: 0.875rem;
  color: #dcddde;
}

.status-option:hover {
  background: #4f545c;
}

.status-option.active {
  background: #5865f2;
  color: white;
}

.status-option .status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 10px;
  flex-shrink: 0;
}

.status-text {
  flex-grow: 1;
  font-weight: 500;
  width: 78px;
}

.checkmark {
  margin-left: auto;
  color: white;
  font-weight: bold;
  font-size: 0.9rem;
}

.dropdown-arrow {
  margin-left: 4px;
  transition: transform 0.2s;
  opacity: 0.7;
}

.dropdown-arrow.rotated {
  transform: rotate(180deg);
}

@media screen and (max-width: 768px) {

  .user-profile-section .user-info,
  .user-profile-section .buttons {
    display: none;
  }

  .user-profile {
    padding: 0;
    width: 64px;
    height: 64px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .mobile-profile-overlay .user-profile {
    position: fixed;
    width: calc(100% - 16px);
    height: 64px;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    padding: 10px;
    left: 6px;
    bottom: 10px;
  }
  .mobile-profile-overlay .user-profile-section .user-info,
  .mobile-profile-overlay .user-profile-section .buttons {
    display: flex;
    align-items: center;
  }
  .mobile-profile-overlay .user-profile-section .user-info {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
  }
  .mobile-profile-overlay .user-profile-section .buttons {
    gap: 8px;
  }
  .mobile-profile-overlay .user-profile-section .buttons .icon-button {
    width: 32px;
    height: 32px;
  }
  .mobile-profile-overlay .user-profile-section .user-status-container {
    margin-right: 0;
  }
  .mobile-profile-overlay .user-profile-section .user-name {
    font-size: 1em;
    color: white;
    margin: 0;
    width: 100%;
    position: relative;
    left: -12px;
  }
  .mobile-profile-overlay .user-profile-section .status-dropdown {
    position: fixed;
    width: 95vw;
    bottom: 100px;
    margin-top: 8px;
    box-shadow: none;
    border: 1px solid #202225;
    animation: none;
    left: 10px;
  }
  .mobile-profile-overlay .user-profile-section .status-option {
    padding: 8px 12px;
    font-size: 0.875rem;
  }
  .mobile-profile-overlay .user-profile-section .status-option .status-dot {
    width: 8px;
    height: 8px;
    margin-right: 8px;
  }
  .mobile-profile-overlay .user-profile-section .status-option .status-text {
    font-size: 0.875rem;
    flex-grow: 1;
  }
  .mobile-profile-overlay .user-profile-section .status-option .checkmark {
    font-size: 0.8rem;
  }
  .mobile-profile-overlay .user-profile-section .status-text {
    font-size: 0.875rem;
    color: #dcddde;
    width: 92px;
  }
  .mobile-profile-overlay .user-profile-section .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
  }
  .user-name {
    font-size: 0.8em;
  }
  
  .icon-button {
    width: 28px;
    height: 28px;
  }
}
</style>