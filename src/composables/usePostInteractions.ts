import { ref } from 'vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { services } from '@/services'
import type { FederatedUser, TimelinePost } from '@/types'
import { debug } from '@/utils/debug'

/**
 * Composable for handling ActivityPub post and user interactions
 * Professional, DRY, and reusable across all components
 * Now using service layer for improved error handling and consistency
 */
export function usePostInteractions() {
  const activityPubStore = useActivityPubStore()
  
  // Loading states
  const isFollowLoading = ref(false)
  const isFavoriteLoading = ref(false)
  const isReblogLoading = ref(false)
  const isBookmarkLoading = ref(false)
  const isPinLoading = ref(false)

  // USER INTERACTIONS

  /**
   * Toggle follow status for a user
   * Now using service layer for consistent error handling and optimistic updates
   */
  const toggleFollow = async (user: FederatedUser | string): Promise<{ following: boolean; error?: string }> => {
    const userId = typeof user === 'string' ? user : user.id
    
    if (!userId) {
      debug.error('❌ toggleFollow: Invalid user ID:', user)
      return { following: false, error: 'Invalid user ID' }
    }

    isFollowLoading.value = true
    try {
      const result = await services.interactions.toggleFollow(userId)
      debug.log(`✅ Follow toggled for user ${userId}:`, result.following ? 'Following' : 'Unfollowed')
      return { following: result.following }
    } catch (error) {
      debug.error('❌ Failed to toggle follow:', error)
      return { 
        following: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    } finally {
      isFollowLoading.value = false
    }
  }

  /**
   * Follow a user (explicit action)
   */
  const followUser = async (user: FederatedUser | string): Promise<{ success: boolean; error?: string }> => {
    const userId = typeof user === 'string' ? user : user.id
    
    if (!userId) {
      debug.error('❌ followUser: Invalid user ID:', user)
      return { success: false, error: 'Invalid user ID' }
    }

    isFollowLoading.value = true
    try {
      await activityPubStore.followUser(userId)
      debug.log(`✅ Successfully followed user: ${userId}`)
      return { success: true }
    } catch (error) {
      debug.error('❌ Failed to follow user:', error)
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    } finally {
      isFollowLoading.value = false
    }
  }

  /**
   * Unfollow a user (explicit action)
   */
  const unfollowUser = async (user: FederatedUser | string): Promise<{ success: boolean; error?: string }> => {
    const userId = typeof user === 'string' ? user : user.id
    
    if (!userId) {
      debug.error('❌ unfollowUser: Invalid user ID:', user)
      return { success: false, error: 'Invalid user ID' }
    }

    isFollowLoading.value = true
    try {
      await activityPubStore.unfollowUser(userId)
      debug.log(`✅ Successfully unfollowed user: ${userId}`)
      return { success: true }
    } catch (error) {
      debug.error('❌ Failed to unfollow user:', error)
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    } finally {
      isFollowLoading.value = false
    }
  }

  // POST INTERACTIONS

  /**
   * Toggle favorite (like) status for a post
   * Now using service layer for consistent error handling and optimistic updates
   */
  const toggleFavorite = async (post: TimelinePost | string): Promise<{ success: boolean; liked?: boolean; newCount?: number; error?: string }> => {
    const postId = typeof post === 'string' ? post : post.id
    
    if (!postId) {
      debug.error('❌ toggleFavorite: Invalid post ID:', post)
      return { success: false, error: 'Invalid post ID' }
    }

    isFavoriteLoading.value = true
    try {
      const result = await services.posts.toggleLike(postId)
      debug.log(`✅ Favorite toggled for post ${postId}:`, result.liked ? 'Liked' : 'Unliked')

      activityPubStore.updatePostInteractionInAllFeeds(postId, 'favorite', result.liked)

      return { 
        success: true, 
        liked: result.liked,
        newCount: result.newCount
      }
    } catch (error) {
      debug.error('❌ Failed to toggle favorite:', error)
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    } finally {
      isFavoriteLoading.value = false
    }
  }

  /**
   * Toggle reblog (boost) status for a post
   * Now using service layer for consistent error handling and optimistic updates
   */
  const toggleReblog = async (post: TimelinePost | string): Promise<{ success: boolean; reblogged?: boolean; newCount?: number; error?: string }> => {
    const postId = typeof post === 'string' ? post : post.id
    
    if (!postId) {
      debug.error('❌ toggleReblog: Invalid post ID:', post)
      return { success: false, error: 'Invalid post ID' }
    }

    isReblogLoading.value = true
    try {
      const result = await services.posts.toggleReblog(postId)
      debug.log(`✅ Reblog toggled for post ${postId}:`, result.reblogged ? 'Reblogged' : 'Unreblogged')
      
      return { 
        success: true, 
        reblogged: result.reblogged,
        newCount: result.newCount
      }
    } catch (error) {
      debug.error('❌ Failed to toggle reblog:', error)
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    } finally {
      isReblogLoading.value = false
    }
  }

  /**
   * Toggle bookmark status for a post
   * Now using service layer for consistent error handling and optimistic updates
   */
  const toggleBookmark = async (post: TimelinePost | string): Promise<{ success: boolean; bookmarked?: boolean; error?: string }> => {
    const postId = typeof post === 'string' ? post : post.id
    
    if (!postId) {
      debug.error('❌ toggleBookmark: Invalid post ID:', post)
      return { success: false, error: 'Invalid post ID' }
    }

    isBookmarkLoading.value = true
    try {
      const result = await services.posts.toggleBookmark(postId)
      debug.log(`✅ Bookmark toggled for post ${postId}:`, result.bookmarked ? 'Bookmarked' : 'Unbookmarked')
      return { 
        success: true, 
        bookmarked: result.bookmarked
      }
    } catch (error) {
      debug.error('❌ Failed to toggle bookmark:', error)
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    } finally {
      isBookmarkLoading.value = false
    }
  }

  /**
   * Toggle pin status for a post (pin/unpin to profile)
   */
  const togglePinPost = async (post: TimelinePost | string): Promise<{ success: boolean; pinned?: boolean; error?: string }> => {
    const postId = typeof post === 'string' ? post : post.id
    
    if (!postId) {
      debug.error('❌ togglePinPost: Invalid post ID:', post)
      return { success: false, error: 'Invalid post ID' }
    }

    isPinLoading.value = true
    try {
      const result = await services.posts.togglePinPost(postId)
      debug.log(`📌 Pin toggled for post ${postId}:`, result.pinned ? 'Pinned' : 'Unpinned')

      activityPubStore.updatePostInteractionInAllFeeds(postId, 'pin', result.pinned)

      return { 
        success: true, 
        pinned: result.pinned
      }
    } catch (error: any) {
      debug.error('❌ Failed to toggle pin:', error)
      return { 
        success: false, 
        error: error?.message || (error instanceof Error ? error.message : 'Unknown error')
      }
    } finally {
      isPinLoading.value = false
    }
  }

  // UTILITY FUNCTIONS

  /**
   * Check if currently following a user
   */
  const isFollowing = (user: FederatedUser | string): boolean => {
    const userId = typeof user === 'string' ? user : user.id
    return userId ? activityPubStore.followedUsers.has(userId) : false
  }

  /**
   * Get loading state for a specific interaction
   */
  const getLoadingState = () => ({
    follow: isFollowLoading.value,
    favorite: isFavoriteLoading.value,
    reblog: isReblogLoading.value,
    bookmark: isBookmarkLoading.value
  })

  return {
    // User interactions
    toggleFollow,
    followUser,
    unfollowUser,
    isFollowing,
    
    // Post interactions
    toggleFavorite,
    toggleReblog,
    toggleBookmark,
    togglePinPost,
    
    // Loading states
    ...getLoadingState(),
    getLoadingState
  }
} 