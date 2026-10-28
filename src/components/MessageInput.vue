<template>
  <div ref="composerRef" class="message-input" data-region="composer" :class="{'replying': replyMessageId, 'has-files': attachedFiles.length > 0}" data-testid="message-input" data-floating-video-avoid @paste="onComposerPaste">
    <MessageReply
      v-if="replyMessageId"
      :replyMessageId="replyMessageId"
      :channel-id="channelId"
      :conversation-id="conversationId"
      :server-id="conversationId ? undefined : serverId"
      @update:replyMessageId="handleDontReply"
    />
    <FilePreview
      :files="attachedFiles"
      :drive-enabled="driveEnabled"
      :force-temporary="driveEnabled && driveFull"
      :temporary-days="driveUsage?.ephemeral_days ?? 30"
      @remove-file="removeFile"
      @toggle-spoiler="toggleFileSpoiler"
      @update-alt="setFileAltText"
      @toggle-temporary="toggleFileTemporary"
    />
    <DriveShareOffer
      v-if="driveShareOffer.offer.value"
      :text="driveShareOfferText"
      :busy="driveShareOffer.busy.value"
      @share="shareOfferedDriveFile"
      @dismiss="driveShareOffer.dismiss()"
    />
    <DrivePickerModal
      v-if="showDrivePicker"
      :kinds="null"
      multiple
      @pick="attachFromDrive"
      @close="showDrivePicker = false"
    />
    <!-- Live media results for /gif, /sticker, /clip, /meme, /aiemoji -->
    <InlineGifPicker
      v-if="inlineMediaType"
      :query="modelValue || ''"
      :media-type="inlineMediaType"
      @selectGif="handleInlineGifSelect"
    />
    <!-- Command parameter hint bar; mirrors Discord. -->
    <div v-if="autoSuggest.activeCommand.value" class="command-param-bar">
      <div class="command-param-info">
        <span class="command-badge">/{{ autoSuggest.activeCommand.value.name }}</span>
        <span 
          v-for="param in autoSuggest.activeCommand.value.params" 
          :key="param.name" 
          class="command-param-item"
        >
          <span class="param-name">{{ param.name }}</span>
          <span class="param-description">{{ param.description }}</span>
        </span>
      </div>
      <button class="command-param-dismiss" @click="dismissCommand" :title="'Dismiss (Esc)'">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </button>
    </div>
    <!-- A server suspended by instance staff takes no new messages
         (a_messages_server_suspension_guard). -->
    <div v-if="suspension" class="message-readonly-banner server-suspended-banner" role="status" data-testid="server-suspended-banner">
      <Icon name="shield" :size="18" />
      <span>
        <strong>{{ t('hostStaff.suspendedBanner', { instance: suspension.instance }) }}</strong>
        <span v-if="suspension.reason" class="server-suspended-reason">{{ t('hostStaff.suspendedReason', { reason: suspension.reason }) }}</span>
      </span>
    </div>
    <!-- Read-only state: user lacks SEND_MESSAGES on this channel, or
         SEND_MESSAGES_IN_THREADS on a thread's channel.
         Backend RLS and triggers enforce it; this is UX, not security. -->
    <div v-else-if="!canSendMessages" class="message-readonly-banner" role="status">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
        <path d="M12 1a4.5 4.5 0 0 0-4.5 4.5V9H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V11a2 2 0 0 0-2-2h-1.5V5.5A4.5 4.5 0 0 0 12 1zm-2.5 4.5a2.5 2.5 0 0 1 5 0V9h-5V5.5z"/>
      </svg>
      <span>{{ readOnlyPlaceholder }}</span>
    </div>

    <div v-else
         class="message-container"
         :class="{ 'buzz-over-limit': overLimitBuzz, 'has-over-limit': messageTooLong }"
         @dragstart="handleDragStart"
         @dragend="handleDragEnd"
         @dragenter="handleDragEnter"
         @dragover="handleDragOver"
         @dragleave="handleDragLeave"
         @drop="handleDrop">
      <!-- Voice recording replaces the normal input. -->
      <div v-if="isVoiceRecording" class="voice-recording-wrapper">
        <VoiceRecorder
          auto-start
          @recording-complete="handleVoiceRecordingComplete"
          @recording-started="isVoiceRecording = true"
          @recording-cancelled="isVoiceRecording = false"
        />
      </div>

      <template v-else>
        <div class="left-icons">
          <!-- Compact: stands in for +, mic and GIF while the draft has content. -->
          <button
            v-if="isCompact"
            type="button"
            class="icon-button composer-expand"
            :class="{ 'is-collapsed': !actionsCollapsed }"
            :aria-label="$t('message.moreActions')"
            :title="$t('message.moreActions')"
            @mousedown.prevent
            @click.stop="expandActions"
          >
            <Icon name="chevron-right" :size="22" />
          </button>
          <div class="plus-icon-container" :class="{ 'is-collapsed': actionsCollapsed }">
            <button
              ref="attachButtonRef"
              type="button"
              class="attach-button"
              :class="{ active: showUploadMenu }"
              :aria-label="t('messageA11y.composer.attach')"
              :title="t('messageA11y.composer.attach')"
              data-testid="composer-attach"
              aria-haspopup="menu"
              :aria-expanded="showUploadMenu ? 'true' : 'false'"
              :aria-controls="showUploadMenu ? attachMenuId : undefined"
              @click.stop="toggleUploadMenu"
              @keydown="onAttachKeydown"
            >
              <PlusIcon />
            </button>
            <FileUploadMenu
              :isVisible="showUploadMenu"
              :allow-poll="allowPolls"
              :anchor="attachButtonRef"
              :menu-id="attachMenuId"
              :initial-focus="attachInitialFocus"
              :allow-drive="driveEnabled"
              @files-selected="handleFilesSelected"
              @pick-drive="openDrivePicker"
              @create-poll="handleCreatePoll"
              @close="closeUploadMenu"
            />
          </div>
        </div>
        <div class="textarea-wrapper">
          <RichTextEditor
            ref="richEditorRef"
            :model-value="modelValue"
            :placeholder="autoSuggest.activeCommand.value ? autoSuggest.activeCommand.value.params[0]?.description || 'Enter a value...' : (attachedFiles.length > 0 ? $t('message.addComment') : $t('message.typeMessage', { to: placeholderTarget }))"
            :min-height="isCompact ? COMPACT_EDITOR_MIN_HEIGHT : undefined"
            :max-height="isCompact ? COMPACT_EDITOR_MAX_HEIGHT : undefined"
            :auto-suggest-active="autoSuggest.state.value.isActive"
            :auto-suggest-selected-id="autoSuggest.state.value.isActive ? 'suggest-' + autoSuggest.state.value.selectedIndex : undefined"
            @update:model-value="handleModelValueUpdate"
            @input="handleEditorInput"
            @keydown="handleKeyDown"
            @focus="handleFocus"
            @blur="handleBlur"
            @cursor-position-changed="handleCursorPositionChanged"
            @paste="handlePasteFiles"
          />
          <div v-if="isCompact" class="field-trailing">
            <span
              v-if="slowmodeActive"
              class="slowmode-indicator"
              :class="{ cooling: slowmodeRemaining > 0 }"
              :title="slowmodeTitle"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 10.59V7h-2v6.41l4.29 4.3 1.42-1.42z"/>
              </svg>
              <span v-if="slowmodeRemaining > 0">{{ slowmodeRemaining }}s</span>
            </span>
            <span
              v-if="showCharCount"
              class="message-char-count"
              :class="{ 'over-limit': messageTooLong }"
              :title="charCountTitle"
            >{{ maxMessageLength - characterCount }}</span>
            <button
              ref="emojiTriggerRef"
              type="button"
              class="icon-button"
              data-testid="composer-emoji"
              :aria-label="t('messageA11y.composer.emoji')"
              :title="t('messageA11y.composer.emoji')"
              aria-haspopup="dialog"
              :aria-expanded="emojiListOpen ? 'true' : 'false'"
              @click.stop="toggleEmojiList"
            >
              <EmojiUI aria-hidden="true" />
            </button>
          </div>
        </div>
        <div class="right-icons">
          <span
            v-if="slowmodeActive && !isCompact"
            class="slowmode-indicator"
            :class="{ cooling: slowmodeRemaining > 0 }"
            :title="slowmodeTitle"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 10.59V7h-2v6.41l4.29 4.3 1.42-1.42z"/>
            </svg>
            <span v-if="slowmodeRemaining > 0">{{ slowmodeRemaining }}s</span>
          </span>
          <!--
            Character count shows only near or past the limit. Red when over.
            Send-button state comes from `hasContent`, not from this.
          -->
          <span
            v-if="showCharCount && !isCompact"
            class="message-char-count"
            :class="{ 'over-limit': messageTooLong }"
            :title="charCountTitle"
          >{{ maxMessageLength - characterCount }}</span>
          <VoiceRecorder
            :class="{ 'is-collapsed': actionsCollapsed }"
            :disabled="hasContent"
            @recording-started="isVoiceRecording = true"
            @recording-complete="handleVoiceRecordingComplete"
            @recording-cancelled="isVoiceRecording = false"
          />
          <!-- The name starts with the visible "GIF" glyph text (WCAG 2.5.3). -->
          <button
            ref="gifTriggerRef"
            type="button"
            class="icon-button composer-tool"
            :class="{ 'is-collapsed': actionsCollapsed }"
            data-testid="composer-gif"
            :aria-label="t('messageA11y.composer.gif')"
            :title="t('messageA11y.composer.gif')"
            aria-haspopup="dialog"
            :aria-expanded="giphyOpen ? 'true' : 'false'"
            @click.stop="toggleGiphy"
          >
            <GifIcon />
          </button>
          <button
            v-if="!isCompact"
            ref="emojiTriggerRef"
            type="button"
            class="icon-button composer-tool"
            data-testid="composer-emoji"
            :aria-label="t('messageA11y.composer.emoji')"
            :title="t('messageA11y.composer.emoji')"
            aria-haspopup="dialog"
            :aria-expanded="emojiListOpen ? 'true' : 'false'"
            @click.stop="toggleEmojiList"
          >
            <EmojiUI aria-hidden="true" />
          </button>
          <Transition name="composer-send">
            <button
              v-if="isMobile && hasContent"
              @mousedown.prevent
              @click.stop="send"
              class="icon-button send-button"
              :aria-label="$t('common.send')"
              data-testid="message-send-btn"
              :disabled="!hasContent"
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
              </svg>
            </button>
          </Transition>
        </div>
      </template>
    </div>

    <!-- Reserved strip under the field: typing and status never cover the bars above. -->
    <div class="composer-status">
      <TypingIndicator
        :typing-users="typingUsers"
        class="typing-indicator-wrapper"
      />
      <slot name="status-end" />
    </div>
    
    <AutoSuggest
      :isVisible="autoSuggest.state.value.isActive"
      :suggestions="autoSuggest.suggestions.value"
      :position="autoSuggest.state.value.position"
      :selectedIndex="autoSuggest.state.value.selectedIndex"
      :headerText="autoSuggest.headerText.value"
      @select="handleSuggestionSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, markRaw, reactive, toRaw } from 'vue';
