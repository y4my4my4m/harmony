<!-- Composer Component - Unified ActivityPub post/reply composer -->
<!-- Supports both modal and inline modes, new posts and replies -->
<template>
  <component :is="wrapperComponent" v-bind="wrapperProps">
    <div :class="composerClasses" @click.self="handleOverlayClick">
      <div :class="contentClasses">
        <!-- Header (hidden for inline replies) -->
        <div v-if="!(mode === 'inline' && type === 'reply')" class="composer-header">
          <h2 class="composer-title">
            {{ headerTitle }}
          </h2>
          <button v-if="mode === 'modal'" class="close-button" @click="handleClose">
            <Icon name="x" />
          </button>
        </div>

        <!-- Reply Context (for modal replies only) -->
        <div v-if="type === 'reply' && replyToPost && mode === 'modal'" class="reply-context">
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

        <!-- Quote Post Preview (for quote posts) -->
        <div v-if="type === 'quote' && quotePost" class="quote-preview-section">
          <div class="quote-preview-header">
            <Icon name="edit" :size="16" />
            <span>Quoting</span>
          </div>
          <div class="quote-preview">
            <Avatar 
              :src="quoteAuthor?.avatar_url || quotePost.author?.avatar_url"
              :alt="quoteAuthor?.display_name || quotePost.author?.display_name"
              size="sm"
              :interactive="true"
            />
            <div class="quote-content">
              <div class="quote-author">
                <span class="author-name">{{ quoteAuthor?.display_name || quotePost.author?.display_name }}</span>
                <span class="author-handle">@{{ quoteAuthor?.username || quotePost.author?.username }}</span>
              </div>
              <div class="quote-text">
                <MonyContent :content="quotePost.content" :truncate="3" />
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
              :size="mode === 'inline' && type === 'reply' ? 'sm' : 'md'"
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
            <div 
              class="text-input-container"
              :class="{ 'is-dragging': isDragging }"
              @dragenter.prevent="handleDragEnter"
              @dragover.prevent="handleDragOver"
              @dragleave.prevent="handleDragLeave"
              @drop.prevent="handleDrop"
            >
              <RichTextEditor
                ref="richEditorRef"
                :model-value="content"
                :placeholder="placeholder"
                :max-height="200"
                :min-height="60"
                @update:model-value="handleContentUpdate"
                @keydown="handleKeydown"
                @cursor-position-changed="handleCursorPositionChanged"
                @paste="actions.handlePaste"
              />
              
              <!-- Drag & Drop Overlay -->
              <div v-if="isDragging" class="drag-drop-overlay">
                <Icon name="upload" :size="32" />
                <span>Drop images or videos here</span>
              </div>
              
              <!-- Character Counter -->
              <div class="character-counter" :class="characterCounterClass">
                {{ remainingCharacters }}
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
              v-if="mediaAttachments.length > 0"
              :attachments="mediaAttachments"
              @remove="removeMediaAttachment"
              @update-description="(index, desc) => {
                if (mediaAttachments[index]) {
                  mediaAttachments[index].description = desc;
                }
              }"
            />

            <!-- Compose Options Toolbar -->
            <div class="compose-options">
              <!-- Left: Toolbar Buttons -->
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
                  :disabled="!canAddMedia"
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
                
                <!-- Visibility Selector -->
                <div class="visibility-selector">
                  <button
                    class="option-button"
                    @click.stop="toggleVisibilityMenu"
                    :title="visibilityOptions.find(v => v.value === visibility)?.label"
                  >
                    <Icon :name="visibilityOptions.find(v => v.value === visibility)?.icon || 'globe'" />
                  </button>

                  <div v-if="showVisibilityMenu" class="visibility-menu" v-click-outside="closeVisibilityMenu">
                    <button
                      v-for="option in visibilityOptions"
                      :key="option.value"
                      class="visibility-option"
                      :class="{ active: visibility === option.value }"
                      @click.stop="setVisibility(option.value)"
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
              
              <!-- Right: Action Buttons -->
              <div class="action-group">
                <!-- Draft Indicator -->
                <span v-if="isDraft" class="draft-indicator">
                  <Icon name="save" />
                  Draft saved
                </span>
                
                <!-- Cancel Button (modal and inline reply) -->
                <button
                  v-if="mode === 'modal' || (mode === 'inline' && type === 'reply')"
                  class="cancel-button"
                  @click="handleClose"
                  :disabled="isPosting"
                >
                  Cancel
                </button>
                
                <!-- Submit Button -->
                <button
                  class="post-button"
                  :disabled="!canSubmit || isPosting"
                  @click="handleSubmit"
                >
                  <Icon v-if="isPosting" name="spinner" class="spinning" />
                  <span>{{ submitButtonText }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Emoji Picker -->
        <Teleport to="body">
          <EmojiPopup
            v-if="showEmojiPicker"
            @sendEmoji="handleEmojiInsert"
            :closeEmojiList="() => showEmojiPicker = false"
            :position="'above'"
            :triggerElement="emojiTriggerRef || undefined"
          />
        </Teleport>

        <!-- GIF Picker -->
        <Teleport to="body">
          <GifComponent
            v-if="showGiphyPicker"
            @sendGif="handleGifInsert"
            @switchToEmoji="handleSwitchToEmoji"
            :closeGiphy="() => showGiphyPicker = false"
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
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n';
import { useProfileStore } from '@/stores/useProfile';
import type { TimelinePost, Post, FederatedUser } from '@/types';

// Composables
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

// I18n
const { t } = useI18n();

// Props
interface Props {
  mode: 'modal' | 'inline';
  type: 'post' | 'reply' | 'quote';
  replyToPost?: TimelinePost;
  quotePost?: TimelinePost;
  quoteAuthor?: FederatedUser;
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
const isDragging = ref(false);

// Direct state management (no composable to avoid ref confusion)
const content = ref('');
const contentWarning = ref('');
const visibility = ref<Post['visibility']>(props.defaultVisibility || 'public');
const isSensitive = ref(false);
const showContentWarning = ref(false);
const showVisibilityMenu = ref(false);
const showEmojiPicker = ref(false);
const showGiphyPicker = ref(false);
const isDraft = ref(false);
const mediaAttachments = ref<any[]>([]);

// Constants
const characterLimit = 500;
const maxMediaAttachments = 4;

// Computed
const remainingCharacters = computed(() => characterLimit - content.value.length);
const characterCounterClass = computed(() => {
  const remaining = remainingCharacters.value;
  if (remaining < 0) return 'over-limit';
  if (remaining < 20) return 'warning';
  return '';
});
const canSubmit = computed(() => {
  const hasContent = content.value.trim().length > 0 || mediaAttachments.value.length > 0;
  const withinLimit = content.value.length <= characterLimit;
  return hasContent && withinLimit;
});
const canAddMedia = computed(() => mediaAttachments.value.length < maxMediaAttachments);

const visibilityOptions = [
  { value: 'public' as const, label: t('activitypub.public'), description: t('activitypub.visibleToEveryone'), icon: 'globe' },
  { value: 'unlisted' as const, label: t('activitypub.unlisted'), description: t('activitypub.notShownInPublicTimelines'), icon: 'unlock' },
  { value: 'followers' as const, label: t('activitypub.followers'), description: t('activitypub.onlyVisibleToFollowers'), icon: 'users' },
  { value: 'direct' as const, label: t('activitypub.direct'), description: t('activitypub.onlyMentionedUsers'), icon: 'mail' }
];

// AutoSuggest setup
const getCurrentText = () => content.value || '';
const updateText = (newText: string) => {
  content.value = newText;
};
const autoSuggest = useAutoSuggest(richEditorRef, getCurrentText, updateText, {
  mode: 'activitypub',
  enableEmojis: true,
  enableMentions: true,
  maxSuggestions: 10
});

// Actions using composable
const actions = useComposerActions({
  content,
  richEditorRef,
  showEmojiPicker,
  showGiphyPicker,
  mediaAttachments,
  canAddMedia,
  onContentUpdate: (newContent) => {
    content.value = newContent;
  }
});

// Computed
const currentUser = computed(() => profileStore.profile);

const placeholder = computed(() => {
  if (props.type === 'reply') {
    return t('activitypub.whatsYourReply');
  }
  if (props.type === 'quote') {
    return 'Add a comment...';
  }
  return t('activitypub.whatsHappeningInMonyverse');
});

const headerTitle = computed(() => {
  if (props.type === 'reply') {
    return t('activitypub.replyToMony');
  }
  if (props.type === 'quote') {
    return 'Quote Post';
  }
  return t('activitypub.createAMony');
});

const submitButtonText = computed(() => {
  if (isPosting.value) {
    if (props.type === 'reply') return t('activitypub.replying');
    if (props.type === 'quote') return 'Quoting...';
    return t('activitypub.posting');
  }
  if (props.type === 'reply') return t('activitypub.reply');
  if (props.type === 'quote') return 'Quote';
  return t('activitypub.mony');
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
  content.value = newContent;
};

const handleCursorPositionChanged = (position: number) => {
  if (richEditorRef.value) {
    autoSuggest.handleInput(content.value, position);
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
    if (canSubmit.value) {
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

// Drag and drop handlers
const handleDragEnter = (event: DragEvent) => {
  event.preventDefault();
  // Only show overlay for image/video files
  const items = event.dataTransfer?.items;
  if (items) {
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/') || item.type.startsWith('video/')) {
        isDragging.value = true;
        break;
      }
    }
  }
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
  if (!files || files.length === 0) return;

  // Filter for images and videos only
  const mediaFiles = Array.from(files).filter(
    file => file.type.startsWith('image/') || file.type.startsWith('video/')
  );

  if (mediaFiles.length === 0) {
    debug.warn('Only images and videos can be dropped');
    return;
  }

  // Create mock event for handleFileUpload
  const mockEvent = {
    target: {
      files: mediaFiles,
      value: ''
    }
  } as any;

  await actions.handleFileUpload(mockEvent);
};

const setVisibility = (newVisibility: Post['visibility']) => {
  visibility.value = newVisibility;
  showVisibilityMenu.value = false;
};

const toggleContentWarning = () => {
  showContentWarning.value = !showContentWarning.value;
  if (!showContentWarning.value) {
    contentWarning.value = '';
  }
};

const removeMediaAttachment = (index: number) => {
  const media = mediaAttachments.value[index];
  if (media.url?.startsWith('blob:')) {
    URL.revokeObjectURL(media.url);
  }
  mediaAttachments.value.splice(index, 1);
};

const closeVisibilityMenu = () => {
  showVisibilityMenu.value = false;
};

const toggleVisibilityMenu = () => {
  showEmojiPicker.value = false;
  showGiphyPicker.value = false;
  showVisibilityMenu.value = !showVisibilityMenu.value;
};

const toggleEmojiPicker = () => {
  const wasOpen = showEmojiPicker.value;
  showVisibilityMenu.value = false;
  showGiphyPicker.value = false;
  showEmojiPicker.value = !wasOpen;
};

const toggleGifPicker = () => {
  const wasOpen = showGiphyPicker.value;
  showVisibilityMenu.value = false;
  showEmojiPicker.value = false;
  showGiphyPicker.value = !wasOpen;
};

const handleSwitchToEmoji = () => {
  showGiphyPicker.value = false;
  showEmojiPicker.value = true;
};

const handleOverlayClick = () => {
  if (props.mode === 'modal') {
    handleClose();
  }
};

const handleEmojiInsert = (emoji: any) => {
  actions.insertEmoji(emoji);
  showEmojiPicker.value = false;
};

const handleGifInsert = (gif: any) => {
  actions.insertGif(gif);
  showGiphyPicker.value = false;
};

const handleClose = () => {
  // Close all pickers
  showEmojiPicker.value = false;
  showGiphyPicker.value = false;
  showVisibilityMenu.value = false;
  
  if (content.value.trim() && !isPosting.value) {
    // Save as draft
    isDraft.value = true;
    setTimeout(() => {
      isDraft.value = false;
    }, 2000);
  }
  emit('close');
};

const resetComposer = () => {
  content.value = '';
  contentWarning.value = '';
  visibility.value = props.defaultVisibility || 'public';
  isSensitive.value = false;
  showContentWarning.value = false;
  showVisibilityMenu.value = false;
  showEmojiPicker.value = false;
  showGiphyPicker.value = false;
  isDraft.value = false;
  
  mediaAttachments.value.forEach(media => {
    if (media.url?.startsWith('blob:')) {
      URL.revokeObjectURL(media.url);
    }
  });
  mediaAttachments.value = [];
};

const handleSubmit = async () => {
  if (!canSubmit.value || isPosting.value) return;

  isPosting.value = true;
  
  try {
    let post;
    
    if (props.type === 'quote' && props.quotePost) {
      // Create a quote reblog using the activityPubService
      const { activityPubService } = await import('@/services/activityPubService');
      post = await activityPubService.createQuoteReblog(
        props.quotePost.id,
        content.value, // User's comment
        visibility.value,
        contentWarning.value,
        isSensitive.value
      );
    } else {
      // Regular post or reply
      post = await actions.submitPost(
        visibility.value,
        contentWarning.value,
        isSensitive.value,
        props.type === 'reply' ? props.replyToPost?.id : undefined
      );
    }

    // Reset state
    resetComposer();
    
    // Emit success
    emit('posted', post);
    emit('close');
  } catch (error) {
    debug.error('Failed to create post:', error);
    // TODO: Show error toast
  } finally {
    isPosting.value = false;
  }
};

// Lifecycle
onMounted(() => {
  // Pre-populate mention for replies
  if (props.type === 'reply' && props.replyToPost?.author) {
    const author = props.replyToPost.author;
    const username = author.username || '';
    const domain = author.domain || '';
    const isLocal = author.is_local !== false;
    
    const mention = (!isLocal && domain)
      ? `@${username}@${domain} `
      : `@${username} `;
    content.value = mention;
  }

  // Focus editor after mount and move cursor to end
  nextTick(() => {
    if (props.mode === 'modal' || props.type === 'reply') {
      richEditorRef.value?.focus();
      // Move cursor to end of content (after the @mention and space)
      if (content.value.length > 0) {
        nextTick(() => {
          richEditorRef.value?.setCursorPosition(content.value.length);
        });
      }
    }
  });
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
  if (props.type === 'reply' && replyPost?.author && content.value === '') {
    const author = replyPost.author;
    const username = author.username || '';
    const domain = author.domain || '';
    const isLocal = author.is_local !== false;
    
    const mention = (!isLocal && domain)
      ? `@${username}@${domain} `
      : `@${username} `;
    content.value = mention;
    
    nextTick(() => {
      richEditorRef.value?.focus();
      // Move cursor to end of content (after the @mention and space)
      nextTick(() => {
        richEditorRef.value?.setCursorPosition(content.value.length);
      });
    });
  }
});

// Click outside directive
const vClickOutside = {
  mounted(el: HTMLElement & { _clickOutsideHandler?: (event: Event) => void }, binding: any) {
    el._clickOutsideHandler = (event: Event) => {
      if (!(el === event.target || el.contains(event.target as Node))) {
        binding.value();
      }
    };
    document.addEventListener('click', el._clickOutsideHandler);
  },
  unmounted(el: HTMLElement & { _clickOutsideHandler?: (event: Event) => void }) {
    if (el._clickOutsideHandler) {
      document.removeEventListener('click', el._clickOutsideHandler);
    }
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
  border: 1px solid var(--background-tertiary-alpha);
  border-radius: 12px;
  border-top-left-radius: 0;
  border-top-right-radius: 0;
  border-top: 0;
  background-color: var(--background-primary);
  padding: 1rem;
  transition: all 0.2s ease;
}

/* Header */
.composer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem 1.5rem 1rem;
  border-bottom: 1px solid var(--border-primary);
  margin-bottom: 1rem;
}

.composer-inline-content .composer-header {
  display: none;
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

/* Quote Preview */
.quote-preview-section {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--border-primary);
}

.quote-preview-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #10b981;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.75rem;
}

.quote-preview {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  background: var(--background-tertiary, #1f1f1f);
  border-radius: 8px;
  border: 1px solid var(--border-primary);
}

.quote-content {
  flex: 1;
  min-width: 0;
}

.quote-author {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.quote-text {
  color: #d1d5db;
  font-size: 0.8125rem;
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

/* Composer Body */
.composer-body {
  display: flex;
  gap: 0.75rem;
  padding: 1.5rem;
  margin-bottom: 0;
}

.composer-inline-content .composer-body {
  padding: 0;
  gap: 0.5rem;
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
  margin-bottom: 0.75rem;
}

.composer-inline-content .content-warning-input {
  margin-bottom: 0.5rem;
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
  margin-bottom: 0.5rem;
}

.composer-inline-content .text-input-container {
  margin-bottom: 0.75rem;
}

.text-input-container.is-dragging {
  border: 2px dashed var(--harmony-primary);
  border-radius: 0.5rem;
  background-color: rgba(88, 101, 242, 0.05);
}

.drag-drop-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  background-color: rgba(0, 0, 0, 0.8);
  border-radius: 0.5rem;
  color: white;
  font-weight: 500;
  pointer-events: none;
  z-index: 10;
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
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.composer-inline-content .compose-options {
  padding-top: 0.75rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  margin-top: 0.75rem;
}

.option-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.action-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.draft-indicator {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  color: #10b981;
  font-size: 0.75rem;
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

/* Footer - removed, merged with compose-options */

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
  .composer-user {
    position: absolute;
  }

  .text-input-container {
    padding-left: 48px;
  }
  .text-input-container .rich-text-editor {
    overflow-y: auto !important;
    height: auto !important;
  }
}
</style>

