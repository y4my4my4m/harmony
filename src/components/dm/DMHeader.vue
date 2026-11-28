<template>
  <div class="dm-header">
    <div class="header-left">
      <button 
        v-if="isMobile"
        type="button"
        class="mobile-menu-btn"
        :aria-label="t('a11y.drawer.navigation')"
        v-bind="leftDrawerToggle"
        @click="$emit('toggle-left-sidebar')"
      >
        <svg viewBox="0 0 24 24" class="menu-icon" aria-hidden="true">
          <path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z" fill="currentColor"/>
        </svg>
      </button>
      
      <div class="conversation-info">
        <GroupIcon
          v-if="conversation.type === 'group'"
          :conversation-id="conversation.id"
          :icon-path="conversation.icon_url"
          size="sm"
          style="width:32px;height:32px;"
        />

        <div v-else class="conversation-avatar">
          <Avatar
            :src="getAvatarUrl(conversation.other_user?.avatar_url)"
            :alt="getUserDisplayName(conversation.other_user?.id || '').value || conversation.other_user?.display_name || conversation.other_user?.username || t('chatNav.user.fallbackName')"
            size="sm"
            style="width:32px;height:32px;"
            :status="otherUserStatus"
          />
          <div 
            v-if="isFederatedUser" 
            class="federated-indicator"
            :title="t('dm.header.federatedUserFrom', { domain: conversation.other_user?.domain })"
          >
            <Icon name="globe" />
          </div>
        </div>

        <div class="conversation-details">
          <template v-if="conversation.type === 'group'">
            <h2 class="conversation-name group-name">
              {{ conversation.name || getDefaultGroupName() }}
            </h2>
            <div class="conversation-status">
              <span v-if="activeCallParticipantCount > 0" class="call-status">
                <Icon name="phone" :size="12" class="call-icon" />
                {{ t('voice.inCallCount', activeCallParticipantCount) }}
              </span>
              <span v-else class="participant-count">
                <Icon name="users" :size="12" class="members-icon" />
                {{ t('invite.modal.members', conversation.participant_count || 0) }}
              </span>
            </div>
          </template>

          <template v-else>
            <h2 class="conversation-name">
              <DisplayName v-if="conversation.other_user?.id" :user-id="conversation.other_user.id" :fallback="conversation.other_user?.display_name || conversation.other_user?.username || t('common.loading')" />
              <template v-else>{{ conversation.other_user?.display_name || conversation.other_user?.username || t('common.loading') }}</template>
            </h2>
            <div class="conversation-status">
              <span v-if="hasActiveCallNotJoined" class="call-status">
                <Icon name="phone" :size="12" class="call-icon" />
                {{ t('dm.header.callInProgress') }}
              </span>
              <span v-else-if="isFederatedUser" class="federated-handle" :style="{ color: conversation.other_user?.color || '#0EA5E9' }">
                {{ conversation.other_user?.handle || `@${conversation.other_user?.username}@${conversation.other_user?.domain}` }}
              </span>
              <span v-else-if="otherUserStatus !== 'offline'" class="status">
                {{ getStatusText(otherUserStatus) }}
              </span>
              <span v-else class="status">
                {{ t('dm.header.lastSeen', { when: formatLastSeen(conversation.other_user?.last_seen) }) }}
              </span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div class="header-actions">
      <button
        v-if="hasActiveCallNotJoined"
        class="action-btn join-call-btn"
        @click="joinActiveCall"
        :title="t('dm.joinCall')"
      >
        <Icon name="phone" :size="16" />
        <span class="join-text">{{ t('dm.joinCall') }}</span>
      </button>
      
      <button 
        v-else
        class="action-btn voice-btn"
        :class="{ active: isInVoiceCall }"
        @click="toggleVoiceCall"
        :title="isInVoiceCall ? t('dm.header.endVoiceCall') : t('dm.header.startVoiceCall')"
        :aria-label="isInVoiceCall ? t('dm.header.endVoiceCall') : t('dm.header.startVoiceCall')"
        data-testid="dm-call"
      >
        <Icon :name="isInVoiceCall ? 'phone-off' : 'phone'" :size="16" />
      </button>
      
      <button 
        class="action-btn search-btn"
        @click="handleSearchClick"
        :title="t('dm.header.searchInConversation')"
      >
        <svg viewBox="0 0 24 24" class="search-icon">
          <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
        </svg>
      </button>
      
      <div class="more-options-container">
        <button 
          class="action-btn more-btn"
          @click="handleMoreClick"
          :title="t('chatNav.header.more')"
          :aria-label="t('chatNav.header.more')"
          :aria-expanded="showOptionsMenu"
          :class="{ active: showOptionsMenu }"
          data-testid="dm-more"
        >
          <svg viewBox="0 0 24 24" class="more-icon">
            <path d="M12,16A2,2 0 0,1 14,18A2,2 0 0,1 12,20A2,2 0 0,1 10,18A2,2 0 0,1 12,16M12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12A2,2 0 0,1 12,10M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8A2,2 0 0,1 10,6A2,2 0 0,1 12,4Z" fill="currentColor"/>
          </svg>
        </button>

        <div v-if="showOptionsMenu" class="actions-menu" v-click-outside="closeActionsMenu" ref="optionsMenuRef">
          <!-- The header keeps Call and Search; the call starts with the camera off and the dock
               turns it on, ringing or answered. -->
          <button
            class="action-item"
            data-testid="dm-menu-add-people"
            @click="handleMenuAddUser"
          >
            <Icon name="user-plus" :size="16" />
            <span>{{ t('dm.header.addPeople') }}</span>
          </button>

          <button
            class="action-item"
            data-testid="dm-menu-video"
            @click="handleMenuVideoCall"
          >
            <Icon :name="isInVideoCall ? 'video-off' : 'video'" :size="16" />
            <span>{{ isInVideoCall ? t('dm.header.turnOffCamera') : t('dm.header.startVideoCall') }}</span>
          </button>

          <button
            v-if="conversation.type === 'group'"
            class="action-item"
            @click="openGroupSettings"
          >
            <Icon name="settings" :size="16" />
            <span>{{ t('dm.groupSettings.title') }}</span>
          </button>

          <button class="action-item" @click="handleMenuSearch">
            <Icon name="search" :size="16" />
            <span>{{ t('messageSearch.title') }}</span>
          </button>
          
          <button class="action-item" @click="handleNotificationSettings">
            <Icon :name="isConversationMuted ? 'bell-off' : 'bell'" :size="16" />
            <span>{{ isConversationMuted ? t('dm.header.unmuteConversation') : t('dm.header.muteConversation') }}</span>
          </button>
          
          <button 
            class="action-item"
            :class="{ 'action-item-disabled': !canToggleEncryption }"
            @click="toggleEncryption"
            :disabled="encryptionLoading"
            :title="encryptionToggleTitle"
          >
            <Icon :name="encryptionEnabled ? 'lock' : 'unlock'" :size="16" />
            <span>{{ encryptionEnabled ? t('dm.header.disableEncryption') : t('dm.header.enableEncryption') }}</span>
            <span v-if="encryptionLoading" class="loading-indicator">...</span>
          </button>
          
          <div class="menu-separator"></div>
          
          <button 
            v-if="conversation.type === 'group'"
            class="action-item danger"
            @click="handleLeaveGroup"
          >
            <Icon name="log-out" :size="16" />
            <span>{{ t('dm.groupSettings.leaveGroup') }}</span>
          </button>
          
          <button 
            v-else
            class="action-item danger"
            @click="handleCloseDM"
          >
            <Icon name="x" :size="16" />
            <span>{{ t('dm.header.closeDm') }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>

  <GroupSettingsModal
    :show="showGroupSettings"
    :conversation="conversation"
    :conversation-id="conversation.id"
    :participants="conversation.participants || []"
    @close="showGroupSettings = false"
    @updated="handleGroupUpdated"
  />

  <MessageSearchModal
    :show="showSearchModal"
    :conversation-id="conversation.id"
    @close="showSearchModal = false"
    @message-click="handleSearchMessageClick"
  />

  <Teleport to="body">
    <div v-if="showEncryptionSetupModal" class="modal-overlay" @click.self="showEncryptionSetupModal = false">
      <div class="modal-content encryption-setup-modal">
        <div class="modal-header">
          <h3>{{ t('dm.header.encryptionSetup.title') }}</h3>
          <button class="close-btn" @click="showEncryptionSetupModal = false">
            <Icon name="x" :size="20" />
          </button>
        </div>
        <div class="modal-body">
          <p>{{ t('dm.header.encryptionSetup.intro') }}</p>
          <div class="setup-steps">
            <div class="step">
              <span class="step-number">1</span>
              <i18n-t keypath="dm.header.encryptionSetup.step1" tag="span" class="step-text">
                <template #path><strong>{{ t('settings.title') }} → {{ t('settings.privacy') }} → {{ t('channelEncryption.settings.heading') }}</strong></template>
              </i18n-t>
            </div>
            <div class="step">
              <span class="step-number">2</span>
              <span class="step-text">{{ t('dm.header.encryptionSetup.step2') }}</span>
            </div>
            <div class="step">
              <span class="step-number">3</span>
              <span class="step-text">{{ t('dm.header.encryptionSetup.step3') }}</span>
            </div>
          </div>
          <p class="note">
            <Icon name="info" :size="14" />
            {{ t('dm.header.encryptionSetup.note') }}
          </p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showEncryptionSetupModal = false">
            {{ t('common.cancel') }}
          </button>
          <button class="btn btn-primary" @click="goToEncryptionSettings">
            {{ t('dm.header.encryptionSetup.goToSettings') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useT } from '@/composables/useT'
import { useAppDrawers } from '@/composables/useLayoutState'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import GroupIcon from '@/components/common/GroupIcon.vue'
import GroupSettingsModal from '@/components/dm/GroupSettingsModal.vue'
import MessageSearchModal from '@/components/search/MessageSearchModal.vue'
import { useUserData } from '@/composables/useUserData'
import { useDMStore, type DMConversation } from '@/stores/useDM'
import type { Message } from '@/types'
import { getAvatarUrl } from '@/utils/avatarUtils'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { useAuthStore } from '@/stores/auth'
import { useToast } from 'vue-toastification'
import { CallRingLimitedError, CallUndeliverableError, dmCallSignaling, type CallSignal } from '@/services/DMCallSignaling'
import { dmCallPermissions } from '@/services/DMCallPermissions'
import { notifyModerationRejection } from '@/services/AutoModService'
import { dmCallRoute, localCallReceivers } from '@/services/dmCallRouting'
import { authContextService } from '@/services/AuthContextService'
import { getInstanceDomain } from '@/services/instanceConfig'
import { supabase } from '@/supabase'
import { fetchConversationEncryption } from '@/services/conversationEncryption'
import { ensureCanJoinCall } from '@/services/voice/voiceEncryptionGate'
import { debug } from '@/utils/debug'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { dmConversationIdFromChannel, useCallSwitch } from '@/composables/useCallSwitch'
import { useDMCallJoin } from '@/composables/useDMCallJoin'

const { t, locale } = useT()
const { leftDrawerToggle } = useAppDrawers()

const router = useRouter()
const { confirm } = useConfirmDialog()
const toast = useToast()
const voiceStore = useUnifiedVoiceChannelStore()
const authStore = useAuthStore()
const { leaveCurrentCallFor } = useCallSwitch()
const { joinConversationCall } = useDMCallJoin()

let callerRingtoneInterval: ReturnType<typeof setInterval> | null = null
let callerRingtoneCap: ReturnType<typeof setTimeout> | null = null
const CALLER_RING_MAX_MS = 45000
// A decline or busy answer to this client's ring can land before the caller's
// own join completes. Refused: the jingle must not start after it. Abandoned:
// a busy answer ended the call, and a join that completes anyway is left.
let ringRefused = false
let ringAbandoned = false

const stopCallerRinging = () => {
  if (callerRingtoneInterval) {
    clearInterval(callerRingtoneInterval)
    callerRingtoneInterval = null
  }
  if (callerRingtoneCap) {
    clearTimeout(callerRingtoneCap)
    callerRingtoneCap = null
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
  // Hard cap: the ring must not outlive the call timeout when stop signals are missed.
  callerRingtoneCap = setTimeout(stopCallerRinging, CALLER_RING_MAX_MS)
}

// Ring state is presence-derived: stops when the call is answered (ringing
// cleared) or gone (declined, timed out, cancelled), independent of broadcast
// delivery.
watch(() => dmCallSignaling.callStateVersion.value, () => {
  if (!callerRingtoneInterval) return
  const call = dmCallSignaling.getActiveCall(props.conversation.id)
  if (!call || !call.ringing) {
    stopCallerRinging()
  }
})

// Active call tracking (presence-derived, reactive via callStateVersion)
const activeCallParticipantCount = computed(() => {
  dmCallSignaling.callStateVersion.value
  return dmCallSignaling.getCallParticipants(props.conversation.id).length
})

interface Props {
  conversation: DMConversation
  isMobile?: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'toggle-left-sidebar': []
  'toggle-voice-panel': []
  'group-updated': []
  'add-user': []
}>()

// Call state for THIS conversation. Another DM or a server voice channel
// does not count: its buttons would otherwise read "End call" here and a
// signal for this conversation would hang up the other call.
const inCallOf = (conversationId: string) =>
  voiceStore.isConnectedOrJoining &&
  dmConversationIdFromChannel(voiceStore.effectiveChannelId) === conversationId
const isInVoiceCall = computed(() => inCallOf(props.conversation.id))
const isInVideoCall = computed(() => isInVoiceCall.value && voiceStore.localState.isVideoEnabled)

// Active call state for any DM (1:1 or group). Reading callStateVersion
// establishes the reactive dependency.
const hasActiveCallNotJoined = computed(() => {
  dmCallSignaling.callStateVersion.value
  const hasActiveCall = dmCallSignaling.hasActiveCall(props.conversation.id)
  const isUserInCall = isInVoiceCall.value
  
  return hasActiveCall && !isUserInCall
})

const { 
  getUserDisplayName,
  subscribeToProfilePresence,
  unsubscribeFromProfilePresence,
  getPresenceAwareStatus
} = useUserData()

const showSearchModal = ref(false)
const showOptionsMenu = ref(false)
const presenceInitialized = ref(false)
const showEncryptionSetupModal = ref(false)
const optionsMenuRef = ref<HTMLElement>()

const showGroupSettings = ref(false)

const encryptionEnabled = ref(false)
const encryptionLoading = ref(false)
const userHasEncryption = ref(false)

const isConversationMuted = ref(false)

const canToggleEncryption = computed(() => userHasEncryption.value && !encryptionLoading.value)
const encryptionToggleTitle = computed(() => {
  if (!userHasEncryption.value) return t('dm.header.encryptionSetupFirst')
  return encryptionEnabled.value ? t('dm.header.clickToDisableEncryption') : t('dm.header.clickToEnableEncryption')
})

async function loadEncryptionStatus() {
  encryptionEnabled.value = false
  encryptionLoading.value = true
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    userHasEncryption.value = megolmMessageEncryptionService.isUnlocked()
    debug.log('User has encryption:', userHasEncryption.value)
    
    encryptionEnabled.value = await fetchConversationEncryption(props.conversation.id)
    debug.log('Conversation encryption enabled:', encryptionEnabled.value)
  } catch (error) {
    debug.warn('Failed to load encryption status:', error)
    encryptionEnabled.value = false
  } finally {
    encryptionLoading.value = false
  }
}

async function toggleEncryption() {
  debug.log('Toggle encryption clicked')
  debug.log('canToggleEncryption:', canToggleEncryption.value)
  debug.log('userHasEncryption:', userHasEncryption.value)
  
  if (!canToggleEncryption.value) {
    debug.log('Cannot toggle - user does not have encryption set up')
    closeActionsMenu()
    showEncryptionSetupModal.value = true
    return
  }
  
  const newState = !encryptionEnabled.value

  if (newState && isFederatedUser.value) {
    const confirmed = await confirm({
      title: t('dm.header.enableEncryption'),
      message: t('dm.header.federatedEncryptionWarning'),
      confirmButtonText: t('dm.header.enable'),
    })
    if (!confirmed) {
      closeActionsMenu()
      return
    }
  }

  encryptionLoading.value = true
  try {
    debug.log('Setting encryption to:', newState)
    
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
      debug.error('Supabase error:', error)
      throw error
    }
    
    encryptionEnabled.value = newState

    window.dispatchEvent(new CustomEvent('dm-encryption-toggled', {
      detail: { conversationId: props.conversation.id, enabled: newState }
    }))

    toast.success(newState ? t('dm.header.encryptionEnabled') : t('dm.header.encryptionDisabled'))
    closeActionsMenu()
  } catch (error) {
    debug.error('Failed to toggle encryption:', error)
    toast.error(t('dm.header.encryptionUpdateFailed'))
  } finally {
    encryptionLoading.value = false
  }
}

function handleGroupUpdated() {
  emit('group-updated')
}

// Conversation partner is tracked for presence while the header is mounted.
let profileContextId: string | null = null

const initializePresenceTracking = async () => {
  if (props.conversation.other_user?.id && !profileContextId) {
    try {
      const userId = props.conversation.other_user.id
      
      // userDataService deduplicates when the user is already tracked globally.
      profileContextId = await subscribeToProfilePresence(userId)
      presenceInitialized.value = true
      debug.log(`DMHeader: Tracking presence for user ${userId}`)
    } catch (error) {
      debug.error('Failed to subscribe to profile presence:', error)
    }
  }
}

/**
 * Stop tracking presence for a previously-subscribed user.
 *
 * On conversation switch the watcher fires after props are
 * updated, so defaulting to `props.conversation.other_user?.id` unsubscribes
 * the new user (a noop) and leaks the old user's subscription. Callers in
 * `watch()` paths must pass `oldUserId` explicitly; the unmount path uses the
 * current id.
 */
const cleanupPresenceTracking = async (userId?: string | null) => {
  const targetUserId = userId ?? props.conversation.other_user?.id
  if (targetUserId && profileContextId) {
    try {
      await unsubscribeFromProfilePresence(targetUserId)
      profileContextId = null
      presenceInitialized.value = false
      debug.log(`DMHeader: Stopped tracking presence for user ${targetUserId}`)
    } catch (error) {
      debug.error('Failed to unsubscribe from profile presence:', error)
    }
  }
}

let callSignalUnsubscribe: (() => void) | null = null

const handleCallSignal = async (signal: CallSignal) => {
  if (!authStore.session?.user?.id) return
  const conversation = props.conversation

  // Signal participant IDs and permission lookups key on
  // profile ids, not auth UUIDs; the rest of the call codebase resolves via
  // `authContextService.getCurrentProfileId()`. An auth UUID here breaks
  // self-signal suppression, the `canReceiveCall` row lookup (block/DND/mute
  // auto-decline) and the actor recorded by `declineCall`.
  let currentUserId: string
  try {
    const { authContextService } = await import('@/services/AuthContextService')
    currentUserId = await authContextService.getCurrentProfileId()
  } catch (err) {
    debug.error('Failed to resolve profile id in handleCallSignal:', err)
    return
  }

  // Own signals raise no notification.
  if (signal.callerId === currentUserId) return

  // Rings arrive on dm-calls:{profile} through ring_dm_call (GlobalDMCallListener), never here.
  switch (signal.type) {
    case 'join':
    case 'accept':
    case 'leave':
      stopCallerRinging()
      dmCallSignaling.handleRemoteSignal(signal)
      break

    case 'end':
      stopCallerRinging()
      dmCallSignaling.handleRemoteSignal(signal)
      if (inCallOf(conversation.id)) {
        voiceStore.leaveVoiceChannel()
        toast.info(t('dm.header.callEnded'))
      }
      break
      
    case 'decline': {
      ringRefused = true
      stopCallerRinging()
      const declineMsg = dmCallPermissions.getDeclineReasonMessage(signal.reason)
      toast.info(declineMsg)
      break
    }
      
    case 'busy':
      ringRefused = true
      stopCallerRinging()
      toast.info(t('dm.busy'))
      // A direct call has nobody else to ring: it ends instead of waiting out the timeout.
      if (conversation.type !== 'group') {
        await abandonOwnRing(currentUserId, conversation.id).catch(error => debug.warn('Cancelling a busy call failed:', error))
      }
      break
      
    case 'timeout':
      // A receiver hearing a caller's ring expire. The caller's own timeout
      // runs in dmCallSignaling; the receiver's ring ends over its ring topic.
      break
  }
}

const subscribeToCallSignals = () => {
  callSignalUnsubscribe = dmCallSignaling.subscribeToConversation(
    props.conversation.id,
    handleCallSignal
  )
}

const unsubscribeFromCallSignals = () => {
  if (callSignalUnsubscribe) {
    callSignalUnsubscribe()
    callSignalUnsubscribe = null
  }
}

/**
 * External "start call" trigger. UserSidebar's context menu offers "Start a
 * Call" but call setup (permissions / signaling / voice join) lives here.
 * Sidebar routes to the DM first, then fires `harmony-dm-start-call`. Acts
 * only when the event targets this conversation, so stale events from a
 * previous DM cannot cross-call.
 */
const handleStartCallRequest = (e: Event) => {
  const detail = (e as CustomEvent).detail || {}
  const targetConversationId: string | undefined = detail.conversationId
  const callType: 'voice' | 'video' = detail.callType || 'voice'
  if (!targetConversationId || targetConversationId !== props.conversation.id) return
  // Already in this call: nothing to start. Another call asks to switch.
  if (isInVoiceCall.value) return
  if (callType === 'video') {
    void toggleVideoCall()
  } else {
    void toggleVoiceCall()
  }
}

// A participant's toggle (conversation:encryption) or this client's own.
const handleEncryptionToggled = (event: Event) => {
  const detail = (event as CustomEvent).detail as { conversationId?: string; enabled?: boolean } | null
  if (detail?.conversationId === props.conversation.id && typeof detail.enabled === 'boolean') {
    encryptionEnabled.value = detail.enabled
  }
}

onMounted(() => {
  initializePresenceTracking()
  subscribeToCallSignals()
  loadEncryptionStatus()
  loadConversationMuteState()
  window.addEventListener('harmony-dm-start-call', handleStartCallRequest)
  window.addEventListener('dm-encryption-toggled', handleEncryptionToggled)
})

watch(
  () => props.conversation.id,
  async (newId, oldId) => {
    if (newId !== oldId) {
      loadEncryptionStatus()
      loadConversationMuteState()
      stopCallerRinging()
      // Re-bind call signals to the new conversation; the old subscription
      // would surface stale call state from the previous DM.
      unsubscribeFromCallSignals()
      subscribeToCallSignals()
    }
  }
)

watch(
  () => props.conversation.other_user?.id,
  async (newUserId, oldUserId) => {
    if (newUserId !== oldUserId) {
      debug.log(`DMHeader: Conversation changed from ${oldUserId} to ${newUserId}`)
      // Pass oldUserId explicitly - props.conversation.other_user.id is
      // already pointing at newUserId by the time this callback runs.
      await cleanupPresenceTracking(oldUserId ?? null)
      if (newUserId) {
        await initializePresenceTracking()
      }
    }
  },
  { immediate: true }
)

// Stop caller ringing when voice connection drops (e.g. user hangs up from dock/overlay)
watch(() => voiceStore.isConnected, (connected, wasConnected) => {
  if (wasConnected && !connected) {
    stopCallerRinging()
  }
})

// Stop ringing when the connecting state clears without a connection (cancelled).
watch(() => voiceStore.isConnecting, (connecting, wasConnecting) => {
  if (wasConnecting && !connecting && !voiceStore.isConnected) {
    stopCallerRinging()
  }
})

onUnmounted(() => {
  cleanupPresenceTracking()
  unsubscribeFromCallSignals()
  stopCallerRinging()
  window.removeEventListener('harmony-dm-start-call', handleStartCallRequest)
  window.removeEventListener('dm-encryption-toggled', handleEncryptionToggled)
})

const otherUserStatus = computed(() => {
  if (!props.conversation.other_user?.id) return 'offline'
  
  const status = getPresenceAwareStatus(props.conversation.other_user.id).value
  
  if (import.meta.env.DEV) {
    debug.log(`DMHeader status for ${props.conversation.other_user.id}:`, {
      status,
      presenceInitialized: presenceInitialized.value,
      profileContextId: profileContextId
    })
  }
  
  return status
})

const isFederatedUser = computed(() => dmCallRoute(props.conversation) === 'federated')

const getStatusText = (status: string): string => {
  switch (status) {
    case 'online':
      return t('user.online')
    case 'away':
      return t('user.away')
    case 'busy':
      return t('user.dnd')
    case 'offline':
    default:
      return t('user.offline')
  }
}

const formatLastSeen = (lastSeen?: string): string => {
  if (!lastSeen) return t('dm.header.lastSeenUnknown')
  
  const now = new Date()
  const seen = new Date(lastSeen)
  const diffMs = now.getTime() - seen.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffMins < 1) return t('time.justNow')
  if (diffMins < 60) return diffMins === 1 ? t('time.minuteAgo') : t('time.minutesAgo', { count: diffMins })
  if (diffHours < 24) return diffHours === 1 ? t('time.hourAgo') : t('time.hoursAgo', { count: diffHours })
  if (diffDays < 7) return diffDays === 1 ? t('time.dayAgo') : t('time.daysAgo', { count: diffDays })
  
  return seen.toLocaleDateString(locale.value)
}

