<template>
  <div class="dm-header">
    <div class="header-left">
      <button 
        v-if="isMobile"
        class="mobile-menu-btn"
        @click="$emit('toggle-left-sidebar')"
      >
        <svg viewBox="0 0 24 24" class="menu-icon">
          <path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z" fill="currentColor"/>
        </svg>
      </button>
      
      <div class="conversation-info">
        <!-- Group Chat Avatar -->
        <GroupIcon
          v-if="conversation.type === 'group'"
          :conversation-id="conversation.id"
          :icon-path="conversation.icon_url"
          size="sm"
          style="width:32px;height:32px;"
        />

        <!-- Direct Chat Avatar -->
        <div v-else class="conversation-avatar">
          <Avatar
            :src="getAvatarUrl(conversation.other_user?.avatar_url)"
            :alt="getUserDisplayName(conversation.other_user?.id || '').value || conversation.other_user?.display_name || conversation.other_user?.username || 'User'"
            size="sm"
            style="width:32px;height:32px;"
            :status="otherUserStatus"
          />
          <!-- Federated user indicator -->
          <div 
            v-if="isFederatedUser" 
            class="federated-indicator"
            :title="`Federated user from ${conversation.other_user?.domain}`"
          >
            <Icon name="globe" />
          </div>
        </div>

        <div class="conversation-details">
          <!-- Group Chat Title -->
          <template v-if="conversation.type === 'group'">
            <h2 class="conversation-name group-name">
              {{ conversation.name || getDefaultGroupName() }}
            </h2>
            <div class="conversation-status">
              <span v-if="activeCallParticipantCount > 0" class="call-status">
                <Icon name="phone" :size="12" class="call-icon" />
                {{ activeCallParticipantCount }} in call
              </span>
              <span v-else class="participant-count">
                <Icon name="users" :size="12" class="members-icon" />
                {{ conversation.participant_count || 0 }} member{{ (conversation.participant_count || 0) !== 1 ? 's' : '' }}
              </span>
            </div>
          </template>

          <!-- Direct Chat Title -->
          <template v-else>
            <h2 class="conversation-name">
              <DisplayName v-if="conversation.other_user?.id" :user-id="conversation.other_user.id" :fallback="conversation.other_user?.display_name || conversation.other_user?.username || 'Loading...'" />
              <template v-else>{{ conversation.other_user?.display_name || conversation.other_user?.username || 'Loading...' }}</template>
            </h2>
            <div class="conversation-status">
              <span v-if="hasActiveCallNotJoined" class="call-status">
                <Icon name="phone" :size="12" class="call-icon" />
                Call in progress
              </span>
              <!-- Show federated handle for remote users -->
              <span v-else-if="isFederatedUser" class="federated-handle" :style="{ color: conversation.other_user?.color || '#0EA5E9' }">
                {{ conversation.other_user?.handle || `@${conversation.other_user?.username}@${conversation.other_user?.domain}` }}
              </span>
              <span v-else-if="otherUserStatus !== 'offline'" class="status">
                {{ getStatusText(otherUserStatus) }}
              </span>
              <span v-else class="status">
                Last seen {{ formatLastSeen(conversation.other_user?.last_seen) }}
              </span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div class="header-actions">
      <!-- Add User Button (for group chat invitation) -->
      <button 
        class="action-btn add-user-btn"
        @click="$emit('add-user')"
        title="Add people to conversation"
      >
        <svg viewBox="0 0 24 24" class="add-user-icon" style="width:24px; height:24px;">
          <path d="M15,14C12.33,14 7,15.33 7,18V20H23V18C23,15.33 17.67,14 15,14M6,10V7H4V10H1V12H4V15H6V12H9V10M15,12A4,4 0 0,0 19,8A4,4 0 0,0 15,4A4,4 0 0,0 11,8A4,4 0 0,0 15,12Z" fill="currentColor"/>
        </svg>
      </button>
      
      <!-- Join Call Button (when a call is active but user is not in it) -->
      <button
        v-if="hasActiveCallNotJoined"
        class="action-btn join-call-btn"
        @click="joinActiveCall"
        title="Join call"
      >
        <Icon name="phone" :size="16" />
        <span class="join-text">Join Call</span>
      </button>
      
      <!-- Voice Call Button -->
      <button 
        v-else
        class="action-btn voice-btn"
        :class="{ active: isInVoiceCall }"
        @click="toggleVoiceCall"
        :title="isInVoiceCall ? 'End voice call' : 'Start voice call'"
      >
        <Icon :name="isInVoiceCall ? 'phone-off' : 'phone'" :size="16" />
      </button>
      
      <!-- Video Call Button -->
      <button 
        class="action-btn video-btn"
        :class="{ active: isInVideoCall }"
        @click="toggleVideoCall"
        :title="isInVideoCall ? 'Turn off camera' : 'Start video call'"
      >
        <Icon :name="isInVideoCall ? 'video-off' : 'video'" :size="16" />
      </button>
      
      <button 
        class="action-btn search-btn"
        @click="handleSearchClick"
        title="Search in conversation"
      >
        <svg viewBox="0 0 24 24" class="search-icon">
          <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
        </svg>
      </button>
      
      <div class="more-options-container">
        <button 
          class="action-btn more-btn"
          @click="handleMoreClick"
          title="More options"
          :class="{ active: showOptionsMenu }"
        >
          <svg viewBox="0 0 24 24" class="more-icon">
            <path d="M12,16A2,2 0 0,1 14,18A2,2 0 0,1 12,20A2,2 0 0,1 10,18A2,2 0 0,1 12,16M12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12A2,2 0 0,1 12,10M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8A2,2 0 0,1 10,6A2,2 0 0,1 12,4Z" fill="currentColor"/>
          </svg>
        </button>

        <!-- Options Menu -->
        <div v-if="showOptionsMenu" class="actions-menu" v-click-outside="closeActionsMenu" ref="optionsMenuRef">
          <!-- Group Settings (only for group chats) -->
          <button 
            v-if="conversation.type === 'group'"
            class="action-item"
            @click="openGroupSettings"
          >
            <Icon name="settings" :size="16" />
            <span>Group Settings</span>
          </button>
          
          <!-- Search in Conversation -->
          <button class="action-item" @click="handleSearchClick">
            <Icon name="search" :size="16" />
            <span>Search Messages</span>
          </button>
          
          <!-- Mute/Unmute Conversation -->
          <button class="action-item" @click="handleNotificationSettings">
            <Icon :name="isConversationMuted ? 'bell-off' : 'bell'" :size="16" />
            <span>{{ isConversationMuted ? 'Unmute Conversation' : 'Mute Conversation' }}</span>
          </button>
          
          <!-- Encryption Toggle -->
          <button 
            class="action-item"
            :class="{ 'action-item-disabled': !canToggleEncryption }"
            @click="toggleEncryption"
            :disabled="encryptionLoading"
            :title="encryptionToggleTitle"
          >
            <Icon :name="encryptionEnabled ? 'lock' : 'unlock'" :size="16" />
            <span>{{ encryptionEnabled ? 'Disable Encryption' : 'Enable Encryption' }}</span>
            <span v-if="encryptionLoading" class="loading-indicator">...</span>
          </button>
          
          <div class="menu-separator"></div>
          
          <!-- Leave Group (only for group chats) -->
          <button 
            v-if="conversation.type === 'group'"
            class="action-item danger"
            @click="handleLeaveGroup"
          >
            <Icon name="log-out" :size="16" />
            <span>Leave Group</span>
          </button>
          
          <!-- Close DM (for direct messages) -->
          <button 
            v-else
            class="action-item danger"
            @click="handleCloseDM"
          >
            <Icon name="x" :size="16" />
            <span>Close DM</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Group Settings Modal -->
  <GroupSettingsModal
    :show="showGroupSettings"
    :conversation="conversation"
    :conversation-id="conversation.id"
    :participants="conversation.participants || []"
    @close="showGroupSettings = false"
    @updated="handleGroupUpdated"
  />

  <!-- Message Search Modal -->
  <MessageSearchModal
    :show="showSearchModal"
    :initial-conversation-id="conversation.id"
    @close="showSearchModal = false"
    @message-click="handleSearchMessageClick"
  />

  <!-- Encryption Setup Required Modal -->
  <Teleport to="body">
    <div v-if="showEncryptionSetupModal" class="modal-overlay" @click.self="showEncryptionSetupModal = false">
      <div class="modal-content encryption-setup-modal">
        <div class="modal-header">
          <h3>🔐 Encryption Setup Required</h3>
          <button class="close-btn" @click="showEncryptionSetupModal = false">
            <Icon name="x" :size="20" />
          </button>
        </div>
        <div class="modal-body">
          <p>To enable encrypted DMs, you need to set up end-to-end encryption first.</p>
          <div class="setup-steps">
            <div class="step">
              <span class="step-number">1</span>
              <span class="step-text">Go to <strong>Settings → Privacy & Security → Encryption</strong></span>
            </div>
            <div class="step">
              <span class="step-number">2</span>
              <span class="step-text">Create your recovery key (12-word phrase)</span>
            </div>
            <div class="step">
              <span class="step-number">3</span>
              <span class="step-text">Come back here and enable encryption for this conversation</span>
            </div>
          </div>
          <p class="note">
            <Icon name="info" :size="14" />
            Your recovery key is the only way to decrypt your messages. Keep it safe!
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showEncryptionSetupModal = false">
            Cancel
          </button>
          <button class="btn btn-primary" @click="goToEncryptionSettings">
            Go to Settings
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import GroupIcon from '@/components/common/GroupIcon.vue'
import GroupSettingsModal from '@/components/dm/GroupSettingsModal.vue'
import MessageSearchModal from '@/components/search/MessageSearchModal.vue'
import { useUserData } from '@/composables/useUserData'
import { useDMStore, type DMConversation } from '@/stores/useDM'
import { getAvatarUrl } from '@/utils/avatarUtils'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useAuthStore } from '@/stores/auth'
import { useToast } from 'vue-toastification'
import { dmCallSignaling, type CallSignal } from '@/services/DMCallSignaling'
import { dmCallPermissions } from '@/services/DMCallPermissions'
import { authContextService } from '@/services/AuthContextService'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

