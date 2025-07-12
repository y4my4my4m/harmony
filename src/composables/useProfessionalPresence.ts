/**
 * Professional Presence Composable
 * 
 * Clean, reactive interface for the professional presence system.
 * Provides Discord-style presence management with optimal performance.
 * 
 * Features:
 * - Reactive presence data with automatic updates
 * - Context-aware subscriptions for optimal bandwidth
 * - Professional caching and performance optimization
 * - Clean error handling and fallbacks
 * - Type-safe presence data
 */

import { computed, ref, onMounted, onUnmounted } from 'vue'
import { UserStatus } from '@/types'
import { professionalPresenceService } from '@/services/professionalPresenceService'
import type { UserPresence } from '@/services/professionalPresenceService'

export function useProfessionalPresence() {
  // Reactive state
  const isInitialized = ref(false)
  const isLoading = ref(false)
  const lastError = ref<string | null>(null)
  
  // Force reactivity by tracking updates
  const updateCounter = ref(0)
  const forceUpdate = () => updateCounter.value++

  // Set up event listeners for reactivity
  const setupEventListeners = () => {
    const handleStatusChange = () => {
      console.log('🔔 Professional presence: status-changed event received')
      forceUpdate()
    }
    const handleUserJoin = () => {
      console.log('🔔 Professional presence: user-join event received')
      forceUpdate()
    }
    const handleUserLeave = () => {
      console.log('🔔 Professional presence: user-leave event received')
      forceUpdate()
    }
    const handlePresenceSync = () => {
      console.log('🔔 Professional presence: presence-sync event received')
      forceUpdate()
    }
    const handleProfileUpdate = () => {
      console.log('🔔 Professional presence: profile-updated event received')
      forceUpdate()
    }
    
    professionalPresenceService.addEventListener('status-changed', handleStatusChange)
    professionalPresenceService.addEventListener('user-join', handleUserJoin)
    professionalPresenceService.addEventListener('user-leave', handleUserLeave)
    professionalPresenceService.addEventListener('presence-sync', handlePresenceSync)
    professionalPresenceService.addEventListener('profile-updated', handleProfileUpdate)
    
    // Store references for cleanup
    return {
      handleStatusChange,
      handleUserJoin,
      handleUserLeave,
      handlePresenceSync,
      handleProfileUpdate
    }
  }

  // Store event listener references
  let eventListeners: any = null
  
  const cleanupEventListeners = () => {
    if (eventListeners) {
      professionalPresenceService.removeEventListener('status-changed', eventListeners.handleStatusChange)
      professionalPresenceService.removeEventListener('user-join', eventListeners.handleUserJoin)
      professionalPresenceService.removeEventListener('user-leave', eventListeners.handleUserLeave)
      professionalPresenceService.removeEventListener('presence-sync', eventListeners.handlePresenceSync)
      professionalPresenceService.removeEventListener('profile-updated', eventListeners.handleProfileUpdate)
      eventListeners = null
    }
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  /**
   * Initialize the professional presence system
   */
  const initialize = async (userId: string, username: string, avatar?: string): Promise<void> => {
    if (isInitialized.value) {
      console.log('🟢 Professional presence already initialized')
      return
    }

    isLoading.value = true
    lastError.value = null

    try {
      await professionalPresenceService.initialize(userId, username, avatar)
      eventListeners = setupEventListeners()
      isInitialized.value = true
      console.log('✅ Professional presence composable initialized')
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to initialize presence'
      console.error('❌ Failed to initialize professional presence:', error)
      throw error
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Cleanup the presence system
   */
  const cleanup = async (): Promise<void> => {
    cleanupEventListeners()
    await professionalPresenceService.cleanup()
    isInitialized.value = false
    lastError.value = null
  }

  // ============================================================================
  // PRESENCE DATA ACCESS
  // ============================================================================

  /**
   * Get user presence data (reactive)
   */
  const getUserPresence = (userId: string) => computed(() => {
    updateCounter.value // Force reactivity
    const presence = professionalPresenceService.getUserPresence(userId)
    if (userId === professionalPresenceService.getCurrentUserId()) {
      console.log('🔍 getUserPresence for current user:', userId, presence ? UserStatus[presence.status] : 'No presence')
    }
    return presence
  })

  /**
   * Get current user's status (reactive)
   */
  const getCurrentUserStatus = computed(() => {
    updateCounter.value // Force reactivity
    const status = professionalPresenceService.getCurrentUserStatus()
    console.log('🔍 getCurrentUserStatus called, returning:', UserStatus[status])
    return status
  })

  /**
   * Get current user ID (reactive)
   */
  const getCurrentUserId = computed(() => {
    updateCounter.value // Force reactivity
    return professionalPresenceService.getCurrentUserId()
  })

  /**
   * Get all online users (reactive)
   */
  const getOnlineUsers = computed(() => {
    updateCounter.value // Force reactivity
    return professionalPresenceService.getOnlineUsers()
  })

  /**
   * Check if user is online (reactive)
   */
  const isUserOnline = (userId: string) => computed(() => {
    updateCounter.value // Force reactivity
    return professionalPresenceService.isUserOnline(userId)
  })

  // ============================================================================
  // UI HELPERS
  // ============================================================================

  /**
   * Get status for avatar display
   */
  const getStatusForAvatar = (userId: string) => computed(() => {
    const presence = getUserPresence(userId).value
    if (!presence) return 'offline'
    
    switch (presence.status) {
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
   * Get human-readable status text
   */
  const getStatusText = (userId: string) => computed(() => {
    const presence = getUserPresence(userId).value
    if (!presence) return 'Offline'
    
    if (presence.customStatusText) {
      return presence.customStatusText
    }
    
    switch (presence.status) {
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
   * Get status color for UI
   */
  const getStatusColor = (userId: string) => computed(() => {
    const presence = getUserPresence(userId).value
    if (!presence) return '#80848e'
    
    switch (presence.status) {
      case UserStatus.Online:
        return '#23a55a'
      case UserStatus.Away:
        return '#f0b232'
      case UserStatus.Busy:
        return '#f23f43'
      case UserStatus.Offline:
      default:
        return '#80848e'
    }
  })

  /**
   * Get user display name
   */
  const getUserDisplayName = (userId: string) => computed(() => {
    const presence = getUserPresence(userId).value
    return presence?.displayName || presence?.username || 'Unknown User'
  })

  /**
   * Get user avatar URL
   */
  const getUserAvatarUrl = (userId: string) => computed(() => {
    const presence = getUserPresence(userId).value
    return presence?.avatarUrl || '/default_avatar.png'
  })

  /**
   * Get user color
   */
  const getUserColor = (userId: string) => computed(() => {
    const presence = getUserPresence(userId).value
    return presence?.color || '#dddddd'
  })

  /**
   * Get user bio
   */
  const getUserBio = (userId: string) => computed(() => {
    const presence = getUserPresence(userId).value
    return presence?.bio || ''
  })

  // Note: Verified status removed as it doesn't exist in current database schema

  // ============================================================================
  // CONTEXT MANAGEMENT
  // ============================================================================

  /**
   * Subscribe to server presence
   */
  const subscribeToServer = async (serverId: string, memberIds: string[]): Promise<void> => {
    try {
      await professionalPresenceService.subscribeToContext(serverId, 'server', memberIds, 2)
    } catch (error) {
      console.error('❌ Failed to subscribe to server presence:', error)
      throw error
    }
  }

  /**
   * Subscribe to DM presence
   */
  const subscribeToDM = async (conversationId: string, participantIds: string[]): Promise<void> => {
    try {
      await professionalPresenceService.subscribeToContext(conversationId, 'dm', participantIds, 3)
    } catch (error) {
      console.error('❌ Failed to subscribe to DM presence:', error)
      throw error
    }
  }

  /**
   * Subscribe to ActivityPub presence
   */
  const subscribeToActivityPub = async (contextId: string, userIds: string[]): Promise<void> => {
    try {
      await professionalPresenceService.subscribeToContext(contextId, 'activitypub', userIds, 1)
    } catch (error) {
      console.error('❌ Failed to subscribe to ActivityPub presence:', error)
      throw error
    }
  }

  /**
   * Subscribe to specific user presence
   */
  const subscribeToUser = async (userId: string): Promise<void> => {
    try {
      await professionalPresenceService.subscribeToContext(userId, 'global', [userId], 4)
    } catch (error) {
      console.error('❌ Failed to subscribe to user presence:', error)
      throw error
    }
  }

  /**
   * Unsubscribe from a context
   */
  const unsubscribeFromContext = async (contextId: string): Promise<void> => {
    try {
      await professionalPresenceService.unsubscribeFromContext(contextId)
    } catch (error) {
      console.error('❌ Failed to unsubscribe from context:', error)
      throw error
    }
  }

  // ============================================================================
  // STATUS MANAGEMENT
  // ============================================================================

  /**
   * Update current user's status
   */
  const updateCurrentUserStatus = async (newStatus: UserStatus, customText?: string): Promise<void> => {
    try {
      await professionalPresenceService.updateCurrentUserStatus(newStatus, customText)
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to update status'
      console.error('❌ Failed to update status:', error)
      throw error
    }
  }

  /**
   * Set user as online
   */
  const setOnline = async (customText?: string): Promise<void> => {
    await updateCurrentUserStatus(UserStatus.Online, customText)
  }

  /**
   * Set user as away
   */
  const setAway = async (customText?: string): Promise<void> => {
    await updateCurrentUserStatus(UserStatus.Away, customText)
  }

  /**
   * Set user as busy
   */
  const setBusy = async (customText?: string): Promise<void> => {
    await updateCurrentUserStatus(UserStatus.Busy, customText)
  }

  /**
   * Set user as offline
   */
  const setOffline = async (customText?: string): Promise<void> => {
    await updateCurrentUserStatus(UserStatus.Offline, customText)
  }

  // ============================================================================
  // ADVANCED FEATURES
  // ============================================================================

  /**
   * Get presence statistics
   */
  const getStats = computed(() => {
    updateCounter.value // Force reactivity
    return professionalPresenceService.getStats()
  })

  /**
   * Refresh all presence data
   */
  const refreshAllPresence = async (): Promise<void> => {
    try {
      await professionalPresenceService.refreshAllPresence()
      forceUpdate()
    } catch (error) {
      console.error('❌ Failed to refresh presence:', error)
      throw error
    }
  }

  /**
   * Force update reactivity
   */
  const forceReactivityUpdate = (): void => {
    forceUpdate()
  }

  // ============================================================================
  // LIFECYCLE MANAGEMENT
  // ============================================================================

  onMounted(() => {
    // Event listeners are set up during initialization
  })

  onUnmounted(() => {
    cleanupEventListeners()
  })

  // ============================================================================
  // RETURN API
  // ============================================================================

  return {
    // State
    isInitialized,
    isLoading,
    lastError,

    // Initialization
    initialize,
    cleanup,

    // Presence data
    getUserPresence,
    getCurrentUserStatus,
    getCurrentUserId,
    getOnlineUsers,
    getAllUsers: computed(() => {
      updateCounter.value // Force reactivity
      return professionalPresenceService.getAllUsers()
    }),
    getUsersInContext: (contextId: string) => computed(() => {
      updateCounter.value // Force reactivity
      return professionalPresenceService.getUsersInContext(contextId)
    }),
    isUserOnline,

    // UI helpers
    getStatusForAvatar,
    getStatusText,
    getStatusColor,
    getUserDisplayName,
    getUserAvatarUrl,
    getUserColor,
    getUserBio,

    // Context management
    subscribeToServer,
    subscribeToDM,
    subscribeToActivityPub,
    subscribeToUser,
    unsubscribeFromContext,

    // Status management
    updateCurrentUserStatus,
    setOnline,
    setAway,
    setBusy,
    setOffline,

    // Advanced features
    getStats,
    refreshAllPresence,
    forceReactivityUpdate,

    // Legacy compatibility helpers
    subscribeToServerUsers: subscribeToServer,
    subscribeToDMUsers: subscribeToDM,
    subscribeToUserPresence: subscribeToUser,
    initializePresence: initialize,
    getFullUserPresence: getUserPresence,
    getUserStatus: getUserPresence,
    getUserUsername: (userId: string) => computed(() => {
      const presence = getUserPresence(userId).value
      return presence?.username || 'unknown'
    }),
    getUserLastSeen: (userId: string) => computed(() => {
      const presence = getUserPresence(userId).value
      return presence?.lastSeen
    })
  }
}