import { computed, onMounted, watch } from 'vue'
import { usePostReactionsStore } from '@/stores/postReactions'
import { useAuthStore } from '@/stores/auth'
import type { TimelinePost } from '@/types'

interface Props {
  post: TimelinePost
  showReactions?: boolean
}

/**
 * Post Reactions Composable - Professional Architecture
 * 
 * Follows the same pattern as useMessageReactions.ts
 * Key benefits:
 * 1. Centralized reaction logic
 * 2. Optimistic updates for instant feedback
 * 3. Automatic batch loading integration
 * 4. Consistent API with chat reactions
 */
export function usePostReactions(props: Props) {
  const postReactionsStore = usePostReactionsStore()
  const authStore = useAuthStore()

  // Always use reactions store (populated by batch loading)
  const reactions = computed(() => 
    postReactionsStore.getPostReactions(props.post.id)
  )

  // Check if reactions are loading
  const isLoadingReactions = computed(() => 
    postReactionsStore.isLoadingReactions(props.post.id)
  )

  // Get current user ID
  const currentUserId = computed(() => 
    authStore.session?.user?.id
  )

  // Check if current user has reacted to a specific emoji
  const hasUserReacted = (emojiId: string | null, customContent: string | null) => {
    return postReactionsStore.hasUserReacted(props.post.id, emojiId, customContent)
  }

  // Handle reaction toggle
  const handleReactionClick = async (reaction: any) => {
    if (!currentUserId.value) {
      console.warn('User not authenticated')
      return
    }
    
    const result = await postReactionsStore.toggleReaction(
      props.post.id, 
      {
        id: reaction.emoji_id,
        native: reaction.custom_emoji_content,
        name: reaction.emoji_name
      },
      currentUserId.value
    )
    
    if (!result.success && result.reason !== 'duplicate_request') {
      console.error('Failed to toggle reaction:', result.reason)
    }
  }

  // Handle adding new reaction from emoji picker
  const handleEmojiSelected = async (emoji: any) => {
    if (!currentUserId.value) {
      console.warn('User not authenticated')
      return
    }
    
    const result = await postReactionsStore.toggleReaction(
      props.post.id,
      {
        id: emoji.id,
        native: emoji.native || emoji.name,
        name: emoji.name
      },
      currentUserId.value
    )
    
    if (!result.success && result.reason !== 'duplicate_request') {
      console.error('Failed to add reaction:', result.reason)
    }
    
    return result.success
  }

  // Format reaction count with "and X others" pattern
  const formatReactionTooltip = (reaction: any) => {
    const userReactions = reaction.user_reactions || []
    const count = reaction.reaction_count || 0
    
    if (count === 0) return ''
    
    if (count <= 5) {
      const names = userReactions.map((ur: any) => ur.display_name || ur.username).join(', ')
      return `${names} reacted with ${reaction.emoji_name || reaction.custom_emoji_content}`
    }
    
    const visibleUsers = userReactions.slice(0, 5)
    const names = visibleUsers.map((ur: any) => ur.display_name || ur.username).join(', ')
    const others = count - 5
    
    return `${names} and ${others} others reacted with ${reaction.emoji_name || reaction.custom_emoji_content}`
  }

  // Store is pre-populated by batch loading from timeline
  // Safe to request reactions - will use cached data, no N+1 queries
  onMounted(() => {
    if (!postReactionsStore.isLoadingReactions(props.post.id)) {
      postReactionsStore.fetchPostReactions(props.post.id)
    }
  })

  // Watch for post changes and reload reactions if needed
  watch(() => props.post.id, (newPostId) => {
    if (!postReactionsStore.isLoadingReactions(newPostId)) {
      postReactionsStore.fetchPostReactions(newPostId)
    }
  })

  return {
    reactions,
    isLoadingReactions,
    hasUserReacted,
    handleReactionClick,
    handleEmojiSelected,
    formatReactionTooltip,
    currentUserId
  }
}