import { useI18n } from 'vue-i18n';
import { useViewport } from '@/composables/useViewport';
import { debug } from '@/utils/debug'
import { useAutoSuggest } from '@/composables/useAutoSuggest';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useTypingIndicator } from '@/composables/useTypingIndicator';
import TypingIndicator from '@/components/TypingIndicator.vue';
import GifIcon from '@/components/icons/Gif.vue'
import PlusIcon from '@/components/icons/Plus.vue'
import EmojiUI from '@/components/EmojiUI.vue'
import MessageReply from '@/components/MessageReply.vue';
import FilePreview from '@/components/FilePreview.vue';
import DrivePickerModal from '@/components/drive/DrivePickerModal.vue';
import DriveShareOffer from '@/components/drive/DriveShareOffer.vue';
import { useDriveShareOffer, type DriveShareRoom } from '@/composables/useDriveShareOffer';
import { driveAvailable, setDriveTemporary, type DriveFile } from '@/services/drive/driveService';
import { useDriveUsage } from '@/composables/useDriveUsage';
import { useUserData } from '@/composables/useUserData';
import { compatUrlFor } from '@/services/privateMedia';
import FileUploadMenu from '@/components/FileUploadMenu.vue';
import AutoSuggest from '@/components/AutoSuggest.vue';
import RichTextEditor from '@/components/RichTextEditor.vue';
import VoiceRecorder from '@/components/VoiceRecorder.vue';
import InlineGifPicker from '@/components/InlineGifPicker.vue';
import Icon from '@/components/common/Icon.vue';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { parseKlipyKind } from '@/utils/klipyAttribution';
import { toggleSpoilerFileName } from '@/utils/spoiler';
import { buildEphemeralEmojiFromGif, registerEphemeralEmoji } from '@/utils/ephemeralEmoji';
import type { GifMediaType } from '@/services/gifProviderService';
import type { FilePreviewData } from '@/components/FilePreview.vue';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';
import type { Message, Gif } from '@/types';
import { useToast } from 'vue-toastification';
import {
  DEFAULT_MAX_MESSAGE_TEXT_LENGTH,
  MESSAGE_TEXT_HARD_CEILING,
} from '@/utils/messageContentUtils';
import { mediaRoom as roomOf, messageMediaPath, uploadMessageMedia } from '@/services/privateMedia';
import { forgetMessageMediaUpload, prepareMessageMediaUploads, startMessageMediaUpload, UploadAbortedError } from '@/services/messageMediaUpload';
import {
  addDraftAttachments,
  discardDraftAttachments,
  draftAttachments,
  draftAttachmentShown,
  holdsDraftAttachment,
  removeDraftAttachment,
  localDraftKey,
  openDraftAttachments,
  releaseAttachment,
  setDraftAttachments,
} from '@/stores/draftAttachments';
import type { VoiceRecordingResult } from '@/services/voiceRecordingService';
import { useAuthStore } from '@/stores/auth';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import { serverSuspension } from '@/utils/serverSuspension';
import { roleService, Permission } from '@/services/RoleService';
import { useAnnouncer } from '@/composables/useAnnouncer';
import { useMenuButton, type MenuCloseReason } from '@/composables/useMenu';
import { isImeKeyEvent } from '@/utils/editorShortcuts';

interface Props {
  giphyOpen?: boolean;
  emojiListOpen?: boolean;
  modelValue?: string;
  replyMessageId?: string;
  serverId?: string;
  channelName?: string;
  username?: string;
  channelId?: string;
  threadId?: string;
  /** The thread's channel; SEND_MESSAGES_IN_THREADS there gates the thread composer. */
  threadChannelId?: string;
  conversationId?: string;
  /** Room of uploaded attachments ('c/<channel id>' or 'd/<conversation id>'); derived from
      channelId or conversationId when absent. */
  mediaRoom?: string | null;
  /**
   * The parent queues sends whose uploads are unfinished (the outbox). Enter hands
   * attachments over mid-upload, and a voice recording goes out as
   * `queueVoiceMessage` without uploading here. Without it, Enter waits for running
   * uploads with the composer intact, and a recording is uploaded before
   * `sendVoiceMessage`.
   */
  backgroundSend?: boolean;
  /** The + menu offers Create poll; the parent handles `createPoll`. */
  allowPolls?: boolean;
  /** Messages of this room are encrypted: uploads carry no file name to Drive. */
  encryptedRoom?: boolean;
  /**
   * Draft of this context (drafts.ts makeKey). Its attachments stay with the draft when the
   * composer unmounts or shows another draft. Without a key they go with the composer.
   */
  draftKey?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  giphyOpen: false,
  emojiListOpen: false,
  modelValue: '',
  replyMessageId: '',
  serverId: undefined,
  backgroundSend: false,
  allowPolls: false,
  encryptedRoom: false,
});

// Placeholder target: DM username or channel name.
const placeholderTarget = computed(() => {
  if (props.username) return `@${props.username}`;
  if (props.channelName) return `#${props.channelName}`;
  return '';
});

interface VoiceMessageData {
  url: string
  path: string
  duration: number
  waveform: number[]
  mimeType: string
}

interface QueuedVoiceMessage {
  /** The recording, named `voice.<ext>`. */
  file: File
  duration: number
  waveform: number[]
  mimeType: string
}

