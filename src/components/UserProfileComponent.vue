<template>
  <div class="user-profile" ref="targetRef">
    <div class="avatar-wrapper" @click.stop="handleAvatarClick">
      <Avatar 
        :src="getUserAvatarUrlCurrent"
        size="md"
        :status="currentStatusForAvatar"
      />
      <!-- Mobile-only: collapsed view hides the inline NotificationBell, so
           surface unread counts on the avatar itself. This badge is hidden
           when the profile is expanded into the overlay (where the bell is
           visible again) - see CSS below. -->
      <div
        v-if="isMobile && mobileUnreadCount > 0"
        class="mobile-avatar-badge"
        :aria-label="`${mobileUnreadCount} unread notification${mobileUnreadCount === 1 ? '' : 's'}`"
      >
        {{ mobileUnreadCount > 99 ? '99+' : mobileUnreadCount }}
      </div>
    </div>
    <div class="user-info">
      <p class="user-name"><DisplayName :userId="currentUser.id" :fallback="currentUser.displayName" :truncate="true" /></p>
      <div class="user-status-container" @click="toggleStatusDropdown">
        <div class="status-dot" :class="currentStatusDisplay.class"></div>
        <span class="status-text">{{ currentStatusDisplay.text }}</span>
        <svg class="dropdown-arrow" :class="{ rotated: showStatusDropdown }" width="12" height="8" viewBox="0 0 12 8" fill="currentColor">
          <path d="M6 6L10.5 1.5L9 0L6 3L3 0L1.5 1.5L6 6Z"/>
        </svg>
      </div>
    </div>

    <div class="buttons profile-bar-buttons">
      <div class="icon-button notification-bell-slot" data-action="bell">
        <NotificationBell />
      </div>
      <div
        class="icon-button"
        data-action="mic"
        @click="toggleMic"
        :class="{
          muted: !isMicActive,
          'voice-active': isInVoiceChannel
        }"
        :title="isMicActive ? 'Mute' : 'Unmute'"
      >
        <Icon :name="isMicActive ? 'mic' : 'mic-off'" />
      </div>
      <div
        class="icon-button"
        data-action="deafen"
        @click="toggleHeadphones"
        :class="{
          muted: !isHeadphonesActive,
          'voice-active': isInVoiceChannel
        }"
        :title="isHeadphonesActive ? 'Deafen' : 'Undeafen'"
      >
        <HeadphonesIcon :isHeadphonesActive="isHeadphonesActive" />
      </div>
      <div class="icon-button settings" data-action="settings" @click="goToSettings" title="Settings"><SettingsIcon/></div>
    </div>

    <div class="status-dropdown" v-if="showStatusDropdown">
      <!-- Custom Status: click row to open edit popup, [X] to clear only -->
      <div 
        class="custom-status-preview"
        @click.stop.prevent="openStatusPicker"
      >
        <div class="preview-left">
          <ActivityIcon
            v-if="currentCustomStatus?.type && currentCustomStatus.type !== 'custom'"
            :type="currentCustomStatus.type"
            :size="18"
            class="preview-activity-icon"
          />
          <img 
            v-if="currentCustomStatus?.emoji_url" 
            :src="getEmojiUrl(currentCustomStatus.emoji_url, 20)" 
            :alt="currentCustomStatus.emoji || 'Emoji'"
            class="preview-emoji-img"
          />
          <span v-else-if="currentCustomStatus?.emoji" class="preview-emoji">{{ currentCustomStatus.emoji }}</span>
          <svg v-else-if="!currentCustomStatus?.type || currentCustomStatus?.type === 'custom'" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" class="emoji-placeholder">
            <path d="M12 2a10 10 0 1010 10A10 10 0 0012 2zm0 18a8 8 0 118-8 8 8 0 01-8 8zm2.44-9a1.5 1.5 0 101.5-1.5 1.5 1.5 0 00-1.5 1.5zM8.5 11a1.5 1.5 0 101.5-1.5A1.5 1.5 0 008.5 11zm7.56 3.15a.76.76 0 00-1.06-.21 4.85 4.85 0 01-6 0 .76.76 0 10-.85 1.26 6.33 6.33 0 007.7 0 .76.76 0 00.21-1.05z"/>
          </svg>
          <span class="preview-text">{{ customStatusDisplayText || 'Set Custom Status' }}</span>
        </div>
        <button 
          v-if="currentCustomStatus" 
          type="button"
          class="clear-status-btn"
          @click.stop.prevent="clearCustomStatus"
          title="Clear status"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.3 5.71a1 1 0 00-1.42 0L12 10.59 7.11 5.7A1 1 0 105.7 7.11L10.59 12 5.7 16.89a1 1 0 101.41 1.41L12 13.41l4.89 4.89a1 1 0 001.41-1.41L13.41 12l4.89-4.89a1 1 0 000-1.4z"/>
          </svg>
        </button>
      </div>
      
      <div class="status-divider"></div>
      
      <!-- Status Options -->
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
    
    <!-- Status Picker Modal -->
    <StatusPicker
      :is-visible="showStatusPicker"
      :current-status="currentCustomStatus"
      @close="showStatusPicker = false"
      @status-updated="handleStatusUpdated"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, nextTick } from 'vue'
