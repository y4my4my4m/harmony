<template>
  <div class="inline-reply-composer" v-if="isVisible">
    <div class="reply-context-indicator">
      <Icon name="corner-down-right" class="reply-icon" />
      <span class="reply-text">
        Replying to <strong>{{ replyToPost.author.display_name || replyToPost.author.username }}</strong>
      </span>
    </div>
    
    <div class="composer-content">
      <div class="composer-header">
        <Avatar 
          :src="currentUser?.avatar_url" 
          :alt="currentUser?.display_name || currentUser?.username"
          size="sm"
        />
        <div class="composer-controls">
          <select v-model="visibility" class="visibility-select">
            <option value="public">🌐 Public</option>
            <option value="unlisted">🔓 Unlisted</option>
            <option value="followers">👥 Followers</option>
            <option value="direct">✉️ Direct</option>
          </select>
        </div>
      </div>

      <div class="composer-body">
        <textarea
          ref="textareaRef"
          v-model="content"
          :placeholder="`Reply to ${replyToPost.author.display_name || replyToPost.author.username}...`"
          class="reply-input"
          rows="3"
          @keydown.ctrl.enter="submitReply"
          @keydown.meta.enter="submitReply"
          @input="adjustHeight"
        />
        
        <div v-if="contentWarning" class="content-warning-input">
          <input
            v-model="contentWarning"
            placeholder="Content warning (optional)"
            class="cw-input"
          />
        </div>
      </div>

      <div class="composer-footer">
        <div class="composer-options">
          <button 
            @click="toggleContentWarning"
            class="option-button"
            :class="{ active: showContentWarning }"
            title="Add content warning"
          >
            <Icon name="alert-triangle" />
          </button>
          
          <button 
            @click="toggleSensitive"
            class="option-button"
            :class="{ active: isSensitive }"
            title="Mark as sensitive"
          >
            <Icon name="eye-off" />
          </button>
        </div>

        <div class="composer-actions">
          <span class="character-count" :class="{ warning: characterCount > 450, error: characterCount > 500 }">
            {{ characterCount }}/500
          </span>
          
          <button 
            @click="cancel"
            class="cancel-button"
            :disabled="isSubmitting"
          >
            Cancel
          </button>
          
          <button 
            @click="submitReply"
            class="submit-button"
            :disabled="!canSubmit || isSubmitting"
          >
            <Icon v-if="isSubmitting" name="loader" class="spinning" />
            <span>{{ isSubmitting ? 'Posting...' : 'Reply' }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useActivityPubStore } from '@/stores/useActivityPub';
import type { TimelinePost } from '@/types';

// Components
import Avatar from '@/components/common/Avatar.vue';
import Icon from '@/components/common/Icon.vue';
import { useProfileStore } from '@/stores/useProfile';

// Props
interface Props {
  replyToPost: TimelinePost;
  isVisible: boolean;
}

const props = defineProps<Props>();

// Emits
const emit = defineEmits<{
  'reply-sent': [reply: any];
  'cancel': [];
  'close': [];
}>();

// Stores
const profileStore = useProfileStore();
const activityPubStore = useActivityPubStore();

// Refs
const textareaRef = ref<HTMLTextAreaElement>();

// State
const content = ref('');
const visibility = ref<'public' | 'unlisted' | 'followers' | 'direct'>('public');
const contentWarning = ref('');
const showContentWarning = ref(false);
const isSensitive = ref(false);
const isSubmitting = ref(false);

// Computed
const currentUser = computed(() => profileStore.profile);

const characterCount = computed(() => content.value.length);

const canSubmit = computed(() => {
  return content.value.trim().length > 0 && 
         content.value.length <= 500 && 
         !isSubmitting.value;
});

// Methods
const adjustHeight = () => {
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto';
    textareaRef.value.style.height = `${textareaRef.value.scrollHeight}px`;
  }
};

const toggleContentWarning = () => {
  showContentWarning.value = !showContentWarning.value;
  if (!showContentWarning.value) {
    contentWarning.value = '';
  }
};

const toggleSensitive = () => {
  isSensitive.value = !isSensitive.value;
};

const submitReply = async () => {
  if (!canSubmit.value) return;

  try {
    isSubmitting.value = true;

    const reply = await activityPubStore.replyToPost(props.replyToPost.id, content.value, {
      visibility: visibility.value,
      content_warning: contentWarning.value || undefined,
      is_sensitive: isSensitive.value
    });

    emit('reply-sent', reply);
    
    // Reset form
    content.value = '';
    contentWarning.value = '';
    showContentWarning.value = false;
    isSensitive.value = false;
    
    emit('close');
  } catch (error) {
    console.error('Failed to send reply:', error);
    // Could show error toast here
  } finally {
    isSubmitting.value = false;
  }
};

const cancel = () => {
  content.value = '';
  contentWarning.value = '';
  showContentWarning.value = false;
  isSensitive.value = false;
  emit('cancel');
  emit('close');
};

// Focus textarea when component becomes visible
watch(() => props.isVisible, async (visible) => {
  if (visible) {
    await nextTick();
    textareaRef.value?.focus();
  }
});
</script>

<style scoped>
.inline-reply-composer {
  border-top: 1px solid var(--border-color);
  background: var(--background-secondary);
  padding: 16px;
  margin-top: 8px;
  border-bottom-left-radius: 12px;
  border-bottom-right-radius: 12px;
}

.reply-context-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: var(--text-secondary);
  font-size: 14px;
}

.reply-icon {
  width: 16px;
  height: 16px;
  color: var(--primary-color);
}

.composer-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.composer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.visibility-select {
  background: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--text-primary);
}

.composer-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.reply-input {
  width: 100%;
  min-height: 80px;
  max-height: 200px;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--background-primary);
  color: var(--text-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
  resize: none;
  overflow-y: auto;
}

.reply-input:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 2px var(--primary-color-20);
}

.content-warning-input {
  margin-top: 8px;
}

.cw-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-primary);
  color: var(--text-primary);
  font-size: 13px;
}

.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.composer-options {
  display: flex;
  gap: 8px;
}

.option-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.option-button:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.option-button.active {
  background: var(--primary-color-10);
  color: var(--primary-color);
}

.composer-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.character-count {
  font-size: 12px;
  color: var(--text-secondary);
}

.character-count.warning {
  color: var(--warning-color);
}

.character-count.error {
  color: var(--error-color);
}

.cancel-button {
  padding: 8px 16px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.cancel-button:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.submit-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: var(--primary-color);
  color: white;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.submit-button:hover:not(:disabled) {
  background: var(--primary-color-dark);
}

.submit-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style> 