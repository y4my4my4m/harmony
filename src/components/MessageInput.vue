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
        <!-- Main contenteditable input (Discord-like structure) -->
        <div 
          ref="richTextContainer"
          class="slate-text-area"
          :class="{ 'is-empty': !modelValue, 'single-line': isSingleLine }"
          role="textbox"
          aria-multiline="true"
          spellcheck="true"
          aria-haspopup="listbox"
          aria-invalid="false"
          aria-autocomplete="list"
          :aria-label="attachedFiles.length > 0 ? 'Add a comment...' : 'Type a message...'"
          contenteditable="true"
          @input="handleRichTextInput"
          @keydown="handleKeyDown"
          @focus="handleFocus"
          @blur="handleBlur"
          @paste="handlePaste"
          :data-placeholder="attachedFiles.length > 0 ? 'Add a comment...' : 'Type a message...'"
        >
        </div>
        <!-- Hidden textarea for AutoSuggest compatibility -->
        <textarea 
          ref="textareaRef"
          class="hidden-sync-textarea"
          :value="modelValue"
          @input="handleTextareaInput"
          tabindex="-1"
        ></textarea>
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
import { defineComponent, ref, watch, onMounted, onUnmounted, nextTick, computed } from 'vue';
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
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
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
    const emojiCache = useEmojiCacheStore();
    const showUploadMenu = ref(false);
    const attachedFiles = ref<FilePreviewData[]>([]);
    const isDragging = ref(false);
    const richTextContainer = ref<HTMLDivElement | null>(null);
    const isTextareaFocused = ref(false);
    
    // Auto-suggest setup
    const textareaRef = ref<HTMLTextAreaElement | null>(null);
    const autoSuggest = useAutoSuggest(textareaRef);

    // Computed property to check if content is single line
    const isSingleLine = computed(() => {
      return !props.modelValue.includes('\n');
    });

    // Find emoji by name in cache
    const findEmojiByName = (name: string) => {
      try {
        // Get all server emojis from cache
        const allServerIds = Array.from(emojiCache.serverCaches.keys());
        for (const serverId of allServerIds) {
          const serverEmojis = emojiCache.getServerEmojis(serverId);
          if (serverEmojis && serverEmojis.length > 0) {
            const emoji = serverEmojis.find(e => e.name === name);
            if (emoji && emoji.url) {
              return emoji;
            }
          }
        }
        
        // Also check if there are any default emojis or global emojis
        // This is a fallback in case server-specific emojis aren't found
        return null;
      } catch (error) {
        console.warn('Error finding emoji by name:', error);
        return null;
      }
    };

    // Parse input text to show emojis as images
    const parseInputForDisplay = (text: string) => {
      const parts = [];
      const emojiRegex = /:(\w+):/g;
      let lastIndex = 0;
      let match;

      while ((match = emojiRegex.exec(text)) !== null) {
        // Add text before emoji
        if (match.index > lastIndex) {
          const textPart = text.substring(lastIndex, match.index);
          if (textPart) {
            parts.push({ type: 'text', text: textPart });
          }
        }

        // Try to find emoji
        const emojiName = match[1];
        const emoji = findEmojiByName(emojiName);
        if (emoji) {
          parts.push({ 
            type: 'emoji', 
            emoji, 
            text: match[0],
            originalLength: match[0].length // Store original text length for cursor calculations
          });
        } else {
          parts.push({ type: 'text', text: match[0] });
        }

        lastIndex = match.index + match[0].length;
      }

      // Add remaining text
      if (lastIndex < text.length) {
        const remaining = text.substring(lastIndex);
        if (remaining) {
          parts.push({ type: 'text', text: remaining });
        }
      }

      return parts.length > 0 ? parts : [{ type: 'text', text }];
    };

    const handleInput = (event: Event) => {
      const target = event.target as HTMLTextAreaElement;
      const value = target.value;
      const cursorPosition = target.selectionStart || 0;
      
      emit('update:modelValue', value);
      
      // Auto-expand textarea
      autoExpandTextarea(target);
      
      // Handle auto-suggest
      autoSuggest.handleInput(value, cursorPosition);
      
      // Check for emoji triggers (: followed by characters)
      checkEmojiTrigger(value, cursorPosition);
    };

    // New rich text input handler
    const handleRichTextInput = (event: Event) => {
      const target = event.target as HTMLDivElement;
      const textContent = extractTextFromRichEditor(target);
      
      emit('update:modelValue', textContent);
      
      // Handle auto-suggest based on cursor position
      const cursorPosition = getCursorPosition(target);
      autoSuggest.handleInput(textContent, cursorPosition);
      
      // Check for emoji triggers
      checkEmojiTrigger(textContent, cursorPosition);
      
      // Auto-expand
      autoExpandRichEditor(target);
    };

    // Handle textarea input for compatibility
    const handleTextareaInput = (event: Event) => {
      const target = event.target as HTMLTextAreaElement;
      const value = target.value;
      
      // Update rich text editor with new content
      if (richTextContainer.value) {
        updateRichEditorContent(value);
      }
    };

    // Handle paste events to process emojis
    const handlePaste = (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') || '';
      insertTextAtCursor(text);
    };

    // Extract plain text from rich editor, preserving emoji codes
    const extractTextFromRichEditor = (element: HTMLDivElement): string => {
      let text = '';
      
      const processNode = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent || '';
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          if (el.classList.contains('slate-emoji')) {
            // Extract emoji name from data attribute
            const emojiName = el.getAttribute('data-emoji-name');
            if (emojiName) {
              text += `:${emojiName}:`;
            }
          } else if (el.tagName === 'BR') {
            text += '\n';
          } else {
            // Process child nodes
            for (const child of Array.from(node.childNodes)) {
              processNode(child);
            }
          }
        }
      };
      
      for (const child of Array.from(element.childNodes)) {
        processNode(child);
      }
      
      return text;
    };

    // Get cursor position in rich editor
    const getCursorPosition = (element: HTMLDivElement): number => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return 0;
      
      const range = selection.getRangeAt(0);
      const preCaretRange = range.cloneRange();
      preCaretRange.selectNodeContents(element);
      preCaretRange.setEnd(range.endContainer, range.endOffset);
      
      return extractTextFromRichEditor({
        childNodes: Array.from(preCaretRange.cloneContents().childNodes)
      } as any).length;
    };

    // Insert text at current cursor position
    const insertTextAtCursor = (text: string) => {
      if (!richTextContainer.value) return;
      
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) {
        // If no selection, append to end
        richTextContainer.value.textContent = (richTextContainer.value.textContent || '') + text;
      } else {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      
      // Update model value
      const newText = extractTextFromRichEditor(richTextContainer.value);
      emit('update:modelValue', newText);
      
      // Process any new emojis
      processEmojisInEditor();
    };

    // Update rich editor content from text
    const updateRichEditorContent = (text: string) => {
      if (!richTextContainer.value) return;
      
      // Clear current content
      richTextContainer.value.innerHTML = '';
      
      // Parse and add content
      const parts = parseInputForDisplay(text);
      
      for (const part of parts) {
        if (part.type === 'text') {
          // Handle newlines by splitting and adding br elements
          const lines = part.text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]) {
              richTextContainer.value.appendChild(document.createTextNode(lines[i]));
            }
            if (i < lines.length - 1) {
              richTextContainer.value.appendChild(document.createElement('br'));
            }
          }
        } else if (part.type === 'emoji' && part.emoji?.url) {
          const emojiSpan = document.createElement('span');
          emojiSpan.className = 'slate-emoji';
          emojiSpan.contentEditable = 'false';
          emojiSpan.setAttribute('data-emoji-name', part.emoji.name);
          emojiSpan.setAttribute('data-type', 'emoji');
          emojiSpan.title = `:${part.emoji.name}:`;
          
          const img = document.createElement('img');
          img.src = part.emoji.url;
          img.alt = `:${part.emoji.name}:`;
          img.setAttribute('aria-label', `:${part.emoji.name}:`);
          img.draggable = false;
          
          emojiSpan.appendChild(img);
          richTextContainer.value.appendChild(emojiSpan);
        }
      }
    };

    // Process emojis in the editor content
    const processEmojisInEditor = () => {
      if (!richTextContainer.value) return;
      
      const text = extractTextFromRichEditor(richTextContainer.value);
      updateRichEditorContent(text);
    };

    // Auto-expand slate text area
    const autoExpandRichEditor = (editor: HTMLDivElement) => {
      // Reset height to calculate natural height
      editor.style.height = 'auto';
      
      const scrollHeight = editor.scrollHeight;
      const maxHeight = 200;
      const minHeight = 44;
      
      const newHeight = scrollHeight <= maxHeight ? Math.max(scrollHeight, minHeight) : maxHeight;
      
      editor.style.height = newHeight + 'px';
      editor.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
    };

    const autoExpandTextarea = (textarea: HTMLTextAreaElement) => {
      // Reset height to auto to get the natural scrollHeight
      textarea.style.height = 'auto';
      
      // Calculate the new height based on content
      const scrollHeight = textarea.scrollHeight;
      const maxHeight = 200; // Maximum height in pixels (about 8-10 lines)
      const minHeight = 44; // Minimum height for single line
      
      const newHeight = scrollHeight <= maxHeight ? Math.max(scrollHeight, minHeight) : maxHeight;
      
      textarea.style.height = newHeight + 'px';
      textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
      
      // Sync slate text area height and alignment
      if (richTextContainer.value) {
        richTextContainer.value.style.height = newHeight + 'px';
        // Force re-alignment after height change
        nextTick(() => {
          syncScroll();
        });
      }
    };

    const syncScroll = () => {
      if (textareaRef.value && richTextContainer.value) {
        richTextContainer.value.scrollTop = textareaRef.value.scrollTop;
        richTextContainer.value.scrollLeft = textareaRef.value.scrollLeft;
      }
    };

    const focusTextarea = () => {
      if (textareaRef.value) {
        textareaRef.value.focus();
      }
    };

    const handleFocus = () => {
      isTextareaFocused.value = true;
    };

    const handleBlur = () => {
      isTextareaFocused.value = false;
    };

    const checkEmojiTrigger = (value: string, cursorPosition: number) => {
      // Simple emoji trigger detection - look for : followed by 2+ characters
      const textBeforeCursor = value.substring(0, cursorPosition);
      const emojiMatch = textBeforeCursor.match(/:([a-zA-Z0-9_]{2,})$/);
      
      if (emojiMatch) {
        // Emoji suggestions are handled by the AutoSuggest component
        // The autoSuggest system will detect this pattern and show emoji suggestions
      }
    };

    // Insert emoji at current cursor position in rich editor
    const insertEmojiAtCursor = (emoji: any) => {
      if (!richTextContainer.value) return;
      
      const editor = richTextContainer.value;
      const selection = window.getSelection();
      
      if (selection && selection.rangeCount > 0) {
        // Find and remove the emoji trigger pattern
        const currentText = extractTextFromRichEditor(editor);
        const cursorPosition = getCursorPosition(editor);
        const textBeforeCursor = currentText.substring(0, cursorPosition);
        const emojiMatch = textBeforeCursor.match(/:([a-zA-Z0-9_]*)$/);
        
        if (emojiMatch) {
          // Remove the trigger text and insert emoji
          const triggerLength = emojiMatch[0].length;
          const newText = currentText.substring(0, cursorPosition - triggerLength) + 
                         `:${emoji.name}:` + 
                         currentText.substring(cursorPosition);
          
          // Update the editor content
          updateRichEditorContent(newText);
          
          // Update model value
          emit('update:modelValue', newText);
          
          // Set cursor position after the emoji
          nextTick(() => {
            const newCursorPos = cursorPosition - triggerLength + `:${emoji.name}:`.length;
            setCursorPosition(editor, newCursorPos);
            editor.focus();
          });
        } else {
          // No trigger pattern, just insert emoji at cursor
          const emojiText = `:${emoji.name}:`;
          insertTextAtCursor(emojiText);
        }
      } else {
        // No selection, just append emoji
        const emojiText = `:${emoji.name}:`;
        insertTextAtCursor(emojiText);
      }
    };

    const insertEmoji = (emoji: any) => {
      insertEmojiAtCursor(emoji);
    };

    // Set cursor position in rich editor
    const setCursorPosition = (element: HTMLDivElement, position: number) => {
      const selection = window.getSelection();
      if (!selection) return;
      
      let currentPos = 0;
      const walker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null
      );
      
      let node = walker.nextNode();
      while (node) {
        const nodeLength = node.textContent?.length || 0;
        if (currentPos + nodeLength >= position) {
          const range = document.createRange();
          range.setStart(node, position - currentPos);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        currentPos += nodeLength;
        node = walker.nextNode();
      }
      
      // If we get here, position is at the end
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // console.log('💬 MessageInput handleKeyDown called:', event.key, 'autoSuggest active:', autoSuggest.state.value.isActive);
      
      // Special handling for Enter key when autosuggestion is active
      if (event.key === 'Enter' && autoSuggest.state.value.isActive && autoSuggest.suggestions.value.length > 0) {
        event.preventDefault();
        // console.log('🎯 Enter pressed with active autosuggestion, selecting suggestion');
        const selectedSuggestion = autoSuggest.suggestions.value[autoSuggest.state.value.selectedIndex];
        if (selectedSuggestion) {
          handleSuggestionSelect(selectedSuggestion);
        }
        return;
      }
      
      // Let auto-suggest handle navigation keys (arrows, escape)
      const autoSuggestHandled = autoSuggest.handleKeyDown(event);
      // console.log('🤖 AutoSuggest handled:', autoSuggestHandled);
      
      if (autoSuggestHandled) {
        return; // Auto-suggest handled the event
      }
      
      // Handle Enter key for sending messages (only if auto-suggest is not active)
      if (event.key === 'Enter' && !event.shiftKey) {
        // console.log('📤 Sending message via Enter key');
        event.preventDefault();
        send();
      }
    };

    const handleSuggestionSelect = (suggestion: SuggestionItem) => {
      if (richTextContainer.value && textareaRef.value) {
        // For emoji suggestions, use rich text insertion
        if (suggestion.type === 'emoji' || suggestion.url) {
          insertEmojiAtCursor(suggestion);
        } else {
          // For other suggestions (users, etc.), use the traditional AutoSuggest handling
          const newValue = autoSuggest.selectSuggestion(suggestion);
          emit('update:modelValue', newValue);
          
          // Update the rich editor with the new content
          updateRichEditorContent(newValue);
        }
        
        // Focus back to the rich text container
        richTextContainer.value.focus();
      }
    };

    const send = () => {
      // Close auto-suggest when sending
      autoSuggest.closeSuggestions();
      
      if (props.modelValue?.trim() || attachedFiles.value.length > 0) {
        // Preserve newlines in the message content - don't trim them away
        const content = props.modelValue || '';
        emit('sendMessage', content, attachedFiles.value);
        emit('update:modelValue', '');
        
        // Clear the slate text area
        if (richTextContainer.value) {
          richTextContainer.value.innerHTML = '';
          richTextContainer.value.style.height = '44px';
        }
        
        // Reset textarea height after sending
        if (textareaRef.value) {
          textareaRef.value.style.height = 'auto';
          textareaRef.value.style.height = '44px'; // Reset to minimum height
        }
        
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
      
      // Initialize slate text area
      if (richTextContainer.value) {
        // Set initial content if modelValue exists
        if (props.modelValue) {
          updateRichEditorContent(props.modelValue);
        }
        autoExpandRichEditor(richTextContainer.value);
      }
      
      // Initialize textarea auto-expand for compatibility
      if (textareaRef.value) {
        autoExpandTextarea(textareaRef.value);
      }
      
      // Debug: Check emoji cache state
      console.log('MessageInput mounted, emoji cache servers:', Array.from(emojiCache.serverCaches.keys()));
      
      // Ensure emoji cache is populated
      nextTick(() => {
        const allServerIds = Array.from(emojiCache.serverCaches.keys());
        if (allServerIds.length === 0) {
          console.warn('No emoji servers found in cache. Emojis may not display properly.');
        } else {
          console.log('Available emoji servers:', allServerIds);
          allServerIds.forEach(serverId => {
            const emojis = emojiCache.getServerEmojis(serverId);
            console.log(`Server ${serverId} has ${emojis?.length || 0} emojis`);
          });
        }
      });
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

    // Watch for external changes to modelValue and update rich editor
    watch(() => props.modelValue, (newValue, oldValue) => {
      if (richTextContainer.value && newValue !== oldValue) {
        // Only update if the content is different from what's currently in the editor
        const currentText = extractTextFromRichEditor(richTextContainer.value);
        if (currentText !== newValue) {
          updateRichEditorContent(newValue || '');
        }
      }
    });

    return { 
      send, 
      toggleGiphy, 
      toggleEmojiList, 
      handleEnter,
      handleInput,
      handleRichTextInput,
      handleTextareaInput,
      handlePaste,
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
      insertEmoji,
      insertEmojiAtCursor,
      richTextContainer,
      isSingleLine,
      isTextareaFocused,
      focusTextarea,
      handleFocus,
      handleBlur,
      syncScroll,
    };
  }
});
</script>

