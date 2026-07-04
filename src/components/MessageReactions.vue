<template>
  <div v-if="showReactions && (reactions.length > 0 || isLoadingReactions)" class="message-reactions" data-testid="message-reactions">
    <div class="reactions-gutter"></div>
    <TransitionGroup name="reaction-list" tag="div" class="reactions-container">
      <div
        v-for="reactionGroup in reactions"
        :key="getReactionKey(reactionGroup)"
        class="reaction"
        :class="{ 
          'reacted': reactionGroup.current_user_reacted,
          'loading': isLoadingReactions 
        }"
        @click="handleReactionClick(reactionGroup.emoji, getReactionKey(reactionGroup))"
        @mouseenter="showTooltip($event, reactionGroup)"
        @mouseleave="hideTooltip"
      >
        <!-- Custom server emoji with URL (priority) -->
        <template v-if="reactionGroup.emoji?.url && !(reactionGroup.emoji as any)?.is_native">
          <Icon 
            v-if="brokenEmojiUrls.has(reactionGroup.emoji.url)" 
            name="image-off" 
            class="reaction-emoji-broken"
            :title="reactionGroup.emoji.name || 'Broken emoji'"
          />
          <img 
            v-else
            :src="getEmojiUrl(reactionGroup.emoji.url, 32)" 
            :alt="reactionGroup.emoji.name || 'emoji'"
            class="reaction-emoji"
            @error="handleEmojiError(reactionGroup.emoji)"
          />
        </template>
        <!-- Resolved emoji (native unicode or pack SVG) -->
        <template v-else-if="getResolvedEmoji(reactionGroup)">
          <img 
            v-if="getResolvedEmoji(reactionGroup)!.display.type === 'svg'"
            :src="getResolvedEmoji(reactionGroup)!.display.content"
            :alt="getResolvedEmoji(reactionGroup)!.shortcode || 'emoji'"
            class="reaction-emoji"
          />
          <span v-else class="native-emoji">{{ getResolvedEmoji(reactionGroup)!.display.content }}</span>
        </template>
        <!-- Fallback for missing emoji -->
        <span v-else class="missing-emoji" :title="`Emoji: ${reactionGroup.emoji?.name || reactionGroup.emoji_id}`">?</span>
        <span class="reaction-count" data-testid="reaction-count">{{ reactionGroup.count }}</span>
      </div>
      
      <!-- Add reaction button (only shown when reactions exist) -->
      <button 
        v-if="reactions.length > 0"
        key="add-reaction-btn"
        class="add-reaction-btn"
        data-testid="add-reaction-btn"
        @click="handleAddReactionClick"
        title="Add Reaction"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="16"/>
          <line x1="8" y1="12" x2="16" y2="12"/>
        </svg>
      </button>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch, nextTick } from 'vue';
import { debug } from '@/utils/debug'
import { useReactionsStore } from '@/stores/useReactions';
import { useProfileStore } from '@/stores/useProfile';
import { useThemeStore } from '@/stores/useTheme';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { useUnifiedEmoji } from '@/services/unifiedEmojiService';
import { getEmojiUrl } from '@/utils/emojiUtils';
import Icon from '@/components/common/Icon.vue';
import type { Message, Emoji } from '@/types';

interface Props {
  message: Message;
  showReactions?: boolean;
}

interface Emits {
  (e: 'show-reaction-tooltip', event: MouseEvent, reactionGroup: any): void;
  (e: 'hide-reaction-tooltip'): void;
  (e: 'open-emoji-picker', messageId: string, event: MouseEvent): void;
  (e: 'layout-change', messageId: string): void;
}

const props = withDefaults(defineProps<Props>(), {
  showReactions: true
});

const emit = defineEmits<Emits>();

const getReactionKey = (reactionGroup: any): string => {
  if (reactionGroup.emoji_id) return reactionGroup.emoji_id
  return reactionGroup.emoji?.name || 'unknown'
};

const reactionsStore = useReactionsStore();
const profileStore = useProfileStore();
const themeStore = useThemeStore();
const { triggerReaction } = useHapticSettings();
const { recordEmojiUsage } = useFrequentEmojis();
const { resolveEmoji } = useUnifiedEmoji();

// UNIFIED ARCHITECTURE: Always use reactions store (populated by CoreMessageService)
const reactions = computed(() => {
  try {
    return reactionsStore.getMessageReactions(props.message.id);
  } catch (error) {
    debug.error('❌ Error getting reactions for message:', props.message.id, error);
    return [];
  }
});

const isLoadingReactions = computed(() => 
  reactionsStore.isLoadingReactions(props.message.id)
);

// Reactions are keyed on profiles.id, so the "reacted" highlight must compare
// against the profile id (using the auth id makes our own reaction flicker off
// when optimistic state reconciles).
const currentUserId = computed(() => profileStore.profileId);

// Check if current user has reacted to a specific emoji
// Handle reaction toggle ( instant feedback)
const handleReactionClick = async (emoji: Emoji, emojiId: string) => {
  if (!currentUserId.value) return;
  
  // Dismiss tooltip immediately so it doesn't linger if the chip is removed from DOM
  emit('hide-reaction-tooltip');
  
  themeStore.playAudio('reaction');
  triggerReaction();
  
  recordEmojiUsage({
    id: emojiId,
    name: emoji.name || emojiId,
    url: emoji.url
  });
  
  const result = await reactionsStore.toggleReaction(props.message.id, emojiId, currentUserId.value, emoji);
  
  if (!result.success && result.reason !== 'Request already in progress') {
    debug.error('🎯 Failed to toggle reaction:', result.reason);
  }
};

