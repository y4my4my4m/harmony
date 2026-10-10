<template>
  <div class="dm-sidebar" data-testid="dm-sidebar">
    <!-- Header -->
    <div class="dm-header">
      <h2 class="dm-title">{{ $t('dm.directMessages') }}</h2>
      <div class="header-actions">
        <button 
          class="new-dm-btn"
          data-testid="dm-new-conversation"
          @click="showUserSearch = !showUserSearch"
          title="Start a new DM"
          aria-label="Start a new DM"
          :aria-expanded="showUserSearch"
        >
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
          </svg>
        </button>
        <button 
          class="group-chat-btn"
          @click="showGroupChatModal = true"
          title="Create group chat"
          aria-label="Create group chat"
        >
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M12,5.5A3.5,3.5 0 0,1 15.5,9A3.5,3.5 0 0,1 12,12.5A3.5,3.5 0 0,1 8.5,9A3.5,3.5 0 0,1 12,5.5M5,8C5.56,8 6.08,8.15 6.53,8.42C6.38,9.85 6.8,11.27 7.66,12.38C7.16,13.34 6.16,14 5,14A3,3 0 0,1 2,11A3,3 0 0,1 5,8M19,8A3,3 0 0,1 22,11A3,3 0 0,1 19,14C17.84,14 16.84,13.34 16.34,12.38C17.2,11.27 17.62,9.85 17.47,8.42C17.92,8.15 18.44,8 19,8M5.5,18.25C5.5,16.18 8.41,14.5 12,14.5C15.59,14.5 18.5,16.18 18.5,18.25V20H5.5V18.25M0,20V18.5C0,17.11 1.89,15.94 4.45,15.6C3.86,16.28 3.5,17.22 3.5,18.25V20H0M24,20H20.5V18.25C20.5,17.22 20.14,16.28 19.55,15.6C22.11,15.94 24,17.11 24,18.5V20Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- User Search -->
    <div v-if="showUserSearch" class="user-search-section">
      <div class="search-input-container">
        <input
          ref="userSearchInputRef"
          v-model="searchQuery"
          type="text"
          :placeholder="$t('dm.searchUsersPlaceholder')"
          class="search-input"
          @input="handleSearch"
          @keydown.escape="closeSearch"
        />
        <button 
          v-if="searchQuery"
          @click="clearSearch"
          class="clear-search-btn"
        >
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
          </svg>
        </button>
      </div>

      <!-- Search Results (filtered to exclude blocked users) -->
      <div v-if="searchQuery" class="search-results">
        <div v-if="dmStore.isSearching" class="search-loading">
          {{ $t('common.search') }}...
        </div>
        <EmptyState
          v-else-if="filteredSearchResults.length === 0"
          size="sm"
          icon="search"
          :title="$t('dm.noUsersFound')"
        />
        <div 
          v-else
          v-for="user in filteredSearchResults"
          :key="user.id"
          class="search-result-item"
          @click="startConversation(user)"
        >
          <Avatar
            :src="getUserAvatarUrl(user.id).value"
            :alt="getUserDisplayName(user.id).value"
            size="sm"
            :status="getUserStatus(user.id)"
            class="user-avatar"
          />
          <div class="user-info">
            <div class="user-name-container">
              <div class="user-name"><DisplayName :user-id="user.id" :truncate="true" /></div>
              <div v-if="!user.is_local && user.domain" class="federated-indicator" title="Federated user">
                <svg viewBox="0 0 24 24" class="icon">
                  <path d="M16.36,14C16.44,13.34 16.5,12.68 16.5,12C16.5,11.32 16.44,10.66 16.36,10H19.74C19.9,10.64 20,11.31 20,12C20,12.69 19.9,13.36 19.74,14M14.59,19.56C15.19,18.45 15.65,17.25 15.97,16H18.92C17.96,17.65 16.43,18.93 14.59,19.56M14.34,14H9.66C9.56,13.34 9.5,12.68 9.5,12C9.5,11.32 9.56,10.65 9.66,10H14.34C14.43,10.65 14.5,11.32 14.5,12C14.5,12.68 14.43,13.34 14.34,14M12,19.96C11.17,18.76 10.5,17.43 10.09,16H13.91C13.5,17.43 12.83,18.76 12,19.96M8,8H5.08C6.03,6.34 7.57,5.06 9.4,4.44C8.8,5.55 8.35,6.75 8,8M5.08,16H8C8.35,17.25 8.8,18.45 9.4,19.56C7.57,18.93 6.03,17.65 5.08,16M4.26,14C4.1,13.36 4,12.69 4,12C4,11.31 4.1,10.64 4.26,10H7.64C7.56,10.66 7.5,11.32 7.5,12C7.5,12.68 7.56,13.34 7.64,14M12,4.03C12.83,5.23 13.5,6.57 13.91,8H10.09C10.5,6.57 11.17,5.23 12,4.03M18.92,8H15.97C15.65,6.75 15.19,5.55 14.59,4.44C16.43,5.07 17.96,6.34 18.92,8M12,2C6.47,2 2,6.5 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
                </svg>
              </div>
            </div>
            <div v-if="user.display_name || !user.is_local" class="username">
              {{ !user.is_local && user.handle ? user.handle : user.username }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Conversations List -->
    <div class="conversations-section">
      <!-- Only show the loading state when there's nothing cached to display.
           If we already have conversations, render them immediately and let any
           refresh happen in the background (stale-while-revalidate). -->
      <div
        v-if="(dmStore.loadingConversations || dmStore.isInitializing) && sortedConversations.length === 0"
        class="conversations-skeleton"
        aria-busy="true"
      >
        <div v-for="i in 7" :key="i" class="conv-skeleton-row">
          <div class="conv-skeleton-avatar"></div>
          <div class="conv-skeleton-lines">
            <div class="conv-skeleton-line" :style="{ width: `${45 + (i * 13) % 40}%` }"></div>
            <div class="conv-skeleton-line dim" :style="{ width: `${60 + (i * 17) % 30}%` }"></div>
          </div>
        </div>
      </div>
      
      <EmptyState
        v-else-if="sortedConversations.length === 0"
        size="sm"
        icon="message-circle"
        :title="$t('dm.noConversations')"
        :description="$t('dm.startBySearching')"
        :action-label="$t('dm.newMessage')"
        @action="showUserSearch = true"
      />

      <div v-else class="conversations-list">
        <div 
          v-for="conversation in sortedConversations"
          :key="conversation.id"
          class="conversation-item"
          data-testid="dm-conversation-item"
          :class="{ 
            'active': conversation.id === dmStore.currentConversationId,
            'unread': conversation.unread_count && conversation.unread_count > 0,
            'group-chat': conversation.type === 'group',
            'muted': conversation.is_muted,
            'in-call': liveCallIds.has(conversation.id)
          }"
          @click="selectConversation(conversation.id)"
          @mouseenter="handleConversationHover(conversation.id); scheduleConversationPrefetch(conversation.id)"
          @mouseleave="cancelConversationPrefetch"
        >
          <!-- Group Chat Avatar: Uses group icon from metadata -->
          <GroupIcon
            v-if="conversation.type === 'group'"
            :conversation-id="conversation.id"
            :icon-path="conversation.icon_url"
            size="sm"
            :show-participant-count="true"
            :participant-count="conversation.participant_count"
            class="conversation-avatar"
          />

          <!-- Direct Chat Avatar: Uses other user's profile avatar -->
          <Avatar
            v-else
            :src="getConversationAvatarUrl(conversation)"
            :alt="getConversationDisplayName(conversation)"
            size="sm"
            :status="getConversationUserStatus(conversation)"
            class="conversation-avatar"
          />
          
          <div class="conversation-content">
            <div class="conversation-header">
              <div class="conversation-name-container">
                <div class="conversation-name">
                  <!-- Group Chat Name -->
                  <template v-if="conversation.type === 'group'">
                    {{ conversation.name || getDefaultGroupName(conversation) }}
                  </template>
                  <!-- Direct Chat Name -->
                  <template v-else>
                    <DisplayName v-if="conversation.other_user?.id" :user-id="conversation.other_user.id" :truncate="true" />
                    <template v-else>{{ getConversationDisplayName(conversation) }}</template>
                  </template>
                </div>
                <div v-if="conversation.other_user && !conversation.other_user.is_local && conversation.other_user.domain" 
                     class="federated-indicator" 
                     title="Federated user">
                  <svg viewBox="0 0 24 24" class="icon">
                    <path d="M16.36,14C16.44,13.34 16.5,12.68 16.5,12C16.5,11.32 16.44,10.66 16.36,10H19.74C19.9,10.64 20,11.31 20,12C20,12.69 19.9,13.36 19.74,14M14.59,19.56C15.19,18.45 15.65,17.25 15.97,16H18.92C17.96,17.65 16.43,18.93 14.59,19.56M14.34,14H9.66C9.56,13.34 9.5,12.68 9.5,12C9.5,11.32 9.56,10.65 9.66,10H14.34C14.43,10.65 14.5,11.32 14.5,12C14.5,12.68 14.43,13.34 14.34,14M12,19.96C11.17,18.76 10.5,17.43 10.09,16H13.91C13.5,17.43 12.83,18.76 12,19.96M8,8H5.08C6.03,6.34 7.57,5.06 9.4,4.44C8.8,5.55 8.35,6.75 8,8M5.08,16H8C8.35,17.25 8.8,18.45 9.4,19.56C7.57,18.93 6.03,17.65 5.08,16M4.26,14C4.1,13.36 4,12.69 4,12C4,11.31 4.1,10.64 4.26,10H7.64C7.56,10.66 7.5,11.32 7.5,12C7.5,12.68 7.56,13.34 7.64,14M12,4.03C12.83,5.23 13.5,6.57 13.91,8H10.09C10.5,6.57 11.17,5.23 12,4.03M18.92,8H15.97C15.65,6.75 15.19,5.55 14.59,4.44C16.43,5.07 17.96,6.34 18.92,8M12,2C6.47,2 2,6.5 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
                  </svg>
                </div>
              </div>
              <div class="conversation-time">
                <Icon v-if="conversation.is_muted" name="bell-off" :size="12" class="muted-icon" />
                {{ formatMessageTime(conversation.last_activity || conversation.created_at) }}
              </div>
            </div>
            
            <div class="conversation-preview">
              <div v-if="liveCallIds.has(conversation.id)" class="last-message call-live" data-testid="dm-conversation-call">
                <Icon name="phone" :size="12" class="call-live-icon" />
                {{ $t('dm.callInProgress') }}
              </div>
              <div v-else class="last-message">
                {{ getLastMessagePreview(conversation) }}
              </div>
              <button
                v-if="liveCallIds.has(conversation.id) && joinedCallId !== conversation.id"
                class="conversation-join-call"
                type="button"
                data-testid="dm-conversation-join-call"
                :title="$t('dm.joinCall')"
                :aria-label="$t('dm.joinCall')"
                @click.stop="joinCallFromList(conversation.id)"
              >
                <Icon name="phone" :size="14" />
              </button>
              <div 
                v-if="conversation.unread_count && conversation.unread_count > 0"
                class="unread-count"
              >
                {{ conversation.unread_count > 99 ? '99+' : conversation.unread_count }}
              </div>
            </div>
          </div>

          <!-- Dismiss (hide from list without deleting). Appears on hover. -->
          <button
            class="conversation-dismiss"
            type="button"
            :title="$t('dm.dismissConversation')"
            :aria-label="$t('dm.dismissConversation')"
            @click.stop="dismissConversation(conversation)"
          >
            <Icon name="x" :size="14" />
          </button>
        </div>
      </div>
    </div>

    <!-- Group Chat Invite Modal -->
    <GroupChatInviteModal
      :show="showGroupChatModal"
      @close="showGroupChatModal = false"
      @conversation-created="handleGroupChatCreated"
    />
  </div>
