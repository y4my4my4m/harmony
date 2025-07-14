<!-- MonyComposer Component - Post creation interface -->
<!-- Professional, feature-rich composer for the Monyverse -->
<template>
  <Teleport to="body">
    <div v-if="isOpen" class="composer-overlay" @click.self="onClose">
      <div class="composer-modal" :class="{ 'is-reply': composerState.in_reply_to }">
        <!-- Header -->
        <div class="composer-header">
          <h2 class="composer-title">
            {{ composerState.in_reply_to ? 'Reply to Mony' : 'Create a Mony' }}
          </h2>
          <button class="close-button" @click="onClose">
            <Icon name="x" />
          </button>
        </div>

        <!-- Reply Context -->
        <div v-if="replyToPost" class="reply-context">
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

        <!-- Main Composer -->
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
            <div v-if="showContentWarning" class="content-warning-input">
              <input
                v-model="contentWarning"
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
                :model-value="content"
                :placeholder="placeholder"
                :max-height="200"
                :min-height="60"
                @update:model-value="handleContentUpdate"
                @input="handleInput"
                @keydown="handleKeydown"
                @cursor-position-changed="handleCursorPositionChanged"
              />
              
              <!-- Character Counter -->
              <div class="character-counter" :class="characterCounterClass">
                {{ remainingCharacters }}
              </div>
              
                        <!-- Auto-suggest dropdown for mentions -->
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

            <!-- Media Attachments -->
            <MonyMediaUpload
              v-if="mediaAttachments.length > 0"
              :attachments="mediaAttachments"
              @remove="removeAttachment"
              @update-description="updateAttachmentDescription"
            />

            <!-- Compose Options -->
            <div class="compose-options">
              <!-- Media Upload -->
              <div class="option-group">
                <input
                  ref="fileInputRef"
                  type="file"
                  multiple
                  accept="image/*,video/*"
                  class="hidden"
                  @change="handleFileUpload"
                />
                <button
                  class="option-button"
                  @click="triggerFileUpload"
                  :disabled="mediaAttachments.length >= maxMediaAttachments"
                  title="Add media"
                >
                  <Icon name="image" />
                </button>

                <!-- GIF Picker -->
                <button
                  ref="gifTriggerRef"
                  class="option-button"
                  @click="showGiphyPicker = !showGiphyPicker"
                  title="Add GIF"
                >
                  <GifIcon />
                </button>

                <!-- Emoji Picker -->
                <button
                  ref="emojiTriggerRef"
                  class="option-button"
                  @click="showEmojiPicker = !showEmojiPicker"
                  title="Add emoji"
                >
                  <EmojiUI />
                </button>

                <!-- Content Warning -->
                <button
                  class="option-button"
                  :class="{ active: showContentWarning }"
                  @click="toggleContentWarning"
                  title="Add content warning"
                >
                  <Icon name="alert-triangle" />
                </button>

                <!-- Sensitive Content -->
                <button
                  class="option-button"
                  :class="{ active: isSensitive }"
                  @click="isSensitive = !isSensitive"
                  title="Mark as sensitive"
                >
                  <Icon name="eye-off" />
                </button>
              </div>

              <!-- Visibility Selector -->
              <div class="visibility-selector">
                <button
                  class="visibility-button"
                  @click="showVisibilityMenu = !showVisibilityMenu"
                  :title="visibilityOptions.find(v => v.value === visibility)?.label"
                >
                  <Icon :name="visibilityOptions.find(v => v.value === visibility)?.icon || 'globe'" />
                  <span class="hidden sm:inline">{{ visibilityOptions.find(v => v.value === visibility)?.label }}</span>
                  <Icon name="chevron-down" :size="16" />
                </button>

                <div v-if="showVisibilityMenu" class="visibility-menu" v-click-outside="closeVisibilityMenu">
                  <button
                    v-for="option in visibilityOptions"
                    :key="option.value"
                    class="visibility-option"
                    :class="{ active: visibility === option.value }"
                    @click="setVisibility(option.value)"
                  >
                    <Icon :name="option.icon" />
                    <div class="option-details">
                      <div class="option-label">{{ option.label }}</div>
                      <div class="option-description">{{ option.description }}</div>
                    </div>
                    <Icon v-if="visibility === option.value" name="check" :size="16" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="composer-footer">
          <div class="footer-info">
            <span v-if="isDraft" class="draft-indicator">
              <Icon name="save" />
              Draft saved
            </span>
          </div>

          <div class="footer-actions">
            <button
              class="cancel-button"
              @click="onClose"
              :disabled="isPosting"
            >
              Cancel
            </button>
            
            <button
              class="post-button"
              :disabled="!canPost || isPosting"
              @click="onSubmit"
            >
              <Icon v-if="isPosting" name="spinner" class="spinning" />
              <span>{{ composerState.in_reply_to ? 'Reply' : 'Mony' }}</span>
            </button>
          </div>
        </div>

        <!-- Emoji Picker -->
        <Teleport to="body">
          <EmojiPopup
            v-if="showEmojiPicker"
            @sendEmoji="insertEmoji"
            :closeEmojiList="() => showEmojiPicker = false"
            :position="'above'"
            :triggerElement="emojiTriggerRef || undefined"
          />
        </Teleport>

        <!-- GIF Picker -->
        <Teleport to="body">
          <GifComponent
            v-if="showGiphyPicker"
            @sendGif="insertGif"
            :closeGiphy="() => showGiphyPicker = false"
            :position="'above'"
            :triggerElement="gifTriggerRef || undefined"
          />
        </Teleport>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useProfileStore } from '@/stores/useProfile';
