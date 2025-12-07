<template>
  <Teleport to="body">
    <Transition name="slide-panel">
      <div v-if="isVisible" class="thread-overlay" @click.self="close">
        <div class="thread-panel">
          <!-- Thread Header -->
          <div class="thread-header">
            <div class="header-left">
              <button class="back-btn" @click="close" title="Close thread">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 12H5M12 19l-7-7 7-7"/>
                </svg>
              </button>
              <div class="thread-info">
                <h3>{{ thread?.name || 'Thread' }}</h3>
                <p class="thread-channel">
                  <span class="hash">#</span>{{ thread?.channel_name || 'channel' }}
                </p>
              </div>
            </div>
            <div class="header-actions">
              <button 
                v-if="!isMember" 
                class="join-btn" 
                @click="joinThread"
                :disabled="joining"
              >
                {{ joining ? 'Joining...' : 'Join Thread' }}
              </button>
              <button 
                v-else
                class="action-btn"
                @click="showOptions = !showOptions"
                title="Thread options"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5" r="2"/>
                  <circle cx="12" cy="12" r="2"/>
                  <circle cx="12" cy="19" r="2"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- Thread Options Menu -->
          <div v-if="showOptions" class="options-menu" v-click-outside="() => showOptions = false">
            <button @click="leaveThread" class="option-item">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              Leave Thread
            </button>
            <button v-if="thread?.muted" @click="toggleMute" class="option-item">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.5 5C7.91 5 5 7.91 5 11.5C5 15.09 7.91 18 11.5 18C12.99 18 14.38 17.5 15.5 16.66L19.29 20.45C19.68 20.84 20.32 20.84 20.71 20.45C21.1 20.06 21.1 19.42 20.71 19.04L16.92 15.25C17.76 14.12 18.25 12.73 18.25 11.24C18.25 7.65 15.34 4.74 11.75 4.74L11.5 5Z"/>
              </svg>
              Unmute Thread
            </button>
            <button v-else @click="toggleMute" class="option-item">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12,4L9.91,6.09L12,8.18M4.27,3L3,4.27L7.73,9H3V15H7L12,20V13.27L16.25,17.53C15.58,18.04 14.83,18.46 14,18.7V20.77C15.38,20.45 16.63,19.82 17.68,18.96L19.73,21L21,19.73L12,10.73M19,12C19,12.94 18.8,13.82 18.46,14.64L19.97,16.15C20.62,14.91 21,13.5 21,12C21,7.72 18,4.14 14,3.23V5.29C16.89,6.15 19,8.83 19,12M16.5,12C16.5,10.23 15.5,8.71 14,7.97V10.18L16.45,12.63C16.5,12.43 16.5,12.21 16.5,12Z"/>
              </svg>
              Mute Thread
            </button>
          </div>

          <!-- Parent Message -->
          <div class="parent-message" v-if="thread?.parent_message">
            <div class="parent-avatar">
              <Avatar :user-id="thread.parent_message.user_id" :size="40" />
            </div>
            <div class="parent-content">
              <div class="parent-header">
                <span class="parent-author">{{ getAuthorName(thread.parent_message.user_id) }}</span>
                <span class="parent-time">{{ formatTimestamp(thread.parent_message.created_at) }}</span>
              </div>
              <div class="parent-text">
                <UnifiedMessageContent
                  :content="thread.parent_message.content"
                  :message-id="thread.parent_message.id"
                />
              </div>
            </div>
          </div>

          <!-- Divider with count -->
          <div class="thread-divider">
            <div class="divider-line"></div>
            <span class="reply-count">{{ thread?.message_count || 0 }} replies</span>
            <div class="divider-line"></div>
          </div>

          <!-- Thread Messages -->
          <div class="thread-messages" ref="messagesContainer">
            <div v-if="loading" class="loading-state">
              <div class="spinner"></div>
              <p>Loading messages...</p>
            </div>
            
            <template v-else>
              <div 
                v-for="message in messages" 
                :key="message.id"
                class="thread-message"
              >
                <div class="message-avatar">
                  <Avatar :user-id="message.user_id" :size="32" />
                </div>
                <div class="message-body">
                  <div class="message-header">
                    <span class="message-author">{{ getAuthorName(message.user_id) }}</span>
                    <span class="message-time">{{ formatTimestamp(message.created_at) }}</span>
                  </div>
                  <div class="message-content">
                    <UnifiedMessageContent
                      :content="message.content"
                      :message-id="message.id"
                    />
                  </div>
                </div>
              </div>
              
              <button 
                v-if="hasMore" 
                class="load-more-btn"
                @click="loadMore"
                :disabled="loadingMore"
              >
                {{ loadingMore ? 'Loading...' : 'Load more' }}
              </button>
            </template>
          </div>

          <!-- Message Input -->
          <div class="thread-input" v-if="isMember">
            <div class="input-container">
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
                @click="sendMessage"
                :disabled="!messageText.trim() || sending"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- Not a member prompt -->
          <div class="join-prompt" v-else>
            <p>Join this thread to reply</p>
            <button @click="joinThread" :disabled="joining">
              {{ joining ? 'Joining...' : 'Join Thread' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { threadService } from '@/services/ThreadService'
import { useUserData } from '@/composables/useUserData'
import { format } from 'date-fns'
import Avatar from '@/components/common/Avatar.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import type { Message, Thread } from '@/types'
import type { ThreadWithDetails } from '@/services/ThreadService'

interface Props {
  isVisible: boolean
  threadId?: string
  initialThread?: ThreadWithDetails
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  'thread-updated': [thread: ThreadWithDetails]
}>()

const { getUserById } = useUserData()

// State
const thread = ref<ThreadWithDetails | null>(null)
const messages = ref<Message[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const hasMore = ref(false)
const isMember = ref(false)
const joining = ref(false)
const showOptions = ref(false)
const messageText = ref('')
const sending = ref(false)
const messagesContainer = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)

// Load thread data
const loadThread = async () => {
  if (!props.threadId && !props.initialThread) return
  
  loading.value = true
  try {
    if (props.initialThread) {
      thread.value = props.initialThread
    } else if (props.threadId) {
      thread.value = await threadService.getThread(props.threadId)
    }
    
    isMember.value = thread.value?.is_member || false
    
    // Load messages
    if (thread.value) {
      const result = await threadService.getThreadMessages(thread.value.id)
      messages.value = result.messages
      hasMore.value = result.has_more
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
    console.error('Failed to load more messages:', error)
  } finally {
    loadingMore.value = false
  }
}

const joinThread = async () => {
  if (!thread.value) return
  
  joining.value = true
  try {
    await threadService.joinThread(thread.value.id)
    isMember.value = true
    thread.value = await threadService.getThread(thread.value.id, true)
    emit('thread-updated', thread.value!)
  } catch (error) {
    console.error('Failed to join thread:', error)
  } finally {
    joining.value = false
  }
}

const leaveThread = async () => {
  if (!thread.value) return
  
  try {
    await threadService.leaveThread(thread.value.id)
    isMember.value = false
    showOptions.value = false
    close()
  } catch (error) {
    console.error('Failed to leave thread:', error)
  }
}

const toggleMute = async () => {
  if (!thread.value) return
  
  try {
    // TODO: Implement mute toggle
    showOptions.value = false
  } catch (error) {
    console.error('Failed to toggle mute:', error)
  }
}

const sendMessage = async () => {
  if (!thread.value || !messageText.value.trim() || sending.value) return
  
  const text = messageText.value.trim()
  messageText.value = ''
  sending.value = true
  
  try {
    const content = [{ type: 'text' as const, text }]
    const newMessage = await threadService.sendThreadMessage(thread.value.id, content)
    
    if (newMessage) {
      messages.value.push(newMessage)
      // Scroll to bottom
      await nextTick()
      if (messagesContainer.value) {
        messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
      }
    }
  } catch (error) {
    console.error('Failed to send message:', error)
    // Restore message text on error
    messageText.value = text
  } finally {
    sending.value = false
  }
}

const handleInput = () => {
  if (inputRef.value) {
    inputRef.value.style.height = 'auto'
    inputRef.value.style.height = Math.min(inputRef.value.scrollHeight, 150) + 'px'
  }
}

const getAuthorName = (userId?: string) => {
  if (!userId) return 'Unknown'
  const user = getUserById(userId)
  return user?.displayName || user?.username || 'Unknown'
}

const formatTimestamp = (date: Date | string) => {
  try {
    const d = typeof date === 'string' ? new Date(date) : date
    return format(d, 'MMM d, h:mm a')
  } catch {
    return ''
  }
}

const close = () => {
  emit('close')
}

// Watch for visibility changes
watch(() => props.isVisible, (visible) => {
  if (visible) {
    loadThread()
  }
})

watch(() => props.threadId, () => {
  if (props.isVisible) {
    loadThread()
  }
})

onMounted(() => {
  if (props.isVisible) {
    loadThread()
  }
})
</script>

<style scoped>
.thread-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1000;
  display: flex;
  justify-content: flex-end;
}

.thread-panel {
  width: 100%;
  max-width: 480px;
  height: 100%;
  background: var(--background-primary);
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.3);
}

.thread-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-secondary);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
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
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.thread-info h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.thread-channel {
  margin: 2px 0 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.thread-channel .hash {
  color: var(--text-muted);
  margin-right: 2px;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.join-btn {
  background: var(--harmony-primary);
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.join-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.join-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.action-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  transition: all 0.2s;
}

.action-btn:hover {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.options-menu {
  position: absolute;
  top: 56px;
  right: 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 8px 0;
  z-index: 10;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}

.option-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 16px;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  transition: background 0.2s;
}

.option-item:hover {
  background: var(--background-secondary);
}

.parent-message {
  display: flex;
  gap: 12px;
  padding: 16px;
  background: var(--background-secondary);
  border-bottom: 1px solid var(--border-color);
}

.parent-content {
  flex: 1;
  min-width: 0;
}

.parent-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.parent-author {
  font-weight: 600;
  color: var(--text-primary);
}

.parent-time {
  font-size: 12px;
  color: var(--text-secondary);
}

.parent-text {
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.4;
}

.thread-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
}

.divider-line {
  flex: 1;
  height: 1px;
  background: var(--border-color);
}

.reply-count {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.thread-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.loading-state {
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
  border: 3px solid var(--border-color);
  border-top-color: var(--harmony-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 16px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.thread-message {
  display: flex;
  gap: 12px;
}

.message-body {
  flex: 1;
  min-width: 0;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.message-author {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}

.message-time {
  font-size: 11px;
  color: var(--text-secondary);
}

.message-content {
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.4;
}

.load-more-btn {
  align-self: center;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.load-more-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.thread-input {
  padding: 16px;
  border-top: 1px solid var(--border-color);
  background: var(--background-secondary);
}

.input-container {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--background-tertiary);
  border-radius: 8px;
  padding: 8px 12px;
}

.input-container textarea {
  flex: 1;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.4;
  resize: none;
  min-height: 24px;
  max-height: 150px;
  outline: none;
}

.input-container textarea::placeholder {
  color: var(--text-muted);
}

.send-btn {
  background: var(--harmony-primary);
  color: white;
  border: none;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.send-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.join-prompt {
  padding: 24px;
  text-align: center;
  background: var(--background-secondary);
  border-top: 1px solid var(--border-color);
}

.join-prompt p {
  margin: 0 0 12px 0;
  color: var(--text-secondary);
}

.join-prompt button {
  background: var(--harmony-primary);
  color: white;
  border: none;
  padding: 10px 24px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.join-prompt button:hover:not(:disabled) {
  filter: brightness(1.1);
}

/* Slide panel transition */
.slide-panel-enter-active,
.slide-panel-leave-active {
  transition: all 0.3s ease;
}

.slide-panel-enter-from .thread-panel,
.slide-panel-leave-to .thread-panel {
  transform: translateX(100%);
}

.slide-panel-enter-from,
.slide-panel-leave-to {
  opacity: 0;
}

/* Mobile */
@media (max-width: 768px) {
  .thread-panel {
    max-width: 100%;
  }
}
</style>