</template>

<script setup lang="ts">
// TODO: Consider virtualizing conversation list for users with many DMs
import { ref, computed, onUnmounted, watch, nextTick } from 'vue'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useDMStore, type DMUser, type DMConversation } from '@/stores/useDM'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { useUserData } from '@/composables/useUserData'
import type { Message, MessagePart } from '@/types'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import GroupIcon from '@/components/common/GroupIcon.vue'
import GroupChatInviteModal from '@/components/dm/GroupChatInviteModal.vue'
import { dmCallSignaling } from '@/services/DMCallSignaling'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { dmConversationIdFromChannel } from '@/composables/useCallSwitch'
import { useDMCallJoin } from '@/composables/useDMCallJoin'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import { useI18n } from 'vue-i18n'
import { isUndecrypted } from '@/utils/channelEncryption'
import { pollPreview } from '@/utils/messagePoll'

const toast = useToast()
const { t } = useI18n()

const emit = defineEmits<{
  'conversationSelected': [conversationId: string]
}>()

const dmStore = useDMStore()
const activityPubStore = useActivityPubStore()

// Reactive computed to track blocked users count for change detection
const blockedUsersCount = computed(() => activityPubStore.blockedUsers.size)

// Use professional presence system
const { 
  getUserDisplayName, 
  getUserAvatarUrl, 
  getCurrentUser,
  // eslint-disable-next-line unused-imports/no-unused-vars
  subscribeToDMPresence,
  getPresenceAwareStatus
} = useUserData()

