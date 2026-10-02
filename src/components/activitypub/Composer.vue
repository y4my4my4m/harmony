<!-- ActivityPub composer: modal or inline, post/reply/quote/edit. -->
<template>
  <component :is="wrapperComponent" v-bind="wrapperProps">
    <div :class="composerClasses" @click.self="handleOverlayClick">
      <div :class="contentClasses">
        <div v-if="!(mode === 'inline' && type === 'reply')" class="composer-header">
          <h2 class="composer-title">
            {{ headerTitle }}
          </h2>
          <button
            v-if="mode === 'modal'"
            type="button"
            class="close-button"
            :aria-label="t('common.close')"
            :title="t('common.close')"
            @click="handleClose"
          >
            <Icon name="x" />
          </button>
        </div>

        <!-- Bound to `effectiveReplyToPost`: reblog wrappers preview the
             original author/content, matching what the reply targets. -->
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
            <div v-if="showContentWarning" class="content-warning-input">
              <input
                v-model="contentWarning"
                type="text"
                :placeholder="t('activitypub.contentWarningPlaceholder')"
                :aria-label="t('activitypub.contentWarning')"
                class="cw-input"
                maxlength="100"
              />
            </div>

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
              
              <div v-if="isDragging" class="drag-drop-overlay">
                <Icon name="upload" :size="32" />
                <span>Drop images or videos here</span>
              </div>
              
              <AutoSuggest
                :isVisible="autoSuggest.state.value.isActive"
                :suggestions="autoSuggest.suggestions.value"
                :position="autoSuggest.state.value.position"
                :selectedIndex="autoSuggest.state.value.selectedIndex"
                :headerText="autoSuggest.headerText.value"
                @select="handleSuggestionSelect"
              >
                <template #default="{ suggestion }">
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
                  
                  <!-- User suggestion; display name resolves emojis when a profile id is known. -->
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

            <div class="compose-options">
              <div class="option-group">
                <input
                  ref="fileInputRef"
                  type="file"
                  multiple
                  accept="image/*,video/*"
                  class="hidden"
                  @change="actions.handleFileUpload"
                />
                <button
                  type="button"
                  class="option-button"
                  @click="triggerFileUpload"
                  :disabled="!canAddMedia"
                  :title="t('activitypub.addMedia')"
                  :aria-label="t('activitypub.addMedia')"
                >
                  <Icon name="image" />
                </button>

                <button
                  ref="gifTriggerRef"
                  type="button"
                  class="option-button"
                  @click="toggleGifPicker"
                  :title="t('activitypub.addGif')"
                  :aria-label="t('activitypub.addGif')"
                  :aria-expanded="showGiphyPicker"
                >
                  <GifIcon />
                </button>

                <button
                  ref="emojiTriggerRef"
                  type="button"
                  class="option-button"
                  @click="toggleEmojiPicker"
                  :title="t('activitypub.addEmoji')"
                  :aria-label="t('activitypub.addEmoji')"
                  :aria-expanded="showEmojiPicker"
                >
                  <EmojiUI />
                </button>

                <button
                  type="button"
                  class="option-button"
                  :class="{ active: showContentWarning }"
                  @click="toggleContentWarning"
                  :title="t('activitypub.contentWarning')"
                  :aria-label="t('activitypub.contentWarning')"
                  :aria-pressed="showContentWarning"
                >
                  <Icon name="alert-triangle" />
                </button>

                <button
                  v-if="mediaAttachments.length > 0"
                  type="button"
                  class="option-button"
                  :class="{ active: isSensitive }"
                  @click="isSensitive = !isSensitive"
                  :title="t('activitypub.markMediaSensitive')"
                  :aria-label="t('activitypub.markMediaSensitive')"
                  :aria-pressed="isSensitive"
                >
                  <Icon name="eye-off" />
                </button>
              </div>

              <button
                v-if="type !== 'edit'"
                ref="visibilityTriggerRef"
                type="button"
                class="visibility-chip"
                aria-haspopup="listbox"
                :aria-expanded="showVisibilityMenu"
                :aria-label="t('activitypub.visibilityLabel', { visibility: currentVisibility.label })"
                @click.stop="toggleVisibilityMenu"
              >
                <Icon :name="currentVisibility.icon" :size="14" />
                <span class="visibility-chip-label">{{ currentVisibility.label }}</span>
                <Icon name="chevron-down" :size="14" />
              </button>

              <div class="action-group">
                <span
                  v-if="charactersUsed > 0"
                  class="character-counter"
                  :class="characterCounterClass"
                  role="status"
                  :aria-label="t('activitypub.charactersRemaining', { count: remainingCharacters })"
                >
                  <svg class="counter-ring" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                    <circle class="counter-track" cx="12" cy="12" r="10" />
                    <circle
                      class="counter-progress"
                      cx="12"
                      cy="12"
                      r="10"
                      :stroke-dasharray="COUNTER_CIRCUMFERENCE"
                      :stroke-dashoffset="counterDashOffset"
                    />
                  </svg>
                  <span v-if="remainingCharacters <= COUNTER_NUMBER_THRESHOLD" class="counter-number" aria-hidden="true">
                    {{ remainingCharacters }}
                  </span>
                </span>

                <span v-if="isDraft" class="draft-indicator">
                  <Icon name="save" />
                  {{ t('activitypub.draftSaved') }}
                </span>
                
                <button
                  v-if="mode === 'modal' || (mode === 'inline' && type === 'reply')"
                  type="button"
                  class="cancel-button"
                  @click="handleClose"
                  :disabled="isPosting"
                >
                  {{ t('common.cancel') }}
                </button>

                <button
                  type="button"
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

        <Teleport to="body">
          <div
            v-if="showVisibilityMenu"
            v-click-outside="closeVisibilityMenu"
            class="composer-visibility-menu"
            role="listbox"
            :aria-label="t('activitypub.postVisibility')"
            :style="visibilityMenuStyle"
            @keydown.esc="closeVisibilityMenu"
          >
            <button
              v-for="option in visibilityOptions"
              :key="option.value"
              type="button"
              role="option"
              :aria-selected="visibility === option.value"
              class="visibility-option"
              :class="{ active: visibility === option.value }"
              @click.stop="setVisibility(option.value)"
            >
              <Icon :name="option.icon" :size="18" />
              <span class="option-details">
                <span class="option-label">{{ option.label }}</span>
                <span class="option-description">{{ option.description }}</span>
              </span>
              <Icon v-if="visibility === option.value" name="check" :size="16" />
            </button>
          </div>
        </Teleport>

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

