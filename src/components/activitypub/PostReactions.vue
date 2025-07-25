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
import { computed, onMounted, onUnmounted, watch, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/useTheme';
import { supabase } from '@/supabase';
import type { TimelinePost } from '@/types';

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

// Reactive state
const reactions = ref<PostEmojiReaction[]>([]);
const isLoadingReactions = ref(false);

// Get current user ID
const currentUserId = computed(() => 
  authStore.session?.user?.id
);

// Load reactions for this post
const loadReactions = async () => {
  if (!props.post?.id) return;
  
  isLoadingReactions.value = true;
  try {
    const { data, error } = await supabase.rpc('get_post_emoji_reactions', {
      p_post_id: props.post.id,
      p_user_limit: 5
    });

    if (error) {
      console.error('Failed to load post reactions:', error);
      return;
    }

    // Transform database response to component format
    reactions.value = (data || []).map((item: any) => ({
      emoji_id: item.emoji_id,
      emoji_name: item.emoji_name,
      emoji_url: item.emoji_url,
      custom_emoji_content: item.custom_emoji_content,
      reaction_count: item.reaction_count,
      user_reactions: item.user_reactions || [],
      current_user_reacted: item.current_user_reacted
    }));

    console.log(`📊 Loaded ${reactions.value.length} reaction types for post ${props.post.id}`);
  } catch (error) {
    console.error('Error loading post reactions:', error);
  } finally {
    isLoadingReactions.value = false;
  }
};

// Handle reaction click (add/remove)
const handleReactionClick = async (reaction: PostEmojiReaction) => {
  if (!currentUserId.value) {
    console.warn('User not authenticated');
    return;
  }
  
  try {
    // Play audio feedback immediately for better UX
    try {
      await themeStore.testAudio('reaction');
    } catch (audioError) {
      console.warn('Failed to play reaction audio:', audioError);
      // Don't block the reaction if audio fails
    }
    
    if (reaction.current_user_reacted) {
      // Remove reaction
      await supabase.rpc('remove_post_emoji_reaction', {
        p_user_id: currentUserId.value,
        p_post_id: props.post.id,
        p_emoji_id: reaction.emoji_id || null,
        p_custom_emoji_content: reaction.custom_emoji_content || null
      });
      console.log(`➖ Removed reaction ${reaction.emoji_name} from post ${props.post.id}`);
    } else {
      // Add reaction
      await supabase.rpc('add_post_emoji_reaction', {
        p_user_id: currentUserId.value,
        p_post_id: props.post.id,
        p_emoji_id: reaction.emoji_id || null,
        p_custom_emoji_content: reaction.custom_emoji_content || null
      });
      console.log(`➕ Added reaction ${reaction.emoji_name} to post ${props.post.id}`);
    }
    
    // Reload reactions to show updated state
    await loadReactions();
    
  } catch (error) {
    console.error('Failed to toggle reaction:', error);
    // Play error sound if available
    try {
      await themeStore.testAudio('ui_error');
    } catch (audioError) {
      console.warn('Failed to play error audio:', audioError);
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
  console.warn('Failed to load emoji:', reaction);
};

// Load reactions when component mounts
onMounted(() => {
  loadReactions();
  
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
        console.log('🔔 Realtime reaction update:', payload);
        // Reload reactions when any interaction changes for this post
        if (payload.new?.interaction_type === 'emoji_reaction' || 
            payload.old?.interaction_type === 'emoji_reaction') {
          loadReactions();
        }
      }
    )
    .subscribe();

  // Cleanup subscription on unmount
  onUnmounted(() => {
    supabase.removeChannel(channel);
  });
});

// Reload reactions when post changes
watch(() => props.post.id, () => {
  if (props.post.id) {
    loadReactions();
  }
});

// Expose methods for parent components
defineExpose({
  loadReactions
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
