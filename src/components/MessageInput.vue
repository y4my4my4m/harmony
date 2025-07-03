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
      <textarea 
        ref="textareaRef"
        draggable="false" 
        @dragstart.prevent 
        class="selectableText" 
        :value="modelValue"
        @input="handleInput"
        @keydown="handleKeyDown" 
        :placeholder="attachedFiles.length > 0 ? 'Add a comment...' : 'Type a message...'"
      ></textarea>
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
        <!-- Custom rendering for different suggestion types -->
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

<script lang="ts">
import { defineComponent, ref, watch, onMounted, onUnmounted } from 'vue';
import GifIcon from '@/components/icons/Gif.vue'
import PlusIcon from '@/components/icons/Plus.vue'
import EmojiUI from '@/components/EmojiUI.vue'
import MessageReply from '@/components/MessageReply.vue';
import FilePreview from '@/components/FilePreview.vue';
import FileUploadMenu from '@/components/FileUploadMenu.vue';
import AutoSuggest from '@/components/AutoSuggest.vue';
import type { FilePreviewData } from '@/components/FilePreview.vue';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';
import { backgroundUploadManager } from '@/services/fileService';
import { useAuthStore } from '@/stores/auth';
import { useAutoSuggest } from '@/composables/useAutoSuggest';
import { v4 as uuidv4 } from 'uuid';

