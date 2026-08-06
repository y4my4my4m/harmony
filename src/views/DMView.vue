<template>
  <div class="dm-view">
    <div class="dm-header-container">
      <DMHeader
        v-if="currentConversation"
        :conversation="currentConversation"
        :is-mobile="isMobile"
        @toggle-left-sidebar="$emit('toggleLeftSidebar')"
        @toggle-voice-panel="$emit('toggleVoicePanel')"
        @add-user="showAddUserModal = true"
        @incoming-call="handleIncomingCall"
      />
      <div v-else class="dm-placeholder-header">
        <div class="header-content">
          <button 
            v-if="isMobile"
            class="mobile-menu-btn"
            @click="$emit('toggleLeftSidebar')"
          >
            <svg viewBox="0 0 24 24" class="menu-icon">
              <path d="M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z" fill="currentColor"/>
            </svg>
          </button>
          <h2>Direct Messages</h2>
        </div>
      </div>
    </div>

    <div v-if="showCallBanner" class="dm-call-banner">
      <div class="call-banner-content">
        <span class="call-banner-icon">
          <Icon name="phone" :size="16" />
        </span>
        <span class="call-banner-text">A call is in progress</span>
        <button class="call-banner-join" @click="joinCallFromBanner">
          Join Call
        </button>
      </div>
    </div>

    <div class="dm-content">
      <FollowersList
        v-if="!currentConversation"
        @conversation-started="handleConversationStarted"
      />
      
      <UnifiedContentArea
        v-else
        :mode="ViewMode.CHAT"
        :chat-messages="chatMessages"
        :is-loading="isLoading"
        :is-d-m="true"
        :conversation-id="currentConversation?.id"
        :dm-username="currentDMUsername"
        :view-type="ViewType.DM"
        current-view="dm"
        @load-more-messages="fetchMoreMessages"
        @update:is-at-bottom="isAtBottom = $event"
      />
    </div>

    <GroupChatInviteModal
      :show="showAddUserModal"
      :conversation-id="currentConversation?.id"
      :existing-participants="existingParticipants"
      @close="showAddUserModal = false"
      @users-added="handleUsersAdded"
      @conversation-created="handleConversationCreated"
    />
    
    <IncomingCallModal
      :show="showIncomingCallModal"
      :caller-id="incomingCall?.callerId || ''"
      :caller-name="getCallerName"
      :caller-avatar="getCallerAvatar"
      :call-type="incomingCall?.callType || 'voice'"
      :conversation-id="incomingCall?.conversationId || ''"
      @accept="handleAcceptCall"
      @decline="handleDeclineCall"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import Icon from '@/components/common/Icon.vue'
import DMHeader from '@/components/dm/DMHeader.vue'
import FollowersList from '@/components/dm/FollowersList.vue'
import GroupChatInviteModal from '@/components/dm/GroupChatInviteModal.vue'
import IncomingCallModal from '@/components/dm/IncomingCallModal.vue'
import { useDMStore } from '@/stores/useDM'
import { useLayoutState } from '@/composables/useLayoutState'
import { useUserData } from '@/composables/useUserData'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { dmCallSignaling } from '@/services/DMCallSignaling'
import { useViewContextTracking } from '@/composables/useViewContext'
import { useNotificationStore } from '@/stores/useNotification'
import { debug } from '@/utils/debug'
// `ChatComponent` owns the DM send + fallback flow so it can await the outcome
// before clearing the input. This file forwards notifications only.
import { ViewMode, ViewType } from '@/types/viewTypes'

interface Props {
  isDM: boolean
  conversationId?: string
}

// eslint-disable-next-line unused-imports/no-unused-vars
const props = defineProps<Props>()

// eslint-disable-next-line unused-imports/no-unused-vars
const emit = defineEmits<{
  toggleLeftSidebar: []
  toggleVoicePanel: []
}>()

const dmStore = useDMStore()
const voiceStore = useUnifiedVoiceChannelStore()
const route = useRoute()
const router = useRouter()

const { getCurrentUser, getUserDisplayName, getUserAvatarUrl } = useUserData()

const { isMobile } = useLayoutState()

const isLoading = ref(false)
const isAtBottom = ref(true)
const showAddUserModal = ref(false)

const showIncomingCallModal = ref(false)
const incomingCall = ref<{ callerId: string, callType: 'voice' | 'video', conversationId: string } | null>(null)

const toast = useToast()

