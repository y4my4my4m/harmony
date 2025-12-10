<template>
  <div class="message-input" :class="{'replying': replyMessageId, 'has-files': attachedFiles.length > 0}">
    <!-- Typing Indicator - positioned absolutely above input -->
    <TypingIndicator
      :typing-users="typingUsers"
      class="typing-indicator-wrapper"
    />
    
    <MessageReply
      v-if="replyMessageId"
      :replyMessageId="replyMessageId"
      :replyUserDisplayName="replyUserDisplayName"
      @update:replyMessageId="handleDontReply"
    />
    <FilePreview
      :files="attachedFiles"
      @remove-file="removeFile"
    />
    <div class="message-container"
         @dragenter.prevent="handleDragEnter"
         @dragover.prevent="handleDragOver"
         @dragleave.prevent="handleDragLeave"
         @drop.prevent="handleDrop">
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
          :placeholder="attachedFiles.length > 0 ? $t('message.addComment') : $t('message.typeMessage', { to: placeholderTarget })"
          @update:model-value="handleModelValueUpdate"
          @input="handleEditorInput"
          @keydown="handleKeyDown"
          @focus="handleFocus"
          @blur="handleBlur"
          @cursor-position-changed="handleCursorPositionChanged"
        />
      </div>
      <div class="right-icons">
        <button ref="gifTriggerRef" @click.stop="toggleGiphy" class="icon-button">
          <GifIcon />
        </button>
        <button ref="emojiTriggerRef" @click.stop="toggleEmojiList" class="icon-button">
          <EmojiUI />
        </button>
        <!-- Send button - only visible on mobile when there's content -->
        <button 
          v-if="isMobile && hasContent" 
          @click.stop="send" 
          class="icon-button send-button"
          :disabled="!hasContent"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
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
import type { FilePreviewData } from '@/components/FilePreview.vue';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';
import type { Message } from '@/types';
import { backgroundUploadManager } from '@/services/fileService';
import { useAuthStore } from '@/stores/auth';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { v4 as uuidv4 } from 'uuid';

interface Props {
  giphyOpen?: boolean;
  emojiListOpen?: boolean;
  modelValue?: string;
  replyMessageId?: string;
  replyUserDisplayName?: string;
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
  replyUserDisplayName: '',
});

// Dynamic placeholder target (channel or DM user)
const placeholderTarget = computed(() => {
  if (props.username) return `@${props.username}`;
  if (props.channelName) return `#${props.channelName}`;
  return '';
});

interface Emits {
  (e: 'update:modelValue', value: string): void;
  (e: 'sendMessage', content: string, files: FilePreviewData[], replyMessageId?: string): void;
  (e: 'toggleGiphy'): void;
  (e: 'toggleEmojiList', isReaction: boolean, message?: Message): void;
  (e: 'update:replyMessageId', value: string): void;
  (e: 'files-attached', files: FilePreviewData[]): void;
  (e: 'upload-status-changed', uploading: boolean): void;
}

const emit = defineEmits<Emits>();

const authStore = useAuthStore();
const { triggerMessage } = useHapticSettings();
const showUploadMenu = ref(false);
const attachedFiles = ref<FilePreviewData[]>([]);
const isDragging = ref(false);
const richEditorRef = ref<InstanceType<typeof RichTextEditor>>();
const isEditorFocused = ref(false);
const gifTriggerRef = ref<HTMLElement | null>(null);
const emojiTriggerRef = ref<HTMLElement | null>(null);

// Get store for channel ID (more reliable than props on direct page load)
const serverChannelStore = useServerChannelStore()

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
  debug.log('🔍 MessageInput: typingContext changed:', newCtx, 'from:', oldCtx)
}, { immediate: true })

// Track if we've started typing (to avoid sending multiple "on" events)
let hasStartedTyping = false
let typingResetTimeout: number | null = null
const TYPING_RESET_MS = 2000 // Reset after 2 seconds of no typing to allow re-triggering

// Mobile detection - check for touch device or narrow screen
const isMobile = ref(false);
const checkMobile = () => {
  isMobile.value = window.matchMedia('(max-width: 768px)').matches || 
    ('ontouchstart' in window) || 
    (navigator.maxTouchPoints > 0);
};

// Check if there's content to send
const hasContent = computed(() => {
  return (props.modelValue?.trim().length ?? 0) > 0 || attachedFiles.value.length > 0;
});

// Initialize and listen for resize
onMounted(() => {
  checkMobile();
  window.addEventListener('resize', checkMobile);
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile);
  // Cleanup typing indicator
  stopTyping()
  hasStartedTyping = false
  if (typingResetTimeout) {
    clearTimeout(typingResetTimeout)
  }
});