// State
const showUserSearch = ref(false)
const userSearchInputRef = ref<HTMLInputElement | null>(null)
watch(showUserSearch, async (open) => {
  if (!open) return
  await nextTick()
  userSearchInputRef.value?.focus()
})
const showGroupChatModal = ref(false)
const searchQuery = ref('')
const searchTimeout = ref<NodeJS.Timeout | null>(null)

// Computed
const sortedConversations = computed(() => dmStore.getSortedConversations)

const voiceStore = useUnifiedVoiceChannelStore()
const { joinConversationCall } = useDMCallJoin()

// Conversations with a live call: placed, ringing (a silenced ring included),
// or in progress. Reading callStateVersion establishes the reactive dependency.
const liveCallIds = computed(() => {
  dmCallSignaling.callStateVersion.value
  return new Set(sortedConversations.value.filter(c => dmCallSignaling.hasActiveCall(c.id)).map(c => c.id))
})

// Conversation whose call this client is in or joining.
const joinedCallId = computed(() => {
  if (!voiceStore.isConnectedOrJoining) return null
  const room = voiceStore.effectiveChannelId
  return room?.startsWith('federated-dm-')
    ? dmCallSignaling.conversationForRoom(room)
    : dmConversationIdFromChannel(room)
})

const joinCallFromList = async (conversationId: string) => {
  selectConversation(conversationId)
  await joinConversationCall(conversationId)
}

