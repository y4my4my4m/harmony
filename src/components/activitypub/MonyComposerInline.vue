<!-- MonyComposerInline - Inline post composer for the timeline -->
<template>
  <div class="inline-composer">
    <div class="composer-content">
      <!-- User Avatar -->
      <img 
        :src="currentUser?.avatar_url || '/default_avatar.png'" 
        :alt="currentUser?.display_name"
        class="user-avatar"
      />
      
      <!-- Composer Form -->
      <div class="composer-form">
        <!-- Text Input -->
        <div class="text-input-container">
          <textarea
            v-model="content"
            ref="textareaRef"
            :placeholder="placeholder"
            class="text-input"
            rows="3"
            maxlength="500"
            @input="adjustTextareaHeight"
            @keydown="handleKeydown"
          />
          
          <!-- Character Counter -->
          <div class="character-counter" :class="{ 'warning': content.length > 450 }">
            {{ content.length }}/500
          </div>
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
              <Icon name="image" />
              <input
                ref="fileInputRef"
                type="file"
                accept="image/*,video/*"
                multiple
                class="hidden"
                @change="handleFileSelect"
              />
            </label>

            <!-- Content Warning Toggle -->
            <button
              @click="showContentWarning = !showContentWarning"
              :class="['action-btn', 'cw-btn', { active: showContentWarning }]"
              title="Add content warning"
            >
              <Icon name="warning" />
            </button>

            <!-- Visibility Selector -->
            <div class="visibility-selector">
              <button
                @click="showVisibilityMenu = !showVisibilityMenu"
                class="action-btn visibility-btn"
                :title="`Visibility: ${visibilityLabels[visibility]}`"
              >
                <Icon :name="visibilityIcons[visibility]" />
                <Icon name="chevron-down" size="12" />
              </button>
              
              <div v-if="showVisibilityMenu" class="visibility-menu">
                <button
                  v-for="(label, key) in visibilityLabels"
                  :key="key"
                  @click="selectVisibility(key)"
                  :class="['visibility-option', { active: visibility === key }]"
                >
                  <Icon :name="visibilityIcons[key]" />
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
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useActivityPubStore } from '@/stores/activitypub';
import { useProfileStore } from '@/stores/useProfile';
import type { Post, MediaAttachment } from '@/types';
import Icon from '@/components/common/Icon.vue';

// Emit events
const emit = defineEmits<{
  'post-created': [post: any];
}>();

// Stores
const activityPubStore = useActivityPubStore();
const profileStore = useProfileStore();

// Refs
const textareaRef = ref<HTMLTextAreaElement>();
const fileInputRef = ref<HTMLInputElement>();

// State
const content = ref('');
const contentWarning = ref('');
const visibility = ref<Post['visibility']>('public');
const mediaAttachments = ref<MediaAttachment[]>([]);
const showContentWarning = ref(false);
const showVisibilityMenu = ref(false);
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
const adjustTextareaHeight = async () => {
  await nextTick();
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto';
    textareaRef.value.style.height = `${textareaRef.value.scrollHeight}px`;
  }
};

const handleKeydown = (event: KeyboardEvent) => {
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
    await activityPubStore.createPost({
      content: content.value.trim(),
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
    
    // Reset textarea height
    await nextTick();
    adjustTextareaHeight();
  } catch (error) {
    console.error('Failed to create post:', error);
    alert('Failed to create post. Please try again.');
  } finally {
    isPosting.value = false;
  }
};

// Watch content changes to adjust textarea height
watch(content, () => {
  adjustTextareaHeight();
});

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
  background: var(--h-sidebar, #2b2d31);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 1rem;
  margin-bottom: 1rem;
}

.composer-content {
  display: flex;
  gap: 0.75rem;
}

.user-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
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
  padding: 0;
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
  bottom: 0;
  right: 0;
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
  bottom: 100%;
  left: 0;
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
    padding: 0.75rem;
  }
  
  .user-avatar {
    width: 32px;
    height: 32px;
  }
  
  .visibility-menu {
    width: 200px;
  }
}
</style>
