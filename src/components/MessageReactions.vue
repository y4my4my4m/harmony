<template>
  <div v-if="showReactions && (reactions.length > 0 || isLoadingReactions)" class="message-reactions">
    <div class="reactions-gutter"></div>
    <div class="reactions-container">
      <!-- Loading state -->
      <!-- <div v-if="isLoadingReactions && reactions.length === 0" class="reaction-loading">
        <div class="loading-spinner"></div>
      </div> -->
      
      <!-- Reaction groups -->
      <div
        v-for="reactionGroup in reactions"
        :key="reactionGroup.emoji_id"
        class="reaction"
        :class="{ 
          'reacted': hasUserReacted(reactionGroup.emoji_id),
          'loading': isLoadingReactions 
        }"
        @click="handleReactionClick(reactionGroup.emoji, reactionGroup.emoji_id)"
        @mouseenter="showTooltip($event, reactionGroup)"
        @mouseleave="hideTooltip"
      >
        <img 
          v-if="reactionGroup.emoji?.url"
          :src="reactionGroup.emoji.url" 
          :alt="reactionGroup.emoji.name || 'emoji'"
          class="reaction-emoji"
          @error="handleEmojiError(reactionGroup.emoji)"
        />
        <span v-else class="missing-emoji" :title="`Emoji not found: ${reactionGroup.emoji?.name}`">?</span>
        <span class="reaction-count">{{ reactionGroup.count }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useReactionsStore } from '@/stores/useReactions';
import { useAuthStore } from '@/stores/auth';
import type { Message, Emoji } from '@/types';

interface Props {
  message: Message;
  showReactions?: boolean;
}

interface Emits {
  (e: 'toggle-reaction', messageId: string, emoji: Emoji): void;
  (e: 'show-reaction-tooltip', event: MouseEvent, reactionGroup: any): void;
  (e: 'hide-reaction-tooltip'): void;
}

const props = withDefaults(defineProps<Props>(), {
  showReactions: true
});

const emit = defineEmits<Emits>();

const reactionsStore = useReactionsStore();
const authStore = useAuthStore();

// ✅ UNIFIED ARCHITECTURE: Always use reactions store (populated by CoreMessageService)
const reactions = computed(() => {
  try {
    return reactionsStore.getMessageReactions(props.message.id);
  } catch (error) {
    console.error('❌ Error getting reactions for message:', props.message.id, error);
    return [];
  }
});

// Check if reactions are loading
const isLoadingReactions = computed(() => 
  reactionsStore.isLoadingReactions(props.message.id)
);

// Get current user ID
const currentUserId = computed(() => 
  authStore.session?.user?.id
);

// Check if current user has reacted to a specific emoji
const hasUserReacted = (emojiId: string) => {
  if (!currentUserId.value) return false;
  return reactionsStore.hasUserReacted(props.message.id, emojiId, currentUserId.value);
};

// Handle reaction toggle (Discord-style instant feedback)
const handleReactionClick = async (emoji: Emoji, emojiId: string) => {
  if (!currentUserId.value) return;
  
  emit('toggle-reaction', props.message.id, emoji);
  
  // Discord-style: Instant UI feedback with background API call
  const result = await reactionsStore.toggleReaction(props.message.id, emojiId, currentUserId.value);
  
  // Log result but don't show error for duplicate requests (they're expected)
  if (!result.success && result.reason !== 'Request already in progress') {
    console.error('🎯 Failed to toggle reaction:', result.reason);
  }
};

// Show reaction tooltip
const showTooltip = (event: MouseEvent, reactionGroup: any) => {
  emit('show-reaction-tooltip', event, reactionGroup);
};

// Hide reaction tooltip
const hideTooltip = () => {
  emit('hide-reaction-tooltip');
};

// Handle emoji loading errors
const handleEmojiError = (emoji: Emoji) => {
  console.warn('Failed to load emoji:', emoji);
};

// ✅ UNIFIED ARCHITECTURE: Reactions store is pre-populated by CoreMessageService  
// Components can safely request reactions - store has batch-loaded data, no N+1 queries
onMounted(() => {
  // Skip fetching for optimistic/temp messages
  if (props.message.id.startsWith('temp-') || props.message.sending) {
    console.log('⏭️ Skipping reaction fetch for optimistic message:', props.message.id);
    return;
  }
  
  // Store is populated by batch loading, but safe to request (will use cache)
  if (!reactionsStore.isLoadingReactions(props.message.id)) {
    reactionsStore.fetchMessageReactions(props.message.id);
  }
});

// Watch for message changes and reload reactions if needed
watch(() => props.message.id, (newMessageId, oldMessageId) => {
  // Skip if it's a temp message or optimistic message
  if (newMessageId.startsWith('temp-') || props.message.sending) {
    console.log('⏭️ Skipping reaction fetch for optimistic message:', newMessageId);
    return;
  }
  
  // Only fetch if message ID actually changed (temp → real)
  if (newMessageId !== oldMessageId && !reactionsStore.isLoadingReactions(newMessageId)) {
    console.log('🔄 Message ID changed, fetching reactions:', oldMessageId, '→', newMessageId);
    reactionsStore.fetchMessageReactions(newMessageId);
  }
});
</script>

<style scoped>
.message-reactions {
  display: flex;
  margin: 2px 0;
}

.reactions-gutter {
  width: 54px; /* 40px avatar + 16px gap to align with message content */
  flex-shrink: 0;
}

.reactions-container {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.reaction {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  background-color: #2d2f35;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.15s ease-out;
  user-select: none;
  min-height: 22px;
}

.reaction:hover {
  background-color: #40444b;
  border-color: #4f545c;
}

.reaction.reacted {
  background-color: hsl(235, 85.6%, 64.7%, 0.15);
  border-color: hsl(235, 85.6%, 64.7%);
}

.reaction.loading {
  opacity: 0.7;
  pointer-events: none;
}

.reaction-emoji {
  max-width: 64px;
  height: 16px;
  object-fit: contain;
  flex-shrink: 0;
}

.reaction-count {
  font-size: 0.8125rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.5);
  min-width: 9px;
  text-align: center;
}

.reaction.reacted .reaction-count {
  color: hsl(0, 0%, 100%);
}

.missing-emoji {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #40444b;
  border-radius: 3px;
  font-size: 10px;
  color: #72767d;
  flex-shrink: 0;
}

.reaction-loading {
  display: flex;
  align-items: center;
  padding: 6px;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid #40444b;
  border-top: 2px solid #5865f2;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
</style>
