<template>
  <!-- Edit mode -->
  <div v-if="editableMessageId === messageId" class="edit-container">
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
    />
  </div>
  
  <!-- Display mode using unified renderer -->
  <UnifiedContentRenderer
    v-else
    :content="content"
    :mode="reply ? 'preview' : 'display'"
    :show-images="!reply"
    :show-videos="!reply"
    :image-loaded="imageLoaded"
    :is-single-emoji="isSingleEmojiMessage"
    render-mode="components"
    @show-user-profile="$emit('show-user-profile', $event)"
    @image-loaded="$emit('image-loaded', $event)"
    @open-lightbox="$emit('open-lightbox', $event)"
    @user-mention-click="handleMentionClick"
  />
</template>

<script lang="ts">
import { defineComponent, watch, ref, nextTick, type PropType } from 'vue';
import { debug } from '@/utils/debug';
import type { MessagePart } from '@/types';
import AutoSuggest from '@/components/AutoSuggest.vue';
import UnifiedContentRenderer from '@/components/UnifiedContentRenderer.vue';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';
import { useAutoSuggest } from '@/composables/useAutoSuggest';

export default defineComponent({
  name: 'MessageContent',
  components: {
    AutoSuggest,
    UnifiedContentRenderer,
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
        }
      });
    });

    // Watch for edit mode changes - place cursor at end on initial open
    watch(() => props.editableMessageId, (newVal) => {
      if (newVal === props.messageId) {
        nextTick(() => {
          if (editTextarea.value) {
            autoResizeTextarea();
            editTextarea.value.focus();
            const len = editTextarea.value.value.length;
            editTextarea.value.setSelectionRange(len, len);
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
        debug.error('Error in handleSaveEdit:', e);
      }
    };

    const handleCancelEdit = () => {
      // Close auto-suggest when canceling
      autoSuggest.closeSuggestions();
      emit('cancel-edit');
    };

    const handleMentionClick = (userId: string, event: Event) => {
      emit('show-user-profile', userId, event);
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
      handleMentionClick,
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
  background-color: var(--harmony-primary);
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
  border: 1px solid var(--background-quinary);
  border-radius: 8px;
  background-color: var(--background-quinary);
  color: var(--text-secondary);
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
  border-color: #0EA5E9;
  background-color: #383c42;
}

.edit-textarea::placeholder {
  color: var(--text-muted);
}

.edit-actions {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-muted);
}

.edit-hint {
  font-size: 12px;
  color: var(--text-muted);
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

</style>
