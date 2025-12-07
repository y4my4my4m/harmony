<template>
  <div class="thread-full-view">
    <!-- Thread Header -->
    <div class="thread-header">
      <button class="back-btn" @click="goBack" title="Back to channel">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
      </button>
      <div class="header-info">
        <h2 class="thread-title">{{ thread?.name || 'Thread' }}</h2>
        <span class="thread-channel" @click="goToChannel">
          <span class="hash">#</span>{{ thread?.channel_name || 'channel' }}
        </span>
      </div>
      <div class="header-actions">
        <span class="member-count" v-if="thread?.member_count">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
          </svg>
          {{ thread?.member_count }}
        </span>
        <button class="options-btn" @click="showOptions = !showOptions" title="Thread options">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="5" r="2"/>
            <circle cx="12" cy="12" r="2"/>
            <circle cx="12" cy="19" r="2"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Options Dropdown -->
    <div v-if="showOptions" class="options-dropdown" v-click-outside="() => showOptions = false">
      <button v-if="!isMember" @click="joinThread" class="option-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="8.5" cy="7" r="4"/>
          <line x1="20" y1="8" x2="20" y2="14"/>
          <line x1="23" y1="11" x2="17" y2="11"/>
        </svg>
        Join Thread
      </button>
      <button v-if="isMember" @click="leaveThread" class="option-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        Leave Thread
      </button>
      <button @click="toggleNotifications" class="option-item">
        <svg v-if="isMuted" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
        </svg>
        {{ isMuted ? 'Unmute Thread' : 'Mute Thread' }}
      </button>
    </div>

    <!-- Parent Message (Starter Message) -->
    <div class="parent-message-section" v-if="thread?.parent_message">
      <div class="section-label">Original Message</div>
      <div class="parent-message">
        <Avatar 
          :src="getAvatarUrl(thread.parent_message.user_id).value" 
          :alt="getDisplayName(thread.parent_message.user_id).value"
          size="md"
          :interactive="true"
        />
        <div class="message-content">
          <div class="message-header">
            <span class="username" :style="{ color: getColor(thread.parent_message.user_id).value }">
              {{ getDisplayName(thread.parent_message.user_id).value }}
            </span>
            <span class="timestamp">{{ formatDate(thread.parent_message.created_at) }}</span>
          </div>
          <div class="message-body">
            <UnifiedMessageContent
              :content="thread.parent_message.content"
              :message-id="thread.parent_message.id"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Thread Messages -->
    <div class="messages-section" ref="messagesContainer" @scroll="handleScroll">
      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <span>Loading messages...</span>
      </div>

      <button v-if="hasMore && !loading" class="load-more-btn" @click="loadMore">
        Load older messages
      </button>

      <div v-if="!loading && messages.length === 0" class="empty-state">
        <div class="empty-icon">💬</div>
        <h3>No messages yet</h3>
        <p>Be the first to reply in this thread!</p>
      </div>

      <!-- Messages List -->
      <div 
        v-for="(message, index) in messages" 
        :key="message.id" 
        class="message-wrapper"
        :class="{ 'compact': !shouldShowHeader(message, index) }"
      >
        <template v-if="shouldShowHeader(message, index)">
          <Avatar 
            :src="getAvatarUrl(message.user_id).value" 
            :alt="getDisplayName(message.user_id).value"
            size="sm"
            :interactive="true"
          />
          <div class="message-main">
            <div class="message-header">
              <span class="username" :style="{ color: getColor(message.user_id).value }">
                {{ getDisplayName(message.user_id).value }}
              </span>
              <span class="timestamp">{{ formatTimestamp(message.created_at) }}</span>
            </div>
            <div class="message-body">
              <UnifiedMessageContent
                :content="message.content"
                :message-id="message.id"
              />
            </div>
          </div>
        </template>
        <template v-else>
          <span class="compact-time">{{ formatTime(message.created_at) }}</span>
          <div class="message-body">
            <UnifiedMessageContent
              :content="message.content"
              :message-id="message.id"
            />
          </div>
        </template>
      </div>
    </div>

    <!-- Message Input -->
    <div class="message-input-section">
      <div class="input-wrapper">
        <button class="attach-btn" title="Attach file">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>
          </svg>
        </button>
        <textarea
          ref="inputRef"
          v-model="messageText"
          :placeholder="`Reply to thread...`"
          @keydown.enter.exact.prevent="sendMessage"
          @input="handleInput"
          rows="1"
        />
        <button 
          class="send-btn" 
          :disabled="!messageText.trim() || sending"
          @click="sendMessage"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { threadService } from '@/services/ThreadService'
