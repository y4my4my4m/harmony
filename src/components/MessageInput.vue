<template>
  <div ref="composerRef" class="message-input" data-region="composer" :class="{'replying': replyMessageId, 'has-files': attachedFiles.length > 0}" data-testid="message-input" data-floating-video-avoid>
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
      @remove-file="removeFile"
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
    <!-- Read-only state: user lacks SEND_MESSAGES on this channel.
         Backend RLS and triggers enforce it; this is UX, not security. -->
    <div v-if="!canSendMessages" class="message-readonly-banner" role="status">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
        <path d="M12 1a4.5 4.5 0 0 0-4.5 4.5V9H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V11a2 2 0 0 0-2-2h-1.5V5.5A4.5 4.5 0 0 0 12 1zm-2.5 4.5a2.5 2.5 0 0 1 5 0V9h-5V5.5z"/>
      </svg>
      <span>{{ readOnlyPlaceholder }}</span>
    </div>

    <div v-else
         class="message-container"
         :class="{ 'buzz-over-limit': overLimitBuzz, 'has-over-limit': messageTooLong }"
         @dragenter.prevent="handleDragEnter"
         @dragover.prevent="handleDragOver"
         @dragleave.prevent="handleDragLeave"
         @drop.prevent="handleDrop">
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
            <PlusIcon @click="toggleUploadMenu" :class="{ active: showUploadMenu }" />
            <FileUploadMenu
              :isVisible="showUploadMenu"
              @files-selected="handleFilesSelected"
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
              :aria-live="messageTooLong ? 'assertive' : 'polite'"
              :title="charCountTitle"
            >{{ maxMessageLength - characterCount }}</span>
            <button ref="emojiTriggerRef" @click.stop="toggleEmojiList" class="icon-button" aria-label="Emoji" title="Emoji">
              <EmojiUI />
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
            :aria-live="messageTooLong ? 'assertive' : 'polite'"
            :title="charCountTitle"
          >{{ maxMessageLength - characterCount }}</span>
          <VoiceRecorder
            :class="{ 'is-collapsed': actionsCollapsed }"
            :disabled="hasContent"
            @recording-started="isVoiceRecording = true"
            @recording-complete="handleVoiceRecordingComplete"
            @recording-cancelled="isVoiceRecording = false"
          />
          <button ref="gifTriggerRef" @click.stop="toggleGiphy" class="icon-button" :class="{ 'is-collapsed': actionsCollapsed }" aria-label="GIFs" title="GIFs">
            <GifIcon />
          </button>
          <button v-if="!isCompact" ref="emojiTriggerRef" @click.stop="toggleEmojiList" class="icon-button" aria-label="Emoji" title="Emoji">
            <EmojiUI />
          </button>
          <Transition name="composer-send">
            <button
              v-if="isMobile && hasContent"
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
import { ref, computed, watch, onMounted, onUnmounted, nextTick, markRaw, toRaw } from 'vue';
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
import FileUploadMenu from '@/components/FileUploadMenu.vue';
import AutoSuggest from '@/components/AutoSuggest.vue';
import RichTextEditor from '@/components/RichTextEditor.vue';
import VoiceRecorder from '@/components/VoiceRecorder.vue';
import InlineGifPicker from '@/components/InlineGifPicker.vue';
import Icon from '@/components/common/Icon.vue';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { parseKlipyKind } from '@/utils/klipyAttribution';
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
import { forgetMessageMediaUpload, startMessageMediaUpload, UploadAbortedError } from '@/services/messageMediaUpload';
import type { VoiceRecordingResult } from '@/services/voiceRecordingService';
import { useAuthStore } from '@/stores/auth';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import { roleService, Permission } from '@/services/RoleService';

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
}

