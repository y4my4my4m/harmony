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
                <h3>{{ displayThreadName }}</h3>
                <p class="thread-channel">
                  <span class="hash">#</span>{{ thread?.channel_name || 'channel' }}
                </p>
              </div>
            </div>
            <div class="header-actions">
              <button 
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
            <button v-if="thread?.muted" @click="toggleMute" class="option-item">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
              </svg>
              Unmute Thread
            </button>
            <button v-else @click="toggleMute" class="option-item">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
              </svg>
              Mute Thread
            </button>
          </div>

          <!-- Parent Message (Original message that started the thread) -->
          <div class="parent-message" v-if="displayParentMessage">
            <div class="message-avatar">
              <Avatar 
                :src="getAuthorAvatar(displayParentMessage.user_id)" 
                :alt="getAuthorName(displayParentMessage.user_id)"
                size="sm"
                :interactive="true"
              />
            </div>
            <div class="message-main">
              <div class="message-meta">
                <span class="username" :style="{ color: getAuthorColor(displayParentMessage.user_id) }">
                  {{ getAuthorName(displayParentMessage.user_id) }}
                </span>
                <span class="timestamp">{{ formatTimestamp(displayParentMessage.created_at) }}</span>
              </div>
              <div class="message-content">
                <UnifiedMessageContent
                  :content="displayParentMessage.content"
                  :message-id="displayParentMessage.id"
                />
              </div>
            </div>
          </div>

          <!-- Divider with count (only show when thread exists) -->
          <div class="thread-divider" v-if="!isDraftMode">
            <div class="divider-line"></div>
            <span class="reply-count">{{ thread?.message_count || 0 }} repl{{ (thread?.message_count || 0) === 1 ? 'y' : 'ies' }}</span>
            <div class="divider-line"></div>
          </div>
          
          <!-- Draft mode hint -->
          <div class="draft-hint" v-if="isDraftMode">
            <div class="divider-line"></div>
            <span class="hint-text">Send a message to start this thread</span>
            <div class="divider-line"></div>
          </div>

          <!-- Thread Messages (styled like normal chat) -->
          <div class="thread-messages" ref="messagesContainer">
            <div v-if="loading" class="loading-state">
              <div class="spinner"></div>
              <p>Loading messages...</p>
            </div>
            
            <template v-else>
              <button 
                v-if="hasMore" 
                class="load-more-btn"
                @click="loadMore"
                :disabled="loadingMore"
              >
                {{ loadingMore ? 'Loading...' : 'Load older messages' }}
              </button>
              
              <div 
                v-for="(message, index) in messages" 
                :key="message.id"
                class="message-group"
                :class="{ 'has-header': shouldShowHeader(message, index) }"
              >
                <!-- Message with header (avatar + username + timestamp) -->
                <template v-if="shouldShowHeader(message, index)">
                  <div class="message-avatar">
                    <Avatar 
                      :src="getAuthorAvatar(message.user_id)" 
                      :alt="getAuthorName(message.user_id)"
                      size="sm"
                      :interactive="true"
                    />
                  </div>
                  <div class="message-main">
                    <div class="message-meta">
                      <span class="username" :style="{ color: getAuthorColor(message.user_id) }">
                        {{ getAuthorName(message.user_id) }}
                      </span>
                      <span class="timestamp">{{ formatTimestamp(message.created_at) }}</span>
                    </div>
                    <div class="message-content">
                      <UnifiedMessageContent
                        :content="message.content"
                        :message-id="message.id"
                      />
                    </div>
                  </div>
                </template>
                
                <!-- Compact message (no header, just content aligned with previous messages) -->
                <template v-else>
                  <div class="message-gutter" :data-timestamp="formatTimeOnly(message.created_at)"></div>
                  <div class="message-main">
                    <div class="message-content">
                      <UnifiedMessageContent
                        :content="message.content"
                        :message-id="message.id"
                      />
                    </div>
                  </div>
                </template>
              </div>
            </template>
          </div>

          <!-- Message Input (styled like normal chat input) -->
          <div class="thread-input">
            <div class="input-wrapper">
              <button class="input-action-btn" title="Add attachment">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/>
                </svg>
              </button>
              <div class="input-container">
                <textarea
                  ref="inputRef"
                  v-model="messageText"
                  :placeholder="`Message &quot;${thread?.name || 'thread'}&quot;`"
                  @keydown.enter.exact.prevent="sendMessage"
                  @input="handleInput"
                  rows="1"
                />
              </div>
              <div class="input-actions">
                <button class="input-action-btn" title="Add emoji">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/>
                  </svg>
                </button>
                <button 
                  class="send-btn"
                  @click="sendMessage"
                  :disabled="!messageText.trim() || sending"
                  title="Send message"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              </div>
            </div>
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
import { format, isSameDay, differenceInMinutes } from 'date-fns'
import Avatar from '@/components/common/Avatar.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import type { Message, Thread } from '@/types'
import type { ThreadWithDetails } from '@/services/ThreadService'

