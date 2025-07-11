<template>
  <div class="chat-view">
    <!-- Chat Header -->
    <div class="chat-header-container">
      <ChatHeader
        v-if="currentChannel"
        :channel="currentChannel"
        :server="currentServer"
        :is-mobile="isMobile"
        @toggle-left-sidebar="$emit('toggleLeftSidebar')"
        @toggle-voice-panel="$emit('toggleVoicePanel')"
      />
      <div v-else class="chat-placeholder-header">
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
          <h2>{{ currentServer?.name || 'Chat' }}</h2>
        </div>
      </div>
    </div>

    <!-- Chat Messages -->
    <div class="chat-messages-container">
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import UnifiedContentArea from '@/components/common/UnifiedContentArea.vue'
import ChatHeader from '@/components/chat/ChatHeader.vue'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useAuthStore } from '@/stores/auth'
import { useLayoutState } from '@/composables/useLayoutState'

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

// Layout state
const { isMobile } = useLayoutState()

// State
const isAtBottom = ref(true)
const isLoading = ref(false)

// Computed
const chatMessages = computed(() => {
  return props.isDM ? dmStore.currentDMMessages : chatStore.messages
})

const currentServer = computed(() => serverChannelStore.currentServer)
const currentChannel = computed(() => {
  const channelId = route.params.channelId as string
  return serverChannelStore.channels.find(c => c.id === channelId) || null
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
        await chatStore.fetchMessages(channelId)
        serverChannelStore.setCurrentChannel(channelId)
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

onMounted(() => {
  loadMessages()
})
</script>

<style scoped>
.chat-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-header-container {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
}

.chat-placeholder-header {
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

.chat-placeholder-header h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
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