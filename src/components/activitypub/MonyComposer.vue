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
            <img 
              :src="replyToPost.author?.avatar_url || '/default_avatar.png'"
              :alt="replyToPost.author?.display_name"
              class="reply-author-avatar"
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
            <img 
              :src="currentUser?.avatar_url || '/default_avatar.png'"
              :alt="currentUser?.display_name"
              class="user-avatar"
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
              <textarea
                ref="textareaRef"
                v-model="content"
                :placeholder="placeholder"
                class="text-input"
                :maxlength="characterLimit"
                @input="handleInput"
                @keydown="handleKeydown"
                @paste="handlePaste"
              ></textarea>
              
              <!-- Character Counter -->
              <div class="character-counter" :class="characterCounterClass">
                {{ remainingCharacters }}
              </div>
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

                <!-- Emoji Picker -->
                <button
                  class="option-button"
                  @click="showEmojiPicker = !showEmojiPicker"
                  title="Add emoji"
                >
                  <Icon name="smile" />
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
                  <Icon name="chevron-down" size="16" />
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
                    <Icon v-if="visibility === option.value" name="check" size="16" />
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
        <EmojiPopup
          v-if="showEmojiPicker"
          @sendEmoji="insertEmoji"
          :closeEmojiList="() => showEmojiPicker = false"
        />
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import type { PostComposerState, Post } from '@/types';

// Components
import MonyContent from './MonyContent.vue';
import MonyMediaUpload from './MonyMediaUpload.vue';
import EmojiPopup from '@/components/EmojiPopup.vue';
import Icon from '@/components/common/Icon.vue';

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

// Refs
const textareaRef = ref<HTMLTextAreaElement>();
const fileInputRef = ref<HTMLInputElement>();

// Local state
const content = ref('');
const contentWarning = ref('');
const visibility = ref<Post['visibility']>('public');
const mediaAttachments = ref<File[]>([]);
const isSensitive = ref(false);
const showContentWarning = ref(false);
const showEmojiPicker = ref(false);
const showVisibilityMenu = ref(false);
const isDraft = ref(false);

// Constants
const characterLimit = 500;
const maxMediaAttachments = 4;

// Computed
const currentUser = computed(() => {
  return authStore.session?.user;
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
const handleInput = () => {
  emit('update-content', content.value);
  autoResize();
};

const handleKeydown = (event: KeyboardEvent) => {
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
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto';
    textareaRef.value.style.height = textareaRef.value.scrollHeight + 'px';
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
  const textarea = textareaRef.value;
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const emojiText = `:${emoji.name}:`;
  
  content.value = content.value.substring(0, start) + emojiText + content.value.substring(end);
  
  nextTick(() => {
    textarea.setSelectionRange(start + emojiText.length, start + emojiText.length);
    textarea.focus();
    handleInput();
  });
  
  showEmojiPicker.value = false;
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
    textareaRef.value?.focus();
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
  background-color: #1f2937;
  border-radius: 1rem;
  max-width: 600px;
  width: 100%;
  max-height: 90vh;
  overflow-y: auto;
  border: 1px solid #374151;
}

.composer-modal.is-reply {
  max-width: 700px;
}

.composer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem 1.5rem 0;
  border-bottom: 1px solid #374151;
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
  background-color: #374151;
  color: white;
}

.reply-context {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #374151;
  position: relative;
}

.reply-thread-line {
  position: absolute;
  left: 3rem;
  top: 4rem;
  bottom: 0;
  width: 2px;
  background-color: #374151;
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
  background-color: #374151;
  border: 1px solid #4b5563;
  border-radius: 0.5rem;
  color: white;
  font-size: 0.875rem;
}

.cw-input::placeholder {
  color: #9ca3af;
}

.cw-input:focus {
  outline: none;
  border-color: #2563eb;
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
  border: 1px solid #374151;
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
  border-color: #2563eb;
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
  border-top: 1px solid #374151;
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
  background-color: #2563eb;
  border: none;
  border-radius: 0.5rem;
  color: white;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.post-button:hover:not(:disabled) {
  background-color: #1d4ed8;
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