const handleSearchClick = () => {
  showSearchModal.value = true
}

const handleMenuSearch = () => {
  showOptionsMenu.value = false
  showSearchModal.value = true
}

const handleMenuVideoCall = () => {
  showOptionsMenu.value = false
  toggleVideoCall()
}

const handleMenuAddUser = () => {
  showOptionsMenu.value = false
  emit('add-user')
}

const handleSearchMessageClick = (message: Message, searchQuery?: string) => {
  showSearchModal.value = false
  router.push({
    name: 'DMConversation',
    params: { conversationId: props.conversation.id },
    query: { messageId: message.id, ...(searchQuery ? { searchQuery } : {}) }
  })
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

    toast.success(newMuted ? t('dm.header.conversationMuted') : t('dm.header.conversationUnmuted'))
    debug.log(`Conversation ${newMuted ? 'muted' : 'unmuted'}:`, props.conversation.id)
  } catch (error) {
    isConversationMuted.value = !isConversationMuted.value
    debug.error('Failed to toggle conversation mute:', error)
    toast.error(t('dm.header.notificationUpdateFailed'))
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

const toggleVoiceCall = async () => {
  const conversation = props.conversation
  try {
    if (isInVoiceCall.value) {
      stopCallerRinging()
      if (dmCallSignaling.isFederatedCall(conversation.id)) {
        const profileId = await authContextService.getCurrentProfileId()
        if (profileId) await dmCallSignaling.endFederatedCall(conversation.id, profileId)
      }
      await voiceStore.leaveVoiceChannel()
    } else {
      debug.log('Starting DM voice call...')

      const profileId = await authContextService.getCurrentProfileId()
      if (!profileId) {
        toast.error(t('auth.errors.authRequired'))
        return
      }

      await startCall(profileId, 'voice', conversation)
    }
  } catch (error) {
    debug.error('Error toggling voice call:', error)
    toast.error(t('dm.header.startCallFailed'))
  }
}

/**
 * Route per dmCallRoute; a peer still loading is resolved from its profile.
 * Refusals come before the switch-calls confirm, so a refused call leaves the
 * caller in its current voice channel. A call is of the `conversation` it was
 * placed in, whichever the header shows by the time a step of it ends.
 */
const startCall = async (profileId: string, callType: 'voice' | 'video', conversation: DMConversation) => {
  let route = dmCallRoute(conversation)
  const peer = conversation.type === 'group' ? null : conversation.other_user
  if (route === 'unknown' && peer?.id) {
    const { data } = await supabase.from('profiles').select('is_local').eq('id', peer.id).maybeSingle()
    route = data?.is_local === false ? 'federated' : 'local'
  }

  if (route === 'federated') {
    if (!(await leaveCurrentCallFor())) return
    await startFederatedCall(profileId, callType, conversation)
    return
  }

  const receiverIds = localCallReceivers(conversation, profileId)
  if (receiverIds.length === 0) {
    toast.error(conversation.type === 'group'
      ? t('dm.header.noLocalMembersToCall')
      : t('dm.header.noParticipantsToCall'))
    return
  }
  if (peer?.id) {
    const permissionCheck = await dmCallPermissions.canPlaceCall(profileId, peer.id)
    if (!permissionCheck.allowed) {
      toast.error(permissionCheck.message || t('dm.header.cannotCallUser'))
      return
    }
  }
  // An encrypted conversation's call this device cannot join rings no one.
  if (!(await ensureCanJoinCall('dm', `dm-${conversation.id}`))) return
  // In another call, a refusal comes before the switch, which leaves that call. Out of one,
  // placing the call answers the same with no extra request.
  if (peer?.id && voiceStore.isConnectedOrJoining) {
    try {
      await dmCallSignaling.checkCallDeliverable(conversation.id)
    } catch (error) {
      if (error instanceof CallUndeliverableError) {
        toast.error(t('dm.callUndeliverable'))
        return
      }
      throw error
    }
  }
  if (!(await leaveCurrentCallFor())) return
  await startLocalCall(profileId, callType, receiverIds, conversation.id)
}

/**
 * Rings only while this client's call is still unanswered and unrefused, and its
 * conversation shown: the answer that stops the jingle is heard there.
 */
const ringIfStillRinging = (conversationId: string) => {
  if (props.conversation.id !== conversationId) return
  if (!ringRefused && dmCallSignaling.getActiveCall(conversationId)?.ringing) {
    startCallerRinging()
  }
}

/**
 * Ends this client's unanswered call: leaving the room cancels the ring on
 * every receiver. Before the join starts there is no room to leave.
 */
const abandonOwnRing = async (profileId: string, conversationId: string) => {
  const call = dmCallSignaling.getActiveCall(conversationId)
  if (!call?.ringing || call.callerId !== profileId) return
  ringAbandoned = true
  if (inCallOf(conversationId)) {
    await voiceStore.leaveVoiceChannel()
  } else {
    await dmCallSignaling.leaveCall(conversationId, profileId)
  }
}

const startLocalCall = async (profileId: string, callType: 'voice' | 'video', receiverIds: string[], conversationId: string) => {
  const dmChannelId = `dm-${conversationId}`
  
  ringRefused = false
  ringAbandoned = false
  try {
    await dmCallSignaling.initiateCall(conversationId, profileId, callType, receiverIds)
  } catch (error) {
    // A block refuses the call as it refuses a message, in words that do not name a block.
    if (error instanceof CallUndeliverableError) {
      toast.error(t('dm.callUndeliverable'))
      return
    }
    // Past account_rings_per_minute: the refusal says when the next call can ring.
    if (error instanceof CallRingLimitedError) {
      notifyModerationRejection(error)
      return
    }
    throw error
  }

  const success = await voiceStore.joinVoiceChannel(dmChannelId, 'dm')

  if (ringAbandoned) {
    if (success) await voiceStore.leaveVoiceChannel()
    return
  }
  
  if (success) {
    if (callType === 'video') {
      await voiceStore.toggleVideo()
    }
    ringIfStillRinging(conversationId)
    voiceStore.isOverlayVisible = true
    debug.log(`${callType} call overlay opened for caller`)
  } else {
    toast.error(voiceStore.joinError || t('dm.header.startCallFailed'))
    // The ring ends with the call: receivers stop ringing, and no "No answer" follows.
    await abandonOwnRing(profileId, conversationId).catch(error => debug.warn('Cancelling the ring of a failed call failed:', error))
  }
}

const startFederatedCall = async (profileId: string, callType: 'voice' | 'video', conversation: DMConversation) => {
  const otherUser = conversation.other_user
  let calleeFederatedId = otherUser?.federated_id
  if (!calleeFederatedId && otherUser?.id) {
    const { data } = await supabase.from('profiles').select('federated_id').eq('id', otherUser.id).maybeSingle()
    calleeFederatedId = data?.federated_id ?? undefined
  }
  if (!calleeFederatedId) {
    toast.error(t('dm.header.noFederatedIdentity'))
    return
  }

  const { data: myProfile } = await supabase
    .from('profiles')
    .select('federated_id, username')
    .eq('id', profileId)
    .single()

  if (!myProfile) {
    toast.error(t('dm.header.profileInfoFailed'))
    return
  }

  const callerFederatedId = myProfile.federated_id || `https://${getInstanceDomain()}/users/${myProfile.username}`

  ringRefused = false
  let callInfo: Awaited<ReturnType<typeof dmCallSignaling.initiateFederatedCall>>
  try {
    callInfo = await dmCallSignaling.initiateFederatedCall(
      conversation.id,
      profileId,
      callerFederatedId,
      calleeFederatedId,
      callType
    )
  } catch (error) {
    if (error instanceof CallRingLimitedError) {
      notifyModerationRejection(error)
      return
    }
    throw error
  }

  if (!callInfo) {
    toast.error(t('dm.header.federatedCallFailed'))
    return
  }

  const dmChannelId = callInfo.roomName
  const success = await voiceStore.joinVoiceChannel(dmChannelId, 'dm')

  if (success) {
    if (callType === 'video') {
      await voiceStore.toggleVideo()
    }
    ringIfStillRinging(conversation.id)
    voiceStore.isOverlayVisible = true
    debug.log(`Federated ${callType} call initiated`)
  } else {
    toast.error(voiceStore.joinError || t('dm.header.startCallFailed'))
    // The ring ends on the backend, which tells the callee's instance; no "No answer" follows.
    if (dmCallSignaling.getActiveCall(conversation.id)?.ringing) {
      await dmCallSignaling.endFederatedCall(conversation.id, profileId)
    }
  }
}

const joinActiveCall = async () => {
  const conversation = props.conversation
  try {
    const profileId = await authContextService.getCurrentProfileId()
    if (!profileId) {
      toast.error(t('auth.errors.authRequired'))
      return
    }
    
    if (conversation.type !== 'group' && conversation.other_user?.id) {
      const permissionCheck = await dmCallPermissions.canPlaceCall(
        profileId,
        conversation.other_user.id
      )
      if (!permissionCheck.allowed) {
        toast.error(permissionCheck.message || t('dm.header.cannotJoinCall'))
        return
      }
    }
    
    await joinConversationCall(conversation.id)
  } catch (error) {
    debug.error('Error joining call:', error)
    toast.error(t('dm.header.joinCallFailed'))
  }
}

const toggleVideoCall = async () => {
  const conversation = props.conversation
  try {
    const profileId = await authContextService.getCurrentProfileId()
    if (!profileId) {
      toast.error(t('auth.errors.authRequired'))
      return
    }
    
    if (!inCallOf(conversation.id)) {
      await startCall(profileId, 'video', conversation)
    } else {
      await voiceStore.toggleVideo()

      if (voiceStore.localState.isVideoEnabled && !voiceStore.isOverlayVisible) {
        voiceStore.isOverlayVisible = true
      }
    }
  } catch (error) {
    debug.error('Error toggling video:', error)
    toast.error(t('dm.header.toggleCameraFailed'))
  }
}

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
      return t('dm.groupSettings.defaultNameMore', { names, count: props.conversation.participants.length - 3 })
    }
    return names
  }
  
  return t('dm.header.defaultNameCount', props.conversation.participant_count || 0)
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
  min-width: 40px;
  min-height: 40px;
  align-items: center;
  justify-content: center;
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
  color: var(--text-success);
  font-size: 14px;
  font-weight: 600;
}