// Filter out blocked users from search results (uses store getter for reactivity)
const filteredSearchResults = computed(() => {
  // Access the count to ensure reactivity when blocked users change
  blockedUsersCount.value
  return dmStore.searchResults.filter(user => !activityPubStore.isBlocked(user.id))
})

// Helper functions for conversation display
const getConversationDisplayName = (conversation: DMConversation): string => {
  if (!conversation.other_user) return 'Unknown User'
  
  if (conversation.other_user._isPlaceholder) {
    return 'Loading...' // Show loading state for placeholder data
  }
  
  // Use the existing helper for loaded data
  return getUserDisplayName(conversation.other_user.id).value || conversation.other_user.display_name || conversation.other_user.username || 'Unknown User'
}

const getConversationAvatarUrl = (conversation: DMConversation): string => {
  if (!conversation.other_user) return ''
  
  if (conversation.other_user._isPlaceholder) {
    return '' // No avatar for placeholder data
  }
  
  // Use the existing helper for loaded data
  return getUserAvatarUrl(conversation.other_user.id).value || conversation.other_user.avatar_url || ''
}

const getUserStatus = (userId: string): 'online' | 'away' | 'busy' | 'offline' => {
  try {
    const status = getPresenceAwareStatus(userId).value;
    debug.log('DMSidebar - Status for user', userId, ':', status);
    // `getPresenceAwareStatus` may return 'invisible' too; the UI only renders
    // four states, so collapse 'invisible' to 'offline' for indicator color.
    return status === 'invisible' ? 'offline' : (status as 'online' | 'away' | 'busy' | 'offline');
  } catch (error) {
    debug.error('DMSidebar - Error getting status for user', userId, ':', error);
    return 'offline';
  }
}