import { debug } from '@/utils/debug'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useNotificationStore } from '@/stores/useNotification'
import { useRouter } from 'vue-router'
import { UserStatus, type UserData } from '@/types'
import { useUserData } from '@/composables/useUserData'
import { useLayoutState } from '@/composables/useLayoutState'
import Icon from '@/components/common/Icon.vue'
import HeadphonesIcon from '@/components/icons/Headphones.vue'
import SettingsIcon from '@/components/icons/Settings.vue'
import Avatar from '@/components/common/Avatar.vue'
import NotificationBell from '@/components/NotificationBell.vue'
import StatusPicker from '@/components/StatusPicker.vue'
import DisplayName from '@/components/DisplayName.vue'
import ActivityIcon from '@/components/ActivityIcon.vue'
import { formatCustomStatusDisplay } from '@/utils/customStatusDisplay'
import { getEmojiUrl } from '@/utils/emojiUtils'

const voiceChannelStore = useUnifiedVoiceChannelStore()
const notificationStore = useNotificationStore()
const router = useRouter()

// Mirrors NotificationBell.unreadCount so the collapsed-mobile avatar badge
// matches the bell when it becomes visible after expansion.
const mobileUnreadCount = computed(() => notificationStore.unreadCount)
const showStatusDropdown = ref(false)
const targetRef = ref<HTMLElement | null>(null)
const { isMobile, closeMobileSidebars } = useLayoutState()

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
  setCustomStatus,
  clearCustomStatus: clearCustomStatusFn,
  getCustomStatus,
  // eslint-disable-next-line unused-imports/no-unused-vars
  getStats
} = useUserData()

// Custom status state
const customStatusText = ref('')
const currentCustomStatus = computed(() => getCustomStatus.value)
const customStatusDisplayText = computed(() => formatCustomStatusDisplay(currentCustomStatus.value))
const showStatusPicker = ref(false)

// Add a local reactive status for immediate UI updates
const localStatus = ref<UserStatus>(UserStatus.Offline)

// Initialize local status from unified system
const initializeLocalStatus = async () => {
  try {
    localStatus.value = getCurrentUserStatus.value
  } catch (error) {
    debug.error('Error initializing local status:', error)
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
    return localStatus.value
  } catch (error) {
    debug.error('Error getting current user status:', error)
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
    case UserStatus.Invisible:
      return { class: 'status-invisible', text: 'Invisible' }
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
    case UserStatus.Invisible:
      return 'invisible'
    case UserStatus.Offline:
    default:
      return 'offline'
  }
})

const statusOptions = [
  { value: UserStatus.Online, label: 'Online', class: 'status-online' },
  { value: UserStatus.Away, label: 'Away', class: 'status-away' },
  { value: UserStatus.Busy, label: 'Do Not Disturb', class: 'status-busy' },
  { value: UserStatus.Invisible, label: 'Invisible', class: 'status-invisible' }
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
    debug.error('Failed to toggle mute:', error)
  }
}

const toggleHeadphones = async () => {
  try {
    await voiceChannelStore.toggleDeafen()
  } catch (error) {
    debug.error('Failed to toggle deafen:', error)
  }
}

const toggleStatusDropdown = () => {
  showStatusDropdown.value = !showStatusDropdown.value
}

const selectStatus = async (status: UserStatus) => {
  debug.log('🔄 Attempting to change status to:', UserStatus[status])
  debug.log('🔄 Current local status before change:', UserStatus[localStatus.value])
  
  try {
    // Update local status immediately for instant UI feedback
    localStatus.value = status
    debug.log('✅ Local status updated immediately to:', UserStatus[status])
    
    // Update via unified user data system in background
    await updateCurrentUserStatus(status)
    debug.log('✅ Backend status updated successfully to:', UserStatus[status])
    
  } catch (error) {
    debug.error('❌ Failed to change status:', error)
    
    // Revert local status on error
    try {
      localStatus.value = getCurrentUserStatus.value
      debug.log('🔄 Reverted local status due to error')
    } catch (revertError) {
      debug.error('Failed to revert status:', revertError)
    }
  } finally {
    showStatusDropdown.value = false
  }
}