import { useComposerActions } from '@/composables/useComposerActions';
import { useAutoSuggest } from '@/composables/useAutoSuggest';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';

import { getOriginalPost, getOriginalPostId, getReplyMentionAuthor } from '@/utils/postReblog';
import { messagePartsToRawText } from '@/utils/messageContentUtils';

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
import { useFileDragOverlay } from '@/composables/useFileDragOverlay';

const { t } = useI18n();
const toast = useToast();

interface Props {
  mode: 'modal' | 'inline';
  type: 'post' | 'reply' | 'quote' | 'edit';
  replyToPost?: TimelinePost;
  // Quoting a reblog targets the inner post: a bare ActivityPubPost without
  // the enhanced interaction fields. Matches PostComposerState.
  quotePost?: TimelinePost | ActivityPubPost;
  quoteAuthor?: FederatedUser | PostAuthor;
  editPost?: TimelinePost;
  isOpen?: boolean;
  defaultVisibility?: Post['visibility'];
  initialContent?: string;
  initialContentWarning?: string;
  initialSensitive?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  isOpen: true,
  defaultVisibility: 'public',
  initialContent: ''
});

const emit = defineEmits<{
  close: [];
  posted: [post: any];
  edited: [post: any];
}>();

const profileStore = useProfileStore();
const instanceSettings = useInstanceSettingsStore();

const richEditorRef = ref<InstanceType<typeof RichTextEditor>>();
const fileInputRef = ref<HTMLInputElement>();
const visibilityTriggerRef = ref<HTMLElement | null>(null);
const visibilityMenuStyle = ref<Record<string, string>>({});
const emojiTriggerRef = ref<HTMLElement | null>(null);
const gifTriggerRef = ref<HTMLElement | null>(null);
const mediaPickerTriggerRef = computed(() => gifTriggerRef.value || emojiTriggerRef.value);
const isPosting = ref(false);
const {
  visible: isDragging,
  onDragEnter: handleDragEnter,
  onDragOver: handleDragOver,
  onDragLeave: handleDragLeave,
  reset: resetDragging,
} = useFileDragOverlay((dt) =>
  Array.from(dt.items || []).some(
    (item) => item.type.startsWith('image/') || item.type.startsWith('video/'),
  ),
);

