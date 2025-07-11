<template>
  <div class="dm-view">
    <!-- DM Header -->
    <div class="dm-header-container">
      <DMHeader
        v-if="currentConversation"
        :conversation="currentConversation"
        :is-mobile="isMobile"
        @toggle-left-sidebar="$emit('toggleLeftSidebar')"
        @toggle-voice-panel="$emit('toggleVoicePanel')"
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

    <!-- DM Content -->
    <div class="dm-content">
      <UnifiedContentArea
        mode="chat"
        :chat-messages="chatMessages"
        :is-loading="isLoading"
        :is-d-m="true"
        view-type="dm"
        current-view="dm"
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
import DMHeader from '@/components/dm/DMHeader.vue'
import { useDMStore } from '@/stores/useDM'
import { useAuthStore } from '@/stores/auth'
import { useLayoutState } from '@/composables/useLayoutState'
import type { MessagePart } from '@/types'

// Props
interface Props {
  isDM: boolean
  conversationId?: string
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  toggleLeftSidebar: []
  toggleVoicePanel: []
  sendMessage: [message: any]
}>()

// Stores
const dmStore = useDMStore()
const authStore = useAuthStore()
const route = useRoute()

// Layout state
const { isMobile } = useLayoutState()

// State
const isLoading = ref(false)
const isAtBottom = ref(true)

// Computed
const chatMessages = computed(() => dmStore.currentDMMessages)
const currentConversation = computed(() => dmStore.getCurrentConversation)

// Load messages when route changes
const loadMessages = async () => {
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
}

const fetchMoreMessages = async () => {
  const conversationId = route.params.conversationId as string
  if (conversationId && dmStore.currentDMMessages.length > 0) {
    const oldestMessage = dmStore.currentDMMessages[0]
    await dmStore.fetchConversationMessages(conversationId, oldestMessage.id)
  }
}

const handleSendMessage = async (content: MessagePart[], replyTo?: string) => {
  const conversationId = route.params.conversationId as string
  const userId = authStore.session?.user?.id
  
  if (conversationId && userId) {
    const success = await dmStore.sendDMMessage(conversationId, userId, content, replyTo)
    if (success) {
      emit('sendMessage', { content, replyTo })
    }
  }
}

// Watch for conversation changes
watch(() => route.params.conversationId, loadMessages, { immediate: true })

// Initialize DM environment on mount
onMounted(async () => {
  const userId = authStore.session?.user?.id
  if (userId) {
    await dmStore.initializeDMEnvironment(userId)
  }
})
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
  border-bottom: 1px solid var(--border-color);
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

/* Mobile styles */
@media (max-width: 768px) {
  .mobile-menu-btn {
    display: flex;
  }
}
</style>