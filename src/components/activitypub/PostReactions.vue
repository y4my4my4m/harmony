<template>
  <div v-if="reactions.length > 0" class="post-reactions" data-testid="post-reactions">
    <TransitionGroup name="reaction-list" tag="div" class="reactions-container">
      <div v-if="isLoadingReactions && reactions.length === 0" key="loading" class="reaction-loading">
        <LoadingSpinner :size="16" />
      </div>

      <div
        v-for="reaction in reactions"
        :key="(reaction.emoji_id || reaction.emoji_name || reaction.custom_emoji_content) ?? undefined"
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
        <template v-if="reaction.emoji_url">
          <Icon 
            v-if="brokenEmojiUrls.has(reaction.emoji_url)" 
            name="image-off" 
            class="reaction-emoji-broken"
            :title="reaction.emoji_name || 'Broken emoji'"
          />
          <img 
            v-else
            :src="getEmojiUrl(reaction.emoji_url, 32)" 
            :alt="reaction.emoji_name || 'emoji'"
            class="reaction-emoji"
            @error="handleEmojiError(reaction)"
          />
        </template>
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
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { debug } from '@/utils/debug'
import { useProfileStore } from '@/stores/useProfile';
import { useThemeStore } from '@/stores/useTheme';
import { usePostReactionsStore } from '@/stores/postReactions';
import { useHapticSettings } from '@/composables/useHapticSettings';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import { postReactionsRealtime } from '@/services/PostReactionsRealtime';
import Icon from '@/components/common/Icon.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import type { TimelinePost } from '@/types';