const router = useRouter()
const toast = useToast()
const voiceStore = useUnifiedVoiceChannelStore()
const authStore = useAuthStore()

// Caller ringing state
let callerRingtoneInterval: ReturnType<typeof setInterval> | null = null
const stopCallerRinging = () => {
  if (callerRingtoneInterval) {
    clearInterval(callerRingtoneInterval)
    callerRingtoneInterval = null
  }
}
const startCallerRinging = async () => {
  stopCallerRinging()
  const { useThemeStore } = await import('@/stores/useTheme')
  const themeStore = useThemeStore()
  themeStore.playAudio('call_outgoing')
  callerRingtoneInterval = setInterval(() => {
    themeStore.playAudio('call_outgoing')
  }, 3000)
}

// Active call tracking
const activeCallParticipantCount = ref(0)

// Props
interface Props {
  conversation: DMConversation
  isMobile?: boolean
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'toggle-left-sidebar': []
  'toggle-voice-panel': []
  'group-updated': []
  'add-user': []
  'incoming-call': [payload: { callerId: string, callType: 'voice' | 'video', conversationId: string }]
}>()

// Voice/Video Call State - synced with voice store
const isInVoiceCall = computed(() => voiceStore.isConnected && (voiceStore.currentChannelId?.startsWith('dm-') || voiceStore.currentChannelId?.startsWith('federated-dm-')))
const isInVideoCall = computed(() => voiceStore.localState.isVideoEnabled)