// Tuple-form defineEmits matches vue-tsc's `(...args: any[]) => any`
// listener-prop type. The call-signature interface form emits contravariance
// errors at every parent binding site (TS2322: "Target requires N element(s)
// but source may have fewer"). Same note in MessageContextMenu.vue.
const emit = defineEmits<{
  'update:modelValue': [value: string]
  sendMessage: [content: string, files: FilePreviewData[], replyMessageId?: string]
  sendVoiceMessage: [data: VoiceMessageData]
  queueVoiceMessage: [data: QueuedVoiceMessage]
  toggleGiphy: []
  toggleEmojiList: [isReaction: boolean, message?: Message, triggerElement?: HTMLElement]
  'update:replyMessageId': [value: string]
  'files-attached': [files: FilePreviewData[]]
  'upload-status-changed': [uploading: boolean]
  'edit-last-message': []
  sendGif: [gif: Gif]
  createPoll: []
}>();

const authStore = useAuthStore();
const toast = useToast();
const { t } = useI18n();

const uploadRoom = computed(() =>
  props.mediaRoom ?? roomOf({ channelId: props.channelId, conversationId: props.conversationId }));
const { triggerMessage } = useHapticSettings();
const { recordEmojiUsage } = useFrequentEmojis();
const showUploadMenu = ref(false);
const attachButtonRef = ref<HTMLButtonElement | null>(null);
const {
  menuId: attachMenuId,
  onTriggerKeydown: onAttachKeydown,
  initialFocus: attachInitialFocus,
} = useMenuButton(showUploadMenu);
const { polite, assertive, announce } = useAnnouncer();
const ownDraftKey = localDraftKey();
const attachmentKey = computed(() => props.draftKey || ownDraftKey);
// The list is read-only; changes go through the setter.
const attachedFiles = computed<FilePreviewData[]>({
  get: () => draftAttachments(attachmentKey.value),
  set: (files) => setDraftAttachments(attachmentKey.value, files),
});
const isDragging = ref(false);
const richEditorRef = ref<InstanceType<typeof RichTextEditor>>();
const isEditorFocused = ref(false);
const composerRef = ref<HTMLElement | null>(null);
const gifTriggerRef = ref<HTMLElement | null>(null);
const emojiTriggerRef = ref<HTMLElement | null>(null);
const isVoiceRecording = ref(false);
const voiceUploading = ref(false);
// Set for ~450ms on an over-limit send attempt; drives the .buzz animation on
// the container. The draft is left intact.
const overLimitBuzz = ref(false);

const serverChannelStore = useServerChannelStore()

// Channel-level send permission gating. Must be declared after `authStore` and
// `serverChannelStore`: the immediate watch resolves synchronously and would
// otherwise hit the temporal dead zone
// (`Cannot access 'authStore' before initialization`).
const canSendMessages = ref(true); // optimistic until first resolution
const isResolvingPermissions = ref(false);

// --- Channel slowmode ---
// DB trigger `enforce_channel_slowmode` is the source of truth; this is the
// matching client UX (countdown, disabled send). MANAGE_MESSAGES is exempt.
const slowmodeExempt = ref(false);
const slowmodeRemaining = ref(0);
let slowmodeTimer: ReturnType<typeof setInterval> | null = null;

const slowmodeSeconds = computed(() => {
  if (!props.channelId || props.conversationId || props.threadId) return 0;
  const channel = serverChannelStore.channels.find(c => c.id === props.channelId);
  return channel?.slowmode_seconds ?? 0;
});

const slowmodeActive = computed(() =>
  slowmodeSeconds.value > 0 && !slowmodeExempt.value
);

const slowmodeTitle = computed(() => slowmodeRemaining.value > 0
  ? `Slowmode: you can send again in ${slowmodeRemaining.value}s`
  : `Slowmode is on: one message every ${slowmodeSeconds.value}s`);

function startSlowmodeCooldown(seconds: number) {
  if (seconds <= 0) return;
  slowmodeRemaining.value = seconds;
  if (slowmodeTimer) clearInterval(slowmodeTimer);
  slowmodeTimer = setInterval(() => {
    slowmodeRemaining.value -= 1;
    if (slowmodeRemaining.value <= 0 && slowmodeTimer) {
      clearInterval(slowmodeTimer);
      slowmodeTimer = null;
    }
  }, 1000);
}

// The DB rejects too-fast sends with SLOWMODE_ACTIVE:<n>; the chat store
// rebroadcasts it and the countdown resyncs to that authoritative value.
const handleSlowmodeHit = (event: Event) => {
  const seconds = (event as CustomEvent<{ seconds?: number; channelId?: string }>).detail?.seconds;
  const channelId = (event as CustomEvent<{ seconds?: number; channelId?: string }>).detail?.channelId;
  if (channelId && channelId !== props.channelId) return;
  if (typeof seconds === 'number' && seconds > 0) startSlowmodeCooldown(seconds);
};

watch(() => props.channelId, () => {
  slowmodeRemaining.value = 0;
  if (slowmodeTimer) {
    clearInterval(slowmodeTimer);
    slowmodeTimer = null;
  }
});

async function refreshSendPermission() {
  // A thread message needs SEND_MESSAGES_IN_THREADS, as messages_insert_member.
  const channelId = props.threadId ? props.threadChannelId : props.channelId;
  const sendPermission = props.threadId ? Permission.SEND_MESSAGES_IN_THREADS : Permission.SEND_MESSAGES;
  if (!channelId || props.conversationId) {
    canSendMessages.value = true;
    slowmodeExempt.value = true;
    return;
  }
  const userId = authStore.session?.user?.id;
  const serverId = serverChannelStore.currentServerId;
  if (!userId || !serverId) {
    canSendMessages.value = true;
    return;
  }
  isResolvingPermissions.value = true;
  try {
    const [allowed, canManage] = await Promise.all([
      roleService.hasPermission(userId, serverId, sendPermission, channelId),
      roleService.hasPermission(userId, serverId, Permission.MANAGE_MESSAGES, channelId),
    ]);
    canSendMessages.value = allowed;
    slowmodeExempt.value = canManage;
  } catch (err) {
    debug.warn('Failed to resolve SEND_MESSAGES permission, defaulting to allowed:', err);
    canSendMessages.value = true;
    slowmodeExempt.value = false;
  } finally {
    isResolvingPermissions.value = false;
  }
}

watch(
  () => [props.channelId, props.threadId, props.threadChannelId, authStore.session?.user?.id, serverChannelStore.currentServerId],
  () => { void refreshSendPermission(); },
  { immediate: true },
);

// Suspension of the server this channel belongs to; servers come from the member's list.
const suspension = computed<{ instance: string; reason: string | null } | null>(() => {
  if (props.conversationId) return null
  const serverId = props.serverId ?? serverChannelStore.currentServerId
  if (!serverId) return null
  const server = serverChannelStore.servers?.find(s => s.id === serverId)
    ?? (serverChannelStore.currentServer?.id === serverId ? serverChannelStore.currentServer : null)
  return serverSuspension(server, instanceSettingsStore.settings.domain)
})

const readOnlyPlaceholder = computed(() => {
  if (isResolvingPermissions.value) return 'Checking permissions...';
  if (props.threadId) return 'You do not have permission to send messages in this thread.';
  return 'You do not have permission to send messages in this channel.';
});

// Typing context: props first, store as fallback.
const typingContext = computed(() => {
  if (props.threadId) {
    return { type: 'thread' as const, threadId: props.threadId }
  }
  if (props.conversationId) {
    return { type: 'conversation' as const, conversationId: props.conversationId }
  }
  // Store's currentChannelId is set by ChatView's loadMessages watch, which
  // runs with immediate: true.
  const channelId = props.channelId || serverChannelStore.currentChannelId
  if (channelId) {
    return { type: 'channel' as const, channelId }
  }
  return null
})

// Getter form so the composable tracks the computed's dependencies.
const { typingUsers, startTyping, stopTyping } = useTypingIndicator(() => typingContext.value)

watch(typingContext, (newCtx, oldCtx) => {
  debug.log('MessageInput: typingContext changed:', newCtx, 'from:', oldCtx)
}, { immediate: true })

// Guards against repeated "typing on" events.
let hasStartedTyping = false
let typingResetTimeout: number | null = null
const TYPING_RESET_MS = 2000 // Idle window after which typing can re-trigger.

// Mobile = small screen OR touch-only device (no mouse)
const { isMobileViewport, isTouchOnly } = useViewport();
const isMobile = computed(() => isMobileViewport.value || isTouchOnly);

