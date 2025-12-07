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

    <!-- Thread Messages - Reuse MessageDisplay component (DRY) -->
    <div class="messages-section" ref="messagesContainer">
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

      <!-- Use the same MessageDisplay component as the main chat -->
      <MessageDisplay
        v-if="messages.length > 0"
        :messages="messages"
        :current-user-id="currentUserId"
        :channel-id="thread?.channel_id"
        :is-loading="loading"
        :hide-thread-actions="true"
        @send-reaction="handleSendReaction"
        @toggle-emoji-list="handleToggleEmojiList"
        @replying-to="handleReplyingTo"
      />
    </div>

    <!-- Message Input - Reuse MessageInput component (DRY) -->
    <MessageInput
      ref="messageInputRef"
      v-model="messageText"
      :placeholder-target="thread?.name || 'thread'"
      :reply-message-id="replyingToMessageId"
      :reply-user-display-name="replyingToUserName"
      :giphy-open="giphyOpen"
      :emoji-list-open="emojiListOpen"
      @send-message="handleSendMessage"
      @update:reply-message-id="handleCancelReply"
      @toggle-giphy="toggleGiphy"
      @toggle-emoji-list="toggleEmojiListForInput"
    />
    
    <!-- Emoji Popup for reactions -->
    <EmojiPopup
      v-if="reactionEmojiOpen"
      @click.stop
      @sendEmoji="handleSendEmoji"
      :closeEmojiList="closeReactionEmoji"
      :emojiIconClicked="emojiIconClicked"
      :position="'left'"
      :triggerElement="reactionTriggerElement || undefined"
      @resetEmojiIconClicked="emojiIconClicked = false"
    />
    
    <!-- Media Picker (GIFs + Emoji) for message input -->
    <MediaPickerPopup
      v-if="mediaPickerOpen"
      @click.stop
      @sendGif="handleSendGif"
      @sendEmoji="handleSendEmojiToInput"
      :closePopup="closeMediaPicker"
      :position="'above'"
      :triggerElement="mediaPickerTriggerElement || undefined"
      :initialTab="mediaPickerInitialTab"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { threadService } from '@/services/ThreadService'
import { useUserData } from '@/composables/useUserData'
import { format } from 'date-fns'
import Avatar from '@/components/common/Avatar.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import MessageInput from '@/components/MessageInput.vue'
import MessageDisplay from '@/components/MessageDisplay.vue'
import EmojiPopup from '@/components/EmojiPopup.vue'
import MediaPickerPopup from '@/components/MediaPickerPopup.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/useChat'
import { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData } from '@/utils/unifiedContentProcessing'
import { debug } from '@/utils/debug'
import { realtimeConnectionManager } from '@/services/RealtimeConnectionManager'
import type { Message, MessagePart, Emoji, Gif } from '@/types'
import type { ThreadWithDetails } from '@/services/ThreadService'
import type { FilePreviewData } from '@/components/FilePreview.vue'

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

const authStore = useAuthStore()
const chatStore = useChatStore()

// Current user ID for MessageDisplay
const currentUserId = computed(() => authStore.session?.user?.id)

// Reply state
const replyingToMessageId = ref<string>('')
const replyingToUserName = ref<string>('')
const messageInputRef = ref<any>(null)

// Emoji popup state for reactions
const reactionEmojiOpen = ref(false)
const reactionTriggerElement = ref<HTMLElement | null>(null)
const selectedMessageId = ref<string>('')
const isPopupForReaction = ref(false)
const emojiIconClicked = ref(false)

// Media picker state (for GIFs + Emoji in message input)
const mediaPickerOpen = ref(false)
const mediaPickerInitialTab = ref<'gifs' | 'emoji'>('gifs')

// Computed values for MessageInput props
const giphyOpen = computed(() => mediaPickerOpen.value && mediaPickerInitialTab.value === 'gifs')
const emojiListOpen = computed(() => mediaPickerOpen.value && mediaPickerInitialTab.value === 'emoji')

// Trigger element for media picker positioning
const mediaPickerTriggerElement = computed(() => {
  return messageInputRef.value?.gifTriggerRef || messageInputRef.value?.emojiTriggerRef || null
})

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
const threadSubscription = ref<(() => void) | null>(null)