import { useUserData } from '@/composables/useUserData'
import { format, isSameDay, differenceInMinutes } from 'date-fns'
import Avatar from '@/components/common/Avatar.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import type { Message } from '@/types'
import type { ThreadWithDetails } from '@/services/ThreadService'

// Props
interface Props {
  serverId: string
  threadId: string
}

const props = defineProps<Props>()
const route = useRoute()
const router = useRouter()

const { 
  getUserDisplayName: getDisplayName, 
  getUserColor: getColor,
  getUserAvatarUrl: getAvatarUrl 
} = useUserData()

// State
const thread = ref<ThreadWithDetails | null>(null)
const messages = ref<Message[]>([])
const loading = ref(true)
const loadingMore = ref(false)
const hasMore = ref(false)
const isMember = ref(true)
const isMuted = ref(false)
const showOptions = ref(false)
const messageText = ref('')
const sending = ref(false)
const messagesContainer = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)

// Format helpers
const formatDate = (date: string | Date) => {
  return format(new Date(date), 'MMM d, yyyy \'at\' h:mm a')
}

const formatTimestamp = (date: string | Date) => {
  const d = new Date(date)
  const now = new Date()
  
  if (isSameDay(d, now)) {
    return `Today at ${format(d, 'h:mm a')}`
  }
  
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (isSameDay(d, yesterday)) {
    return `Yesterday at ${format(d, 'h:mm a')}`
  }
  
  return format(d, 'MM/dd/yyyy h:mm a')
}

const formatTime = (date: string | Date) => {
  return format(new Date(date), 'h:mm a')
}

// Message grouping
const shouldShowHeader = (message: Message, index: number): boolean => {
  if (index === 0) return true
  const prev = messages.value[index - 1]
  if (!prev) return true
  if (message.user_id !== prev.user_id) return true
  if (differenceInMinutes(new Date(message.created_at), new Date(prev.created_at)) > 7) return true
  if (!isSameDay(new Date(message.created_at), new Date(prev.created_at))) return true
  return false
}

// Load thread
const loadThread = async () => {
  loading.value = true
  try {
    thread.value = await threadService.getThread(props.threadId, true)
    isMember.value = thread.value?.is_member ?? true
    
    if (thread.value) {
      const result = await threadService.getThreadMessages(thread.value.id)
      messages.value = result.messages
      hasMore.value = result.has_more
      
      await nextTick()
      scrollToBottom()
    }
  } catch (error) {
    console.error('Failed to load thread:', error)
  } finally {
    loading.value = false
  }
}

const loadMore = async () => {
  if (!thread.value || loadingMore.value) return
  
  const oldest = messages.value[0]
  if (!oldest) return
  
  loadingMore.value = true
  try {
    const result = await threadService.getThreadMessages(thread.value.id, {
      before: oldest.created_at.toString(),
    })
    messages.value = [...result.messages, ...messages.value]
    hasMore.value = result.has_more
  } catch (error) {
    console.error('Failed to load more:', error)
  } finally {
    loadingMore.value = false
  }
}

// Actions
const goBack = () => {
  if (thread.value?.channel_id) {
    router.push({
      name: 'ChatChannel',
      params: {
        serverId: props.serverId,
        channelId: thread.value.channel_id
      }
    })
  } else {
    router.back()
  }
}

const goToChannel = () => {
  if (thread.value?.channel_id) {
    router.push({
      name: 'ChatChannel',
      params: {
        serverId: props.serverId,
        channelId: thread.value.channel_id
      }
    })
  }
}

const joinThread = async () => {
  if (!thread.value) return
  try {
    await threadService.joinThread(thread.value.id)
    isMember.value = true
    showOptions.value = false
  } catch (error) {
    console.error('Failed to join thread:', error)
  }
}

const leaveThread = async () => {
  if (!thread.value) return
  try {
    await threadService.leaveThread(thread.value.id)
    goBack()
  } catch (error) {
    console.error('Failed to leave thread:', error)
  }
}

const toggleNotifications = () => {
  isMuted.value = !isMuted.value
  showOptions.value = false
  // TODO: Implement actual mute functionality
}

const sendMessage = async () => {
  if (!thread.value || !messageText.value.trim() || sending.value) return
  
  const text = messageText.value.trim()
  messageText.value = ''
  sending.value = true
  
  if (inputRef.value) {
    inputRef.value.style.height = 'auto'
  }
  
  try {
    const content = [{ type: 'text' as const, text }]
    const newMessage = await threadService.sendThreadMessage(thread.value.id, content)
    
    if (newMessage) {
      messages.value.push(newMessage)
      await nextTick()
      scrollToBottom()
    }
  } catch (error) {
    console.error('Failed to send message:', error)
    messageText.value = text
  } finally {
    sending.value = false
  }
}

