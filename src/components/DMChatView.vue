<template>
  <div class="dm-chat-view">
    <!-- Chat Header -->
    <div class="dm-chat-header">
      <div class="user-info">
        <div class="user-avatar">
          <img 
            v-if="otherUser?.avatar_url" 
            :src="otherUser.avatar_url" 
            :alt="otherUser.display_name || otherUser.username"
            class="avatar-image"
          />
          <div v-else class="avatar-placeholder">
            {{ getInitial(otherUser) }}
          </div>
          <div v-if="otherUser?.is_online" class="online-indicator"></div>
        </div>
        <div class="user-details">
          <h2 class="user-name">{{ otherUser?.display_name || otherUser?.username }}</h2>
          <div class="user-status">
            <span v-if="otherUser?.is_online" class="status-text online">Online</span>
            <span v-else class="status-text offline">Offline</span>
          </div>
        </div>
      </div>
      
      <div class="header-actions">
        <button class="action-btn" title="Voice Call" disabled>
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M6.62,10.79C8.06,13.62 10.38,15.94 13.21,17.38L15.41,15.18C15.69,14.9 16.08,14.82 16.43,14.93C17.55,15.3 18.75,15.5 20,15.5A1,1 0 0,1 21,16.5V20A1,1 0 0,1 20,21A17,17 0 0,1 3,4A1,1 0 0,1 4,3H7.5A1,1 0 0,1 8.5,4C8.5,5.25 8.7,6.45 9.07,7.57C9.18,7.92 9.1,8.31 8.82,8.59L6.62,10.79Z" fill="currentColor"/>
          </svg>
        </button>
        
        <button class="action-btn" title="Video Call" disabled>
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M17,10.5V7A1,1 0 0,0 16,6H4A1,1 0 0,0 3,7V17A1,1 0 0,0 4,18H16A1,1 0 0,0 17,17V13.5L21,17.5V6.5L17,10.5Z" fill="currentColor"/>
          </svg>
        </button>
        
        <button class="action-btn" title="More Options">
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M12,16A2,2 0 0,1 14,18A2,2 0 0,1 12,20A2,2 0 0,1 10,18A2,2 0 0,1 12,16M12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12A2,2 0 0,1 12,10M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8A2,2 0 0,1 10,6A2,2 0 0,1 12,4Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Messages Area -->
    <div class="messages-container">
      <div v-if="dmStore.loadingMessages" class="loading-state">
        <div class="loading-spinner"></div>
        <span>Loading messages...</span>
      </div>
      
      <div v-else-if="dmStore.currentDMMessages.length === 0" class="empty-messages-state">
        <div class="empty-icon">
          <div class="user-avatar large">
            <img 
              v-if="otherUser?.avatar_url" 
              :src="otherUser.avatar_url" 
              :alt="otherUser.display_name || otherUser.username"
              class="avatar-image"
            />
            <div v-else class="avatar-placeholder">
              {{ getInitial(otherUser) }}
            </div>
          </div>
        </div>
        <h3>This is the beginning of your direct message history with {{ otherUser?.display_name || otherUser?.username }}</h3>
        <p>Say hello! 👋</p>
      </div>

      <div v-else class="messages-list" ref="messagesContainer">
        <DMMessageDisplay
          v-for="message in dmStore.currentDMMessages"
          :key="message.id"
          :message="message"
          :show-avatar="shouldShowAvatar(message)"
          :is-continuation="isContinuation(message)"
          @reply="handleReply"
        />
      </div>
    </div>

    <!-- Message Input -->
    <div class="message-input-section">
      <DMMessageInput
        :conversation-id="conversationId"
        :other-user="otherUser"
        :reply-to="replyToMessage"
        @message-sent="handleMessageSent"
        @clear-reply="clearReply"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useDMStore, type DMUser } from '@/stores/useDM'
import { useAuthStore } from '@/stores/auth'
import type { Message } from '@/types'
import DMMessageDisplay from './DMMessageDisplay.vue'
import DMMessageInput from './DMMessageInput.vue'

interface Props {
  conversationId: string
}

const props = defineProps<Props>()

const dmStore = useDMStore()
const authStore = useAuthStore()

// State
const messagesContainer = ref<HTMLElement>()
const replyToMessage = ref<Message | null>(null)

// Computed
const currentConversation = computed(() => dmStore.getCurrentConversation)
const otherUser = computed(() => currentConversation.value?.other_user)

// Methods
const getInitial = (user?: DMUser): string => {
  if (!user) return '?'
  return (user.display_name || user.username).charAt(0).toUpperCase()
}

const shouldShowAvatar = (message: Message): boolean => {
  const messages = dmStore.currentDMMessages
  const currentIndex = messages.findIndex(m => m.id === message.id)
  
  if (currentIndex === 0) return true
  
  const prevMessage = messages[currentIndex - 1]
  if (!prevMessage) return true
  
  // Show avatar if different user or more than 5 minutes apart
  if (prevMessage.user_id !== message.user_id) return true
  
  const timeDiff = new Date(message.created_at).getTime() - new Date(prevMessage.created_at).getTime()
  return timeDiff > 5 * 60 * 1000 // 5 minutes
}

