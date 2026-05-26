<template>
  <div class="chat-container" 
      @dragenter.prevent="handleDragEnter"
      @dragover.prevent="handleDragOver"
      @dragleave.prevent="handleDragLeave"
      @drop.prevent="triggerFileDrop">
    <div v-if="showDragDropArea" 
      class="drag-drop-area"
      @dragleave.prevent="handleDragLeave">
      <div v-if="uploading" class="upload-status">{{ t('chat.uploading') }}</div>
      <div v-else>{{ t('chat.dropFilesHere') }}</div>
    </div>

    <MessageDisplay 
      ref="messageDisplayRef"
      :messages="messages" 
      :isLoading="isLoading"
      :currentUserId="currentUserId"
      :loadMoreMessages="props.loadMoreMessages"
      :channelId="props.channelId"
      :conversationId="props.conversationId"
      @toggleEmojiList="toggleEmojiList"
      @sendReaction="toggleReaction"
      @replyingTo="replyingTo"
      @createThread="handleCreateThread"
      @showAllThreads="handleShowAllThreads"
      @mentionUser="(username: string) => { messageContent += `@${username} `; }"
      @retry-message="handleRetryMessage"
      @discard-message="handleDiscardMessage"
    />
    
    <!-- Encryption setup wizard (launched from status bar prompt) -->
    <Teleport to="body">
      <RecoveryKeySetupWizard
        v-if="showEncryptionSetupWizard"
        @close="showEncryptionSetupWizard = false"
        @complete="handleEncryptionSetupComplete"
      />
    </Teleport>

    <!-- Send error feedback -->
    <div v-if="sendError" class="encryption-status-bar error" @click="sendError = null">
      <span class="encryption-status-icon">⚠️</span>
      <span class="encryption-status-text">{{ sendError }}</span>
    </div>

    <!-- Encryption status tag (inline, floated right of typing indicator) -->
    <div class="input-status-row">
      <div v-if="encryptionStatus" :class="['encryption-status-tag', encryptionStatus.level]">
        <span class="encryption-status-icon">{{ encryptionStatus.icon }}</span>
        <span class="encryption-status-text">{{ encryptionStatus.text }}</span>
        <button
          v-if="encryptionStatus.showSetup"
          class="encryption-setup-btn"
          @click="showEncryptionSetupWizard = true"
        >
          {{ t('chat.setupNow') }}
        </button>
      </div>
    </div>

    <MessageInput 
      ref="messageInputRef"
      v-model="messageContent"
      :giphyOpen="giphyOpen"
      :emojiListOpen="emojiListOpen"
      :reply-message-id="replyToMessageId"
      :reply-user-display-name="replyToUserDisplayName"
      :reply-user-id="replyToUserId"
      :channel-name="effectiveChannelName"
      :username="effectiveDMUsername"
      :channel-id="props.channelId"
      :conversation-id="props.conversationId"
      @toggleGiphy="toggleGiphy"
      @toggleEmojiList="toggleEmojiList"
      @sendMessage="handleSendMessage"
      @sendVoiceMessage="handleSendVoiceMessage"
      @update:replyMessageId="handleDontReply"
      @upload-status-changed="handleUploadStatusChanged"
      @edit-last-message="handleEditLastMessage"
      @sendGif="handleSendGif"
    />
    <!-- Media Picker (GIFs + Emoji) for message input -->
    <MediaPickerPopup
      v-if="mediaPickerOpen"
      @click.stop
      @sendGif="handleSendGif"
      @sendEmoji="handleSendEmoji"
      :closePopup="closeMediaPicker"
      :position="'above'"
      :triggerElement="(mediaPickerTriggerElement as unknown as HTMLElement | null) || undefined"
      :initialTab="mediaPickerInitialTab"
    />

    <!-- Emoji Popup for message reactions.
         EmojiPopup teleports itself to <body>, so no outer Teleport wrapper
         needed — that avoids transform/overflow containment from virtual
         scroll ancestors automatically. See EmojiPopup.vue template. -->
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
    
    <!-- Thread View -->
    <ThreadView
      :is-visible="showThreadView"
      :thread-id="selectedThreadId"
      :initial-thread="selectedThread"
      :draft-parent-message="draftParentMessage"
      :channel-id="props.channelId"
      @close="closeThreadView"
      @thread-updated="handleThreadUpdated"
      @thread-created="handleThreadCreated"
    />

    <KickBanModal
      v-if="showKickBanModal && !props.isDM"
      :show="showKickBanModal"
      :mode="kickBanMode"
      :user="kickBanTargetUser"
      :server-id="serverChannelStore.currentServerId!"
      @close="showKickBanModal = false"
      @done="handleKickBanDone"
    />
  </div>
</template>

