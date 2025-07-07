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
      await reactionsStore.toggleReaction(props.message.id, emoji.id, currentUserId.value);
    };

    // Show reaction tooltip
    const showTooltip = (event: MouseEvent, reactionGroup: any) => {
      emit('show-reaction-tooltip', event, reactionGroup);
    };

    // Hide reaction tooltip
    const hideTooltip = () => {
      emit('hide-reaction-tooltip');
    };

    // Load reactions when component mounts
    onMounted(() => {
      reactionsStore.fetchMessageReactions(props.message.id);
    });

    // Watch for message changes and reload reactions if needed
    watch(() => props.message.id, (newMessageId) => {
      reactionsStore.fetchMessageReactions(newMessageId);
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