const showTooltip = (event: MouseEvent, reactionGroup: any) => {
  emit('show-reaction-tooltip', event, reactionGroup);
};

const hideTooltip = () => {
  emit('hide-reaction-tooltip');
};

const brokenEmojiUrls = ref(new Set<string>());

const handleEmojiError = (emoji: Emoji) => {
  debug.warn('Failed to load emoji:', emoji);
  if (emoji?.url) brokenEmojiUrls.value.add(emoji.url);
};

/**
 * Resolve emoji for display using the unified emoji service
 * Handles: unicode, shortcodes
 */
const getResolvedEmoji = (reactionGroup: any) => {
  const emoji = reactionGroup.emoji;
  if (!emoji) return null;
  
  const identifier = emoji.content || emoji.name || emoji.id || reactionGroup.emoji_id;
  if (!identifier) return null;
  
  try {
    return resolveEmoji(identifier);
  } catch (e) {
    return null;
  }
};

// Handle add reaction button click (haptic fires on emoji selection, not popup open)
const handleAddReactionClick = (event: MouseEvent) => {
  emit('open-emoji-picker', props.message.id, event);
};

// UNIFIED ARCHITECTURE: Reactions store is pre-populated by batch loading in MessageDisplay
// Individual components should only fetch if data is missing (batch loading handles most cases)
onMounted(() => {
  // Skip fetching for optimistic/temp messages
  if (props.message.id.startsWith('temp-') || props.message.sending) {
    return;
  }
  
  // Only fetch individually if:
  // 1. Not already loading (avoid duplicate requests)
  // 2. Not already cached (batch loading should have populated this)
  const hasCachedReactions = reactionsStore.getMessageReactions(props.message.id).length > 0;
  if (!reactionsStore.isLoadingReactions(props.message.id) && !hasCachedReactions) {
    // Fallback: fetch individually if batch loading missed this message
    reactionsStore.fetchMessageReactions(props.message.id);
  }
});

// Reactions change row height (virtual list); parent must remeasure.
watch(
  () => reactions.value.map(g => `${getReactionKey(g)}:${g.count}`).join(','),
  () => {
    nextTick(() => emit('layout-change', props.message.id));
  },
);

watch(() => isLoadingReactions.value, (loading, wasLoading) => {
  if (wasLoading && !loading) {
    nextTick(() => emit('layout-change', props.message.id));
  }
});

// Watch for message changes and reload reactions if needed
watch(() => props.message.id, (newMessageId, oldMessageId) => {
  // Skip if it's a temp message or optimistic message
  if (newMessageId.startsWith('temp-') || props.message.sending) {
    return;
  }
  
  // Only fetch if message ID actually changed (temp → real) and data is missing
  if (newMessageId !== oldMessageId) {
    const hasCachedReactions = reactionsStore.getMessageReactions(newMessageId).length > 0;
    if (!reactionsStore.isLoadingReactions(newMessageId) && !hasCachedReactions) {
      // Fallback: fetch individually if batch loading missed this message
      reactionsStore.fetchMessageReactions(newMessageId);
    }
  }
});
</script>

<style scoped>
.message-reactions {
  display: flex;
  margin: 6px 4px 8px 4px;
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
  background-color: var(--background-quinary);
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.875rem;
  transition: background-color 0.15s ease-out, border-color 0.15s ease-out, opacity 0.15s ease-out, transform 0.15s ease-out;
  user-select: none;
  min-height: 22px;
}

.reaction:active {
  transform: scale(0.92);
}

.reaction:hover {
  background-color: var(--harmony-primary-alpha);
  border-color: var(--harmony-primary-alpha-strong);
}

.reaction.reacted {
  /* background-color: hsl(235, 85.6%, 64.7%, 0.15); */
  /* border-color: hsl(235, 85.6%, 64.7%); */
  background-color: var(--harmony-primary-alpha);
  border-color: var(--harmony-primary);
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
  color: var(--text-muted);
  min-width: 9px;
  text-align: center;
}

.reaction.reacted .reaction-count {
  color: var(--text-primary);
}

.reaction-emoji-broken {
  width: 16px;
  height: 16px;
  color: var(--text-muted);
  opacity: 0.5;
  flex-shrink: 0;
}

.missing-emoji {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--background-quinary);
  border-radius: 3px;
  font-size: 10px;
  color: var(--text-muted);
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
  border: 2px solid var(--background-quinary);
  border-top: 2px solid #0EA5E9;
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

/* TransitionGroup animations for smooth reaction chip add/remove */
.reaction-list-enter-active {
  animation: reaction-pop-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.reaction-list-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.reaction-list-enter-from {
  opacity: 0;
  transform: scale(0.5);
}

.reaction-list-leave-to {
  opacity: 0;
  transform: scale(0.7);
}

.reaction-list-move {
  transition: transform 0.2s ease;
}

@keyframes reaction-pop-in {
  0% { opacity: 0; transform: scale(0.5); }
  70% { opacity: 1; transform: scale(1.08); }
  100% { opacity: 1; transform: scale(1); }
}
</style>