interface Props {
  isVisible: boolean
  threadId?: string
  initialThread?: ThreadWithDetails
  draftParentMessage?: Message | null
  channelId?: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  close: []
  'thread-updated': [thread: ThreadWithDetails]
  'thread-created': [thread: ThreadWithDetails, parentMessage: Message]
}>()

const { 
  getUserDisplayName: getDisplayName, 
  getUserColor: getColor,
  getUserAvatarUrl: getAvatarUrl 
} = useUserData()

// State
const thread = ref<ThreadWithDetails | null>(null)
const messages = ref<Message[]>([])
const loading = ref(false)
const loadingMore = ref(false)
const hasMore = ref(false)
const isMember = ref(true) // Default to true to allow sending
const joining = ref(false)
const showOptions = ref(false)
const messageText = ref('')
const sending = ref(false)
const messagesContainer = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)

// Draft mode - thread not yet created
const isDraftMode = computed(() => !props.threadId && !props.initialThread && !!props.draftParentMessage)

// Parent message to display (from thread or draft)
const displayParentMessage = computed(() => {
  if (isDraftMode.value) {
    return props.draftParentMessage
  }
  return thread.value?.parent_message
})

// Thread name (or generate from parent message in draft mode)
const displayThreadName = computed(() => {
  if (thread.value?.name) return thread.value.name
  if (isDraftMode.value && props.draftParentMessage) {
    const text = Array.isArray(props.draftParentMessage.content)
      ? props.draftParentMessage.content.find(p => p.type === 'text')?.text || 'Thread'
      : 'Thread'
    return text.substring(0, 50) + (text.length > 50 ? '...' : '')
  }
  return 'Thread'
})

// Message grouping - show header if different author or > 7 min gap
const shouldShowHeader = (message: Message, index: number): boolean => {
  if (index === 0) return true
  
  const prevMessage = messages.value[index - 1]
  if (!prevMessage) return true
  
  // Different author
  if (message.user_id !== prevMessage.user_id) return true
  
  // More than 7 minutes apart
  const currentTime = new Date(message.created_at)
  const prevTime = new Date(prevMessage.created_at)
  if (differenceInMinutes(currentTime, prevTime) > 7) return true
  
  // Different day
  if (!isSameDay(currentTime, prevTime)) return true
  
  return false
}

// Load thread data
const loadThread = async () => {
  // In draft mode, don't load - just show parent message
  if (isDraftMode.value) {
    loading.value = false
    messages.value = []
    return
  }
  
  const threadId = props.threadId || props.initialThread?.id
  if (!threadId) return
  
  loading.value = true
  try {
    // Always fetch full thread data to ensure parent_message is included
    thread.value = await threadService.getThread(threadId, true) // force refresh
    
    isMember.value = thread.value?.is_member ?? true
    
    // Load messages
    if (thread.value) {
      const result = await threadService.getThreadMessages(thread.value.id)
      messages.value = result.messages
      hasMore.value = result.has_more
      
      // Scroll to bottom after loading
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
    console.error('Failed to load more messages:', error)
  } finally {
    loadingMore.value = false
  }
}

const joinThread = async () => {
  if (!thread.value) return
  
  joining.value = true
  showOptions.value = false
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
  if (!messageText.value.trim() || sending.value) return
  
  // In draft mode, need parent message to create thread
  if (isDraftMode.value && !props.draftParentMessage) return
  
  // In normal mode, need thread
  if (!isDraftMode.value && !thread.value) return
  
  const text = messageText.value.trim()
  messageText.value = ''
  sending.value = true
  
  // Reset textarea height
  if (inputRef.value) {
    inputRef.value.style.height = 'auto'
  }
  
  try {
    let targetThreadId = thread.value?.id
    
    // If in draft mode, create the thread first
    if (isDraftMode.value && props.draftParentMessage) {
      const threadName = displayThreadName.value
      const newThread = await threadService.createThread({
        message_id: props.draftParentMessage.id,
        name: threadName,
      })
      
      if (!newThread) {
        throw new Error('Failed to create thread')
      }
      
      targetThreadId = newThread.id
      thread.value = await threadService.getThread(newThread.id, true)
      
      // Emit thread-created event to parent
      emit('thread-created', thread.value!, props.draftParentMessage)
    }
    
    if (!targetThreadId) {
      throw new Error('No thread ID')
    }
    
    const content = [{ type: 'text' as const, text }]
    const newMessage = await threadService.sendThreadMessage(targetThreadId, content)
    
    if (newMessage) {
      messages.value.push(newMessage)
      // Scroll to bottom
      await nextTick()
      scrollToBottom()
    }
  } catch (error) {
    console.error('Failed to send message:', error)
    // Restore message text on error
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

const handleInput = () => {
  if (inputRef.value) {
    inputRef.value.style.height = 'auto'
    inputRef.value.style.height = Math.min(inputRef.value.scrollHeight, 150) + 'px'
  }
}

const getAuthorName = (userId?: string) => {
  if (!userId) return 'Unknown'
  return getDisplayName(userId).value
}

const getAuthorColor = (userId?: string) => {
  if (!userId) return undefined
  return getColor(userId).value
}

const getAuthorAvatar = (userId?: string) => {
  if (!userId) return '/default_avatar.webp'
  return getAvatarUrl(userId).value
}

const formatTimestamp = (date: Date | string) => {
  try {
    const d = typeof date === 'string' ? new Date(date) : date
    return format(d, 'MMM d, h:mm a')
  } catch {
    return ''
  }
}

const formatTimeOnly = (date: Date | string) => {
  try {
    const d = typeof date === 'string' ? new Date(date) : date
    return format(d, 'h:mm a')
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
  max-width: 520px;
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
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-secondary);
  min-height: 48px;
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
  padding: 6px;
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
}

.header-actions {
  display: flex;
  gap: 8px;
}

.action-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 6px;
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
  padding: 6px;
  z-index: 10;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  min-width: 160px;
}

.option-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}

.option-item:hover {
  background: var(--background-secondary);
}

/* Parent Message - styled like regular chat */
.parent-message {
  display: flex;
  gap: 16px;
  padding: 16px;
  background: var(--background-secondary);
  border-bottom: 1px solid var(--border-color);
}

.parent-message .message-avatar {
  flex-shrink: 0;
}

.parent-message .message-main {
  flex: 1;
  min-width: 0;
}

.parent-message .message-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}

