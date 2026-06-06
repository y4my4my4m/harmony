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

      <div class="options-divider"></div>

      <button v-if="canManageThread" @click="editThread" class="option-item">
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path fill="currentColor" d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
        </svg>
        Edit Thread
      </button>

      <button v-if="canManageThread && !thread?.archived" @click="closeThread" class="option-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/>
        </svg>
        Close Thread
      </button>

      <button v-if="canManageThread && thread?.archived" @click="reopenThread" class="option-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 6.5L17.5 12H14v2h-4v-2H6.5L12 6.5zM5.12 5l.81-1h12l.94 1H5.12z"/>
        </svg>
        Reopen Thread
      </button>

      <button v-if="canManageThread && !thread?.locked" @click="lockThread" class="option-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
        </svg>
        Lock Thread
      </button>

      <button v-if="canManageThread && thread?.locked" @click="unlockThread" class="option-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6h1.9c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm0 12H6V10h12v10z"/>
        </svg>
        Unlock Thread
      </button>

      <button v-if="canManageThread" @click="deleteThread" class="option-item danger">
        <svg width="16" height="16" viewBox="0 0 24 24">
          <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
        </svg>
        Delete Thread
      </button>

      <div class="options-divider"></div>

      <button @click="toggleNotifications" class="option-item">
        <svg v-if="isMuted" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
        </svg>
        {{ isMuted ? 'Unmute Thread' : 'Mute Thread' }}
      </button>

      <div class="options-divider"></div>

      <button @click="copyThreadLink" class="option-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>
        </svg>
        Copy Link
      </button>

      <button @click="copyThreadId" class="option-item">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>
        </svg>
        Copy Thread ID
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
              <DisplayName :userId="thread.parent_message.user_id" />
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
        <LoadingSpinner :size="32" />
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
        ref="threadMessageDisplayRef"
        v-if="messages.length > 0"
        :messages="messages"
        :current-user-id="currentUserId"
        :channel-id="thread?.channel_id"
        :is-loading="loading"
        :hide-thread-actions="true"
        :enable-read-divider="false"
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
      :reply-user-id="replyingToUserId"
      :giphy-open="giphyOpen"
      :emoji-list-open="emojiListOpen"
      @send-message="handleSendMessage"
      @send-voice-message="handleSendVoiceMessage"
      @update:reply-message-id="handleCancelReply"
      @toggle-giphy="toggleGiphy"
      @toggle-emoji-list="toggleEmojiListForInput"
      @edit-last-message="threadMessageDisplayRef?.editLastOwnMessage()"
    />
    
    <!-- Emoji Popup for reactions -->
    <EmojiPopup
      v-if="reactionEmojiOpen"
      @click.stop
      @sendEmoji="handleSendEmoji"
      :closeEmojiList="closeReactionEmoji"
      :emojiIconClicked="emojiIconClicked"
      :position="'left'"
      :triggerElement="(reactionTriggerElement as unknown as HTMLElement | null) || undefined"
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
import { useRouter } from 'vue-router'
import { threadService } from '@/services/ThreadService'
import { supabase } from '@/supabase'
import { useUserData } from '@/composables/useUserData'
import { useEncryptionFallbackPrompt } from '@/composables/useEncryptionFallbackPrompt'
import { format } from 'date-fns'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import MessageInput from '@/components/MessageInput.vue'
import MessageDisplay from '@/components/MessageDisplay.vue'
import EmojiPopup from '@/components/EmojiPopup.vue'
import MediaPickerPopup from '@/components/MediaPickerPopup.vue'
import { useAuthStore } from '@/stores/auth'
import { useChatStore } from '@/stores/useChat'
import { useReactionsStore } from '@/stores/useReactions'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData } from '@/utils/unifiedContentProcessing'
import { debug } from '@/utils/debug'
import { isVideoMessageUrl } from '@/utils/klipyAttribution'
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
const router = useRouter()

