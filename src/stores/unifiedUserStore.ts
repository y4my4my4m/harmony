/**
 * Unified User Store
 * 
 * Single source of truth for all user data across the application.
 * Provides reactive user information including presence, profiles, and status
 * without requiring individual components to manage presence subscriptions.
 * 
 * This addresses the architectural concern about having to implement 
 * presence tracking in every component that displays users.
 */

import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
import { professionalPresenceService, type UserPresence } from '@/services/professionalPresenceService'
import { UserStatus } from '@/types'
import type { User } from '@/types'

export interface UnifiedUser {
  // Core identity
  id: string
  username: string
  displayName: string
  
  // Profile data
  avatarUrl?: string
  bio?: string
  color?: string
  
  // Presence data (real-time)
  status: UserStatus
  isOnline: boolean
  lastSeen: string
  
  // Activity data
  currentActivity?: string
  customStatusText?: string
  
  // Metadata
  lastUpdated: string
}

export const useUnifiedUserStore = defineStore('unifiedUser', () => {
  // Internal state
  const users = reactive(new Map<string, UnifiedUser>())
  const lastSync = ref<Date | null>(null)
  const isInitialized = ref(false)
  
  // Event listener setup
  let eventListenersSetup = false
  
  // Initialize the store
  const initialize = async () => {
    if (isInitialized.value) return
    
    if (!eventListenersSetup) {
      setupEventListeners()
      eventListenersSetup = true
    }
    
    // Sync initial data from professional presence service
    syncFromPresenceService()
    
    isInitialized.value = true
    console.log('✅ Unified User Store initialized')
  }
  
  // Setup event listeners for real-time updates
  const setupEventListeners = () => {
    professionalPresenceService.addEventListener('user-join', handleUserUpdate)
    professionalPresenceService.addEventListener('user-leave', handleUserUpdate)
    professionalPresenceService.addEventListener('status-changed', handleUserUpdate)
    professionalPresenceService.addEventListener('profile-updated', handleUserUpdate)
    professionalPresenceService.addEventListener('presence-sync', handleBulkUpdate)
  }
  
  // Handle individual user updates
  const handleUserUpdate = (event: CustomEvent) => {
    syncFromPresenceService()
  }
  
  // Handle bulk presence updates
  const handleBulkUpdate = (event: CustomEvent) => {
    syncFromPresenceService()
  }
  
  // Sync all users from the professional presence service
  const syncFromPresenceService = () => {
    const allPresenceUsers = professionalPresenceService.getAllUsers()
    
    allPresenceUsers.forEach(presence => {
      updateUser(presence)
    })
    
    lastSync.value = new Date()
  }
  
  // Update a single user
  const updateUser = (presence: UserPresence) => {
    const unifiedUser: UnifiedUser = {
      id: presence.userId,
      username: presence.username,
      displayName: presence.displayName,
      avatarUrl: presence.avatarUrl,
      bio: presence.bio,
      color: presence.color,
      status: presence.status,
      isOnline: presence.isOnline,
      lastSeen: presence.lastSeen,
      currentActivity: presence.currentActivity,
      customStatusText: presence.customStatusText,
      lastUpdated: new Date().toISOString()
    }
    
    users.set(presence.userId, unifiedUser)
  }
  
  // Public API - Reactive getters
  
  /**
   * Get user by ID - always returns most up-to-date data
   */
  const getUser = (userId: string) => computed(() => {
    if (!isInitialized.value) {
      initialize()
    }
    
    let user = users.get(userId)
    
    // If user not found in store, try to get from presence service
    if (!user) {
      const presence = professionalPresenceService.getUserPresence(userId)
      if (presence) {
        updateUser(presence)
        user = users.get(userId)
      }
    }
    
    return user || null
  })
  
  /**
   * Get user avatar URL
   */
  const getUserAvatarUrl = (userId: string) => computed(() => {
    const user = getUser(userId).value
    return user?.avatarUrl || '/default_avatar.png'
  })
  
  /**
   * Get user display name
   */
  const getUserDisplayName = (userId: string) => computed(() => {
    const user = getUser(userId).value
    return user?.displayName || user?.username || 'Unknown User'
  })
  
  /**
   * Get user status for avatar display
   */
  const getUserStatusForAvatar = (userId: string) => computed(() => {
    const user = getUser(userId).value
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
    const user = getUser(userId).value
    if (!user) return 'Offline'
    
    if (user.customStatusText) {
      return user.customStatusText
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
    const user = getUser(userId).value
    return user?.color || '#dddddd'
  })
  
  /**
   * Check if user is online
   */
  const isUserOnline = (userId: string) => computed(() => {
    const user = getUser(userId).value
    return user?.isOnline || false
  })
  
  /**
   * Get all users in a context (server, DM, etc.)
   */
  const getUsersInContext = (contextId: string) => computed(() => {
    if (!isInitialized.value) {
      initialize()
    }
    
    const contextUsers = professionalPresenceService.getUsersInContext(contextId)
    
    // Ensure all context users are in our store
    contextUsers.forEach(presence => {
      updateUser(presence)
    })
    
    return contextUsers.map(presence => users.get(presence.userId)).filter(Boolean) as UnifiedUser[]
  })
  
  /**
   * Get all online users
   */
  const getOnlineUsers = computed(() => {
    if (!isInitialized.value) {
      initialize()
    }
    
    return Array.from(users.values()).filter(user => user.isOnline)
  })
  
  /**
   * Get all users
   */
  const getAllUsers = computed(() => {
    if (!isInitialized.value) {
      initialize()
    }
    
    return Array.from(users.values())
  })
  
  /**
   * Convert UnifiedUser to legacy User format for compatibility
   */
  const toLegacyUser = (unifiedUser: UnifiedUser): User => {
    return {
      id: unifiedUser.id,
      username: unifiedUser.username,
      display_name: unifiedUser.displayName,
      avatar_url: unifiedUser.avatarUrl,
      status: unifiedUser.status
    }
  }
  
  /**
   * Get users in legacy format for compatibility
   */
  const getUsersInContextLegacy = (contextId: string) => computed(() => {
    return getUsersInContext(contextId).value.map(toLegacyUser)
  })
  
  // Stats and debugging
  const getStats = computed(() => ({
    totalUsers: users.size,
    onlineUsers: getOnlineUsers.value.length,
    lastSync: lastSync.value,
    isInitialized: isInitialized.value
  }))
  
  // Force refresh
  const forceRefresh = () => {
    syncFromPresenceService()
  }
  
  // Cleanup
  const cleanup = () => {
    if (eventListenersSetup) {
      professionalPresenceService.removeEventListener('user-join', handleUserUpdate)
      professionalPresenceService.removeEventListener('user-leave', handleUserUpdate)
      professionalPresenceService.removeEventListener('status-changed', handleUserUpdate)
      professionalPresenceService.removeEventListener('profile-updated', handleUserUpdate)
      professionalPresenceService.removeEventListener('presence-sync', handleBulkUpdate)
      eventListenersSetup = false
    }
    
    users.clear()
    isInitialized.value = false
  }
  
  return {
    // Initialization
    initialize,
    cleanup,
    forceRefresh,
    
    // User data getters (reactive)
    getUser,
    getUserAvatarUrl,
    getUserDisplayName,
    getUserStatusForAvatar,
    getUserStatusText,
    getUserColor,
    isUserOnline,
    
    // Context-based getters
    getUsersInContext,
    getUsersInContextLegacy,
    getOnlineUsers,
    getAllUsers,
    
    // Utilities
    toLegacyUser,
    getStats,
    
    // State
    isInitialized
  }
})