// Active call state for any DM (1:1 or group)
// Reading callStateVersion establishes a reactive dependency so Vue re-evaluates on changes
const hasActiveCallNotJoined = computed(() => {
  dmCallSignaling.callStateVersion.value
  const hasActiveCall = dmCallSignaling.hasActiveCall(props.conversation.id)
  const isUserInCall = isInVoiceCall.value
  
  return hasActiveCall && !isUserInCall
})

// Use clean status system
const { 
  getUserDisplayName,
  subscribeToProfilePresence,
  unsubscribeFromProfilePresence,
  getPresenceAwareStatus
} = useUserData()

// State
const showSearchModal = ref(false)
const showOptionsMenu = ref(false)
const presenceInitialized = ref(false)
const showEncryptionSetupModal = ref(false)
const optionsMenuRef = ref<HTMLElement>()

// Group chat state
const showGroupSettings = ref(false)

// Encryption state
const encryptionEnabled = ref(false)
const encryptionLoading = ref(false)
const userHasEncryption = ref(false)

// Conversation mute state
const isConversationMuted = ref(false)

// Check if user can toggle encryption (needs to have encryption set up)
const canToggleEncryption = computed(() => userHasEncryption.value && !encryptionLoading.value)
const encryptionToggleTitle = computed(() => {
  if (!userHasEncryption.value) return 'Set up encryption in settings first'
  return encryptionEnabled.value ? 'Click to disable encryption' : 'Click to enable encryption'
})

// Load encryption status
async function loadEncryptionStatus() {
  // Reset immediately so stale state from previous conversation isn't visible
  encryptionEnabled.value = false
  encryptionLoading.value = true
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    userHasEncryption.value = megolmMessageEncryptionService.isUnlocked()
    debug.log('🔐 User has encryption:', userHasEncryption.value)
    
    const { data } = await supabase
      .from('conversation_encryption_settings')
      .select('encryption_enabled')
      .eq('conversation_id', props.conversation.id)
      .maybeSingle()
    
    encryptionEnabled.value = data?.encryption_enabled === true
    debug.log('🔐 Conversation encryption enabled:', encryptionEnabled.value)
  } catch (error) {
    debug.warn('Failed to load encryption status:', error)
    encryptionEnabled.value = false
  } finally {
    encryptionLoading.value = false
  }
}

// Toggle encryption for this conversation
async function toggleEncryption() {
  debug.log('🔐 Toggle encryption clicked')
  debug.log('🔐 canToggleEncryption:', canToggleEncryption.value)
  debug.log('🔐 userHasEncryption:', userHasEncryption.value)
  
  if (!canToggleEncryption.value) {
    debug.log('🔐 Cannot toggle - user does not have encryption set up')
    closeActionsMenu()
    showEncryptionSetupModal.value = true
    return
  }
  
  const newState = !encryptionEnabled.value

  // Warn about federated users when enabling encryption
  if (newState && isFederatedUser.value) {
    const confirmed = confirm(
      'The other user is on a federated server that may not support Harmony\'s end-to-end encryption. ' +
      'Encrypted messages may not be readable by them.\n\n' +
      'Do you still want to enable encryption?'
    )
    if (!confirmed) {
      closeActionsMenu()
      return
    }
  }

  encryptionLoading.value = true
  try {
    debug.log('🔐 Setting encryption to:', newState)
    
    // Upsert the setting
    const { error } = await supabase
      .from('conversation_encryption_settings')
      .upsert({
        conversation_id: props.conversation.id,
        encryption_enabled: newState,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'conversation_id'
      })
    
    if (error) {
      debug.error('🔐 Supabase error:', error)
      throw error
    }
    
    encryptionEnabled.value = newState

    // Notify ChatComponent to refresh its encryption indicator
    window.dispatchEvent(new CustomEvent('dm-encryption-toggled', {
      detail: { conversationId: props.conversation.id, enabled: newState }
    }))

    toast.success(newState ? 'Encryption enabled for this conversation' : 'Encryption disabled for this conversation')
    closeActionsMenu()
  } catch (error) {
    debug.error('Failed to toggle encryption:', error)
    toast.error('Failed to update encryption setting')
  } finally {
    encryptionLoading.value = false
  }
}