.call-icon {
  color: var(--text-success);
}

.join-call-btn {
  background: var(--success) !important;
  color: var(--text-on-primary) !important;
  padding: 8px 16px !important;
  width: auto !important;
  gap: 8px;
  font-weight: 600;
  font-size: 14px;
}

.join-call-btn:hover {
  background: var(--success-hover) !important;
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
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status {
  font-weight: 500;
  color: var(--text-secondary);
}

/* Optional status-colored text. */
/* .status.online {
  color: var(--success-color, #3ba55c);
}

.status.away {
  color: var(--warning-color, #faa61a);
}

.status.busy {
  color: var(--text-danger, #ed4245);
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
  color: var(--text-on-primary);
}

.federated-handle {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: 'Roboto Mono', monospace;
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* An inline span ignores max-width and overflow. */
  display: inline-block;
  max-width: 100%;
  vertical-align: bottom;
}

.more-options-container {
  position: relative;
}

.actions-menu {
  position: absolute;
  top: 100%;
  right: 0;
  background: var(--background-floating);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-large);
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
  color: var(--text-danger);
}

.action-item.danger:hover {
  background: color-mix(in srgb, var(--error) 10%, transparent);
}

.action-item.action-item-disabled {
  opacity: 0.5;
}

.menu-separator {
  height: 1px;
  background: var(--border-color);
  margin: 8px 16px;
}

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

  /* Search moves into the overflow menu: the header keeps Call and More. */
  .search-btn {
    display: none;
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
}

.encryption-setup-modal {
  background: var(--background-primary);
  border-radius: var(--radius-lg);
  max-width: 460px;
  width: 90%;
  box-shadow: var(--shadow-large);
}

@media (prefers-reduced-motion: no-preference) {
  .modal-overlay {
    animation: fadeIn 0.2s ease;
  }

  .encryption-setup-modal {
    animation: slideUp 0.3s ease;
  }
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
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
  color: var(--text-on-primary);
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
  background: var(--harmony-primary-alpha-light);
  border-radius: var(--radius-md);
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
  color: var(--text-on-primary);
}

.modal-footer .btn-primary:hover {
  background: var(--harmony-primary-hover);
}
</style>