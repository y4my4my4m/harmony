import { ref } from 'vue'
import { useActivityPubStore } from '@/stores/useActivityPub'
import type { FederatedUser, TimelinePost } from '@/types'

/**
 * Composable for handling ActivityPub post and user interactions
 * Professional, DRY, and reusable across all components
 */
export function usePostInteractions() {
  const activityPubStore = useActivityPubStore()
  
  // Loading states
  const isFollowLoading = ref(false)
  const isFavoriteLoading = ref(false)
  const isReblogLoading = ref(false)
  const isBookmarkLoading = ref(false)

  // =============================================
  // USER INTERACTIONS
  // =============================================

  /**
   * Toggle follow status for a user
   */
  const toggleFollow = async (user: FederatedUser | string): Promise<{ following: boolean; error?: string }> => {
    const userId = typeof user === 'string' ? user : user.id
    
    if (!userId) {
      console.error('❌ toggleFollow: Invalid user ID:', user)
      return { following: false, error: 'Invalid user ID' }
    }

    isFollowLoading.value = true
    try {
      const result = await activityPubStore.toggleFollow(userId)
      console.log(`✅ Follow toggled for user ${userId}:`, result.following ? 'Following' : 'Unfollowed')
      return result
    } catch (error) {
      console.error('❌ Failed to toggle follow:', error)
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
      console.error('❌ followUser: Invalid user ID:', user)
      return { success: false, error: 'Invalid user ID' }
    }

    isFollowLoading.value = true
    try {
      await activityPubStore.followUser(userId)
      console.log(`✅ Successfully followed user: ${userId}`)
      return { success: true }
    } catch (error) {
      console.error('❌ Failed to follow user:', error)
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
      console.error('❌ unfollowUser: Invalid user ID:', user)
      return { success: false, error: 'Invalid user ID' }
    }

    isFollowLoading.value = true
    try {
      await activityPubStore.unfollowUser(userId)
      console.log(`✅ Successfully unfollowed user: ${userId}`)
      return { success: true }
    } catch (error) {
      console.error('❌ Failed to unfollow user:', error)
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    } finally {
      isFollowLoading.value = false
    }
  }

  // =============================================
  // POST INTERACTIONS
  // =============================================

  /**
   * Toggle favorite status for a post
   * Note: Does not return immediate state - UI should read from store reactively
   */
  const toggleFavorite = async (post: TimelinePost | string): Promise<{ success: boolean; error?: string }> => {
    const postId = typeof post === 'string' ? post : post.id
    
    if (!postId) {
      console.error('❌ toggleFavorite: Invalid post ID:', post)
      return { success: false, error: 'Invalid post ID' }
    }

    isFavoriteLoading.value = true
    try {
      await activityPubStore.toggleFavorite(postId)
      console.log(`✅ Favorite toggle requested for post ${postId} - waiting for realtime update`)
      return { success: true }
    } catch (error) {
      console.error('❌ Failed to toggle favorite:', error)
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    } finally {
      isFavoriteLoading.value = false
    }
  }

  /**
   * Toggle reblog status for a post
   * Note: Does not return immediate state - UI should read from store reactively
   */
  const toggleReblog = async (post: TimelinePost | string): Promise<{ success: boolean; error?: string }> => {
    const postId = typeof post === 'string' ? post : post.id
    
    if (!postId) {
      console.error('❌ toggleReblog: Invalid post ID:', post)
      return { success: false, error: 'Invalid post ID' }
    }

    isReblogLoading.value = true
    try {
      await activityPubStore.toggleReblog(postId)
      console.log(`✅ Reblog toggle requested for post ${postId} - waiting for realtime update`)
      return { success: true }
    } catch (error) {
      console.error('❌ Failed to toggle reblog:', error)
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
   * Note: Does not return immediate state - UI should read from store reactively
   */
  const toggleBookmark = async (post: TimelinePost | string): Promise<{ success: boolean; error?: string }> => {
    const postId = typeof post === 'string' ? post : post.id
    
    if (!postId) {
      console.error('❌ toggleBookmark: Invalid post ID:', post)
      return { success: false, error: 'Invalid post ID' }
    }

    isBookmarkLoading.value = true
    try {
      await activityPubStore.toggleBookmark(postId)
      console.log(`✅ Bookmark toggle requested for post ${postId} - waiting for realtime update`)
      return { success: true }
    } catch (error) {
      console.error('❌ Failed to toggle bookmark:', error)
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    } finally {
      isBookmarkLoading.value = false
    }
  }

  // =============================================
  // UTILITY FUNCTIONS
  // =============================================

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
    
    // Loading states
    ...getLoadingState(),
    getLoadingState
  }
} 