<script setup lang="ts">
  import { ref, onMounted, computed, watch, onUnmounted, defineAsyncComponent } from 'vue';
  import MessageDisplay from './MessageDisplay.vue';
  import MessageInput from './MessageInput.vue';
  import KickBanModal from './moderation/KickBanModal.vue';
  const RecoveryKeySetupWizard = defineAsyncComponent(() => import('@/components/encryption/RecoveryKeySetupWizard.vue'));
  import { useAuthStore } from '@/stores/auth'; 
  import { useChatStore } from '@/stores/useChat';
  import { useServerChannelStore } from '@/stores/useServerChannel'; 
  import { useDMStore } from '@/stores/useDM';
  import { useThemeStore } from '@/stores/useTheme';
  import { useDraftsStore } from '@/stores/drafts';
  import type { Message, Gif, Emoji, MessagePart } from '@/types';
  import { recordEmojiUsage } from '@/services/emojiService';
  import { getEmojiShortcodeForInsert } from '@/services/emojiShortcodeResolver';
  import { listen } from '@tauri-apps/api/event';
  import { readFile } from '@tauri-apps/plugin-fs';
  import MediaPickerPopup from '@/components/MediaPickerPopup.vue';
  import EmojiPopup from '@/components/EmojiPopup.vue';
  import ThreadView from '@/components/threads/ThreadView.vue';
  import type { FilePreviewData } from '@/components/FilePreview.vue';
  import { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData, resolveRoleMentionsData } from '@/utils/unifiedContentProcessing';
  import { useEmojiCacheStore } from '@/stores/useEmojiCache';
  import { threadService } from '@/services/ThreadService';
  import { coreMessageService } from '@/services/core/CoreMessageService';
  import { useEncryptionFallbackPrompt } from '@/composables/useEncryptionFallbackPrompt';
  import { supabase } from '@/supabase';
  import { debug } from '@/utils/debug';
  import { useUserData } from '@/composables/useUserData';
  import { useServerPermissions } from '@/composables/useServerPermissions';
  import { useI18n } from 'vue-i18n';

  // FIXME: probably breaking the __TAURI__ implementation if we declare it here
  declare const __TAURI__: any;

  interface Props {
    messages: Message[];
    isLoading?: boolean;
    loadMoreMessages?: () => void;
    isDM?: boolean;
    channelId?: string;
    conversationId?: string;
    channelName?: string;
    dmUsername?: string;
  }

  const props = withDefaults(defineProps<Props>(), {
    isLoading: false,
    isDM: false,
  });

  interface Emits {
    (e: 'loadMoreMessages'): void;
    (e: 'showAllThreads'): void;
  }

  const emit = defineEmits<Emits>();

  const { t } = useI18n();
  const chatStore = useChatStore();
  const authStore = useAuthStore();
  const serverChannelStore = useServerChannelStore();
  const dmStore = useDMStore();
  const themeStore = useThemeStore();
  const draftsStore = useDraftsStore();
  const { hasCurrentUserPermission, Permission, isCurrentUserServerOwner } = useServerPermissions();
  
  const showDragDropArea = ref(false);
  const uploading = ref(false);
  const sendError = ref<string | null>(null);

  // Slash command moderation modal
  const showKickBanModal = ref(false);
  const kickBanMode = ref<'kick' | 'ban'>('kick');
  const kickBanTargetUser = ref({ id: '', username: '', display_name: '', avatar_url: null as string | null });

  function handleSlashCommand(e: Event) {
    const { command } = (e as CustomEvent).detail;
    if (command === 'kick' || command === 'ban') {
      if (props.isDM || !serverChannelStore.currentServerId) return;
      
      const requiredPerm = command === 'kick' ? Permission.KICK_MEMBERS : Permission.BAN_MEMBERS;
      if (!isCurrentUserServerOwner.value && !hasCurrentUserPermission(requiredPerm)) return;
      
      kickBanMode.value = command;
      kickBanTargetUser.value = { id: '', username: '', display_name: '', avatar_url: null };
      showKickBanModal.value = true;
    }
  }

  function handleKickBanDone(result: { success: boolean }) {
    showKickBanModal.value = false;
  }
  
  // Media picker state (unified GIF + Emoji picker)
  const mediaPickerOpen = ref(false);
  const mediaPickerInitialTab = ref<'gifs' | 'emoji'>('gifs');
  
  // Reaction emoji picker (separate for positioning on messages)
  const reactionEmojiOpen = ref(false);
  const isPopupForReaction = ref(false);
  const selectedMessageId = ref('');
  const replyToMessageId = ref('');
  const replyToUserDisplayName = ref('');
  const replyToUserId = ref('');
  const messageContent = ref('');

  // Draft persistence
  const draftKey = computed(() => {
    if (props.isDM && props.conversationId) {
      return draftsStore.makeKey('conversation', props.conversationId);
    }
    if (props.channelId) {
      return draftsStore.makeKey('channel', props.channelId);
    }
    return null;
  });

  // Load draft when context changes
  watch(draftKey, (newKey, oldKey) => {
    if (oldKey && messageContent.value.trim()) {
      draftsStore.saveDraft(oldKey, messageContent.value);
    }
    messageContent.value = newKey ? draftsStore.getDraft(newKey) : '';
  }, { immediate: true });

  // Save draft on content change (debounced inside the store)
  watch(messageContent, (val) => {
    if (draftKey.value) {
      draftsStore.saveDraft(draftKey.value, val);
    }
  });
  
  // Legacy compatibility
  const giphyOpen = computed(() => mediaPickerOpen.value && mediaPickerInitialTab.value === 'gifs');
  const emojiListOpen = computed(() => mediaPickerOpen.value && mediaPickerInitialTab.value === 'emoji');
  
  // Thread state
  const showThreadView = ref(false);
  const selectedThreadId = ref<string | undefined>();
  const selectedThread = ref<any>(null);
  
  // Component refs
  const messageInputRef = ref<InstanceType<typeof MessageInput> | null>(null);
  
  // Trigger element references for positioning
  const reactionTriggerElement = ref<HTMLElement | null>(null);
  
  // Computed trigger refs from MessageInput
  const gifTriggerElement = computed(() => messageInputRef.value?.gifTriggerRef || null);
  const emojiTriggerElement = computed(() => messageInputRef.value?.emojiTriggerRef || null);
  
  // Media picker uses GIF trigger as default
  const mediaPickerTriggerElement = computed(() => gifTriggerElement.value || emojiTriggerElement.value);
  
      const messageDisplayRef = ref<InstanceType<typeof MessageDisplay> | null>(null);
      const currentUserId = computed(() => authStore.session?.user?.id);
      const hasActiveUploads = ref(false);
      
      // Computed channel name - use prop or fallback to store lookup
      const effectiveChannelName = computed(() => {
        if (props.channelName) return props.channelName;
        // Fallback: try to get from store
        if (!props.isDM && props.channelId) {
          const channel = serverChannelStore.channels.find(ch => ch.id === props.channelId);
          return channel?.name;
        }
        return undefined;
      });
      
      // Computed DM username - use prop or fallback to store lookup
      const effectiveDMUsername = computed(() => {
        if (props.dmUsername) return props.dmUsername;
        // Fallback: try to get from store
        if (props.isDM) {
          const conversation = dmStore.getCurrentConversation;
          // `other_participants` is a legacy view-model field; the canonical
          // store key is `participants`. Read via `any` to cover both shapes.
          const otherParticipant = (conversation as any)?.other_participants?.[0] || (conversation as any)?.participants?.[0];
          return otherParticipant?.display_name || otherParticipant?.username;
        }
        return undefined;
      });
      
      
      // Computed property to check if running in Tauri
      const isTauri = computed(() => {
        return typeof __TAURI__ !== 'undefined';
      });
      const gifIconClicked = ref(false);
      const emojiIconClicked = ref(false);

      // Encryption status tracking
      const encryptionStatusData = ref<{ level: string; icon: string; text: string; showSetup?: boolean } | null>(null)
      const showEncryptionSetupWizard = ref(false)

      const encryptionStatus = computed(() => encryptionStatusData.value)

      async function checkEncryptionStatus() {
        if (props.isDM) {
          await checkDMEncryptionStatus()
          return
        }
        const serverId = serverChannelStore.currentServerId
        if (!serverId) {
          encryptionStatusData.value = null
          return
        }
        try {
          const { data: settings } = await supabase
            .from('server_encryption_settings')
            .select('encryption_mode, force_key_setup')
            .eq('server_id', serverId)
            .maybeSingle()

          const mode = settings?.encryption_mode || 'disabled'
          const forceSetup = settings?.force_key_setup || false

          if (mode === 'disabled') {
            encryptionStatusData.value = null
            return
          }

          const module = await import('@/services/encryption/MegolmMessageEncryptionService')
          const svc = module.megolmMessageEncryptionService
          if (!svc.isInitialized()) {
            const { data: { session } } = await supabase.auth.getSession()
            if (session?.user?.id) await svc.initialize(session.user.id)
          }

          if (svc.isInitialized() && svc.isUnlocked()) {
            const hasKey = await svc.hasRecoveryKey()
            if (hasKey) {
              encryptionStatusData.value = { level: 'active', icon: '🔐', text: 'End-to-end encrypted' }
            } else {
              encryptionStatusData.value = null
            }
          } else {
            const hasKey = svc.isInitialized() ? await svc.hasRecoveryKey() : false
            if (hasKey) {
              encryptionStatusData.value = {
                level: 'locked',
                icon: '🔓',
                text: mode === 'required'
                  ? 'Encryption required - unlock in Settings > Encryption'
                  : 'Encryption available but locked - messages sent as plaintext'
              }
            } else if (mode === 'required') {
              encryptionStatusData.value = {
                level: 'error',
                icon: '⚠️',
                text: 'Encryption required - set up in Settings > Encryption',
                showSetup: true
              }
            } else if (forceSetup) {
              encryptionStatusData.value = {
                level: 'setup-prompt',
                icon: '🔑',
                text: 'This server recommends encryption - set up your keys to enable E2EE',
                showSetup: true
              }
            } else {
              encryptionStatusData.value = null
            }
          }
        } catch {
          encryptionStatusData.value = null
        }
      }

      async function checkDMEncryptionStatus() {
        const conversationId = props.conversationId
        if (!conversationId) {
          encryptionStatusData.value = null
          return
        }
        try {
          const { data } = await supabase
            .from('conversation_encryption_settings')
            .select('encryption_enabled')
            .eq('conversation_id', conversationId)
            .maybeSingle()

          const enabled = data?.encryption_enabled === true
          if (!enabled) {
            encryptionStatusData.value = null
            return
          }

          const module = await import('@/services/encryption/MegolmMessageEncryptionService')
          const svc = module.megolmMessageEncryptionService
          if (!svc.isInitialized()) {
            const { data: { session } } = await supabase.auth.getSession()
            if (session?.user?.id) await svc.initialize(session.user.id)
          }

          if (svc.isInitialized() && svc.isUnlocked()) {
            const hasKey = await svc.hasRecoveryKey()
            if (hasKey) {
              encryptionStatusData.value = { level: 'active', icon: '🔐', text: 'End-to-end encrypted' }
            } else {
              encryptionStatusData.value = {
                level: 'locked',
                icon: '🔓',
                text: 'Encryption enabled but keys not set up',
                showSetup: true
              }
            }
          } else {
            encryptionStatusData.value = {
              level: 'locked',
              icon: '🔓',
              text: 'Encryption enabled - unlock in Settings > Encryption',
              showSetup: true
            }
          }
        } catch {
          encryptionStatusData.value = null
        }
      }

      function handleEncryptionSetupComplete() {
        showEncryptionSetupWizard.value = false
        checkEncryptionStatus()
      }

      // Listen for DM encryption toggle events from DMHeader
      function handleDMEncryptionToggled(event: Event) {
        const detail = (event as CustomEvent).detail
        if (detail?.conversationId === props.conversationId) {
          checkEncryptionStatus()
        }
      }

      // Listen for server settings changes (encryption mode, etc.) via server-structure broadcast
      function handleServerSettingsChange(event: Event) {
        const detail = (event as CustomEvent).detail
        if (!props.isDM && detail?.table === 'server_encryption_settings') {
          checkEncryptionStatus()
        }
      }

      watch(
        () => serverChannelStore.currentServerId,
        () => { if (!props.isDM) checkEncryptionStatus() },
        { immediate: true }
      )

      watch(
        () => props.conversationId,
        () => { if (props.isDM) checkEncryptionStatus() },
        { immediate: true }
      )

      // Page leave protection
      const handleBeforeUnload = (event: BeforeUnloadEvent) => {
        if (hasActiveUploads.value) {
          event.preventDefault();
          event.returnValue = 'You have files uploading. Are you sure you want to leave?';
          return 'You have files uploading. Are you sure you want to leave?';
        }
      };

      const handleUploadStatusChanged = (uploading: boolean) => {
        hasActiveUploads.value = uploading;
      };

      const handleEncryptionFallback = (e: Event) => {
        // With the fail-closed policy this event is informational: the actual
        // ENCRYPTION_FAILED_NO_FALLBACK error is thrown by CoreMessageService
        // and shown via the confirm() flow. If the override was authorized
        // the message _was_ sent unencrypted, which is also worth surfacing.
        const detail = (e as CustomEvent).detail || {}
        sendError.value = detail.failClosed
          ? 'Encryption failed - message NOT sent (confirm fallback to send unencrypted)'
          : 'Encryption failed - message sent unencrypted'
        setTimeout(() => { sendError.value = null }, 6000)
      };

      /**
       * Cross-component mention insertion. UserSidebar (and any other
       * surface that doesn't have a direct emit path into ChatComponent —
       * e.g. context menus living outside the chat subtree) fires
       * `harmony-insert-mention` with a `{ handle, username }` payload.
       * We just append it to the active draft, same way as the existing
       * `@mentionUser` listener handles mentions clicked from inside
       * MessageDisplay.
       */
      const handleInsertMention = (e: Event) => {
        const detail = (e as CustomEvent).detail || {};
        const handle: string | undefined = detail.handle || detail.username;
        if (!handle) return;
        // Match the format used by the existing `@mentionUser` handler
        // above (single leading `@`, trailing space) so MessageInput
        // parses it identically.
        messageContent.value += `@${handle} `;
      };

      onMounted(() => {
        window.addEventListener('beforeunload', handleBeforeUnload);
        window.addEventListener('harmony-command', handleSlashCommand);
        window.addEventListener('encryption-fallback', handleEncryptionFallback);
        window.addEventListener('dm-encryption-toggled', handleDMEncryptionToggled);
        window.addEventListener('server-structure:settings-change', handleServerSettingsChange);
        window.addEventListener('harmony-insert-mention', handleInsertMention);
      });

      onUnmounted(() => {
        window.removeEventListener('beforeunload', handleBeforeUnload);
        window.removeEventListener('harmony-command', handleSlashCommand);
        window.removeEventListener('encryption-fallback', handleEncryptionFallback);
        window.removeEventListener('dm-encryption-toggled', handleDMEncryptionToggled);
        window.removeEventListener('server-structure:settings-change', handleServerSettingsChange);
        window.removeEventListener('harmony-insert-mention', handleInsertMention);
      });

      const replyingTo = (messageId: string, displayName: string, userId?: string) => {
        if (messageId) {
          replyToMessageId.value = messageId;
          replyToUserDisplayName.value = displayName;
          replyToUserId.value = userId || '';
        }
      };

      const handleDontReply = () => {
        replyToMessageId.value = '';
        replyToUserDisplayName.value = '';
        replyToUserId.value = '';
      };

      const handleEditLastMessage = () => {
        messageDisplayRef.value?.editLastOwnMessage();
      };

      // Thread state for draft threads
      const draftParentMessage = ref<Message | null>(null);
      
      // Thread handlers
      const handleCreateThread = async (messageOrEvent: Message | { thread: any }) => {
        // Handle case when receiving a thread directly (from ThreadIndicator)
        if ('thread' in messageOrEvent && messageOrEvent.thread) {
          selectedThreadId.value = messageOrEvent.thread.id;
          selectedThread.value = messageOrEvent.thread;
          draftParentMessage.value = null;
          showThreadView.value = true;
          return;
        }
        
        const message = messageOrEvent as Message;
        
        if (!message || !props.channelId) {
          debug.warn('Cannot create thread: missing message or channelId');
          return;
        }
        
        try {
          // Check if thread already exists for this message
          const existingThread = await threadService.getThreadForMessage(message.id);
          
          if (existingThread) {
            // Open existing thread
            selectedThreadId.value = existingThread.id;
            selectedThread.value = existingThread;
            draftParentMessage.value = null;
            showThreadView.value = true;
          } else {
            // Open draft thread view - thread will be created on first message
            selectedThreadId.value = undefined;
            selectedThread.value = null;
            draftParentMessage.value = message;
            showThreadView.value = true;
          }
        } catch (error) {
          debug.error('Failed to create/open thread:', error);
        }
      };
      
      // Handle when a thread is created from ThreadView (on first message)
      const handleThreadCreated = async (thread: any, parentMessage: Message) => {
        selectedThreadId.value = thread.id;
        selectedThread.value = thread;
        draftParentMessage.value = null;
        
        // Send system message to channel about thread creation
        // The content is minimal - actual rendering uses metadata
        if (props.channelId) {
          const threadName = thread.name || 'Thread';
          await sendSystemThreadMessage(props.channelId, threadName, thread.id);
        }
      };

      const closeThreadView = () => {
        showThreadView.value = false;
        selectedThreadId.value = undefined;
        selectedThread.value = null;
        draftParentMessage.value = null;
      };
      
      // Send a system message for thread creation
      const sendSystemThreadMessage = async (channelId: string, threadName: string, threadId: string) => {
        const { error } = await coreMessageService.sendSystemMessage(
          channelId,
          [{ type: 'text' as const, text: 'started a thread' }],
          { type: 'thread_created', thread_id: threadId, thread_name: threadName }
        );
        if (error) debug.error('Failed to send thread system message:', error);
      };

      const handleThreadUpdated = (thread: any) => {
        selectedThread.value = thread;
      };

      const handleShowAllThreads = () => {
        emit('showAllThreads');
      };

      const handleRetryMessage = async (message: any) => {
        if (props.isDM && props.conversationId) {
          await dmStore.retryDMMessage(message.id, props.conversationId, message.user_id, message.content, message.reply_to);
        } else if (props.channelId && serverChannelStore.currentServerId) {
          await chatStore.retryMessage(message.id, serverChannelStore.currentServerId, props.channelId, message.user_id, message.content, message.reply_to || '');
        }
      };

      const handleDiscardMessage = (message: any) => {
        if (props.isDM) {
          dmStore.discardFailedDMMessage(message.id);
        } else {
          chatStore.discardFailedMessage(message.id);
        }
      };

      const toggleReaction = (messageId: string, emoji: Emoji) => {
        selectedMessageId.value = messageId;
        isPopupForReaction.value = true;
        handleSendEmoji(emoji);
      };

      const toggleEmojiList = (isReaction: boolean, message?: Message, triggerElement?: HTMLElement) => {
        if (isReaction) {
          // Reaction emoji - use separate popup positioned on the message
          if (message) selectedMessageId.value = message.id;
          if (triggerElement) reactionTriggerElement.value = triggerElement;
          isPopupForReaction.value = true;
          reactionEmojiOpen.value = !reactionEmojiOpen.value;
          if (reactionEmojiOpen.value) {
            mediaPickerOpen.value = false; // Close media picker
            emojiIconClicked.value = true;
          }
        } else {
          // Regular emoji input - use unified media picker
          isPopupForReaction.value = false;
          mediaPickerInitialTab.value = 'emoji';
          mediaPickerOpen.value = !mediaPickerOpen.value;
          if (mediaPickerOpen.value) {
            reactionEmojiOpen.value = false;
            emojiIconClicked.value = true;
          }
        }
      };

      watch(reactionEmojiOpen, () => {
          if (!reactionEmojiOpen.value) {
            emojiIconClicked.value = false;
            reactionTriggerElement.value = null;
          }
      });

      const closeReactionEmoji = () => {
        reactionEmojiOpen.value = false;
        isPopupForReaction.value = false;
        reactionTriggerElement.value = null;
      };

      const toggleGiphy = () => {
          debug.log('toggleGiphy called');
          mediaPickerInitialTab.value = 'gifs';
          mediaPickerOpen.value = !mediaPickerOpen.value;
          debug.log('mediaPickerOpen is now:', mediaPickerOpen.value);
          if (mediaPickerOpen.value) {
              gifIconClicked.value = true;
              reactionEmojiOpen.value = false;
          }
      };

      watch(mediaPickerOpen, () => {
          if (!mediaPickerOpen.value) {
              gifIconClicked.value = false;
              emojiIconClicked.value = false;
          }
      });

      const closeMediaPicker = () => {
        mediaPickerOpen.value = false;
      };

      // New drag and drop handler for the chat container (fallback)
      const triggerFileDrop = async (event: any) => {
        debug.log("triggerFileDrop called - File dropped on chat container:", event);
        showDragDropArea.value = false;
        
        const files = event.dataTransfer.files;
        if (files.length > 0) {
          debug.log("ChatComponent forwarding", files.length, "files to MessageInput");
          const fileArray = Array.from(files);
          // This will be handled by MessageInput's drag and drop
          // We'll emit an event to trigger file selection in MessageInput
          const messageInputEvent = new CustomEvent('external-file-drop', {
            detail: { files: fileArray }
          });
          document.dispatchEvent(messageInputEvent);
        }
      };

      let unlistenTauriFileDrop: (() => void) | null = null;

      onMounted(async () => {
        if (!isTauri.value) return;
        unlistenTauriFileDrop = await listen('tauri://file-drop', async (event: any) => {
          const filePath = event.payload[0];
          try {
            const fileBytes = await readFile(filePath);
            const fileBlob = new Blob([fileBytes]);

            const file = new File([fileBlob], filePath.split('/').pop(), {
              type: "mime/type",
            });

            const messageInputEvent = new CustomEvent('external-file-drop', {
              detail: { files: [file] }
            });
            document.dispatchEvent(messageInputEvent);
          } catch (error) {
            debug.error('Error processing file drop:', error);
          }
        });
      });

      onUnmounted(() => {
        unlistenTauriFileDrop?.();
        unlistenTauriFileDrop = null;
      });

      // Use unified content parsing system (DRY)
      const parseMessageInput = async (input: string): Promise<MessagePart[]> => {
        debug.log('🔧 Using unified content parsing for:', input);
        
        const userDataMap = await resolveMentionsUserData(input);
        const emojiDataMap = await resolveEmojisData(input);
        const roleDataMap = await resolveRoleMentionsData(input, serverChannelStore.currentServerId || undefined);
        
        const result = await parseContentToMessageParts(input, userDataMap, emojiDataMap, {}, roleDataMap);
        
        debug.log('🔧 Final parsed message parts:', result);
        return result;
      };



      // Updated handleSendMessage to support both DMs and server channels
      const handleSendMessage = async (content: string, files: FilePreviewData[] = [], replyMessageId?: string) => {
        if (!authStore.session?.user) {
          return;
        }

        // For DMs: check if we have a conversation ID
        // For server channels: check if we have channel and server IDs
        if (props.isDM) {
          if (!dmStore.currentConversationId) {
            debug.warn('Cannot send DM: no conversation selected');
            return;
          }
        } else {
          if (!serverChannelStore.currentChannelId || !serverChannelStore.currentServerId) {
            debug.warn('Cannot send message: no channel or server selected');
            return;
          }
        }

        // Check if all files are uploaded
        const hasUploadingFiles = files.some(file => file.uploadStatus === 'uploading');
        const hasFailedFiles = files.some(file => file.uploadStatus === 'error');

        if (hasUploadingFiles) {
          debug.warn('Cannot send message while files are still uploading');
          return;
        }

        if (hasFailedFiles) {
          debug.warn('Cannot send message with failed uploads');
          return;
        }

        let didAttemptSend = false;
        try {
          const messageParts: MessagePart[] = [];
          
          // Add text content if present
          if (content.trim()) {
            const parsedMessage = await parseMessageInput(content);
            messageParts.push(...parsedMessage);
          }

          // Use already uploaded files
          for (const fileData of files) {
            if (fileData.uploadStatus === 'completed' && fileData.uploadedUrl) {
              let fileType: 'image' | 'video' | 'audio' | 'file' = 'file';
              
              if (fileData.type.startsWith('image/')) {
                fileType = 'image';
              } else if (fileData.type.startsWith('video/')) {
                fileType = 'video';
              } else if (fileData.type.startsWith('audio/')) {
                fileType = 'audio';
              }
              
              messageParts.push({
                type: "file",
                url: fileData.uploadedUrl,
                fileType,
                fileName: fileData.name
              });
            }
          }

          // Send the message with all parts
          if (messageParts.length > 0) {
            didAttemptSend = true;
            const sendOutcome = await sendChannelOrDMWithEncryptionPolicy(messageParts, replyMessageId)

            // Only clear the draft / reply state if the message actually
            // went through. On 'declined' (encryption cancel) or
            // 'no-context' (missing channel/conversation/user - rare race),
            // keep the text and the reply target so the user can retry.
            //
            // NOTE: we do NOT touch `messageContent.value` here. MessageInput
            // already cleared the input synchronously when the user pressed
            // Enter (via `update:modelValue`). Setting it to '' a second time
            // _after_ the server roundtrip would wipe whatever the user has
            // typed in the meantime - reported as a chat-input bug.
            if (sendOutcome === 'ok') {
              if (draftKey.value && !messageContent.value.trim()) {
                draftsStore.clearDraft(draftKey.value);
              }
              handleDontReply();
            }
          }
        } catch (error: any) {
          debug.error('Error sending message:', error);
          const msg = error?.message || String(error)
          if (msg.includes('ENCRYPTION_')) {
            sendError.value = msg
            setTimeout(() => { sendError.value = null }, 6000)
          }
        }
      };

      const { runWithEncryptionFallback } = useEncryptionFallbackPrompt()

      /**
       * Run the actual send call, intercept fail-closed encryption policy
       * errors, and prompt the user (via the styled global modal) before
       * retrying with an explicit plaintext-fallback override.
       *
       * Returns one of:
       *   - 'ok'         - the message was sent (either encrypted or with
       *                    user-authorized plaintext fallback)
       *   - 'declined'   - the user pressed Cancel on the fallback modal,
       *                    nothing was sent
       *   - 'no-context' - the conversation/channel/user context was missing
       *                    (rare race: channel just deleted, user logging out,
       *                    DM conversation not loaded yet). Nothing was sent.
       *                    Caller must NOT treat this as success.
       *   - 'error'      - an unrecoverable error happened (re-thrown to
       *                    the outer handler in `handleSendMessage`)
       *
       * Both DM and channel sends go through the same composable here so
       * the input/draft state in `handleSendMessage` can synchronize with
       * the actual outcome (including encryption-fallback decline).
       */
      const sendChannelOrDMWithEncryptionPolicy = async (
        messageParts: MessagePart[],
        replyMessageId?: string,
      ): Promise<'ok' | 'declined' | 'error' | 'no-context'> => {
        // Pre-check context so a missing channel/conversation/user surfaces as
        // a distinct outcome instead of being swallowed as a `false` resolution
        // (which `runWithEncryptionFallback` would have reported as success).
        if (props.isDM) {
          if (!props.conversationId || !authStore.session?.user?.id) {
            debug.warn('Cannot send: missing DM conversation or user context')
            return 'no-context'
          }
        } else if (
          !serverChannelStore.currentServerId ||
          !serverChannelStore.currentChannelId ||
          !authStore.session?.user
        ) {
          debug.warn('Cannot send: missing channel/server or user context')
          return 'no-context'
        }

        const trySend = async ({ allowPlaintextFallback }: { allowPlaintextFallback: boolean }) => {
          if (props.isDM) {
            // Context guaranteed by the pre-check above.
            const success = await dmStore.sendDMMessage(
              props.conversationId!,
              authStore.session!.user!.id,
              messageParts,
              replyMessageId || undefined,
              { allowPlaintextFallback },
            )
            // `dmStore.sendDMMessage` returns false on non-encryption
            // transient failures it couldn't recover after retry; throw so
            // `runWithEncryptionFallback` classifies it as `error` rather
            // than `ok`.
            if (!success) throw new Error('DM send did not complete')
            return true
          }
          await chatStore.sendMessage(
            serverChannelStore.currentServerId!,
            serverChannelStore.currentChannelId!,
            authStore.session!.user!.id,
            messageParts,
            replyMessageId || '',
            undefined,
            { allowPlaintextFallback },
          )
          return true
        }

        const scope: 'channel' | 'dm' = props.isDM ? 'dm' : 'channel'
        const outcome = await runWithEncryptionFallback(trySend, { scope })

        if (outcome.status === 'declined') {
          sendError.value = 'Message was not sent.'
          setTimeout(() => { sendError.value = null }, 6000)
          return 'declined'
        }
        if (outcome.status === 'error') {
          // ENCRYPTION_REQUIRED is server-enforced and not overridable;
          // bubble it up as a regular error so `handleSendMessage` can show
          // the appropriate copy. Same path for non-encryption failures.
          throw outcome.error
        }

        return 'ok'
      }

      const handleSendVoiceMessage = async (data: {
        url: string
        duration: number
        waveform: number[]
        mimeType: string
      }) => {
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

        debug.log('🎙️ Sending voice message:', { url: data.url, messageParts, voiceMetadata, isDM: props.isDM, conversationId: props.conversationId })

        try {
          if (props.isDM && props.conversationId) {
            await coreMessageService.sendDMMessage(
              props.conversationId,
              messageParts,
              undefined,
              undefined,
              voiceMetadata
            )
            debug.log('🎙️ Voice DM sent successfully')
          } else if (serverChannelStore.currentServerId && serverChannelStore.currentChannelId) {
            await chatStore.sendMessage(
              serverChannelStore.currentServerId,
              serverChannelStore.currentChannelId,
              authStore.session!.user.id,
              messageParts,
              '',
              voiceMetadata
            )
            debug.log('🎙️ Voice channel message sent successfully')
          } else {
            debug.error('🎙️ Cannot send voice: no channel or conversation context')
          }
        } catch (error) {
          debug.error('Error sending voice message:', error)
        }
      }

      const handleSendGif = async (gif: Gif) => {
        const gifUrl = gif.media_formats.gif.url;
        closeMediaPicker();

        const messageParts: MessagePart[] = [{
          type: 'file',
          url: gifUrl,
          fileType: 'image',
        }];

        try {
          const sendOutcome = await sendChannelOrDMWithEncryptionPolicy(
            messageParts,
            replyToMessageId.value || undefined,
          );
          // Only clear reply state on actual success. `'declined'` (user
          // cancelled fallback) and `'no-context'` (missing channel/DM)
          // must preserve the reply target so the user can retry.
          if (sendOutcome === 'ok') {
            handleDontReply();
          }
        } catch (error) {
          debug.error('Error sending GIF:', error);
        }
      };

      const handleSendEmoji = async (emoji: Emoji) => {
        const wasReaction = isPopupForReaction.value;
        if (wasReaction) {
          closeReactionEmoji();
        } else {
          closeMediaPicker();
        }
        
        if (wasReaction) {
          if (authStore.session?.user) {
            themeStore.playAudio('reaction');
            
            // Track emoji usage when used as reaction
            if (!props.isDM && serverChannelStore.currentServerId) {
              await recordEmojiUsage(
                emoji.id,
                authStore.session.user.id,
                serverChannelStore.currentServerId,
                'reaction',
                selectedMessageId.value
              );
            }
            
            // Add reaction - works for both DMs and server messages
            await chatStore.addReaction(selectedMessageId.value, emoji.id, authStore.session.user.id, emoji);
          }
        } else {
          // Append emoji immediately so it appears in the editor without delay
          messageContent.value += getEmojiShortcodeForInsert(emoji);
          debug.log("Emoji added in Parent:", messageContent.value);

          // Track emoji usage in background (non-blocking)
          if (authStore.session?.user && !props.isDM && serverChannelStore.currentServerId) {
            recordEmojiUsage(
              emoji.id,
              authStore.session.user.id,
              serverChannelStore.currentServerId,
              'message'
            );
          }
        }
      };

      // Drag and drop handlers for chat container
      const handleDragEnter = (event: DragEvent) => {
        event.preventDefault();
        if (event.dataTransfer?.types.includes('Files')) {
          showDragDropArea.value = true;
        }
      };

      const handleDragOver = (event: DragEvent) => {
        event.preventDefault();
      };

      const handleDragLeave = (event: DragEvent) => {
        event.preventDefault();
        // Only hide if we're leaving the chat container entirely
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const x = event.clientX;
        const y = event.clientY;
        
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
          showDragDropArea.value = false;
        }
      };

