import { defineComponent, computed, onMounted, watch } from 'vue';
import { useReactionsStore } from '@/stores/useReactions';
import { useProfileStore } from '@/stores/useProfile';
import type { Message, Emoji } from '@/types';
import { debug } from '@/utils/debug'

interface Props {
  message: Message;
  showReactions?: boolean;
}

export default defineComponent({
  props: {
    message: {
      type: Object as () => Message,
      required: true
    },
    showReactions: {
      type: Boolean,
      default: true
    }
  },
  emits: ['toggle-reaction', 'show-reaction-tooltip', 'hide-reaction-tooltip'],
  setup(props: Props, { emit }: { emit: any }) {
    const reactionsStore = useReactionsStore();
    const profileStore = useProfileStore();

    // UNIFIED ARCHITECTURE: Always use reactions store (populated by CoreMessageService)
    const reactions = computed(() => 
      reactionsStore.getMessageReactions(props.message.id)
    );

    // Check if reactions are loading
    const isLoadingReactions = computed(() => 
      reactionsStore.isLoadingReactions(props.message.id)
    );

    // Reactions are keyed by the user's PROFILE id (profiles.id), not the auth
    // user id, so the highlight check must use the profile id.
    const currentUserId = computed(() => 
      profileStore.profile?.id
    );

    // Check if current user has reacted to a specific emoji
    const hasUserReacted = (emojiId: string) => {
      if (!currentUserId.value) return false;
      return reactionsStore.hasUserReacted(props.message.id, emojiId, currentUserId.value);
    };

    // Handle reaction toggle
    const handleReactionClick = async (emoji: Emoji) => {
      if (!currentUserId.value) return;
      
      emit('toggle-reaction', props.message.id, emoji);
      
      // Optimistically update via the store
      const result = await reactionsStore.toggleReaction(props.message.id, emoji.id, currentUserId.value);
      
      // Log result but don't show error for duplicate requests (they're expected)
      if (!result.success && result.reason !== 'duplicate_request') {
        debug.error('🎯 Failed to toggle reaction:', (result as any).message || result.reason);
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

    // UNIFIED ARCHITECTURE: Store is pre-populated by CoreMessageService
    // Safe to request reactions - will use cached data, no N+1 queries
    onMounted(() => {
      if (!reactionsStore.isLoadingReactions(props.message.id)) {
        reactionsStore.fetchMessageReactions(props.message.id);
      }
    });

    // Watch for message changes and reload reactions if needed
    watch(() => props.message.id, (newMessageId) => {
      if (!reactionsStore.isLoadingReactions(newMessageId)) {
        reactionsStore.fetchMessageReactions(newMessageId);
      }
    });

    return {
      reactions,
      isLoadingReactions,
      hasUserReacted,
      handleReactionClick,
      showTooltip,
      hideTooltip,
    };
  }
});