const scrollToBottom = () => {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

const handleScroll = () => {
  // Could implement lazy loading on scroll
}

const handleInput = () => {
  if (inputRef.value) {
    inputRef.value.style.height = 'auto'
    inputRef.value.style.height = Math.min(inputRef.value.scrollHeight, 200) + 'px'
  }
}

// Watch for threadId changes
watch(() => props.threadId, () => {
  if (props.threadId) {
    loadThread()
  }
}, { immediate: true })

onMounted(() => {
  inputRef.value?.focus()
})
</script>

<style scoped>
.thread-full-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--background-primary);
}

/* Header */
.thread-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  background: var(--background-secondary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.back-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  display: flex;
  transition: all 0.2s;
}

.back-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.header-info {
  flex: 1;
  min-width: 0;
}

.thread-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.thread-channel {
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.thread-channel:hover {
  color: var(--text-link);
  text-decoration: underline;
}

.thread-channel .hash {
  opacity: 0.7;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.member-count {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-muted);
}

.member-count svg {
  opacity: 0.7;
}

.options-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  display: flex;
  transition: all 0.2s;
}

.options-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

/* Options Dropdown */
.options-dropdown {
  position: absolute;
  top: 60px;
  right: 20px;
  background: var(--background-floating);
  border-radius: 8px;
  padding: 8px;
  min-width: 180px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 100;
}

.option-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s;
}

.option-item:hover {
  background: var(--background-modifier-hover);
}

.option-item svg {
  color: var(--text-muted);
}

/* Parent Message Section */
.parent-message-section {
  padding: 16px 20px;
  background: var(--background-secondary);
  border-bottom: 1px solid var(--border-color);
}

.section-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-bottom: 12px;
  letter-spacing: 0.02em;
}

.parent-message {
  display: flex;
  gap: 16px;
}

.parent-message .message-content {
  flex: 1;
  min-width: 0;
}

.parent-message .message-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.parent-message .username {
  font-weight: 600;
  font-size: 15px;
}

.parent-message .timestamp {
  font-size: 12px;
  color: var(--text-muted);
}

.parent-message .message-body {
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.375;
}

/* Messages Section */
.messages-section {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px;
  color: var(--text-secondary);
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--background-tertiary);
  border-top-color: var(--harmony-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-state h3 {
  margin: 0 0 8px;
  color: var(--text-primary);
}

.empty-state p {
  margin: 0;
  color: var(--text-muted);
}

.load-more-btn {
  display: block;
  margin: 0 auto 16px;
  padding: 8px 16px;
  background: var(--background-secondary);
  border: none;
  border-radius: 4px;
  color: var(--text-link);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.load-more-btn:hover {
  background: var(--background-tertiary);
}

/* Message styles */
.message-wrapper {
  display: flex;
  gap: 16px;
  padding: 4px 0;
  margin-top: 16px;
}

.message-wrapper.compact {
  margin-top: 0;
  padding-left: 56px;
  gap: 8px;
}

.message-wrapper .message-main {
  flex: 1;
  min-width: 0;
}

.message-wrapper .message-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 2px;
}

.message-wrapper .username {
  font-weight: 600;
  font-size: 15px;
  cursor: pointer;
}

.message-wrapper .username:hover {
  text-decoration: underline;
}

.message-wrapper .timestamp {
  font-size: 12px;
  color: var(--text-muted);
}

.compact-time {
  font-size: 11px;
  color: var(--text-muted);
  min-width: 40px;
  opacity: 0;
  transition: opacity 0.1s;
}

.message-wrapper.compact:hover .compact-time {
  opacity: 1;
}

.message-body {
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.375;
}

/* Input Section */
.message-input-section {
  padding: 16px 20px 24px;
  background: var(--background-primary);
  flex-shrink: 0;
}

.input-wrapper {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--background-tertiary);
  border-radius: 8px;
  padding: 8px 12px;
}

.attach-btn,
.send-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  display: flex;
  transition: all 0.2s;
}

.attach-btn:hover,
.send-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.input-wrapper textarea {
  flex: 1;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.375;
  resize: none;
  outline: none;
  max-height: 200px;
  font-family: inherit;
}

.input-wrapper textarea::placeholder {
  color: var(--text-muted);
}
</style>

