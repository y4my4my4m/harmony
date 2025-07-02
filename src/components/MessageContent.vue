<template>
  <div v-if="editableMessageId !== messageId" class="message-content">
    <template v-for="(part, partIndex) in content" :key="partIndex">
      <template v-if="part && typeof part === 'object'">
        <span draggable="false" @dragstart.prevent class="selectableText" v-if="part.type === 'text'">{{ part.text }}</span>
        <a v-else-if="part.type === 'url'" :href="part.url" target="_blank" rel="noopener noreferrer">{{ part.url }}</a>
        <span v-else-if="part.type === 'mention'" class="mention" @click="$emit('show-user-profile', part.userId, $event)">{{ part.mention }}</span>
        <img v-else-if="part.type === 'emoji'"
          class="emoji-icon"
          :class="{ 'single': isSingleEmojiMessage }"
          :src="part.emoji.url"
          :alt="part.emoji.name"
          :title="`:${part.emoji.name}:`"
          draggable="false"
        />
        <div v-if="(part.type === 'file' && part.fileType === 'image' && !reply) && imageLoaded" class="file-container">
          <div v-if="!imageLoaded[part.url]" class="image-skeleton"></div>
          <img
            :src="part.url"
            @load="$emit('image-loaded', part.url)"
            @click="$emit('open-lightbox', part.url)"
            v-show="imageLoaded[part.url]"
            draggable="false"
          />
        </div>
        <!-- maybe unsafe? -->
        <div v-if="(part.type === 'url' && part.url && (part.url.endsWith('.jpg') || part.url.endsWith('.png') || part.url.endsWith('.webp'))) && imageLoaded && !reply" class="file-container">
          <div v-if="!imageLoaded[part.url]" class="image-skeleton"></div>
          <img
            :src="part.url"
            @load="$emit('image-loaded', part.url)"
            @click="$emit('open-lightbox', part.url)"
            v-show="imageLoaded[part.url]"
            draggable="false"
          />
        </div>
        <div v-if="(part.type === 'url' && part.url && (part.url.endsWith('.mp4') || part.url.endsWith('.webm'))) && !reply" class="file-container">
          <video
            :src="part.url"
            controls
          ></video>
        </div>
        <a v-if="reply && (part.type === 'url' || part.type === 'file') && part.url" :href="part.url" target="_blank" rel="noopener noreferrer">{{ part.url }}</a>
      </template>
    </template>
  </div>
  
  <!-- Discord-like editing interface -->
  <div v-else class="edit-container">
    <textarea 
      :id="`edit-input-${messageId}`"
      v-model="localEditableContent" 
      @keydown="handleKeyDown"
      @input="handleInput"
      class="edit-textarea"
      :placeholder="'Edit message'"
      ref="editTextarea"
      rows="1"
      @dragstart.prevent
    ></textarea>
    <div class="edit-actions">
      <span class="edit-hint">escape to <span class="edit-action" @click="handleCancelEdit">cancel</span> • enter to <span class="edit-action" @click="handleSaveEdit">save</span></span>
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
            <span v-if="suggestion.username" class="suggest-username">@{{ suggestion.username }}</span>
            <span v-if="suggestion.server_name" class="suggest-server">{{ suggestion.server_name }}</span>
          </div>
        </div>
      </template>
    </AutoSuggest>
  </div>
</template>

<script lang="ts">
import { defineComponent, watch, ref, nextTick } from 'vue';
import type { PropType } from 'vue';
import type { MessagePart } from '@/types';
import AutoSuggest from '@/components/AutoSuggest.vue';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';
import { useAutoSuggest } from '@/composables/useAutoSuggest';

