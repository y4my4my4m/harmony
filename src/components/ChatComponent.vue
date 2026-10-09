<template>
  <div class="chat-container" 
      @dragenter.prevent="handleDragEnter"
      @dragover.prevent="handleDragOver"
      @dragleave.prevent="handleDragLeave"
      @drop.prevent="triggerFileDrop">
    <MessageDisplay 
      ref="messageDisplayRef"
      :messages="displayMessages"
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
      <Icon name="alert-triangle" :size="12" class="encryption-status-icon" />
      <span class="encryption-status-text">{{ sendError }}</span>
    </div>

    <RulesAcceptPrompt
      v-if="rulesPromptServerId"
      :server-name="serverChannelStore.currentServer?.name"
      @review="welcomeStore.open(rulesPromptServerId)"
    />
    <MessageInput 
      v-else
      ref="messageInputRef"
      v-model="messageContent"
      :giphyOpen="giphyOpen"
      :emojiListOpen="emojiListOpen"
      :reply-message-id="replyToMessageId"
      :channel-id="props.channelId"
      :conversation-id="props.conversationId"
      :media-room="composerMediaRoom"
      :server-id="serverChannelStore.currentServerId ?? undefined"
      :channel-name="effectiveChannelName"
      :username="effectiveDMUsername"
      background-send
      @toggleGiphy="toggleGiphy"
      @toggleEmojiList="toggleEmojiList"
      @sendMessage="handleSendMessage"
      @queueVoiceMessage="handleQueueVoiceMessage"
      @update:replyMessageId="handleDontReply"
      @upload-status-changed="handleUploadStatusChanged"
      @edit-last-message="handleEditLastMessage"
      @sendGif="handleSendGif"
    >
      <!-- Shares the strip under the field with the typing indicator. -->
      <template #status-end>
        <div v-if="encryptionStatus" :class="['encryption-status-tag', encryptionStatus.level]">
          <Icon :name="encryptionStatus.icon" :size="12" class="encryption-status-icon" />
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
      </template>
    </MessageInput>
    <!-- Media Picker (GIFs + Emoji) for message input -->
    <MediaPickerPopup
      v-if="mediaPickerOpen"
      @click.stop
      @sendGif="handleSendGif"
      @sendEmoji="handleSendEmoji"
      :closePopup="closeMediaPicker"
      :position="'above'"
      :triggerElement="(mediaPickerTriggerElement as unknown as HTMLElement | null) || undefined"
      :composerElement="composerElement || undefined"
      :initialTab="mediaPickerInitialTab"
    />

    <!-- Emoji Popup for message reactions.
         EmojiPopup teleports itself to <body>; no outer Teleport wrapper.
         That escapes transform/overflow containment from virtual-scroll
         ancestors. See EmojiPopup.vue template. -->
    <EmojiPopup
      v-if="reactionEmojiOpen"
      @click.stop
      @sendEmoji="handleSendEmoji"
      :closeEmojiList="closeReactionEmoji"
      :isEmojiBlocked="isReactionEmojiBlocked"
      :limitNotice="reactionLimitNotice"
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
  import { ref, onMounted, computed, watch, onUnmounted, defineAsyncComponent, toRaw } from 'vue';
  import MessageDisplay from './MessageDisplay.vue';
  import MessageInput from './MessageInput.vue';
  import Icon from '@/components/common/Icon.vue';
  import KickBanModal from './moderation/KickBanModal.vue';
  import RulesAcceptPrompt from '@/components/welcome/RulesAcceptPrompt.vue';
  import { useServerWelcomeStore } from '@/stores/useServerWelcome';
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
  import { classifySendFailure } from '@/utils/sendFailure';
  import { useOutboxStore, withPendingRows } from '@/stores/useOutbox';
  import { sendToTarget, targetKey, type MessageTarget } from '@/stores/shared/sendToTarget';
  import { recordEmojiUsage } from '@/services/emojiService';
  import { getEmojiShortcodeForInsert } from '@/services/emojiShortcodeResolver';
  import { mediaRoom } from '@/services/privateMedia';
  import { forgetMessageMediaUpload } from '@/services/messageMediaUpload';
  import MediaPickerPopup from '@/components/MediaPickerPopup.vue';
  import EmojiPopup from '@/components/EmojiPopup.vue';
  import { useMessageReactionLimit } from '@/composables/useReactionLimits';
  import ThreadView from '@/components/threads/ThreadView.vue';
  import type { FilePreviewData } from '@/components/FilePreview.vue';
  import { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData, resolveRoleMentionsData } from '@/utils/unifiedContentProcessing';
  import { buildChatParseOptions } from '@/utils/chatParseOptions';
  import { threadService } from '@/services/ThreadService';