interface Reactor {
  username: string
  display_name: string
  display_name_emojis?: Array<{name: string, url: string}>
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

const profileStore = useProfileStore();
const themeStore = useThemeStore();
const postReactionsStore = usePostReactionsStore();
const { triggerReaction } = useHapticSettings();
const { recordEmojiUsage } = useFrequentEmojis();

// Strip @domain from shortcodes for comparison: ":name@domain:" → ":name:"
const normalizeEmojiKey = (name: string | null | undefined): string => {
  if (!name) return '';
  return name.replace(/@[\w.-]+(?=:$)/, '');
};

const reactions = computed(() => {
  if (!props.post?.id) return [];
  
  const storeReactions = postReactionsStore.getPostReactions(props.post.id);
  const localReactions = Array.isArray(storeReactions) ? storeReactions : [];
  
  const remoteReactions = props.post?.metadata?.remote_reactions;
  if (!remoteReactions || typeof remoteReactions !== 'object') {
    return localReactions;
  }
  
  const remoteReactionGroups: PostEmojiReaction[] = Object.entries(remoteReactions).map(([emoji, value]) => {
    const count = typeof value === 'number' ? value : (value as any)?.count || 0;
    const url = typeof value === 'object' ? (value as any)?.url : null;
    const reactors = typeof value === 'object' ? (value as any)?.reactors : [];
    const isCustomEmoji = emoji.startsWith(':') && emoji.endsWith(':');
    
    return {
      emoji_id: null,
      emoji_name: emoji,
      emoji_url: url || null,
      custom_emoji_content: isCustomEmoji ? (url ? null : emoji) : emoji,
      reaction_count: count,
      user_reactions: [],
      current_user_reacted: false,
      reactors: reactors || [],
    };
  });
  
  // Local reactions take priority; emoji keys normalized so ":name@domain:" matches ":name:".
  const mergedReactions = [...localReactions];
  for (const remote of remoteReactionGroups) {
    const remoteKey = normalizeEmojiKey(remote.emoji_name);
    const existingIndex = mergedReactions.findIndex(r => {
      if (normalizeEmojiKey(r.emoji_name) === remoteKey) return true;
      if (r.custom_emoji_content && normalizeEmojiKey(r.custom_emoji_content) === remoteKey) return true;
      if (r.emoji_url && remote.emoji_url && r.emoji_url === remote.emoji_url) return true;
      return false;
    });
    
    if (existingIndex === -1) {
      mergedReactions.push(remote as any);
    } else {
      const target = mergedReactions[existingIndex] as any;
      if (remote.reaction_count > target.reaction_count) {
        target.reaction_count = remote.reaction_count;
      }
      if (remote.emoji_url && !target.emoji_url) {
        target.emoji_url = remote.emoji_url;
      }
      if (remote.reactors && remote.reactors.length > 0 && (!target.reactors || target.reactors!.length === 0)) {
        target.reactors = remote.reactors;
      }
    }
  }
  
  return mergedReactions;
});
const isLoadingReactions = computed(() => {
  if (!props.post?.id) return false;
  return postReactionsStore.isLoadingReactions(props.post.id);
});

// App data (reactions) keys on profiles.id, not the auth user id.
const currentUserId = computed(() => 
  profileStore.profileId
);

const handleReactionClick = async (reaction: PostEmojiReaction) => {
  if (!currentUserId.value) {
    debug.warn('User not authenticated');
    return;
  }
  
  if (!reaction || typeof reaction !== 'object') {
    debug.warn('Invalid reaction object:', reaction);
    return;
  }
  
  try {
    triggerReaction();

    recordEmojiUsage({
      id: reaction.emoji_id || reaction.emoji_name || '',
      native: reaction.custom_emoji_content || undefined,
      name: reaction.emoji_name || '',
      url: reaction.emoji_url || undefined
    });
    
    try {
      await themeStore.playAudio('reaction');
    } catch (audioError) {
      debug.warn('Failed to play reaction audio:', audioError);
    }

    // Fields may be null from remote/legacy data shape; coerce to undefined for store API.
    const emoji = {
      id: reaction.emoji_id ?? undefined,
      native: reaction.custom_emoji_content ?? undefined,
      name: reaction.emoji_name ?? undefined,
      url: reaction.emoji_url ?? undefined,
    };

    const result = await postReactionsStore.toggleReaction(
      props.post.id,
      emoji,
      currentUserId.value
    );
    
    if (result.success) {
      const action = reaction.current_user_reacted ? 'Removed' : 'Added';
      debug.log(`${action === 'Added' ? '' : ''} ${action} reaction ${reaction.emoji_name} to post ${props.post.id}`);
    } else {
      debug.warn('Failed to toggle reaction:', result.reason);
    }
    
  } catch (error) {
    debug.error('Failed to toggle reaction:', error);
    try {
      await themeStore.playAudio('ui_error');
    } catch (audioError) {
      debug.warn('Failed to play error audio:', audioError);
    }
  }
};

const showTooltip = (event: MouseEvent, reaction: PostEmojiReaction) => {
  emit('show-reaction-tooltip', event, reaction);
};

const hideTooltip = () => {
  emit('hide-reaction-tooltip');
};

const brokenEmojiUrls = ref(new Set<string>());

const handleEmojiError = (reaction: PostEmojiReaction) => {
  debug.warn('Failed to load emoji:', reaction);
  if (reaction?.emoji_url) brokenEmojiUrls.value.add(reaction.emoji_url);
};

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
      debug.log(`Added reaction ${emoji.name} to post ${props.post.id}`);
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

onMounted(() => {
  postReactionsRealtime.subscribe(props.post.id);
});

onUnmounted(() => {
  postReactionsRealtime.unsubscribe(props.post.id);
});

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
  transition: background-color 0.15s ease-out, border-color 0.15s ease-out, opacity 0.15s ease-out, transform 0.15s ease-out;
  user-select: none;
  min-height: 24px;
}

.reaction:active {
  transform: scale(0.92);
}

.reaction:hover {
  background-color: var(--harmony-primary-alpha);
  border-color: var(--harmony-primary-alpha-strong);
}

.reaction.reacted {
  /* background-color: rgba(14, 165, 233, 0.15); */
  background-color: var(--harmony-primary-alpha);
  /* border-color: rgba(14, 165, 233, 0.5); */
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
