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
        :key="reaction.emoji_id || reaction.emoji_name || reaction.custom_emoji_content"
        class="reaction"
        :class="{ 
          'reacted': reaction.current_user_reacted,
          'loading': isLoadingReactions,
          'has-reactors': reaction.reactors && reaction.reactors.length > 0
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
        
        <!-- Reactor avatars (for remote reactions) -->
        <div v-if="reaction.reactors && reaction.reactors.length > 0" class="reactor-avatars">
          <img 
            v-for="(reactor, idx) in reaction.reactors.slice(0, 3)" 
            :key="idx"
            :src="reactor.avatar_url || '/default_avatar.png'"
            :alt="reactor.display_name"
            :title="`${reactor.display_name} (@${reactor.username}@${reactor.domain})`"
            class="reactor-avatar"
          />
          <span v-if="reaction.reaction_count > 3" class="reactor-more">
            +{{ reaction.reaction_count - 3 }}
          </span>
        </div>
        
        <!-- Count (show if no reactor avatars or as fallback) -->
        <span v-else class="reaction-count">{{ reaction.reaction_count }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/useTheme';
import { usePostReactionsStore } from '@/stores/postReactions';
import { supabase } from '@/supabase';
import type { TimelinePost } from '@/types';

interface Reactor {
  username: string
  display_name: string
  avatar_url: string
  domain: string
}

interface PostEmojiReaction {
  emoji_id: string | null
  emoji_name: string | null
  emoji_url?: string | null
  custom_emoji_content?: string | null
  reaction_count: number
  user_reactions: Array<{
    user_id: string
    username: string
    display_name: string
    avatar_url: string
    created_at: string
  }>
  current_user_reacted: boolean
  reactors?: Reactor[] // Remote reactors from federation
}

interface Props {
  post: TimelinePost;
  showReactions?: boolean;
}

interface Emits {
  (e: 'show-reaction-tooltip', event: MouseEvent, reaction: PostEmojiReaction): void;
  (e: 'hide-reaction-tooltip'): void;
}

const props = withDefaults(defineProps<Props>(), {
  showReactions: true,
});

const emit = defineEmits<Emits>();

const authStore = useAuthStore();
const themeStore = useThemeStore();
const postReactionsStore = usePostReactionsStore();

// Use store-based reactions with safety checks, also include remote reactions from metadata
const reactions = computed(() => {
  if (!props.post?.id) return [];
  
  // Get local reactions from store
  const storeReactions = postReactionsStore.getPostReactions(props.post.id);
  const localReactions = Array.isArray(storeReactions) ? storeReactions : [];
  
  // Check for remote reactions in post metadata (from federated fetch)
  const remoteReactions = props.post?.metadata?.remote_reactions;
  if (!remoteReactions || typeof remoteReactions !== 'object') {
    return localReactions;
  }
  
  // Convert remote reactions to the same format and merge with local
  // Format can be either { emoji: count } (old) or { emoji: { count, url, reactors } } (new)
  const remoteReactionGroups: PostEmojiReaction[] = Object.entries(remoteReactions).map(([emoji, value]) => {
    // Handle both formats
    const count = typeof value === 'number' ? value : (value as any)?.count || 0;
    const url = typeof value === 'object' ? (value as any)?.url : null;
    const reactors = typeof value === 'object' ? (value as any)?.reactors : [];
    
    // Check if it's a custom emoji (starts and ends with :)
    const isCustomEmoji = emoji.startsWith(':') && emoji.endsWith(':');
    
    return {
      emoji_id: null,
      emoji_name: emoji,
      emoji_url: url || null, // Use the URL from the fetched data
      // For custom emojis without URL, show the emoji name; for unicode, show the emoji itself
      custom_emoji_content: isCustomEmoji ? (url ? null : emoji) : emoji,
      reaction_count: count,
      user_reactions: [], // Remote reactions don't have individual user data in this format
      current_user_reacted: false,
      reactors: reactors || [], // Include reactor info for tooltip/display
    };
  });
  
  // Merge: local reactions take priority, add remote ones that don't exist locally
  const mergedReactions = [...localReactions];
  for (const remote of remoteReactionGroups) {
    const existingIndex = mergedReactions.findIndex(r => 
      r.emoji_name === remote.emoji_name
    );
    
    if (existingIndex === -1) {
      // Add remote reaction if not in local
      mergedReactions.push(remote);
    } else {
      // Use the higher count between local and remote
      if (remote.reaction_count > mergedReactions[existingIndex].reaction_count) {
        mergedReactions[existingIndex].reaction_count = remote.reaction_count;
      }
      // Also use the URL if we have one and the existing doesn't
      if (remote.emoji_url && !mergedReactions[existingIndex].emoji_url) {
        mergedReactions[existingIndex].emoji_url = remote.emoji_url;
      }
    }
  }
  
  return mergedReactions;
});
const isLoadingReactions = computed(() => {
  if (!props.post?.id) return false;
  return postReactionsStore.isLoadingReactions(props.post.id);
});

// Get current user ID
const currentUserId = computed(() => 
  authStore.session?.user?.id
);

// REMOVED: Individual reaction loading - now handled by batch fetch from timeline
// This prevents N+1 queries by relying on batch fetch from the parent timeline

// Handle reaction click (add/remove) using the store
const handleReactionClick = async (reaction: PostEmojiReaction) => {
  if (!currentUserId.value) {
    debug.warn('User not authenticated');
    return;
  }
  
  // Safety check for reaction object
  if (!reaction || typeof reaction !== 'object') {
    debug.warn('Invalid reaction object:', reaction);
    return;
  }
  
  try {
    // Play audio feedback immediately for better UX
    try {
      await themeStore.testAudio('reaction');
    } catch (audioError) {
      debug.warn('Failed to play reaction audio:', audioError);
      // Don't block the reaction if audio fails
    }
    
    // Use the store to toggle the reaction
    const emoji = {
      id: reaction.emoji_id,
      native: reaction.custom_emoji_content,
      name: reaction.emoji_name,
      url: reaction.emoji_url
    };
    
    const result = await postReactionsStore.toggleReaction(
      props.post.id,
      emoji,
      currentUserId.value
    );
    
    if (result.success) {
      const action = reaction.current_user_reacted ? 'Removed' : 'Added';
      debug.log(`${action === 'Added' ? '➕' : '➖'} ${action} reaction ${reaction.emoji_name} to post ${props.post.id}`);
    } else {
      debug.warn('Failed to toggle reaction:', result.reason);
    }
    
  } catch (error) {
    debug.error('Failed to toggle reaction:', error);
    // Play error sound if available
    try {
      await themeStore.testAudio('ui_error');
    } catch (audioError) {
      debug.warn('Failed to play error audio:', audioError);
    }
  }
};

// Show reaction tooltip with user details
const showTooltip = (event: MouseEvent, reaction: PostEmojiReaction) => {
  emit('show-reaction-tooltip', event, reaction);
};

// Hide reaction tooltip
const hideTooltip = () => {
  emit('hide-reaction-tooltip');
};

// Handle emoji loading errors
const handleEmojiError = (reaction: PostEmojiReaction) => {
  debug.warn('Failed to load emoji:', reaction);
};

// Handle emoji selection from parent components (like MonyPost)
const handleEmojiSelected = async (emoji: any): Promise<boolean> => {
  if (!currentUserId.value) {
    debug.warn('User not authenticated');
    return false;
  }
  
  try {
    const result = await postReactionsStore.toggleReaction(
      props.post.id,
      emoji,
      currentUserId.value
    );
    
    if (result.success) {
      debug.log(`➕ Added reaction ${emoji.name} to post ${props.post.id}`);
      return true;
    } else {
      debug.warn('Failed to add reaction:', result.reason);
      return false;
    }
    
  } catch (error) {
    debug.error('Failed to add emoji reaction:', error);
    return false;
  }
};

// Load reactions when component mounts
onMounted(() => {
  // REMOVED individual loading - rely on batch fetch from timeline for performance
  // loadReactions();
  
  // Subscribe to realtime updates for emoji reactions on this post
  const channel = supabase
    .channel(`post_reactions_${props.post.id}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'post_interactions',
        filter: `post_id=eq.${props.post.id}`
      },
      (payload) => {
        debug.log('🔔 Realtime reaction update:', payload);
        // Use store's realtime handler for proper optimistic state management
        if (payload.new?.interaction_type === 'emoji_reaction' || 
            payload.old?.interaction_type === 'emoji_reaction') {
          postReactionsStore.handleRealtimeUpdate(payload);
        }
      }
    )
    .subscribe();

  // Cleanup subscription on unmount
  onUnmounted(() => {
    supabase.removeChannel(channel);
  });
});

// REMOVED: Individual loading on post change - batch fetch handles this
// Reload reactions when post changes
// watch(() => props.post.id, () => {
//   if (props.post.id) {
//     loadReactions();
//   }
// });

// Expose methods for parent components (removed loadReactions since it's handled by batch fetch)
defineExpose({
  handleEmojiSelected
});
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
  max-width: 64px;
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

/* Reactor avatars */
.reactor-avatars {
  display: flex;
  align-items: center;
  gap: -4px; /* Overlap avatars slightly */
}

.reactor-avatar {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--background-primary);
  margin-left: -4px;
  transition: transform 0.15s ease;
}

.reactor-avatar:first-child {
  margin-left: 0;
}

.reactor-avatar:hover {
  transform: scale(1.15);
  z-index: 1;
}

.reactor-more {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-left: 2px;
  white-space: nowrap;
}

.reaction.has-reactors {
  padding-right: 6px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
</style>