export default defineComponent({
  components: {
    PlusIcon,
    GifIcon,
    EmojiUI,
    MessageReply,
    FilePreview,
    FileUploadMenu,
    AutoSuggest,
  },
  props: {
    giphyOpen: Boolean,
    emojiListOpen: Boolean,
    modelValue: {
      type: String,
      default: ''
    },
    replyMessageId: {
      type: String,
      default: ''
    },
    replyUserDisplayName: {
      type: String,
      default: ''
    },
  },
  emits: ['update:modelValue', 'sendMessage', 'toggleGiphy', 'toggleEmojiList', 'update:replyMessageId', 'files-attached', 'upload-status-changed'],
  setup(props, { emit }) {
    const authStore = useAuthStore();
    const showUploadMenu = ref(false);
    const attachedFiles = ref<FilePreviewData[]>([]);
    const isDragging = ref(false);
    
    // Auto-suggest setup
    const textareaRef = ref<HTMLTextAreaElement | null>(null);
    const autoSuggest = useAutoSuggest(textareaRef);

    const handleInput = (event: Event) => {
      const target = event.target as HTMLTextAreaElement;
      const value = target.value;
      const cursorPosition = target.selectionStart || 0;
      
      emit('update:modelValue', value);
      
      // Handle auto-suggest
      autoSuggest.handleInput(value, cursorPosition);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      console.log('💬 MessageInput handleKeyDown called:', event.key, 'autoSuggest active:', autoSuggest.state.value.isActive);
      
      // Special handling for Enter key when autosuggestion is active
      if (event.key === 'Enter' && autoSuggest.state.value.isActive && autoSuggest.suggestions.value.length > 0) {
        event.preventDefault();
        console.log('🎯 Enter pressed with active autosuggestion, selecting suggestion');
        const selectedSuggestion = autoSuggest.suggestions.value[autoSuggest.state.value.selectedIndex];
        if (selectedSuggestion) {
          handleSuggestionSelect(selectedSuggestion);
        }
        return;
      }
      
      // Let auto-suggest handle navigation keys (arrows, escape)
      const autoSuggestHandled = autoSuggest.handleKeyDown(event);
      console.log('🤖 AutoSuggest handled:', autoSuggestHandled);
      
      if (autoSuggestHandled) {
        return; // Auto-suggest handled the event
      }
      
      // Handle Enter key for sending messages (only if auto-suggest is not active)
      if (event.key === 'Enter' && !event.shiftKey) {
        console.log('📤 Sending message via Enter key');
        event.preventDefault();
        send();
      }
    };

    const handleSuggestionSelect = (suggestion: SuggestionItem) => {
      if (textareaRef.value) {
        const newValue = autoSuggest.selectSuggestion(suggestion);
        emit('update:modelValue', newValue);
        
        // Also manually trigger the input event to ensure Vue reactivity
        if (textareaRef.value) {
          const event = new Event('input', { bubbles: true });
          textareaRef.value.dispatchEvent(event);
        }
      }
    };

    const send = () => {
      // Close auto-suggest when sending
      autoSuggest.closeSuggestions();
      
      if (props.modelValue?.trim() || attachedFiles.value.length > 0) {
        const content = props.modelValue?.trim() || '';
        emit('sendMessage', content, attachedFiles.value);
        emit('update:modelValue', '');
        
        // Clear files after sending (uploads should be completed by now)
        attachedFiles.value.forEach(file => {
          if (file.preview) {
            URL.revokeObjectURL(file.preview);
          }
        });
        attachedFiles.value = [];
        emit('files-attached', []);
      }
    };

    const handleEnter = (event: KeyboardEvent) => {
      if (event.shiftKey) {
        return;
      } else {
        event.preventDefault();
        send();
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
      console.log('Toggle upload menu clicked, current state:', showUploadMenu.value);
      showUploadMenu.value = !showUploadMenu.value;
      console.log('New state:', showUploadMenu.value);
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
            // Force reactivity update
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

      // Force reactivity update
      attachedFiles.value = [...attachedFiles.value];
      emit('upload-status-changed', hasActiveUploads());
    };

    const hasActiveUploads = () => {
      return attachedFiles.value.some(file => file.uploadStatus === 'uploading');
    };

    const handleFilesSelected = async (files: File[]) => {
      console.log('handleFilesSelected called with:', files.length, 'files');
      console.log('Current attachedFiles count before:', attachedFiles.value.length);
      
      const newFiles = await Promise.all(files.map(createFilePreview));
      
      // Add files to the preview
      attachedFiles.value.push(...newFiles);
      console.log('Current attachedFiles count after:', attachedFiles.value.length);
      emit('files-attached', attachedFiles.value);
      
      // Start background uploads immediately
      newFiles.forEach((fileData) => {
        startBackgroundUpload(fileData);
      });
      
      closeUploadMenu();
    };

    const removeFile = (index: number) => {
      const removedFile = attachedFiles.value[index];
      
      // Revoke object URL to prevent memory leaks
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
      // Only set isDragging to false if we're leaving the message container
      const currentTarget = event.currentTarget as HTMLElement;
      const relatedTarget = event.relatedTarget as Node | null;
      if (!currentTarget?.contains(relatedTarget)) {
        isDragging.value = false;
      }
    };

    const handleDrop = async (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation(); // Prevent bubbling to parent
      isDragging.value = false;

      const files = event.dataTransfer?.files;
      if (files && files.length > 0) {
        const fileArray = Array.from(files);
        await handleFilesSelected(fileArray);
      }
    };

    // Handle external file drop events from ChatComponent
    const handleExternalFileDrop = (event: CustomEvent) => {
      console.log('handleExternalFileDrop called with:', event.detail.files?.length, 'files');
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

    return { 
      send, 
      toggleGiphy, 
      toggleEmojiList, 
      handleEnter,
      handleInput,
      handleDontReply,
      showUploadMenu,
      toggleUploadMenu,
      closeUploadMenu,
      attachedFiles,
      handleFilesSelected,
      removeFile,
      handleDragEnter,
      handleDragOver,
      handleDragLeave,
      handleDrop,
      isDragging,
      handleKeyDown,
      handleSuggestionSelect,
      textareaRef,
      autoSuggest,
    };
  }
});
</script>

<style scoped>
  .message-input {
    display: flex;
    padding: 10px 12px;
    background-color: var(--h-chat);
    border-radius: 8px;
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
  }

  .message-container {
    position: relative;
    display: flex;
    align-items: center;
    flex-grow: 1;
    padding: 8px;
    border-radius: 8px;
    border: none;
    background-color: var(--h-chat-light);
    transition: .2s;
  }

  textarea {
    flex-grow: 1;
    padding: 0;
    margin-left: 10px;
    margin-right: 10px;
    border: none;
    background-color: transparent;
    color: white;
    font-size: 16px;
    resize: none;
    overflow: auto;
    outline: none;
    position: relative;
    top: 10px;
    font-family: Arial, sans-serif;
  }

  textarea::placeholder {
    color: #72767d;
  }

  textarea:focus,
  textarea:active {
    outline: none;
  }
  /* party mode RGB */
  /* .message-container::before,
  .message-container::after{
    content: '';
    position: absolute;
    top: -2px;
    right: -2px;
    bottom: -2px;
    left: -2px;
    z-index: -1;
    box-shadow: 0 0 5px rgba(0, 0, 0, 0.1);
    transition: .5s;
    opacity: 0;
  }

  @keyframes rgbled {
    0% { box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 1px hsla(0, 100%, 50%, 100%), 0 0 50px hsla(0, 100%, 50%, 5%); }
    25% { box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 1px hsla(90, 100%, 50%, 100%), 0 0 50px hsla(90, 100%, 50%, 5%); }
    50% { box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 1px hsla(180, 100%, 50%, 100%), 0 0 50px hsla(180, 100%, 50%, 5%); }
    75% { box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 1px hsla(270, 100%, 50%, 100%), 0 0 50px hsla(270, 100%, 50%, 5%); }
    100% { box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 1px hsla(360, 100%, 50%, 100%), 0 0 50px hsla(360, 100%, 50%, 5%); }
  }

  .message-container:has(textarea:focus)::before{
    content: '';
    position: absolute;
    top: -2px;
    right: -2px;
    bottom: -2px;
    left: -2px;
    z-index: 2;
    box-shadow: 0 0 5px rgba(0, 0, 0, 0.1);
    animation: rgbled 15s linear infinite;
    border-radius: 8px;
    opacity: 1;
  }

  .message-container:has(textarea:focus)::after {
    top: -4px;
    right: -4px;
    bottom: -4px;
    left: -4px;
    animation-delay: 2.5s;
  } */

  .message-container:has(textarea:focus) {
    box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,.15)
  }

  @media (max-width: 768px) {
    .message-input {
      position: sticky;
      bottom: 0;
    }
    
    textarea {
      font-size: 14px;
      top: 7px;
    }
  }

  /* Auto-suggest custom styling */
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
</style>