import type { PostComposerState, Post } from '@/types';

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

// Composables  
import { useAutoSuggest } from '@/composables/useAutoSuggest';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';
import { activityPubService } from '@/services/activityPubService';


// Props
interface Props {
  isOpen: boolean;
  composerState: PostComposerState;
  isPosting: boolean;
  replyToPost?: any; // The post being replied to
}

const props = defineProps<Props>();

// Emits
const emit = defineEmits<{
  close: [];
  submit: [];
  'update-content': [content: string];
  'update-visibility': [visibility: Post['visibility']];
}>();

// Store
const authStore = useAuthStore();
const profileStore = useProfileStore();

// Refs
const richEditorRef = ref<InstanceType<typeof RichTextEditor>>();
const fileInputRef = ref<HTMLInputElement>();
const emojiTriggerRef = ref<HTMLElement | null>(null);
const gifTriggerRef = ref<HTMLElement | null>(null);

// AutoSuggest setup 
const getCurrentText = () => content.value || '';
const updateText = (newText: string) => {
  content.value = newText;
  emit('update-content', newText);
};
const autoSuggest = useAutoSuggest(richEditorRef, getCurrentText, updateText, {
  mode: 'activitypub',
  enableEmojis: true,
  enableMentions: true,
  maxSuggestions: 10
});

// Remove all the duplicate user search and suggestion combining logic
// The enhanced composable now handles ActivityPub user search internally

// Watch for mention queries is now handled internally by the composable

// Local state
const content = ref('');
const contentWarning = ref('');
const visibility = ref<Post['visibility']>('public');
const mediaAttachments = ref<File[]>([]);
const isSensitive = ref(false);
const showContentWarning = ref(false);
const showEmojiPicker = ref(false);
const showGiphyPicker = ref(false);
const showVisibilityMenu = ref(false);
const isDraft = ref(false);

// Constants
const characterLimit = 500;
const maxMediaAttachments = 4;

// Computed
const currentUser = computed(() => {
  return profileStore.profile;
});

const placeholder = computed(() => {
  if (props.composerState.in_reply_to) {
    return 'What\'s your reply?';
  }
  return 'What\'s happening in the Monyverse?';
});

const remainingCharacters = computed(() => {
  return characterLimit - content.value.length;
});

const characterCounterClass = computed(() => {
  const remaining = remainingCharacters.value;
  if (remaining < 0) return 'over-limit';
  if (remaining < 20) return 'warning';
  return '';
});

const canPost = computed(() => {
  return content.value.trim().length > 0 && 
         content.value.length <= characterLimit &&
         !props.isPosting;
});

const visibilityOptions = [
  {
    value: 'public' as const,
    label: 'Public',
    description: 'Visible to everyone',
    icon: 'globe'
  },
  {
    value: 'unlisted' as const,
    label: 'Unlisted',
    description: 'Not shown in public timelines',
    icon: 'unlock'
  },
  {
    value: 'followers' as const,
    label: 'Followers',
    description: 'Only visible to followers',
    icon: 'users'
  },
  {
    value: 'direct' as const,
    label: 'Direct',
    description: 'Only mentioned users',
    icon: 'mail'
  }
];

// Watch for prop changes
watch(() => props.composerState.content, (newContent) => {
  content.value = newContent;
});

watch(() => props.composerState.visibility, (newVisibility) => {
  visibility.value = newVisibility;
});

watch(() => props.composerState.content_warning, (newCw) => {
  contentWarning.value = newCw || '';
  showContentWarning.value = !!newCw;
});

watch(() => props.composerState.is_sensitive, (newSensitive) => {
  isSensitive.value = newSensitive;
});

// Methods
const handleContentUpdate = (newContent: string) => {
  content.value = newContent;
  emit('update-content', newContent);
};

const handleInput = () => {
  // Input is handled by handleContentUpdate
};

const handleCursorPositionChanged = (position: number) => {
  // Handle auto-suggest based on cursor position and current text
  if (richEditorRef.value) {
    autoSuggest.handleInput(content.value, position);
  }
};

const handleSuggestionSelect = (suggestion: SuggestionItem) => {
  // Use the autoSuggest system's built-in selection method
  autoSuggest.selectSuggestion(suggestion);
};



