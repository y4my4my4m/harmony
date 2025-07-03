<template>
  <div class="dm-view">
    <div v-if="!dmStore.currentConversationId" class="dm-home">
      <!-- DM Home Screen -->
      <div class="dm-home-content">
        <div class="dm-logo">
          <svg viewBox="0 0 24 24" class="logo-icon">
            <path d="M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2M4,4H20V16H5.17L4,17.17V4Z" fill="currentColor"/>
          </svg>
        </div>
        <h1 class="dm-title">Your Direct Messages</h1>
        <p class="dm-subtitle">
          Start a conversation with any member of your mutual servers, 
          or create a group DM for up to 10 friends.
        </p>
        
        <div class="dm-actions">
          <button class="action-btn primary" @click="openNewDM">
            <svg viewBox="0 0 24 24" class="btn-icon">
              <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
            </svg>
            Start Conversation
          </button>
        </div>

        <!-- Recent Conversations Preview -->
        <div v-if="recentConversations.length > 0" class="recent-conversations">
          <h3 class="section-title">Recent Conversations</h3>
          <div class="conversation-cards">
            <div
              v-for="conversation in recentConversations"
              :key="conversation.id"
              class="conversation-card"
              @click="selectConversation(conversation.id)"
            >
              <div class="card-avatar">
                <img 
                  :src="conversation.other_user?.avatar_url || '/default_avatar.png'" 
                  :alt="conversation.other_user?.display_name || conversation.other_user?.username"
                />
                <div 
                  class="status-dot"
                  :class="{ 'online': dmStore.isUserOnline(conversation.other_user?.id || '') }"
                ></div>
              </div>
              <div class="card-content">
                <h4 class="card-title">{{ conversation.other_user?.display_name || conversation.other_user?.username }}</h4>
                <p class="card-preview">{{ getLastMessagePreview(conversation.last_message) }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="dm-chat">
      <!-- DM Chat Header -->
      <div class="dm-chat-header">
        <div class="header-user-info">
          <div class="user-avatar-container">
            <img 
              :src="currentConversation?.other_user?.avatar_url || '/default_avatar.png'" 
              :alt="currentConversation?.other_user?.display_name || currentConversation?.other_user?.username"
              class="user-avatar"
            />
            <div 
              class="status-indicator"
              :class="{ 'online': dmStore.isUserOnline(currentConversation?.other_user?.id || '') }"
            ></div>
          </div>
          <div class="user-details">
            <h2 class="user-name">{{ currentConversation?.other_user?.display_name || currentConversation?.other_user?.username }}</h2>
            <p class="user-status">
              <span v-if="dmStore.isUserOnline(currentConversation?.other_user?.id || '')" class="status-text online">
                Online
              </span>
              <span v-else class="status-text offline">
                Offline
              </span>
            </p>
          </div>
        </div>

        <div class="header-actions">
          <button class="header-btn" title="Start voice call">
            <svg viewBox="0 0 24 24" class="btn-icon">
              <path d="M15.5,4A1.5,1.5 0 0,0 14,5.5A1.5,1.5 0 0,0 15.5,7A1.5,1.5 0 0,0 17,5.5A1.5,1.5 0 0,0 15.5,4M13,20A1,1 0 0,0 14,21H16A1,1 0 0,0 17,20V16.5L22.39,21.89C22.72,22.22 23.22,22.22 23.54,21.89C23.86,21.56 23.86,21.1 23.54,20.78L18,15.24V8A2,2 0 0,0 16,6H8A2,2 0 0,0 6,8V16A2,2 0 0,0 8,18H13V20Z" fill="currentColor"/>
            </svg>
          </button>
          <button class="header-btn" title="Start video call">
            <svg viewBox="0 0 24 24" class="btn-icon">
              <path d="M17,10.5V7A1,1 0 0,0 16,6H4A1,1 0 0,0 3,7V17A1,1 0 0,0 4,18H16A1,1 0 0,0 17,17V13.5L21,17.5V6.5L17,10.5Z" fill="currentColor"/>
            </svg>
          </button>
          <button class="header-btn" title="More options">
            <svg viewBox="0 0 24 24" class="btn-icon">
              <path d="M12,16A2,2 0 0,1 14,18A2,2 0 0,1 12,20A2,2 0 0,1 10,18A2,2 0 0,1 12,16M12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12A2,2 0 0,1 12,10M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8A2,2 0 0,1 10,6A2,2 0 0,1 12,4Z" fill="currentColor"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- DM Chat Content -->
      <div class="dm-chat-content">
        <ChatComponent
          :messages="dmStore.currentDMMessages"
          :isLoading="isLoadingMessages"
          @loadMoreMessages="loadMoreMessages"
          @sendMessage="sendMessage"
          :isDM="true"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useDMStore } from '@/stores/useDM'
import { useAuthStore } from '@/stores/auth'
import ChatComponent from '@/components/ChatComponent.vue'
import type { Message, MessagePart } from '@/types'

interface Props {
  conversationId?: string
}

const props = defineProps<Props>()

const router = useRouter()
const dmStore = useDMStore()
const authStore = useAuthStore()

const isLoadingMessages = ref(false)

// Computed properties
const currentConversation = computed(() => dmStore.getCurrentConversation)
const recentConversations = computed(() => dmStore.getSortedConversations.slice(0, 6))

// Methods
const openNewDM = () => {
  // This could emit an event to the parent to show user search
  // For now, we'll navigate to DM home and let the sidebar handle it
  router.push({ name: 'DMHome' })
}

const selectConversation = (conversationId: string) => {
  router.push({ name: 'DM', params: { conversationId } })
}