// Reading callStateVersion establishes the reactive dependency for re-evaluation.
const showCallBanner = computed(() => {
  dmCallSignaling.callStateVersion.value
  if (!currentConversation.value) return false
  const hasActiveCall = dmCallSignaling.hasActiveCall(currentConversation.value.id)
  const dmChannelId = `dm-${currentConversation.value.id}`
  const isUserInCall = voiceStore.isConnected && voiceStore.currentChannelId === dmChannelId
  return hasActiveCall && !isUserInCall
})

const joinCallFromBanner = async () => {
  if (!currentConversation.value) return
  const dmChannelId = `dm-${currentConversation.value.id}`
  
  if (voiceStore.isConnected) {
    toast.error('You are already in a call')
    return
  }
  
  try {
    const { authContextService } = await import('@/services/AuthContextService')
    const profileId = await authContextService.getCurrentProfileId()
    await dmCallSignaling.joinCall(currentConversation.value.id, profileId)
    
    const success = await voiceStore.joinVoiceChannel(dmChannelId, 'dm')
    if (success) {
      toast.success('Joined call')
      voiceStore.isOverlayVisible = true
    } else {
      toast.error('Failed to join call')
    }
  } catch (error) {
    debug.error('Error joining call from banner:', error)
    toast.error('Failed to join call')
  }
}

const chatMessages = computed(() => dmStore.currentDMMessages)
const currentConversation = computed(() => dmStore.getCurrentConversation)

// The placeholder is plain text; shortcodes are stripped.
const stripShortcodes = (text: string): string => {
  if (!text) return text
  const stripped = text.replace(/:[a-zA-Z0-9_+-]+:/g, '').replace(/\s+/g, ' ').trim()
  return stripped || text
}

const currentDMUsername = computed(() => {
  const conversation = currentConversation.value
  if (!conversation) return undefined
  // `other_participants` is provided by the conversation payload at runtime but
  // isn't on the typed Conversation interface; cast to access it.
  const conv = conversation as any
  const otherUserId = conv.other_participants?.[0]?.id || conv.other_user?.id
  if (otherUserId) {
    const name = getUserDisplayName(otherUserId).value
    if (name && name !== 'Unknown User') return stripShortcodes(name)
  }
  const rawName = conv.other_participants?.[0]?.display_name || conv.other_participants?.[0]?.username || conv.other_user?.display_name || conv.other_user?.username
  return rawName ? stripShortcodes(rawName) : undefined
})

const existingParticipants = computed(() => {
  const conversation = currentConversation.value
  const currentUser = getCurrentUser.value
  
  if (!conversation?.other_user || !currentUser) return []
  
  // Participant data is derived from the conversation payload, not the
  // conversation_participants table.
  // `domain: null` plus optional fields don't match DMUser exactly; cast through any.
  const conv = conversation as any
  return [
    {
      id: currentUser.id,
      username: currentUser.username || '',
      display_name: currentUser.displayName,
      avatar_url: currentUser.avatarUrl,
      is_local: true,
      domain: null,
      handle: `@${currentUser.username}`
    },
    {
      id: conv.other_user.id,
      username: conv.other_user.username,
      display_name: conv.other_user.display_name,
      avatar_url: conv.other_user.avatar_url,
      is_local: conv.other_user.is_local || false,
      domain: conv.other_user.domain,
      handle: conv.other_user.handle
    }
  ] as any
})

const loadMessages = async () => {
  const conversationId = route.params.conversationId as string
  if (conversationId) {
    const currentUser = getCurrentUser.value
    
    if (dmStore.isCacheValid(conversationId)) {
      dmStore.loadCachedMessages(conversationId)
      // Still initialize conversation metadata in background
      if (currentUser?.id) {
        dmStore.initializeDMEnvironmentForDirectAccess(currentUser.id, conversationId)
        // Background refresh
        dmStore.fetchConversationMessages(conversationId)
      }
      return
    }
    
    // No cache - show skeleton loader
    isLoading.value = true
    dmStore.clearDMMessages()
    // Force browser to paint the skeleton before fetching
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    try {
      if (currentUser?.id) {
        const conversation = await dmStore.initializeDMEnvironmentForDirectAccess(currentUser.id, conversationId)
        
        if (conversation) {
          await dmStore.fetchConversationMessages(conversationId)
        }
      }
    } finally {
      isLoading.value = false
    }
  }
}

const fetchMoreMessages = async () => {
  const conversationId = route.params.conversationId as string
  if (conversationId && dmStore.currentDMMessages.length > 0) {
    const oldestMessage = dmStore.currentDMMessages[0]
    await dmStore.fetchConversationMessages(conversationId, oldestMessage.id)
  }
}


