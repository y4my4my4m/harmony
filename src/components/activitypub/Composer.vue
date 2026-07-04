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
        <!-- Bound to `effectiveReplyToPost` so reblog wrappers show the
             original author / content in the preview, matching what the
             submitted reply will actually target. -->
        <div v-if="type === 'reply' && effectiveReplyToPost && mode === 'modal'" class="reply-context">
          <div class="reply-thread-line"></div>
          <div class="reply-to-post">
            <Avatar 
              :src="effectiveReplyToPost.author?.avatar_url"
              :alt="effectiveReplyToPost.author?.display_name || effectiveReplyToPost.author?.username"
              size="md"
              :interactive="true"
            />
            <div class="reply-content">
              <div class="reply-author">
                <span class="author-name">{{ effectiveReplyToPost.author?.display_name }}</span>
                <span class="author-handle">{{ effectiveReplyToPost.author?.handle }}</span>
              </div>
              <div class="reply-text">
                <MonyContent :content="effectiveReplyToPost.content" :truncate="3" />
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
        <div class="composer-body" data-testid="compose-post">
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
                :bordered="mode === 'inline'"
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
                  
                  <!-- User Suggestion (display name with resolved emojis when we have profile id) -->
                  <div v-else class="suggest-item-content">
                    <Avatar 
                      v-if="suggestion.avatar || suggestion.avatar_url" 
                      :src="suggestion.avatar || suggestion.avatar_url" 
                      :alt="suggestion.display_name || suggestion.username"
                      class="suggest-icon"
                      size="sm"
                    />
                    <div class="suggest-text">
                      <span class="suggest-name">
                        <DisplayName
                          v-if="suggestion.id"
                          :userId="suggestion.id"
                          :fallback="suggestion.display_name || suggestion.username"
                        />
                        <template v-else>{{ suggestion.display_name || suggestion.username }}</template>
                      </span>
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
                <!-- Character Counter -->
                <span class="character-counter" :class="characterCounterClass">
                  {{ remainingCharacters }}
                </span>

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
                  data-testid="compose-submit"
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

        <!-- Unified Media Picker (GIFs + Emoji) -->
        <Teleport to="body">
          <MediaPickerPopup
            v-if="showMediaPicker"
            @sendGif="handleGifInsert"
            @sendEmoji="handleEmojiInsert"
            :closePopup="() => showMediaPicker = false"
            :position="'above'"
            :triggerElement="(mediaPickerTriggerRef as unknown as HTMLElement | null) || undefined"
            :initialTab="mediaPickerInitialTab"
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
import { useToast } from 'vue-toastification';
import { useProfileStore } from '@/stores/useProfile';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
import type { TimelinePost, Post, FederatedUser, ActivityPubPost, PostAuthor } from '@/types';

// Composables
import { useComposerActions } from '@/composables/useComposerActions';
import { useAutoSuggest } from '@/composables/useAutoSuggest';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';

// Utils
import { getOriginalPost, getOriginalPostId, getReplyMentionAuthor } from '@/utils/postReblog';

// Components
import MonyContent from './MonyContent.vue';
import MonyMediaUpload from './MonyMediaUpload.vue';
import MediaPickerPopup from '@/components/MediaPickerPopup.vue';
import GifIcon from '@/components/icons/Gif.vue';
import EmojiUI from '@/components/EmojiUI.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '../common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';
import AutoSuggest from '@/components/AutoSuggest.vue';
import RichTextEditor from '@/components/RichTextEditor.vue';

// I18n
const { t } = useI18n();
const toast = useToast();

// Props
interface Props {
  mode: 'modal' | 'inline';
  type: 'post' | 'reply' | 'quote' | 'edit';
  replyToPost?: TimelinePost;
  // Quoting a reblog targets the inner post - a bare ActivityPubPost without
  // the enhanced interaction fields (matches PostComposerState).
  quotePost?: TimelinePost | ActivityPubPost;
  quoteAuthor?: FederatedUser | PostAuthor;
  editPost?: TimelinePost;
  isOpen?: boolean;
  defaultVisibility?: Post['visibility'];
  initialContent?: string;
}