const isContinuation = (message: Message): boolean => {
  const messages = dmStore.currentDMMessages
  const currentIndex = messages.findIndex(m => m.id === message.id)
  
  if (currentIndex === 0) return false
  
  const prevMessage = messages[currentIndex - 1]
  if (!prevMessage || prevMessage.user_id !== message.user_id) return false
  
  const timeDiff = new Date(message.created_at).getTime() - new Date(prevMessage.created_at).getTime()
  return timeDiff <= 5 * 60 * 1000 // 5 minutes
}

const handleReply = (message: Message) => {
  replyToMessage.value = message
}

const clearReply = () => {
  replyToMessage.value = null
}

const handleMessageSent = () => {
  clearReply()
  scrollToBottom()
}

const scrollToBottom = () => {
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
    }
  })
}

// Watchers
watch(() => props.conversationId, async (newConversationId) => {
  if (newConversationId) {
    dmStore.setCurrentConversation(newConversationId)
    dmStore.clearDMMessages()
    await dmStore.fetchConversationMessages(newConversationId)
    scrollToBottom()
  }
}, { immediate: true })

watch(() => dmStore.currentDMMessages.length, () => {
  // Auto-scroll to bottom when new messages arrive
  nextTick(() => {
    if (messagesContainer.value) {
      const { scrollTop, scrollHeight, clientHeight } = messagesContainer.value
      const isNearBottom = scrollTop + clientHeight >= scrollHeight - 100
      
      if (isNearBottom) {
        scrollToBottom()
      }
    }
  })
})

// Lifecycle
onMounted(() => {
  scrollToBottom()
})
</script>

<style scoped>
.dm-chat-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--h-chat, #36393f);
  flex: 1;
}

.dm-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--h-chat-light, #40444b);
  background: var(--h-chat, #36393f);
  min-height: 48px;
  box-shadow: 0 1px 0 rgba(4, 4, 5, 0.2), 0 1.5px 0 rgba(6, 6, 7, 0.05), 0 2px 0 rgba(4, 4, 5, 0.05);
}

.user-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-avatar {
  position: relative;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
}

.user-avatar.large {
  width: 80px;
  height: 80px;
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
  background: var(--h-brand, #5865f2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  color: #ffffff;
  font-size: 14px;
}

.user-avatar.large .avatar-placeholder {
  font-size: 32px;
}

.online-indicator {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 12px;
  height: 12px;
  background: #3ba55c;
  border: 2px solid var(--h-chat, #36393f);
  border-radius: 50%;
}

.user-details {
  flex: 1;
  min-width: 0;
}

.user-name {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 2px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user-status {
  display: flex;
  align-items: center;
  gap: 4px;
}

.status-text {
  font-size: 12px;
  font-weight: 500;
}

.status-text.online {
  color: #3ba55c;
}

.status-text.offline {
  color: #72767d;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-btn {
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  color: #b9bbbe;
  cursor: pointer;
  border-radius: 4px;
  padding: 6px;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.action-btn:hover:not(:disabled) {
  color: #ffffff;
  background: var(--h-chat-light, #40444b);
}

.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.icon {
  width: 20px;
  height: 20px;
}

.messages-container {
  flex: 1;
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
  color: #72767d;
  gap: 12px;
  flex: 1;
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--h-chat-light, #40444b);
  border-top: 2px solid var(--h-brand, #5865f2);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.empty-messages-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  color: #72767d;
  flex: 1;
}

.empty-icon {
  margin-bottom: 24px;
}

.empty-messages-state h3 {
  margin: 0 0 8px 0;
  font-size: 20px;
  color: #ffffff;
  font-weight: 600;
  line-height: 1.4;
  max-width: 480px;
}

.empty-messages-state p {
  margin: 0;
  font-size: 16px;
  line-height: 1.4;
}

.messages-list {
  flex: 1;
  overflow-y: auto;
  padding: 16px 0;
  scroll-behavior: smooth;
}

.message-input-section {
  padding: 16px;
  background: var(--h-chat, #36393f);
  border-top: 1px solid var(--h-chat-light, #40444b);
}

/* Custom scrollbar */
.messages-list::-webkit-scrollbar {
  width: 14px;
}

.messages-list::-webkit-scrollbar-thumb {
  background-color: var(--h-chat-light, #40444b);
  border: 3px solid var(--h-chat, #36393f);
  border-radius: 7px;
}

.messages-list::-webkit-scrollbar-thumb:hover {
  background-color: #5c6168;
}

.messages-list::-webkit-scrollbar-track {
  background: transparent;
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .dm-chat-header {
    padding: 8px 12px;
  }
  
  .user-name {
    font-size: 14px;
  }
  
  .header-actions {
    gap: 4px;
  }
  
  .action-btn {
    width: 28px;
    height: 28px;
    padding: 4px;
  }
  
  .icon {
    width: 16px;
    height: 16px;
  }
  
  .message-input-section {
    padding: 12px;
  }
  
  .empty-messages-state h3 {
    font-size: 18px;
  }
  
  .empty-messages-state p {
    font-size: 14px;
  }
}

@media (max-width: 480px) {
  .dm-chat-header {
    padding: 8px;
  }
  
  .user-info {
    gap: 8px;
  }
  
  .user-avatar {
    width: 28px;
    height: 28px;
  }
  
  .user-name {
    font-size: 14px;
  }
  
  .status-text {
    font-size: 11px;
  }
  
  .messages-list {
    padding: 12px 0;
  }
}
</style>