.parent-message .username {
  font-weight: 600;
  font-size: 15px;
  cursor: pointer;
}

.parent-message .username:hover {
  text-decoration: underline;
}

.parent-message .timestamp {
  font-size: 12px;
  color: var(--text-muted);
}

.parent-message .message-content {
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.375;
}

/* Divider */
.thread-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: var(--background-primary);
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

/* Draft Hint */
.draft-hint {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--background-primary);
}

.hint-text {
  font-size: 13px;
  color: var(--text-muted);
  font-style: italic;
  white-space: nowrap;
}

/* Thread Messages - styled exactly like main chat */
.thread-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 0;
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

.load-more-btn {
  display: block;
  margin: 0 auto 16px;
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

/* Message Group - matches MessageDisplay.vue styling */
.message-group {
  display: flex;
  padding: 2px 16px;
  transition: background 0.1s;
}

.message-group:hover {
  background: var(--background-message-hover, rgba(0, 0, 0, 0.05));
}

.message-group.has-header {
  padding-top: 16px;
  margin-top: 0;
}

.message-group .message-avatar {
  flex-shrink: 0;
  width: 40px;
  margin-right: 16px;
}

.message-group .message-gutter {
  width: 40px;
  margin-right: 16px;
  flex-shrink: 0;
  position: relative;
}

.message-group:hover .message-gutter::before {
  content: attr(data-timestamp);
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}

.message-group .message-main {
  flex: 1;
  min-width: 0;
}

.message-group .message-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 2px;
}

.message-group .username {
  font-weight: 600;
  font-size: 15px;
  cursor: pointer;
}

.message-group .username:hover {
  text-decoration: underline;
}

.message-group .timestamp {
  font-size: 12px;
  color: var(--text-muted);
}

.message-group .message-content {
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.375;
  word-wrap: break-word;
}

/* Thread Input - styled like main chat input */
.thread-input {
  padding: 0 16px 24px;
  background: var(--background-primary);
}

.input-wrapper {
  display: flex;
  align-items: flex-end;
  background: var(--background-tertiary);
  border-radius: 8px;
  padding: 0 4px;
}

.input-action-btn {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 10px 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s;
}

.input-action-btn:hover {
  color: var(--text-primary);
}

.input-container {
  flex: 1;
  display: flex;
  align-items: center;
}

.input-container textarea {
  flex: 1;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 15px;
  line-height: 1.375;
  resize: none;
  min-height: 44px;
  max-height: 150px;
  padding: 11px 0;
  outline: none;
  font-family: inherit;
}

.input-container textarea::placeholder {
  color: var(--text-muted);
}

.input-actions {
  display: flex;
  align-items: center;
}

.send-btn {
  background: none;
  border: none;
  color: var(--harmony-primary);
  cursor: pointer;
  padding: 10px 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  opacity: 0.7;
}

.send-btn:hover:not(:disabled) {
  opacity: 1;
}

.send-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
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
