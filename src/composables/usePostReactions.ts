import { computed } from 'vue'
import { usePostReactionsStore } from '@/stores/postReactions'
import { useAuthStore } from '@/stores/auth'
import type { TimelinePost } from '@/types'
import { debug } from '@/utils/debug'

interface Props {
  post: TimelinePost
  showReactions?: boolean
}

/**
 * Reads reaction state from the store (batch-populated by timeline loaders).
 * Does NOT fetch per-post - that's handled by useActivityPub / PostView via
 * fetchMultiplePostReactions(). This avoids N+1 request storms during scroll.
 */
export function usePostReactions(props: Props) {
  const postReactionsStore = usePostReactionsStore()
  const authStore = useAuthStore()

  const reactions = computed(() => 
    postReactionsStore.getPostReactions(props.post.id)
  )

  const isLoadingReactions = computed(() => 
    postReactionsStore.isLoadingReactions(props.post.id)
  )

  const currentUserId = computed(() => 
    authStore.session?.user?.id
  )

  const hasUserReacted = (emojiId: string | null, customContent: string | null) => {
    return postReactionsStore.hasUserReacted(props.post.id, emojiId, customContent)
  }

  const handleReactionClick = async (reaction: any) => {
    if (!currentUserId.value) {
      debug.warn('User not authenticated')
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
      debug.error('Failed to toggle reaction:', result.reason)
    }
  }

  const handleEmojiSelected = async (emoji: any) => {
    if (!currentUserId.value) {
      debug.warn('User not authenticated')
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
      debug.error('Failed to add reaction:', result.reason)
    }
    
    return result.success
  }

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
