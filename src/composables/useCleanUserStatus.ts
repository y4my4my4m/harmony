/**
 * Clean User Status Composable - Professional Global Implementation
 * 
 * Professional, scalable interface for the global user presence system.
 * Includes full profile data tracking and context-based subscriptions.
 * 
 * Features:
 * - Global presence with context-aware subscriptions
 * - Full profile data (avatar, name, color, bio, status, etc.)
 * - Smart subscription management
 * - Real-time profile updates
 * - Discord-style efficiency
 */

import { computed } from 'vue'
import { UserStatus } from '@/types'
import { useContextualStatusStore } from '@/stores/contextualStatusStore'
import type { UserPresence } from '@/services/globalPresenceService'

export function useCleanUserStatus() {
  const statusStore = useContextualStatusStore()

  // Status getters with full profile data
  const getUserPresence = (userId: string) => computed(() => statusStore.getUserPresence(userId))
  
  const getCurrentUserStatus = computed(() => statusStore.getCurrentUserStatus)
  
  const getCurrentUserId = computed(() => statusStore.getCurrentUserId)
  
  const getOnlineUsers = computed(() => statusStore.getOnlineUsers)

  // UI helpers for components
  const getStatusForAvatar = (userId: string) => computed(() => {
    const presence = statusStore.getUserPresence(userId)
    return presence?.status || UserStatus.Offline
  })

  const getStatusColor = (userId: string) => computed(() => {
    const presence = statusStore.getUserPresence(userId)
    const status = presence?.status || UserStatus.Offline
    
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
    const presence = statusStore.getUserPresence(userId)
    const status = presence?.status || UserStatus.Offline
    
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
    return statusStore.isUserOnline(userId)
  })

  const getUserDisplayName = (userId: string) => computed(() => {
    const presence = statusStore.getUserPresence(userId)
    return presence?.displayName || presence?.username || 'Unknown User'
  })

  const getUserUsername = (userId: string) => computed(() => {
    const presence = statusStore.getUserPresence(userId)
    return presence?.username || 'unknown'
  })

  const getUserAvatarUrl = (userId: string) => computed(() => {
    const presence = statusStore.getUserPresence(userId)
    return presence?.avatarUrl
  })

  const getUserBio = (userId: string) => computed(() => {
    const presence = statusStore.getUserPresence(userId)
    return presence?.bio
  })

  const getUserColor = (userId: string) => computed(() => {
    const presence = statusStore.getUserPresence(userId)
    return presence?.color
  })

  const isUserVerified = (_userId: string) => computed(() => {
    // Note: verified field removed from schema
    return false
  })

  const getUserLastSeen = (userId: string) => computed(() => {
    const presence = statusStore.getUserPresence(userId)
    return presence?.lastSeen
  })

  // Get full user presence data
  const getFullUserPresence = (userId: string) => computed(() => {
    return statusStore.getUserPresence(userId)
  })

  // Context subscription methods
  const subscribeToServerUsers = async (serverId: string, memberIds: string[]): Promise<void> => {
    statusStore.subscribeToContext(serverId, 'server', memberIds)
  }

  const subscribeToDMUsers = async (conversationId: string, participantIds: string[]): Promise<void> => {
    statusStore.subscribeToContext(conversationId, 'dm', participantIds)
  }

  const subscribeToUserPresence = async (userId: string): Promise<void> => {
    statusStore.subscribeToContext(userId, 'global', [userId])
  }

  const unsubscribeFromContext = async (contextId: string): Promise<void> => {
    statusStore.unsubscribeFromContext(contextId)
  }

  // Status management
  const updateCurrentUserStatus = async (newStatus: UserStatus): Promise<void> => {
    await statusStore.setUserStatus(newStatus)
  }

  // Force an immediate update for the current user
  const forceUpdateCurrentUser = (): void => {
    statusStore.forceUpdateCurrentUserPresence()
  }

  // Profile broadcasting (for real-time profile changes)
  const broadcastProfileUpdate = async (_profileData: Partial<UserPresence>): Promise<void> => {
    // Note: This would need to be implemented if the global service supports it
    // For now, we just force an update
    statusStore.forceUpdateCurrentUserPresence()
  }

  // Initialize the presence system
  const initializePresence = async (userId: string, username: string, avatar?: string): Promise<void> => {
    await statusStore.initialize(userId, username, avatar)
  }

  // Cleanup
  const cleanup = async (): Promise<void> => {
    await statusStore.cleanup()
  }

  // Legacy compatibility - bulk initialize server users
  const initializeServerUsers = async (_userIds: string[]): Promise<void> => {
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
    return {
      currentUserId: statusStore.getCurrentUserId,
      currentStatus: statusStore.getCurrentUserStatus,
      onlineUsers: statusStore.getOnlineUsers
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
    
    // Context subscriptions
    subscribeToServerUsers,
    subscribeToDMUsers,
    subscribeToUserPresence,
    unsubscribeFromContext,
    
    // Status management
    updateCurrentUserStatus,
    forceUpdateCurrentUser,
    broadcastProfileUpdate,
    
    // Lifecycle
    initializePresence,
    cleanup,
    initializeServerUsers, // Legacy compatibility
    
    // Legacy aliases for backward compatibility
    getUserStatus,
    getUserAvatar,
    subscribeToUser,
    initializeForUser,
    
    // Debug
    getPresenceDebugInfo
  }
}
