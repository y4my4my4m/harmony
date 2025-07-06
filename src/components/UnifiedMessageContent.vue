<template>
  <div class="unified-content">
    <!-- Edit mode -->
    <div v-if="editableMessageId === messageId" class="edit-container">
      <textarea 
        :id="`edit-input-${messageId}`"
        v-model="localEditableContent" 
        @keydown="handleKeyDown"
        @input="handleInput"
        class="edit-textarea"
        placeholder="Edit message"
        ref="editTextarea"
        rows="1"
        @dragstart.prevent
      ></textarea>
      <div class="edit-actions">
        <span class="edit-hint">
          escape to <span class="edit-action" @click="handleCancelEdit">cancel</span> • 
          enter to <span class="edit-action" @click="handleSaveEdit">save</span>
        </span>
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
    
    <!-- Display mode -->
    <div v-else class="content-display">
      <template v-for="(part, partIndex) in content" :key="partIndex">
        <!-- Text content with markdown-style formatting and code blocks -->
        <template 
          v-if="part && typeof part === 'object' && part.type === 'text'"
        >
          <template v-for="(segment, segmentIndex) in renderTextSegments(part.text)" :key="`${partIndex}-${segmentIndex}`">
            <span 
              v-if="segment.type === 'text'" 
              class="text-content"
              v-html="segment.content"
            ></span>
            <CodeBlock 
              v-else-if="segment.type === 'codeblock'"
              :code="segment.code!"
              :language="segment.language!"
            />
          </template>
        </template>
        
        <!-- User mentions -->
        <span 
          v-else-if="part && typeof part === 'object' && part.type === 'mention'" 
          class="mention" 
          @click="$emit('show-user-profile', part.userId, $event)"
        >{{ part.mention }}</span>
        
        <!-- Custom emojis -->
        <img 
          v-else-if="part && typeof part === 'object' && part.type === 'emoji'"
          class="emoji-icon"
          :class="{ 'single': isSingleEmoji }"
          :src="part.emoji.url"
          :alt="part.emoji.name"
          :title="`:${part.emoji.name}:`"
          draggable="false"
        />
        
        <!-- URLs (with special handling for images and videos) -->
        <template v-else-if="part && typeof part === 'object' && part.type === 'url'">
          <!-- Image URLs -->
          <div 
            v-if="isImageUrl(part.url)" 
            class="media-container image-container"
          >
            <div v-if="!imageLoaded[part.url]" class="media-skeleton image-skeleton"></div>
            <img
              :src="part.url"
              @load="$emit('image-loaded', part.url)"
              @click="$emit('open-lightbox', part.url)"
              v-show="imageLoaded[part.url]"
              draggable="false"
              class="content-image"
            />
          </div>

          <!-- Video URLs -->
          <div 
            v-else-if="isVideoUrl(part.url)" 
            class="media-container video-container"
          >
            <video
              :src="part.url"
              controls
              class="content-video"
              preload="metadata"
            ></video>
          </div>

          <!-- Regular URL links -->
          <a 
            v-else
            :href="part.url" 
            target="_blank" 
            rel="noopener noreferrer"
            class="url-link"
          >{{ part.url }}</a>
        </template>
        
        <!-- Image files -->
        <div 
          v-else-if="part && typeof part === 'object' && part.type === 'file' && part.fileType === 'image'" 
          class="media-container image-container"
        >
          <div v-if="!imageLoaded[part.url]" class="media-skeleton image-skeleton"></div>
          <img
            :src="part.url"
            @load="$emit('image-loaded', part.url)"
            @click="$emit('open-lightbox', part.url)"
            v-show="imageLoaded[part.url]"
            draggable="false"
            class="content-image"
          />
        </div>

        <!-- Video files -->
        <div 
          v-else-if="part && typeof part === 'object' && part.type === 'file' && part.fileType === 'video'" 
          class="media-container video-container"
        >
          <video
            :src="part.url"
            controls
            class="content-video"
            preload="metadata"
          ></video>
        </div>
        
        <!-- Other file attachments -->
        <div 
          v-else-if="part && typeof part === 'object' && part.type === 'file' && !['image', 'video'].includes(part.fileType)"
          class="file-attachment"
        >
          <div class="file-icon">📎</div>
          <a :href="part.url" target="_blank" rel="noopener noreferrer" class="file-name">
            {{ getFileName(part.url) }}
          </a>
        </div>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, watch, ref, nextTick } from 'vue';
