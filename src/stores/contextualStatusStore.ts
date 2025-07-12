import { defineStore } from 'pinia'
import { computed } from 'vue'
import { globalPresenceService, type UserPresence } from '@/services/globalPresenceService'
import { UserStatus } from '@/types'

export const useContextualStatusStore = defineStore('contextualStatus', () => {
  // Reactive getters that wrap the global presence service
  const getUserPresence = computed(() => {
    return (userId: string): UserPresence | null => {
      return globalPresenceService.getUserPresence(userId)
    }
  })

  const getCurrentUserStatus = computed(() => {
    return globalPresenceService.getCurrentUserStatus()
  })

  const getCurrentUserId = computed(() => {
    return globalPresenceService.getCurrentUserId()
  })

  const getOnlineUsers = computed(() => {
    return globalPresenceService.getOnlineUsers()
  })

  const isUserOnline = computed(() => {
    return (userId: string): boolean => {
      return globalPresenceService.isUserOnline(userId)
    }
  })

  // Context subscription methods (direct passthrough to global service)
  const subscribeToContext = (
    contextId: string, 
    contextType: 'server' | 'dm' | 'activitypub' | 'global', 
    userIds: string[],
    priority: number = 1
  ) => {
    return globalPresenceService.subscribeToContext(contextId, contextType, userIds, priority)
  }

  const unsubscribeFromContext = (contextId: string) => {
    return globalPresenceService.unsubscribeFromContext(contextId)
  }

  // Status update methods
  const setUserStatus = (status: UserStatus) => {
    return globalPresenceService.setUserStatus(status)
  }

  const forceUpdateCurrentUserPresence = () => {
    return globalPresenceService.forceUpdateCurrentUserPresence()
  }

  // Event handling
  const addEventListener = <K extends keyof import('@/services/globalPresenceService').PresenceEvents>(
    type: K,
    listener: (event: CustomEvent<import('@/services/globalPresenceService').PresenceEvents[K]>) => void
  ) => {
    return globalPresenceService.addEventListener(type, listener)
  }

  const removeEventListener = <K extends keyof import('@/services/globalPresenceService').PresenceEvents>(
    type: K,
    listener: (event: CustomEvent<import('@/services/globalPresenceService').PresenceEvents[K]>) => void
  ) => {
    return globalPresenceService.removeEventListener(type, listener)
  }

  // Initialization and cleanup
  const initialize = (userId: string, username: string, avatar?: string) => {
    return globalPresenceService.initialize(userId, username, avatar)
  }

  const cleanup = () => {
    return globalPresenceService.cleanup()
  }

  return {
    // Reactive getters
    getUserPresence,
    getCurrentUserStatus,
    getCurrentUserId,
    getOnlineUsers,
    isUserOnline,
    
    // Subscription methods
    subscribeToContext,
    unsubscribeFromContext,
    
    // Update methods
    setUserStatus,
    forceUpdateCurrentUserPresence,
    
    // Event handling
    addEventListener,
    removeEventListener,
    
    // Lifecycle methods
    initialize,
    cleanup
  }
})