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
                  <DisplayName :userId="displayParentMessage.user_id" />
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

          <!-- Thread Messages - Reuse MessageDisplay component (DRY) -->
          <div class="thread-messages" ref="messagesContainer">
            <div v-if="loading" class="loading-state">
              <LoadingSpinner :size="32" />
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
              
              <!-- Use the same MessageDisplay component as the main chat -->
              <MessageDisplay
                ref="threadMessageDisplayRef"
                :messages="messages"
                :current-user-id="currentUserId"
                :channel-id="thread?.channel_id"
                :thread-id="thread?.id"
                :is-loading="loading"
                :hide-thread-actions="true"
                :enable-read-divider="false"
                @send-reaction="handleSendReaction"
                @toggle-emoji-list="handleToggleEmojiList"
                @replying-to="handleReplyingTo"
              />
            </template>
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
            :thread-id="effectiveThreadIdForTyping"
            @send-message="handleSendMessage"
            @send-voice-message="handleSendVoiceMessage"
            @update:reply-message-id="handleCancelReply"
            @toggle-giphy="toggleGiphy"
            @toggle-emoji-list="toggleEmojiListForInput"
            @edit-last-message="threadMessageDisplayRef?.editLastOwnMessage()"
            @send-gif="handleSendGif"
          />
        </div>
      </div>
    </Transition>
    
    <!-- Emoji Popup for reactions -->
    <EmojiPopup
      v-if="reactionEmojiOpen"
      @click.stop
      @sendEmoji="handleSendEmoji"
      :closeEmojiList="closeReactionEmoji"
      :emojiIconClicked="emojiIconClicked"
      :position="'left'"
      :triggerElement="(reactionTriggerElement as any) || undefined"
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
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { supabase } from '@/supabase'
import { threadService } from '@/services/ThreadService'
import { useUserData } from '@/composables/useUserData'
import { useEncryptionFallbackPrompt } from '@/composables/useEncryptionFallbackPrompt'
import { useProfileStore } from '@/stores/useProfile'
import { format } from 'date-fns'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import UnifiedMessageContent from '@/components/UnifiedMessageContent.vue'
import MessageInput from '@/components/MessageInput.vue'
import MessageDisplay from '@/components/MessageDisplay.vue'
import EmojiPopup from '@/components/EmojiPopup.vue'
import MediaPickerPopup from '@/components/MediaPickerPopup.vue'
import { useChatStore } from '@/stores/useChat'
import { useDraftsStore } from '@/stores/drafts'
import { useThemeStore } from '@/stores/useTheme'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData } from '@/utils/unifiedContentProcessing'
import { debug } from '@/utils/debug'
import { isVideoMessageUrl } from '@/utils/klipyAttribution'
import { realtimeConnectionManager } from '@/services/RealtimeConnectionManager'
import type { Message, MessagePart, Emoji, Gif } from '@/types'
import type { ThreadWithDetails } from '@/services/ThreadService'
import type { FilePreviewData } from '@/components/FilePreview.vue'

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

const chatStore = useChatStore()
const draftsStore = useDraftsStore()
const themeStore = useThemeStore()
const serverChannelStore = useServerChannelStore()
const { canManageChannels } = useServerPermissions()
const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()

const canManageThread = computed(() => canManageChannels.value)

// Current user identity for MessageDisplay / reactions. App data keys on
// profiles.id (not the auth user id), so this must be the profile id.
const profileStore = useProfileStore()
const currentUserId = computed(() => profileStore.profileId)

/** Thread id for composer + typing presence (includes draft threads before DB row exists) */
const effectiveThreadIdForTyping = computed(() => {
  if (props.threadId) return props.threadId
  if (props.initialThread?.id) return props.initialThread.id
  if (thread.value?.id) return thread.value.id
  if (props.draftParentMessage?.id) return `draft:${props.draftParentMessage.id}`
  return undefined
})

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
const loading = ref(false)
const loadingMore = ref(false)
const hasMore = ref(false)
const isMember = ref(true) // Default to true to allow sending
const joining = ref(false)
const showOptions = ref(false)
const messageText = ref('')
const sending = ref(false)

// Draft persistence for threads
const threadDraftKey = computed(() => {
  const id = props.threadId || props.initialThread?.id
  return id ? draftsStore.makeKey('thread', id) : null
})

