<!-- MonyComposerInline - Inline post composer for the timeline -->
<template>
  <div class="inline-composer">
    <div class="composer-content">
      <!-- User Avatar -->
      <Avatar 
        :src="currentUser?.avatar_url"
        :alt="currentUser?.display_name || currentUser?.username"
        :size="isMobile ? 'sm' : 'md'"
        :interactive="true"
      />
      
      <!-- Composer Form -->
      <div class="composer-form">
        <!-- Text Input -->
        <div class="text-input-container">
          <RichTextEditor
            ref="richEditorRef"
            :model-value="content"
            :placeholder="placeholder"
            :max-height="150"
            :min-height="60"
            @update:model-value="handleContentUpdate"
            @input="handleInput"
            @keydown="handleKeydown"
            @cursor-position-changed="handleCursorPositionChanged"
          />
          
          <!-- Character Counter -->
          <div class="character-counter" :class="{ 'warning': content.length > 450 }">
            {{ content.length }}/500
          </div>
          
          <!-- Auto-suggest dropdown for mentions -->
          <AutoSuggest
            :isVisible="autoSuggest.state.value.isActive"
            :suggestions="autoSuggest.suggestions.value"
            :position="autoSuggest.state.value.position"
            :selectedIndex="autoSuggest.state.value.selectedIndex"
            :headerText="autoSuggest.headerText.value"
            @select="handleSuggestionSelect"
            @update:selectedIndex="(index) => autoSuggest.state.value.selectedIndex = index"
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

        <!-- Content Warning Input -->
        <div v-if="showContentWarning" class="content-warning-input">
          <input
            v-model="contentWarning"
            type="text"
            placeholder="Describe why this content might be sensitive"
            class="cw-input"
            maxlength="100"
          />
        </div>

        <!-- Media Attachments Preview -->
        <div v-if="mediaAttachments.length > 0" class="media-preview">
          <div
            v-for="(media, index) in mediaAttachments"
            :key="index"
            class="media-item"
          >
            <img 
              v-if="media.type === 'image'"
              :src="media.preview_url"
              :alt="media.description || 'Attachment'"
              class="media-thumbnail"
            />
            <video 
              v-else-if="media.type === 'video'"
              :src="media.url"
              class="media-thumbnail"
              controls
            />
            <div v-else class="media-placeholder">
              <Icon name="file" />
              <span>{{ media.filename }}</span>
            </div>
            <button
              @click="removeMedia(index)"
              class="remove-media-btn"
              title="Remove attachment"
            >
              <Icon name="x" />
            </button>
          </div>
        </div>

        <!-- Composer Actions -->
        <div class="composer-actions">
          <div class="action-buttons">
            <!-- Media Upload -->
            <label class="action-btn media-btn" title="Add media">
              <Icon name="image" :size="24" />
              <input
                ref="fileInputRef"
                type="file"
                accept="image/*,video/*"
                multiple
                class="hidden"
                @change="handleFileSelect"
              />
            </label>

            <!-- GIF Picker -->
            <button
              ref="gifTriggerRef"
              @click="showGiphyPicker = !showGiphyPicker"
              :class="['action-btn', 'gif-btn', { active: showGiphyPicker }]"
              title="Add GIF"
            >
              <GifIcon />
            </button>

            <!-- Emoji Picker -->
            <button
              ref="emojiTriggerRef"
              @click="showEmojiPicker = !showEmojiPicker"
              :class="['action-btn', 'emoji-btn', { active: showEmojiPicker }]"
              title="Add emoji"
            >
              <EmojiUI />
            </button>

            <!-- Content Warning Toggle -->
            <button
              @click="showContentWarning = !showContentWarning"
              :class="['action-btn', 'cw-btn', { active: showContentWarning }]"
              title="Add content warning"
            >
              <Icon name="warning" :size="24"/>
            </button>

            <!-- Visibility Selector -->
            <div class="visibility-selector">
              <button
                @click="showVisibilityMenu = !showVisibilityMenu"
                class="action-btn visibility-btn"
                :title="`Visibility: ${visibilityLabels[visibility]}`"
              >
                <Icon :size="24" :name="visibilityIcons[visibility]" />
                <Icon name="chevron-down" :size="12" />
              </button>
              
              <div v-if="showVisibilityMenu" class="visibility-menu">
                <button
                  v-for="(label, key) in visibilityLabels"
                  :key="key"
                  @click="selectVisibility(key)"
                  :class="['visibility-option', { active: visibility === key }]"
                >
                  <Icon :size="24" :name="visibilityIcons[key]" />
                  <div class="visibility-info">
                    <div class="visibility-label">{{ label }}</div>
                    <div class="visibility-desc">{{ visibilityDescriptions[key] }}</div>
                  </div>
                </button>
              </div>
            </div>
          </div>

          <!-- Submit Button -->
          <button
            @click="handleSubmit"
            :disabled="!canSubmit || isPosting"
            class="submit-btn"
          >
            <Icon v-if="isPosting" name="loader" class="spinning" />
            <span>{{ isPosting ? 'Posting...' : 'Mony' }}</span>
          </button>
        </div>
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
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useProfileStore } from '@/stores/useProfile';
import type { Post, MediaAttachment } from '@/types';
import Icon from '@/components/common/Icon.vue';
import Avatar from '../common/Avatar.vue';
import AutoSuggest from '@/components/AutoSuggest.vue';
import RichTextEditor from '@/components/RichTextEditor.vue';
import EmojiPopup from '@/components/EmojiPopup.vue';
import GifComponent from '@/components/GifComponent.vue';
import GifIcon from '@/components/icons/Gif.vue';
import EmojiUI from '@/components/EmojiUI.vue';
import { useLayoutState } from '@/composables/useLayoutState';

