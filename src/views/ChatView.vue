<template>
  <!-- Chat Messages -->
  <UnifiedContentArea
    mode="chat"
    :chat-messages="chatMessages"
    :is-loading="isLoading"
    :is-d-m="isDM"
    view-type="chat"
    current-view="chat"
    @load-more-messages="fetchMoreMessages"
    @update:is-at-bottom="isAtBottom = $event"
    @send-message="handleSendMessage"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'

import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useAuthStore } from '@/stores/auth'

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
  if (props.isDM) {
    const conversationId = route.params.conversationId as string
    if (conversationId && dmStore.currentDMMessages.length > 0) {
      const oldestMessage = dmStore.currentDMMessages[0]
      await dmStore.fetchConversationMessages(conversationId, oldestMessage.id)
    }
  } else {
    const channelId = route.params.channelId as string
    if (channelId && chatStore.messages.length > 0) {
      const oldestMessage = chatStore.messages[0]
      await chatStore.fetchMessages(channelId, oldestMessage.id)
    }
  }
}

const handleSendMessage = (message: any) => {
  emit('sendMessage', message)
}

// Watch for route changes
watch(() => route.params, loadMessages, { immediate: true })

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