import { useFileDragOverlay } from '@/composables/useFileDragOverlay';
  import { useThreadsStore } from '@/stores/useThreads';
  import { coreMessageService } from '@/services/core/CoreMessageService';
  import { ENCRYPTION_STATE_CHANGED_EVENT } from '@/composables/useEncryptionAction';
  import { fetchEffectiveChannelEncryption, fetchServerForceKeySetup, invalidateServerForceKeySetup } from '@/services/ChannelEncryptionService';
  import { getEncryptionService } from '@/services/core/channelMessageEncryption';
  import { useChannelEncryptionStore } from '@/stores/useChannelEncryption';
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
  const channelEncryptionStore = useChannelEncryptionStore();
  const dmStore = useDMStore();
  const themeStore = useThemeStore();
  const draftsStore = useDraftsStore();
  const outbox = useOutboxStore();
  const { hasCurrentUserPermission, Permission, isCurrentUserServerOwner } = useServerPermissions();

  // Messages of this view with its outbox rows, which outlive the component. The
  // rows join once the view has messages: MessageDisplay places its initial scroll
  // and read divider on the first non-empty list.
  const viewTargetKey = computed(() => {
    if (props.isDM) return props.conversationId ? targetKey({ kind: 'dm', conversationId: props.conversationId }) : null;
    return props.channelId ? targetKey({ kind: 'channel', channelId: props.channelId }) : null;
  });
  const displayMessages = computed(() => props.isLoading && props.messages.length === 0
    ? props.messages
    : withPendingRows(props.messages, outbox.rowsFor(viewTargetKey.value)));

  /** The open channel or DM; a send keeps it however the view changes afterwards. */
  const currentTarget = (): MessageTarget | null => {
    if (props.isDM) {
      const conversationId = props.conversationId || dmStore.currentConversationId;
      return conversationId ? { kind: 'dm', conversationId } : null;
    }
    const channelId = props.channelId || serverChannelStore.currentChannelId;
    const serverId = serverChannelStore.channels.find(ch => ch.id === channelId)?.server_id
      ?? serverChannelStore.currentServerId;
    return channelId && serverId ? { kind: 'channel', serverId, channelId } : null;
  };
  
  const {
    visible: showDragDropArea,
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    reset: resetDragDropArea,
    hold: holdDragDropArea,
  } = useFileDragOverlay();
  const uploading = ref(false);
  const sendError = ref<string | null>(null);

  const welcomeStore = useServerWelcomeStore();
  const rulesPromptServerId = computed(() => {
    const serverId = serverChannelStore.currentServerId;
    return !props.isDM && serverId && welcomeStore.mustAccept(serverId) ? serverId : null;
  });

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
  const { isEmojiBlocked: isReactionEmojiBlocked, limitNotice: reactionLimitNotice } =
    useMessageReactionLimit(selectedMessageId);
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
  
  // Computed trigger refs from MessageInput
  const gifTriggerElement = computed(() => messageInputRef.value?.gifTriggerRef || null);
  const emojiTriggerElement = computed(() => messageInputRef.value?.emojiTriggerRef || null);
  
  // Media picker uses GIF trigger as default
  const mediaPickerTriggerElement = computed(() => gifTriggerElement.value || emojiTriggerElement.value);
  const composerElement = computed(() => messageInputRef.value?.composerRef || null);
  
      const messageDisplayRef = ref<InstanceType<typeof MessageDisplay> | null>(null);
      // Messages, reactions and emoji usage key on profiles.id, not the auth
      // user id. Match and write that data with this id.
      const profileStore = useProfileStore();
      const currentUserId = computed(() => profileStore.profileId);
      const hasActiveUploads = ref(false);
      
      // Prop wins; store lookup is the fallback.
      const effectiveChannelName = computed(() => {
        if (props.channelName) return props.channelName;
        if (!props.isDM && props.channelId) {
          const channel = serverChannelStore.channels.find(ch => ch.id === props.channelId);
          return channel?.name;
        }
        return undefined;
      });
      
      // Prop wins; store lookup is the fallback.
      const effectiveDMUsername = computed(() => {
        if (props.dmUsername) return props.dmUsername;
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
        const channelId = props.channelId || serverChannelStore.currentChannelId
        if (!serverId || !channelId) {
          encryptionStatusData.value = null
          return
        }
        try {
          const [state, forceKeySetup] = await Promise.all([
            fetchEffectiveChannelEncryption(channelId),
            fetchServerForceKeySetup(serverId),
          ])
          if (state) channelEncryptionStore.applyEffective(state)

          const channelEncrypted = state?.messagesEncrypted === true
          const recommendSetup = forceKeySetup && state?.serverMode !== 'disabled'
          if (!channelEncrypted && !recommendSetup) {
            encryptionStatusData.value = null
            return
          }

          const svc = await getEncryptionService()
          const initialized = !!svc && svc.isInitialized()
          const hasKey = initialized ? await svc.hasRecoveryKey() : false
          const unlocked = initialized && svc.isUnlocked()

          if (!channelEncrypted) {
            // A user with keys is never offered setup: setup mints a new
            // identity and orphans encrypted history.
            encryptionStatusData.value = hasKey ? null : {
              level: 'setup-prompt',
              icon: 'key',
              text: t('channelEncryption.status.recommended'),
              showSetup: true
            }
          } else if (hasKey && unlocked) {
            encryptionStatusData.value = { level: 'active', icon: 'lock', text: t('channelEncryption.status.active') }
          } else if (hasKey) {
            encryptionStatusData.value = {
              level: 'locked',
              icon: 'unlock',
              text: t('channelEncryption.status.locked'),
              showUnlock: true
            }
          } else {
            encryptionStatusData.value = {
              level: 'error',
              icon: 'alert-triangle',
              text: t('channelEncryption.status.setup'),
              showSetup: true
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
              encryptionStatusData.value = { level: 'active', icon: 'lock', text: 'End-to-end encrypted' }
            } else {
              encryptionStatusData.value = {
                level: 'locked',
                icon: 'unlock',
                text: 'Encryption enabled but keys not set up',
                showSetup: true
              }
            }
          } else {
            const hasKey = svc.isInitialized() ? await svc.hasRecoveryKey() : false
            if (hasKey) {
              encryptionStatusData.value = {
                level: 'locked',
                icon: 'unlock',
                text: 'Encryption enabled - unlock to read encrypted messages',
                showUnlock: true
              }
            } else {
              encryptionStatusData.value = {
                level: 'locked',
                icon: 'unlock',
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

      // DMHeader fires the DM encryption toggle event.
      function handleDMEncryptionToggled(event: Event) {
        const detail = (event as CustomEvent).detail
        if (detail?.conversationId === props.conversationId) {
          checkEncryptionStatus()
        }
      }

      // Server and channel encryption changes arrive on the server-structure
      // broadcast.
      function handleServerSettingsChange(event: Event) {
        const detail = (event as CustomEvent).detail
        if (props.isDM) return
        if (detail?.table === 'server_encryption_settings') {
          invalidateServerForceKeySetup(detail?.new?.server_id ?? serverChannelStore.currentServerId)
          checkEncryptionStatus()
        } else if (detail?.table === 'channel_encryption_settings'
            && detail?.new?.channel_id === (props.channelId || serverChannelStore.currentChannelId)) {
          checkEncryptionStatus()
        }
      }

      function handleEncryptionStateChanged() {
        checkEncryptionStatus()
      }

      // A string source; a fresh array compares unequal on every dependency
      // trigger, which repeats the check several times per switch.
      watch(
        () => props.isDM ? null : `${serverChannelStore.currentServerId}:${props.channelId || serverChannelStore.currentChannelId}`,
        (key) => { if (key) checkEncryptionStatus() },
        { immediate: true }
      )

      watch(
        () => props.conversationId,
        () => { if (props.isDM) checkEncryptionStatus() },
        { immediate: true }
      )

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
        // Under the fail-closed policy this event is informational.
        // CoreMessageService throws ENCRYPTION_FAILED_NO_FALLBACK and the
        // confirm() flow surfaces it. An authorized override means the message
        // went out unencrypted, which is also surfaced here.
        const detail = (e as CustomEvent).detail || {}
        sendError.value = detail.failClosed
          ? 'Encryption failed - message NOT sent (confirm fallback to send unencrypted)'
          : 'Encryption failed - message sent unencrypted'
        setTimeout(() => { sendError.value = null }, 6000)
      };

      /**
       * Cross-component mention insertion. UserSidebar, and any other surface
       * without a direct emit path into ChatComponent such as context menus
       * outside the chat subtree, fires `harmony-insert-mention` with a
       * `{ handle, username }` payload. The handle is appended to the active
       * draft, as the `@mentionUser` listener does for mentions clicked inside
       * MessageDisplay.
       */
      const handleInsertMention = (e: Event) => {
        const detail = (e as CustomEvent).detail || {};
        const handle: string | undefined = detail.handle || detail.username;
        if (!handle) return;
        // Format matches the `@mentionUser` handler above - single leading
        // `@`, trailing space - so MessageInput parses it identically.
        messageContent.value += `@${handle} `;
      };

      onMounted(() => {
        window.addEventListener('beforeunload', handleBeforeUnload);
        window.addEventListener('harmony-command', handleSlashCommand);
        window.addEventListener('encryption-fallback', handleEncryptionFallback);
        window.addEventListener('dm-encryption-toggled', handleDMEncryptionToggled);
        window.addEventListener('server-structure:settings-change', handleServerSettingsChange);
        window.addEventListener('harmony-insert-mention', handleInsertMention);
        window.addEventListener(ENCRYPTION_STATE_CHANGED_EVENT, handleEncryptionStateChanged);
      });

      onUnmounted(() => {
        window.removeEventListener('beforeunload', handleBeforeUnload);
        window.removeEventListener('harmony-command', handleSlashCommand);
        window.removeEventListener('encryption-fallback', handleEncryptionFallback);
        window.removeEventListener('dm-encryption-toggled', handleDMEncryptionToggled);
        window.removeEventListener('server-structure:settings-change', handleServerSettingsChange);
        window.removeEventListener('harmony-insert-mention', handleInsertMention);
        window.removeEventListener(ENCRYPTION_STATE_CHANGED_EVENT, handleEncryptionStateChanged);
      });

      const replyingTo = (messageId: string) => {
        if (messageId) {
          replyToMessageId.value = messageId;
        }
      };

      const handleDontReply = () => {
        replyToMessageId.value = '';
      };

      // The reply bar clears the instant a message is committed to being sent,
      // matching how MessageInput clears the text editor on Enter, rather than
      // lingering until the server roundtrip completes. `consumeReplyTarget`
      // snapshots and clears the reply state up front; `restoreReplyTarget`
      // puts it back when the send did not go through - encryption declined or
      // required, missing context, transient error.
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
      
      const threadsStore = useThreadsStore();

      const openExistingThread = (thread: any) => {
        selectedThreadId.value = thread.id;
        selectedThread.value = thread;
        draftParentMessage.value = null;
        showThreadView.value = true;
      };

      // Thread handlers. The panel opens without a read: an indexed thread
      // opens directly, anything else opens as a draft.
      const handleCreateThread = (messageOrEvent: Message | { thread: any }) => {
        if ('thread' in messageOrEvent && messageOrEvent.thread) {
          openExistingThread(messageOrEvent.thread);
          return;
        }

        const message = messageOrEvent as Message;

        if (!message || !props.channelId) {
          debug.warn('Cannot create thread: missing message or channelId');
          return;
        }

        const indexed = threadsStore.threadForMessage(message.id);
        if (indexed) {
          openExistingThread(indexed);
          return;
        }

        // Draft thread view; the thread is created on the first message.
        selectedThreadId.value = undefined;
        selectedThread.value = null;
        draftParentMessage.value = message;
        showThreadView.value = true;

        // The index holds unarchived threads of the loaded page. A thread
        // outside it replaces the draft if the draft is still showing.
        void threadService.getThreadForMessage(message.id).then((found) => {
          if (!found) return;
          const entry = threadsStore.upsert(found);
          if (showThreadView.value && draftParentMessage.value?.id === message.id) {
            openExistingThread(entry);
          }
        });
      };
      
      // Fired by ThreadView when the first message creates the thread.
      const handleThreadCreated = async (thread: any, _parentMessage: Message) => {
        selectedThreadId.value = thread.id;
        selectedThread.value = thread;
        draftParentMessage.value = null;
        
        // The database posts the thread notice; rendering reads its metadata.
        if (props.channelId) {
          const { error } = await coreMessageService.postThreadCreatedNotice(thread.id);
          if (error) debug.error('Failed to post thread notice:', error);
        }
      };

      const closeThreadView = () => {
        showThreadView.value = false;
        selectedThreadId.value = undefined;
        selectedThread.value = null;
        draftParentMessage.value = null;
      };
      
      const handleThreadUpdated = (thread: any) => {
        selectedThread.value = thread;
      };

      const handleShowAllThreads = () => {
        emit('showAllThreads');
      };

      const handleRetryMessage = async (message: any) => {
        if (outbox.has(message.id)) {
          outbox.retry(message.id);
          return;
        }
        if (props.isDM && props.conversationId) {
          await dmStore.retryDMMessage(message.id, props.conversationId, message.user_id, message.content, message.reply_to);
        } else if (props.channelId && serverChannelStore.currentServerId) {
          await chatStore.retryMessage(message.id, serverChannelStore.currentServerId, props.channelId, message.user_id, message.content, message.reply_to || '');
        }
      };

      const handleDiscardMessage = (message: any) => {
        if (outbox.has(message.id)) {
          outbox.discard(message.id);
          return;
        }
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
          // Reactions use a separate popup anchored to the message.
          if (message) selectedMessageId.value = message.id;
          if (triggerElement) reactionTriggerElement.value = triggerElement;
          isPopupForReaction.value = true;
          reactionEmojiOpen.value = !reactionEmojiOpen.value;
          if (reactionEmojiOpen.value) {
            mediaPickerOpen.value = false;
            emojiIconClicked.value = true;
          }
        } else {
          // Input emoji uses the unified media picker.
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

      // Fallback drop handler for the chat container.
      const triggerFileDrop = async (event: any) => {
        debug.log("triggerFileDrop called - File dropped on chat container:", event);
        resetDragDropArea();
        
        const files = event.dataTransfer.files;
        if (files.length > 0) {
          debug.log("ChatComponent forwarding", files.length, "files to MessageInput");
          const fileArray = Array.from(files);
          // MessageInput owns drag-and-drop; this event hands the files over.
          const messageInputEvent = new CustomEvent('external-file-drop', {
            detail: { files: fileArray }
          });
          document.dispatchEvent(messageInputEvent);
        }
      };

      const parseMessageInput = async (input: string, serverId?: string): Promise<MessagePart[]> => {
        debug.log('Using unified content parsing for:', input);

        const userDataMap = await resolveMentionsUserData(input);
        const emojiDataMap = await resolveEmojisData(input);
        const roleDataMap = await resolveRoleMentionsData(input, serverId);

        const result = await parseContentToMessageParts(
          input, userDataMap, emojiDataMap, {}, roleDataMap, buildChatParseOptions(props.isDM));

        debug.log('Final parsed message parts:', result);
        return result;
      };

      // Room of composer uploads. The outbox copies an upload made in another room
      // into the room of the send.
      const composerMediaRoom = computed(() => props.isDM
        ? mediaRoom({ conversationId: props.conversationId || dmStore.currentConversationId })
        : mediaRoom({ channelId: props.channelId || serverChannelStore.currentChannelId }));

      const targetServerId = (target: MessageTarget) => target.kind === 'channel' ? target.serverId : undefined;

      /** Clears the draft of a sent message unless it holds other text, typed since. */
      const clearSentDraft = (sentDraftKey: string | null, sentText: string) => {
        if (!sentDraftKey) return;
        const stored = draftsStore.getDraft(sentDraftKey);
        if (stored.trim() && stored !== sentText) return;
        draftsStore.clearDraft(sentDraftKey);
      };

      /**
       * Puts a message MessageInput handed over back into the composer: its text, and
       * its attachments with their running uploads. Without a composer the
       * attachments' uploads are aborted and their previews revoked.
       */
      const restoreComposer = (content: string, files: FilePreviewData[]) => {
        if (content && !messageContent.value.trim()) messageContent.value = content;
        if (files.length === 0) return;
        if (messageInputRef.value) {
          messageInputRef.value.restoreAttachments(files);
          return;
        }
        for (const file of files) {
          file.upload?.abort();
          forgetMessageMediaUpload(file.upload?.path);
          if (file.preview) URL.revokeObjectURL(file.preview);
        }
      };

      /**
       * Queues a message with attachments in the outbox. It shows as a pending row at
       * once and is sent to `target` when its uploads finish, wherever the user is by
       * then. False when the author is unknown and nothing was queued.
       */
      const queueAttachmentSend = (
        target: MessageTarget,
        content: string,
        files: FilePreviewData[],
        replyMessageId: string | undefined,
        extraMetadata?: Record<string, unknown>,
      ): boolean => {
        const authorId = currentUserId.value;
        const uploaderId = authStore.session?.user?.id;
        if (!authorId || !uploaderId) return false;
        const hasText = !!content.trim();
        try {
          outbox.enqueue({
            target,
            authorId,
            uploaderId,
            replyTo: replyMessageId,
            textParts: hasText ? [{ type: 'text', text: content }] : [],
            parsedTextParts: hasText ? parseMessageInput(content, targetServerId(target)) : undefined,
            attachments: files.map((file) => {
              const raw = toRaw(file);
              const completed = raw.uploadStatus === 'completed';
              return {
                file: raw.file,
                name: raw.name,
                type: raw.type,
                size: raw.size,
                previewUrl: raw.preview,
                upload: raw.upload,
                uploadedPath: completed ? raw.uploadedPath : undefined,
                uploadedUrl: completed ? raw.uploadedUrl : undefined,
              };
            }),
            extraMetadata,
          });
          return true;
        } catch (error) {
          debug.error('Queueing a message with attachments failed:', error);
          return false;
        }
      };

      // Handles both DMs and server channels.
      const handleSendMessage = async (content: string, files: FilePreviewData[] = [], replyMessageId?: string) => {
        // Fixed at Enter: the message lands here whatever the view shows by the
        // time it is sent.
        const target = authStore.session?.user ? currentTarget() : null;
        if (!target) {
          debug.warn('Cannot send message: no session, channel or conversation');
          restoreComposer(content, files);
          toast.error(t('message.upload.notSent'));
          return;
        }
        const sentDraftKey = draftKey.value;

        if (files.length > 0) {
          const savedReply = consumeReplyTarget();
          if (queueAttachmentSend(target, content, files, replyMessageId)) {
            clearSentDraft(sentDraftKey, content);
          } else {
            restoreReplyTarget(savedReply);
            restoreComposer(content, files);
            toast.error(t('message.upload.notSent'));
          }
          return;
        }

        let savedReply: ReplyTargetSnapshot | null = null;
        try {
          const messageParts: MessagePart[] = content.trim()
            ? await parseMessageInput(content, targetServerId(target))
            : [];

          if (messageParts.length > 0) {
            // Reply bar clears before the network roundtrip, as MessageInput
            // already cleared the text editor on Enter. The snapshot restores
            // it if the send does not go through.
            savedReply = consumeReplyTarget();

            const sendOutcome = await sendChannelOrDMWithEncryptionPolicy(target, messageParts, replyMessageId)

            // NOTE: `messageContent.value` is not touched here. MessageInput
            // cleared the input synchronously on Enter via `update:modelValue`.
            // Clearing it again after the server roundtrip wipes anything typed
            // in the meantime.
            if (sendOutcome === 'ok') {
              clearSentDraft(sentDraftKey, content);
            } else {
              // 'declined' (encryption cancel) or 'no-context' (missing
              // author): nothing was sent, so the reply target goes back for a
              // retry.
              restoreReplyTarget(savedReply);
            }
          }
        } catch (error: any) {
          // Hard failure such as ENCRYPTION_REQUIRED or a transient send error.
          // Nothing was delivered; the reply target is restored alongside the
          // draft handling below.
          restoreReplyTarget(savedReply);
          debug.error('Error sending message:', error);
          handleSendFailure(error, target, content);
        }
      };

      const handleSendFailure = (error: any, target: MessageTarget, content: string) => {
        const msg = error?.message || String(error)
        // The input cleared optimistically on send. The draft comes back unless the
        // view moved on or something new has already been typed.
        const restoreDraft = () => {
          if (content && viewTargetKey.value === targetKey(target) && !messageContent.value.trim()) {
            messageContent.value = content
          }
        }
        switch (classifySendFailure(error)) {
          case 'encryption-required':
            // The channel mandates encryption; no plaintext override exists.
            // Same rejection feedback as an over-limit send (buzz plus toast)
            // rather than a "send plaintext" prompt. A refusal carrying a
            // reason has its own toast and setup or unlock prompt.
            if (!error?.reason) {
              toast.error(msg || 'This channel requires end-to-end encryption.')
            }
            messageInputRef.value?.flashRejection?.()
            restoreDraft()
            break
          case 'encryption':
            sendError.value = msg
            setTimeout(() => { sendError.value = null }, 6000)
            break
          case 'recipient-deleted':
            toast.error(t('dm.recipientDeleted'))
            messageInputRef.value?.flashRejection?.()
            restoreDraft()
            break
          case 'slowmode':
            // The chat store already dispatched harmony:slowmode-hit to sync the
            // input countdown. This surfaces the human-readable reason.
            toast.info(msg)
            restoreDraft()
            break
          case 'rules':
            // The composer turns into the accept-rules prompt; the draft is kept.
            void welcomeStore.handleRulesRejection(error?.details?.serverId ?? targetServerId(target))
            restoreDraft()
            break
          case 'moderation':
            // AutoMod block, member timeout or new-account limit. The message
            // carries the server's reason; the draft comes back for editing.
            toast.error(msg)
            messageInputRef.value?.flashRejection?.()
            restoreDraft()
            break
        }
      };

      /**
       * Sends to `target` through sendToTarget, which applies the fail-closed
       * encryption policy and prompts through the global modal before re-sending
       * with an explicit plaintext-fallback override.
       *
       * Returns:
       *   - 'ok'         - sent, encrypted or with authorized plaintext
       *                    fallback; or kept by the store as a failed row with
       *                    Retry after its own retries
       *   - 'declined'   - Cancel on the fallback modal; nothing was sent
       *   - 'no-context' - no author profile. Nothing was sent; callers must
       *                    not treat this as success.
       * Unrecoverable errors are thrown to the caller.
       */
      const sendChannelOrDMWithEncryptionPolicy = async (
        target: MessageTarget,
        messageParts: MessagePart[],
        replyMessageId?: string,
      ): Promise<'ok' | 'declined' | 'no-context'> => {
        const authorId = currentUserId.value;
        if (!authorId) {
          debug.warn('Cannot send: missing user context')
          return 'no-context'
        }

        const outcome = await sendToTarget(target, authorId, messageParts, replyMessageId)
        if (outcome === 'declined') {
          sendError.value = 'Message was not sent.'
          setTimeout(() => { sendError.value = null }, 6000)
          return 'declined'
        }
        return 'ok'
      }

      const handleQueueVoiceMessage = (data: {
        file: File
        duration: number
        waveform: number[]
        mimeType: string
      }) => {
        const target = currentTarget()
        if (!target) {
          debug.error('Cannot send voice: no channel or conversation context')
          toast.error(t('message.upload.voiceNotSent'))
          return
        }
        const voiceFile = {
          file: data.file,
          name: 'Voice message',
          size: data.file.size,
          type: data.mimeType,
          uploadStatus: 'pending',
        } as FilePreviewData
        const voiceMetadata = {
          voice_message: {
            duration: data.duration,
            waveform: data.waveform,
          },
        }
        if (!queueAttachmentSend(target, '', [voiceFile], undefined, voiceMetadata)) {
          debug.error('Cannot send voice: no author context')
          toast.error(t('message.upload.voiceNotSent'))
        }
      }

      const handleSendGif = async (gif: Gif) => {
        const gifUrl = gif.media_formats?.gif?.url;
        if (!gifUrl) return;
        closeMediaPicker();
        const target = currentTarget();
        if (!target) return;

        const messageParts: MessagePart[] = [{
          type: 'file',
          url: gifUrl,
          fileType: isVideoMessageUrl(gifUrl) ? 'video' : 'image',
        }];

        // Reply bar clears before the network roundtrip; restored only if the
        // GIF send did not go through.
        const replyId = replyToMessageId.value || undefined;
        const savedReply = consumeReplyTarget();
        try {
          const sendOutcome = await sendChannelOrDMWithEncryptionPolicy(
            target,
            messageParts,
            replyId,
          );
          if (sendOutcome !== 'ok') {
            // 'declined' (fallback cancelled) or 'no-context' (missing
            // author): the GIF was not sent; restore the reply target.
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


</script>

<style scoped>
  .chat-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0; /* flex child with overflow needs an explicit floor */
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
    color: var(--success);
  }
  .encryption-status-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    font-size: 0.75rem;
    line-height: 1;
    border-top: 1px solid var(--border-color);
  }
  .encryption-status-bar.error {
    color: var(--error);
    background: color-mix(in srgb, var(--error) 8%, transparent);
    cursor: pointer;
  }

  .encryption-status-tag {
    flex-shrink: 0;
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.65rem;
    line-height: 1;
    opacity: 0.7;
    pointer-events: auto;
  }
  .encryption-status-tag.active {
    color: var(--success);
  }
  .encryption-status-tag.locked {
    color: var(--warning);
  }
  .encryption-status-tag.setup-prompt {
    color: var(--harmony-primary);
    opacity: 1;
  }
  .encryption-status-tag.error {
    color: var(--error);
  }
  @media (max-width: 768px) {
    .encryption-status-tag {
      display: none;
    }
  }

  .encryption-status-icon {
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
    border-radius: var(--radius-sm);
    border: none;
    background: var(--harmony-primary);
    color: var(--text-on-primary);
    font-size: 0.6rem;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .encryption-setup-btn:hover {
    background: var(--harmony-primary-hover);
  }
</style>