// Custom status functions
// eslint-disable-next-line unused-imports/no-unused-vars
const saveCustomStatus = async () => {
  if (!customStatusText.value.trim()) return
  
  try {
    await setCustomStatus({ text: customStatusText.value.trim() })
    debug.log('✅ Custom status saved:', customStatusText.value)
  } catch (error) {
    debug.error('❌ Failed to save custom status:', error)
  }
}

const clearCustomStatus = async () => {
  try {
    await clearCustomStatusFn()
    customStatusText.value = ''
    showStatusDropdown.value = false
    debug.log('✅ Custom status cleared')
  } catch (error) {
    debug.error('❌ Failed to clear custom status:', error)
  }
}

// Open modal first so the dropdown closing (or click-outside) doesn't prevent the popup from showing
const openStatusPicker = () => {
  showStatusPicker.value = true
  nextTick(() => {
    showStatusDropdown.value = false
  })
}

const handleStatusUpdated = (status: any) => {
  debug.log('✅ Status updated from picker:', status)
  showStatusPicker.value = false
}

const onClickOutside = (event: any) => {
  if (targetRef.value && !targetRef.value.contains(event.target)) {
    showStatusDropdown.value = false
  }
}

const goToSettings = () => {
  // Close mobile profile/sidebars when opening settings for better UX
  if (isMobile.value) {
    closeMobileSidebars()
  }
  router.push({ name: 'UserSettings' })
}

const handleAvatarClick = () => {
  debug.log('🔘 Avatar clicked!')
  debug.log('📱 isMobile:', isMobile.value)
  debug.log('🔧 toggleMobileProfile prop:', props.toggleMobileProfile)
  
  if (isMobile.value && props.toggleMobileProfile) {
    debug.log('✅ Calling toggleMobileProfile')
    props.toggleMobileProfile()
  } else {
    debug.log('❌ Not calling toggleMobileProfile - conditions not met')
  }
}

onMounted(async () => {
  // Initialize local status for immediate UI updates
  await initializeLocalStatus()
  
  // Component uses ONLY useUserData for real-time profile updates
  // All profile changes (avatar, display name, status, etc.) are handled reactively
  // via the unified user data system
  document.addEventListener('click', onClickOutside)
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

.status-invisible {
  background-color: #747f8d;
  /* Hollow circle to indicate invisible (like Discord) */
  border: 2px solid #747f8d;
  background: transparent !important;
}

.user-info {
  flex-grow: 1;
  margin-left: 4px;
}

.user-name {
  font-weight: bold;
  /* color: var(--text-primary); */
  color: var(--text-primary);
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
  align-items: center;
  gap: 6px;
}

/* NotificationBell matches icon-button styling when in profile bar */
.buttons :deep(.notification-bell) {
  width: 32px;
  height: 32px;
  min-width: 32px;
  min-height: 32px;
  border-radius: 6px;
  color: var(--text-secondary);
}

.buttons :deep(.notification-bell:hover) {
  background-color: rgba(79, 84, 92, 0.4);
  transform: none; /* match other icon buttons - no lift effect */
}

.icon-button {
  width: 32px;
  height: 32px;
  min-width: 32px;
  min-height: 32px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
  color: var(--text-secondary);
}

.icon-button:hover {
  background-color: rgba(79, 84, 92, 0.4);
  color: var(--text-secondary);
}

.icon-button.muted {
  background-color: #f04747;
  color: var(--text-primary);
}

.icon-button.muted:hover {
  background-color: #d73c3c;
}

.icon-button.voice-active {
  border: 1px solid rgba(14, 165, 233, 0.3);
  box-shadow: 0 0 4px rgba(14, 165, 233, 0.2);
}

.icon-button.voice-active:hover {
  border-color: rgba(14, 165, 233, 0.5);
  box-shadow: 0 0 6px rgba(14, 165, 233, 0.3);
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
  width: 220px;
  gap: 4px;
  background: #18191c;
  border-radius: 8px;
  padding: 6px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4);
  border: 1px solid #202225;
  z-index: 1000;
  animation: slideUp 0.15s ease-out;
}

/* Custom Status Preview - Discord Style */
.custom-status-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px;
  margin: 4px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  transition: background 0.15s;
}

.custom-status-preview:hover {
  background: rgba(255, 255, 255, 0.08);
}

.custom-status-preview .preview-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.custom-status-preview .preview-emoji {
  font-size: 20px;
  flex-shrink: 0;
  line-height: 1;
}

.custom-status-preview .preview-emoji-img {
  width: 20px;
  height: 20px;
  object-fit: contain;
  flex-shrink: 0;
}

