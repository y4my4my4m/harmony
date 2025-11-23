<template>
  <div class="message-input" :class="{'replying': replyMessageId, 'has-files': attachedFiles.length > 0}">
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
          :placeholder="attachedFiles.length > 0 ? $t('message.addComment') : $t('message.typeMessage')"
          @update:model-value="(value: string) => $emit('update:modelValue', value)"
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
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useAutoSuggest } from '@/composables/useAutoSuggest';
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
import { v4 as uuidv4 } from 'uuid';

interface Props {
  giphyOpen?: boolean;
  emojiListOpen?: boolean;
  modelValue?: string;
  replyMessageId?: string;
  replyUserDisplayName?: string;
}

const props = withDefaults(defineProps<Props>(), {
  giphyOpen: false,
  emojiListOpen: false,
  modelValue: '',
  replyMessageId: '',
  replyUserDisplayName: '',
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
const showUploadMenu = ref(false);
const attachedFiles = ref<FilePreviewData[]>([]);
const isDragging = ref(false);
const richEditorRef = ref<InstanceType<typeof RichTextEditor>>();
const isEditorFocused = ref(false);
const gifTriggerRef = ref<HTMLElement | null>(null);
const emojiTriggerRef = ref<HTMLElement | null>(null);

// Auto-suggest setup
const getCurrentText = () => richEditorRef.value ? props.modelValue : '';
const updateText = (newText: string, cursorPosition?: number) => {
  console.log('🔧 MessageInput updateText called:', { newText, cursorPosition });
  
  // Set cursor position after text update if provided
  if (cursorPosition !== undefined && richEditorRef.value) {
    // Set the skip flag BEFORE emitting the update
    console.log('🔧 Setting skipNextWatch to true');
    richEditorRef.value.skipNextWatch = true;
    
    emit('update:modelValue', newText);
    
    // Wait for Vue to process the update
    nextTick(() => {
      // Now render the content manually with skip cursor restore
      if (richEditorRef.value?.renderContent) {
        console.log('🔧 Calling manual renderContent with skipCursorRestore=true');
        richEditorRef.value.renderContent(newText, true); // Skip cursor restore
      }
      
      // IMPORTANT: Focus FIRST, then set cursor position
      nextTick(() => {
        if (richEditorRef.value) {
          console.log('🔧 Focusing editor FIRST');
          richEditorRef.value.focus();
          
          // Wait longer to ensure focus and DOM are stable
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (richEditorRef.value) {
                console.log('🔧 Now setting cursor position to:', cursorPosition);
                richEditorRef.value.setCursorPosition(cursorPosition);
                console.log('🔧 Verifying final state:');
                console.log('  - activeElement:', document.activeElement);
                console.log('  - selection:', window.getSelection());
                console.log('  - rangeCount:', window.getSelection()?.rangeCount);
                console.log('🔧 Cursor should now be visible and ready for typing');
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

    const handleEditorInput = () => {
      // The model value is handled by the update:model-value event
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
      if (event.key === 'Enter' && !event.shiftKey) {
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
      // Close auto-suggest when sending
      autoSuggest.closeSuggestions();
      
      if (props.modelValue?.trim() || attachedFiles.value.length > 0) {
        const content = props.modelValue || '';
        // Pass reply message ID as third parameter
        emit('sendMessage', content, attachedFiles.value, props.replyMessageId || undefined);
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

    // Expose refs for parent component
    defineExpose({
      gifTriggerRef,
      emojiTriggerRef
    });


</script>

<style scoped>
  .message-input {
    display: flex;
    padding: 10px 12px 20px 12px;
    /* background-color: var(--h-chat); */
    flex-direction: column;
    flex-shrink: 0; /* Prevent the input from shrinking */
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
      padding: 12px 16px;
      background: var(--h-chat, #313338);
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);
    }

    .message-container {
      border-radius: 20px;
      padding: 8px 12px;
      min-height: 44px;
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
</style>