const { 
  getUserDisplayName: getDisplayName, 
  getUserColor: getColor,
  getUserAvatarUrl: getAvatarUrl 
} = useUserData()

const authStore = useAuthStore()
const chatStore = useChatStore()
const reactionsStore = useReactionsStore()
const { canManageChannels } = useServerPermissions()
const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()

const canManageThread = computed(() => canManageChannels.value)

// Current user ID for MessageDisplay
const currentUserId = computed(() => authStore.session?.user?.id)

// Reply state
const replyingToMessageId = ref<string>('')
const replyingToUserName = ref<string>('')
const replyingToUserId = ref<string>('')
const messageInputRef = ref<any>(null)
const threadMessageDisplayRef = ref<InstanceType<typeof MessageDisplay> | null>(null)

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
const reactionsSubscription = ref<(() => void) | null>(null)

// Format helpers
const formatDate = (date: string | Date) => {
  return format(new Date(date), 'MMM d, yyyy \'at\' h:mm a')
}



// Load thread
const loadThread = async () => {
  // Check if we have cached messages - if so, show instantly without loading indicator
  const cachedMessages = threadService.getCachedMessages(props.threadId)
  if (cachedMessages) {
    // Use cached data instantly - no loading indicator
    messages.value = cachedMessages.messages
    hasMore.value = cachedMessages.has_more
    
    // Still load thread metadata in background
    thread.value = await threadService.getThread(props.threadId, false)
    isMember.value = thread.value?.is_member ?? true
    
    await nextTick()
    scrollToBottom()
    return
  }
  
  // No cache - show loading indicator
  loading.value = true
  try {
    thread.value = await threadService.getThread(props.threadId, false)
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

const toggleNotifications = async () => {
  if (!thread.value) return
  const newMuted = !isMuted.value
  isMuted.value = newMuted
  showOptions.value = false

  try {
    const { authContextService } = await import('@/services/AuthContextService')
    const profileId = await authContextService.getCurrentProfileId()

    const { error } = await supabase
      .from('thread_members')
      .update({ muted: newMuted })
      .eq('thread_id', thread.value.id)
      .eq('user_id', profileId)

    if (error) {
      isMuted.value = !newMuted
      console.error('Failed to toggle thread mute:', error)
    }
  } catch (error) {
    isMuted.value = !newMuted
    console.error('Failed to toggle thread mute:', error)
  }
}

const editThread = () => {
  showOptions.value = false
  if (!thread.value) return
  const newName = prompt('Edit thread name:', thread.value.name)
  if (newName && newName !== thread.value.name) {
    threadService.updateThread(thread.value.id, { name: newName }).then((updated) => {
      if (updated && thread.value) {
        thread.value.name = updated.name
      }
    })
  }
}

const closeThread = async () => {
  showOptions.value = false
  if (!thread.value) return
  try {
    await threadService.archiveThread(thread.value.id)
    if (thread.value) thread.value.archived = true
  } catch (error) {
    debug.error('Failed to close thread:', error)
  }
}

const reopenThread = async () => {
  showOptions.value = false
  if (!thread.value) return
  try {
    await threadService.unarchiveThread(thread.value.id)
    if (thread.value) thread.value.archived = false
  } catch (error) {
    debug.error('Failed to reopen thread:', error)
  }
}

const lockThread = async () => {
  showOptions.value = false
  if (!thread.value) return
  try {
    await threadService.lockThread(thread.value.id)
    if (thread.value) {
      thread.value.locked = true
      thread.value.archived = true
    }
  } catch (error) {
    debug.error('Failed to lock thread:', error)
  }
}

const unlockThread = async () => {
  showOptions.value = false
  if (!thread.value) return
  try {
    await threadService.unlockThread(thread.value.id)
    if (thread.value) thread.value.locked = false
  } catch (error) {
    debug.error('Failed to unlock thread:', error)
  }
}

const deleteThread = async () => {
  showOptions.value = false
  if (!thread.value) return
  if (!confirm(`Are you sure you want to delete "${thread.value.name}"? This cannot be undone.`)) return
  try {
    await threadService.deleteThread(thread.value.id)
    goBack()
  } catch (error) {
    debug.error('Failed to delete thread:', error)
  }
}

const copyThreadLink = async () => {
  showOptions.value = false
  if (!thread.value) return
  const url = `${window.location.origin}/chat/${props.serverId}/thread/${thread.value.id}`
  await navigator.clipboard.writeText(url)
}

const copyThreadId = async () => {
  showOptions.value = false
  if (!thread.value) return
  await navigator.clipboard.writeText(thread.value.id)
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
      const targetThreadId = thread.value.id
      const sendResult = await runWithEncryptionFallback(
        ({ allowPlaintextFallback }) =>
          threadService.sendThreadMessage(
            targetThreadId,
            messageParts,
            replyMessageId || replyingToMessageId.value || undefined,
            undefined,
            { allowPlaintextFallback },
          ),
        { scope: 'thread', contextKey: `thread:${targetThreadId}` },
      )

      if (sendResult.status === 'ok' && sendResult.result) {
        const newMessage = sendResult.result
        messages.value.push(newMessage)
        // Update cache
        threadService.addMessageToCache(targetThreadId, newMessage)
        messageText.value = ''
        // Clear reply state
        replyingToMessageId.value = ''
        replyingToUserName.value = ''
        replyingToUserId.value = ''
        await nextTick()
        scrollToBottom()
      } else if (sendResult.status === 'error') {
        debug.error('Failed to send thread message:', sendResult.error)
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
  if (!currentUserId.value) return
  try {
    await reactionsStore.toggleReaction(messageId, emoji.id, currentUserId.value, emoji)
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
    await chatStore.addReaction(selectedMessageId.value, emoji.id, authStore.session.user.id, emoji)
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

const toggleEmojiListForInput = (isReaction: boolean, _message?: Message) => {
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

// Handle sending a voice message
const handleSendVoiceMessage = async (data: { url: string, duration: number, waveform: number[], mimeType: string }) => {
  if (!thread.value) return

  sending.value = true
  try {
    const messageParts: MessagePart[] = [{
      type: 'file',
      url: data.url,
      fileType: 'audio',
      fileName: 'Voice message',
    }]

    const voiceMetadata = {
      voice_message: {
        duration: data.duration,
        waveform: data.waveform,
      },
    }

    const targetThreadId = thread.value.id
    const sendResult = await runWithEncryptionFallback(
      ({ allowPlaintextFallback }) =>
        threadService.sendThreadMessage(targetThreadId, messageParts, undefined, voiceMetadata, {
          allowPlaintextFallback,
        }),
      { scope: 'thread', contextKey: `thread:${targetThreadId}` },
    )

    if (sendResult.status === 'ok' && sendResult.result) {
      const newMessage = sendResult.result
      messages.value.push(newMessage)
      threadService.addMessageToCache(targetThreadId, newMessage)
      await nextTick()
      scrollToBottom()
    } else if (sendResult.status === 'error') {
      debug.error('Error sending voice message in thread:', sendResult.error)
    }
  } catch (error) {
    debug.error('Error sending voice message in thread:', error)
  } finally {
    sending.value = false
  }
}

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
      fileType: isVideoMessageUrl(gifUrl) ? 'video' : 'image'
    }]
    
    const targetThreadId = thread.value.id
    const sendResult = await runWithEncryptionFallback(
      ({ allowPlaintextFallback }) =>
        threadService.sendThreadMessage(targetThreadId, messageParts, replyingToMessageId.value || undefined, undefined, {
          allowPlaintextFallback,
        }),
      { scope: 'thread', contextKey: `thread:${targetThreadId}` },
    )

    if (sendResult.status === 'ok' && sendResult.result) {
      const newMessage = sendResult.result
      messages.value.push(newMessage)
      // Update cache
      threadService.addMessageToCache(targetThreadId, newMessage)
      replyingToMessageId.value = ''
      replyingToUserName.value = ''
      replyingToUserId.value = ''
      await nextTick()
      scrollToBottom()
    } else if (sendResult.status === 'error') {
      debug.error('Failed to send GIF:', sendResult.error)
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

const handleReplyingTo = (messageId: string, displayName?: string, userId?: string) => {
  // Set reply state
  replyingToMessageId.value = messageId
  replyingToUserId.value = userId || ''
  
  if (displayName) {
    replyingToUserName.value = displayName
  } else {
    // Fallback: find the message and get user display name
    const replyMessage = messages.value.find(m => m.id === messageId)
    if (replyMessage) {
      replyingToUserName.value = getDisplayName(replyMessage.user_id ?? '').value
      if (!replyingToUserId.value && replyMessage.user_id) replyingToUserId.value = replyMessage.user_id
    }
  }
}

const handleCancelReply = (value: string) => {
  if (!value) {
    replyingToMessageId.value = ''
    replyingToUserName.value = ''
    replyingToUserId.value = ''
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
        // Update cache
        threadService.addMessageToCache(thread.value!.id, newMessage)
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
          // Update cache
          if (thread.value?.id) {
            threadService.removeMessageFromCache(thread.value.id, payloadNew.id)
          }
          debug.log('🗑️ Thread message soft-deleted via realtime:', payloadNew.id)
        }
        return
      }
      
      // Handle message edits
      const index = messages.value.findIndex(m => m.id === payloadNew.id)
      if (index !== -1) {
        const updatedMessage: Message = {
          ...messages.value[index],
          content: payloadNew.content,
          updated_at: payloadNew.updated_at ? new Date(payloadNew.updated_at) : undefined,
          metadata: payloadNew.metadata || null,
        }
        messages.value[index] = updatedMessage
        // Update cache
        if (thread.value?.id) {
          threadService.updateMessageInCache(thread.value.id, payloadNew.id, updatedMessage)
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
        // Update cache
        if (thread.value?.id) {
          threadService.removeMessageFromCache(thread.value.id, payloadOld.id)
        }
        debug.log('🗑️ Thread message deleted via realtime:', payloadOld.id)
      }
    },
  })
  
  debug.log(`📡 Subscribed to thread messages: ${channelName}`)
}

const cleanupReactionsSubscription = () => {
  if (reactionsSubscription.value) {
    reactionsSubscription.value()
    reactionsSubscription.value = null
  }
}

/** Full thread route does not run ChatView.subscribeToMessages - mirror channel reactions CDC here. */
const setupReactionsSubscription = () => {
  cleanupReactionsSubscription()
  if (!thread.value?.channel_id || !thread.value?.id) return

  const channelName = `thread-full-reactions-${thread.value.id}`
  reactionsSubscription.value = realtimeConnectionManager.subscribeToTable({
    channelName,
    table: 'reactions',
    filter: `channel_id=eq.${thread.value.channel_id}`,
    onInsert: (payload) => {
      const messageId = (payload.new as any)?.message_id
      if (messageId) void reactionsStore.handleRealtimeUpdate(payload)
    },
    onDelete: (payload) => {
      const messageId = (payload.old as any)?.message_id
      if (messageId) void reactionsStore.handleRealtimeUpdate(payload)
    },
  })
  debug.log(`📡 Subscribed to thread reactions: ${channelName}`)
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
    setupReactionsSubscription()
  } else {
    // Clean up subscription when thread is unloaded
    if (threadSubscription.value) {
      threadSubscription.value()
      threadSubscription.value = null
    }
    cleanupReactionsSubscription()
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
  cleanupReactionsSubscription()
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

.option-item.danger {
  color: #ed4245;
}

.option-item.danger:hover {
  background: rgba(237, 66, 69, 0.1);
}

.option-item.danger svg {
  color: #ed4245;
}

.options-divider {
  height: 1px;
  background: var(--border-color, var(--h-black-lighter));
  margin: 4px 8px;
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
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 16px 20px;
  min-height: 0;
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

