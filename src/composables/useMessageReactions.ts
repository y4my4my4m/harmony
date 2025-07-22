import { defineComponent, computed, onMounted, watch } from 'vue';
import { useReactionsStore } from '@/stores/useReactions';
import { useAuthStore } from '@/stores/auth';
import type { Message, Emoji } from '@/types';

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
  setup(props: Props, { emit }: { emit: (event: string, ...args: any[]) => void }) {
    const reactionsStore = useReactionsStore();
    const authStore = useAuthStore();

    // Get reactions for this message
    const reactions = computed(() => 
      reactionsStore.getMessageReactions(props.message.id)
    );

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

    // Handle reaction toggle
    const handleReactionClick = async (emoji: Emoji) => {
      if (!currentUserId.value) return;
      
      emit('toggle-reaction', props.message.id, emoji);
      
      // Optimistically update via the store
      const result = await reactionsStore.toggleReaction(props.message.id, emoji.id, currentUserId.value);
      
      // Log result but don't show error for duplicate requests (they're expected)
      if (!result.success && result.reason !== 'duplicate_request') {
        console.error('🎯 Failed to toggle reaction:', result.message || result.reason);
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

    // ✅ PERFORMANCE FIX: Reactions are already loaded by MessageService
    // Only load if truly missing (handles edge cases)
    onMounted(() => {
      if (!props.message.reactions || props.message.reactions.length === 0) {
        const existingReactions = reactionsStore.getMessageReactions(props.message.id);
        if (existingReactions.length === 0) {
          reactionsStore.fetchMessageReactions(props.message.id);
        }
      }
    });

    // Watch for message changes and reload reactions only if needed
    watch(() => props.message.id, (newMessageId) => {
      const existingReactions = reactionsStore.getMessageReactions(newMessageId);
      if (existingReactions.length === 0 && (!props.message.reactions || props.message.reactions.length === 0)) {
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