// Methods
function handleGroupUpdated() {
  emit('group-updated')
}

// Professional presence management for DM header
// Always ensure the conversation partner is tracked for presence
let profileContextId: string | null = null

const initializePresenceTracking = async () => {
  if (props.conversation.other_user?.id && !profileContextId) {
    try {
      const userId = props.conversation.other_user.id
      
      // Always subscribe to profile presence to ensure real-time updates
      // The userDataService will handle deduplication if user is already tracked globally
      profileContextId = await subscribeToProfilePresence(userId)
      presenceInitialized.value = true
      debug.log(`🗨️ DMHeader: Tracking presence for user ${userId}`)
    } catch (error) {
      debug.error('Failed to subscribe to profile presence:', error)
    }
  }
}

/**
 * Stop tracking presence for a previously-subscribed user.
 *
 * BUGS.md H30: this used to default to `props.conversation.other_user?.id`,
 * but on conversation switch the watcher fires AFTER props are already
 * updated - so cleanup would call `unsubscribeFromProfilePresence(newUserId)`
 * (a noop) and leak the old user's subscription. Callers in `watch()` paths
 * must pass `oldUserId` explicitly; the unmount path uses the current id.
 */
const cleanupPresenceTracking = async (userId?: string | null) => {
  const targetUserId = userId ?? props.conversation.other_user?.id
  if (targetUserId && profileContextId) {
    try {
      await unsubscribeFromProfilePresence(targetUserId)
      profileContextId = null
      presenceInitialized.value = false
      debug.log(`🗨️ DMHeader: Stopped tracking presence for user ${targetUserId}`)
    } catch (error) {
      debug.error('Failed to unsubscribe from profile presence:', error)
    }
  }
}

// Call signal subscription
let callSignalUnsubscribe: (() => void) | null = null

const handleCallSignal = async (signal: CallSignal) => {
  if (!authStore.session?.user?.id) return

  // BUGS.md Pattern A: signal participant IDs and permission lookups all
  // key on PROFILE ids (the rest of the call codebase resolves via
  // `authContextService.getCurrentProfileId()`). Using the auth UUID here
  // meant:
  //   - `signal.callerId === currentUserId` never matched our own outgoing
  //     signals, so self-suppression was broken,
  //   - `canReceiveCall(callerId, currentUserId, ...)` queried the wrong
  //     row, breaking block/DND/mute auto-decline,
  //   - `declineCall(..., currentUserId, ...)` recorded the wrong actor.
  let currentUserId: string
  try {
    const { authContextService } = await import('@/services/AuthContextService')
    currentUserId = await authContextService.getCurrentProfileId()
  } catch (err) {
    debug.error('Failed to resolve profile id in handleCallSignal:', err)
    return
  }

  // Don't show notifications for our own signals, but allow timeout
  // so the caller stops ringing and leaves the voice channel
  if (signal.callerId === currentUserId && signal.type !== 'timeout') return
  
  switch (signal.type) {
    case 'initiate': {
      const permissionCheck = await dmCallPermissions.canReceiveCall(
        signal.callerId,
        currentUserId,
        signal.conversationId
      )

      if (!permissionCheck.allowed) {
        debug.log('Auto-declining call:', permissionCheck.reason)
        await dmCallSignaling.declineCall(
          signal.conversationId,
          currentUserId,
          permissionCheck.reason as any
        )
        return
      }

      emit('incoming-call', {
        callerId: signal.callerId,
        callType: signal.callType,
        conversationId: signal.conversationId
      })
      break
    }
      
    case 'join':
    case 'accept':
      stopCallerRinging()
      dmCallSignaling.handleRemoteSignal(signal)
      updateActiveCallParticipants()
      break
    
    case 'leave':
      stopCallerRinging()
      dmCallSignaling.handleRemoteSignal(signal)
      updateActiveCallParticipants()
      break
      
    case 'end':
      stopCallerRinging()
      dmCallSignaling.handleRemoteSignal(signal)
      if (isInVoiceCall.value) {
        voiceStore.leaveVoiceChannel()
        toast.info('Call ended')
      }
      activeCallParticipantCount.value = 0
      break
      
    case 'decline': {
      stopCallerRinging()
      const declineMsg = dmCallPermissions.getDeclineReasonMessage(signal.reason)
      toast.info(declineMsg)
      break
    }
      
    case 'busy':
      stopCallerRinging()
      toast.info('User is busy')
      break
      
    case 'timeout':
      stopCallerRinging()
      if (isInVoiceCall.value) {
        voiceStore.leaveVoiceChannel()
      }
      toast.warning('No answer - call timed out')
      break
  }
}