// Layout state
const { isMobile } = useLayoutState();

// Composables
import { useAutoSuggest } from '@/composables/useAutoSuggest';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';


// Emit events
const emit = defineEmits<{
  'post-created': [post: any];
}>();

// Stores
const activityPubStore = useActivityPubStore();
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

// State
const content = ref('');
const contentWarning = ref('');
const visibility = ref<Post['visibility']>('public');
const mediaAttachments = ref<MediaAttachment[]>([]);
const showContentWarning = ref(false);
const showVisibilityMenu = ref(false);
const showEmojiPicker = ref(false);
const showGiphyPicker = ref(false);
const isPosting = ref(false);

// Configuration
const visibilityLabels = {
  public: 'Public',
  unlisted: 'Unlisted',
  private: 'Followers only',
  direct: 'Direct'
};

const visibilityIcons = {
  public: 'globe',
  unlisted: 'unlock',
  private: 'lock',
  direct: 'mail'
};

const visibilityDescriptions = {
  public: 'Visible to everyone',
  unlisted: 'Public but not on timelines',
  private: 'Only visible to followers',
  direct: 'Only mentioned users can see'
};

// Computed
const currentUser = computed(() => profileStore.profile);

const placeholder = computed(() => {
  return "What's happening in the Monyverse?";
});

const canSubmit = computed(() => {
  return (content.value.trim().length > 0 || mediaAttachments.value.length > 0) &&
         content.value.length <= 500;
});

// Methods
const handleContentUpdate = (newContent: string) => {
  content.value = newContent;
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

// Handle emoji insertion like the chat system
const insertEmojiAtCursor = (emoji: any) => {
  if (!richEditorRef.value?.insertTextAtCursor) return;
  
  const currentText = content.value;
  const cursorPosition = richEditorRef.value.getCursorPosition?.() || 0;
  
  // Check if there's an emoji trigger pattern before cursor
  const textBeforeCursor = currentText.substring(0, cursorPosition);
  const emojiMatch = textBeforeCursor.match(/:([a-zA-Z0-9_]*)$/);
  
  let newText;
  
  if (emojiMatch) {
    // Remove the trigger text and insert emoji
    const triggerLength = emojiMatch[0].length;
    newText = currentText.substring(0, cursorPosition - triggerLength) + 
             `:${emoji.name}:` + 
             currentText.substring(cursorPosition);
  } else {
    // No trigger pattern, just insert emoji at cursor
    newText = currentText.substring(0, cursorPosition) + 
             `:${emoji.name}:` + 
             currentText.substring(cursorPosition);
  }
  
  // Update content
  content.value = newText;
};

// Handle mention insertion like the chat system
const handleMentionInsertion = (mention: SuggestionItem) => {
  if (!richEditorRef.value) return;
  
  const currentText = content.value;
  const cursorPosition = richEditorRef.value.getCursorPosition?.() || 0;
  
  // Find the @ trigger
  const textBeforeCursor = currentText.substring(0, cursorPosition);
  const mentionMatch = textBeforeCursor.match(/@([a-zA-Z0-9_]*)$/);
  
  if (mentionMatch) {
    const triggerLength = mentionMatch[0].length;
    let mentionText = '';
    
    // For federated users, use full handle, for local users use just @username
    if (!mention.is_local && mention.domain) {
      mentionText = `@${mention.username}@${mention.domain}`;
    } else {
      mentionText = `@${mention.username}`;
    }
    
    const newText = currentText.substring(0, cursorPosition - triggerLength) + 
                   mentionText + ' ' + 
                   currentText.substring(cursorPosition);
    
    content.value = newText;
  }
};

// Handle emoji insertion - store full emoji object, not just shortcode
const insertEmoji = (emoji: any) => {
  // TODO: For now, we'll still use shortcode approach until we refactor the content system
  // to handle structured content with emoji objects during composition
  const emojiText = `:${emoji.name}:`;
  const currentContent = content.value;
  content.value = currentContent + emojiText;
  
  showEmojiPicker.value = false;
  
  nextTick(() => {
    const richEditor = richEditorRef.value;
    if (richEditor && richEditor.focus) {
      richEditor.focus();
    }
  });
};

// Handle GIF insertion
const insertGif = (gif: any) => {
  const gifUrl = gif.media_formats.gif.url;
  const currentContent = content.value;
  content.value = currentContent + (currentContent ? '\n' : '') + gifUrl;
  
  showGiphyPicker.value = false;
  
  nextTick(() => {
    const richEditor = richEditorRef.value;
    if (richEditor && richEditor.focus) {
      richEditor.focus();
    }
  });
};

const handleKeydown = (event: KeyboardEvent) => {
  // Handle autoSuggest navigation
  const handled = autoSuggest.handleKeyDown(event);
  if (handled) return;
  
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    handleSubmit();
  }
};