import type { PropType } from 'vue';
import type { MessagePart } from '@/types';
import AutoSuggest from '@/components/AutoSuggest.vue';
import CodeBlock from '@/components/common/CodeBlock.vue';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';
import { useAutoSuggest } from '@/composables/useAutoSuggest';

export default defineComponent({
  name: 'UnifiedMessageContent',
  components: {
    AutoSuggest,
    CodeBlock,
  },
  props: {
    content: {
      type: Array as PropType<MessagePart[]>,
      required: true
    },
    editableMessageId: {
      type: String as PropType<string | null>,
      default: null
    },
    messageId: {
      type: String,
      required: true
    },
    imageLoaded: {
      type: Object as PropType<Record<string, boolean>>,
      default: () => ({})
    },
    isSingleEmoji: {
      type: Boolean,
      default: false
    },
    editableContent: {
      type: String,
      default: ''
    }
  },
  emits: ['update:message', 'update:content', 'cancel-edit', 'image-loaded', 'open-lightbox', 'show-user-profile'],
  setup(props, { emit }) {
    const localEditableContent = ref(props.editableContent);
    const editTextarea = ref<HTMLTextAreaElement | null>(null);
    
    // Auto-suggest setup
    const autoSuggest = useAutoSuggest(editTextarea);

    // Helper functions
    const isImageUrl = (url: string): boolean => {
      if (!url) return false;
      return /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(url);
    };

    const isVideoUrl = (url: string): boolean => {
      if (!url) return false;
      return /\.(mp4|webm|ogg|avi|mov|wmv|flv)$/i.test(url);
    };

    const getFileName = (url: string): string => {
      if (!url) return 'Unknown file';
      const urlParts = url.split('/');
      const filename = urlParts[urlParts.length - 1];
      return decodeURIComponent(filename) || 'Unknown file';
    };

    const formatFileSize = (bytes: number): string => {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    // Simple markdown-style text rendering with extracted code blocks
    const renderTextContent = (text: string): { renderedText: string; codeBlocks: Array<{id: string; code: string; language: string}> } => {
      if (!text) return { renderedText: '', codeBlocks: [] };
      
      let rendered = text;
      const codeBlocks: Array<{id: string; code: string; language: string}> = [];
      
      // Extract code blocks first and replace with placeholders
      // Updated regex to handle code blocks with or without newlines and with optional language
      rendered = rendered.replace(/```(\w+)?(?:\n)?([\s\S]*?)```/g, (match, language, code) => {
        const lang = language || 'text';
        const blockId = `\uE000CODEBLOCK_${codeBlocks.length}\uE001`;
        // Clean up the code content more thoroughly
        const cleanCode = code.replace(/^\n+/, '').replace(/\n+$/, '');
        codeBlocks.push({
          id: blockId,
          code: cleanCode,
          language: lang
        });
        return blockId;
      });
      
      // Process other markdown after extracting code blocks
      // Inline code: `text`
      rendered = rendered.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
      
      // Bold: **text** or __text__
      rendered = rendered.replace(/\*\*(.*?)\*\*/g, '<strong class="md-bold">$1</strong>');
      rendered = rendered.replace(/__(.*?)__/g, '<strong class="md-bold">$1</strong>');
      
      // Italic: *text* or _text_ (but not in URLs or other contexts)
      rendered = rendered.replace(/(?<![\w/:])_([^_]+)_(?![\w])/g, '<em class="md-italic">$1</em>');
      rendered = rendered.replace(/(?<![\w*])\*([^*]+)\*(?![\w*])/g, '<em class="md-italic">$1</em>');
      
      // Strikethrough: ~~text~~
      rendered = rendered.replace(/~~(.*?)~~/g, '<del class="md-strikethrough">$1</del>');
      
      // Underline: __text__ (alternative, not conflicting with bold)
      rendered = rendered.replace(/\+\+(.*?)\+\+/g, '<u class="md-underline">$1</u>');
      
      // Line breaks (this won't affect code blocks since they're already extracted)
      rendered = rendered.replace(/\n/g, '<br>');
      
      return { renderedText: rendered, codeBlocks };
    };

    // Function to render text content with code blocks as components
    const renderTextSegments = (text: string) => {
      const { renderedText, codeBlocks } = renderTextContent(text);
      const segments: Array<{type: 'text' | 'codeblock'; content?: string; code?: string; language?: string}> = [];
      
      if (codeBlocks.length === 0) {
        // No code blocks, just return the rendered text
        segments.push({ type: 'text', content: renderedText });
        return segments;
      }
      
      // Split the rendered text by code block placeholders and interleave with code blocks
      let remainingText = renderedText;
      
      codeBlocks.forEach((codeBlock) => {
        const placeholder = codeBlock.id;
        const placeholderIndex = remainingText.indexOf(placeholder);
        
        if (placeholderIndex !== -1) {
          // Add text before the placeholder
          const beforeText = remainingText.substring(0, placeholderIndex);
          if (beforeText) {
            segments.push({ type: 'text', content: beforeText });
          }
          
          // Add the code block
          segments.push({ 
            type: 'codeblock', 
            code: codeBlock.code, 
            language: codeBlock.language 
          });
          
          // Update remaining text to everything after the placeholder
          remainingText = remainingText.substring(placeholderIndex + placeholder.length);
        }
      });
      
      // Add any remaining text after the last code block
      if (remainingText) {
        segments.push({ type: 'text', content: remainingText });
      }
      
      return segments;
    };

    // Watch for changes to the prop and update the local copy accordingly
    watch(() => props.editableContent, (newVal) => {
      // Only update if the value is different to avoid infinite loops
      if (newVal !== localEditableContent.value) {
        localEditableContent.value = newVal;
      }
      nextTick(() => {
        if (editTextarea.value && props.editableMessageId === props.messageId) {
          autoResizeTextarea();
          editTextarea.value.focus();
          const textLength = editTextarea.value.value.length;
          editTextarea.value.setSelectionRange(textLength, textLength);
        }
      });
    });

    // Watch for edit mode changes
    watch(() => props.editableMessageId, (newVal) => {
      if (newVal === props.messageId) {
        nextTick(() => {
          if (editTextarea.value) {
            autoResizeTextarea();
            editTextarea.value.focus();
            const textLength = editTextarea.value.value.length;
            editTextarea.value.setSelectionRange(textLength, textLength);
          }
        });
      }
    });

    // Auto-resize textarea based on content
    const autoResizeTextarea = () => {
      if (editTextarea.value) {
        editTextarea.value.style.height = 'auto';
        editTextarea.value.style.height = Math.min(editTextarea.value.scrollHeight, 200) + 'px';
      }
    };

    const handleInput = (event: Event) => {
      const target = event.target as HTMLTextAreaElement;
      const value = target.value;
      const cursorPosition = target.selectionStart || 0;
      
      // Update local content
      localEditableContent.value = value;
      
      // Emit the content update
      emit('update:content', value);
      
      // Handle auto-suggest
      autoSuggest.handleInput(value, cursorPosition);
      
      autoResizeTextarea();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if auto-suggest handled the key event first
      if (autoSuggest.handleKeyDown(event)) {
        return;
      }
      
      if (event.key === 'Enter' && !event.shiftKey) {
        // Only save if auto-suggest is not active
        if (!autoSuggest.state.value.isActive) {
          event.preventDefault();
          handleSaveEdit();
        }
        return;
      }
      
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancelEdit();
        return;
      }
    };

    const handleSuggestionSelect = (suggestion: SuggestionItem) => {
      if (!editTextarea.value) return;
      
      const newValue = autoSuggest.selectSuggestion(suggestion);
      if (newValue !== localEditableContent.value) {
        localEditableContent.value = newValue;
        emit('update:content', newValue);
        
        nextTick(() => {
          autoResizeTextarea();
          // Keep focus on the textarea after suggestion selection
          if (editTextarea.value) {
            editTextarea.value.focus();
          }
        });
      }
    };

    const handleSaveEdit = () => {
      console.log('handleSaveEdit called');
      autoSuggest.closeSuggestions();
      
      const content = localEditableContent.value.trim();
      console.log('handleSaveEdit called with content:', content);
      console.log('messageId:', props.messageId);
      console.log('editableMessageId:', props.editableMessageId);
      
      if (!content) {
        console.log('Content is empty, canceling edit');
        handleCancelEdit();
        return;
      }
      
      try {
        console.log('Emitting update:message with messageId:', props.messageId, 'content:', content);
        emit('update:message', props.messageId, content);
        console.log('update:message emitted successfully');
      } catch (e) {
        console.error('Error in handleSaveEdit:', e);
      }
    };

    const handleCancelEdit = () => {
      autoSuggest.closeSuggestions();
      emit('cancel-edit');
    };


    return { 
      localEditableContent,
      editTextarea,
      handleSaveEdit, 
      handleCancelEdit,
      handleKeyDown,
      handleInput,
      autoResizeTextarea,
      autoSuggest,
      handleSuggestionSelect,
      isImageUrl,
      isVideoUrl,
      formatFileSize,
      renderTextContent,
      renderTextSegments,
      getFileName,
    };
  }
});
</script>