</script>

<style scoped>
  .chat-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0; /* Important for flex child with overflow */
    position: relative;
    /* custom wallpapers/styling for users */
  }
  /* .chat-container::before {
    position:absolute;
    top:0;
    left:0;
    content: '';
    width: 100%;
    height:100%;
    background: linear-gradient(90deg, black 20%, transparent 100%);
    opacity: 1;
  } */
  .drag-drop-area {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 50;
    display: flex;
    border: 2px dashed #ccc;
    padding: 20px;
    text-align: center;
    background: rgba(0, 0, 0, 0.8);
    align-items: center;
    justify-content: center;
    transition: 0.2s ease-in-out;
    font-size: 48px;

    .upload-status {
      color: rgb(18, 143, 18);
    } 
    font-weight: bold;
    color: var(--text-primary);
  }
  .encryption-status-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    font-size: 0.75rem;
    line-height: 1;
    border-top: 1px solid var(--border-color, rgba(255,255,255,0.06));
  }
  .encryption-status-bar.error {
    color: var(--color-error, #ed4245);
    background: rgba(237, 66, 69, 0.08);
    cursor: pointer;
  }

  .input-status-row {
    position: relative;
    height: 0;
    z-index: 1;
  }
  .encryption-status-tag {
    position: absolute;
    bottom: -18px;
    right: 16px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.65rem;
    line-height: 1;
    opacity: 0.7;
    pointer-events: auto;
  }
  .encryption-status-tag.active {
    color: var(--color-success, #43b581);
  }
  .encryption-status-tag.locked {
    color: var(--color-warning, #faa61a);
  }
  .encryption-status-tag.setup-prompt {
    color: var(--harmony-primary, #0EA5E9);
    opacity: 1;
  }
  .encryption-status-tag.error {
    color: var(--color-error, #ed4245);
  }
  @media (max-width: 768px) {
    .encryption-status-tag {
      display: none;
    }
  }

  .encryption-status-icon {
    font-size: 0.7rem;
    flex-shrink: 0;
  }
  .encryption-status-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .encryption-setup-btn {
    margin-left: 4px;
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 3px;
    border: none;
    background: var(--harmony-primary, #0EA5E9);
    color: #fff;
    font-size: 0.6rem;
    font-weight: 600;
    cursor: pointer;
    transition: filter 0.15s ease;
  }
  .encryption-setup-btn:hover {
    filter: brightness(1.15);
  }
</style>
