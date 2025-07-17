/**
 * useUserData Composable
 * 
 * Clean, simple wrapper around userDataService for component usage.
 * Provides reactive user data without the complexity of the old system.
 */

import { computed, ref } from 'vue'
import { userDataService } from '@/services/userDataService'
import { UserStatus } from '@/types'
import { getAvatarUrl } from '@/utils/avatarUtils'

export function useUserData() {
  const isInitialized = ref(false)
  const forceUpdate = ref(0)
  
  // Force reactivity by updating the counter
  const triggerUpdate = () => {
    forceUpdate.value++
  }
  
  // Setup event listeners
  const setupEventListeners = () => {
    const listeners = [
      { type: 'user-updated', listener: triggerUpdate },
      { type: 'status-changed', listener: triggerUpdate },
      { type: 'presence-sync', listener: triggerUpdate },
      { type: 'data-refreshed', listener: triggerUpdate },
      { type: 'context-updated', listener: triggerUpdate }
    ]
    
    listeners.forEach(({ type, listener }) => {
      userDataService.addEventListener(type, listener)
    })
  }
  
  // Initialize if not already done
  const ensureInitialized = async () => {
    if (!isInitialized.value) {
      setupEventListeners()
      isInitialized.value = true
    }
  }
  
  // User Data Getters (all reactive)
  
  /**
   * Get complete user data
   */
  const getUser = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getUser(userId)
  })
  
  /**
   * Get current user data
   */
  const getCurrentUser = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getCurrentUser()
  })
  
  /**
   * Get user avatar URL
   */
  const getUserAvatarUrl = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.avatarUrl || '/default_avatar.png'
  })

  /**
   * Get user avatar URL for current user
   */
  const getUserAvatarUrlCurrent = computed(() => {
    forceUpdate.value // Force reactivity
    const currentUser = userDataService.getCurrentUser()
    if (currentUser?.isLocal) {
      return getAvatarUrl(currentUser?.avatarUrl)
    }
    // Fallback for non-local users
    return currentUser?.avatarUrl || '/default_avatar.png'
  })
  
  /**
   * Get user display name
   */
  const getUserDisplayName = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.displayName || user?.username || 'Unknown User'
  })
  
  /**
   * @deprecated Use getPresenceAwareStatus instead - this only shows persistent DB status
   * Get user status for avatar display (legacy - not presence-aware)
   */
  const getUserStatusForAvatar = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    if (!user) return 'offline'
    
    switch (user.status) {
      case UserStatus.Online:
        return 'online'
      case UserStatus.Away:
        return 'away'
      case UserStatus.Busy:
        return 'busy'
      case UserStatus.Offline:
      default:
        return 'offline'
    }
  })
  
  /**
   * Get user status text
   */
  const getUserStatusText = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    if (!user) return 'Offline'
    
    if (user.bio && user.bio.includes('status:')) {
      const customStatus = user.bio.split('status:')[1]?.trim()
      if (customStatus) return customStatus
    }
    
    switch (user.status) {
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
  
  /**
   * Get user color
   */
  const getUserColor = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.color || '#ffffff'
  })
  
  /**
   * Check if user is online
   */
  const isUserOnline = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.isOnline || false
  })
  
  /**
   * Get current user status
   */
  const getCurrentUserStatus = computed(() => {
    forceUpdate.value // Force reactivity
    const currentUser = userDataService.getCurrentUser()
    return currentUser?.status ?? UserStatus.Offline
  })
  
  /**
   * Get user status
   */
  const getUserStatus = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.status ?? UserStatus.Offline
  })
  
  /**
   * Get user creation date (Member Since)
   */
  const getUserCreatedAt = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.createdAt || null
  })

  /**
   * Get user profile data (complete profile info for compatibility)
   */
  const getUserProfile = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getUserProfile(userId)
  })

  /**
   * Get user bio
   */
  const getUserBio = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.bio || null
  })

  /**
   * Get user roles
   */
  const getUserRoles = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.roles || []
  })

  /**
   * Get user message count
   */
  const getUserMessageCount = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.messageCount || 0
  })

  /**
   * Get user voice time
   */
  const getUserVoiceTime = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.voiceTime || 0
  })

  /**
   * Get user banner URL
   */
  const getUserBannerUrl = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.bannerUrl || null
  })

  /**
   * Fetch user profile (with caching)
   */
  const fetchUserProfile = async (userId: string, forceRefresh: boolean = false) => {
    await ensureInitialized()
    return await userDataService.fetchUserProfile(userId, forceRefresh)
  }

  /**
   * Fetch multiple user profiles efficiently
   */
  const fetchMultipleUserProfiles = async (userIds: string[], forceRefresh: boolean = false) => {
    await ensureInitialized()
    return await userDataService.fetchMultipleUserProfiles(userIds, forceRefresh)
  }

  /**
   * Professional cache method to ensure profiles are available
   * Use this in components that need to display user data
   */
  const ensureProfilesAvailable = async (userIds: string[]) => {
    await ensureInitialized()
    await userDataService.ensureUsersLoaded(userIds)
  }
  
  // Actions
  
  /**
   * Initialize the service
   */
  const initialize = async (userId: string, username: string, avatarUrl?: string) => {
    await ensureInitialized()
    await userDataService.initialize(userId, username, avatarUrl)
  }
  
  /**
   * Subscribe to a context
   */
  const subscribeToContext = async (contextId: string, type: 'server' | 'dm' | 'profile' | 'friends', userIds: string[]) => {
    await ensureInitialized()
    await userDataService.subscribeToContext(contextId, type, userIds)
  }
  
  /**
   * Unsubscribe from a context
   */
  const unsubscribeFromContext = async (contextId: string) => {
    await userDataService.unsubscribeFromContext(contextId)
  }
  
  /**
   * Update current user status
   */
  const updateCurrentUserStatus = async (status: UserStatus) => {
    await userDataService.updateCurrentUserStatus(status)
  }
  
  /**
   * Update current user profile
   * Broadcasts profile updates to all connected clients for real-time updates
   */
  const updateCurrentUserProfile = async (profileData: {
    displayName?: string
    avatarUrl?: string
    bannerUrl?: string
    color?: string
    bio?: string
  }) => {
    await userDataService.updateCurrentUserProfile(profileData)
  }
  
  /**
   * Force refresh all data
   */
  const refresh = async () => {
    await userDataService.refresh()
  }
  
  /**
   * Get service stats for debugging
   */
  const getStats = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getStats()
  })
  
  /**
   * Get users in a specific context (server, DM)
   */
  const getUsersInContext = (contextId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getUsersInContext(contextId)
  })
  
  /**
   * Get all online users
   */
  const getOnlineUsers = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getOnlineUsers()
  })
  
  /**
   * Get all users
   */
  const getAllUsers = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getAllUsers()
  })

  /**
   * Context-Aware Presence Management
   * Professional approach: Only track users we actually need to see
   */
  
  /**
   * Subscribe to DM presence context
   * Tracks users we have active conversations with
   */
  const subscribeToDMPresence = async (conversationUserIds: string[]) => {
    await ensureInitialized()
    
    // Create DM context with unique ID
    const contextId = 'dm-conversations'
    await userDataService.subscribeToContext(contextId, 'dm', conversationUserIds)
    
    console.log(`🗨️ DM Presence: Tracking ${conversationUserIds.length} conversation partners`)
    return contextId
  }
  
  /**
   * Subscribe to profile presence context  
   * Tracks a single user when viewing their profile
   */
  const subscribeToProfilePresence = async (userId: string) => {
    await ensureInitialized()
    
    // Create profile context with user-specific ID
    const contextId = `profile-${userId}`
    await userDataService.subscribeToContext(contextId, 'profile', [userId])
    
    console.log(`👤 Profile Presence: Tracking user ${userId}`)
    return contextId
  }
  
  /**
   * Subscribe to friends presence context
   * Tracks users on our friends list
   */
  const subscribeToFriendsPresence = async (friendUserIds: string[]) => {
    await ensureInitialized()
    
    // Create friends context
    const contextId = 'friends-list'
    await userDataService.subscribeToContext(contextId, 'friends', friendUserIds)
    
    console.log(`👥 Friends Presence: Tracking ${friendUserIds.length} friends`)
    return contextId
  }
  
  /**
   * Get presence-aware status for avatar (replaces getUserStatusForAvatar)
   * Uses real-time presence if available, falls back to database status
   */
  const getPresenceAwareStatus = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    
    console.log(`🔍 getPresenceAwareStatus for ${userId}:`, {
      user: user ? 'found' : 'not found',
      isOnline: user?.isOnline,
      status: user?.status ? UserStatus[user.status] : 'undefined'
    })
    
    if (!user) return 'offline'
    
    // Check if user is actually present in real-time
    const isPresent = user.isOnline || false
    
    if (!isPresent) {
      // User is not present - always show as offline
      console.log(`🔍 User ${userId} not present, showing offline`)
      return 'offline'
    }
    
    // User is present - return their preferred status
    console.log(`🔍 User ${userId} present with status:`, UserStatus[user.status])
    switch (user.status) {
      case UserStatus.Online:
        return 'online'
      case UserStatus.Away:
        return 'away'
      case UserStatus.Busy:
        return 'busy'
      default:
        // Present but status unknown - show as online
        return 'online'
    }
  })

  /**
   * Context Management Utilities
   * Professional methods for managing presence subscriptions
   */
  
  /**
   * Unsubscribe from specific profile presence
   */
  const unsubscribeFromProfilePresence = async (userId: string) => {
    const contextId = `profile-${userId}`
    await unsubscribeFromContext(contextId)
    console.log(`👤 Profile Presence: Stopped tracking user ${userId}`)
  }
  
  /**
   * Update DM conversations presence
   * Call this when DM list changes (new conversations, removed conversations)
   */
  const updateDMPresence = async (conversationUserIds: string[]) => {
    // Unsubscribe from old DM context
    await unsubscribeFromContext('dm-conversations')
    
    // Subscribe to new DM context if there are conversations
    if (conversationUserIds.length > 0) {
      return await subscribeToDMPresence(conversationUserIds)
    }
    
    console.log(`🗨️ DM Presence: No active conversations to track`)
    return null
  }
  
  /**
   * Update friends list presence
   * Call this when friends list changes
   */
  const updateFriendsPresence = async (friendUserIds: string[]) => {
    // Unsubscribe from old friends context
    await unsubscribeFromContext('friends-list')
    
    // Subscribe to new friends context if there are friends
    if (friendUserIds.length > 0) {
      return await subscribeToFriendsPresence(friendUserIds)
    }
    
    console.log(`👥 Friends Presence: No friends to track`)
    return null
  }
  
  /**
   * Get active contexts (for debugging)
   */
  const getActiveContexts = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getStats().contexts || 0
  })
  
  /**
   * Get presence statistics (for debugging and monitoring)
   */
  const getPresenceStats = computed(() => {
    forceUpdate.value // Force reactivity
    const stats = userDataService.getStats()
    return {
      totalUsers: stats.totalUsers,
      onlineUsers: stats.onlineUsers,
      activeContexts: stats.contexts,
      initialized: stats.initialized,
      globalChannelConnected: stats.globalChannelConnected
    }
  })

  // // Lifecycle
  // onMounted(async () => {
  //   await ensureInitialized()
  // })
  
  // onUnmounted(() => {
  //   cleanupEventListeners()
  // })
  
  return {
    // Initialization
    initialize,
    refresh,
    
    // User Data (reactive)
    getUser,
    getCurrentUser,
    getUserAvatarUrl,
    getUserBannerUrl,
    getUserDisplayName,
    getUserStatus,
    getUserStatusForAvatar,
    getUserStatusText,
    getUserColor,
    isUserOnline,
    getCurrentUserStatus,
    getUserCreatedAt,
    getUserProfile,
    getUserBio,
    getUserRoles,
    getUserMessageCount,
    getUserVoiceTime,
    
    // Context Data (reactive)
    getUsersInContext,
    getOnlineUsers,
    getAllUsers,
    
    // Actions
    subscribeToContext,
    unsubscribeFromContext,
    updateCurrentUserStatus,
    updateCurrentUserProfile,
    
    // Utilities
    getStats,
    getUserAvatarUrlCurrent,
    fetchUserProfile,
    fetchMultipleUserProfiles,
    ensureProfilesAvailable,
    
    // State
    isInitialized,
    
    // Presence Management
    subscribeToDMPresence,
    subscribeToProfilePresence,
    subscribeToFriendsPresence,
    getPresenceAwareStatus,
    
    // Context Management
    unsubscribeFromProfilePresence,
    updateDMPresence,
    updateFriendsPresence,
    
    // Debugging
    getActiveContexts,
    getPresenceStats
  }
}