// State is held locally, not in a composable.
const content = ref('');
const contentWarning = ref('');
const visibility = ref<Post['visibility']>(props.defaultVisibility || 'public');
const isSensitive = ref(false);
const showContentWarning = ref(false);
const showVisibilityMenu = ref(false);
const showMediaPicker = ref(false);
const mediaPickerInitialTab = ref<'gifs' | 'emoji'>('gifs');

// Legacy flags derived from the unified media picker state.
const showEmojiPicker = computed(() => showMediaPicker.value && mediaPickerInitialTab.value === 'emoji');
const showGiphyPicker = computed(() => showMediaPicker.value && mediaPickerInitialTab.value === 'gifs');
const isDraft = ref(false);
const mediaAttachments = ref<any[]>([]);

// Instance `max_post_length`; the server enforces the same limit on body text.
const characterLimit = computed(() => instanceSettings.settings.maxPostLength || 500);

// Counter ring geometry (r = 10) and the remaining count at which the number appears.
const COUNTER_CIRCUMFERENCE = 2 * Math.PI * 10;
const COUNTER_NUMBER_THRESHOLD = 20;

const maxMediaAttachments = computed(() => instanceSettings.settings.maxMediaAttachmentsPerPost ?? 20);

// For reblog targets the reply-to is the original post, not the Announce
// wrapper. Drives the modal preview so the displayed author/content matches
// what the reply threads under.
const effectiveReplyToPost = computed(() =>
  props.replyToPost ? getOriginalPost(props.replyToPost) : undefined
);

// The content warning counts toward the limit, as on Mastodon.
const charactersUsed = computed(() =>
  content.value.length + (showContentWarning.value ? contentWarning.value.length : 0)
);
const remainingCharacters = computed(() => characterLimit.value - charactersUsed.value);
const characterCounterClass = computed(() => {
  const remaining = remainingCharacters.value;
  if (remaining < 0) return 'over-limit';
  if (remaining <= COUNTER_NUMBER_THRESHOLD) return 'warning';
  return '';
});
const counterDashOffset = computed(() => {
  const ratio = Math.min(1, charactersUsed.value / Math.max(1, characterLimit.value));
  return COUNTER_CIRCUMFERENCE * (1 - ratio);
});
const canSubmit = computed(() => {
  const hasContent = content.value.trim().length > 0 || mediaAttachments.value.length > 0;
  return hasContent && remainingCharacters.value >= 0;
});
const canAddMedia = computed(() => mediaAttachments.value.length < maxMediaAttachments.value);

const visibilityOptions = computed(() => [
  { value: 'public' as const, label: t('activitypub.public'), description: t('activitypub.visibleToEveryone'), icon: 'globe' },
  { value: 'unlisted' as const, label: t('activitypub.unlisted'), description: t('activitypub.notShownInPublicTimelines'), icon: 'unlock' },
  { value: 'followers' as const, label: t('activitypub.followersOnly'), description: t('activitypub.onlyVisibleToFollowers'), icon: 'lock' },
  { value: 'direct' as const, label: t('activitypub.mentionedOnly'), description: t('activitypub.onlyMentionedUsers'), icon: 'mail' }
]);

const currentVisibility = computed(() =>
  visibilityOptions.value.find(v => v.value === visibility.value) ?? visibilityOptions.value[0]
);