const props = withDefaults(defineProps<Props>(), {
  isOpen: true,
  defaultVisibility: 'public',
  initialContent: ''
});

// Emits
const emit = defineEmits<{
  close: [];
  posted: [post: any];
  edited: [post: any];
}>();

const profileStore = useProfileStore();
const instanceSettings = useInstanceSettingsStore();

// Refs
const richEditorRef = ref<InstanceType<typeof RichTextEditor>>();
const fileInputRef = ref<HTMLInputElement>();
const emojiTriggerRef = ref<HTMLElement | null>(null);
const gifTriggerRef = ref<HTMLElement | null>(null);
const mediaPickerTriggerRef = computed(() => gifTriggerRef.value || emojiTriggerRef.value);
const isPosting = ref(false);
const isDragging = ref(false);

// Direct state management (no composable to avoid ref confusion)
const content = ref('');
const contentWarning = ref('');
const visibility = ref<Post['visibility']>(props.defaultVisibility || 'public');
const isSensitive = ref(false);
const showContentWarning = ref(false);
const showVisibilityMenu = ref(false);
const showMediaPicker = ref(false);
const mediaPickerInitialTab = ref<'gifs' | 'emoji'>('gifs');

// Legacy computed for compatibility
const showEmojiPicker = computed(() => showMediaPicker.value && mediaPickerInitialTab.value === 'emoji');
const showGiphyPicker = computed(() => showMediaPicker.value && mediaPickerInitialTab.value === 'gifs');
const isDraft = ref(false);
const mediaAttachments = ref<any[]>([]);

// Constants
const characterLimit = 500;

// Computed
const maxMediaAttachments = computed(() => instanceSettings.settings.maxMediaAttachmentsPerPost ?? 20);

// For reblog targets, the actual reply-to is the original post, not the
// Announce wrapper. Used by the modal preview block above so the displayed
// author/content matches what the submitted reply will thread under.
const effectiveReplyToPost = computed(() =>
  props.replyToPost ? getOriginalPost(props.replyToPost) : undefined
);

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
const canAddMedia = computed(() => mediaAttachments.value.length < maxMediaAttachments.value);

const visibilityOptions = [
  { value: 'public' as const, label: t('activitypub.public'), description: t('activitypub.visibleToEveryone'), icon: 'globe' },
  { value: 'unlisted' as const, label: t('activitypub.unlisted'), description: t('activitypub.notShownInPublicTimelines'), icon: 'unlock' },
  { value: 'followers' as const, label: t('activitypub.followers'), description: t('activitypub.onlyVisibleToFollowers'), icon: 'users' },
  { value: 'direct' as const, label: t('activitypub.direct'), description: t('activitypub.onlyMentionedUsers'), icon: 'mail' }
];

// AutoSuggest setup
const getCurrentText = () => content.value || '';
const updateText = (newText: string, cursorPosition?: number) => {
  if (cursorPosition !== undefined && richEditorRef.value) {
    debug.log('🔧 Composer updateText:', { newText, cursorPosition });
    richEditorRef.value.skipNextWatch = true;

    content.value = newText;

    nextTick(() => {
      if (richEditorRef.value?.renderContent) {
        richEditorRef.value.renderContent(newText, true);
      }

      nextTick(() => {
        if (richEditorRef.value) {
          // Mention display normalization (e.g. @user@localhost → @user for local)
          // can shorten the rendered text vs. the raw text. Recalculate cursor
          // position by anchoring from the end: the suffix after the cursor is
          // unaffected by mention rendering, so we can subtract it from the
          // rendered length to find the correct cursor position.
          const renderedText = richEditorRef.value.getPlainText?.() || '';
          const suffixLen = newText.length - cursorPosition;
          const adjustedCursor = Math.max(0, renderedText.length - suffixLen);
          debug.log('🔧 Composer cursor adjustment:', {
            rawLen: newText.length, renderedLen: renderedText.length,
            rawCursor: cursorPosition, adjustedCursor
          });

          richEditorRef.value.focus();
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              richEditorRef.value?.setCursorPosition(adjustedCursor);
            });
          });
        }
      });
    });
  } else {
    content.value = newText;
  }
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
  if (props.type === 'edit') {
    return t('activitypub.editYourPost');
  }
  return t('activitypub.whatsHappeningInFediverse');
});

