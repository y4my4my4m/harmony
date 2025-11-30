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
        <!-- Custom server emoji with URL (priority) -->
        <img 
          v-if="reactionGroup.emoji?.url && !reactionGroup.emoji?.is_native"
          :src="reactionGroup.emoji.url" 
          :alt="reactionGroup.emoji.name || 'emoji'"
          class="reaction-emoji"
          @error="handleEmojiError(reactionGroup.emoji)"
        />
        <!-- Resolved emoji (native unicode or pack SVG) -->
        <template v-else-if="getResolvedEmoji(reactionGroup)">
          <img 
            v-if="getResolvedEmoji(reactionGroup).display.type === 'svg'"
            :src="getResolvedEmoji(reactionGroup).display.content"
            :alt="getResolvedEmoji(reactionGroup).shortcode || 'emoji'"
            class="reaction-emoji"
          />
          <span v-else class="native-emoji">{{ getResolvedEmoji(reactionGroup).display.content }}</span>
        </template>
        <!-- Fallback for missing emoji -->
        <span v-else class="missing-emoji" :title="`Emoji: ${reactionGroup.emoji?.name || reactionGroup.emoji_id}`">?</span>
        <span class="reaction-count">{{ reactionGroup.count }}</span>
      </div>
      
      <!-- Add reaction button (only shown when reactions exist) -->
      <button 
        v-if="reactions.length > 0"
        class="add-reaction-btn"
        @click="handleAddReactionClick"
        title="Add Reaction"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="16"/>
          <line x1="8" y1="12" x2="16" y2="12"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { debug } from '@/utils/debug'
import { useReactionsStore } from '@/stores/useReactions';
import { useAuthStore } from '@/stores/auth';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { useUnifiedEmoji } from '@/services/unifiedEmojiService';
import type { Message, Emoji } from '@/types';

interface Props {
  message: Message;
  showReactions?: boolean;
}

interface Emits {
  (e: 'toggle-reaction', messageId: string, emoji: Emoji): void;
  (e: 'show-reaction-tooltip', event: MouseEvent, reactionGroup: any): void;
  (e: 'hide-reaction-tooltip'): void;
  (e: 'open-emoji-picker', messageId: string, event: MouseEvent): void;
}

const props = withDefaults(defineProps<Props>(), {
  showReactions: true
});

const emit = defineEmits<Emits>();

const reactionsStore = useReactionsStore();
const authStore = useAuthStore();
const { triggerReaction } = useHapticSettings();
const { recordEmojiUsage } = useFrequentEmojis();
const { resolveEmoji, isNativePack } = useUnifiedEmoji();

// ✅ UNIFIED ARCHITECTURE: Always use reactions store (populated by CoreMessageService)
const reactions = computed(() => {
  try {
    return reactionsStore.getMessageReactions(props.message.id);
  } catch (error) {
    debug.error('❌ Error getting reactions for message:', props.message.id, error);
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
  
  // Haptic feedback on reaction
  triggerReaction();
  
  // Record emoji usage for frequently used emojis
  recordEmojiUsage({
    id: emojiId,
    name: emoji.name || emojiId,
    url: emoji.url
  });
  
  emit('toggle-reaction', props.message.id, emoji);
  
  // Discord-style: Instant UI feedback with background API call
  const result = await reactionsStore.toggleReaction(props.message.id, emojiId, currentUserId.value);
  
  // Log result but don't show error for duplicate requests (they're expected)
  if (!result.success && result.reason !== 'Request already in progress') {
    debug.error('🎯 Failed to toggle reaction:', result.reason);
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
  debug.warn('Failed to load emoji:', emoji);
};

/**
 * Resolve emoji for display using the unified emoji service
 * Handles: unicode, shortcodes, legacy mutant:path format
 */
const getResolvedEmoji = (reactionGroup: any) => {
  const emoji = reactionGroup.emoji;
  if (!emoji) return null;
  
  // Get the identifier to resolve
  const identifier = emoji.content || emoji.name || emoji.id || reactionGroup.emoji_id;
  if (!identifier) return null;
  
  try {
    return resolveEmoji(identifier);
  } catch (e) {
    return null;
  }
};

// Handle add reaction button click
const handleAddReactionClick = (event: MouseEvent) => {
  triggerReaction();
  emit('open-emoji-picker', props.message.id, event);
};

// ✅ UNIFIED ARCHITECTURE: Reactions store is pre-populated by CoreMessageService  
// Components can safely request reactions - store has batch-loaded data, no N+1 queries
onMounted(() => {
  // Skip fetching for optimistic/temp messages
  if (props.message.id.startsWith('temp-') || props.message.sending) {
    debug.log('⏭️ Skipping reaction fetch for optimistic message:', props.message.id);
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
    debug.log('⏭️ Skipping reaction fetch for optimistic message:', newMessageId);
    return;
  }
  
  // Only fetch if message ID actually changed (temp → real)
  if (newMessageId !== oldMessageId && !reactionsStore.isLoadingReactions(newMessageId)) {
    debug.log('🔄 Message ID changed, fetching reactions:', oldMessageId, '→', newMessageId);
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

.native-emoji {
  font-size: 16px;
  line-height: 1;
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


.add-reaction-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  padding: 0;
  background-color: transparent;
  border: 1px dashed rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.4);
  transition: all 0.15s ease-out;
  flex-shrink: 0;
}

.add-reaction-btn:hover {
  background-color: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.3);
  color: rgba(255, 255, 255, 0.7);
}

.add-reaction-btn:active {
  transform: scale(0.95);
}

.add-reaction-btn svg {
  width: 14px;
  height: 14px;
}

@media (max-width: 768px) {
  .reactions-gutter {
    width: 48px;
  }
}
</style>
