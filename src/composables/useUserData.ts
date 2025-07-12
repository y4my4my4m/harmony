/**
 * useUserData Composable
 * 
 * Clean, simple wrapper around userDataService for component usage.
 * Provides reactive user data without the complexity of the old system.
 */

import { computed, ref, onMounted, onUnmounted } from 'vue'
import { userDataService, type UserData } from '@/services/userDataService'
import { UserStatus } from '@/types'

export function useUserData() {
  const isInitialized = ref(false)
  const forceUpdate = ref(0)
  
  // Event listener references
  let eventListeners: Array<{ type: string; listener: EventListener }> = []
  
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
    
    eventListeners = listeners
  }
  
  // Cleanup event listeners
  const cleanupEventListeners = () => {
    eventListeners.forEach(({ type, listener }) => {
      userDataService.removeEventListener(type, listener)
    })
    eventListeners = []
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
   * Get user display name
   */
  const getUserDisplayName = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.displayName || user?.username || 'Unknown User'
  })
  
  /**
   * Get user status for avatar display
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
  
  // Context Data Getters
  
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
  const subscribeToContext = async (contextId: string, type: 'server' | 'dm', userIds: string[]) => {
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
  
  // Convert single user to legacy format for compatibility
  const toLegacyUser = (userData: UserData) => ({
    id: userData.id,
    username: userData.username,
    display_name: userData.displayName,
    avatar_url: userData.avatarUrl,
    status: userData.status
  })
  
  // Get users in legacy format for compatibility
  const getUsersInContextLegacy = (contextId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getUsersInContext(contextId).map(toLegacyUser)
  })
  
  // Lifecycle
  onMounted(async () => {
    await ensureInitialized()
  })
  
  onUnmounted(() => {
    cleanupEventListeners()
  })
  
  return {
    // Initialization
    initialize,
    refresh,
    
    // User Data (reactive)
    getUser,
    getCurrentUser,
    getUserAvatarUrl,
    getUserDisplayName,
    getUserStatusForAvatar,
    getUserStatusText,
    getUserColor,
    isUserOnline,
    getCurrentUserStatus,
    
    // Context Data (reactive)
    getUsersInContext,
    getUsersInContextLegacy,
    getOnlineUsers,
    getAllUsers,
    
    // Actions
    subscribeToContext,
    unsubscribeFromContext,
    updateCurrentUserStatus,
    
    // Utilities
    toLegacyUser,
    getStats,
    
    // State
    isInitialized
  }
}