const headerTitle = computed(() => {
  if (props.type === 'reply') {
    return t('activitypub.replyToPost');
  }
  if (props.type === 'quote') {
    return t('activitypub.quotePost');
  }
  if (props.type === 'edit') {
    return t('activitypub.editPost');
  }
  return t('activitypub.createAPost');
});

const submitButtonText = computed(() => {
  if (isPosting.value) {
    if (props.type === 'reply') return t('activitypub.replying');
    if (props.type === 'quote') return t('activitypub.quoting');
    if (props.type === 'edit') return t('activitypub.saving');
    return t('activitypub.posting');
  }
  if (props.type === 'reply') return t('activitypub.reply');
  if (props.type === 'quote') return t('activitypub.quote');
  if (props.type === 'edit') return t('activitypub.save');
  return t('activitypub.post');
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
    // Use getPlainText from editor when available - ensures we have DOM state including
    // mention spans (content.value can lag when typing after inserted mentions)
    const text = typeof richEditorRef.value.getPlainText === 'function'
      ? richEditorRef.value.getPlainText()
      : content.value;
    autoSuggest.handleInput(text ?? '', position);
  }
};

const handleSuggestionSelect = (suggestion: SuggestionItem) => {
  autoSuggest.selectSuggestion(suggestion);
};

const handleKeydown = (event: KeyboardEvent) => {
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

  const mediaFiles = Array.from(files).filter(
    file => file.type.startsWith('image/') || file.type.startsWith('video/')
  );

  if (mediaFiles.length === 0) {
    debug.warn('Only images and videos can be dropped');
    return;
  }

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
  showMediaPicker.value = false;
  showVisibilityMenu.value = !showVisibilityMenu.value;
};

const toggleEmojiPicker = () => {
  showVisibilityMenu.value = false;
  mediaPickerInitialTab.value = 'emoji';
  showMediaPicker.value = !showMediaPicker.value;
};

const toggleGifPicker = () => {
  showVisibilityMenu.value = false;
  mediaPickerInitialTab.value = 'gifs';
  showMediaPicker.value = !showMediaPicker.value;
};

const handleOverlayClick = () => {
  if (props.mode === 'modal') {
    handleClose();
  }
};

const handleEmojiInsert = (emoji: any) => {
  actions.insertEmoji(emoji);
  showMediaPicker.value = false;
};

const handleGifInsert = (gif: any) => {
  actions.insertGif(gif);
  showMediaPicker.value = false;
};

const handleClose = () => {
  showMediaPicker.value = false;
  showVisibilityMenu.value = false;
  
  if (content.value.trim() && !isPosting.value) {
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
  showMediaPicker.value = false;
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
    
    if (props.type === 'edit' && props.editPost) {
      post = await actions.updatePost(
        props.editPost.id,
        contentWarning.value,
        isSensitive.value
      );
      resetComposer();
      emit('edited', post);
      emit('close');
      return;
    }

    if (props.type === 'quote' && props.quotePost) {
      const { activityPubService } = await import('@/services/activityPubService');
      post = await activityPubService.createQuoteReblog(
        props.quotePost.id,
        content.value,
        visibility.value,
        contentWarning.value,
        isSensitive.value
      );
    } else {
      // For reblogs, thread the reply under the *original* post - never under
      // the Announce wrapper. Callers should already pass the unwrapped post,
      // but unwrap defensively here so future call sites can't regress this.
      const replyToId = props.type === 'reply' && props.replyToPost
        ? getOriginalPostId(props.replyToPost)
        : undefined;
      post = await actions.submitPost(
        visibility.value,
        contentWarning.value,
        isSensitive.value,
        replyToId
      );
    }

    resetComposer();
    emit('posted', post);
    emit('close');
  } catch (error: any) {
    debug.error('Failed to create post:', error);
    // Surface failures as a toast rather than inline text that would shove the
    // action buttons around / overflow the toolbar. Content is preserved since
    // we don't reset the composer on error.
    toast.error(error?.message || t('activitypub.failedToSendPost'));
  } finally {
    isPosting.value = false;
  }
};

