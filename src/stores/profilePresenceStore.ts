/**
 * Profile Presence Store
 * 
 * Manages real-time profile information for all users.
 * Works alongside the status store to provide complete user presence data.
 * 
 * Architecture:
 * - Reactive Map for profile data
 * - Real-time updates via presence service
 * - Context-based subscriptions
 * - Automatic cache management
 */

import { ref, computed, type Ref } from 'vue'
import { defineStore } from 'pinia'
import { globalPresenceService, type ProfilePresenceData } from '@/services/globalPresenceService'

export interface ProfilePresence {
  userId: string
  username?: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  color?: string
  verified?: boolean
  lastUpdated: string
}

export const useProfilePresenceStore = defineStore('profilePresence', () => {
  // Profile presence data - separate from status
  const profileMap: Ref<Map<string, ProfilePresence>> = ref(new Map())
  const isInitialized = ref(false)

  // Computed getters
  const getAllProfiles = computed(() => profileMap.value)
  
  const getProfile = (userId: string): ProfilePresence | null => {
    return profileMap.value.get(userId) || null
  }

  const getUserAvatar = (userId: string): string => {
    const profile = profileMap.value.get(userId)
    return profile?.avatarUrl || '/default_avatar.png'
  }

  const getUserDisplayName = (userId: string): string => {
    const profile = profileMap.value.get(userId)
    return profile?.displayName || profile?.username || 'Unknown User'
  }

  const getUserColor = (userId: string): string => {
    const profile = profileMap.value.get(userId)
    return profile?.color || '#dddddd'
  }

  const getUserBio = (userId: string): string => {
    const profile = profileMap.value.get(userId)
    return profile?.bio || ''
  }

  // Actions
  const setProfile = (userId: string, profileData: Partial<ProfilePresence>): void => {
    const current = profileMap.value.get(userId) || {
      userId,
      lastUpdated: new Date().toISOString()
    }

    const updated = { 
      ...current, 
      ...profileData, 
      lastUpdated: new Date().toISOString() 
    }
    profileMap.value.set(userId, updated)
  }

  const updateProfile = (userId: string, profileData: Partial<ProfilePresenceData>): void => {
    setProfile(userId, {
      username: profileData.username,
      displayName: profileData.displayName,
      avatarUrl: profileData.avatarUrl,
      bio: profileData.bio,
      color: profileData.color,
      verified: profileData.verified
    })
  }

  const removeProfile = (userId: string): void => {
    profileMap.value.delete(userId)
  }

  const clearAllProfiles = (): void => {
    profileMap.value.clear()
  }

  // Initialize with presence service integration
  const initialize = (): void => {
    if (isInitialized.value) return

    console.log('🔄 Initializing profile presence store')

    // Listen for profile change events from presence service
    globalPresenceService.addEventListener('user-profile-changed', (event) => {
      const { userId, profileData } = event.detail
      console.log(`📥 Profile change received for user: ${userId}`, profileData)
      updateProfile(userId, profileData)
    })

    // Listen for presence sync events to get initial profile data
    globalPresenceService.addEventListener('presence-sync', () => {
      // When presence syncs, we get user data including profile info
      console.log('📥 Presence sync received, updating profiles')
      // This would be handled by the presence service itself
    })

    isInitialized.value = true
    console.log('✅ Profile presence store initialized')
  }

  // Cleanup
  const cleanup = (): void => {
    profileMap.value.clear()
    isInitialized.value = false
  }

  return {
    // State
    profileMap: getAllProfiles,
    isInitialized,

    // Getters
    getProfile,
    getUserAvatar,
    getUserDisplayName,
    getUserColor,
    getUserBio,

    // Actions
    setProfile,
    updateProfile,
    removeProfile,
    clearAllProfiles,
    initialize,
    cleanup
  }
})