const handleUsersAdded = async (conversationId: string, _userIds: string[]) => {
  const currentUser = getCurrentUser.value
  if (currentUser?.id) {
    try {
      await dmStore.fetchConversationDetails(conversationId, currentUser.id)
      // Refetch to pick up the system message about added users.
      await dmStore.fetchConversationMessages(conversationId)
    } catch (error) {
      debug.error('Failed to refresh conversation after adding users:', error)
    }
  }
}

const handleConversationStarted = async (conversationId: string) => {
  // FollowersList performs the navigation.
  debug.log('Conversation started:', conversationId)
}

const handleConversationCreated = async (newConversationId: string) => {
  try {
    await router.push(`/dm/${newConversationId}`)
  } catch (error) {
    debug.error('Failed to navigate to new conversation:', error)
  }
}

const handleIncomingCall = (payload: { callerId: string, callType: 'voice' | 'video', conversationId: string }) => {
  // The modal is suppressed while already in a call.
  if (voiceStore.isConnected) return
  
  incomingCall.value = payload
  showIncomingCallModal.value = true
}

const handleAcceptCall = async (acceptWithVideo: boolean) => {
  if (!incomingCall.value) return

  // Snapshot before clearing; the IDs are needed after the modal is dismissed.
  const acceptedCall = incomingCall.value

  // Dismiss the modal and show the voice overlay before the join round-trip.
  // `voiceStore.isConnecting` drives the overlay's loading affordance, so the
  // UI does not sit on the "Incoming call" sheet for the duration.
  showIncomingCallModal.value = false
  incomingCall.value = null
  voiceStore.isOverlayVisible = true

  try {
    const { authContextService } = await import('@/services/AuthContextService')
    const profileId = await authContextService.getCurrentProfileId()
    if (!profileId) {
      voiceStore.isOverlayVisible = false
      toast.error('Authentication required')
      return
    }

    // Accept signal uses the profile ID to match leaveCall.
    await dmCallSignaling.acceptCall(acceptedCall.conversationId, profileId)

    const dmChannelId = `dm-${acceptedCall.conversationId}`
    const success = await voiceStore.joinVoiceChannel(dmChannelId, 'dm')

    if (success) {
      if (acceptWithVideo) {
        await voiceStore.toggleVideo()
      }
      toast.success('Joined call')
    } else {
      voiceStore.isOverlayVisible = false
      toast.error('Failed to join call')
    }
  } catch (error) {
    debug.error('Error accepting call:', error)
    voiceStore.isOverlayVisible = false
    toast.error('Failed to join call')
  }
}

const handleDeclineCall = async () => {
  if (!incomingCall.value) return
  
  try {
    const { authContextService } = await import('@/services/AuthContextService')
    const profileId = await authContextService.getCurrentProfileId()
    if (!profileId) return
    
    await dmCallSignaling.declineCall(incomingCall.value.conversationId, profileId)
    toast.info('Call declined')
  } catch (error) {
    debug.error('Error declining call:', error)
  } finally {
    showIncomingCallModal.value = false
    incomingCall.value = null
  }
}

const getCallerName = computed(() => {
  if (!incomingCall.value?.callerId) return 'Unknown'
  return getUserDisplayName(incomingCall.value.callerId).value || 'Unknown'
})

const getCallerAvatar = computed(() => {
  if (!incomingCall.value?.callerId) return '/default_avatar.webp'
  return getUserAvatarUrl(incomingCall.value.callerId).value || '/default_avatar.webp'
})

watch(() => route.params.conversationId, loadMessages, { immediate: true })

useViewContextTracking()

watch(() => route.query.messageId, async (messageId) => {
  if (messageId && typeof messageId === 'string') {
    await nextTick()
    await scrollToMessage(messageId)
  }
}, { immediate: true })