const getConversationUserStatus = (conversation: DMConversation): 'online' | 'away' | 'busy' | 'offline' => {
  if (!conversation.other_user?.id) {
    debug.log('DMSidebar - No other_user.id for conversation:', conversation.id);
    return 'offline';
  }
  
  // Don't load presence for placeholder data
  if (conversation.other_user._isPlaceholder) {
    return 'offline';
  }
  
  return getUserStatus(conversation.other_user.id);
}

// Methods
const handleSearch = () => {
  if (searchTimeout.value) {
    clearTimeout(searchTimeout.value)
  }

  searchTimeout.value = setTimeout(() => {
    const currentUser = getCurrentUser.value
    if (searchQuery.value.trim() && currentUser?.id) {
      dmStore.searchUsers(searchQuery.value.trim(), currentUser.id)
    }
  }, 300)
}

const clearSearch = () => {
  searchQuery.value = ''
  dmStore.searchResults = []
}

const closeSearch = () => {
  showUserSearch.value = false
  clearSearch()
}

const startConversation = async (user: DMUser) => {
  const currentUser = getCurrentUser.value
  if (!currentUser?.id) return

  // Check if user is blocked - don't allow starting conversation with blocked users
  if (activityPubStore.isBlocked(user.id)) {
    debug.warn('Cannot start conversation with blocked user')
    return
  }

  const conversationId = await dmStore.createOrGetConversation(
    currentUser.id,
    user.id
  )

  if (conversationId) {
    selectConversation(conversationId)
    closeSearch()
  }
}

const selectConversation = (conversationId: string) => {
  cancelConversationPrefetch()
  emit('conversationSelected', conversationId)
}

const dismissConversation = async (conversation: DMConversation) => {
  const ok = await dmStore.hideConversation(conversation.id)
  if (ok) {
    toast.success(t('dm.conversationDismissed'))
  } else {
    toast.error(t('dm.failedToDismissConversation'))
  }
}

const handleGroupChatCreated = (conversationId: string) => {
  selectConversation(conversationId)
}

const stripShortcodes = (text: string): string => {
  if (!text) return text
  const stripped = text.replace(/:[a-zA-Z0-9_+-]+:/g, '').replace(/\s+/g, ' ').trim()
  return stripped || text
}

const getDefaultGroupName = (conversation: DMConversation): string => {
  if (conversation.participants && conversation.participants.length > 0) {
    const names = conversation.participants
      .slice(0, 3)
      .map(p => stripShortcodes(p.display_name || p.username))
      .join(', ')
    
    if (conversation.participants.length > 3) {
      return `${names}, and ${conversation.participants.length - 3} others`
    }
    return names
  }
  
  return `Group Chat (${conversation.participant_count || 0} members)`
}