const handleFileSelect = async (event: Event) => {
  const target = event.target as HTMLInputElement;
  const files = target.files;
  if (!files) return;

  for (const file of Array.from(files)) {
    if (mediaAttachments.value.length >= 4) {
      alert('Maximum 4 attachments allowed');
      break;
    }

    try {
      // Create a mock media attachment for now
      // In a real implementation, you would upload to your media service
      const attachment: MediaAttachment = {
        id: `temp_${Date.now()}_${Math.random()}`,
        type: file.type.startsWith('image/') ? 'image' : 'video',
        url: URL.createObjectURL(file),
        preview_url: URL.createObjectURL(file),
        filename: file.name,
        size: file.size,
        description: null
      };

      mediaAttachments.value.push(attachment);
    } catch (error) {
      console.error('Failed to process file:', error);
      alert('Failed to add attachment');
    }
  }

  // Clear the input
  if (fileInputRef.value) {
    fileInputRef.value.value = '';
  }
};

const removeMedia = (index: number) => {
  const media = mediaAttachments.value[index];
  if (media.url.startsWith('blob:')) {
    URL.revokeObjectURL(media.url);
  }
  mediaAttachments.value.splice(index, 1);
};

const selectVisibility = (newVisibility: Post['visibility']) => {
  visibility.value = newVisibility;
  showVisibilityMenu.value = false;
};

const handleSubmit = async () => {
  if (!canSubmit.value || isPosting.value) return;

  isPosting.value = true;
  try {
    // Parse content just like chat messages do
    const { parseContentToMessageParts, resolveMentionsUserData, resolveEmojisData, resolveHashtagsData } = await import('@/utils/unifiedContentProcessing');
    
    const rawContent = content.value.trim();
    console.log('🔧 DEBUG: MonyComposer rawContent:', rawContent);
    console.log('🔧 DEBUG: MonyComposer rawContent type:', typeof rawContent);
    
    const [usernameToUserDataMap, emojiDataMap, hashtagDataMap] = await Promise.all([
      resolveMentionsUserData(rawContent),
      resolveEmojisData(rawContent),
      resolveHashtagsData(rawContent)
    ]);
    
    console.log('🔧 DEBUG: MonyComposer resolved data:', { usernameToUserDataMap, emojiDataMap, hashtagDataMap });
    
    const parsedContent = await parseContentToMessageParts(rawContent, usernameToUserDataMap, emojiDataMap, hashtagDataMap);
    console.log('🔧 DEBUG: MonyComposer parsedContent:', parsedContent);
    console.log('🔧 DEBUG: MonyComposer parsedContent JSON:', JSON.stringify(parsedContent));

    await activityPubStore.createPost({
      content: parsedContent,
      visibility: visibility.value,
      content_warning: showContentWarning.value ? contentWarning.value : undefined,
      in_reply_to: undefined,
      media_attachments: mediaAttachments.value,
      is_sensitive: showContentWarning.value
    });

    // Reset form
    content.value = '';
    contentWarning.value = '';
    mediaAttachments.value.forEach(media => {
      if (media.url.startsWith('blob:')) {
        URL.revokeObjectURL(media.url);
      }
    });
    mediaAttachments.value = [];
    showContentWarning.value = false;
    showVisibilityMenu.value = false;

    // Emit success event
    emit('post-created', { id: 'new-post' });
    
    // RichTextEditor handles its own height
  } catch (error) {
    console.error('Failed to create post:', error);
    alert('Failed to create post. Please try again.');
  } finally {
    isPosting.value = false;
  }
};