const updateActiveCallParticipants = () => {
  const participants = dmCallSignaling.getCallParticipants(props.conversation.id)
  activeCallParticipantCount.value = participants.length
}

const subscribeToCallSignals = () => {
  callSignalUnsubscribe = dmCallSignaling.subscribeToConversation(
    props.conversation.id,
    handleCallSignal
  )
  // Update initial participant count
  updateActiveCallParticipants()
}

const unsubscribeFromCallSignals = () => {
  if (callSignalUnsubscribe) {
    callSignalUnsubscribe()
    callSignalUnsubscribe = null
  }
}

/**
 * External "start call" trigger. UserSidebar's context menu offers
 * "Start a Call" but the actual call setup (permissions / signaling /
 * voice join) lives here in DMHeader. Sidebar routes the user to the
 * DM first and then fires `harmony-dm-start-call` once the conversation
 * is open - we only act when the event targets *this* conversation so
 * stale events from a previous DM don't cause a cross-call.
 */
const handleStartCallRequest = (e: Event) => {
  const detail = (e as CustomEvent).detail || {}
  const targetConversationId: string | undefined = detail.conversationId
  const callType: 'voice' | 'video' = detail.callType || 'voice'
  if (!targetConversationId || targetConversationId !== props.conversation.id) return
  // Don't fight an existing call.
  if (isInVoiceCall.value || voiceStore.isConnected) return
  if (callType === 'video') {
    void toggleVideoCall()
  } else {
    void toggleVoiceCall()
  }
}

// Initialize presence tracking when component loads
onMounted(() => {
  initializePresenceTracking()
  subscribeToCallSignals()
  loadEncryptionStatus()
  loadConversationMuteState()
  window.addEventListener('harmony-dm-start-call', handleStartCallRequest)
})

// Watch for conversation changes to update presence tracking and encryption
watch(
  () => props.conversation.id,
  async (newId, oldId) => {
    if (newId !== oldId) {
      loadEncryptionStatus()
      loadConversationMuteState()
    }
  }
)

watch(
  () => props.conversation.other_user?.id,
  async (newUserId, oldUserId) => {
    if (newUserId !== oldUserId) {
      debug.log(`🔄 DMHeader: Conversation changed from ${oldUserId} to ${newUserId}`)
      // Pass oldUserId explicitly - props.conversation.other_user.id is
      // already pointing at newUserId by the time this callback runs.
      await cleanupPresenceTracking(oldUserId ?? null)
      // Initialize new tracking
      if (newUserId) {
        await initializePresenceTracking()
      }
    }
  },
  { immediate: true } // Initialize immediately when component is created
)

// Stop caller ringing when voice connection drops (e.g. user hangs up from dock/overlay)
watch(() => voiceStore.isConnected, (connected, wasConnected) => {
  if (wasConnected && !connected) {
    stopCallerRinging()
  }
})

// Also stop ringing when the connecting state clears (cancelled before connection established)
watch(() => voiceStore.isConnecting, (connecting, wasConnecting) => {
  if (wasConnecting && !connecting && !voiceStore.isConnected) {
    stopCallerRinging()
  }
})

// Cleanup when component unmounts
onUnmounted(() => {
  cleanupPresenceTracking()
  unsubscribeFromCallSignals()
  stopCallerRinging()
  window.removeEventListener('harmony-dm-start-call', handleStartCallRequest)
})

// Computed
const otherUserStatus = computed(() => {
  if (!props.conversation.other_user?.id) return 'offline'
  
  // Use presence-aware status for real-time accuracy
  const status = getPresenceAwareStatus(props.conversation.other_user.id).value
  
  // Debug logging to help identify issues
  if (import.meta.env.DEV) {
    debug.log(`🔍 DMHeader status for ${props.conversation.other_user.id}:`, {
      status,
      presenceInitialized: presenceInitialized.value,
      profileContextId: profileContextId
    })
  }
  
  return status
})

const isFederatedUser = computed(() => {
  return !props.conversation.other_user?.is_local
})

// Methods
const getStatusText = (status: string): string => {
  switch (status) {
    case 'online':
      return 'Online'
    case 'away':
      return 'Away'
    case 'busy':
      return 'Do Not Disturb'
    case 'offline':
    default:
      return 'Offline'
  }
}

const formatLastSeen = (lastSeen?: string): string => {
  if (!lastSeen) return 'some time ago'
  
  const now = new Date()
  const seen = new Date(lastSeen)
  const diffMs = now.getTime() - seen.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  
  return seen.toLocaleDateString()
}

const handleSearchClick = () => {
  showSearchModal.value = true
}

const handleSearchMessageClick = (_message: any) => {
  // Message click is handled by the modal, just close it
  // The message will be scrolled to in the conversation view
  showSearchModal.value = false
}

const handleMoreClick = (event: Event) => {
  event.stopPropagation()
  showOptionsMenu.value = !showOptionsMenu.value
}

