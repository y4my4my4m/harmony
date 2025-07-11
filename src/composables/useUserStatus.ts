/**
 * Unified User Status Composable
 * 
 * Provides a clean, reactive interface to the global user status system.
 * This is the single source of truth for user status across all components.
 * 
 * Features:
 * - Reactive user status for any user ID
 * - Automatic subscription to presence updates
 * - Helper functions for status display
 * - Integration with global presence service
 * - View-context awareness
 */

import { ref, computed, onUnmounted, watch } from 'vue'
import { globalPresenceService, type UserPresence } from '@/services/globalPresenceService'
import { UserStatus } from '@/types'

// Global reactive state for all user statuses
const globalUserStatuses = ref<Map<string, UserPresence>>(new Map())
const isInitialized = ref(false)

// Event listeners for presence updates
let statusUpdateListener: ((event: CustomEvent) => void) | null = null
let userOnlineListener: ((event: CustomEvent) => void) | null = null
let userOfflineListener: ((event: CustomEvent) => void) | null = null

/**
 * Initialize the global user status system
 * Should be called once during app initialization
 */
export async function initializeUserStatus(userId: string, username: string, avatar?: string): Promise<void> {
  if (isInitialized.value) {
    console.log('🟢 User status system already initialized')
    return
  }

  console.log('🔄 Initializing global user status system...')

  try {
    // Initialize the global presence service
    await globalPresenceService.initialize(userId, username, avatar)

    // Set up event listeners for presence updates
    setupPresenceEventListeners()

    // Initialize the presence context manager
    // (This will be connected when the unified app service is available)
    
    isInitialized.value = true
    console.log('✅ Global user status system initialized')
  } catch (error) {
    console.error('❌ Failed to initialize user status system:', error)
    throw error
  }
}

/**
 * Set up event listeners for presence updates
 */
function setupPresenceEventListeners(): void {
  // Listen for status changes
  statusUpdateListener = (event: CustomEvent) => {
    const { userId, status } = event.detail
    console.log('🔄 Status update event received for user:', userId, 'status:', UserStatus[status])
    updateUserStatus(userId, { status })
  }
  globalPresenceService.addEventListener('user-status-changed', statusUpdateListener)

  // Listen for user online/offline events
  userOnlineListener = (event: CustomEvent) => {
    const { userId } = event.detail
    console.log('🟢 User online event received for user:', userId)
    updateUserStatus(userId, { isOnline: true })
  }
  globalPresenceService.addEventListener('user-online', userOnlineListener)

  userOfflineListener = (event: CustomEvent) => {
    const { userId } = event.detail
    console.log('🔴 User offline event received for user:', userId)
    updateUserStatus(userId, { isOnline: false, status: UserStatus.Offline })
  }
  globalPresenceService.addEventListener('user-offline', userOfflineListener)
}

/**
 * Update user status in the global reactive state
 */
function updateUserStatus(userId: string, updates: Partial<UserPresence>): void {
  const currentStatuses = new Map(globalUserStatuses.value)
  const existing = currentStatuses.get(userId) || {
    userId,
    status: UserStatus.Offline,
    isOnline: false,
    lastSeen: new Date().toISOString()
  }
  
  const updated = { ...existing, ...updates }
  currentStatuses.set(userId, updated)
  globalUserStatuses.value = currentStatuses
  
  console.log('🔄 Updated reactive user status for', userId, ':', UserStatus[updated.status], 'online:', updated.isOnline)
}

/**
 * Main composable for user status
 */