// Compact layout follows the 768px stylesheet breakpoint; touch-only input
// alone does not switch it.
const isCompact = computed(() => isMobileViewport.value);
// One line matches the 40px buttons: 22px line (16px x 1.375) + 9px padding
// top and bottom. Five lines, then the editor scrolls.
const COMPACT_EDITOR_MIN_HEIGHT = 40;
const COMPACT_EDITOR_MAX_HEIGHT = 5 * 22 + 18;

// Counts the raw editor string, markdown markers (`**`) included. The backend
// counts parsed text part lengths and is authoritative; the two values track
// closely enough to drive the counter.
const characterCount = computed(() => (props.modelValue || '').length);

// Soft limit from `instance_config.max_message_length`, owned by
// `useInstanceSettings`. Falls back to the default until the store loads, and
// clamps to the DB hard ceiling so a misconfigured value can't exceed what the
// DB accepts.
const instanceSettingsStore = useInstanceSettingsStore();
const maxMessageLength = computed(() => {
  const v = instanceSettingsStore.settings.maxMessageLength;
  if (typeof v !== 'number' || v < 1) return DEFAULT_MAX_MESSAGE_TEXT_LENGTH;
  return Math.min(v, MESSAGE_TEXT_HARD_CEILING);
});
const messageTooLong = computed(() => characterCount.value > maxMessageLength.value);
const showCharCount = computed(
  () => characterCount.value > maxMessageLength.value * 0.85,
);
// The counter is announced when it appears, when the draft goes over the
// limit and when it comes back under; never per keystroke.
watch([showCharCount, messageTooLong], ([near, over], [wasNear, wasOver]) => {
  const left = maxMessageLength.value - characterCount.value;
  if (over && !wasOver) assertive(t('messageA11y.composer.overLimit', { count: -left }, -left));
  else if (!over && wasOver) polite(t('messageA11y.composer.backUnderLimit', { count: left }, left));
  else if (near && !wasNear) polite(t('messageA11y.composer.nearLimit', { count: left }, left));
});

const charCountTitle = computed(() => messageTooLong.value
  ? `Message too long (${characterCount.value} / ${maxMessageLength.value})`
  : `${characterCount.value} / ${maxMessageLength.value}`);

// Over-limit drafts still count as content, keeping the send button enabled.
// The press routes through `send()`, which buzzes the input and toasts an
// error rather than dropping the draft.
const hasContent = computed(() => {
  return (props.modelValue?.trim().length ?? 0) > 0 || attachedFiles.value.length > 0;
});

// Compact, with content: +, mic and GIF fold behind the chevron. A chevron tap
// unfolds them until the next keystroke or until one is used; the upload menu
// is anchored inside +, so + stays out while the menu is open.
const actionsExpanded = ref(false);
const actionsCollapsed = computed(() =>
  isCompact.value && hasContent.value && !actionsExpanded.value && !showUploadMenu.value
);
const expandActions = () => {
  actionsExpanded.value = true;
};
watch(hasContent, (has) => {
  if (!has) actionsExpanded.value = false;
});

const handleVoiceRecordingComplete = async (result: VoiceRecordingResult) => {
  const userId = authStore.session?.user?.id
  if (!userId) return

  debug.log('Voice recording complete:', { duration: result.duration, blobSize: result.blob.size, mimeType: result.mimeType, waveformLength: result.waveform?.length })

  const ext = result.mimeType.includes('webm') ? 'webm' : result.mimeType.includes('ogg') ? 'ogg' : 'mp4'
  if (props.backgroundSend) {
    emit('queueVoiceMessage', {
      file: new File([result.blob], `voice.${ext}`, { type: result.mimeType }),
      duration: result.duration,
      waveform: result.waveform,
      mimeType: result.mimeType,
    })
    isVoiceRecording.value = false
    return
  }

  voiceUploading.value = true
  try {
    const room = uploadRoom.value
    if (!room) throw new Error('Voice messages need a channel or conversation')

    const uploaded = await uploadMessageMedia(room, userId, result.blob, {
      fileName: `voice.${ext}`,
      contentType: result.mimeType,
      ownProgress: true,
    })
    debug.log('Voice upload success:', { path: uploaded.path })

    emit('sendVoiceMessage', {
      url: uploaded.url,
      path: uploaded.path,
      duration: result.duration,
      waveform: result.waveform,
      mimeType: result.mimeType,
    })
  } catch (err) {
    debug.error('Failed to upload voice message:', err)
    toast.error(t('message.upload.voiceFailed'))
  } finally {
    voiceUploading.value = false
    isVoiceRecording.value = false
  }
}

onMounted(() => {
  window.addEventListener('harmony:slowmode-hit', handleSlowmodeHit);
});

onUnmounted(() => {
  window.removeEventListener('harmony:slowmode-hit', handleSlowmodeHit);
  if (slowmodeTimer) {
    clearInterval(slowmodeTimer);
    slowmodeTimer = null;
  }
  stopTyping()
  hasStartedTyping = false
  if (typingResetTimeout) {
    clearTimeout(typingResetTimeout)
  }
});

// Reads from the editor: `props.modelValue` lags one keystroke because
// `update:modelValue` round-trips through the parent's v-model before the prop
// is patched back down. The editor ref gives the value as of this tick, which
// matters for handlers firing synchronously after a keystroke
// (`cursor-position-changed` follows `update:modelValue`). The
// `props.modelValue` fallback covers the window before `richEditorRef` mounts.
const getCurrentText = () => richEditorRef.value?.getPlainText?.() ?? props.modelValue;
const updateText = (newText: string, cursorPosition?: number) => {
  debug.log('MessageInput updateText called:', { newText, cursorPosition });
  
  if (cursorPosition !== undefined && richEditorRef.value?.replaceText) {
    richEditorRef.value.replaceText(newText, cursorPosition);
  } else if (cursorPosition !== undefined && richEditorRef.value) {
    // Skip flag must be set before the update is emitted.
    debug.log('Setting skipNextWatch to true');
    richEditorRef.value.skipNextWatch = true;
    
    emit('update:modelValue', newText);
    
    nextTick(() => {
      if (richEditorRef.value?.renderContent) {
        debug.log('Calling manual renderContent with skipCursorRestore=true');
        richEditorRef.value.renderContent(newText, true); // true = skip cursor restore
      }
      
      // Focus precedes setCursorPosition.
      nextTick(() => {
        if (richEditorRef.value) {
          debug.log('Focusing editor FIRST');
          richEditorRef.value.focus();
          
          // Two frames: focus and DOM settle before the caret moves.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (richEditorRef.value) {
                debug.log('Now setting cursor position to:', cursorPosition);
                richEditorRef.value.setCursorPosition(cursorPosition);
                debug.log('Verifying final state:');
                debug.log('  - activeElement:', document.activeElement);
                debug.log('  - selection:', window.getSelection());
                debug.log('  - rangeCount:', window.getSelection()?.rangeCount);
                debug.log('Cursor should now be visible and ready for typing');
              }
            });
          });
        }
      });
    });
  } else {
    emit('update:modelValue', newText);
  }
};
// '#' channel autocomplete only in server channels - in DMs '#' is plain text.
const autoSuggest = useAutoSuggest(richEditorRef, getCurrentText, updateText, {
  mode: 'chat',
  enableChannels: !!props.channelId && !props.conversationId,
  pollsEnabled: () => props.allowPolls,
  channelId: () => (props.conversationId ? null : props.channelId),
});

// The editor carries no aria-expanded (role=textbox); the list opening and its
// size are spoken instead.
watch(
  () => (autoSuggest.state.value.isActive ? autoSuggest.suggestions.value.length : 0),
  (count, before) => {
    if (count > 0 && count !== before) {
      announce(t('messageA11y.composer.suggestions', { count }, count), { key: 'composer-suggestions' });
    }
  },
);

