<!-- Composer Component - Unified ActivityPub post/reply composer -->
<!-- Supports both modal and inline modes, new posts and replies -->
<template>
  <component :is="wrapperComponent" v-bind="wrapperProps">
    <div :class="composerClasses" @click.self="handleOverlayClick">
      <div :class="contentClasses">
        <!-- Header -->
        <div class="composer-header">
          <h2 class="composer-title">
            {{ headerTitle }}
          </h2>
          <button v-if="mode === 'modal'" class="close-button" @click="handleClose">
            <Icon name="x" />
          </button>
        </div>

        <!-- Reply Context (for replies only) -->
        <div v-if="type === 'reply' && replyToPost" class="reply-context">
          <div class="reply-thread-line"></div>
          <div class="reply-to-post">
            <Avatar 
              :src="replyToPost.author?.avatar_url"
              :alt="replyToPost.author?.display_name || replyToPost.author?.username"
              size="md"
              :interactive="true"
            />
            <div class="reply-content">
              <div class="reply-author">
                <span class="author-name">{{ replyToPost.author?.display_name }}</span>
                <span class="author-handle">{{ replyToPost.author?.handle }}</span>
              </div>
              <div class="reply-text">
                <MonyContent :content="replyToPost.content" :truncate="3" />
              </div>
            </div>
          </div>
        </div>

        <!-- Main Composer Body -->
        <div class="composer-body">
          <div class="composer-user">
            <Avatar 
              :src="currentUser?.avatar_url"
              :alt="currentUser?.display_name || currentUser?.username"
              size="md"
              :interactive="true"
            />
          </div>

          <div class="composer-input-area">
            <!-- Content Warning Input -->
            <div v-if="state.showContentWarning" class="content-warning-input">
              <input
                v-model="state.contentWarning"
                type="text"
                placeholder="Content warning (optional)"
                class="cw-input"
                maxlength="100"
              />
            </div>

            <!-- Main Text Input -->
            <div class="text-input-container">
              <RichTextEditor
                ref="richEditorRef"
                :model-value="state.content"
                :placeholder="placeholder"
                :max-height="200"
                :min-height="60"
                @update:model-value="handleContentUpdate"
                @keydown="handleKeydown"
                @cursor-position-changed="handleCursorPositionChanged"
                @paste="actions.handlePaste"
              />
              
              <!-- Character Counter -->
              <div class="character-counter" :class="state.characterCounterClass">
                {{ state.remainingCharacters }}
              </div>
              
              <!-- Auto-suggest dropdown -->
              <AutoSuggest
                :isVisible="autoSuggest.state.value.isActive"
                :suggestions="autoSuggest.suggestions.value"
                :position="autoSuggest.state.value.position"
                :selectedIndex="autoSuggest.state.value.selectedIndex"
                :headerText="autoSuggest.headerText.value"
                @select="handleSuggestionSelect"
              >
                <template #default="{ suggestion }">
                  <!-- Emoji Suggestion -->
                  <div v-if="suggestion.url && suggestion.emoji" class="suggest-item-content">
                    <img 
                      :src="suggestion.url" 
                      :alt="suggestion.name"
                      class="suggest-icon emoji-icon"
                    />
                    <div class="suggest-text">
                      <span class="suggest-name">:{{ suggestion.name }}:</span>
                      <span v-if="suggestion.server_name" class="suggest-server">{{ suggestion.server_name }}</span>
                    </div>
                  </div>
                  
                  <!-- User Suggestion -->
                  <div v-else class="suggest-item-content">
                    <Avatar 
                      v-if="suggestion.avatar || suggestion.avatar_url" 
                      :src="suggestion.avatar || suggestion.avatar_url" 
                      :alt="suggestion.display_name || suggestion.username"
                      class="suggest-icon"
                      size="sm"
                    />
                    <div class="suggest-text">
                      <span class="suggest-name">{{ suggestion.display_name || suggestion.username }}</span>
                      <span v-if="suggestion.username && suggestion.display_name !== suggestion.username" class="suggest-username">@{{ suggestion.username }}</span>
                      <span v-if="suggestion.handle && suggestion.handle.includes('@')" class="suggest-domain">{{ suggestion.handle }}</span>
                    </div>
                  </div>
                </template>
              </AutoSuggest>
            </div>

            <!-- Media Attachments Preview -->
            <MonyMediaUpload
              v-if="state.mediaAttachments.length > 0"
              :attachments="state.mediaAttachments"
              @remove="state.removeMediaAttachment"
              @update-description="(index, desc) => {
                if (state.mediaAttachments[index]) {
                  state.mediaAttachments[index].description = desc;
                }
              }"
            />

            <!-- Compose Options Toolbar -->
            <div class="compose-options">
              <div class="option-group">
                <!-- Media Upload -->
                <input
                  ref="fileInputRef"
                  type="file"
                  multiple
                  accept="image/*,video/*"
                  class="hidden"
                  @change="actions.handleFileUpload"
                />
                <button
                  class="option-button"
                  @click="triggerFileUpload"
                  :disabled="!state.canAddMedia"
                  title="Add media"
                >
                  <Icon name="image" />
                </button>

                <!-- GIF Picker -->
                <button
                  ref="gifTriggerRef"
                  class="option-button"
                  @click="toggleGifPicker"
                  title="Add GIF"
                >
                  <GifIcon />
                </button>

                <!-- Emoji Picker -->
                <button
                  ref="emojiTriggerRef"
                  class="option-button"
                  @click="toggleEmojiPicker"
                  title="Add emoji"
                >
                  <EmojiUI />
                </button>

                <!-- Content Warning -->
                <button
                  class="option-button"
                  :class="{ active: state.showContentWarning }"
                  @click="state.toggleContentWarning"
                  title="Add content warning"
                >
                  <Icon name="alert-triangle" />
                </button>

                <!-- Sensitive Content -->
                <button
                  class="option-button"
                  :class="{ active: state.isSensitive }"
                  @click="state.isSensitive = !state.isSensitive"
                  title="Mark as sensitive"
                >
                  <Icon name="eye-off" />
                </button>
              </div>

              <!-- Visibility Selector -->
              <div class="visibility-selector">
                <button
                  class="visibility-button"
                  @click="toggleVisibilityMenu"
                  :title="state.visibilityOptions.find(v => v.value === state.visibility)?.label"
                >
                  <Icon :name="state.visibilityOptions.find(v => v.value === state.visibility)?.icon || 'globe'" />
                  <span class="hidden sm:inline">{{ state.visibilityOptions.find(v => v.value === state.visibility)?.label }}</span>
                  <Icon name="chevron-down" :size="16" />
                </button>

                <div v-if="state.showVisibilityMenu" class="visibility-menu" v-click-outside="closeVisibilityMenu">
                  <button
                    v-for="option in state.visibilityOptions"
                    :key="option.value"
                    class="visibility-option"
                    :class="{ active: state.visibility === option.value }"
                    @click="state.setVisibility(option.value)"
                  >
                    <Icon :name="option.icon" />
                    <div class="option-details">
                      <div class="option-label">{{ option.label }}</div>
                      <div class="option-description">{{ option.description }}</div>
                    </div>
                    <Icon v-if="state.visibility === option.value" name="check" :size="16" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="composer-footer">
          <div class="footer-info">
            <span v-if="state.isDraft" class="draft-indicator">
              <Icon name="save" />
              Draft saved
            </span>
          </div>

          <div class="footer-actions">
            <button
              class="cancel-button"
              @click="handleClose"
              :disabled="isPosting"
            >
              Cancel
            </button>
            
            <button
              class="post-button"
              :disabled="!state.canSubmit || isPosting"
              @click="handleSubmit"
            >
              <Icon v-if="isPosting" name="spinner" class="spinning" />
              <span>{{ submitButtonText }}</span>
            </button>
          </div>
        </div>

        <!-- Emoji Picker -->
        <Teleport to="body">
          <EmojiPopup
            v-if="state.showEmojiPicker"
            @sendEmoji="handleEmojiInsert"
            :closeEmojiList="() => state.showEmojiPicker = false"
            :position="'above'"
            :triggerElement="emojiTriggerRef || undefined"
          />
        </Teleport>

        <!-- GIF Picker -->
        <Teleport to="body">
          <GifComponent
            v-if="state.showGiphyPicker"
            @sendGif="handleGifInsert"
            :closeGiphy="() => state.showGiphyPicker = false"
            :position="'above'"
            :triggerElement="gifTriggerRef || undefined"
          />
        </Teleport>
      </div>
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useProfileStore } from '@/stores/useProfile';
import type { TimelinePost, Post } from '@/types';