/**
 * Convert MessagePart[] from a post's content back to raw text for editing.
 */
function messagePartsToRawText(parts: any[]): string {
  if (!Array.isArray(parts)) return typeof parts === 'string' ? parts : '';
  return parts.map((part: any) => {
    switch (part.type) {
      case 'text': return part.text || '';
      case 'url': return part.url || '';
      case 'mention': {
        if (!part.isLocal && part.domain) return `@${part.username}@${part.domain}`;
        return `@${part.username}`;
      }
      case 'emoji': return `:${part.emoji?.name || 'emoji'}:`;
      case 'hashtag': return `#${part.name}`;
      default: return '';
    }
  }).join('');
}

// Lifecycle
onMounted(() => {
  if (props.type === 'edit' && props.editPost) {
    content.value = messagePartsToRawText(props.editPost.content);
    contentWarning.value = props.editPost.content_warning || '';
    isSensitive.value = props.editPost.is_sensitive || false;
    visibility.value = props.editPost.visibility || props.defaultVisibility || 'public';
    showContentWarning.value = !!contentWarning.value;
    if (props.editPost.media_attachments?.length) {
      mediaAttachments.value = props.editPost.media_attachments.map((m: any) => ({
        id: m.id || m.url,
        type: m.type || 'image',
        url: m.url,
        preview_url: m.preview_url || m.url,
        filename: m.filename,
        description: m.description,
      }));
    }
  } else if (props.type === 'reply' && props.replyToPost) {
    // Mention whichever author the reply should reach. `getReplyMentionAuthor`
    // returns the original post's author for pure reblogs, the quoter for
    // quote posts, and `undefined` for unhydrated reblogs (so we skip the
    // prefill rather than mention the booster, which would mislead the user).
    const author = getReplyMentionAuthor(props.replyToPost);
    if (author) {
      const username = author.username || '';
      const domain = author.domain || '';
      const isLocal = author.is_local !== false;

      const mention = (!isLocal && domain)
        ? `@${username}@${domain} `
        : `@${username} `;
      content.value = mention;
    }
  } else if (props.type === 'post' && props.initialContent?.trim()) {
    content.value = props.initialContent;
  }

  nextTick(() => {
    if (props.mode === 'modal' || props.type === 'reply' || props.type === 'edit') {
      richEditorRef.value?.focus();
      if (content.value.length > 0) {
        nextTick(() => {
          richEditorRef.value?.setCursorPosition(content.value.length);
        });
      }
    }
  });
});

// Watch for modal open state and initial content
watch(() => props.isOpen, (isOpen) => {
  if (isOpen && props.mode === 'modal') {
    nextTick(() => {
      richEditorRef.value?.focus();
    });
  }
});

watch(() => props.initialContent, (val) => {
  if (props.type === 'post' && val?.trim()) {
    content.value = val;
    nextTick(() => richEditorRef.value?.setCursorPosition(content.value.length));
  }
}, { immediate: true });

