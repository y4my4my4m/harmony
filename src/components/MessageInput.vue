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
          :placeholder="attachedFiles.length > 0 ? 'Add a comment...' : 'Type a message...'"
          @update:model-value="(value: string) => $emit('update:modelValue', value)"
          @input="handleEditorInput"
          @keydown="handleKeyDown"
          @focus="handleFocus"
          @blur="handleBlur"
          @cursor-position-changed="handleCursorPositionChanged"
        />
      </div>
      <div class="right-icons">
        <GifIcon @click="toggleGiphy" />
        <EmojiUI @click="toggleEmojiList" />
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
    >
      <template #default="{ suggestion }">
        <div class="suggest-item-content">
          <img 
            v-if="suggestion.url || suggestion.avatar" 
            :src="suggestion.url || suggestion.avatar" 
            :alt="suggestion.name || suggestion.display_name"
            class="suggest-icon"
          />
          <div class="suggest-text">
            <span class="suggest-name">{{ suggestion.display_name || suggestion.name }}</span>
            <span v-if="suggestion.username" class="suggest-username">{{ suggestion.username }}</span>
            <span v-if="suggestion.server_name" class="suggest-server">{{ suggestion.server_name }}</span>
          </div>
        </div>
      </template>
    </AutoSuggest>
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
  (e: 'sendMessage', content: string, files: FilePreviewData[]): void;
  (e: 'toggleGiphy'): void;
  (e: 'toggleEmojiList', value?: boolean): void;
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

// Auto-suggest setup
const getCurrentText = () => richEditorRef.value ? props.modelValue : '';
const updateText = (newText: string) => emit('update:modelValue', newText);
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
      // Special handling for Enter key when autosuggestion is active
      if (event.key === 'Enter' && autoSuggest.state.value.isActive && autoSuggest.suggestions.value.length > 0) {
        event.preventDefault();
        const selectedSuggestion = autoSuggest.suggestions.value[autoSuggest.state.value.selectedIndex];
        if (selectedSuggestion) {
          handleSuggestionSelect(selectedSuggestion);
          autoSuggest.closeSuggestions();
        }
        return;
      }
      
      // Let auto-suggest handle navigation keys (arrows, escape)
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
      if (!richEditorRef.value) return;
      
      // Handle different suggestion types
      if (suggestion.type === 'emoji' || suggestion.url) {
        // For emoji, insert it directly
        insertEmojiAtCursor(suggestion);
      } else {
        // For other suggestions (users, etc.)
        const insertText = autoSuggest.selectSuggestion(suggestion);
        if (insertText && suggestion.type !== 'emoji') {
          // Handle mention insertion
          handleMentionInsertion(suggestion);
        }
      }
      
      // Focus back to the editor after insertion
      nextTick(() => {
        if (richEditorRef.value?.focus) {
          richEditorRef.value.focus();
        }
      });
    };

    // Handle emoji insertion
    const insertEmojiAtCursor = (emoji: any) => {
      if (!richEditorRef.value?.insertTextAtCursor) return;
      
      // Get current text and cursor position
      const currentText = props.modelValue;
      const cursorPosition = richEditorRef.value.getCursorPosition?.() || 0;
      
      // Check if there's an emoji trigger pattern before cursor
      const textBeforeCursor = currentText.substring(0, cursorPosition);
      const emojiMatch = textBeforeCursor.match(/:([a-zA-Z0-9_]*)$/);
      
      let newText;
      
      if (emojiMatch) {
        // Remove the trigger text and insert emoji
        const triggerLength = emojiMatch[0].length;
        newText = currentText.substring(0, cursorPosition - triggerLength) + 
                 `:${emoji.name}:` + 
                 currentText.substring(cursorPosition);
      } else {
        // No trigger pattern, just insert emoji at cursor
        newText = currentText.substring(0, cursorPosition) + 
                 `:${emoji.name}:` + 
                 currentText.substring(cursorPosition);
      }
      
      // Update model
      emit('update:modelValue', newText);
    };

    // Handle mention insertion
    const handleMentionInsertion = (mention: SuggestionItem) => {
      if (!richEditorRef.value) return;
      
      const currentText = props.modelValue;
      const cursorPosition = richEditorRef.value.getCursorPosition?.() || 0;
      
      // Find the @ trigger
      const textBeforeCursor = currentText.substring(0, cursorPosition);
      const mentionMatch = textBeforeCursor.match(/@([a-zA-Z0-9_]*)$/);
      
      if (mentionMatch) {
        const triggerLength = mentionMatch[0].length;
        const username = mention.username || mention.display_name;
        const newText = currentText.substring(0, cursorPosition - triggerLength) + 
                       `${username}` + 
                       currentText.substring(cursorPosition);
        //  TODO: this wont properly place the cursor after the mention
        // Set the cursor position after the mention
        // richEditorRef.value.insertTextAtCursor?.(username);
        // richEditorRef.value.setCursorPosition?.(cursorPosition - triggerLength + username.length);
        
        emit('update:modelValue', newText);
      }
    };

    const send = () => {
      // Close auto-suggest when sending
      autoSuggest.closeSuggestions();
      
      if (props.modelValue?.trim() || attachedFiles.value.length > 0) {
        const content = props.modelValue || '';
        emit('sendMessage', content, attachedFiles.value);
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

    // Handle emoji insertion from popup
    const insertEmoji = (emoji: any) => {
      if (richEditorRef.value) {
        if (!isEditorFocused.value && richEditorRef.value.focus) {
          richEditorRef.value.focus();
        }
        
        nextTick(() => {
          insertEmojiAtCursor(emoji);
          
          nextTick(() => {
            if (richEditorRef.value?.focus) {
              richEditorRef.value.focus();
            }
          });
        });
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


</script>

<style scoped>
  .message-input {
    display: flex;
    padding: 10px 12px 20px 12px;
    /* background-color: var(--h-chat); */
    flex-direction: column;
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

  /* Auto-suggest item styling */
  .suggest-item-content {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .suggest-icon {
    width: 24px;
    height: 24px;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .suggest-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .suggest-name {
    font-weight: 500;
    color: #ffffff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .suggest-username {
    font-size: 12px;
    color: #b9bbbe;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .suggest-server {
    font-size: 11px;
    color: #72767d;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (max-width: 768px) {
    .message-input {
      position: sticky;
      bottom: 0;
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
</style>