// Composables
import { useComposerState } from '@/composables/useComposerState';
import { useComposerActions } from '@/composables/useComposerActions';
import { useAutoSuggest } from '@/composables/useAutoSuggest';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';

// Components
import MonyContent from './MonyContent.vue';
import MonyMediaUpload from './MonyMediaUpload.vue';
import EmojiPopup from '@/components/EmojiPopup.vue';
import GifComponent from '@/components/GifComponent.vue';
import GifIcon from '@/components/icons/Gif.vue';
import EmojiUI from '@/components/EmojiUI.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '../common/Avatar.vue';
import AutoSuggest from '@/components/AutoSuggest.vue';
import RichTextEditor from '@/components/RichTextEditor.vue';

// Props
interface Props {
  mode: 'modal' | 'inline';
  type: 'post' | 'reply';
  replyToPost?: TimelinePost;
  isOpen?: boolean;
  defaultVisibility?: Post['visibility'];
}

const props = withDefaults(defineProps<Props>(), {
  isOpen: true,
  defaultVisibility: 'public'
});

// Emits
const emit = defineEmits<{
  close: [];
  posted: [post: any];
}>();

// Store
const profileStore = useProfileStore();

// Refs
const richEditorRef = ref<InstanceType<typeof RichTextEditor>>();
const fileInputRef = ref<HTMLInputElement>();
const emojiTriggerRef = ref<HTMLElement | null>(null);
const gifTriggerRef = ref<HTMLElement | null>(null);
const isPosting = ref(false);