const getCurrentText = () => content.value || '';
const updateText = (newText: string, cursorPosition?: number) => {
  if (cursorPosition !== undefined && richEditorRef.value) {
    debug.log('Composer updateText:', { newText, cursorPosition });
    richEditorRef.value.skipNextWatch = true;

    content.value = newText;

    nextTick(() => {
      if (richEditorRef.value?.renderContent) {
        richEditorRef.value.renderContent(newText, true);
      }

      nextTick(() => {
        if (richEditorRef.value) {
          // Mention normalization (@user@localhost → @user for local) shortens
          // rendered text relative to raw text. Anchor the cursor from the end:
          // the suffix after the cursor is unaffected by mention rendering, so
          // rendered length minus suffix length gives the cursor offset.
          const renderedText = richEditorRef.value.getPlainText?.() || '';
          const suffixLen = newText.length - cursorPosition;
          const adjustedCursor = Math.max(0, renderedText.length - suffixLen);
          debug.log('Composer cursor adjustment:', {
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

const currentUser = computed(() => profileStore.profile);

const placeholder = computed(() => {
  if (props.type === 'reply') {
    return t('activitypub.whatsYourReply');
  }
  if (props.type === 'quote') {
    return t('activitypub.addAComment');
  }
  if (props.type === 'edit') {
    return t('activitypub.editYourPost');
  }
  return t('activitypub.whatsOnYourMind');
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

const handleContentUpdate = (newContent: string) => {
  content.value = newContent;
};

const handleCursorPositionChanged = (position: number) => {
  if (richEditorRef.value) {
    // getPlainText reflects DOM state including mention spans; content.value
    // lags when typing after an inserted mention.
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
  
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    if (canSubmit.value) {
      handleSubmit();
    }
  }
  
  if (event.key === 'Escape' && props.mode === 'modal') {
    handleClose();
  }
};

const triggerFileUpload = () => {
  fileInputRef.value?.click();
};

const handleDrop = async (event: DragEvent) => {
  event.preventDefault();
  event.stopPropagation();
  resetDragging();

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
  // The sensitive toggle is hidden without media; a leftover flag would mark a text-only post.
  if (mediaAttachments.value.length === 0) {
    isSensitive.value = false;
  }
};

const closeVisibilityMenu = () => {
  showVisibilityMenu.value = false;
};

// Teleported to <body>: the modal body and the mobile toolbar are scroll
// containers and clip positioned descendants.
const positionVisibilityMenu = () => {
  const trigger = visibilityTriggerRef.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const menuWidth = Math.min(280, window.innerWidth - 16);
  const left = Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8));
  const spaceBelow = window.innerHeight - rect.bottom;
  const style: Record<string, string> = { left: `${left}px`, width: `${menuWidth}px` };
  if (spaceBelow < 300 && rect.top > spaceBelow) {
    style.bottom = `${window.innerHeight - rect.top + 6}px`;
  } else {
    style.top = `${rect.bottom + 6}px`;
  }
  visibilityMenuStyle.value = style;
};

const toggleVisibilityMenu = () => {
  showMediaPicker.value = false;
  if (!showVisibilityMenu.value) positionVisibilityMenu();
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
      // Reblog replies thread under the original post, never the Announce
      // wrapper. Callers pass the unwrapped post; unwrapping again here keeps
      // new call sites correct.
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
    // Failures go to a toast; inline text would shift the action buttons and
    // overflow the toolbar. The composer is not reset, so the draft survives.
    toast.error(error?.message || t('activitypub.failedToSendPost'));
  } finally {
    isPosting.value = false;
  }
};

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
    // `getReplyMentionAuthor` returns the original post's author for pure
    // reblogs, the quoter for quote posts, and `undefined` for unhydrated
    // reblogs - no prefill there, since mentioning the booster is wrong.
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
    if (props.initialContentWarning) {
      contentWarning.value = props.initialContentWarning;
      showContentWarning.value = true;
    }
    if (props.initialSensitive) {
      isSensitive.value = true;
    }
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

watch(() => props.replyToPost, (replyPost) => {
  if (props.type === 'reply' && replyPost && content.value === '') {
    // Same routing as onMounted: pure reblog → original author,
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
      // Cursor lands after the mention and its trailing space.
      nextTick(() => {
        richEditorRef.value?.setCursorPosition(content.value.length);
      });
    });
  }
});

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

.composer-inline {
  width: 100%;
}

.composer-inline-content {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  background-color: var(--background-primary);
  padding: 1rem;
}

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
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0;
}

.close-button {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 0.5rem;
  transition: all 0.2s;
}

.close-button:hover {
  background-color: var(--bg-tertiary);
  color: var(--text-primary);
}

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
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.author-handle {
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.reply-text {
  color: var(--text-secondary);
  font-size: 0.875rem;
  line-height: 1.5;
}

.quote-preview-section {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--border-primary);
}

.quote-preview-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: var(--font-weight-medium);
  margin-bottom: 0.75rem;
}

.quote-preview {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  background: var(--background-secondary);
  border-radius: var(--radius-md);
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
  color: var(--text-secondary);
  font-size: 0.8125rem;
  line-height: 1.4;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

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
  color: var(--text-muted);
}

.cw-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

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
  background-color: var(--harmony-primary-alpha-light);
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
  border-radius: var(--radius-md);
  color: var(--text-light);
  font-weight: var(--font-weight-medium);
  pointer-events: none;
  z-index: 10;
}

.character-counter {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  user-select: none;
}

.counter-ring {
  transform: rotate(-90deg);
}

.counter-track {
  fill: none;
  stroke: var(--border-primary);
  stroke-width: 2.5;
}

.counter-progress {
  fill: none;
  stroke: var(--harmony-primary);
  stroke-width: 2.5;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.15s linear;
}

.character-counter.warning {
  color: var(--warning);
}

.character-counter.warning .counter-progress {
  stroke: var(--warning);
}

.character-counter.over-limit {
  color: var(--error);
}

.character-counter.over-limit .counter-progress {
  stroke: var(--error);
}

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
}

.draft-indicator {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--success);
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
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: var(--radius-full);
  transition: color var(--transition-fast), background-color var(--transition-fast);
  flex-shrink: 0;
}

.option-button:hover {
  background-color: var(--background-modifier-hover);
  color: var(--text-primary);
}

.option-button.active {
  color: var(--harmony-primary);
  background-color: var(--harmony-primary-alpha);
}

.visibility-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin-left: auto;
  height: 30px;
  padding: 0 0.625rem;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--harmony-primary);
  font-size: 0.8125rem;
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color var(--transition-fast);
}

