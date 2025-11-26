<template>
  <!-- Chat Messages -->
  <UnifiedContentArea
    mode="chat"
    :chat-messages="chatMessages"
    :is-loading="isLoading"
    :is-d-m="isDM"
    :channel-id="props.isDM ? undefined : (route.params.channelId as string)"
    :conversation-id="props.isDM ? (route.params.conversationId as string) : undefined"
    view-type="chat"
    current-view="chat"
    @load-more-messages="fetchMoreMessages"
    @update:is-at-bottom="isAtBottom = $event"
    @send-message="handleSendMessage"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { debug } from '@/utils/debug'
import { useRoute } from 'vue-router'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'

import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useAuthStore } from '@/stores/auth'
import { useNotificationStore } from '@/stores/useNotification'
import { useViewContextTracking } from '@/composables/useViewContext'

// Props
interface Props {
  currentServer?: any
  currentChannel?: any
  isDM?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  isDM: false
})

// Emits
const emit = defineEmits<{
  sendMessage: [message: any]
  toggleLeftSidebar: []
  toggleVoicePanel: []
}>()

// Stores
const chatStore = useChatStore()
const dmStore = useDMStore()
const serverChannelStore = useServerChannelStore()
const authStore = useAuthStore()
const route = useRoute()

// State
const isAtBottom = ref(true)
const isLoading = ref(false)

// Computed
const chatMessages = computed(() => {
  return props.isDM ? dmStore.currentDMMessages : chatStore.messages
})

// Load messages when route changes
const loadMessages = async () => {
  if (props.isDM) {
    const conversationId = route.params.conversationId as string
    if (conversationId) {
      isLoading.value = true
      // Clear DM messages immediately when switching conversations
      dmStore.clearDMMessages()
      try {
        // Initialize DM environment for direct access if needed
        const userId = authStore.session?.user?.id
        if (userId) {
          await dmStore.initializeDMEnvironmentForDirectAccess(userId, conversationId)
          await dmStore.fetchConversationMessages(conversationId)
        }
      } finally {
        isLoading.value = false
      }
    }
  } else {
    const channelId = route.params.channelId as string
    const serverId = route.params.serverId as string
    
    if (serverId && channelId) {
      isLoading.value = true
      // Clear messages immediately when switching channels to show loading state
      chatStore.clearMessages()
      try {
        // Set current channel first to avoid race condition
        // Only set if it's different to prevent recursive triggers
        if (serverChannelStore.currentChannelId !== channelId) {
          serverChannelStore.setCurrentChannel(channelId)
        }
        await chatStore.fetchMessages(channelId)
        // Subscribe to real-time messages for this channel
        chatStore.subscribeToMessages(channelId)
      } finally {
        isLoading.value = false
      }
    }
  }
}

const fetchMoreMessages = async () => {
  debug.log('📜 fetchMoreMessages called, isDM:', props.isDM)
  
  if (props.isDM) {
    const conversationId = route.params.conversationId as string
    if (conversationId && dmStore.currentDMMessages.length > 0) {
      const oldestMessage = dmStore.currentDMMessages[0]
      debug.log('📜 Fetching older DM messages before:', oldestMessage.id)
      await dmStore.fetchConversationMessages(conversationId, oldestMessage.id)
    } else {
      debug.log('📜 Cannot fetch DM messages: no conversation or no messages yet')
    }
  } else {
    const channelId = route.params.channelId as string
    debug.log('📜 Current channel:', channelId, 'Message count:', chatStore.messages.length)
    debug.log('📜 allMessagesLoaded:', chatStore.allMessagesLoaded)
    debug.log('📜 loadingOlderMessages:', chatStore.loadingOlderMessages)
    
    if (chatStore.allMessagesLoaded) {
      debug.log('📜 All messages already loaded, not fetching more')
      return
    }
    
    if (chatStore.loadingOlderMessages) {
      debug.log('📜 Already loading older messages, skipping')
      return
    }
    
    if (channelId && chatStore.messages.length > 0) {
      const oldestMessage = chatStore.messages[0]
      debug.log('📜 Fetching older messages before message:', oldestMessage.id, oldestMessage.created_at)
      await chatStore.fetchMessages(channelId, oldestMessage.id)
    } else {
      debug.log('📜 Cannot fetch messages: no channel or no messages yet')
    }
  }
}