const closeActionsMenu = () => {
  showOptionsMenu.value = false
}

const openGroupSettings = () => {
  showGroupSettings.value = true
  showOptionsMenu.value = false
}

async function loadConversationMuteState() {
  try {
    const ctx = await authContextService.getCurrentContext()
    if (!ctx.isAuthenticated) return

    const { data } = await supabase
      .from('notification_channels')
      .select('muted')
      .eq('user_id', ctx.profileId)
      .eq('conversation_id', props.conversation.id)
      .is('channel_id', null)
      .maybeSingle()

    isConversationMuted.value = data?.muted ?? false
  } catch (error) {
    debug.error('Failed to load conversation mute state:', error)
  }
}

const handleNotificationSettings = async () => {
  showOptionsMenu.value = false

  try {
    const ctx = await authContextService.getCurrentContext()
    if (!ctx.isAuthenticated) return

    const newMuted = !isConversationMuted.value
    isConversationMuted.value = newMuted

    const { data: existing } = await supabase
      .from('notification_channels')
      .select('id')
      .eq('user_id', ctx.profileId)
      .eq('conversation_id', props.conversation.id)
      .is('channel_id', null)
      .maybeSingle()

    if (existing?.id) {
      const { error } = await supabase
        .from('notification_channels')
        .update({ muted: newMuted, updated_at: new Date().toISOString() })
        .eq('id', existing.id)

      if (error) throw error
    } else {
      const { error } = await supabase
        .from('notification_channels')
        .insert({
          user_id: ctx.profileId,
          conversation_id: props.conversation.id,
          muted: newMuted,
        })

      if (error) throw error
    }

    // Sync mute state in DM store for sidebar display
    const dmStore = useDMStore()
    const conv = dmStore.conversations.find(c => c.id === props.conversation.id)
    if (conv) {
      conv.is_muted = newMuted
    }

    toast.success(newMuted ? 'Conversation muted' : 'Conversation unmuted')
    debug.log(`Conversation ${newMuted ? 'muted' : 'unmuted'}:`, props.conversation.id)
  } catch (error) {
    isConversationMuted.value = !isConversationMuted.value
    debug.error('Failed to toggle conversation mute:', error)
    toast.error('Failed to update notification setting')
  }
}

const goToEncryptionSettings = () => {
  showEncryptionSetupModal.value = false
  router.push('/settings/privacy')
}

const handleLeaveGroup = () => {
  debug.log('Leave group clicked')
  showOptionsMenu.value = false
}

const handleCloseDM = () => {
  debug.log('Close DM clicked')
  showOptionsMenu.value = false
}

// Voice/Video Call Functions
const toggleVoiceCall = async () => {
  try {
    if (isInVoiceCall.value) {
      stopCallerRinging()
      // Check if this is a federated call and end it properly
      if (dmCallSignaling.isFederatedCall(props.conversation.id)) {
        const profileId = await authContextService.getCurrentProfileId()
        if (profileId) await dmCallSignaling.endFederatedCall(props.conversation.id, profileId)
      }
      await voiceStore.leaveVoiceChannel()
      toast.info('Left call')
    } else {
      // Start voice call
      debug.log('📞 Starting DM voice call...')
      
      const profileId = await authContextService.getCurrentProfileId()
      if (!profileId) {
        toast.error('Authentication required')
        return
      }
      
      // Check if caller is already in another call
      if (voiceStore.isConnected) {
        toast.error('You are already in a call')
        return
      }
      
      // For 1-on-1 DMs, check permissions (skip for federated - permissions are local only)
      if (props.conversation.type !== 'group' && props.conversation.other_user?.id && !isFederatedUser.value) {
        const permissionCheck = await dmCallPermissions.canReceiveCall(
          profileId,
          props.conversation.other_user.id,
          props.conversation.id
        )
        
        if (!permissionCheck.allowed) {
          toast.error(permissionCheck.message || 'Cannot call this user')
          return
        }
      }
      
      // Route to federated or local call flow
      if (isFederatedUser.value) {
        await startFederatedCall(profileId, 'voice')
      } else {
        await startLocalCall(profileId, 'voice')
      }
    }
  } catch (error) {
    debug.error('Error toggling voice call:', error)
    toast.error('Failed to start call')
  }
}

// Start a local (same-instance) call
const startLocalCall = async (profileId: string, callType: 'voice' | 'video') => {
  const dmChannelId = `dm-${props.conversation.id}`
  
  const receiverIds = getReceiverIds()
  if (receiverIds.length === 0) {
    toast.error('No participants to call')
    return
  }
  
  await dmCallSignaling.initiateCall(props.conversation.id, profileId, callType, receiverIds)
  
  const success = await voiceStore.joinVoiceChannel(dmChannelId, 'dm')
  
  if (success) {
    if (callType === 'video') {
      await voiceStore.toggleVideo()
    }
    toast.success('Calling...')
    startCallerRinging()
    voiceStore.isOverlayVisible = true
    await new Promise(resolve => setTimeout(resolve, 100))
    debug.log(`✅ ${callType} call overlay opened for caller`)
  } else {
    toast.error('Failed to start call')
  }
}

