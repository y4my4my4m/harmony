/**
 * Clean Profile Presence Composable
 * 
 * Provides a clean, simple interface for accessing real-time profile data.
 * Works alongside useCleanUserStatus to provide complete user presence.
 * 
 * Usage:
 * const { getUserAvatar, getUserDisplayName, getUserColor } = useProfilePresence()
 * const avatar = getUserAvatar(userId)
 * const displayName = getUserDisplayName(userId)
 */

import { computed } from 'vue'
import { useProfilePresenceStore } from '@/stores/profilePresenceStore'

export function useProfilePresence() {
  const profilePresenceStore = useProfilePresenceStore()

  // Initialize the store if not already done
  if (!profilePresenceStore.isInitialized) {
    profilePresenceStore.initialize()
  }

  // Profile getters
  const getUserProfile = (userId: string) => {
    return computed(() => profilePresenceStore.getProfile(userId))
  }

  const getUserAvatar = (userId: string) => {
    return computed(() => profilePresenceStore.getUserAvatar(userId))
  }

  const getUserDisplayName = (userId: string) => {
    return computed(() => profilePresenceStore.getUserDisplayName(userId))
  }

  const getUserColor = (userId: string) => {
    return computed(() => profilePresenceStore.getUserColor(userId))
  }

  const getUserBio = (userId: string) => {
    return computed(() => profilePresenceStore.getUserBio(userId))
  }

  // Convenience methods for getting multiple users
  const getMultipleUserProfiles = (userIds: string[]) => {
    return computed(() => 
      userIds.map(userId => ({
        userId,
        profile: profilePresenceStore.getProfile(userId)
      }))
    )
  }

  return {
    // Single user getters
    getUserProfile,
    getUserAvatar,
    getUserDisplayName,
    getUserColor,
    getUserBio,

    // Multiple user helpers
    getMultipleUserProfiles,

    // Store access for advanced usage
    profilePresenceStore
  }
}