const loadMoreMessages = async () => {
  if (!dmStore.currentConversationId || isLoadingMessages.value) return
  
  try {
    isLoadingMessages.value = true
    const oldestMessage = dmStore.currentDMMessages[0]
    const oldestMessageId = oldestMessage?.id
    
    await dmStore.fetchConversationMessages(dmStore.currentConversationId, oldestMessageId)
  } catch (error) {
    console.error('Error loading more messages:', error)
  } finally {
    isLoadingMessages.value = false
  }
}

const sendMessage = async (content: MessagePart[], replyTo?: string) => {
  const currentUserId = authStore.session?.user?.id
  const conversationId = dmStore.currentConversationId
  
  if (!currentUserId || !conversationId) return

  try {
    const success = await dmStore.sendDMMessage(conversationId, currentUserId, content, replyTo)
    if (!success) {
      console.error('Failed to send DM message')
    }
  } catch (error) {
    console.error('Error sending DM message:', error)
  }
}

const getLastMessagePreview = (message?: Message): string => {
  if (!message?.content || !Array.isArray(message.content)) return 'Start a conversation'
  
  let preview = ''
  for (const part of message.content) {
    if (part.type === 'text') {
      preview += part.text
    } else if (part.type === 'emoji') {
      preview += `:${part.name}:`
    } else if (part.type === 'file') {
      preview += '[File]'
    }
  }
  
  return preview.length > 60 ? preview.substring(0, 60) + '...' : preview || 'Start a conversation'
}

// Watch for conversation changes
watch(
  () => props.conversationId,
  async (newConversationId) => {
    if (newConversationId) {
      dmStore.setCurrentConversation(newConversationId)
      
      // Load messages for the conversation
      try {
        isLoadingMessages.value = true
        dmStore.clearDMMessages()
        await dmStore.fetchConversationMessages(newConversationId)
      } catch (error) {
        console.error('Error loading conversation messages:', error)
      } finally {
        isLoadingMessages.value = false
      }
    } else {
      dmStore.setCurrentConversation(null)
      dmStore.clearDMMessages()
    }
  },
  { immediate: true }
)

// Initialize on mount
onMounted(async () => {
  const userId = authStore.session?.user?.id
  if (userId && !dmStore.conversations.length) {
    await dmStore.initializeDMEnvironment(userId)
  }
})
</script>

<style scoped>
.dm-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--h-chat);
}

/* DM Home Styles */
.dm-home {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
}

.dm-home-content {
  max-width: 600px;
  text-align: center;
}

.dm-logo {
  margin-bottom: 24px;
}

.logo-icon {
  width: 80px;
  height: 80px;
  color: #5865f2;
  opacity: 0.8;
}

.dm-title {
  font-size: 32px;
  font-weight: 700;
  color: #ffffff;
  margin: 0 0 16px 0;
  line-height: 1.2;
}

.dm-subtitle {
  font-size: 16px;
  color: #b9bbbe;
  margin: 0 0 32px 0;
  line-height: 1.4;
}

.dm-actions {
  margin-bottom: 48px;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: #5865f2;
  color: #ffffff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.action-btn:hover {
  background: #4752c4;
  transform: translateY(-1px);
}

.btn-icon {
  width: 16px;
  height: 16px;
}

.recent-conversations {
  text-align: left;
}

.section-title {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 16px 0;
}

.conversation-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
}

.conversation-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--h-sidebar);
  border: 1px solid var(--h-chat-light);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.conversation-card:hover {
  background: var(--h-chat-light);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.card-avatar {
  position: relative;
  flex-shrink: 0;
}

.card-avatar img {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
}

.status-dot {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #747f8d;
  border: 3px solid var(--h-sidebar);
}

.status-dot.online {
  background: #3ba55c;
}

.card-content {
  flex: 1;
  min-width: 0;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 4px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-preview {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* DM Chat Styles */
.dm-chat {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.dm-chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--h-chat);
  border-bottom: 1px solid var(--h-chat-light);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.header-user-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-avatar-container {
  position: relative;
  flex-shrink: 0;
}

.user-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
}

.status-indicator {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #747f8d;
  border: 3px solid var(--h-chat);
}

.status-indicator.online {
  background: #3ba55c;
}

.user-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.user-name {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
  margin: 0;
  line-height: 1.2;
}

.user-status {
  margin: 0;
}

.status-text {
  font-size: 12px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.status-text.online {
  color: #3ba55c;
}

.status-text.offline {
  color: #747f8d;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-btn {
  width: 36px;
  height: 36px;
  background: none;
  border: none;
  border-radius: 6px;
  color: #b9bbbe;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.header-btn:hover {
  background: var(--h-chat-light);
  color: #ffffff;
}

.header-btn .btn-icon {
  width: 20px;
  height: 20px;
}

.dm-chat-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .dm-home {
    padding: 20px;
  }
  
  .dm-title {
    font-size: 24px;
  }
  
  .dm-subtitle {
    font-size: 14px;
  }
  
  .conversation-cards {
    grid-template-columns: 1fr;
  }
  
  .dm-chat-header {
    padding: 8px 12px;
  }
  
  .user-name {
    font-size: 16px;
  }
  
  .header-actions {
    gap: 4px;
  }
  
  .header-btn {
    width: 32px;
    height: 32px;
  }
  
  .header-btn .btn-icon {
    width: 18px;
    height: 18px;
  }
}

@media (max-width: 480px) {
  .dm-home-content {
    max-width: 100%;
  }
  
  .conversation-card {
    padding: 12px;
    gap: 12px;
  }
  
  .card-avatar img {
    width: 40px;
    height: 40px;
  }
  
  .status-dot {
    width: 12px;
    height: 12px;
    border-width: 2px;
  }
}
</style>