// Start a federated (cross-instance) call via ActivityPub
const startFederatedCall = async (profileId: string, callType: 'voice' | 'video') => {
  const otherUser = props.conversation.other_user
  if (!otherUser?.federated_id) {
    toast.error('Cannot determine federated identity for this user')
    return
  }

  // Get our own federated ID
  const { data: myProfile } = await supabase
    .from('profiles')
    .select('federated_id, username')
    .eq('id', profileId)
    .single()

  if (!myProfile) {
    toast.error('Failed to get profile info')
    return
  }

  const callerFederatedId = myProfile.federated_id || `https://${window.location.hostname}/users/${myProfile.username}`

  const callInfo = await dmCallSignaling.initiateFederatedCall(
    props.conversation.id,
    profileId,
    callerFederatedId,
    otherUser.federated_id,
    callType
  )

  if (!callInfo) {
    toast.error('Failed to initiate federated call')
    return
  }

  // Join the LiveKit room
  const dmChannelId = callInfo.roomName
  const success = await voiceStore.joinVoiceChannel(dmChannelId, 'dm')

  if (success) {
    if (callType === 'video') {
      await voiceStore.toggleVideo()
    }
    toast.success('Calling...')
    startCallerRinging()
    voiceStore.isOverlayVisible = true
    await new Promise(resolve => setTimeout(resolve, 100))
    debug.log(`✅ Federated ${callType} call initiated`)
  } else {
    toast.error('Failed to start call')
  }
}

// Join an active call
const joinActiveCall = async () => {
  try {
    const profileId = await authContextService.getCurrentProfileId()
    if (!profileId) {
      toast.error('Authentication required')
      return
    }
    
    // For 1-on-1 DMs, verify call permissions before joining
    if (props.conversation.type !== 'group' && props.conversation.other_user?.id) {
      const permissionCheck = await dmCallPermissions.canReceiveCall(
        profileId,
        props.conversation.other_user.id,
        props.conversation.id
      )
      if (!permissionCheck.allowed) {
        toast.error(permissionCheck.message || 'Cannot join this call')
        return
      }
    }
    
    const dmChannelId = `dm-${props.conversation.id}`
    
    // Send join signal
    await dmCallSignaling.joinCall(props.conversation.id, profileId)
    
    // Join the voice channel
    const success = await voiceStore.joinVoiceChannel(dmChannelId, 'dm')
    
    if (success) {
      toast.success('Joined call')
      // Show voice overlay in maximized mode
      voiceStore.isOverlayVisible = true
      await new Promise(resolve => setTimeout(resolve, 100))
      debug.log('✅ Joined group call (maximized)')
    } else {
      toast.error('Failed to join call')
    }
  } catch (error) {
    debug.error('Error joining call:', error)
    toast.error('Failed to join call')
  }
}

const toggleVideoCall = async () => {
  try {
    const profileId = await authContextService.getCurrentProfileId()
    if (!profileId) {
      toast.error('Authentication required')
      return
    }
    
    if (!isInVoiceCall.value) {
      // Check if caller is already in another call
      if (voiceStore.isConnected) {
        toast.error('You are already in a call')
        return
      }
      
      // For 1-on-1 DMs, check permissions (skip for federated)
      if (props.conversation.type !== 'group' && props.conversation.other_user?.id && !isFederatedUser.value) {
        const permissionCheck = await dmCallPermissions.canReceiveCall(
          profileId,
          props.conversation.other_user.id,
          props.conversation.id
        )
        
        if (!permissionCheck.allowed) {
          toast.error(permissionCheck.message || 'Cannot call this user')
          return
        }
      }
      
      // Route to federated or local call flow
      if (isFederatedUser.value) {
        await startFederatedCall(profileId, 'video')
      } else {
        await startLocalCall(profileId, 'video')
      }
    } else {
      // Toggle video in ongoing call
      await voiceStore.toggleVideo()
      
      if (voiceStore.localState.isVideoEnabled) {
        toast.success('Camera on')
        if (!voiceStore.isOverlayVisible) {
          voiceStore.isOverlayVisible = true
        }
      } else {
        toast.info('Camera off')
      }
    }
  } catch (error) {
    debug.error('Error toggling video:', error)
    toast.error('Failed to toggle camera')
  }
}

// Get receiver IDs for calling
const getReceiverIds = (): string[] => {
  const currentUserId = authStore.session?.user?.id
  if (!currentUserId) return []
  
  if (props.conversation.type === 'group') {
    // For group chats, call all participants except self
    return (props.conversation.participants || [])
      .map(p => p.id || (p as any).user_id)
      .filter(id => id && id !== currentUserId)
  } else {
    // For 1-on-1, call the other user
    const otherUserId = props.conversation.other_user?.id
    return otherUserId ? [otherUserId] : []
  }
}

// Group chat methods
const stripShortcodes = (text: string): string => {
  if (!text) return text
  const stripped = text.replace(/:[a-zA-Z0-9_+-]+:/g, '').replace(/\s+/g, ' ').trim()
  return stripped || text
}