const scrollToMessage = async (messageId: string) => {
  await nextTick()
  
  // 300ms allows messages to render.
  await new Promise(resolve => setTimeout(resolve, 300))
  
  const messageElement = document.getElementById(`message-${messageId}`)
  if (messageElement) {
    const scrollContainer = messageElement.closest('.message-display') as HTMLElement
    if (scrollContainer) {
      const elementTop = messageElement.offsetTop
      const elementHeight = messageElement.offsetHeight
      const containerHeight = scrollContainer.clientHeight
      const scrollTop = elementTop - (containerHeight / 2) + (elementHeight / 2)
      
      // Smooth scroll without using scrollIntoView to avoid UI deformation
      scrollContainer.scrollTo({
        top: Math.max(0, scrollTop),
        behavior: 'smooth'
      })
    } else {
      messageElement.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'nearest', // Use 'nearest' instead of 'center' to minimize shifts
        inline: 'nearest'
      })
    }
    
    const notificationStore = useNotificationStore()
    const notification = notificationStore.notifications.find(n => 
      n.data?.message?.id === messageId || n.data?.message_id === messageId
    )
    if (notification) {
      await notificationStore.markAsRead(notification.id)
    }
    
    messageElement.classList.add('highlighted')
    setTimeout(() => {
      messageElement.classList.remove('highlighted')
    }, 3000)
    
    const searchQuery = route.query.searchQuery as string
    if (searchQuery) {
      highlightSearchText(messageElement, searchQuery)
    }
  } else {
    // Message not in DOM (virtualized) -- still mark notification as read
    const notificationStore = useNotificationStore()
    const notification = notificationStore.notifications.find(n => 
      (n.data?.message?.id === messageId || n.data?.message_id === messageId) && !n.is_read
    )
    if (notification) {
      await notificationStore.markAsRead(notification.id)
    }
  }
}

const highlightSearchText = (messageElement: HTMLElement, query: string) => {
  const contentElements = messageElement.querySelectorAll('.message-content, .result-content')
  const searchTerms = query.trim().split(/\s+/).filter(term => term.length > 0)
  
  contentElements.forEach(element => {
    searchTerms.forEach(term => {
      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null
      )
      
      const textNodes: Text[] = []
      let node
      while ((node = walker.nextNode())) {
        textNodes.push(node as Text)
      }
      
      textNodes.forEach(textNode => {
        const text = textNode.textContent || ''
        const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
        if (regex.test(text)) {
          const parent = textNode.parentNode
          if (parent && parent.nodeName !== 'MARK') {
            // Build the highlight wrapper with DOM APIs, not
            // `innerHTML = text.replace(...)`. `textNode.textContent` is the
            // decoded text: a DM containing `<style>foo</style>` was escaped by
            // the renderer to `&lt;style&gt;foo&lt;/style&gt;`, which reads back
            // as `<style>foo</style>` here. innerHTML would re-parse it as a
            // real <style> tag and reinstate the XSS the renderer blocked.
            const wrapper = document.createElement('span')
            let lastIndex = 0
            let match: RegExpExecArray | null
            regex.lastIndex = 0
            while ((match = regex.exec(text)) !== null) {
              if (match.index > lastIndex) {
                wrapper.appendChild(
                  document.createTextNode(text.slice(lastIndex, match.index)),
                )
              }
              const mark = document.createElement('mark')
              mark.className = 'search-highlight'
              mark.textContent = match[0]
              wrapper.appendChild(mark)
              lastIndex = match.index + match[0].length
              if (regex.lastIndex === match.index) regex.lastIndex++
            }
            if (lastIndex < text.length) {
              wrapper.appendChild(document.createTextNode(text.slice(lastIndex)))
            }
            parent.replaceChild(wrapper, textNode)

            setTimeout(() => {
              const marks = wrapper.querySelectorAll('mark.search-highlight')
              marks.forEach(mark => {
                const text = mark.textContent || ''
                const textNode = document.createTextNode(text)
                mark.parentNode?.replaceChild(textNode, mark)
              })
              if (wrapper.parentNode && wrapper.textContent) {
                const textNode = document.createTextNode(wrapper.textContent)
                wrapper.parentNode.replaceChild(textNode, wrapper)
              }
            }, 5000)
          }
        }
      })
    })
  })
}

// NOTE: DM initialization happens in two places:
// 1. BaseLayout (primary) - calls initializeDMEnvironmentForDirectAccess
// 2. loadMessages watcher (route-based) - handles direct URL access
// Request deduplication in useDM.ts prevents duplicate API calls. No fallback
// initialization exists here.
</script>

<style scoped>
.dm-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.dm-header-container {
  flex-shrink: 0;
}

.dm-placeholder-header {
  height: 48px;
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  padding: 0 16px;
}

.header-content {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
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

.dm-placeholder-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.dm-content {
  flex: 1;
  overflow: hidden;
}

.dm-call-banner {
  flex-shrink: 0;
  background: var(--accent-color, #0EA5E9);
  border-bottom: 1px solid rgba(0, 0, 0, 0.2);
}

.call-banner-content {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
}

.call-banner-icon {
  display: flex;
  align-items: center;
  animation: pulse-call 2s ease-in-out infinite;
}

@keyframes pulse-call {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.call-banner-text {
  flex: 1;
}

.call-banner-join {
  background: #fff;
  color: var(--accent-color, #0EA5E9);
  border: none;
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.call-banner-join:hover {
  opacity: 0.9;
}

@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
  }
}
</style>