<template>
  <div v-if="reactions.length > 0" class="post-reactions">
    <div class="reactions-container">
      <!-- Loading state -->
      <div v-if="isLoadingReactions && reactions.length === 0" class="reaction-loading">
        <div class="loading-spinner"></div>
      </div>
      
      <!-- Reaction groups -->
      <div
        v-for="reaction in reactions"
        :key="reaction.emoji_id || reaction.custom_emoji_content"
        class="reaction"
        :class="{ 
          'reacted': reaction.current_user_reacted,
          'loading': isLoadingReactions 
        }"
        @click="handleReactionClick(reaction)"
        @mouseenter="showTooltip($event, reaction)"
        @mouseleave="hideTooltip"
      >
        <!-- Custom emoji image -->
        <img 
          v-if="reaction.emoji_url"
          :src="reaction.emoji_url" 
          :alt="reaction.emoji_name || 'emoji'"
          class="reaction-emoji"
          @error="handleEmojiError(reaction)"
        />
        <!-- Unicode emoji -->
        <span 
          v-else-if="reaction.custom_emoji_content"
          class="reaction-emoji unicode-emoji"
        >
          {{ reaction.custom_emoji_content }}
        </span>
        <!-- Fallback for missing emoji -->
        <span v-else class="missing-emoji" :title="`Emoji not found: ${reaction.emoji_name}`">?</span>
        
        <span class="reaction-count">{{ reaction.reaction_count }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TimelinePost } from '@/types'
import { usePostReactions } from '@/composables/usePostReactions'

interface Props {
  post: TimelinePost;
  showReactions?: boolean;
}

interface Emits {
  (e: 'show-reaction-tooltip', event: MouseEvent, reaction: any): void;
  (e: 'hide-reaction-tooltip'): void;
}

const props = withDefaults(defineProps<Props>(), {
  showReactions: true,
});

const emit = defineEmits<Emits>();

// Use the professional composable following chat patterns
const {
  reactions,
  isLoadingReactions,
  handleReactionClick,
  formatReactionTooltip
} = usePostReactions(props)

// Show reaction tooltip with user details  
const showTooltip = (event: MouseEvent, reaction: any) => {
  emit('show-reaction-tooltip', event, reaction);
};

// Hide reaction tooltip
const hideTooltip = () => {
  emit('hide-reaction-tooltip');
};

// Handle emoji loading errors
const handleEmojiError = (reaction: any) => {
  console.warn('Failed to load emoji:', reaction);
};

// Expose methods for parent components
defineExpose({
  // Not needed anymore - store handles everything
})
</script>

<style scoped>
.post-reactions {
  margin-bottom: 8px;
}

.reactions-container {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.reaction {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background-color: var(--background-quinary);
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.15s ease-out;
  user-select: none;
  min-height: 24px;
}

.reaction:hover {
  background-color: var(--background-quaternary);
  border-color: var(--border-color);
}

.reaction.reacted {
  background-color: rgba(88, 101, 242, 0.15);
  border-color: rgba(88, 101, 242, 0.5);
}

.reaction.loading {
  opacity: 0.7;
  pointer-events: none;
}

.reaction-emoji {
  width: 16px;
  height: 16px;
  object-fit: contain;
  flex-shrink: 0;
}

.unicode-emoji {
  font-size: 16px;
  line-height: 1;
}

.reaction-count {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-secondary);
  min-width: 9px;
  text-align: center;
}

.reaction.reacted .reaction-count {
  color: var(--text-primary);
  font-weight: 600;
}

.missing-emoji {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--background-quaternary);
  border-radius: 3px;
  font-size: 10px;
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.add-reaction-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background-color: var(--background-quinary);
  border: 1px solid transparent;
  border-radius: 12px;
  cursor: pointer;
  color: var(--text-tertiary);
  transition: all 0.15s ease-out;
}

.add-reaction-btn:hover {
  background-color: var(--background-quaternary);
  border-color: var(--border-color);
  color: var(--text-secondary);
}

.reaction-loading {
  display: flex;
  align-items: center;
  padding: 6px;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--background-quaternary);
  border-top: 2px solid var(--harmony-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
</style>
