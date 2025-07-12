import { userDataService } from '@/services/userDataService'

/**
 * useUserState Composable
 * 
 * Provides reactive access to user state management and profile broadcasting
 * This replaces the old useCleanUserStatus composable with broader scope
 */
export function useUserState() {
  
  /**
   * Broadcast profile updates to all connected clients in context
   * This ensures real-time profile updates across all UI views
   */
  const broadcastProfileUpdate = async (profileData: {
    displayName?: string
    avatarUrl?: string
    color?: string
    bio?: string
  }) => {
    try {
      await userDataService.updateCurrentUserProfile(profileData)
      console.log('✅ Profile update broadcasted successfully')
    } catch (error) {
      console.error('❌ Failed to broadcast profile update:', error)
      throw error
    }
  }

  /**
   * Update current user status (online, away, busy, offline)
   */
  const updateUserStatus = async (status: number) => {
    try {
      await userDataService.updateCurrentUserStatus(status)
      console.log('✅ User status updated successfully')
    } catch (error) {
      console.error('❌ Failed to update user status:', error)
      throw error
    }
  }

  /**
   * Get current user data
   */
  const getCurrentUser = () => {
    return userDataService.getCurrentUser()
  }

  /**
   * Get user data by ID
   */
  const getUser = (userId: string) => {
    return userDataService.getUser(userId)
  }

  /**
   * Get service statistics
   */
  const getStats = () => {
    return userDataService.getStats()
  }

  return {
    // Profile management
    broadcastProfileUpdate,
    
    // Status management  
    updateUserStatus,
    
    // User data access
    getCurrentUser,
    getUser,
    getStats
  }
}