// State management using composable
const state = useComposerState({
  defaultVisibility: props.defaultVisibility
});

// AutoSuggest setup
const getCurrentText = () => state.content || '';
const updateText = (newText: string) => {
  state.content = newText;
};
const autoSuggest = useAutoSuggest(richEditorRef, getCurrentText, updateText, {
  mode: 'activitypub',
  enableEmojis: true,
  enableMentions: true,
  maxSuggestions: 10
});

// Actions using composable
const actions = useComposerActions({
  content: state.content,
  richEditorRef,
  showEmojiPicker: state.showEmojiPicker,
  showGiphyPicker: state.showGiphyPicker,
  mediaAttachments: state.mediaAttachments,
  canAddMedia: state.canAddMedia,
  onContentUpdate: (newContent) => {
    state.content = newContent;
  }
});

// Computed
const currentUser = computed(() => profileStore.profile);

const placeholder = computed(() => {
  if (props.type === 'reply') {
    return 'What\'s your reply?';
  }
  return 'What\'s happening in the Monyverse?';
});

const headerTitle = computed(() => {
  if (props.type === 'reply') {
    return 'Reply to Mony';
  }
  return 'Create a Mony';
});

const submitButtonText = computed(() => {
  if (isPosting.value) {
    return props.type === 'reply' ? 'Replying...' : 'Posting...';
  }
  return props.type === 'reply' ? 'Reply' : 'Mony';
});

const wrapperComponent = computed(() => {
  return props.mode === 'modal' ? 'Teleport' : 'div';
});

const wrapperProps = computed(() => {
  if (props.mode === 'modal') {
    return { to: 'body' };
  }
  return {};
});

const composerClasses = computed(() => {
  if (props.mode === 'modal') {
    return {
      'composer-overlay': true,
      'is-modal': true
    };
  }
  return {
    'composer-inline': true
  };
});

const contentClasses = computed(() => {
  return {
    'composer-modal': props.mode === 'modal',
    'composer-inline-content': props.mode === 'inline',
    'is-reply': props.type === 'reply'
  };
});

// Methods
const handleContentUpdate = (newContent: string) => {
  state.content = newContent;
};

const handleCursorPositionChanged = (position: number) => {
  if (richEditorRef.value) {
    autoSuggest.handleInput(state.content, position);
  }
};

const handleSuggestionSelect = (suggestion: SuggestionItem) => {
  autoSuggest.selectSuggestion(suggestion);
};

const handleKeydown = (event: KeyboardEvent) => {
  // Handle autoSuggest navigation
  const handled = autoSuggest.handleKeyDown(event);
  if (handled) return;
  
  // Ctrl/Cmd + Enter to post
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    if (state.canSubmit) {
      handleSubmit();
    }
  }
  
  // Escape to close
  if (event.key === 'Escape' && props.mode === 'modal') {
    handleClose();
  }
};

const triggerFileUpload = () => {
  fileInputRef.value?.click();
};

const closeVisibilityMenu = () => {
  state.showVisibilityMenu = false;
};

const toggleVisibilityMenu = () => {
  // Close other pickers when opening visibility menu
  state.showEmojiPicker = false;
  state.showGiphyPicker = false;
  state.showVisibilityMenu = !state.showVisibilityMenu;
};

const toggleEmojiPicker = () => {
  // Close other pickers when opening emoji picker
  state.showVisibilityMenu = false;
  state.showGiphyPicker = false;
  state.showEmojiPicker = !state.showEmojiPicker;
};

