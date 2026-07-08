<template>
  <div class="message-input" :class="{'replying': replyMessageId, 'has-files': attachedFiles.length > 0}" data-testid="message-input">
    <!-- Typing Indicator - positioned absolutely above input -->
    <TypingIndicator
      :typing-users="typingUsers"
      class="typing-indicator-wrapper"
    />
    
    <MessageReply
      v-if="replyMessageId"
      :replyMessageId="replyMessageId"
      :channel-id="channelId"
      :conversation-id="conversationId"
      :server-id="serverId"
      @update:replyMessageId="handleDontReply"
    />
    <FilePreview
      :files="attachedFiles"
      @remove-file="removeFile"
    />
    <!-- Inline media results (live search during /gif, /sticker, /clip, /meme, /aiemoji) -->
    <InlineGifPicker
      v-if="inlineMediaType"
      :query="modelValue || ''"
      :media-type="inlineMediaType"
      @selectGif="handleInlineGifSelect"
    />
    <!-- Command parameter hint bar (Discord-style) -->
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
         Backend RLS / triggers still enforce - this is UX, not security. -->
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
      <!-- Voice recording mode: replaces the normal input -->
      <div v-if="isVoiceRecording" class="voice-recording-wrapper">
        <VoiceRecorder
          auto-start
          @recording-complete="handleVoiceRecordingComplete"
          @recording-started="isVoiceRecording = true"
          @recording-cancelled="isVoiceRecording = false"
        />
      </div>

      <!-- Normal input mode -->
      <template v-else>
        <div class="left-icons">
          <div class="plus-icon-container">
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
        </div>
        <div class="right-icons">
          <span
            v-if="slowmodeActive"
            class="slowmode-indicator"
            :class="{ cooling: slowmodeRemaining > 0 }"
            :title="slowmodeRemaining > 0
              ? `Slowmode: you can send again in ${slowmodeRemaining}s`
              : `Slowmode is on: one message every ${slowmodeSeconds}s`"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 10.59V7h-2v6.41l4.29 4.3 1.42-1.42z"/>
            </svg>
            <span v-if="slowmodeRemaining > 0">{{ slowmodeRemaining }}s</span>
          </span>
          <!--
            Character count: only shown when approaching / over the limit
            so it doesn't clutter the input for short messages. Red when
            over the limit; the send button is disabled separately via
            `hasContent`.
          -->
          <span
            v-if="showCharCount"
            class="message-char-count"
            :class="{ 'over-limit': messageTooLong }"
            :aria-live="messageTooLong ? 'assertive' : 'polite'"
            :title="messageTooLong ? `Message too long (${characterCount} / ${maxMessageLength})` : `${characterCount} / ${maxMessageLength}`"
          >{{ maxMessageLength - characterCount }}</span>
          <VoiceRecorder
            :disabled="hasContent"
            @recording-started="isVoiceRecording = true"
            @recording-complete="handleVoiceRecordingComplete"
            @recording-cancelled="isVoiceRecording = false"
          />
          <button ref="gifTriggerRef" @click.stop="toggleGiphy" class="icon-button">
            <GifIcon />
          </button>
          <button ref="emojiTriggerRef" @click.stop="toggleEmojiList" class="icon-button">
            <EmojiUI />
          </button>
          <button 
            v-if="isMobile && hasContent" 
            @click.stop="send" 
            class="icon-button send-button"
            data-testid="message-send-btn"
            :disabled="!hasContent"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
      </template>
    </div>
    
    <!-- Auto-suggest component -->
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
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
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
import { backgroundUploadManager } from '@/services/fileService';
import type { VoiceRecordingResult } from '@/services/voiceRecordingService';
import { supabase } from '@/supabase';
import { useAuthStore } from '@/stores/auth';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import { roleService, Permission } from '@/services/RoleService';
import { v4 as uuidv4 } from 'uuid';

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
}

const props = withDefaults(defineProps<Props>(), {
  giphyOpen: false,
  emojiListOpen: false,
  modelValue: '',
  replyMessageId: '',
  serverId: undefined,
});