const getDefaultGroupName = (): string => {
  if (props.conversation.participants && props.conversation.participants.length > 0) {
    const names = props.conversation.participants
      .slice(0, 3)
      .map(p => stripShortcodes(p.display_name || p.username))
      .join(', ')
    
    if (props.conversation.participants.length > 3) {
      return `${names}, and ${props.conversation.participants.length - 3} others`
    }
    return names
  }
  
  return `Group Chat (${props.conversation.participant_count || 0} members)`
}
</script>

<style scoped>
.dm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-color);
  height: 48px;
  min-height: 48px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.mobile-menu-btn {
  display: none;
  background: none;
  border: none;
  color: var(--text-primary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  transition: background-color 0.2s;
}

.mobile-menu-btn:hover {
  background: var(--background-secondary);
}

.menu-icon {
  width: 20px;
  height: 20px;
}

.conversation-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.conversation-avatar {
  position: relative;
  flex-shrink: 0;
}



.group-name {
  display: flex;
  align-items: center;
  gap: 8px;
}

.edit-group-name-btn,
.participants-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s;
  font-size: 14px;
}

.edit-group-name-btn:hover,
.participants-btn:hover {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.participant-count {
  color: var(--text-secondary);
  font-size: 14px;
}

.call-status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #43b581;
  font-size: 14px;
  font-weight: 600;
  animation: pulse-text 2s ease-in-out infinite;
}

@keyframes pulse-text {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

.call-icon {
  color: #43b581;
}

.join-call-btn {
  background: #43b581 !important;
  color: var(--text-primary) !important;
  padding: 8px 16px !important;
  width: auto !important;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
  animation: pulse-button 2s ease-in-out infinite;
}

.join-call-btn:hover {
  background: #369968 !important;
  transform: translateY(-1px);
}

@keyframes pulse-button {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(67, 181, 129, 0.7);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(67, 181, 129, 0);
  }
}

.join-text {
  font-size: 14px;
}

.conversation-details {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.conversation-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 18px;
}

.conversation-status {
  font-size: 12px;
}

.status {
  font-weight: 500;
  color: var(--text-secondary);
}

/* if you want to color the status text with the status color */
/* .status.online {
  color: var(--success-color, #3ba55c);
}

.status.away {
  color: var(--warning-color, #faa61a);
}

.status.busy {
  color: var(--danger-color, #ed4245);
}

.status.offline {
  color: var(--text-secondary);
}
*/

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
}

.action-btn:hover {
  color: var(--text-primary);
  background: var(--background-secondary);
}

.voice-icon,
.search-icon,
.more-icon {
  width: 20px;
  height: 20px;
}

.federated-indicator {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 16px;
  height: 16px;
  background: var(--harmony-primary);
  border: 2px solid var(--background-primary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.federated-indicator svg {
  width: 10px;
  height: 10px;
  color: var(--text-primary);
}

.federated-handle {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: 'Roboto Mono', monospace;
  background: rgba(14, 165, 233, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.more-options-container {
  position: relative;
}

.actions-menu {
  position: absolute;
  top: 100%;
  right: 0;
  background: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: var(--space-2);
  min-width: 190px;
  z-index: 10;
}

.action-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all var(--transition-base);
}

.action-item:hover {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.action-item.danger {
  color: var(--error-primary);
}

.action-item.danger:hover {
  background: rgba(248, 113, 113, 0.1);
}

.action-item.action-item-disabled {
  opacity: 0.5;
}

.menu-separator {
  height: 1px;
  background: var(--border-color);
  margin: 8px 16px;
}

/* Mobile styles */
@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
  }
  
  .dm-header {
    padding: 12px;
    height: 64px;
  }
  
  .action-btn {
    width: 40px;
    height: 40px;
  }
  
  .voice-icon,
  .search-icon,
  .more-icon {
    width: 24px;
    height: 24px;
  }
}

/* Encryption Setup Modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.encryption-setup-modal {
  background: var(--background-primary);
  border-radius: 12px;
  max-width: 460px;
  width: 90%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  animation: slideUp 0.3s ease;
}

@keyframes slideUp {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.modal-header .close-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s;
}

.modal-header .close-btn:hover {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.modal-body {
  padding: 20px 24px;
}

.modal-body p {
  margin: 0 0 16px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.setup-steps {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

.step {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.step-number {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  background: var(--primary-color);
  color: var(--text-primary);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
}

.step-text {
  color: var(--text-primary);
  line-height: 1.5;
  padding-top: 2px;
}

.note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  background: rgba(var(--primary-rgb), 0.1);
  border-radius: 8px;
  color: var(--text-secondary) !important;
  font-size: 13px;
  margin-bottom: 0 !important;
}

.note svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--primary-color);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px 20px;
  border-top: 1px solid var(--border-color);
}

.modal-footer .btn {
  padding: 10px 20px;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.modal-footer .btn-secondary {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

.modal-footer .btn-secondary:hover {
  background: var(--background-tertiary);
}

.modal-footer .btn-primary {
  background: var(--primary-color);
  border: none;
  color: var(--text-primary);
}

.modal-footer .btn-primary:hover {
  filter: brightness(1.1);
}
</style>