watch(threadDraftKey, (newKey, oldKey) => {
  if (oldKey && messageText.value.trim()) {
    draftsStore.saveDraft(oldKey, messageText.value)
  }
  messageText.value = newKey ? draftsStore.getDraft(newKey) : ''
}, { immediate: true })

watch(messageText, (val) => {
  if (threadDraftKey.value) {
    draftsStore.saveDraft(threadDraftKey.value, val)
  }
})
const messagesContainer = ref<HTMLElement | null>(null)
const threadSubscription = ref<(() => void) | null>(null)

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
    // find() doesn't narrow the discriminated union, so cast to access .text safely.
    const text = Array.isArray(props.draftParentMessage.content)
      ? ((props.draftParentMessage.content.find(p => p.type === 'text') as any)?.text || 'Thread')
      : 'Thread'
    return text.substring(0, 50) + (text.length > 50 ? '...' : '')
  }
  return 'Thread'
})


// Load thread data
const loadThread = async () => {
  // In draft mode, don't load - just show parent message
  if (isDraftMode.value) {
    thread.value = null
    loading.value = false
    messages.value = []
    return
  }
  
  const threadId = props.threadId || props.initialThread?.id
  if (!threadId) return
  
  // Check if we have cached messages - if so, show instantly without loading indicator
  const cachedMessages = threadService.getCachedMessages(threadId)
  if (cachedMessages) {
    // Use cached data instantly - no loading indicator
    messages.value = cachedMessages.messages
    hasMore.value = cachedMessages.has_more
    
    // Still load thread metadata in background (for fresh membership status, etc.)
    thread.value = await threadService.getThread(threadId, false) // use cache if available
    isMember.value = thread.value?.is_member ?? true
    
    // Scroll to bottom
    await nextTick()
    scrollToBottom()
    return
  }
  
  // No cache - show loading indicator
  loading.value = true
  try {
    // Fetch thread data
    thread.value = await threadService.getThread(threadId, false)
    
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
    const { authContextService } = await import('@/services/AuthContextService')
    const profileId = await authContextService.getCurrentProfileId()
    const newMuted = !thread.value.muted

    const { error } = await supabase
      .from('thread_members')
      .update({ muted: newMuted })
      .eq('thread_id', thread.value.id)
      .eq('user_id', profileId)

    if (error) {
      console.error('Failed to toggle thread mute:', error)
    } else if (thread.value) {
      thread.value.muted = newMuted
    }
    showOptions.value = false
  } catch (error) {
    console.error('Failed to toggle mute:', error)
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
        emit('thread-updated', thread.value)
      }
    })
  }
}

const closeThread = async () => {
  showOptions.value = false
  if (!thread.value) return
  try {
    await threadService.archiveThread(thread.value.id)
    if (thread.value) {
      thread.value.archived = true
      emit('thread-updated', thread.value)
    }
  } catch (error) {
    debug.error('Failed to close thread:', error)
  }
}

const reopenThread = async () => {
  showOptions.value = false
  if (!thread.value) return
  try {
    await threadService.unarchiveThread(thread.value.id)
    if (thread.value) {
      thread.value.archived = false
      emit('thread-updated', thread.value)
    }
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
      emit('thread-updated', thread.value)
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
    if (thread.value) {
      thread.value.locked = false
      emit('thread-updated', thread.value)
    }
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
    close()
  } catch (error) {
    debug.error('Failed to delete thread:', error)
  }
}

const copyThreadLink = async () => {
  showOptions.value = false
  if (!thread.value) return
  const serverId = serverChannelStore.currentServerId
  if (serverId) {
    const url = `${window.location.origin}/chat/${serverId}/thread/${thread.value.id}`
    await navigator.clipboard.writeText(url)
  }
}

const copyThreadId = async () => {
  showOptions.value = false
  if (!thread.value) return
  await navigator.clipboard.writeText(thread.value.id)
}