// RichTextEditor automatically handles height changes

// Close visibility menu when clicking outside
const handleClickOutside = (event: Event) => {
  if (showVisibilityMenu.value) {
    const target = event.target as Element;
    if (!target.closest('.visibility-selector')) {
      showVisibilityMenu.value = false;
    }
  }
};

// Set up event listeners
document.addEventListener('click', handleClickOutside);
</script>

<style scoped>
.inline-composer {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 1rem;
  margin: 1rem;
}

.composer-content {
  display: flex;
  gap: 0.75rem;
}
.composer-form {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.text-input-container {
  position: relative;
}

.text-input {
  width: 100%;
  background: transparent;
  border: none;
  color: white;
  font-size: 1rem;
  line-height: 1.5;
  resize: none;
  min-height: 60px;
  max-height: 200px;
  padding: 4px;
  border-radius: 4px;;
  font-family: inherit;
}

.text-input:focus {
  outline: none;
}

.text-input::placeholder {
  color: #80848e;
}

.character-counter {
  position: absolute;
  bottom: 4px;
  right: 4px;
  font-size: 0.75rem;
  color: #80848e;
  pointer-events: none;
}

.character-counter.warning {
  color: #f23f42;
}

.content-warning-input {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 0.75rem;
}

.cw-input {
  width: 100%;
  background: var(--h-chat, #313338);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 0.5rem;
  color: white;
  font-size: 0.875rem;
}

.cw-input:focus {
  outline: none;
  border-color: var(--h-brand, #5865f2);
}

.media-preview {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.media-item {
  position: relative;
  width: 80px;
  height: 80px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--h-chat, #313338);
}

.media-thumbnail {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.media-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 0.75rem;
  color: #80848e;
  text-align: center;
  padding: 0.25rem;
}

.remove-media-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  background: rgba(0, 0, 0, 0.7);
  border: none;
  border-radius: 50%;
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.remove-media-btn:hover {
  background: rgba(0, 0, 0, 0.9);
}

.composer-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 0.75rem;
}

.action-buttons {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: 6px;
  color: #80848e;
  cursor: pointer;
  transition: all 0.2s;
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: white;
}

.action-btn.active {
  color: var(--h-brand, #5865f2);
  background: rgba(88, 101, 242, 0.1);
}

.hidden {
  display: none;
}

.visibility-selector {
  position: relative;
}

.visibility-btn {
  gap: 0.25rem;
  width: auto;
  padding: 0 0.5rem;
}

.visibility-menu {
  position: absolute;
  top: calc(100% - 34px);
  left: 60px;
  width: 240px;
  background: var(--h-sidebar, #2b2d31);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 0.5rem;
  z-index: 100;
  margin-bottom: 0.5rem;
}

.visibility-option {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  background: none;
  border: none;
  color: white;
  padding: 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  transition: background 0.2s;
}

.visibility-option:hover {
  background: rgba(255, 255, 255, 0.08);
}

.visibility-option.active {
  background: rgba(88, 101, 242, 0.1);
  color: var(--h-brand, #5865f2);
}

.visibility-info {
  flex: 1;
}

.visibility-label {
  font-weight: 500;
  margin-bottom: 0.25rem;
}

.visibility-desc {
  font-size: 0.75rem;
  color: #80848e;
}

.submit-btn {
  background: var(--h-brand, #5865f2);
  border: none;
  border-radius: 6px;
  color: white;
  padding: 0.5rem 1rem;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  transition: all 0.2s;
}

.submit-btn:hover:not(:disabled) {
  background: #4752c4;
}

.submit-btn:disabled {
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

/* Mobile responsiveness */
@media (max-width: 768px) {
  .inline-composer {
    /* padding: 0.75rem; */
    margin: 0.5rem;
    margin-right: 1rem;
  }
  .visibility-menu {
    width: 200px;
  }
}
</style>