const handleSendMessage = (message: any) => {
  emit('sendMessage', message)
}

// Watch for route changes
watch(() => route.params, loadMessages, { immediate: true })

// Track view context in database for notification suppression
useViewContextTracking()

// Watch for messageId query param to scroll and highlight
watch(() => route.query.messageId, async (messageId) => {
  if (messageId && typeof messageId === 'string') {
    await nextTick()
    await scrollToMessage(messageId)
  }
}, { immediate: true })

// Function to scroll to and highlight a message
const scrollToMessage = async (messageId: string) => {
  await nextTick()
  
  // Wait a bit for messages to load
  await new Promise(resolve => setTimeout(resolve, 300))
  
  const messageElement = document.getElementById(`message-${messageId}`)
  if (messageElement) {
    // Get the scroll container (message display container)
    const scrollContainer = messageElement.closest('.message-display') as HTMLElement
    if (scrollContainer) {
      // Calculate scroll position without causing layout shifts
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
      // Fallback to scrollIntoView if container not found
      messageElement.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'nearest', // Use 'nearest' instead of 'center' to minimize shifts
        inline: 'nearest'
      })
    }
    
    // Mark notification as read
    const notificationStore = useNotificationStore()
    const notification = notificationStore.notifications.find(n => 
      n.data?.message?.id === messageId || n.data?.message_id === messageId
    )
    if (notification) {
      await notificationStore.markAsRead(notification.id)
    }
    
    // Highlight the message
    messageElement.classList.add('highlighted')
    setTimeout(() => {
      messageElement.classList.remove('highlighted')
    }, 3000)
    
    // Highlight search query text if available
    const searchQuery = route.query.searchQuery as string
    if (searchQuery) {
      highlightSearchText(messageElement, searchQuery)
    }
  } else {
    // Message not loaded yet, try to jump to it
    const searchQuery = route.query.searchQuery as string
    
    if (!props.isDM) {
      const channelId = route.params.channelId as string
      if (channelId) {
        const chatStore = useChatStore()
        await chatStore.jumpToMessage(messageId, channelId)
        // Retry after jump
        await nextTick()
        await new Promise(resolve => setTimeout(resolve, 500))
        const retryElement = document.getElementById(`message-${messageId}`)
        if (retryElement) {
          retryElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
          retryElement.classList.add('highlighted')
          setTimeout(() => retryElement.classList.remove('highlighted'), 3000)
          if (searchQuery) {
            highlightSearchText(retryElement, searchQuery)
          }
        }
      }
    } else {
      // For DMs, try to fetch the message if not loaded
      const conversationId = route.params.conversationId as string
      if (conversationId) {
        // Messages should already be loaded, but wait a bit more
        await new Promise(resolve => setTimeout(resolve, 500))
        const retryElement = document.getElementById(`message-${messageId}`)
        if (retryElement) {
          retryElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
          retryElement.classList.add('highlighted')
          setTimeout(() => retryElement.classList.remove('highlighted'), 3000)
          if (searchQuery) {
            highlightSearchText(retryElement, searchQuery)
          }
        }
      }
    }
  }
}

// Function to highlight search text within message content
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
      while (node = walker.nextNode()) {
        textNodes.push(node as Text)
      }
      
      textNodes.forEach(textNode => {
        const text = textNode.textContent || ''
        const regex = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
        if (regex.test(text)) {
          const parent = textNode.parentNode
          if (parent && parent.nodeName !== 'MARK') {
            const highlighted = text.replace(regex, '<mark class="search-highlight">$1</mark>')
            const wrapper = document.createElement('span')
            wrapper.innerHTML = highlighted
            parent.replaceChild(wrapper, textNode)
            
            // Remove highlight after 5 seconds
            setTimeout(() => {
              const marks = wrapper.querySelectorAll('mark.search-highlight')
              marks.forEach(mark => {
                const text = mark.textContent || ''
                const textNode = document.createTextNode(text)
                mark.parentNode?.replaceChild(textNode, mark)
              })
              // Clean up empty wrapper
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

// Remove onMounted since the watcher with immediate: true handles initial load
// onMounted(() => {
//   loadMessages()
// })
</script>

<style scoped>
.chat-view {
  height: 100%;
  display: flex;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}



.chat-messages-container {
  flex: 1;
  overflow: hidden;
}

/* Mobile styles */
@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
  }
}
</style>