<style>
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
    padding: 8px;
    border-radius: 8px;
    border: none;
    background-color: var(--h-chat-light);
    transition: .2s;
  }

  .textarea-wrapper {
    flex-grow: 1;
    position: relative;
    margin-left: 10px;
    margin-right: 10px;
  }

  .slate-text-area {
    width: 100%;
    min-height: 44px;
    max-height: 200px;
    padding: 12px 0;
    border: none;
    background-color: transparent;
    color: white;
    font-size: 16px;
    font-family: inherit;
    line-height: 1.375;
    outline: none;
    overflow-y: hidden;
    overflow-x: hidden;
    white-space: pre-wrap;
    word-wrap: break-word;
    resize: none;
    cursor: text;
    position: relative;
  }

  .slate-text-area:empty::before {
    content: attr(data-placeholder);
    color: #72767d;
    pointer-events: none;
    position: absolute;
    top: 12px;
    left: 0;
  }

  .slate-text-area.single-line {
    display: flex;
    align-items: center;
    min-height: 44px;
    padding: 0;
  }

  .slate-text-area.single-line:empty::before {
    top: 0;
    display: flex;
    align-items: center;
    height: 44px;
  }

  .slate-text-area:focus {
    outline: none;
  }

  .slate-emoji {
    display: inline-block;
    position: relative;
    vertical-align: middle;
    margin: 0 1px;
    user-select: none;
  }

  .slate-emoji img {
    display: inline-block;
    height: 24px;
    width: 24px;
    vertical-align: middle;
    object-fit: contain;
    user-select: none;
    pointer-events: none;
  }

  .hidden-sync-textarea {
    position: absolute !important;
    left: -9999px !important;
    opacity: 0 !important;
    pointer-events: none !important;
    width: 1px !important;
    height: 1px !important;
    overflow: hidden !important;
  }

  /* Focus styling */
  .message-container:has(.slate-text-area:focus) {
    box-shadow: inset 0 0 5px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,.15)
  }

  /* Custom scrollbar for slate text area */
  .slate-text-area::-webkit-scrollbar {
    width: 4px;
  }

  .slate-text-area::-webkit-scrollbar-track {
    background: transparent;
  }

  .slate-text-area::-webkit-scrollbar-thumb {
    background: #40444b;
    border-radius: 2px;
  }

  .slate-text-area::-webkit-scrollbar-thumb:hover {
    background: #4f545c;
  }

  @media (max-width: 768px) {
    .message-input {
      position: sticky;
      bottom: 0;
    }
    
    .slate-text-area {
      font-size: 14px;
      padding: 10px 0;
      min-height: 40px;
    }

    .slate-text-area.single-line:empty::before {
      top: 0;
      display: flex;
      align-items: center;
      height: 40px;
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