// Maps the active media slash command to the inline picker's media type.
const INLINE_MEDIA_COMMANDS: Record<string, GifMediaType> = {
  gif: 'gifs',
  sticker: 'stickers',
  clip: 'clips',
  meme: 'memes',
  aiemoji: 'ai-emojis',
};
const inlineMediaType = computed<GifMediaType | null>(() => {
  const name = autoSuggest.activeCommand.value?.name;
  return name ? INLINE_MEDIA_COMMANDS[name] ?? null : null;
});

    const handleModelValueUpdate = (value: string) => {
      actionsExpanded.value = false
      emit('update:modelValue', value)
      handleTyping()
    }

    const handleEditorInput = () => {
      // Model value arrives via update:model-value; handleModelValueUpdate owns
      // the typing indicator, so triggering here would double-fire it.
    };

    const handleTyping = () => {
      if (!typingContext.value) {
        return
      }
      
      if (typingResetTimeout) {
        clearTimeout(typingResetTimeout)
        typingResetTimeout = null
      }
      
      if (!hasStartedTyping) {
        hasStartedTyping = true
        startTyping()
      }
      
      typingResetTimeout = window.setTimeout(() => {
        hasStartedTyping = false
      }, TYPING_RESET_MS)
    };

    const handleCursorPositionChanged = (position: number) => {
      // Text comes from the editor ref, not `props.modelValue`.
      // `RichTextEditor.handleInput` emits `update:modelValue` and
      // `cursor-position-changed` synchronously back-to-back; the prop only
      // refreshes after the parent's v-model round-trip, so it holds the value
      // from before the keystroke. Reading the prop truncates queries by one
      // character (`:+1` → `:+`), which falls under the unified-emoji search's
      // `query.length >= 2` gate.
      if (richEditorRef.value) {
        const text = richEditorRef.value.getPlainText?.() ?? props.modelValue;
        autoSuggest.handleInput(text, position);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // Keys of an open composition, and the Enter that commits it, are the input method's.
      if (isImeKeyEvent(event)) return;

      // Auto-suggest claims its own keys, Enter included.
      const autoSuggestHandled = autoSuggest.handleKeyDown(event);
      
      if (autoSuggestHandled) {
        return;
      }
      
      if (event.key === 'Escape' && autoSuggest.activeCommand.value) {
        event.preventDefault();
        dismissCommand();
        return;
      }

      if (event.key === 'Escape' && props.replyMessageId) {
        event.preventDefault();
        emit('update:replyMessageId', '');
        return;
      }

      // Up arrow on empty input → edit last own message (Discord/Telegram behavior)
      if (event.key === 'ArrowUp' && !props.modelValue?.trim()) {
        event.preventDefault();
        emit('edit-last-message');
        return;
      }

      // Desktop: Enter sends, Shift+Enter newlines.
      // Mobile: Enter newlines; sending requires the send button.
      if (event.key === 'Enter' && !event.shiftKey && !isMobile.value) {
        event.preventDefault();

        // Enter does not send while a parameterized command is active;
        // results are picked by click (GIF grid).
        if (autoSuggest.activeCommand.value) {
          return;
        }

        send();
      }
    };

    const handleSuggestionSelect = (suggestion: SuggestionItem) => {
      // selectSuggestion handles emojis and mentions, inserting the leading @
      // and the trailing space itself.
      autoSuggest.selectSuggestion(suggestion);
      
      // Refocus after the DOM write; nextTick waits for the render.
      nextTick(() => {
        if (richEditorRef.value?.focus) {
          richEditorRef.value.focus();
        }
      });
    };

    const send = () => {
      stopTyping()
      hasStartedTyping = false

      if (typingResetTimeout) {
        clearTimeout(typingResetTimeout)
        typingResetTimeout = null
      }

      autoSuggest.closeSuggestions();
      autoSuggest.dismissActiveCommand();

      // Over-limit sends are refused here: no emit, no editor clear. Shake the
      // input, toast, and refocus. Emitting instead means a backend rejection
      // and the optimistic-removal path wipes the draft.
      if (messageTooLong.value) {
        overLimitBuzz.value = false;
        // Toggled on the next frame so re-presses restart the animation
        // while a previous run is still in flight.
        nextTick(() => {
          overLimitBuzz.value = true;
          window.setTimeout(() => { overLimitBuzz.value = false; }, 450);
        });
        toast.error(
          `Message too long (${characterCount.value.toLocaleString()} / ${maxMessageLength.value.toLocaleString()}). Trim it and try again.`,
        );
        if (richEditorRef.value?.focus) richEditorRef.value.focus();
        return;
      }

      if (slowmodeActive.value && slowmodeRemaining.value > 0) {
        toast.info(`Slowmode is on - you can send again in ${slowmodeRemaining.value}s`);
        return;
      }

      // A failed attachment blocks the send; the draft stays for its removal.
      if (attachedFiles.value.some(file => file.uploadStatus === 'error')) {
        toast.error(t('message.upload.removeFailed'));
        return;
      }

      if (!props.backgroundSend && hasUnfinishedUploads()) {
        if (holdingSend.value !== attachmentKey.value) {
          holdingSend.value = attachmentKey.value;
          attachedFiles.value.filter(file => file.uploadStatus === 'pending').forEach(file => startBackgroundUpload(file));
          toast.info(t('message.upload.sendWhenDone'));
        }
        return;
      }

      if (props.modelValue?.trim() || attachedFiles.value.length > 0) {
        const content = props.modelValue || '';
        const files = attachedFiles.value;
        // URL tracking-parameter stripping lives in unifiedContentProcessing.ts
        // and covers ActivityPub, DMs, and chat alike.
        emit('sendMessage', content, files, props.replyMessageId || undefined);
        if (slowmodeActive.value) {
          startSlowmodeCooldown(slowmodeSeconds.value);
        }
        triggerMessage();
        emit('update:modelValue', '');

        if (richEditorRef.value?.clear) {
          richEditorRef.value.clear();
        }

        // With backgroundSend the parent owns the files, their previews and uploads.
        if (!props.backgroundSend) {
          files.forEach(file => {
            if (file.preview) URL.revokeObjectURL(file.preview);
            forgetMessageMediaUpload(file.upload?.path);
          });
        }
        attachedFiles.value = [];
        emit('files-attached', []);
        emit('upload-status-changed', false);
      }
    };

    // Draft of an Enter pressed while uploads run, without backgroundSend; it sends once they finish.
    const holdingSend = ref<string | null>(null);

    const hasUnfinishedUploads = () =>
      attachedFiles.value.some(file => file.uploadStatus === 'uploading' || file.uploadStatus === 'pending');

    watch(() => attachedFiles.value.map(file => file.uploadStatus), () => {
      if (holdingSend.value !== attachmentKey.value || hasUnfinishedUploads()) return;
      holdingSend.value = null;
      if (attachedFiles.value.length === 0 && !props.modelValue?.trim()) return;
      send();
    });

    const handleFocus = () => {
      isEditorFocused.value = true;
    };

    const handleBlur = () => {
      isEditorFocused.value = false;
      stopTyping()
      hasStartedTyping = false
      if (typingResetTimeout) {
        clearTimeout(typingResetTimeout)
        typingResetTimeout = null
      }
    };

    const dismissCommand = () => {
      autoSuggest.dismissActiveCommand();
      emit('update:modelValue', '');
      if (richEditorRef.value?.clear) {
        richEditorRef.value.clear();
      }
      nextTick(() => richEditorRef.value?.focus());
    };

    const handleInlineGifSelect = (gif: Gif) => {
      autoSuggest.dismissActiveCommand();
      // AI emoji insert into the composer like emoji; no autosend.
      if (parseKlipyKind(gif.media_formats?.gif?.url || '') === 'ai-emoji') {
        const emoji = buildEphemeralEmojiFromGif(gif);
        registerEphemeralEmoji(emoji);
        recordEmojiUsage({ id: emoji.id, name: emoji.name, url: emoji.url });
        const shortcode = `:${emoji.name}:`;
        emit('update:modelValue', shortcode);
        nextTick(() => {
          richEditorRef.value?.renderContent?.(shortcode);
          richEditorRef.value?.focus();
        });
        return;
      }
      emit('update:modelValue', '');
      if (richEditorRef.value?.clear) {
        richEditorRef.value.clear();
      }
      emit('sendGif', gif);
    };

    const toggleGiphy = () => {
      actionsExpanded.value = false;
      emit('toggleGiphy');
    };
    
    const toggleEmojiList = () => {
      emit('toggleEmojiList', false);
    };

    const handleDontReply = (newReplyMessageId: string) => {
      emit('update:replyMessageId', newReplyMessageId);
    };

    // A press on the attach button while the menu is open closes it on
    // pointerdown ('outside'); the click that follows must not reopen it.
    let uploadMenuClosedAt = 0;
    const toggleUploadMenu = (event?: Event) => {
      if (event) {
        event.stopPropagation();
      }
      if (!showUploadMenu.value && performance.now() - uploadMenuClosedAt < 400) return;
      showUploadMenu.value = !showUploadMenu.value;
    };

    const closeUploadMenu = (reason?: MenuCloseReason) => {
      if (reason === 'outside') uploadMenuClosedAt = performance.now();
      showUploadMenu.value = false;
      actionsExpanded.value = false;
    };

    const handleCreatePoll = () => {
      closeUploadMenu();
      emit('createPoll');
    };

    const createFilePreview = async (file: File): Promise<FilePreviewData> => {
      const fileData: FilePreviewData = {
        file,
        name: file.name,
        size: file.size,
        type: file.type,
        uploadStatus: 'pending'
      };

      if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
        const url = URL.createObjectURL(file);
        fileData.preview = url;
      }

      return fileData;
    };

    // An upload outlives the composer that started it: it reports to its draft wherever that
    // is shown. After a backgroundSend hand-off it belongs to the parent and the draft no
    // longer holds the file.
    const startBackgroundUpload = (attachment: FilePreviewData, room: string | null = uploadRoom.value) => {
      const uploaderId = authStore.session?.user?.id;
      if (!uploaderId) return;
      // Writes through the proxy reach every composer showing the draft.
      const fileData = reactive(attachment);
      if (!room) {
        fileData.uploadStatus = 'error';
        fileData.uploadError = 'Attachments need a channel or conversation';
        return;
      }

      const sentTemporary = !!fileData.temporary;
      const upload = markRaw(startMessageMediaUpload(
        messageMediaPath(room, uploaderId, fileData.file.name),
        fileData.file,
        {
          validate: true,
          name: props.encryptedRoom ? undefined : fileData.name,
          label: fileData.name,
          ephemeral: sentTemporary,
          resumeKey: `${room}/${uploaderId}`,
          ownProgress: true,
          onProgress: (fraction) => {
            if (!holdsDraftAttachment(fileData)) return;
            const before = Math.floor((fileData.uploadProgress ?? 0) / 25);
            fileData.uploadProgress = fraction * 100;
            const after = Math.floor(fileData.uploadProgress / 25);
            if (after > before && after < 4 && draftAttachmentShown(fileData)) {
              announce(t('messageA11y.upload.progress', { name: fileData.name, percent: after * 25 }), { verbose: true, key: `upload-${fileData.name}` });
            }
          },
        },
      ));
      fileData.upload = upload;
      fileData.uploadStatus = 'uploading';
      fileData.uploadProgress = 0;

      upload.result.then(
        (uploaded) => {
          fileData.uploadStatus = 'completed';
          fileData.uploadedUrl = uploaded.url;
          fileData.uploadedPath = uploaded.path;
          fileData.uploadProgress = 100;
          fileData.reused = !!uploaded.reused;
          if (uploaded.reused) fileData.temporary = false;
          // The toggle moved while the bytes were on their way.
          else if (!!fileData.temporary !== sentTemporary) void applyTemporary(fileData);
          void refreshDriveUsage(true);
          if (draftAttachmentShown(fileData)) polite(t('messageA11y.upload.done', { name: fileData.name }));
        },
        (error: unknown) => {
          // Cancelled in the transfers indicator: the draft lets go of the file. A removal
          // from the draft aborts after the draft has let go.
          if (error instanceof UploadAbortedError) {
            removeDraftAttachment(fileData);
            return;
          }
          fileData.uploadStatus = 'error';
          fileData.uploadError = error instanceof Error ? error.message : 'Upload failed';
          fileData.uploadProgress = 0;
          if (draftAttachmentShown(fileData)) assertive(t('message.upload.failedToast', { name: fileData.name, reason: fileData.uploadError }));
        },
      );
    };

    const hasActiveUploads = () => {
      return attachedFiles.value.some(file => file.uploadStatus === 'uploading');
    };
    watch(hasActiveUploads, (uploading) => emit('upload-status-changed', uploading), { immediate: true });

    const handlePasteFiles = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        handleFilesSelected(files);
      }
    };

    const instanceSettings = useInstanceSettingsStore();
    const maxMediaAttachments = computed(() => instanceSettings.settings.maxMediaAttachmentsPerPost ?? 20);

    const handleFilesSelected = async (files: File[]) => {
      // Draft and room at attach time; the view can change during the await.
      const key = attachmentKey.value;
      const room = uploadRoom.value;
      const limit = maxMediaAttachments.value;
      const capacity = Math.max(0, limit - attachedFiles.value.length);
      if (capacity <= 0) return;
      const filesToAdd = Array.from(files).slice(0, capacity);
      const newFiles = await Promise.all(filesToAdd.map(createFilePreview));

      addDraftAttachments(key, newFiles);
      void refreshDriveUsage();
      if (newFiles.length > 0) polite(t('messageA11y.upload.attached', { count: newFiles.length }, newFiles.length));
      
      newFiles.forEach((fileData) => {
        startBackgroundUpload(fileData, room);
      });
      
      closeUploadMenu();
    };

    const toggleFileSpoiler = (index: number) => {
      const file = attachedFiles.value[index];
      if (file) file.name = toggleSpoilerFileName(file.name);
    };

    const driveEnabled = ref(false);
    const { usage: driveUsage, full: driveFull, refresh: refreshDriveUsage } = useDriveUsage();
    const showDrivePicker = ref(false);

    const applyTemporary = async (attachment: FilePreviewData) => {
      const fileData = reactive(attachment);
      if (!fileData.uploadedPath) return;
      try {
        await setDriveTemporary([fileData.uploadedPath], !!fileData.temporary);
      } catch (error) {
        fileData.temporary = !fileData.temporary;
        assertive(t('drive.errors.temporary', { reason: error instanceof Error ? error.message : '' }));
      }
    };

    const toggleFileTemporary = (index: number) => {
      const file = attachedFiles.value[index];
      if (!file || file.reused || file.fromDrive) return;
      file.temporary = !file.temporary;
      polite(file.temporary ? t('drive.composer.markedTemporary', { name: file.name }) : t('drive.composer.markedKept', { name: file.name }));
      if (file.uploadStatus === 'completed') void applyTemporary(file);
    };

    const openDrivePicker = () => {
      closeUploadMenu();
      showDrivePicker.value = true;
    };

    const attachFromDrive = async (files: DriveFile[]) => {
      showDrivePicker.value = false;
      const key = attachmentKey.value;
      const capacity = Math.max(0, maxMediaAttachments.value - attachedFiles.value.length);
      const picked = files.filter((f) => f.bucket === 'message_media').slice(0, capacity);
      const entries = await Promise.all(picked.map(async (f): Promise<FilePreviewData> => {
        const name = f.name || f.path.split('/').pop() || 'file';
        const type = f.mime_type || 'application/octet-stream';
        const url = await compatUrlFor(f.path);
        return {
          file: new File([], name, { type }),
          name,
          size: f.size_bytes,
          type,
          preview: type.startsWith('image/') || type.startsWith('video/') ? url : undefined,
          uploadStatus: 'completed',
          uploadProgress: 100,
          uploadedUrl: url,
          uploadedPath: f.path,
          fromDrive: true,
        };
      }));
      if (entries.length === 0) return;
      addDraftAttachments(key, entries);
      polite(t('messageA11y.upload.attached', { count: entries.length }, entries.length));
    };

    onMounted(() => {
      prepareMessageMediaUploads();
      void driveAvailable().then((ok) => {
        driveEnabled.value = ok;
      });
    });

    // A pasted Drive link of the caller's file that members of the room cannot open.
    const driveShareOffer = useDriveShareOffer((): DriveShareRoom | null => {
      if (props.conversationId) return { conversationId: props.conversationId };
      const channelId = props.threadChannelId || props.channelId;
      return channelId ? { channelId } : null;
    });
    const { getUserDisplayName } = useUserData();
    const driveShareOfferText = computed(() => {
      const offer = driveShareOffer.offer.value;
      if (!offer) return '';
      if (offer.gap.scope === 'user') {
        const { targets } = offer.gap;
        const name = targets.length === 1 ? getUserDisplayName(targets[0]).value : '';
        if (name && name !== 'Unknown User') return t('drive.offer.person', { name: `@${name}` });
        return targets.length
          ? t('drive.offer.people', { count: targets.length }, targets.length)
          : t('drive.offer.conversation');
      }
      return props.channelName && !props.threadId
        ? t('drive.offer.channel', { channel: `#${props.channelName}` })
        : t('drive.offer.thisChannel');
    });
    const onComposerPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain');
      if (text && driveEnabled.value) void driveShareOffer.checkText(text);
    };
    const shareOfferedDriveFile = async () => {
      try {
        await driveShareOffer.share();
        toast.success(t('drive.offer.shared'));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    };

    const setFileAltText = (index: number, altText: string) => {
      const file = attachedFiles.value[index];
      if (!file) return;
      file.altText = altText.trim() || undefined;
      polite(file.altText ? t('messageA11y.alt.saved', { name: file.name }) : t('messageA11y.alt.removed', { name: file.name }));
    };

    const removeFile = (index: number) => {
      const removedFile = attachedFiles.value[index];
      if (!removedFile) return;
      attachedFiles.value = attachedFiles.value.filter((_, i) => i !== index);
      releaseAttachment(removedFile);
      polite(t('messageA11y.upload.removed', { name: removedFile.name }));
    };

    // A drag that starts in the editor (selected text) is the editor's own: the browser moves
    // the text. Its events stop here uncancelled, as the chat's own drop zone (ChatComponent)
    // cancels every drop it sees.
    let dragFromEditor = false;
    const handleDragStart = (event: DragEvent) => {
      const target = event.target as Node | null;
      const element = target?.nodeType === Node.ELEMENT_NODE ? target as Element : target?.parentElement;
      dragFromEditor = !!element?.closest('.rich-text-editor');
    };
    const handleDragEnd = () => {
      dragFromEditor = false;
    };

    const handleDragEnter = (event: DragEvent) => {
      if (dragFromEditor) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      isDragging.value = true;
    };

    const handleDragOver = (event: DragEvent) => {
      if (dragFromEditor) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
    };

    const handleDragLeave = (event: DragEvent) => {
      if (dragFromEditor) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      const currentTarget = event.currentTarget as HTMLElement;
      const relatedTarget = event.relatedTarget as Node | null;
      if (!currentTarget?.contains(relatedTarget)) {
        isDragging.value = false;
      }
    };

    const handleDrop = async (event: DragEvent) => {
      if (dragFromEditor) {
        dragFromEditor = false;
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      isDragging.value = false;

      const files = event.dataTransfer?.files;
      if (files && files.length > 0) {
        const fileArray = Array.from(files);
        await handleFilesSelected(fileArray);
        return;
      }
      // The drop is cancelled for files; dropped text or a dragged link goes in where it lands.
      const text = event.dataTransfer?.getData('text/plain');
      if (text) richEditorRef.value?.insertAtPoint(text.replace(/\r\n?/g, '\n'), event.clientX, event.clientY);
    };

    const handleExternalFileDrop = (event: CustomEvent) => {
      const { files } = event.detail;
      if (files && files.length > 0) {
        handleFilesSelected(files);
      }
    };

    onMounted(() => {
      document.addEventListener('external-file-drop', handleExternalFileDrop as EventListener);
    });

    // Drafts with a key keep their attachments for the next composer that shows them.
    let closeShownDraft: (() => void) | null = null;
    watch(attachmentKey, (key) => {
      closeShownDraft?.();
      closeShownDraft = openDraftAttachments(key);
      // A send held for uploads belongs to the draft it was pressed in.
      holdingSend.value = null;
    }, { immediate: true });

    onUnmounted(() => {
      document.removeEventListener('external-file-drop', handleExternalFileDrop as EventListener);
      closeShownDraft?.();
      discardDraftAttachments(ownDraftKey);
    });

    watch(() => props.replyMessageId, (newId) => {
      if (newId) {
        nextTick(() => {
          richEditorRef.value?.focus();
        });
      }
    });

    // Desktop only: focus follows channel/DM navigation.
    watch(
      () => [props.channelId, props.conversationId],
      () => {
        if (!isMobile.value) {
          nextTick(() => {
            richEditorRef.value?.focus();
          });
        }
      }
    );

    watch(attachedFiles, (newFiles) => {
      emit('files-attached', newFiles);
    }, { deep: true });

    watch(() => props.modelValue, (newValue, oldValue) => {
      if (newValue && newValue.trim().length > 0 && isEditorFocused.value && newValue !== oldValue) {
        debug.log('MessageInput: modelValue changed, triggering typing:', newValue.length, 'chars')
        handleTyping()
      }
    });
    
    // Focusing an editor that already holds content counts as typing.
    watch(() => isEditorFocused.value, (focused) => {
      if (focused && props.modelValue && props.modelValue.trim().length > 0) {
        handleTyping()
      }
    });

    /**
     * Shakes the input and refocuses, reusing the over-limit buzz animation.
     * ChatComponent calls this when server policy refuses a send (required
     * E2EE), matching the over-limit feedback instead of failing silently.
     */
    const flashRejection = () => {
      overLimitBuzz.value = false;
      nextTick(() => {
        overLimitBuzz.value = true;
        window.setTimeout(() => { overLimitBuzz.value = false; }, 450);
      });
      if (richEditorRef.value?.focus) richEditorRef.value.focus();
    };

    /**
     * Puts back attachments a backgroundSend parent handed over and could not queue.
     * Their previews and running uploads return to the shown draft.
     */
    const restoreAttachments = (files: FilePreviewData[]) => {
      attachedFiles.value = [...files.map(file => toRaw(file)), ...attachedFiles.value];
      emit('files-attached', attachedFiles.value);
      emit('upload-status-changed', hasActiveUploads());
    };

    const focusEditor = () => {
      richEditorRef.value?.focus?.();
    };

    /** Inserts `text` at the editor's caret, or its last caret while focus was elsewhere. */
    const insertAtCaret = (text: string): boolean => {
      if (!richEditorRef.value?.insertAtCaret) return false;
      richEditorRef.value.insertAtCaret(text);
      return true;
    };

    /** Empties the text field; attachments stay. */
    const clearText = () => {
      emit('update:modelValue', '');
      richEditorRef.value?.clear?.();
    };

    defineExpose({
      composerRef,
      gifTriggerRef,
      emojiTriggerRef,
      flashRejection,
      restoreAttachments,
      focusEditor,
      insertAtCaret,
      clearText
    });


</script>

<style scoped>
  .message-input {
    display: flex;
    padding: 8px 12px 0 12px;
    flex-direction: column;
    flex-shrink: 0;
    position: relative;
  }

  /* Fixed height whether or not anyone is typing, so the list never shifts. */
  .composer-status {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 24px;
    min-width: 0;
    padding: 0 4px;
  }

  .typing-indicator-wrapper {
    flex: 1 1 auto;
    min-width: 0;
    pointer-events: none;
  }

  .message-input.replying,
  .message-input.has-files {
    padding-top: 0;
  }
  
  .message-input.replying .message-container {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }

  .message-input.has-files .message-container {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }

  /* Read-only state when the user lacks SEND_MESSAGES on the current channel.
     Mirrors Discord's no-permission banner. */
  .message-readonly-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    margin: 0 12px 12px;
    background: var(--background-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.4;
    user-select: none;
  }

  .message-readonly-banner svg {
    flex-shrink: 0;
    color: var(--text-tertiary, var(--text-secondary));
  }

  .server-suspended-banner {
    border-color: color-mix(in srgb, var(--warning, #f0b232) 55%, var(--border-color));
    color: var(--text-primary);
  }

  .server-suspended-banner svg {
    color: var(--warning, #f0b232);
  }

  .server-suspended-reason {
    margin-left: 6px;
    color: var(--text-secondary);
  }

  .command-param-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--background-quaternary);
    border-bottom: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);
  }

  .inline-gif-picker + .command-param-bar {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }

  .command-param-bar:first-child,
  .command-param-bar:not(.inline-gif-picker + .command-param-bar) {
    border-top-left-radius: 8px;
    border-top-right-radius: 8px;
  }

  .command-param-bar + .message-container {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }

  .command-param-info {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .command-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--harmony-primary-alpha, color-mix(in srgb, var(--harmony-primary) 15%, transparent));
    color: var(--accent-color, var(--harmony-primary));
    font-size: 12px;
    font-weight: 600;
  }

  .command-param-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }

  .param-name {
    color: var(--text-primary);
    font-weight: 600;
    font-size: 12px;
  }

  .param-description {
    color: var(--text-muted);
    font-size: 12px;
  }

  .command-param-dismiss {
    background: none;
    border: none;
    padding: 4px;
    cursor: pointer;
    color: var(--text-muted);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .command-param-dismiss:hover {
    background: color-mix(in srgb, var(--text-primary) 15%, transparent);
    color: var(--text-primary);
  }

  .left-icons {
    padding-left: 10px;
  }
  
  .left-icons, .right-icons {
    display: flex;
    align-items: center;
  }
  
  .right-icons {
    padding-right: 10px;
  }

  .message-char-count {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    padding: 0 6px;
    user-select: none;
    pointer-events: auto;
  }

  .slowmode-indicator {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    padding: 2px 6px;
    border-radius: var(--radius-full);
    user-select: none;
  }

  .slowmode-indicator.cooling {
    color: var(--text-link);
    background: color-mix(in srgb, var(--harmony-primary) 12%, transparent);
  }

  .message-char-count.over-limit {
    color: var(--text-danger);
    font-weight: 600;
  }

  .plus-icon-container {
    position: relative;
    background-color: var(--background-modifier-active);
    border-radius: 100%;
    width: 28px;
    height: 28px;
    text-align: center;
    cursor: pointer;
    padding: 4px;
    transition: 0.25s;
  }
  .plus-icon-container:hover {
    background-color: color-mix(in srgb, var(--text-primary) 24%, transparent);
  }

  .attach-button {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: inherit;
    background: none;
    color: inherit;
    cursor: pointer;
  }

  .attach-button:focus-visible,
  .icon-button:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 2px;
  }

  .message-container {
    position: relative;
    display: flex;
    align-items: center;
    flex-grow: 1;
    padding: 4px 8px;
    border-radius: 8px;
    border: none;
    background-color: var(--background-quaternary);
    transition: .2s;
  }

  /* Red outline while the draft exceeds the character cap, before any send
   * attempt. */
  .message-container.has-over-limit {
    outline: 1px solid var(--error);
    outline-offset: 0;
  }

  /* Buzz fires on an over-limit send attempt. Transform-only horizontal
   * shake, so adjacent UI does not move. The toast carries the explanation. */
  .message-container.buzz-over-limit {
    animation: message-input-buzz 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
  }

  @keyframes message-input-buzz {
    10%, 90% { transform: translate3d(-1px, 0, 0); }
    20%, 80% { transform: translate3d(2px, 0, 0); }
    30%, 50%, 70% { transform: translate3d(-4px, 0, 0); }
    40%, 60% { transform: translate3d(4px, 0, 0); }
  }

  .textarea-wrapper {
    flex-grow: 1;
    position: relative;
    margin-left: 10px;
    margin-right: 10px;
  }

  .voice-recording-wrapper {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
  }

  .message-container:has(.rich-text-editor.is-focused) {
    box-shadow: 0 0 0 1px var(--border-hover);
  }

  .icon-button {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: background-color 0.2s;
    min-width: 24px;
    min-height: 24px;
  }

  .icon-button:hover {
    background-color: var(--background-modifier-hover);
  }

  /* GIF and emoji share the mic's box (VoiceRecorder .mic-trigger): 32px, colour, hover. */
  .composer-tool {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    color: var(--text-secondary);
    transition: color 0.15s ease, background-color 0.15s ease;
  }

  .composer-tool:hover {
    color: var(--text-primary);
  }

  .composer-tool > svg {
    transition: transform 0.2s;
  }

  @media (hover: hover) {
    .composer-tool:hover > svg {
      transform: scale(1.14);
    }
  }

  /* Send button; rendered on mobile only. */
  .send-button {
    background-color: var(--harmony-primary-fill) !important;
    border-radius: 50% !important;
    width: 40px !important;
    height: 40px !important;
    min-width: 40px !important;
    color: var(--text-on-primary);
    transition: transform 0.15s ease, background-color 0.2s ease;
  }

  .send-button:hover {
    background-color: var(--harmony-primary-fill-hover) !important;
  }

  .send-button:active {
    transform: scale(0.95);
  }

  .send-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .send-button svg {
    margin-left: 2px; /* Optical centering for the arrow glyph. */
  }

  /* Compact composer. One strip with 8px edges; the text field is the only
     pill. Buttons sit on the strip and align to the field's last line. */
  @media (max-width: 768px) {
    .message-input,
    .message-input.replying,
    .message-input.has-files {
      padding: 8px;
      background: var(--background-secondary);
      border-top: 1px solid var(--border-primary);
    }

    /* No reserved row under the keyboard: the status strip rides on the
       composer's top edge as a tab over the message list, short of the
       jump-to-present pill on the right. */
    .composer-status {
      position: absolute;
      bottom: 100%;
      left: 0;
      height: auto;
      max-width: calc(100% - 64px);
      padding: 0;
    }

    /* Qualified to outrank TypingIndicator's own padding rule. */
    .message-input .typing-indicator-wrapper {
      padding: 2px 8px;
      border-top-right-radius: 8px;
      background: var(--background-secondary);
    }

    .message-readonly-banner {
      margin: 0;
    }

    /* Reply bar, attachment preview and command bar stand above the row as
       cards on the same edges. */
    .attachedBars,
    .file-preview-container,
    .command-param-bar {
      border-radius: 8px;
      margin-bottom: 6px;
    }

    .message-container {
      gap: 6px;
      align-items: flex-end;
      padding: 0;
      border-radius: 0;
      background: transparent;
    }

    .message-container:has(.rich-text-editor.is-focused) {
      box-shadow: none;
    }

    .message-container.has-over-limit {
      outline: none;
    }

    .left-icons,
    .right-icons {
      align-items: flex-end;
      padding: 0;
    }

    /* 40px touch targets. Width and opacity carry the fold. */
    .left-icons > *,
    .right-icons > * {
      flex-shrink: 0;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: width 0.15s ease, opacity 0.15s ease, visibility 0s,
        background-color 0.2s ease, transform 0.15s ease;
    }

    /* Visibility flips after the fade, taking folded controls out of tab
       order and the accessibility tree. */
    .left-icons > .is-collapsed,
    .right-icons > .is-collapsed {
      width: 0;
      min-width: 0;
      opacity: 0;
      visibility: hidden;
      overflow: hidden;
      pointer-events: none;
      transition: width 0.15s ease, opacity 0.15s ease, visibility 0s 0.15s;
    }

    .plus-icon-container,
    .composer-expand {
      padding: 0;
      border-radius: 20px;
      background-color: var(--background-modifier-active);
    }

    .composer-expand {
      color: var(--text-secondary);
    }

    .right-icons button {
      border-radius: 20px;
    }

    .right-icons > .composer-send-enter-active,
    .right-icons > .composer-send-leave-active {
      transition: width 0.15s ease, min-width 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
    }

    .right-icons > .composer-send-enter-from,
    .right-icons > .composer-send-leave-to {
      width: 0 !important;
      min-width: 0 !important;
      opacity: 0;
      transform: scale(0.6);
    }

    .textarea-wrapper {
      display: flex;
      align-items: flex-end;
      flex: 1 1 auto;
      min-width: 0;
      margin: 0;
      border-radius: 20px;
      background-color: var(--background-quaternary);
      transition: box-shadow 0.2s;
    }

    .textarea-wrapper:has(.rich-text-editor.is-focused) {
      box-shadow: 0 0 0 1px var(--border-hover);
    }

    .message-container.has-over-limit .textarea-wrapper {
      outline: 1px solid var(--error);
    }

    .textarea-wrapper .rich-text-editor {
      flex: 1 1 auto;
      min-width: 0;
      padding: 9px 4px 9px 14px;
    }

    .textarea-wrapper .rich-text-editor.is-empty::before {
      top: 9px;
      left: 14px;
      right: 4px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .field-trailing {
      display: flex;
      align-items: center;
      flex-shrink: 0;
      height: 40px;
    }

    .field-trailing .icon-button {
      width: 40px;
      height: 40px;
      border-radius: 20px;
    }

    .voice-recording-wrapper {
      min-height: 40px;
      border-radius: 20px;
      background-color: var(--background-quaternary);
    }

    .sprite {
      --scaleFactor: 1.25;
    }
  }

  /* prefers-reduced-motion: no shake, outline stays; folds and the send
     button switch without animating. */
  @media (prefers-reduced-motion: reduce) {
    .message-container.buzz-over-limit {
      animation: none;
    }

    .left-icons > *,
    .right-icons > *,
    .left-icons > .is-collapsed,
    .right-icons > .is-collapsed,
    .right-icons > .composer-send-enter-active,
    .right-icons > .composer-send-leave-active {
      transition: none;
    }
  }
</style>