export default defineComponent({
  name: 'MessageContent',
  components: {
    AutoSuggest,
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
    imageLoaded: Object as PropType<Record<string, boolean>>,
    isSingleEmojiMessage: Boolean,
    editableMessageContent: {
      type: String,
      default: ''
    },
    saveEdit: Function,
    cancelEdit: Function,
    showUserProfile: Function,
    reply: Boolean,
  },
  emits: ['update:message', 'update:content', 'cancel-edit', 'image-loaded', 'open-lightbox', 'show-user-profile'],
  setup(props, { emit }) {
    const localEditableContent = ref(props.editableMessageContent);
    const editTextarea = ref<HTMLTextAreaElement | null>(null);
    
    // Auto-suggest setup
    const autoSuggest = useAutoSuggest(editTextarea);

    // Watch for changes to the prop and update the local copy accordingly
    watch(() => props.editableMessageContent, (newVal) => {
      localEditableContent.value = newVal;
      nextTick(() => {
        if (editTextarea.value && props.editableMessageId === props.messageId) {
          autoResizeTextarea();
          editTextarea.value.focus();
          // Remove the .select() call to prevent automatic text selection
          // This allows users to position cursor where they want to edit
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
            // Remove the .select() call here too
            // Position cursor at the end of the text instead
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

    const handleInput = () => {
      if (editTextarea.value) {
        const value = editTextarea.value.value;
        const cursorPosition = editTextarea.value.selectionStart || 0;
        
        // Handle auto-suggest
        autoSuggest.handleInput(value, cursorPosition);
      }
      
      emit('update:content', localEditableContent.value);
      autoResizeTextarea();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // Let auto-suggest handle its own key events first
      if (autoSuggest.handleKeyDown(event)) {
        return; // Auto-suggest handled the event
      }
      
      // Handle Enter key (save)
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleSaveEdit();
        return;
      }
      
      // Handle Escape key (cancel)
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancelEdit();
        return;
      }

      // Allow Shift+Enter for new lines
      if (event.key === 'Enter' && event.shiftKey) {
        // Let the default behavior happen (new line)
        return;
      }
    };

    const handleSuggestionSelect = (suggestion: SuggestionItem) => {
      if (editTextarea.value) {
        const newValue = autoSuggest.selectSuggestion(suggestion);
        localEditableContent.value = newValue;
        emit('update:content', newValue);
      }
    };

    const handleSaveEdit = () => {
      // Close auto-suggest when saving
      autoSuggest.closeSuggestions();
      
      if (!localEditableContent.value.trim()) {
        handleCancelEdit();
        return;
      }
      
      try {
        emit('update:message', props.messageId, localEditableContent.value);
      } catch (e) {
        console.error('Error in handleSaveEdit:', e);
      }
    };

    const handleCancelEdit = () => {
      // Close auto-suggest when canceling
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
    };
  }
});
</script>

<style scoped>
.emoji-icon  {
  width: auto;
  max-width : 120px;
  height: 24px; 
  /* height: 48px; */
  /* margin: 0 2px; */
  vertical-align: middle;
}
.emoji-icon.single {
  height: 64px;
}

.mention {
  background-color: #3c4270;
  border-radius: 3px;
  padding: 0 2px;
  font-weight: 500;
  cursor: pointer;
  color: #c9c9ee;
  display: inline-block;
  transition: 0.2s;
  font-weight:500;
}
.mention:hover {
  background-color: #5865f2;
  color:rgba(255,255,255,0.9);
}
.file-container {
  margin-top: 5px;
}

.message-header + .file-container{
  padding-left: 46px
}
.file-container > img {
  height: 100%;
  max-width: 100%;
  width: auto;
  max-height: 256px;
  border-radius: 5px;
  cursor: pointer;
  transition: transform 0.2s ease-in-out;
}

.file-container img:hover {
  transform: scale(1.05);
}
.file-container > video {
  max-width: 25vw!important;
  max-height: 25vh !important;
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 4px;
}

/* Edit interface styles */
.edit-container {
  width: 100%;
  max-width: calc(100vw - 200px);
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

@media (max-width: 768px) {
  .file-container > video {
    max-width: 100% !important;
  }
  
  .edit-container {
    max-width: calc(100vw - 40px);
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