// Watch for reply context changes (when opening reply composer)
watch(() => props.replyToPost, (replyPost) => {
  if (props.type === 'reply' && replyPost && content.value === '') {
    // Same routing rule as onMounted - pure reblog → original author,
    // quote → quoter, unhydrated reblog → no prefill.
    const author = getReplyMentionAuthor(replyPost);
    if (!author) return;
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
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
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
  border: 1px solid var(--border-secondary, var(--border-color));
  border-radius: 12px;
  background-color: var(--background-primary);
  box-shadow: 0 2px 5px 5px #00000011;
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
  color: var(--text-primary);
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
  color: var(--text-primary);
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
  color: var(--text-primary);
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
  padding-right: 8px;
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
  color: var(--text-primary);
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
  background-color: rgba(14, 165, 233, 0.05);
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
  color: var(--text-primary);
  font-weight: 500;
  pointer-events: none;
  z-index: 10;
}

.character-counter {
  font-size: 0.8125rem;
  color: #9ca3af;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  user-select: none;
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
/* 
.composer-inline-content .compose-options {
  padding-top: 0.75rem;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  margin-top: 0.75rem;
} */

.option-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.action-group {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
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
  background-color: var(--background-tertiary, #374151);
  color: var(--text-primary);
}

.option-button.active {
  color: var(--harmony-primary, #2563eb);
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
  background-color: var(--background-primary);
  border: 1px solid var(--border-primary);
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
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  border-radius: 0.5rem;
  transition: all 0.2s;
}

.visibility-option:hover {
  background-color: var(--background-tertiary);
}

.visibility-option.active {
  background-color: var(--background-quinary);
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
  border: 1px solid var(--border-primary, #374151);
  border-radius: 0.5rem;
  color: #9ca3af;
  cursor: pointer;
  transition: all 0.2s;
}

.cancel-button:hover {
  background-color: var(--background-tertiary, #374151);
  color: var(--text-primary);
}

.post-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.5rem;
  background-color: var(--harmony-primary);
  border: none;
  border-radius: 0.5rem;
  color: var(--text-primary);
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
  color: var(--text-primary);
}

.suggest-username,
.suggest-domain,
.suggest-server {
  /* color: #9ca3af;
  font-size: 0.875rem;
  margin-left: 0.25rem; */
}

/* Mobile responsive */
@media (max-width: 768px) {
  /* ---------- Modal composer ---------- */
  /* Keep the modal centered over a dimmed/blurred backdrop (like our other
     modals) and just let it grow in height to fit its content, instead of
     forcing a full-screen sheet that left a huge empty gap below the input. */
  .composer-overlay {
    padding: 1rem;
    align-items: center;
  }

  .composer-modal {
    max-height: 85vh;
    height: auto;
    max-width: 100%;
    border-radius: 1rem;
    display: flex;
    flex-direction: column;
  }

  /* Header stays pinned at the top; only the body grows and scrolls once the
     content exceeds the modal's max-height. */
  .composer-modal > .composer-header {
    flex-shrink: 0;
    padding: 1rem;
    margin-bottom: 0;
  }

  .composer-modal > .composer-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 1rem;
  }

  .composer-modal .composer-user {
    padding-right: 0;
  }

  .composer-modal .text-input-container .rich-text-editor {
    overflow-y: auto !important;
    height: auto !important;
  }

  /* ---------- Inline composer ---------- */
  /* The inline card already supplies its own padding via
     .composer-inline-content, so we must NOT add the modal's body padding
     on top of it (that double padding squished the inline composer). */
  .composer-inline-content {
    padding: 0.75rem;
  }

  /* ---------- Shared toolbar behaviour ---------- */
  .visibility-button span {
    display: none;
  }

  /* One-line toolbar on mobile: action icons pinned left, counter + Post
     pinned right, never wrapping. The icon group is the flexible part - it
     shrinks and (in the worst case) scrolls horizontally, so the counter and
     the Post button always stay on the same row. */
  .compose-options {
    flex-wrap: nowrap;
    align-items: center;
    column-gap: 0.25rem;
  }

  /* Break the toolbar out of the input column so it spans the full card
     width, starting under the avatar. Offset = avatar (48px md) +
     .composer-user padding-right (8px) + .composer-body gap (0.5rem). */
  .composer-inline-content .compose-options {
    margin-left: calc(-1 * (48px + 8px + 0.5rem));
  }

  /* Inline reply variant uses the sm (40px) avatar. */
  .composer-inline-content .composer-body:has(.avatar-sm) .compose-options {
    margin-left: calc(-1 * (40px + 8px + 0.5rem));
  }

  .option-group {
    flex-wrap: nowrap;
    flex: 1 1 auto;
    min-width: 0;
    gap: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .option-group::-webkit-scrollbar {
    display: none;
  }

  .option-button {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
  }

  .action-group {
    flex: 0 0 auto;
    margin-left: auto;
    flex-wrap: nowrap;
    gap: 0.35rem;
  }

  .character-counter {
    font-size: 0.75rem;
  }

  .post-button {
    padding: 0.45rem 0.8rem;
    flex-shrink: 0;
  }

  .cancel-button {
    padding: 0.45rem 0.6rem;
    flex-shrink: 0;
  }
}
</style>