const formatMessageTime = (timestamp: string): string => {
  const date = new Date(timestamp)
  const now = new Date()
  const diffInMinutes = Math.floor((now.getTime() - date.getTime()) / (1000 * 60))
  
  if (diffInMinutes < 1) return 'now'
  if (diffInMinutes < 60) return `${diffInMinutes}m`
  if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h`
  if (diffInMinutes < 10080) return `${Math.floor(diffInMinutes / 1440)}d`
  
  return date.toLocaleDateString()
}

const getLastMessagePreview = (conversation: DMConversation): string => {
  if (!conversation.last_message?.content) return 'No messages yet'
  
  try {
    const message = conversation.last_message
    const currentUser = getCurrentUser.value
    
    // Only show preview if the message is from the other user (not from current user)
    if (message.user_id === currentUser?.id) {
      return 'You: ' + getMessagePreviewText(message)
    }
    
    return getMessagePreviewText(message)
  } catch (error) {
    return 'Message'
  }
}

const getMessagePreviewText = (message: Message): string => {
  if (isUndecrypted(message)) return t('channelEncryption.encryptedMessage')
  const content = message.content as MessagePart[]
  if (!Array.isArray(content)) return 'No messages yet'
  const poll = pollPreview(content)
  if (poll) return poll.length > 50 ? poll.substring(0, 50) + '...' : poll
  
  // Extract text from message parts. After the type filter narrows to the
  // 'text' arm, `.text` is safe to read, but TypeScript's narrowing across
  // .filter+.map is not always tight enough; cast through `any`.
  const textParts = content
    .filter((part: any) => part.type === 'text')
    .map((part: any) => part.text)
    .join(' ')
  
  if (textParts) return textParts.length > 50 ? textParts.substring(0, 50) + '...' : textParts
  
  // Check for other content types
  const filePart = content.find(part => part.type === 'file')
  if (filePart) return 'File'
  
  const emojiPart = content.find(part => part.type === 'emoji')
  if (emojiPart) return 'Emoji'
  
  return 'Message'
}

// Same intent threshold as the server rail and channel list.
const CONVERSATION_PREFETCH_DELAY_MS = 100
let conversationPrefetchTimer: ReturnType<typeof setTimeout> | null = null

const cancelConversationPrefetch = () => {
  if (conversationPrefetchTimer) {
    clearTimeout(conversationPrefetchTimer)
    conversationPrefetchTimer = null
  }
}

/** Loads a hovered conversation's newest page into the DM message cache. */
const scheduleConversationPrefetch = (conversationId: string) => {
  cancelConversationPrefetch()
  if (conversationId === dmStore.currentConversationId) return
  conversationPrefetchTimer = setTimeout(() => {
    conversationPrefetchTimer = null
    void dmStore.prefetchConversationMessages(conversationId)
  }, CONVERSATION_PREFETCH_DELAY_MS)
}

// Lazy user profile loading
const hoveredConversations = ref(new Set<string>())

const handleConversationHover = async (conversationId: string) => {
  if (hoveredConversations.value.has(conversationId)) {
    return // Already loaded
  }
  
  hoveredConversations.value.add(conversationId)
  
  try {
    const success = await dmStore.loadConversationUserProfile(conversationId)
    
    if (success) {
      // Also load presence for this specific user if not already loaded
      const conversation = dmStore.conversations.find(c => c.id === conversationId)
      if (conversation?.other_user?.id && !conversation.other_user._isPlaceholder) {
        const { subscribeToDMPresence } = useUserData()
        await subscribeToDMPresence([conversation.other_user.id])
      }
    }
  } catch (error) {
    debug.error('Failed to load conversation profile on hover:', conversationId, error)
  }
}

// DM environment is initialized by BaseLayout; conversations stream into the
// store on their own. Profiles/presence load on-demand on hover.

onUnmounted(() => {
  cancelConversationPrefetch()
  if (searchTimeout.value) {
    clearTimeout(searchTimeout.value)
  }
})

// Removed automatic presence updates - now handled on-demand during hover
</script>

<style scoped>
/* Fill the parent (.dm-content) and become a flex column so the conversations
   list can scroll internally. Width/background/border are owned by the parent
   AdaptiveChannelSidebar now, so we only manage layout + height here.
   `min-height: 0` is required for the flex children to shrink and scroll. */
.dm-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.dm-header {
  height: 48px;
  box-sizing: border-box;
  padding: 0 16px;
  border-bottom: 1px solid var(--background-quaternary, var(--background-quinary));
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dm-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.new-dm-btn,
.group-chat-btn {
  width: 24px;
  height: 24px;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  padding: 2px;
  transition: all 0.15s ease;
}

.new-dm-btn:hover,
.group-chat-btn:hover {
  color: var(--text-primary);
  background: var(--background-quaternary, var(--background-quinary));
}

.icon {
  width: 100%;
  height: 100%;
}

.user-search-section {
  padding: 16px;
  border-bottom: 1px solid var(--background-quaternary, var(--background-quinary));
}

.search-input-container {
  position: relative;
  display: flex;
  align-items: center;
}

.search-input {
  width: 100%;
  padding: 8px 32px 8px 12px;
  background: var(--background-secondary);
  border: 1px solid var(--background-quaternary, var(--background-quinary));
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s ease;
}

.search-input:focus {
  border-color: var(--h-brand, var(--harmony-primary));
}

.search-input::placeholder {
  color: var(--text-muted);
}

.clear-search-btn {
  position: absolute;
  right: 8px;
  width: 16px;
  height: 16px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 2px;
  padding: 0;
  transition: color 0.15s ease;
}

.clear-search-btn:hover {
  color: var(--text-primary);
}

.search-results {
  margin-top: 8px;
  max-height: 200px;
  overflow-y: auto;
}

.search-loading,
.search-result-item {
  display: flex;
  align-items: center;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s ease;
  gap: 12px;
}

.search-result-item:hover {
  background: var(--background-quaternary, var(--background-quinary));
}

.conversations-section {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  padding: 40px 20px;
  color: var(--text-muted);
  gap: 12px;
}

.conversations-skeleton {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.conv-skeleton-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px;
}

.conv-skeleton-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--background-modifier-hover, rgba(255, 255, 255, 0.06));
  animation: convSkeletonPulse 1.4s ease-in-out infinite;
}

.conv-skeleton-lines {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.conv-skeleton-line {
  height: 10px;
  border-radius: 5px;
  background: var(--background-modifier-hover, rgba(255, 255, 255, 0.06));
  animation: convSkeletonPulse 1.4s ease-in-out infinite;
}

.conv-skeleton-line.dim {
  opacity: 0.6;
}

@keyframes convSkeletonPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

@media (prefers-reduced-motion: reduce) {
  .conv-skeleton-avatar,
  .conv-skeleton-line {
    animation: none;
  }
}

.conversations-list {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  /* Bottom strip reserved for the floating user panel, as in ChannelSidebar. */
  padding: 8px 0 96px;
}

.conversation-item {
  position: relative;
  display: flex;
  align-items: center;
  padding: 8px 16px;
  cursor: pointer;
  transition: background-color 0.15s ease;
  gap: 12px;
  border-radius: 0;
  margin: 0 8px;
  border-radius: 4px;
  min-width: 0;
  overflow: hidden;
}

.conversation-item:hover {
  background: var(--background-quaternary, var(--background-quinary));
}

/* Dismiss button - hidden until the row is hovered (or always shown on touch). */
.conversation-dismiss {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: var(--background-primary, rgba(0, 0, 0, 0.45));
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease;
}

.conversation-item:hover .conversation-dismiss {
  opacity: 1;
  pointer-events: auto;
}

.conversation-dismiss:hover {
  background: var(--error);
  color: var(--text-on-primary);
}

/* The dismiss button sits over the timestamp's corner. */
@media (hover: hover) {
  .conversation-item:hover .conversation-time {
    visibility: hidden;
  }
}

@media (hover: none) {
  .conversation-dismiss {
    opacity: 0.55;
    pointer-events: auto;
  }

  .conversation-time {
    margin-right: 22px;
  }
}

/* Same selection surface as the channel list. */
.conversation-item.active {
  background: var(--channel-item-selected-bg, var(--background-modifier-selected));
}

.conversation-item.unread {
  background: var(--background-modifier-hover);
}

.conversation-item.unread:hover {
  background: var(--background-quaternary, var(--background-quinary));
}

.conversation-item.muted {
  opacity: 0.5;
}

.conversation-item.muted:hover {
  opacity: 0.75;
}

/* A live call stays legible in a muted conversation: the ring was silenced, not the call. */
.conversation-item.muted.in-call {
  opacity: 1;
}

.conversation-item .conversation-preview .last-message.call-live {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--success);
  font-weight: 500;
}

.call-live-icon {
  flex-shrink: 0;
}

.conversation-join-call {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: 8px;
  padding: 0;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--success);
  color: var(--text-on-primary);
  cursor: pointer;
  transition: filter 0.12s ease;
}

.conversation-join-call:hover {
  filter: brightness(1.1);
}

.muted-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
  width: 12px;
  height: 12px;
}

.user-avatar,
.conversation-avatar {
  position: relative;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
}



.avatar-image {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.avatar-placeholder {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: var(--h-brand, var(--harmony-primary));
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: var(--text-on-primary);
  font-size: 14px;
}

.online-indicator {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  background: var(--status-online);
  border: 2px solid var(--h-channel-sidebar, var(--background-tertiary));
  border-radius: 50%;
}

.user-info,
.conversation-content {
  flex: 1;
  min-width: 0;
}

.user-name,
.conversation-name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 14px;
  margin-bottom: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}

.username {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conversation-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
  min-width: 0;
  overflow: hidden;
}

.conversation-time {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
  margin-left: 8px;
}

.conversation-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.last-message {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.conversation-item.unread .last-message {
  color: var(--text-primary);
  font-weight: 500;
}

.unread-count {
  background: var(--error);
  color: var(--text-on-primary);
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: var(--radius-full);
  min-width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: 8px;
  flex-shrink: 0;
}
.active .conversation-time,
.active .conversation-preview .last-message {
  color: color-mix(in srgb, var(--text-primary) 53%, transparent);
}

.user-name-container, .conversation-name-container {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.federated-indicator {
  display: flex;
  align-items: center;
  color: var(--text-secondary);
  opacity: 0.7;
  flex-shrink: 0;
  
  .icon {
    width: 14px;
    height: 14px;
  }
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .dm-sidebar {
    width: 100%;
    /* max-width: 360px;
    min-width: 320px;
    background: linear-gradient(135deg, var(--background-tertiary, #2b2d31) 0%, #252830 100%); */
  }

  /* Enhanced mobile touch targets */
  .dm-header {
    padding: 20px 16px;
    border-bottom: 1px solid color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  }

  .dm-title {
    font-size: 18px;
    font-weight: 700;
  }

  .new-dm-btn {
    width: 36px;
    height: 36px;
    border-radius: 12px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .new-dm-btn:active {
    transform: scale(0.95);
    background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  }

  .user-search-section {
    padding: 16px;
  }

  .search-input {
    font-size: 16px; /* Prevents zoom on iOS */
    padding: 14px 16px;
    border-radius: 12px;
    min-height: 48px;
  }

  .conversation-item {
    min-height: 64px;
    padding: 12px 16px;
    border-radius: 12px;
    margin: 4px 8px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .conversation-item:active {
    transform: scale(0.98);
    background: var(--background-modifier-active);
  }

  .conversation-join-call {
    width: 32px;
    height: 32px;
  }

  .user-avatar {
    width: 48px;
    height: 48px;
  }

  .conversation-info {
    gap: 8px;
  }

  .conversation-name {
    font-size: 16px;
    font-weight: 600;
  }

  .last-message {
    font-size: 14px;
    line-height: 1.4;
  }
}

@media (max-width: 480px) {
  .dm-sidebar {
    width: 100%;
    max-width: none;
  }
  
  .dm-header {
    padding: 16px;
  }
  
  .user-search-section {
    padding: 16px;
  }
  
  .conversation-item {
    min-height: 60px;
    padding: 10px 16px;
    margin: 2px 8px;
  }

  .user-avatar {
    width: 44px;
    height: 44px;
  }

  .conversation-name {
    font-size: 15px;
  }

  .last-message {
    font-size: 13px;
  }
}
</style>