const toggleGifPicker = () => {
  // Close other pickers when opening GIF picker
  state.showVisibilityMenu = false;
  state.showEmojiPicker = false;
  state.showGiphyPicker = !state.showGiphyPicker;
};

const handleOverlayClick = () => {
  if (props.mode === 'modal') {
    handleClose();
  }
};

const handleEmojiInsert = (emoji: any) => {
  actions.insertEmoji(emoji);
  state.showEmojiPicker = false;
};

const handleGifInsert = (gif: any) => {
  actions.insertGif(gif);
  state.showGiphyPicker = false;
};

const handleClose = () => {
  // Close all pickers
  state.showEmojiPicker = false;
  state.showGiphyPicker = false;
  state.showVisibilityMenu = false;
  
  if (state.content.trim() && !isPosting.value) {
    // Save as draft
    state.isDraft = true;
    setTimeout(() => {
      state.isDraft = false;
    }, 2000);
  }
  emit('close');
};

const handleSubmit = async () => {
  if (!state.canSubmit || isPosting.value) return;

  isPosting.value = true;
  
  try {
    const post = await actions.submitPost(
      state.visibility,
      state.contentWarning,
      state.isSensitive,
      props.type === 'reply' ? props.replyToPost?.id : undefined
    );

    // Reset state
    state.reset();
    
    // Emit success
    emit('posted', post);
    emit('close');
  } catch (error) {
    console.error('Failed to create post:', error);
    // TODO: Show error toast
  } finally {
    isPosting.value = false;
  }
};

// Lifecycle
onMounted(() => {
  // Pre-populate mention for replies
  if (props.type === 'reply' && props.replyToPost) {
    const author = props.replyToPost.author;
    if (author) {
      const mention = author.domain && !author.is_local 
        ? `@${author.username}@${author.domain} `
        : `@${author.username} `;
      state.content = mention;
    }
  }

  if (props.isOpen && props.mode === 'modal') {
    nextTick(() => {
      richEditorRef.value?.focus();
    });
  }
});

// Watch for modal open state
watch(() => props.isOpen, (isOpen) => {
  if (isOpen && props.mode === 'modal') {
    nextTick(() => {
      richEditorRef.value?.focus();
    });
  }
});

// Watch for reply context changes (when opening reply composer)
watch(() => props.replyToPost, (replyPost) => {
  if (props.type === 'reply' && replyPost && !state.content) {
    const author = replyPost.author;
    if (author) {
      const mention = author.domain && !author.is_local 
        ? `@${author.username}@${author.domain} `
        : `@${author.username} `;
      state.content = mention;
      nextTick(() => {
        richEditorRef.value?.focus();
      });
    }
  }
});

// Click outside directive
const vClickOutside = {
  mounted(el: HTMLElement, binding: any) {
    el._clickOutsideHandler = (event: Event) => {
      if (!(el === event.target || el.contains(event.target as Node))) {
        binding.value();
      }
    };
    document.addEventListener('click', el._clickOutsideHandler);
  },
  unmounted(el: HTMLElement) {
    document.removeEventListener('click', el._clickOutsideHandler);
  }
};
</script>

<style scoped>
/* Modal overlay */
.composer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}

/* Modal content */
.composer-modal {
  background-color: var(--background-primary);
  border-radius: 1rem;
  max-width: 600px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  border: 1px solid var(--border-primary);
}

.composer-modal.is-reply {
  max-width: 700px;
}

/* Inline content */
.composer-inline {
  width: 100%;
}

.composer-inline-content {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background-color: var(--background-primary);
  padding: 1rem;
}

/* Header */
.composer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem 1.5rem 1rem;
  border-bottom: 1px solid var(--border-primary);
}

.composer-inline-content .composer-header {
  padding: 0 0 1rem;
}

.composer-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: white;
  margin: 0;
}

.close-button {
  background: none;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 0.5rem;
  transition: all 0.2s;
}

.close-button:hover {
  background-color: var(--bg-tertiary);
  color: white;
}

/* Reply Context */
.reply-context {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--border-primary);
  position: relative;
}

.composer-inline-content .reply-context {
  padding: 1rem 0;
}

.reply-thread-line {
  position: absolute;
  left: 3rem;
  top: 4rem;
  bottom: 0;
  width: 2px;
  background-color: var(--border-primary);
}

.reply-to-post {
  display: flex;
  gap: 0.75rem;
}

.reply-content {
  flex: 1;
  min-width: 0;
}