// Auto-suggest setup
const getCurrentText = () => richEditorRef.value ? props.modelValue : '';
const updateText = (newText: string, cursorPosition?: number) => {
  debug.log('🔧 MessageInput updateText called:', { newText, cursorPosition });
  
  // Set cursor position after text update if provided
  if (cursorPosition !== undefined && richEditorRef.value) {
    // Set the skip flag BEFORE emitting the update
    debug.log('🔧 Setting skipNextWatch to true');
    richEditorRef.value.skipNextWatch = true;
    
    emit('update:modelValue', newText);
    
    // Wait for Vue to process the update
    nextTick(() => {
      // Now render the content manually with skip cursor restore
      if (richEditorRef.value?.renderContent) {
        debug.log('🔧 Calling manual renderContent with skipCursorRestore=true');
        richEditorRef.value.renderContent(newText, true); // Skip cursor restore
      }
      
      // IMPORTANT: Focus FIRST, then set cursor position
      nextTick(() => {
        if (richEditorRef.value) {
          debug.log('🔧 Focusing editor FIRST');
          richEditorRef.value.focus();
          
          // Wait longer to ensure focus and DOM are stable
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (richEditorRef.value) {
                debug.log('🔧 Now setting cursor position to:', cursorPosition);
                richEditorRef.value.setCursorPosition(cursorPosition);
                debug.log('🔧 Verifying final state:');
                debug.log('  - activeElement:', document.activeElement);
                debug.log('  - selection:', window.getSelection());
                debug.log('  - rangeCount:', window.getSelection()?.rangeCount);
                debug.log('🔧 Cursor should now be visible and ready for typing');
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
const autoSuggest = useAutoSuggest(richEditorRef, getCurrentText, updateText);

    const handleModelValueUpdate = (value: string) => {
      emit('update:modelValue', value)
      handleTyping()
    }

    const handleEditorInput = () => {
      // The model value is handled by the update:model-value event
      // Typing indicator is triggered in handleModelValueUpdate to avoid duplicate calls
    };

    // Handle typing indicator - only send "on" once, then keep alive
    const handleTyping = () => {
      if (!typingContext.value) {
        return
      }
      
      // Clear reset timeout
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
      // Handle auto-suggest based on cursor position and current text
      if (richEditorRef.value) {
        autoSuggest.handleInput(props.modelValue, position);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // Let auto-suggest handle all its own keys (including Enter for selection)
      const autoSuggestHandled = autoSuggest.handleKeyDown(event);
      
      if (autoSuggestHandled) {
        return; // Auto-suggest handled the event
      }
      
      // Handle Enter key for sending messages (only if auto-suggest is not active)
      // On mobile, Enter creates a new line - user must tap the send button
      // On desktop, Enter sends (Shift+Enter for new line)
      if (event.key === 'Enter' && !event.shiftKey && !isMobile.value) {
        event.preventDefault();
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
      // Stop typing indicator when sending
      stopTyping()
      hasStartedTyping = false
      
      // Clear typing reset timeout
      if (typingResetTimeout) {
        clearTimeout(typingResetTimeout)
        typingResetTimeout = null
      }
      
      // Close auto-suggest when sending
      autoSuggest.closeSuggestions();
      
      if (props.modelValue?.trim() || attachedFiles.value.length > 0) {
        const content = props.modelValue || '';
        // URL tracking parameter stripping is handled in unifiedContentProcessing.ts
        // This covers the entire app (ActivityPub, DMs, chat, etc.)
        // Pass reply message ID as third parameter
        emit('sendMessage', content, attachedFiles.value, props.replyMessageId || undefined);
        // Haptic feedback on message send
        triggerMessage();
        emit('update:modelValue', '');
        
        // Clear the rich text editor
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
      // Stop typing when editor loses focus
      stopTyping()
      hasStartedTyping = false
      if (typingResetTimeout) {
        clearTimeout(typingResetTimeout)
        typingResetTimeout = null
      }
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

      // Create preview for images and videos
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

    const handleFilesSelected = async (files: File[]) => {
      const newFiles = await Promise.all(files.map(createFilePreview));
      
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

    // Handle external file drop events from ChatComponent
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

    // Watch for changes in attached files to emit to parent
    watch(attachedFiles, (newFiles) => {
      emit('files-attached', newFiles);
    }, { deep: true });

    // Watch modelValue for typing detection
    watch(() => props.modelValue, (newValue, oldValue) => {
      if (newValue && newValue.trim().length > 0 && isEditorFocused.value && newValue !== oldValue) {
        debug.log('⌨️ MessageInput: modelValue changed, triggering typing:', newValue.length, 'chars')
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

    // Expose refs for parent component
    defineExpose({
      gifTriggerRef,
      emojiTriggerRef
    });


</script>

<style scoped>
  .message-input {
    display: flex;
    padding: 24px 12px 12px 12px;
    /* background-color: var(--h-chat); */
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
    background-color: #ffffff3d;
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

  .textarea-wrapper {
    flex-grow: 1;
    position: relative;
    margin-left: 10px;
    margin-right: 10px;
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
      background: var(--h-chat, #313338);
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
      gap: 8px;
    }

    .plus-icon-container,
    .right-icons button {
      width: 36px;
      height: 36px;
      border-radius: 18px;
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
    background-color: var(--harmony--primary, #5865f2) !important;
    border-radius: 50% !important;
    width: 36px !important;
    height: 36px !important;
    min-width: 36px !important;
    color: white;
    transition: transform 0.15s ease, background-color 0.2s ease;
  }

  .send-button:hover {
    background-color: var(--harmony--primary-dark, #4752c4) !important;
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