const handleKeydown = (event: KeyboardEvent) => {
  // Handle autoSuggest navigation
  const handled = autoSuggest.handleKeyDown(event);
  if (handled) return;
  
  // Ctrl/Cmd + Enter to post
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    if (canPost.value) {
      onSubmit();
    }
  }
  
  // Escape to close
  if (event.key === 'Escape') {
    onClose();
  }
};

const handlePaste = (event: ClipboardEvent) => {
  const items = event.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file && mediaAttachments.value.length < maxMediaAttachments) {
        mediaAttachments.value.push(file);
      }
    }
  }
};

const autoResize = () => {
  // RichTextEditor handles its own resizing
  // This function is kept for compatibility but may not be needed
  if (richEditorRef.value) {
    // RichTextEditor component should handle auto-resize internally
    console.log('autoResize called on RichTextEditor');
  }
};

const triggerFileUpload = () => {
  fileInputRef.value?.click();
};

const handleFileUpload = (event: Event) => {
  const files = (event.target as HTMLInputElement).files;
  if (!files) return;

  for (const file of files) {
    if (mediaAttachments.value.length >= maxMediaAttachments) break;
    if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
      mediaAttachments.value.push(file);
    }
  }
};

const removeAttachment = (index: number) => {
  mediaAttachments.value.splice(index, 1);
};

const updateAttachmentDescription = () => {
  // Update attachment description for accessibility
  // This would be handled by the MonyMediaUpload component
  // TODO: Implement attachment description updates
};

const insertEmoji = (emoji: any) => {
  const richEditor = richEditorRef.value;
  if (!richEditor) return;

  const emojiText = `:${emoji.name}:`;
  
  // For RichTextEditor, we'll insert at the current cursor position
  // or append to the end if no cursor position is available
  const currentContent = content.value;
  content.value = currentContent + emojiText;
  
  nextTick(() => {
    richEditor.focus();
    handleInput();
  });
  
  showEmojiPicker.value = false;
};

const insertGif = (gif: any) => {
  const gifUrl = gif.media_formats.gif.url;
  
  // Add GIF as media attachment - reuse the media upload logic
  const gifAttachment = {
    url: gifUrl,
    type: 'image',
    description: gif.title || 'GIF'
  };
  
  // For now, add it to content as a link
  const currentContent = content.value;
  content.value = currentContent + (currentContent ? '\n' : '') + gifUrl;
  
  showGiphyPicker.value = false;
  
  nextTick(() => {
    const richEditor = richEditorRef.value;
    if (richEditor) {
      richEditor.focus();
      handleInput();
    }
  });
};

const toggleContentWarning = () => {
  showContentWarning.value = !showContentWarning.value;
  if (!showContentWarning.value) {
    contentWarning.value = '';
  }
};

const setVisibility = (newVisibility: Post['visibility']) => {
  visibility.value = newVisibility;
  emit('update-visibility', newVisibility);
  showVisibilityMenu.value = false;
};

const closeVisibilityMenu = () => {
  showVisibilityMenu.value = false;
};

const onClose = () => {
  if (content.value.trim() && !props.isPosting) {
    // Save as draft
    isDraft.value = true;
    setTimeout(() => {
      isDraft.value = false;
    }, 2000);
  }
  emit('close');
};

const onSubmit = () => {
  if (!canPost.value) return;
  emit('submit');
};

// Lifecycle
onMounted(() => {
  nextTick(() => {
    richEditorRef.value?.focus();
    autoResize();
  });
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

.composer-modal {
  background-color: var(--bg-primary);
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

.composer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem 1.5rem 0;
  border-bottom: 1px solid var(--border-primary);
  padding-bottom: 1rem;
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

.reply-context {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--border-primary);
  position: relative;
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

.reply-author-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
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

.composer-body {
  display: flex;
  gap: 0.75rem;
  padding: 1.5rem;
}

.composer-user {
  flex-shrink: 0;
}

.user-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
}

.composer-input-area {
  flex: 1;
  min-width: 0;
}

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

.text-input-container {
  position: relative;
  margin-bottom: 1rem;
}

.text-input {
  width: 100%;
  min-height: 120px;
  padding: 1rem;
  background-color: transparent;
  border: 1px solid var(--border-primary);
  border-radius: 0.5rem;
  color: white;
  font-size: 1rem;
  line-height: 1.5;
  resize: none;
  overflow: hidden;
}

.text-input::placeholder {
  color: #9ca3af;
}

.text-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
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

.compose-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
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
  bottom: 100%;
  right: 0;
  background-color: #1f2937;
  border: 1px solid #374151;
  border-radius: 0.5rem;
  padding: 0.5rem;
  min-width: 250px;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
  z-index: 10;
  margin-bottom: 0.5rem;
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

.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--border-primary);
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
  
  .user-avatar {
    width: 40px;
    height: 40px;
  }
  
  .visibility-button span {
    display: none;
  }
}
</style>