// Use unified content parsing system (DRY - same as ChatComponent)
const parseMessageInput = async (input: string): Promise<MessagePart[]> => {
  debug.log('🔧 ThreadView: Using unified content parsing for:', input)
  
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
  if ((!content.trim() && files.length === 0) || sending.value) return
  if (isDraftMode.value && !props.draftParentMessage) return
  if (!isDraftMode.value && !thread.value) return
  
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
  
  // Clear input immediately for responsiveness
  const savedContent = content
  messageText.value = ''
  if (threadDraftKey.value) draftsStore.clearDraft(threadDraftKey.value)
  const savedReplyTo = replyMessageId || replyingToMessageId.value || undefined
  replyingToMessageId.value = ''
  replyingToUserName.value = ''
  replyingToUserId.value = ''
  
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
      
      emit('thread-created', thread.value!, props.draftParentMessage)
    }
    
    if (!targetThreadId) {
      throw new Error('No thread ID')
    }
    
    const messageParts: MessagePart[] = []
    
    if (savedContent.trim()) {
      const parsedMessage = await parseMessageInput(savedContent)
      messageParts.push(...parsedMessage)
    }
    
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
    
    if (messageParts.length > 0) {
      // Optimistic: add a temporary message immediately
      const tempId = `temp-${crypto.randomUUID()}`
      const { authContextService } = await import('@/services/AuthContextService')
      const profileId = await authContextService.getCurrentProfileId()
      // reply_to/metadata are optional strings/objects in the Message type; use
      // undefined instead of null to satisfy the optional-property shape.
      const optimisticMessage: Message = {
        id: tempId,
        created_at: new Date(),
        channel_id: thread.value?.channel_id || '',
        user_id: profileId,
        content: messageParts,
        thread_id: targetThreadId,
        reply_to: savedReplyTo || undefined,
        is_system: false,
        encrypted: false,
        reactions: [],
        metadata: undefined,
      }
      messages.value.push(optimisticMessage)
      
      // Optimistic thread count update
      if (thread.value) {
        thread.value.message_count = (thread.value.message_count || 0) + 1
        thread.value.last_message_at = new Date().toISOString()
      }
      
      await nextTick()
      scrollToBottom()
      
      // Send to DB (fail-closed + plaintext override prompt)
      const sendResult = await runWithEncryptionFallback(
        ({ allowPlaintextFallback }) =>
          threadService.sendThreadMessage(targetThreadId!, messageParts, savedReplyTo, undefined, {
            allowPlaintextFallback,
          }),
        { scope: 'thread' },
      )

      if (sendResult.status === 'ok' && sendResult.result) {
        const newMessage = sendResult.result
        // Replace optimistic message with real one
        const tempIndex = messages.value.findIndex(m => m.id === tempId)
        if (tempIndex !== -1) {
          messages.value[tempIndex] = newMessage
        }
        threadService.addMessageToCache(targetThreadId, newMessage)
      } else {
        // Remove optimistic message on declined or failed send
        const tempIndex = messages.value.findIndex(m => m.id === tempId)
        if (tempIndex !== -1) {
          messages.value.splice(tempIndex, 1)
        }
        if (thread.value) {
          thread.value.message_count = Math.max(0, (thread.value.message_count || 1) - 1)
        }
        if (sendResult.status === 'error') {
          debug.error('Failed to send thread message:', sendResult.error)
        }
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


const close = () => {
  cleanupSubscription() // Unsubscribe when closing
  emit('close')
}

// MessageDisplay event handlers
const handleSendReaction = async (messageId: string, emoji: Emoji) => {
  if (!currentUserId.value) return
  try {
    themeStore.playAudio('reaction')
    const { useReactionsStore } = await import('@/stores/useReactions')
    const reactionsStore = useReactionsStore()
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
  if (isPopupForReaction.value && currentUserId.value) {
    themeStore.playAudio('reaction')
    await chatStore.addReaction(selectedMessageId.value, emoji.id, currentUserId.value, emoji)
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
  if (!thread.value && !isDraftMode.value) return

  sending.value = true
  try {
    let targetThreadId = thread.value?.id

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
      emit('thread-created', thread.value!, props.draftParentMessage)
    }

    if (!targetThreadId) {
      throw new Error('No thread ID')
    }

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

    const tempId = `temp-${crypto.randomUUID()}`
    const { authContextService } = await import('@/services/AuthContextService')
    const profileId = await authContextService.getCurrentProfileId()
    const optimisticMessage: Message = {
      id: tempId,
      created_at: new Date(),
      channel_id: thread.value?.channel_id || '',
      user_id: profileId,
      content: messageParts,
      thread_id: targetThreadId,
      reply_to: undefined,
      is_system: false,
      encrypted: false,
      reactions: [],
      metadata: voiceMetadata,
    }
    messages.value.push(optimisticMessage)

    if (thread.value) {
      thread.value.message_count = (thread.value.message_count || 0) + 1
      thread.value.last_message_at = new Date().toISOString()
    }

    await nextTick()
    scrollToBottom()

    const sendResult = await runWithEncryptionFallback(
      ({ allowPlaintextFallback }) =>
        threadService.sendThreadMessage(targetThreadId!, messageParts, undefined, voiceMetadata, {
          allowPlaintextFallback,
        }),
      { scope: 'thread' },
    )

    if (sendResult.status === 'ok' && sendResult.result) {
      const newMessage = sendResult.result
      const tempIndex = messages.value.findIndex(m => m.id === tempId)
      if (tempIndex !== -1) {
        messages.value[tempIndex] = newMessage
      }
      threadService.addMessageToCache(targetThreadId, newMessage)
    } else {
      const tempIndex = messages.value.findIndex(m => m.id === tempId)
      if (tempIndex !== -1) {
        messages.value.splice(tempIndex, 1)
      }
      if (thread.value) {
        thread.value.message_count = Math.max(0, (thread.value.message_count || 1) - 1)
      }
      if (sendResult.status === 'error') {
        debug.error('Error sending voice message in thread:', sendResult.error)
      }
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
  
  if (!thread.value && !isDraftMode.value) return
  
  sending.value = true
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
      emit('thread-created', thread.value!, props.draftParentMessage)
    }
    
    if (!targetThreadId) {
      throw new Error('No thread ID')
    }
    
    const messageParts: MessagePart[] = [{
      type: 'file',
      url: gifUrl,
      fileType: isVideoMessageUrl(gifUrl) ? 'video' : 'image'
    }]
    
    const sendResult = await runWithEncryptionFallback(
      ({ allowPlaintextFallback }) =>
        threadService.sendThreadMessage(targetThreadId!, messageParts, replyingToMessageId.value || undefined, undefined, {
          allowPlaintextFallback,
        }),
      { scope: 'thread' },
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
      replyingToUserName.value = getDisplayName(replyMessage.user_id).value
      if (!replyingToUserId.value) replyingToUserId.value = replyMessage.user_id ?? ''
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

// Clean up subscription helper (defined before use)
const cleanupSubscription = () => {
  if (threadSubscription.value) {
    threadSubscription.value()
    threadSubscription.value = null
    debug.log('📡 Unsubscribed from thread messages')
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
    
    onInsert: async (payload) => {
      const payloadNew = payload.new as any
      
      // Skip if already in messages (non-optimistic duplicate)
      if (messages.value.some(m => m.id === payloadNew.id)) {
        return
      }
      
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
        
        // Replace the oldest optimistic temp message with matching content
        const tempIndex = messages.value.findIndex(
          m => m.id.startsWith('temp-') && m.user_id === payloadNew.user_id
            && JSON.stringify(m.content) === JSON.stringify(payloadNew.content)
        )
        if (tempIndex !== -1) {
          messages.value[tempIndex] = newMessage
        } else {
          messages.value.push(newMessage)
        }

        // Update thread count
        if (thread.value) {
          thread.value.message_count = (thread.value.message_count || 0) + (tempIndex === -1 ? 1 : 0)
          thread.value.last_message_at = payloadNew.created_at
        }

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

// Watch for visibility changes
watch(() => props.isVisible, (visible) => {
  if (visible) {
    loadThread()
  } else {
    // When thread becomes invisible, cleanup subscription immediately
    cleanupSubscription()
  }
})

watch(() => props.threadId, () => {
  if (props.isVisible) {
    loadThread()
  }
})

// Setup realtime when thread is loaded AND visible
watch(() => [thread.value?.id, props.isVisible] as const, ([threadId, isVisible]) => {
  if (threadId && isVisible) {
    setupRealtimeSubscription()
  } else {
    // Clean up subscription when thread is unloaded or becomes invisible
    cleanupSubscription()
  }
}, { immediate: true })

// Also watch isVisible separately to unsubscribe immediately when closed
watch(() => props.isVisible, (isVisible) => {
  if (!isVisible) {
    cleanupSubscription()
  } else if (thread.value?.id) {
    // If becoming visible and thread is loaded, subscribe
    setupRealtimeSubscription()
  }
})

onMounted(() => {
  if (props.isVisible) {
    loadThread()
  }
})

// Cleanup on unmount
onUnmounted(() => {
  cleanupSubscription()
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

.option-item.danger {
  color: #ed4245;
}

.option-item.danger:hover {
  background: rgba(237, 66, 69, 0.1);
}

.options-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 8px;
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
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 16px 0;
  min-height: 0;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px;
  color: var(--text-secondary);
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