<style scoped>
.unified-content {
  width: 100%;
  line-height: 1.375;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

/* Text content styling */
.text-content {
  color: #dcddde;
}

.text-content :deep(.md-bold) {
  font-weight: bold;
  color: #ffffff;
}

.text-content :deep(.md-italic) {
  font-style: italic;
}

.text-content :deep(.md-strikethrough) {
  text-decoration: line-through;
  opacity: 0.6;
}

.text-content :deep(.md-underline) {
  text-decoration: underline;
}

.text-content :deep(.md-code) {
  background-color: #2f3136;
  border-radius: 3px;
  padding: 2px 4px;
  font-family: 'Monaco', 'Consolas', 'Courier New', monospace;
  font-size: 0.85em;
}

/* Code blocks are now handled by the CodeBlock component */

/* URL links */
.url-link {
  color: #00aff4;
  text-decoration: none;
  word-break: break-all;
}

.url-link:hover {
  text-decoration: underline;
}

/* User mentions */
.mention {
  background-color: #3c4270;
  border-radius: 3px;
  padding: 0 2px;
  font-weight: 500;
  cursor: pointer;
  color: #c9c9ee;
  display: inline-block;
  transition: background-color 0.2s ease;
}

.mention:hover {
  background-color: #5865f2;
  color: rgba(255,255,255,0.9);
}

/* Emoji styling */
.emoji-icon {
  width: auto;
  max-width: 120px;
  height: 24px;
  vertical-align: middle;
  margin: 0 1px;
}

.emoji-icon.single {
  height: 64px;
}

/* Media containers */
.media-container {
  margin: 4px 0 8px 0;
  max-width: 100%;
}

.image-container {
  max-width: 400px;
}

.content-image {
  max-width: 100%;
  height: auto;
  max-height: 300px;
  border-radius: 8px;
  cursor: pointer;
  transition: transform 0.2s ease-in-out;
}

.content-image:hover {
  transform: scale(1.02);
}

.video-container {
  max-width: 400px;
}

.content-video {
  max-width: 100%;
  height: auto;
  max-height: 300px;
  border-radius: 8px;
  background-color: #000;
}

/* Media skeletons */
.media-skeleton {
  border-radius: 8px;
  background: linear-gradient(
    90deg,
    #40444b 0%,
    #484c52 50%,
    #40444b 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
}

.image-skeleton {
  width: 200px;
  height: 150px;
}

@keyframes skeleton-shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}

/* File attachments */
.file-attachment {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background-color: #2f3136;
  border-radius: 8px;
  margin: 4px 0;
  max-width: 400px;
}

.file-icon {
  font-size: 20px;
}

.file-name {
  color: #00aff4;
  text-decoration: none;
  font-weight: 500;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-name:hover {
  text-decoration: underline;
}

.file-size {
  color: #b9bbbe;
  font-size: 0.875rem;
  white-space: nowrap;
}

/* Edit interface styles */
.edit-container {
  width: 100%;
}

.edit-textarea {
  width: 100%;
  min-height: 40px;
  max-height: 200px;
  padding: 8px 12px;
  border: 1px solid #40444b;
  border-radius: 8px;
  background-color: #40444b;
  color: #dcddde;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.375;
  resize: none;
  outline: none;
  box-sizing: border-box;
  overflow-y: auto;
  transition: border-color 0.15s ease-in-out;
}

.edit-textarea:focus {
  border-color: #5865f2;
  background-color: #383c42;
}

.edit-textarea::placeholder {
  color: #72767d;
}

.edit-actions {
  margin-top: 8px;
  font-size: 12px;
  color: #72767d;
}

.edit-hint {
  font-size: 12px;
  color: #72767d;
}

.edit-action {
  color: #00b0f4;
  cursor: pointer;
  font-weight: 500;
}

.edit-action:hover {
  text-decoration: underline;
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

@media (max-width: 768px) {
  .image-container,
  .video-container {
    max-width: 100%;
  }
  
  .content-video {
    max-width: 100%;
  }
}
</style>