.visibility-chip:hover {
  background: var(--harmony-primary-alpha-light);
}

.option-button:focus-visible,
.visibility-chip:focus-visible,
.post-button:focus-visible,
.cancel-button:focus-visible,
.close-button:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.option-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.composer-inline-content .option-button {
  display: flex;
}

.composer-visibility-menu {
  position: fixed;
  z-index: 10000;
  background-color: var(--background-floating, var(--background-primary));
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  padding: 0.25rem;
  box-shadow: var(--shadow-large);
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
  background-color: var(--background-modifier-hover);
}

.visibility-option.active {
  color: var(--harmony-primary);
}

.option-details {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.option-label {
  font-weight: var(--font-weight-semibold);
}

.option-description {
  font-size: 0.8125rem;
  color: var(--text-secondary);
}


.cancel-button {
  padding: 0.5rem 1rem;
  background: none;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.cancel-button:hover {
  background-color: var(--background-modifier-hover);
  color: var(--text-primary);
}

.post-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.25rem;
  background-color: var(--harmony-primary);
  border: none;
  border-radius: var(--radius-full);
  color: var(--text-on-primary);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast);
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
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.suggest-username,
.suggest-domain,
.suggest-server {
  /* color: #9ca3af;
  font-size: 0.875rem;
  margin-left: 0.25rem; */
}

@media (max-width: 768px) {
  /* ---------- Modal composer ---------- */
  /* Modal stays centered over the dimmed backdrop and grows to fit content.
     A full-screen sheet leaves a large empty gap below the input. */
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

  /* Header pins to the top; only the body grows and scrolls past the modal's
     max-height. */
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
  /* The inline card supplies its own padding via .composer-inline-content.
     Adding the modal's body padding on top of it squishes the composer. */
  .composer-inline-content {
    padding: 0.75rem;
  }

  /* ---------- Shared toolbar behaviour ---------- */

  /* One-line toolbar on mobile: action icons left, counter + Post right, no
     wrapping. The icon group is the flexible part - it shrinks and scrolls
     horizontally so the counter and Post button stay on the same row. */
  /* The visibility chip takes its own row above the icons; the zero-height
     ::before item forces the line break after it. */
  .compose-options {
    flex-wrap: wrap;
    align-items: center;
    column-gap: 0.25rem;
    row-gap: 0.5rem;
  }

  .compose-options::before {
    content: '';
    order: -1;
    flex-basis: 100%;
    height: 0;
  }

  .visibility-chip {
    order: -2;
    margin-left: 0;
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

  /* 40px touch targets; the option group scrolls when they overflow. */
  .option-button {
    width: 40px;
    height: 40px;
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
    min-height: 40px;
    padding: 0.45rem 0.8rem;
    flex-shrink: 0;
  }

  .cancel-button {
    min-height: 40px;
    padding: 0.45rem 0.6rem;
    flex-shrink: 0;
  }

  .visibility-chip {
    height: 40px;
  }
}
</style>

