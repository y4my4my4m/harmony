/**
 * Clean User Status Composable
 * 
 * Professional, scalable interface      // Update in backend/presence service
      const { globalPresenceService } = await import('@/services/globalPresenceService')
      await globalPresenceService.setUserStatus(statusStore.currentUserId, newStatus)
      
      // Also update in user profile through service layer
      const { updateUserStatus } = await import('@/services/profileService')
      await updateUserStatus(statusStore.currentUserId, newStatus)er status system.
 * Uses the clean status store with proper separation of concerns.
 * 
 * Features:
 * - Clean reactive status access
 * - No side effects on user profiles
 * - Type-safe status helpers
 * - Proper Vue 3 composition patterns
 */

import { computed } from 'vue'
import { UserStatus } from '@/types'
import { useUserStatusStore, type CleanUserStatus } from '@/stores/userStatusStore'

export function useCleanUserStatus() {
  const statusStore = useUserStatusStore()

  // Status getters
  const getUserStatus = (userId: string) => computed(() => statusStore.getStatus(userId))
  
  const getCurrentUserStatus = computed(() => statusStore.getCurrentUserStatus)
  
  const getOnlineUsers = computed(() => statusStore.getOnlineUsers)
  
  const getUsersByStatus = computed(() => statusStore.getUsersByStatus)

  // Status helpers for UI components
  const getStatusForAvatar = (userId: string) => computed(() => {
    const status = statusStore.getStatus(userId)
    switch (status.status) {
      case UserStatus.Online: return 'online'
      case UserStatus.Away: return 'away'
      case UserStatus.Busy: return 'busy'
      default: return 'offline'
    }
  })

  const getStatusColor = (userId: string) => computed(() => {
    const status = statusStore.getStatus(userId)
    switch (status.status) {
      case UserStatus.Online: return '#00ff00'
      case UserStatus.Away: return '#ffff00'
      case UserStatus.Busy: return '#ff0000'
      default: return '#666666'
    }
  })

  const getStatusText = (userId: string) => computed(() => {
    const status = statusStore.getStatus(userId)
    switch (status.status) {
      case UserStatus.Online: return 'Online'
      case UserStatus.Away: return 'Away'
      case UserStatus.Busy: return 'Busy'
      default: return 'Offline'
    }
  })

  const isUserOnline = (userId: string) => computed(() => {
    return statusStore.getStatus(userId).isOnline
  })

  // Status actions
  const updateCurrentUserStatus = async (newStatus: UserStatus): Promise<void> => {
    if (!statusStore.currentUserId) {
      console.error('Cannot update status: no current user set')
      return
    }

    try {
      // Update in store immediately for UI responsiveness
      statusStore.updateStatus(statusStore.currentUserId, newStatus)
      
      // Update in backend/presence service
      const { globalPresenceService } = await import('@/services/globalPresenceService')
      await globalPresenceService.setUserStatus(newStatus)
      
      // Also update in user profile through service layer
      const { updateUserStatus } = await import('@/services/profileService')
      await updateUserStatus(statusStore.currentUserId, newStatus)
      
      console.log('✅ Updated user status to:', UserStatus[newStatus])
    } catch (error) {
      console.error('❌ Failed to update user status:', error)
      // Revert the optimistic update
      const currentStatus = statusStore.getStatus(statusStore.currentUserId).status
      statusStore.updateStatus(statusStore.currentUserId, currentStatus)
      throw error
    }
  }

  const initializeStatus = async (userId: string): Promise<void> => {
    await statusStore.initializeFromPresenceService(userId)
  }

  const initializeServerUsers = (userIds: string[]): void => {
    statusStore.initializeServerUsers(userIds)
  }

  // Utility functions
  const groupUsersByStatus = (userIds: string[]): {
    online: CleanUserStatus[]
    away: CleanUserStatus[]
    busy: CleanUserStatus[]
    offline: CleanUserStatus[]
  } => {
    const groups = {
      online: [] as CleanUserStatus[],
      away: [] as CleanUserStatus[],
      busy: [] as CleanUserStatus[],
      offline: [] as CleanUserStatus[]
    }

    userIds.forEach(userId => {
      const status = statusStore.getStatus(userId)
      switch (status.status) {
        case UserStatus.Online:
          groups.online.push(status)
          break
        case UserStatus.Away:
          groups.away.push(status)
          break
        case UserStatus.Busy:
          groups.busy.push(status)
          break
        default:
          groups.offline.push(status)
      }
    })

    return groups
  }

  return {
    // Getters
    getUserStatus,
    getCurrentUserStatus,
    getOnlineUsers,
    getUsersByStatus,
    
    // UI Helpers
    getStatusForAvatar,
    getStatusColor,
    getStatusText,
    isUserOnline,
    
    // Actions
    updateCurrentUserStatus,
    initializeStatus,
    initializeServerUsers,
    
    // Utilities
    groupUsersByStatus
  }
}