export function useUserStatus() {
  /**
   * Get user status for a specific user
   */
  const getUserStatus = (userId: string) => {
    return computed(() => {
      const reactivePresence = globalUserStatuses.value.get(userId)
      const servicePresence = globalPresenceService.getUserPresence(userId)
      
      console.log(`🔍 Getting status for user ${userId}:`)
      console.log('  - Reactive presence:', reactivePresence)
      console.log('  - Service presence:', servicePresence)
      
      const presence = reactivePresence || servicePresence
      if (presence) {
        // Ensure the reactive state is updated
        updateUserStatus(userId, presence)
        return presence
      }
      
      // Return default offline status
      const defaultPresence = {
        userId,
        status: UserStatus.Offline,
        isOnline: false,
        lastSeen: new Date().toISOString()
      }
      console.log('  - Using default offline presence:', defaultPresence)
      return defaultPresence
    })
  }

  /**
   * Check if a user is online
   */
  const isUserOnline = (userId: string) => {
    return computed(() => {
      return getUserStatus(userId).value.isOnline
    })
  }

  /**
   * Get user status as enum value
   */
  const getUserStatusEnum = (userId: string) => {
    return computed(() => {
      return getUserStatus(userId).value.status
    })
  }

  /**
   * Get user status as display text
   */
  const getUserStatusText = (userId: string) => {
    return computed(() => {
      const status = getUserStatus(userId).value.status
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
  }

  /**
   * Get user status CSS class for styling
   */
  const getUserStatusClass = (userId: string) => {
    return computed(() => {
      const status = getUserStatus(userId).value.status
      switch (status) {
        case UserStatus.Online:
          return 'status-online'
        case UserStatus.Away:
          return 'status-away'
        case UserStatus.Busy:
          return 'status-busy'
        case UserStatus.Offline:
        default:
          return 'status-offline'
      }
    })
  }

  /**
   * Get user status for avatar display
   */
  const getUserStatusForAvatar = (userId: string) => {
    return computed(() => {
      const status = getUserStatus(userId).value.status
      switch (status) {
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
  }

  /**
   * Set the current user's status
   */
  const setCurrentUserStatus = async (status: UserStatus): Promise<void> => {
    try {
      await globalPresenceService.setUserStatus(status)
      
      // The global presence service should already emit events that update the reactive state
      // but we can force an immediate update to ensure UI responsiveness
      console.log('✅ User status set to:', UserStatus[status])
    } catch (error) {
      console.error('Failed to set user status:', error)
      throw error
    }
  }

  /**
   * Get current user's status
   */
  const getCurrentUserStatus = () => {
    return computed(() => globalPresenceService.getCurrentUserStatus())
  }

  /**
   * Get all online users
   */
  const getOnlineUsers = () => {
    return computed(() => globalPresenceService.getOnlineUsers())
  }

  /**
   * Subscribe to presence updates for specific users
   * Useful for context-specific subscriptions
   */
  const subscribeToUsers = (
    contextId: string,
    contextType: 'server' | 'dm' | 'activitypub' | 'global',
    userIds: string[],
    priority: number = 1
  ): void => {
    globalPresenceService.subscribeToContext(contextId, contextType, userIds, priority)
  }

  /**
   * Unsubscribe from a context
   */
  const unsubscribeFromContext = (contextId: string): void => {
    globalPresenceService.unsubscribeFromContext(contextId)
  }

  return {
    // Status getters
    getUserStatus,
    isUserOnline,
    getUserStatusEnum,
    getUserStatusText,
    getUserStatusClass,
    getUserStatusForAvatar,
    
    // Current user
    setCurrentUserStatus,
    getCurrentUserStatus,
    
    // Global state
    getOnlineUsers,
    isInitialized: computed(() => isInitialized.value),
    
    // Context management
    subscribeToUsers,
    unsubscribeFromContext
  }
}

/**
 * Cleanup user status system
 * Should be called when the app is shutting down
 */
export async function cleanupUserStatus(): Promise<void> {
  if (!isInitialized.value) return

  console.log('🧹 Cleaning up user status system...')

  // Remove event listeners
  if (statusUpdateListener) {
    globalPresenceService.removeEventListener('user-status-changed', statusUpdateListener)
  }
  if (userOnlineListener) {
    globalPresenceService.removeEventListener('user-online', userOnlineListener)
  }
  if (userOfflineListener) {
    globalPresenceService.removeEventListener('user-offline', userOfflineListener)
  }

  // Cleanup global presence service
  await globalPresenceService.cleanup()

  // Clear reactive state
  globalUserStatuses.value.clear()
  isInitialized.value = false

  console.log('✅ User status system cleaned up')
}

/**
 * Context-aware user status hook
 * Automatically manages presence subscriptions based on provided user lists
 */
export function useContextUserStatus(
  contextId: string,
  contextType: 'server' | 'dm' | 'activitypub' | 'global',
  userIds: () => string[],
  priority: number = 1
) {
  const { subscribeToUsers, unsubscribeFromContext, ...statusMethods } = useUserStatus()

  // Watch for changes in user IDs and update subscriptions
  watch(
    userIds,
    (newUserIds, oldUserIds) => {
      if (newUserIds.length > 0 && JSON.stringify(newUserIds) !== JSON.stringify(oldUserIds)) {
        subscribeToUsers(contextId, contextType, newUserIds, priority)
      }
    },
    { immediate: true }
  )

  // Cleanup on unmount
  onUnmounted(() => {
    unsubscribeFromContext(contextId)
  })

  return {
    ...statusMethods,
    subscribeToUsers,
    unsubscribeFromContext
  }
}
