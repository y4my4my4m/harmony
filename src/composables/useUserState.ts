/**
 * User State Composable
 * 
 * Provides a unified interface for user status and profile management using the modern userDataService.
 * Implements context-aware broadcasting - only users in relevant contexts receive updates.
 * 
 * Features:
 * - Real-time status data
 * - Context-aware profile broadcasting (scalable)
 * - Smart subscription management
 * - Discord/Slack-style efficiency
 */

import { computed, ref } from 'vue'
import { UserStatus } from '@/types'
import { userDataService } from '@/services/userDataService'

// Modern user presence interface (simplified from deprecated UserPresence)
export interface UserPresence {
  userId: string
  username: string
  displayName: string
  status: UserStatus
  isOnline: boolean
  lastSeen: string
  avatarUrl?: string
  bio?: string
  color?: string
}

export function useUserState() {
  // Force reactivity trigger
  const forceUpdate = ref(0)
  
  // Setup event listeners for reactivity
  const setupReactivity = () => {
    const triggerUpdate = () => forceUpdate.value++
    
    userDataService.addEventListener('user-updated', triggerUpdate)
    userDataService.addEventListener('status-changed', triggerUpdate)
    userDataService.addEventListener('presence-sync', triggerUpdate)
  }
  
  // Initialize reactivity on first use
  setupReactivity()

  // Status getters with full user data
  const getUserData = (userId: string) => computed(() => {
    // Trigger reactivity
    forceUpdate.value
    return userDataService.getUser(userId)
  })
  
  const getUserPresence = (userId: string) => computed(() => {
    // Trigger reactivity  
    forceUpdate.value
    const userData = userDataService.getUser(userId)
    return userData ? {
      userId: userData.id,
      username: userData.username,
      displayName: userData.displayName,
      status: userData.status,
      isOnline: userData.isOnline,
      lastSeen: userData.lastSeen,
      avatarUrl: userData.avatarUrl,
      bio: userData.bio,
      color: userData.color
    } : null
  })
  
  const getCurrentUserStatus = computed(() => {
    forceUpdate.value
    const currentUser = userDataService.getCurrentUser()
    return currentUser?.status || UserStatus.Offline
  })
  
  const getCurrentUserId = computed(() => {
    forceUpdate.value
    const currentUser = userDataService.getCurrentUser() 
    return currentUser?.id || null
  })
  
  const getOnlineUsers = computed(() => {
    forceUpdate.value
    return userDataService.getOnlineUsers()
  })

  // UI helpers for components
  const getStatusForAvatar = (userId: string) => computed(() => {
    forceUpdate.value
    const userData = userDataService.getUser(userId)
    return userData?.status || UserStatus.Offline
  })

  const getStatusColor = (userId: string) => computed(() => {
    forceUpdate.value
    const userData = userDataService.getUser(userId)
    const status = userData?.status || UserStatus.Offline
    
    // Return appropriate color for each status
    switch (status) {
      case UserStatus.Online:
        return '#23a55a' // Green
      case UserStatus.Away:
        return '#f0b232' // Yellow
      case UserStatus.Busy:
        return '#f23f43' // Red
      case UserStatus.Offline:
      default:
        return '#80848e' // Gray
    }
  })

  const getStatusText = (userId: string) => computed(() => {
    forceUpdate.value
    const userData = userDataService.getUser(userId)
    const status = userData?.status || UserStatus.Offline
    
    // Return human-readable status text
    switch (status) {
      case UserStatus.Online:
        return 'Online'
      case UserStatus.Away:
        return 'Away'
      case UserStatus.Busy:
        return 'Do Not Disturb'
      case UserStatus.Offline:
      default:
        return 'Offline'
    }
  })

  const isUserOnline = (userId: string) => computed(() => {
    forceUpdate.value
    const userData = userDataService.getUser(userId)
    return userData?.isOnline || false
  })

  const getUserDisplayName = (userId: string) => computed(() => {
    forceUpdate.value
    const userData = userDataService.getUser(userId)
    return userData?.displayName || userData?.username || 'Unknown User'
  })

  const getUserUsername = (userId: string) => computed(() => {
    forceUpdate.value
    const userData = userDataService.getUser(userId)
    return userData?.username || 'unknown'
  })

  const getUserAvatarUrl = (userId: string) => computed(() => {
    forceUpdate.value
    const userData = userDataService.getUser(userId)
    return userData?.avatarUrl
  })

  const getUserBio = (userId: string) => computed(() => {
    forceUpdate.value
    const userData = userDataService.getUser(userId)
    return userData?.bio
  })

  const getUserColor = (userId: string) => computed(() => {
    forceUpdate.value
    const userData = userDataService.getUser(userId)
    return userData?.color
  })

  const isUserVerified = () => computed(() => {
    // Note: verified field removed from schema
    return false
  })

  const getUserLastSeen = (userId: string) => computed(() => {
    forceUpdate.value
    const userData = userDataService.getUser(userId)
    return userData?.lastSeen
  })

  // Get full user presence data
  const getFullUserPresence = (userId: string) => computed(() => {
    return getUserPresence(userId).value
  })

  // Context subscription methods - now use userDataService
  const subscribeToServerUsers = async (serverId: string, memberIds: string[]): Promise<void> => {
    await userDataService.subscribeToContext(serverId, 'server', memberIds)
  }

  const subscribeToDMUsers = async (conversationId: string, participantIds: string[]): Promise<void> => {
    await userDataService.subscribeToContext(conversationId, 'dm', participantIds)
  }

  const subscribeToUserPresence = async (userId: string): Promise<void> => {
    // Use DM context for individual user subscriptions since userDataService doesn't support 'global' 
    await userDataService.subscribeToContext(userId, 'dm', [userId])
  }

  const unsubscribeFromContext = async (contextId: string): Promise<void> => {
    await userDataService.unsubscribeFromContext(contextId)
  }

  // Status management
  const updateCurrentUserStatus = async (newStatus: UserStatus): Promise<void> => {
    await userDataService.updateCurrentUserStatus(newStatus)
  }

  // Force an immediate update for the current user
  const forceUpdateCurrentUser = (): void => {
    // Trigger reactivity update
    forceUpdate.value++
  }

  // Context-aware profile broadcasting (SCALABLE - only to relevant users)
  const broadcastProfileUpdate = async (profileData: Partial<UserPresence>): Promise<void> => {
    try {
      // Use the new context-aware profile broadcasting
      await userDataService.updateCurrentUserProfile({
        displayName: profileData.displayName,
        avatarUrl: profileData.avatarUrl,
        bio: profileData.bio,
        color: profileData.color,
        username: profileData.username
      })
      console.log('✅ Profile broadcast to relevant contexts only (scalable)')
    } catch (error) {
      console.error('Failed to broadcast profile update:', error)
      // Fallback to force update if broadcast fails
      forceUpdateCurrentUser()
    }
  }

  // Initialize the presence system
  const initializePresence = async (userId: string, username: string, avatar?: string): Promise<void> => {
    await userDataService.initialize(userId, username, avatar)
  }

  // Cleanup
  const cleanup = async (): Promise<void> => {
    await userDataService.cleanup()
  }

  // Legacy compatibility - bulk initialize server users
  const initializeServerUsers = async (): Promise<void> => {
    // This is now handled automatically by the global service
    // when subscribing to contexts
    console.log('initializeServerUsers called - now handled automatically by global service')
  }

  // Legacy aliases for backward compatibility
  const getUserStatus = getUserPresence
  const getUserAvatar = getUserAvatarUrl
  const subscribeToUser = subscribeToUserPresence
  const initializeForUser = initializePresence

  // Debug helper
  const getPresenceDebugInfo = () => {
    const currentUser = userDataService.getCurrentUser()
    return {
      currentUserId: currentUser?.id || null,
      currentStatus: currentUser?.status || UserStatus.Offline,
      onlineUsers: userDataService.getOnlineUsers()
    }
  }

  return {
    // Status getters
    getUserPresence,
    getCurrentUserStatus,
    getCurrentUserId,
    getOnlineUsers,
    
    // UI helpers
    getStatusForAvatar,
    getStatusColor,
    getStatusText,
    isUserOnline,
    
    // Profile getters
    getUserDisplayName,
    getUserUsername,
    getUserAvatarUrl,
    getUserBio,
    getUserColor,
    isUserVerified,
    getUserLastSeen,
    getFullUserPresence,
    
    // Context management
    subscribeToServerUsers,
    subscribeToDMUsers,
    subscribeToUserPresence,
    unsubscribeFromContext,
    
    // Status management
    updateCurrentUserStatus,
    forceUpdateCurrentUser,
    broadcastProfileUpdate,
    
    // System management
    initializePresence,
    cleanup,
    initializeServerUsers,
    
    // Legacy aliases
    getUserStatus,
    getUserAvatar,
    subscribeToUser,
    initializeForUser,
    
    // Debug
    getPresenceDebugInfo,
    
    // Additional exports
    getUserData
  }
}