.reply-author {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.author-name {
  font-weight: 600;
  color: white;
}

.author-handle {
  color: #9ca3af;
  font-size: 0.875rem;
}

.reply-text {
  color: #d1d5db;
  font-size: 0.875rem;
  line-height: 1.5;
}

/* Composer Body */
.composer-body {
  display: flex;
  gap: 0.75rem;
  padding: 1.5rem;
}

.composer-inline-content .composer-body {
  padding: 0;
}

.composer-user {
  flex-shrink: 0;
}

.composer-input-area {
  flex: 1;
  min-width: 0;
}

/* Content Warning */
.content-warning-input {
  margin-bottom: 1rem;
}

.cw-input {
  width: 100%;
  padding: 0.75rem;
  background-color: var(--bg-tertiary);
  border: 1px solid var(--border-primary);
  border-radius: 0.5rem;
  color: white;
  font-size: 0.875rem;
}

.cw-input::placeholder {
  color: #9ca3af;
}

.cw-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

/* Text Input */
.text-input-container {
  position: relative;
  margin-bottom: 1rem;
}

.character-counter {
  position: absolute;
  bottom: 0.75rem;
  right: 0.75rem;
  font-size: 0.875rem;
  color: #9ca3af;
}

.character-counter.warning {
  color: #f59e0b;
}

.character-counter.over-limit {
  color: #ef4444;
}

/* Compose Options */
.compose-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 1rem;
}

.option-group {
  display: flex;
  gap: 0.5rem;
}

.option-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: none;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  border-radius: 0.5rem;
  transition: all 0.2s;
  flex-shrink: 0;
}

.option-button:hover {
  background-color: #374151;
  color: white;
}

.option-button.active {
  color: #2563eb;
  background-color: rgba(37, 99, 235, 0.1);
}

.option-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Ensure buttons are visible in inline mode */
.composer-inline-content .option-button {
  display: flex;
}

.visibility-selector {
  position: relative;
}

.visibility-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background-color: #374151;
  border: 1px solid #4b5563;
  border-radius: 0.5rem;
  color: white;
  cursor: pointer;
  transition: all 0.2s;
}

.visibility-button:hover {
  background-color: #4b5563;
}

.visibility-menu {
  position: absolute;
  top: 100%;
  right: 0;
  background-color: #1f2937;
  border: 1px solid #374151;
  border-radius: 0.5rem;
  padding: 0.5rem;
  min-width: 250px;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
  z-index: 10;
  margin-top: 0.5rem;
}

.visibility-option {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  padding: 0.75rem;
  background: none;
  border: none;
  color: white;
  text-align: left;
  cursor: pointer;
  border-radius: 0.5rem;
  transition: all 0.2s;
}

.visibility-option:hover {
  background-color: #374151;
}

.visibility-option.active {
  background-color: rgba(37, 99, 235, 0.1);
  color: #3b82f6;
}

.option-details {
  flex: 1;
}

.option-label {
  font-weight: 500;
}

.option-description {
  font-size: 0.875rem;
  color: #9ca3af;
}

/* Footer */
.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--border-primary);
}

.composer-inline-content .composer-footer {
  padding: 1rem 0 0;
}

.footer-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.draft-indicator {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #10b981;
  font-size: 0.875rem;
}

.footer-actions {
  display: flex;
  gap: 0.75rem;
}

.cancel-button {
  padding: 0.5rem 1rem;
  background: none;
  border: 1px solid #374151;
  border-radius: 0.5rem;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.2s;
}

.cancel-button:hover {
  background-color: #374151;
  color: white;
}

.post-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.5rem;
  background-color: var(--harmony-primary);
  border: none;
  border-radius: 0.5rem;
  color: white;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.post-button:hover:not(:disabled) {
  background-color: var(--harmony-primary-hover);
}

.post-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.hidden {
  display: none;
}

/* AutoSuggest styling */
.suggest-item-content {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.suggest-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  flex-shrink: 0;
}

.suggest-icon.emoji-icon {
  border-radius: 0;
}

.suggest-text {
  flex: 1;
  min-width: 0;
}

.suggest-name {
  font-weight: 500;
  color: white;
}

.suggest-username,
.suggest-domain,
.suggest-server {
  color: #9ca3af;
  font-size: 0.875rem;
  margin-left: 0.25rem;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .composer-overlay {
    padding: 0.5rem;
  }
  
  .composer-modal {
    max-height: 95vh;
  }
  
  .composer-header,
  .composer-body,
  .composer-footer {
    padding-left: 1rem;
    padding-right: 1rem;
  }
  
  .visibility-button span {
    display: none;
  }
}
</style>

