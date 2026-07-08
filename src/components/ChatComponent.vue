<template>
  <div class="chat-container" 
      @dragenter.prevent="handleDragEnter"
      @dragover.prevent="handleDragOver"
      @dragleave.prevent="handleDragLeave"
      @drop.prevent="triggerFileDrop">
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

    <Teleport to="body">
      <KeyRecoveryModal
        v-if="showKeyRecoveryModal"
        @close="showKeyRecoveryModal = false"
        @restored="handleEncryptionUnlocked"
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
          v-if="encryptionStatus.showUnlock"
          class="encryption-setup-btn"
          @click="showKeyRecoveryModal = true"
        >
          {{ t('chat.unlockNow') }}
        </button>
        <button
          v-else-if="encryptionStatus.showSetup"
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
      :channel-id="props.channelId"
      :conversation-id="props.conversationId"
      :server-id="serverChannelStore.currentServerId ?? undefined"
      :channel-name="effectiveChannelName"
      :username="effectiveDMUsername"
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
         needed - that avoids transform/overflow containment from virtual
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

    <!-- File-drop overlay: full-viewport dim, below toasts, above chat content. -->
    <Teleport to="body">
      <div v-if="showDragDropArea" class="drag-drop-area">
        <div class="drag-drop-inner">
          <div v-if="uploading" class="upload-status">{{ t('chat.uploading') }}</div>
          <div v-else>{{ t('chat.dropFilesHere') }}</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
  import { ref, onMounted, computed, watch, onUnmounted, defineAsyncComponent } from 'vue';
  import MessageDisplay from './MessageDisplay.vue';
  import MessageInput from './MessageInput.vue';
  import KickBanModal from './moderation/KickBanModal.vue';
  const RecoveryKeySetupWizard = defineAsyncComponent(() => import('@/components/encryption/RecoveryKeySetupWizard.vue'));
  const KeyRecoveryModal = defineAsyncComponent(() => import('@/components/encryption/KeyRecoveryModal.vue'));
  import { useAuthStore } from '@/stores/auth'; 
  import { useProfileStore } from '@/stores/useProfile';
  import { useChatStore } from '@/stores/useChat';
  import { useServerChannelStore } from '@/stores/useServerChannel'; 
  import { useDMStore } from '@/stores/useDM';
  import { useThemeStore } from '@/stores/useTheme';
  import { useDraftsStore } from '@/stores/drafts';
  import type { Message, Gif, Emoji, MessagePart } from '@/types';
  import { recordEmojiUsage } from '@/services/emojiService';
  import { getEmojiShortcodeForInsert } from '@/services/emojiShortcodeResolver';
  import { readFile } from '@tauri-apps/plugin-fs';
  import { isTauriRuntime } from '@/services/instanceConfig';
  import { getMimeTypeFromFilename } from '@/utils/fileUpload';
  import MediaPickerPopup from '@/components/MediaPickerPopup.vue';
  import EmojiPopup from '@/components/EmojiPopup.vue';
  import ThreadView from '@/components/threads/ThreadView.vue';
  import type { FilePreviewData } from '@/components/FilePreview.vue';
  import { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData, resolveRoleMentionsData } from '@/utils/unifiedContentProcessing';
  import { buildChatParseOptions } from '@/utils/chatParseOptions';
  import { threadService } from '@/services/ThreadService';
  import { coreMessageService } from '@/services/core/CoreMessageService';
  import { useEncryptionFallbackPrompt } from '@/composables/useEncryptionFallbackPrompt';
  import { supabase } from '@/supabase';
  import { debug } from '@/utils/debug';
  import { isVideoMessageUrl } from '@/utils/klipyAttribution';
  import { useServerPermissions } from '@/composables/useServerPermissions';
  import { useI18n } from 'vue-i18n';
  import { useToast } from 'vue-toastification';

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
  const toast = useToast();
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

  function handleKickBanDone(_result: { success: boolean }) {
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
  
  const reactionTriggerElement = ref<HTMLElement | null>(null);
  
  const gifTriggerElement = computed(() => messageInputRef.value?.gifTriggerRef || null);
  const emojiTriggerElement = computed(() => messageInputRef.value?.emojiTriggerRef || null);
  
  // Media picker uses GIF trigger as default
  const mediaPickerTriggerElement = computed(() => gifTriggerElement.value || emojiTriggerElement.value);
  
      const messageDisplayRef = ref<InstanceType<typeof MessageDisplay> | null>(null);
      // App data (messages, reactions, emoji usage) keys on profiles.id, not the
      // auth user id - always use this for matching/writing that data.
      const profileStore = useProfileStore();
      const currentUserId = computed(() => profileStore.profileId);
      const hasActiveUploads = ref(false);
      
      const effectiveChannelName = computed(() => {
        if (props.channelName) return props.channelName;
        // Fallback: try to get from store
        if (!props.isDM && props.channelId) {
          const channel = serverChannelStore.channels.find(ch => ch.id === props.channelId);
          return channel?.name;
        }
        return undefined;
      });
      
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
      
      
      const gifIconClicked = ref(false);
      const emojiIconClicked = ref(false);

      // Encryption status tracking
      const encryptionStatusData = ref<{ level: string; icon: string; text: string; showSetup?: boolean; showUnlock?: boolean } | null>(null)
      const showEncryptionSetupWizard = ref(false)
      const showKeyRecoveryModal = ref(false)

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
              // Keys exist - offer UNLOCK (recovery phrase), never setup:
              // setup would mint a new identity and orphan encrypted history.
              encryptionStatusData.value = {
                level: 'locked',
                icon: '🔓',
                text: mode === 'required'
                  ? 'Encryption required - unlock to read and send messages'
                  : 'Encryption available but locked - messages sent as plaintext',
                showUnlock: true
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
            const hasKey = svc.isInitialized() ? await svc.hasRecoveryKey() : false
            if (hasKey) {
              encryptionStatusData.value = {
                level: 'locked',
                icon: '🔓',
                text: 'Encryption enabled - unlock to read encrypted messages',
                showUnlock: true
              }
            } else {
              encryptionStatusData.value = {
                level: 'locked',
                icon: '🔓',
                text: 'Encryption enabled - set up your keys to participate',
                showSetup: true
              }
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

      function handleEncryptionUnlocked() {
        showKeyRecoveryModal.value = false
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
       * surface that doesn't have a direct emit path into ChatComponent -
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

      const replyingTo = (messageId: string) => {
        if (messageId) {
          replyToMessageId.value = messageId;
        }
      };

      const handleDontReply = () => {
        replyToMessageId.value = '';
      };

      // The reply bar should disappear the instant a message is committed to
      // being sent - mirroring how MessageInput clears the text editor on
      // Enter - rather than lingering until the server roundtrip completes.
      // `consumeReplyTarget` snapshots and clears the reply state up front;
      // `restoreReplyTarget` puts it back only if the send never went through
      // (encryption declined / required, missing context, transient error) so
      // the user doesn't silently lose what they were replying to.
      type ReplyTargetSnapshot = { id: string };
      const consumeReplyTarget = (): ReplyTargetSnapshot => {
        const snapshot: ReplyTargetSnapshot = {
          id: replyToMessageId.value,
        };
        handleDontReply();
        return snapshot;
      };
      const restoreReplyTarget = (snapshot: ReplyTargetSnapshot | null) => {
        if (snapshot?.id && !replyToMessageId.value) {
          replyToMessageId.value = snapshot.id;
        }
      };

      const handleEditLastMessage = () => {
        messageDisplayRef.value?.editLastOwnMessage();
      };

      // Thread state for draft threads
      const draftParentMessage = ref<Message | null>(null);
      
      // Thread handlers
      const handleCreateThread = async (messageOrEvent: Message | { thread: any }) => {
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
          const existingThread = await threadService.getThreadForMessage(message.id);
          
          if (existingThread) {
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
      const handleThreadCreated = async (thread: any, _parentMessage: Message) => {
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
          // MessageInput owns drag-and-drop handling
          // We'll emit an event to trigger file selection in MessageInput
          const messageInputEvent = new CustomEvent('external-file-drop', {
            detail: { files: fileArray }
          });
          document.dispatchEvent(messageInputEvent);
        }
      };

      let unlistenTauriFileDrop: (() => void) | null = null;

      onMounted(async () => {
        if (!isTauriRuntime()) return;
        // Tauri intercepts OS file drops (the DOM dataTransfer stays empty),
        // so read the dropped paths through the webview drag-drop event.
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        unlistenTauriFileDrop = await getCurrentWebview().onDragDropEvent(async (event) => {
          if (event.payload.type === 'enter' || event.payload.type === 'over') {
            showDragDropArea.value = true;
            return;
          }
          showDragDropArea.value = false;
          if (event.payload.type !== 'drop') return;

          const files: File[] = [];
          for (const filePath of event.payload.paths) {
            try {
              const fileBytes = await readFile(filePath);
              const name = filePath.split(/[\\/]/).pop() || 'file';
              files.push(new File([new Blob([fileBytes])], name, {
                type: getMimeTypeFromFilename(name),
              }));
            } catch (error) {
              debug.error('Error reading dropped file:', filePath, error);
            }
          }
          if (files.length > 0) {
            document.dispatchEvent(new CustomEvent('external-file-drop', { detail: { files } }));
          }
        });
      });

      onUnmounted(() => {
        unlistenTauriFileDrop?.();
        unlistenTauriFileDrop = null;
      });

      // Use unified content parsing system (DRY)
      const parseMessageInput = async (input: string): Promise<MessagePart[]> => {
        debug.log('Using unified content parsing for:', input);

        const userDataMap = await resolveMentionsUserData(input);
        const emojiDataMap = await resolveEmojisData(input);
        const roleDataMap = await resolveRoleMentionsData(input, serverChannelStore.currentServerId || undefined);

        const result = await parseContentToMessageParts(
          input, userDataMap, emojiDataMap, {}, roleDataMap, buildChatParseOptions(props.isDM));

        debug.log('Final parsed message parts:', result);
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
        let savedReply: ReplyTargetSnapshot | null = null;
        try {
          const messageParts: MessagePart[] = [];
          
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

          if (messageParts.length > 0) {
            // eslint-disable-next-line unused-imports/no-unused-vars
            didAttemptSend = true;

            // Clear the reply bar up front (before the network roundtrip), the
            // same way MessageInput already cleared the text editor on Enter.
            // The snapshot lets us restore it if the send doesn't go through.
            savedReply = consumeReplyTarget();

            const sendOutcome = await sendChannelOrDMWithEncryptionPolicy(messageParts, replyMessageId)

            // NOTE: we do NOT touch `messageContent.value` here. MessageInput
            // already cleared the input synchronously when the user pressed
            // Enter (via `update:modelValue`). Setting it to '' a second time
            // _after_ the server roundtrip would wipe whatever the user has
            // typed in the meantime - reported as a chat-input bug.
            if (sendOutcome === 'ok') {
              if (draftKey.value && !messageContent.value.trim()) {
                draftsStore.clearDraft(draftKey.value);
              }
            } else {
              // 'declined' (encryption cancel) or 'no-context' (missing
              // channel/conversation/user - rare race): the message was NOT
              // sent, so put the reply target back for a retry.
              restoreReplyTarget(savedReply);
            }
          }
        } catch (error: any) {
          // Hard failure (e.g. ENCRYPTION_REQUIRED, transient send error):
          // nothing was delivered, so restore the reply target alongside the
          // draft-restore handling below.
          restoreReplyTarget(savedReply);
          debug.error('Error sending message:', error);
          const code = (error?.code || '').toString()
          const msg = error?.message || String(error)
          if (code === 'ENCRYPTION_REQUIRED' || msg.includes('ENCRYPTION_REQUIRED')) {
            // Server mandates encryption - there is no plaintext override. Give
            // the same kinetic rejection as an over-limit send (buzz + toast)
            // instead of (wrongly) offering a "send plaintext" prompt.
            toast.error(msg || 'This server requires end-to-end encryption.')
            messageInputRef.value?.flashRejection?.()
            // The input cleared itself optimistically on send; restore the draft
            // so the user doesn't lose what they typed - unless they've already
            // started typing something new in the meantime.
            if (content && !messageContent.value.trim()) {
              messageContent.value = content
            }
          } else if (code.startsWith('ENCRYPTION_') || msg.includes('ENCRYPTION_')) {
            sendError.value = msg
            setTimeout(() => { sendError.value = null }, 6000)
          } else if (msg.includes('Slowmode')) {
            // The chat store already dispatched harmony:slowmode-hit to sync
            // the input countdown; surface the human-readable reason.
            toast.info(msg)
            if (content && !messageContent.value.trim()) {
              messageContent.value = content
            }
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
              currentUserId.value!,
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
            currentUserId.value!,
            messageParts,
            replyMessageId || '',
            undefined,
            { allowPlaintextFallback },
          )
          return true
        }

        const scope: 'channel' | 'dm' = props.isDM ? 'dm' : 'channel'
        const contextKey = props.isDM
          ? `dm:${props.conversationId}`
          : `channel:${serverChannelStore.currentChannelId}`
        const outcome = await runWithEncryptionFallback(trySend, { scope, contextKey })

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

        debug.log('Sending voice message:', { url: data.url, messageParts, voiceMetadata, isDM: props.isDM, conversationId: props.conversationId })

        try {
          if (props.isDM && props.conversationId) {
            await coreMessageService.sendDMMessage(
              props.conversationId,
              messageParts,
              undefined,
              undefined,
              voiceMetadata
            )
            debug.log('Voice DM sent successfully')
          } else if (serverChannelStore.currentServerId && serverChannelStore.currentChannelId) {
            await chatStore.sendMessage(
              serverChannelStore.currentServerId,
              serverChannelStore.currentChannelId,
              currentUserId.value!,
              messageParts,
              '',
              voiceMetadata
            )
            debug.log('Voice channel message sent successfully')
          } else {
            debug.error('Cannot send voice: no channel or conversation context')
          }
        } catch (error) {
          debug.error('Error sending voice message:', error)
        }
      }

      const handleSendGif = async (gif: Gif) => {
        const gifUrl = gif.media_formats?.gif?.url;
        if (!gifUrl) return;
        closeMediaPicker();

        const messageParts: MessagePart[] = [{
          type: 'file',
          url: gifUrl,
          fileType: isVideoMessageUrl(gifUrl) ? 'video' : 'image',
        }];

        // Clear the reply bar up front (before the network roundtrip); restore
        // it only if the GIF send didn't actually go through.
        const replyId = replyToMessageId.value || undefined;
        const savedReply = consumeReplyTarget();
        try {
          const sendOutcome = await sendChannelOrDMWithEncryptionPolicy(
            messageParts,
            replyId,
          );
          if (sendOutcome !== 'ok') {
            // 'declined' (user cancelled fallback) or 'no-context' (missing
            // channel/DM): the GIF was not sent, so put the reply target back.
            restoreReplyTarget(savedReply);
          }
        } catch (error) {
          debug.error('Error sending GIF:', error);
          restoreReplyTarget(savedReply);
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
          if (currentUserId.value) {
            themeStore.playAudio('reaction');
            
            if (!props.isDM && serverChannelStore.currentServerId) {
              await recordEmojiUsage(
                emoji.id,
                currentUserId.value,
                serverChannelStore.currentServerId,
                'reaction',
                selectedMessageId.value
              );
            }
            
            await chatStore.addReaction(selectedMessageId.value, emoji.id, currentUserId.value, emoji);
          }
        } else {
          messageContent.value += getEmojiShortcodeForInsert(emoji);
          debug.log("Emoji added in Parent:", messageContent.value);

          if (currentUserId.value && !props.isDM && serverChannelStore.currentServerId) {
            recordEmojiUsage(
              emoji.id,
              currentUserId.value,
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
    inset: 0;
    z-index: calc(var(--z-toast) - 1);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.78);
    backdrop-filter: blur(2px);
    pointer-events: none;
    transition: opacity 0.15s ease-in-out;
  }

  .drag-drop-inner {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    border: 3px dashed rgba(255, 255, 255, 0.5);
    border-radius: 12px;
    font-size: 40px;
    font-weight: bold;
    text-align: center;
    color: #ffffff;
  }

  .drag-drop-area .upload-status {
    color: rgb(74, 222, 128);
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