// Format helpers
const formatDate = (date: string | Date) => {
  return format(new Date(date), 'MMM d, yyyy \'at\' h:mm a')
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

// Use unified content parsing system (DRY - same as ChatComponent)
const parseMessageInput = async (input: string): Promise<MessagePart[]> => {
  debug.log('🔧 ThreadFullView: Using unified content parsing for:', input)
  
  // Use efficient batch mention resolution
  const userDataMap = await resolveMentionsUserData(input)
  
  // Use unified emoji resolution - includes both server emojis AND unified pack
  const emojiDataMap = await resolveEmojisData(input)
  
  debug.log('🔧 Emoji data map size:', Object.keys(emojiDataMap).length)
  
  // Parse with unified system (now with emoji data)
  const result = await parseContentToMessageParts(input, userDataMap, emojiDataMap)
  
  debug.log('🔧 Final parsed message parts:', result)
  return result
}

const handleSendMessage = async (content: string, files: FilePreviewData[] = [], replyMessageId?: string) => {
  // Allow sending if we have content OR files
  if ((!content.trim() && files.length === 0) || sending.value || !thread.value) return
  
  // Check if all files are uploaded
  const hasUploadingFiles = files.some(file => file.uploadStatus === 'uploading')
  const hasFailedFiles = files.some(file => file.uploadStatus === 'error')
  
  if (hasUploadingFiles) {
    debug.warn('Cannot send message while files are still uploading')
    return
  }
  
  if (hasFailedFiles) {
    debug.warn('Cannot send message with failed uploads')
    return
  }
  
  sending.value = true
  
  try {
    const messageParts: MessagePart[] = []
    
    // Parse text content if present (handles mentions, emojis, URLs/embeds - same as chat)
    if (content.trim()) {
      const parsedMessage = await parseMessageInput(content)
      messageParts.push(...parsedMessage)
    }
    
    // Add uploaded files as message parts
    for (const fileData of files) {
      if (fileData.uploadStatus === 'completed' && fileData.uploadedUrl) {
        let fileType: 'image' | 'video' | 'audio' | 'file' = 'file'
        
        if (fileData.type.startsWith('image/')) {
          fileType = 'image'
        } else if (fileData.type.startsWith('video/')) {
          fileType = 'video'
        } else if (fileData.type.startsWith('audio/')) {
          fileType = 'audio'
        }
        
        messageParts.push({
          type: 'file',
          url: fileData.uploadedUrl,
          fileType,
          fileName: fileData.name
        })
      }
    }
    
    // Only send if we have message parts
    if (messageParts.length > 0) {
    const newMessage = await threadService.sendThreadMessage(
      thread.value.id, 
      messageParts, 
      replyMessageId || replyingToMessageId.value || undefined
    )
    
    if (newMessage) {
      messages.value.push(newMessage)
      messageText.value = ''
      // Clear reply state
      replyingToMessageId.value = ''
      replyingToUserName.value = ''
      await nextTick()
      scrollToBottom()
      }
    }
  } catch (error) {
    debug.error('Failed to send message:', error)
  } finally {
    sending.value = false
  }
}

const scrollToBottom = () => {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

// MessageDisplay event handlers
const handleSendReaction = async (messageId: string, emoji: Emoji) => {
  try {
    const { useReactionsStore } = await import('@/stores/useReactions')
    const reactionsStore = useReactionsStore()
    await reactionsStore.toggleReaction(messageId, emoji)
  } catch (error) {
    console.error('Failed to toggle reaction:', error)
  }
}

const handleToggleEmojiList = (isReaction: boolean, message?: Message, triggerElement?: HTMLElement) => {
  if (isReaction) {
    // Reaction emoji - use separate popup positioned on the message
    if (message) selectedMessageId.value = message.id
    if (triggerElement) reactionTriggerElement.value = triggerElement
    isPopupForReaction.value = true
    reactionEmojiOpen.value = !reactionEmojiOpen.value
    if (reactionEmojiOpen.value) {
      emojiIconClicked.value = true
    }
  }
}

const handleSendEmoji = async (emoji: Emoji) => {
  if (isPopupForReaction.value && authStore.session?.user) {
    // Add reaction using chat store
    await chatStore.addReaction(selectedMessageId.value, emoji.id, authStore.session.user.id)
  }
  closeReactionEmoji()
}

const closeReactionEmoji = () => {
  reactionEmojiOpen.value = false
  reactionTriggerElement.value = null
  emojiIconClicked.value = false
}

watch(reactionEmojiOpen, () => {
  if (!reactionEmojiOpen.value) {
    emojiIconClicked.value = false
    reactionTriggerElement.value = null
  }
})

// Media picker handlers (GIF + Emoji for message input)
const toggleGiphy = () => {
  mediaPickerInitialTab.value = 'gifs'
  mediaPickerOpen.value = !mediaPickerOpen.value
  if (mediaPickerOpen.value) {
    reactionEmojiOpen.value = false
  }
}

const toggleEmojiListForInput = (isReaction: boolean, message?: Message) => {
  if (!isReaction) {
    // Regular emoji input - use unified media picker
    mediaPickerInitialTab.value = 'emoji'
    mediaPickerOpen.value = !mediaPickerOpen.value
    if (mediaPickerOpen.value) {
      reactionEmojiOpen.value = false
    }
  }
}

const closeMediaPicker = () => {
  mediaPickerOpen.value = false
}

watch(mediaPickerOpen, () => {
  if (!mediaPickerOpen.value) {
    emojiIconClicked.value = false
  }
})

// Handle sending a GIF
const handleSendGif = async (gif: Gif) => {
  const gifUrl = gif.media_formats.gif.url
  closeMediaPicker()
  
  if (!thread.value) return
  
  sending.value = true
  try {
    const messageParts: MessagePart[] = [{
      type: 'file',
      url: gifUrl,
      fileType: 'image'
    }]
    
    const newMessage = await threadService.sendThreadMessage(
      thread.value.id,
      messageParts,
      replyingToMessageId.value || undefined
    )
    
    if (newMessage) {
      messages.value.push(newMessage)
      replyingToMessageId.value = ''
      replyingToUserName.value = ''
      await nextTick()
      scrollToBottom()
    }
  } catch (error) {
    debug.error('Failed to send GIF:', error)
  } finally {
    sending.value = false
  }
}

// Handle adding emoji to message input (not reaction)
const handleSendEmojiToInput = (emoji: Emoji) => {
  closeMediaPicker()
  // Append emoji to message text
  messageText.value += `:${emoji.name}:`
}

const handleReplyingTo = (messageId: string, displayName?: string) => {
  // Set reply state
  replyingToMessageId.value = messageId
  
  if (displayName) {
    replyingToUserName.value = displayName
  } else {
    // Fallback: find the message and get user display name
    const replyMessage = messages.value.find(m => m.id === messageId)
    if (replyMessage) {
      replyingToUserName.value = getDisplayName(replyMessage.user_id).value
    }
  }
}

const handleCancelReply = (value: string) => {
  if (!value) {
    replyingToMessageId.value = ''
    replyingToUserName.value = ''
  }
}

// Setup realtime subscription for thread messages
const setupRealtimeSubscription = () => {
  if (!thread.value?.id) return

  // Clean up existing subscription
  if (threadSubscription.value) {
    threadSubscription.value()
    threadSubscription.value = null
  }

  const channelName = `thread-messages-${thread.value.id}`
  
  threadSubscription.value = realtimeConnectionManager.subscribeToTable({
    channelName,
    table: 'messages',
    filter: `thread_id=eq.${thread.value.id}`,
    
    // Handle new messages
    onInsert: async (payload) => {
      const payloadNew = payload.new as any
      
      // Skip if already in messages (optimistic update)
      if (messages.value.some(m => m.id === payloadNew.id)) {
        return
      }
      
      // Only add if it's for this thread
      if (payloadNew.thread_id === thread.value?.id) {
        const newMessage: Message = {
          id: payloadNew.id,
          created_at: new Date(payloadNew.created_at),
          channel_id: payloadNew.channel_id,
          conversation_id: payloadNew.conversation_id,
          user_id: payloadNew.user_id,
          bot_id: payloadNew.bot_id,
          content: payloadNew.content,
          reactions: payloadNew.reactions,
          reply_to: payloadNew.reply_to,
          is_system: payloadNew.is_system,
          updated_at: payloadNew.updated_at ? new Date(payloadNew.updated_at) : undefined,
          metadata: payloadNew.metadata || null,
          encrypted: payloadNew.encrypted || false,
          encryption_metadata: payloadNew.encryption_metadata || null,
          thread_id: payloadNew.thread_id,
        }
        
        messages.value.push(newMessage)
        await nextTick()
        scrollToBottom()
        debug.log('📝 Thread message added via realtime:', newMessage.id)
      }
    },
    
    // Handle message updates (edits, soft deletes)
    onUpdate: async (payload) => {
      const payloadNew = payload.new as any
      
      // Handle soft delete
      if (payloadNew.is_deleted) {
        const index = messages.value.findIndex(m => m.id === payloadNew.id)
        if (index !== -1) {
          messages.value.splice(index, 1)
          debug.log('🗑️ Thread message soft-deleted via realtime:', payloadNew.id)
        }
        return
      }
      
      // Handle message edits
      const index = messages.value.findIndex(m => m.id === payloadNew.id)
      if (index !== -1) {
        messages.value[index] = {
          ...messages.value[index],
          content: payloadNew.content,
          updated_at: payloadNew.updated_at ? new Date(payloadNew.updated_at) : undefined,
          metadata: payloadNew.metadata || null,
        }
        debug.log('🔄 Thread message updated via realtime:', payloadNew.id)
      }
    },
    
    // Handle hard deletes
    onDelete: (payload) => {
      const payloadOld = payload.old as any
      const index = messages.value.findIndex(m => m.id === payloadOld.id)
      if (index !== -1) {
        messages.value.splice(index, 1)
        debug.log('🗑️ Thread message deleted via realtime:', payloadOld.id)
      }
    },
  })
  
  debug.log(`📡 Subscribed to thread messages: ${channelName}`)
}

// Watch for threadId changes
watch(() => props.threadId, () => {
  if (props.threadId) {
    loadThread()
  }
}, { immediate: true })

// Setup realtime when thread is loaded
watch(() => thread.value?.id, (threadId) => {
  if (threadId) {
    setupRealtimeSubscription()
  } else {
    // Clean up subscription when thread is unloaded
    if (threadSubscription.value) {
      threadSubscription.value()
      threadSubscription.value = null
    }
  }
})

onMounted(() => {
  // Focus will be handled by MessageInput component
})

// Cleanup on unmount
onUnmounted(() => {
  if (threadSubscription.value) {
    threadSubscription.value()
    threadSubscription.value = null
  }
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

</style>