.custom-status-preview .emoji-placeholder {
  color: var(--text-muted, var(--text-muted));
  flex-shrink: 0;
}

.custom-status-preview .preview-text {
  font-size: 14px;
  color: var(--text-secondary, #b9bbbe);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.clear-status-btn {
  background: none;
  border: none;
  color: var(--text-muted, var(--text-muted));
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  flex-shrink: 0;
}

.clear-status-btn:hover {
  background: rgba(237, 66, 69, 0.2);
  color: #ed4245;
}

/* Custom Status Section - Legacy (can remove if not used) */
.custom-status-section {
  padding: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
}

.custom-status-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  color: var(--text-muted);
  font-weight: 600;
  margin-bottom: 6px;
  letter-spacing: 0.02em;
}

.custom-status-input-row {
  display: flex;
  gap: 4px;
  align-items: center;
}

.custom-status-input {
  flex: 1;
  background: var(--background-tertiary);
  border: none;
  border-radius: 4px;
  padding: 8px 10px;
  font-size: 0.85rem;
  width: 100%;
  color: var(--text-secondary);
  outline: none;
}

.custom-status-input::placeholder {
  color: var(--text-muted);
}

.custom-status-input:focus {
  box-shadow: 0 0 0 2px #0EA5E9;
}

.custom-status-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  transition: background 0.15s;
}

.custom-status-btn.save {
  background: #43b581;
  color: var(--text-primary);
}

.custom-status-btn.save:hover {
  background: #3ca374;
}

.custom-status-btn.clear {
  background: #f04747;
  color: var(--text-primary);
}

.custom-status-btn.clear:hover {
  background: #d84040;
}

.current-custom-status {
  margin-top: 6px;
  font-size: 0.75rem;
  color: var(--text-muted);
  font-style: italic;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-divider {
  height: 1px;
  background: var(--background-tertiary);
  margin: 4px 0;
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
  color: var(--text-secondary);
}

.status-option:hover {
  background: #4f545c;
}

.status-option.active {
  background: var(--harmony-primary);
  color: var(--text-primary);
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
  color: var(--text-primary);
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

/* Mobile-only avatar unread badge. Anchored to the avatar; .avatar-wrapper
   only exists in mobile (collapsed) and mobile-overlay flows but the badge
   itself is gated on isMobile in the template so it never renders on
   desktop. */
.avatar-wrapper {
  position: relative;
  display: inline-flex;
}

.mobile-avatar-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: #f04747;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  box-shadow: 0 0 0 2px var(--background-secondary, #2f3136);
  pointer-events: none;
}

/* In the expanded mobile overlay the inline NotificationBell is visible, so
   hide the redundant avatar badge to avoid double-counting. */
.mobile-profile-overlay .mobile-avatar-badge {
  display: none;
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
    max-width: calc(100% - 16px);
    height: auto;
    min-height: 64px;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    padding: 10px;
    left: 6px;
    bottom: 10px;
    top: auto;
    right: auto;
    margin: 0;
  }
  /* Overlay teleports to #app — profile is not under .user-profile-section */
  .mobile-profile-overlay .user-info,
  .mobile-profile-overlay .buttons {
    display: flex;
    align-items: center;
  }
  .mobile-profile-overlay .user-info {
    flex-grow: 1;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: flex-start;
  }
  .mobile-profile-overlay .buttons {
    gap: 8px;
    flex-shrink: 0;
  }
  .mobile-profile-overlay .buttons .icon-button {
    width: 32px;
    height: 32px;
  }
  .mobile-profile-overlay .user-status-container {
    margin-right: 0;
  }
  .mobile-profile-overlay .user-name {
    font-size: 1em;
    color: var(--text-primary);
    margin: 0;
    width: 100%;
    position: relative;
    left: 0;
  }
  .mobile-profile-overlay .status-dropdown {
    position: fixed;
    width: 95vw;
    bottom: 100px;
    margin-top: 8px;
    box-shadow: none;
    border: 1px solid #202225;
    animation: none;
    left: 10px;
  }
  .mobile-profile-overlay .status-option {
    padding: 8px 12px;
    font-size: 0.875rem;
  }
  .mobile-profile-overlay .status-option .status-dot {
    width: 8px;
    height: 8px;
    margin-right: 8px;
  }
  .mobile-profile-overlay .status-option .status-text {
    font-size: 0.875rem;
    flex-grow: 1;
  }
  .mobile-profile-overlay .status-option .checkmark {
    font-size: 0.8rem;
  }
  .mobile-profile-overlay .status-text {
    font-size: 0.875rem;
    color: var(--text-secondary);
    width: auto;
    max-width: 100%;
  }
  .mobile-profile-overlay .status-dot {
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