const props = withDefaults(defineProps<Props>(), {
  giphyOpen: false,
  emojiListOpen: false,
  modelValue: '',
  replyMessageId: '',
  serverId: undefined,
  backgroundSend: false,
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
}>();

const authStore = useAuthStore();
const toast = useToast();
const { t } = useI18n();

const uploadRoom = computed(() =>
  props.mediaRoom ?? roomOf({ channelId: props.channelId, conversationId: props.conversationId }));
const { triggerMessage } = useHapticSettings();
const { recordEmojiUsage } = useFrequentEmojis();
const showUploadMenu = ref(false);
const attachedFiles = ref<FilePreviewData[]>([]);
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
  if (!props.channelId || props.conversationId) {
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
      roleService.hasPermission(userId, serverId, Permission.SEND_MESSAGES, props.channelId),
      roleService.hasPermission(userId, serverId, Permission.MANAGE_MESSAGES, props.channelId),
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
  () => [props.channelId, authStore.session?.user?.id, serverChannelStore.currentServerId],
  () => { void refreshSendPermission(); },
  { immediate: true },
);

const readOnlyPlaceholder = computed(() => {
  if (isResolvingPermissions.value) return 'Checking permissions...';
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
  
  if (cursorPosition !== undefined && richEditorRef.value) {
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
});

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
      if (event.key === 'Enter' && !event.isComposing && !event.shiftKey && !isMobile.value) {
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
        if (!holdingSend.value) {
          holdingSend.value = true;
          attachedFiles.value.filter(file => file.uploadStatus === 'pending').forEach(startBackgroundUpload);
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

    // Enter pressed while uploads run, without backgroundSend; sends once they finish.
    const holdingSend = ref(false);

    const hasUnfinishedUploads = () =>
      attachedFiles.value.some(file => file.uploadStatus === 'uploading' || file.uploadStatus === 'pending');

    watch(() => attachedFiles.value.map(file => file.uploadStatus), () => {
      if (!holdingSend.value || hasUnfinishedUploads()) return;
      holdingSend.value = false;
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

    const toggleUploadMenu = (event?: Event) => {
      if (event) {
        event.stopPropagation();
      }
      showUploadMenu.value = !showUploadMenu.value;
    };

    const closeUploadMenu = () => {
      showUploadMenu.value = false;
      actionsExpanded.value = false;
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

    // The file stays in the composer while it is attached; after a backgroundSend
    // hand-off the upload belongs to the parent and the composer stops tracking it.
    const isAttached = (fileData: FilePreviewData) =>
      attachedFiles.value.some(file => toRaw(file) === toRaw(fileData));

    const refreshUploads = () => {
      attachedFiles.value = [...attachedFiles.value];
      emit('upload-status-changed', hasActiveUploads());
    };

    const startBackgroundUpload = (fileData: FilePreviewData) => {
      const uploaderId = authStore.session?.user?.id;
      if (!uploaderId) return;
      const room = uploadRoom.value;
      if (!room) {
        fileData.uploadStatus = 'error';
        fileData.uploadError = 'Attachments need a channel or conversation';
        refreshUploads();
        return;
      }

      const upload = markRaw(startMessageMediaUpload(
        messageMediaPath(room, uploaderId, fileData.file.name),
        fileData.file,
        {
          validate: true,
          onProgress: (fraction) => {
            if (!isAttached(fileData)) return;
            fileData.uploadProgress = fraction * 100;
            refreshUploads();
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
        },
        (error: unknown) => {
          if (error instanceof UploadAbortedError) return;
          fileData.uploadStatus = 'error';
          fileData.uploadError = error instanceof Error ? error.message : 'Upload failed';
          fileData.uploadProgress = 0;
        },
      ).finally(() => {
        if (isAttached(fileData)) refreshUploads();
      });
    };

    const hasActiveUploads = () => {
      return attachedFiles.value.some(file => file.uploadStatus === 'uploading');
    };

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
      const limit = maxMediaAttachments.value;
      const capacity = Math.max(0, limit - attachedFiles.value.length);
      if (capacity <= 0) return;
      const filesToAdd = Array.from(files).slice(0, capacity);
      const newFiles = await Promise.all(filesToAdd.map(createFilePreview));

      attachedFiles.value.push(...newFiles);
      emit('files-attached', attachedFiles.value);
      
      newFiles.forEach((fileData) => {
        startBackgroundUpload(fileData);
      });
      
      closeUploadMenu();
    };

    const removeFile = (index: number) => {
      const removedFile = attachedFiles.value[index];

      if (removedFile.preview) {
        URL.revokeObjectURL(removedFile.preview);
      }
      removedFile.upload?.abort();
      forgetMessageMediaUpload(removedFile.upload?.path);

      attachedFiles.value.splice(index, 1);
      emit('files-attached', attachedFiles.value);
      emit('upload-status-changed', hasActiveUploads());
    };

    const handleDragEnter = (event: DragEvent) => {
      event.preventDefault();
      isDragging.value = true;
    };

    const handleDragOver = (event: DragEvent) => {
      event.preventDefault();
    };

    const handleDragLeave = (event: DragEvent) => {
      event.preventDefault();
      const currentTarget = event.currentTarget as HTMLElement;
      const relatedTarget = event.relatedTarget as Node | null;
      if (!currentTarget?.contains(relatedTarget)) {
        isDragging.value = false;
      }
    };

    const handleDrop = async (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      isDragging.value = false;

      const files = event.dataTransfer?.files;
      if (files && files.length > 0) {
        const fileArray = Array.from(files);
        await handleFilesSelected(fileArray);
      }
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

    onUnmounted(() => {
      document.removeEventListener('external-file-drop', handleExternalFileDrop as EventListener);

      // Attachments still in the composer are discarded with it.
      attachedFiles.value.forEach(file => {
        if (file.preview) {
          URL.revokeObjectURL(file.preview);
        }
        file.upload?.abort();
        forgetMessageMediaUpload(file.upload?.path);
      });
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
     * Their previews and running uploads return to the composer's care.
     */
    const restoreAttachments = (files: FilePreviewData[]) => {
      attachedFiles.value = [...files.map(file => toRaw(file)), ...attachedFiles.value];
      emit('files-attached', attachedFiles.value);
      emit('upload-status-changed', hasActiveUploads());
    };

    defineExpose({
      composerRef,
      gifTriggerRef,
      emojiTriggerRef,
      flashRejection,
      restoreAttachments
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
    color: var(--harmony-primary);
    background: color-mix(in srgb, var(--harmony-primary) 12%, transparent);
  }

  .message-char-count.over-limit {
    color: var(--error);
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

  /* Send button; rendered on mobile only. */
  .send-button {
    background-color: var(--harmony-primary) !important;
    border-radius: 50% !important;
    width: 40px !important;
    height: 40px !important;
    min-width: 40px !important;
    color: var(--text-on-primary);
    transition: transform 0.15s ease, background-color 0.2s ease;
  }

  .send-button:hover {
    background-color: var(--harmony-primary-hover) !important;
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