// Dynamic placeholder target (channel or DM user)
const placeholderTarget = computed(() => {
  if (props.username) return `@${props.username}`;
  if (props.channelName) return `#${props.channelName}`;
  return '';
});

interface VoiceMessageData {
  url: string
  duration: number
  waveform: number[]
  mimeType: string
}

// Tuple-based defineEmits is the modern Vue 3 syntax and plays better
// with vue-tsc's `(...args: any[]) => any` listener-prop type than the
// older call-signature interface form, which produced contravariance
// errors at every parent's `@sendMessage="..."` / `@toggleEmojiList="..."`
// binding site (TS2322: "Target requires N element(s) but source may have
// fewer"). See the matching note in MessageContextMenu.vue.
const emit = defineEmits<{
  'update:modelValue': [value: string]
  sendMessage: [content: string, files: FilePreviewData[], replyMessageId?: string]
  sendVoiceMessage: [data: VoiceMessageData]
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
const { triggerMessage } = useHapticSettings();
const { recordEmojiUsage } = useFrequentEmojis();
const showUploadMenu = ref(false);
const attachedFiles = ref<FilePreviewData[]>([]);
const isDragging = ref(false);
const richEditorRef = ref<InstanceType<typeof RichTextEditor>>();
const isEditorFocused = ref(false);
const gifTriggerRef = ref<HTMLElement | null>(null);
const emojiTriggerRef = ref<HTMLElement | null>(null);
const isVoiceRecording = ref(false);
const voiceUploading = ref(false);
// Flips for ~400ms whenever the user tries to send an over-limit message -
// drives the .buzz CSS animation on the container so the user sees the
// message wasn't sent, without losing their draft.
const overLimitBuzz = ref(false);

const serverChannelStore = useServerChannelStore()

// Send permission gating (channel-level role permissions)
// must be declared AFTER `authStore` / `serverChannelStore` above
// because the immediate-watch resolves synchronously and would otherwise hit a
// temporal-dead-zone (`Cannot access 'authStore' before initialization`).
const canSendMessages = ref(true); // optimistic until first resolution
const isResolvingPermissions = ref(false);

// --- Channel slowmode ---
// DB trigger `enforce_channel_slowmode` is the source of truth; this is the
// matching client UX (countdown + disabled send). MANAGE_MESSAGES is exempt.
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
// broadcasts it so the countdown resyncs to the authoritative value.
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

// Typing context - use props first, fall back to store
// This is a computed that Vue can properly track for reactivity
const typingContext = computed(() => {
  if (props.threadId) {
    return { type: 'thread' as const, threadId: props.threadId }
  }
  if (props.conversationId) {
    return { type: 'conversation' as const, conversationId: props.conversationId }
  }
  // Use props.channelId first, fall back to store's currentChannelId
  // The store is set in ChatView's loadMessages which fires with immediate: true
  const channelId = props.channelId || serverChannelStore.currentChannelId
  if (channelId) {
    return { type: 'channel' as const, channelId }
  }
  return null
})

// Pass the computed getter - this properly tracks all reactive dependencies
const { typingUsers, startTyping, stopTyping } = useTypingIndicator(() => typingContext.value)

// DEBUG: Track context changes for typing indicator debugging
watch(typingContext, (newCtx, oldCtx) => {
  debug.log('MessageInput: typingContext changed:', newCtx, 'from:', oldCtx)
}, { immediate: true })

// Track if we've started typing (to avoid sending multiple "on" events)
let hasStartedTyping = false
let typingResetTimeout: number | null = null
const TYPING_RESET_MS = 2000 // Reset after 2 seconds of no typing to allow re-triggering

// Mobile = small screen OR touch-only device (no mouse)
const { isMobileViewport, isTouchOnly } = useViewport();
const isMobile = computed(() => isMobileViewport.value || isTouchOnly);

// Character count of the raw editor text. Used to surface a counter when
// the user is close to / over the limit. We count the raw editor string
// (which includes markdown markers like `**`); the backend counts the
// parsed text part lengths and is the authoritative limit, but the two
// values are close enough that this is a useful UX guide.
const characterCount = computed(() => (props.modelValue || '').length);

// Authoritative soft limit. Comes from the admin's
// `instance_config.max_message_length` (loaded by `useInstanceSettings`).
// We fall back to the default for the brief period before the settings
// store has loaded, and clamp to the DB-side hard ceiling so a
// misconfigured admin can't push the soft limit past what the DB will
// accept. The store is already instantiated below for the
// `allowCustomEmojisInDisplayNames` / `maxMediaAttachmentsPerPost` reads.
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

// Check if there's content to send. Over-limit messages STILL count as
// "having content" so the send button stays enabled - clicking it (or
// pressing Enter) routes through `send()` which buzzes the input and
// toasts an error, instead of silently dropping the user's draft.
const hasContent = computed(() => {
  return (props.modelValue?.trim().length ?? 0) > 0 || attachedFiles.value.length > 0;
});

const handleVoiceRecordingComplete = async (result: VoiceRecordingResult) => {
  const userId = authStore.session?.user?.id
  if (!userId) return

  debug.log('Voice recording complete:', { duration: result.duration, blobSize: result.blob.size, mimeType: result.mimeType, waveformLength: result.waveform?.length })

  voiceUploading.value = true
  try {
    const ext = result.mimeType.includes('webm') ? 'webm' : result.mimeType.includes('ogg') ? 'ogg' : 'mp4'
    const filePath = `${userId}/voice/${crypto.randomUUID()}.${ext}`

    const { data: uploadData, error } = await supabase.storage
      .from('user_media')
      .upload(filePath, result.blob, { contentType: result.mimeType })

    if (error) throw error
    debug.log('Voice upload success:', { path: uploadData?.path || filePath })

    const { data } = supabase.storage.from('user_media').getPublicUrl(filePath)
    debug.log('Voice public URL:', data.publicUrl)

    if (data.publicUrl) {
      emit('sendVoiceMessage', {
        url: data.publicUrl,
        duration: result.duration,
        waveform: result.waveform,
        mimeType: result.mimeType,
      })
    } else {
      debug.error('No public URL returned for voice message')
    }
  } catch (err) {
    debug.error('Failed to upload voice message:', err)
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

// Auto-suggest setup
// Read straight from the editor: `props.modelValue` lags one keystroke behind (v-model
// round-trip), so synchronous post-keystroke handlers would see the pre-keystroke value.
// props.modelValue fallback covers the window before richEditorRef mounts.
const getCurrentText = () => richEditorRef.value?.getPlainText?.() ?? props.modelValue;
const updateText = (newText: string, cursorPosition?: number) => {
  debug.log('MessageInput updateText called:', { newText, cursorPosition });
  
  // Set cursor position after text update if provided
  if (cursorPosition !== undefined && richEditorRef.value) {
    // Set the skip flag BEFORE emitting the update
    debug.log('Setting skipNextWatch to true');
    richEditorRef.value.skipNextWatch = true;
    
    emit('update:modelValue', newText);
    
    nextTick(() => {
      // Now render the content manually with skip cursor restore
      if (richEditorRef.value?.renderContent) {
        debug.log('Calling manual renderContent with skipCursorRestore=true');
        richEditorRef.value.renderContent(newText, true); // Skip cursor restore
      }
      
      // Focus FIRST, then set cursor position
      nextTick(() => {
        if (richEditorRef.value) {
          debug.log('Focusing editor FIRST');
          richEditorRef.value.focus();
          
          // Wait longer to ensure focus and DOM are stable
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
    // Normal text update without cursor control
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
      emit('update:modelValue', value)
      handleTyping()
    }

    const handleEditorInput = () => {
      // The model value is handled by the update:model-value event
      // Typing indicator is triggered in handleModelValueUpdate to avoid duplicate calls
    };

    const handleTyping = () => {
      if (!typingContext.value) {
        return
      }
      
      if (typingResetTimeout) {
        clearTimeout(typingResetTimeout)
        typingResetTimeout = null
      }
      
      // Only send "on" event if we haven't started typing yet
      if (!hasStartedTyping) {
        hasStartedTyping = true
        startTyping()
      }
      
      // Reset flag after inactivity (allows re-triggering if user pauses then continues)
      typingResetTimeout = window.setTimeout(() => {
        hasStartedTyping = false
      }, TYPING_RESET_MS)
    };

    const handleCursorPositionChanged = (position: number) => {
      // Read from the editor ref, not `props.modelValue`: handleInput emits
      // update:modelValue and cursor-position-changed synchronously, but the prop only
      // refreshes after the v-model round-trip, giving the pre-keystroke value (e.g.
      // `:+1` evaluated as `:+`, failing the query.length >= 2 emoji-search gate).
      if (richEditorRef.value) {
        const text = richEditorRef.value.getPlainText?.() ?? props.modelValue;
        autoSuggest.handleInput(text, position);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // Let auto-suggest handle all its own keys (including Enter for selection)
      const autoSuggestHandled = autoSuggest.handleKeyDown(event);
      
      if (autoSuggestHandled) {
        return; // Auto-suggest handled the event
      }
      
      // Escape dismisses active command mode
      if (event.key === 'Escape' && autoSuggest.activeCommand.value) {
        event.preventDefault();
        dismissCommand();
        return;
      }

      // Up arrow on empty input → edit last own message (Discord/Telegram behavior)
      if (event.key === 'ArrowUp' && !props.modelValue?.trim()) {
        event.preventDefault();
        emit('edit-last-message');
        return;
      }

      // Handle Enter key for sending messages (only if auto-suggest is not active)
      // On mobile, Enter creates a new line - user must tap the send button
      // On desktop, Enter sends (Shift+Enter for new line)
      if (event.key === 'Enter' && !event.isComposing && !event.shiftKey && !isMobile.value) {
        event.preventDefault();

        // If a parameterized command is active, Enter doesn't send
        // (user picks results by clicking, e.g. GIF grid)
        if (autoSuggest.activeCommand.value) {
          return;
        }

        send();
      }
    };

    const handleSuggestionSelect = (suggestion: SuggestionItem) => {
      // Use the autoSuggest system's built-in selection method
      // This handles both emojis and mentions correctly, including the @ symbol for mentions
      // The selectSuggestion method already includes the space in the inserted text
      autoSuggest.selectSuggestion(suggestion);
      
      // Return focus to the rich text editor after text update and DOM rendering
      // Use nextTick to wait for Vue's reactivity cycle to complete
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

      // Hard refuse over-limit sends: do NOT emit, do NOT clear the editor,
      // shake the input, surface a toast, and refocus so the user can
      // trim and retry. Previously the over-limit message was emitted,
      // bounced from the backend, and the optimistic-removal path wiped
      // the user's draft - which is terrible UX if they actually wrote
      // 4000+ characters.
      if (messageTooLong.value) {
        overLimitBuzz.value = false;
        // Toggle next frame so re-presses re-trigger the animation even
        // if the previous one is still running.
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

      if (props.modelValue?.trim() || attachedFiles.value.length > 0) {
        const content = props.modelValue || '';
        // URL tracking parameter stripping is handled in unifiedContentProcessing.ts
        // This covers the entire app (ActivityPub, DMs, chat, etc.)
        // Pass reply message ID as third parameter
        emit('sendMessage', content, attachedFiles.value, props.replyMessageId || undefined);
        if (slowmodeActive.value) {
          startSlowmodeCooldown(slowmodeSeconds.value);
        }
        // Haptic feedback on message send
        triggerMessage();
        emit('update:modelValue', '');

        if (richEditorRef.value?.clear) {
          richEditorRef.value.clear();
        }

        // Clear files after sending
        attachedFiles.value.forEach(file => {
          if (file.preview) {
            URL.revokeObjectURL(file.preview);
          }
        });
        attachedFiles.value = [];
        emit('files-attached', []);
      }
    };

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
      // AI emoji behave like emoji: insert into the composer (no autosend).
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

    const startBackgroundUpload = async (fileData: FilePreviewData) => {
      if (!authStore.session?.user?.id) return;

      const uploadId = uuidv4();
      fileData.uploadStatus = 'uploading';
      fileData.uploadProgress = 0;

      try {
        const uploadedUrl = await backgroundUploadManager.startUpload(
          uploadId,
          authStore.session.user.id,
          fileData.file,
          (progress) => {
            fileData.uploadProgress = progress;
            attachedFiles.value = [...attachedFiles.value];
            emit('upload-status-changed', hasActiveUploads());
          }
        );

        if (uploadedUrl) {
          fileData.uploadStatus = 'completed';
          fileData.uploadedUrl = uploadedUrl;
          fileData.uploadProgress = 100;
        } else {
          throw new Error('Upload failed');
        }
      } catch (error) {
        fileData.uploadStatus = 'error';
        fileData.uploadError = error instanceof Error ? error.message : 'Upload failed';
        fileData.uploadProgress = 0;
      }

      attachedFiles.value = [...attachedFiles.value];
      emit('upload-status-changed', hasActiveUploads());
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
      
      attachedFiles.value.splice(index, 1);
      emit('files-attached', attachedFiles.value);
      emit('upload-status-changed', hasActiveUploads());
    };

    // Drag and drop handlers
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
      
      // Clean up any remaining object URLs
      attachedFiles.value.forEach(file => {
        if (file.preview) {
          URL.revokeObjectURL(file.preview);
        }
      });
    });

    // Auto-focus editor when replying
    watch(() => props.replyMessageId, (newId) => {
      if (newId) {
        nextTick(() => {
          richEditorRef.value?.focus();
        });
      }
    });

    // Auto-focus editor when navigating to a new channel/DM/group
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

    // Watch modelValue for typing detection
    watch(() => props.modelValue, (newValue, oldValue) => {
      if (newValue && newValue.trim().length > 0 && isEditorFocused.value && newValue !== oldValue) {
        debug.log('⌨MessageInput: modelValue changed, triggering typing:', newValue.length, 'chars')
        handleTyping()
      }
    });
    
    // Also trigger on input events from RichTextEditor
    watch(() => isEditorFocused.value, (focused) => {
      if (focused && props.modelValue && props.modelValue.trim().length > 0) {
        // User focused the editor with content, might be typing
        handleTyping()
      }
    });

    /**
     * Kinetic rejection feedback for the parent: shake the input and refocus.
     * Reuses the over-limit buzz animation. Called by ChatComponent when a send
     * is refused by server policy (e.g. required E2EE) so the rejection feels
     * the same as the over-limit case instead of a silent failure.
     */
    const flashRejection = () => {
      overLimitBuzz.value = false;
      nextTick(() => {
        overLimitBuzz.value = true;
        window.setTimeout(() => { overLimitBuzz.value = false; }, 450);
      });
      if (richEditorRef.value?.focus) richEditorRef.value.focus();
    };

    // Expose refs for parent component
    defineExpose({
      gifTriggerRef,
      emojiTriggerRef,
      flashRejection
    });


</script>

<style scoped>
  .message-input {
    display: flex;
    padding: 24px 12px 12px 12px;
    /* background-color: var(--background-secondary); */
    flex-direction: column;
    flex-shrink: 0; /* Prevent the input from shrinking */
    position: relative; /* For absolute positioning of typing indicator */
  }
  
  .typing-indicator-wrapper {
    position: absolute;
    bottom: calc(100% - 22px); /* Position above the input, in padding area */
    left: 12px;
    right: 12px;
    pointer-events: none; /* Don't interfere with interactions */
    z-index: 1;
  }
  
  .message-input.replying {
    padding: 0 12px 10px 12px;
  }
  
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

  /* Read-only state when user lacks SEND_MESSAGES on the current channel.
     Mirrors Discord's "You don't have permission to send messages in this channel" UI. */
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

  /* Command parameter hint bar */
  .command-param-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--background-quaternary);
    border-bottom: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);
  }

  /* When inline GIF picker is above, hint bar loses top radius */
  .inline-gif-picker + .command-param-bar {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }

  /* When hint bar has no picker above, keep top radius */
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
    background: var(--harmony-primary-alpha, rgba(14, 165, 233, 0.15));
    color: var(--accent-color, #0EA5E9);
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
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.02em;
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
    color: var(--text-muted, #72767d);
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
    color: var(--text-muted, #72767d);
    padding: 2px 6px;
    border-radius: 10px;
    user-select: none;
  }

  .slowmode-indicator.cooling {
    color: var(--harmony-primary, #0EA5E9);
    background: rgba(14, 165, 233, 0.12);
  }

  .message-char-count.over-limit {
    color: var(--color-danger, #ed4245);
    font-weight: 600;
  }

  .plus-icon-container {
    position: relative;
    background-color: #aaaaaa29;
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

  /* Over-limit visual cue: red outline whenever the draft exceeds the
   * character cap so the user sees they're over before they try to send. */
  .message-container.has-over-limit {
    outline: 1px solid var(--color-danger, #ed4245);
    outline-offset: 0;
  }

  /* "Buzz" animation fired when the user tries to send an over-limit
   * draft. Quick horizontal shake - visible, dismissable, doesn't move
   * adjacent UI (transform-only). The toast carries the explanation;
   * this is just kinetic feedback that the click was acknowledged. */
  .message-container.buzz-over-limit {
    animation: message-input-buzz 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
  }

  @keyframes message-input-buzz {
    10%, 90% { transform: translate3d(-1px, 0, 0); }
    20%, 80% { transform: translate3d(2px, 0, 0); }
    30%, 50%, 70% { transform: translate3d(-4px, 0, 0); }
    40%, 60% { transform: translate3d(4px, 0, 0); }
  }

  /* Respect prefers-reduced-motion: skip the shake, keep the outline. */
  @media (prefers-reduced-motion: reduce) {
    .message-container.buzz-over-limit {
      animation: none;
    }
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

  /* Focus styling */
  .message-container:has(.rich-text-editor.is-focused) {
    box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,.15)
  }

  @media (max-width: 768px) {
    .message-input {
      flex-shrink: 0;
      margin: 0;
      /* padding: 12px 16px; */
      padding: 0.5rem;
      background: var(--background-secondary, #313338);
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);
    }

    .message-container {
      border-radius: 16px;
      padding: 0.25rem;
      min-height: 52px;
      align-items: center;
    }

    .left-icons,
    .right-icons {
      gap: 2px;
    }

    .right-icons {
      padding-right: 4px;
    }

    .plus-icon-container {
      width: 36px;
      height: 36px;
      border-radius: 18px;
    }

    .right-icons button {
      width: 32px;
      height: 32px;
      border-radius: 16px;
    }

    .textarea-wrapper {
      min-height: 28px;
      margin-left: 0;
      margin-right: 0;
    }

    /* Enhanced touch targets for mobile */
    .left-icons > *,
    .right-icons > * {
      min-width: 24px;
      min-height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .sprite {
      --scaleFactor: 1.25;
    }
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
    background-color: rgba(255, 255, 255, 0.1);
  }

  /* Send button - mobile only */
  .send-button {
    background-color: var(--harmony--primary, #0EA5E9) !important;
    border-radius: 50% !important;
    width: 36px !important;
    height: 36px !important;
    min-width: 36px !important;
    color: var(--text-primary);
    transition: transform 0.15s ease, background-color 0.2s ease;
  }

  .send-button:hover {
    background-color: var(--harmony--primary-dark, #0284C7) !important;
  }

  .send-button:active {
    transform: scale(0.95);
  }

  .send-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .send-button svg {
    margin-left: 2px; /* Slight offset to center the arrow visually */
  }
</style>
