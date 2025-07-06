import { useServerUsersStore } from '@/stores/useServerUsers'
import { GetUserProfileById, GetUserProfileByUsername, IsUserProfileCached } from '@/utils/getFromUser'
import type { UserStatus, Channel, User } from '@/types'
import { ref, computed } from 'vue'

export function useUserProfile() {
  const serverUsersStore = useServerUsersStore()
  const loading = ref(false)
  const error = ref<string | null>(null)

  const getUserAvatar = (userId: string) => {
    return serverUsersStore.userProfiles[userId]?.avatar_url || '/default_avatar.png'
  }

  const getUserDisplayName = (userId: string) => {
    return serverUsersStore.userProfiles[userId]?.display_name || 'Unknown User'
  }

  const getUserColor = (userId: string) => {
    return serverUsersStore.userProfiles[userId]?.color || '#ffffff'
  }

  const getUserStatus = (userId: string) => {
    return serverUsersStore.userProfiles[userId]?.status || 0
  }

  // Enhanced methods with caching
  const getProfile = (userId: string): User | null => {
    return serverUsersStore.getUserProfile(userId)
  }

  const isProfileCached = (userId: string): boolean => {
    return IsUserProfileCached(userId)
  }

  // Fetch profile by ID with caching
  const fetchProfile = async (userId: string, forceRefresh = false): Promise<User | null> => {
    if (!userId) return null

    loading.value = true
    error.value = null

    try {
      const fetchedProfile = await GetUserProfileById(userId, forceRefresh)
      return fetchedProfile
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch profile'
      console.error('Error fetching profile:', err)
      return null
    } finally {
      loading.value = false
    }
  }

  // Fetch profile by username with caching
  const fetchProfileByUsername = async (username: string, forceRefresh = false): Promise<User | null> => {
    if (!username) return null

    loading.value = true
    error.value = null

    try {
      const fetchedProfile = await GetUserProfileByUsername(username, forceRefresh)
      return fetchedProfile
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch profile'
      console.error('Error fetching profile by username:', err)
      return null
    } finally {
      loading.value = false
    }
  }

  // Ensure profile is loaded (fetch if not cached)
  const ensureProfile = async (userId: string): Promise<User | null> => {
    if (IsUserProfileCached(userId)) {
      return serverUsersStore.getUserProfile(userId)
    }
    return await fetchProfile(userId)
  }

  // Refresh profile from server
  const refreshProfile = async (userId: string): Promise<User | null> => {
    return await fetchProfile(userId, true)
  }

  // Get display name with fallback to fetching if not cached
  const getDisplayNameWithFetch = async (userId: string): Promise<string> => {
    const cachedProfile = getProfile(userId)
    if (cachedProfile?.display_name) {
      return cachedProfile.display_name
    }

    // Try to fetch the profile
    const profile = await ensureProfile(userId)
    return profile?.display_name || 'Unknown User'
  }

  // Get avatar with fallback to fetching if not cached
  const getAvatarWithFetch = async (userId: string): Promise<string> => {
    const cachedProfile = getProfile(userId)
    if (cachedProfile?.avatar_url) {
      return cachedProfile.avatar_url
    }

    // Try to fetch the profile
    const profile = await ensureProfile(userId)
    return profile?.avatar_url || '/default_avatar.png'
  }

  const getUserStatusClass = (status: UserStatus) => {
    switch (status) {
      case 1: // Online
        return 'status-online'
      case 2: // Away
        return 'status-away'
      case 3: // Busy
        return 'status-busy'
      case 0: // Offline
      default:
        return 'status-offline'
    }
  }

  const getUserStatusText = (status: UserStatus) => {
    switch (status) {
      case 1: // Online
        return 'Online'
      case 2: // Away
        return 'Away'
      case 3: // Busy
        return 'Do Not Disturb'
      case 0: // Offline
      default:
        return 'Offline'
    }
  }

  return {
    getUserAvatar,
    getUserDisplayName,
    getUserColor,
    getUserStatus,
    getUserStatusClass,
    getUserStatusText,
    loading,
    error,
    fetchProfile,
    fetchProfileByUsername,
    ensureProfile,
    refreshProfile,
    getDisplayNameWithFetch,
    getAvatarWithFetch
  }
}

export function useChannelSelection() {
  const getDefaultChannel = (channels: Channel[], categories: any[], categoryChannels: Record<string, Channel[]>) => {
    // Priority order for channel selection:
    // 1. First text channel in first category
    // 2. First orphan text channel 
    // 3. Any first channel as fallback

    // Try to find first text channel in first category
    if (categories && categories.length > 0) {
      for (const category of categories) {
        const categoryChannelList = categoryChannels[category.id] || []
        const firstTextChannel = categoryChannelList.find(ch => ch.type === 0) // Text channel
        if (firstTextChannel) {
          return firstTextChannel.id
        }
      }
    }

    // Try to find first orphan text channel
    const orphanChannels = channels.filter(channel => !channel.category)
    const firstOrphanTextChannel = orphanChannels.find(ch => ch.type === 0)
    if (firstOrphanTextChannel) {
      return firstOrphanTextChannel.id
    }

    // Fallback to any first available channel
    const firstChannel = channels.find(ch => ch.type === 0) || channels[0]
    return firstChannel?.id || null
  }

  return {
    getDefaultChannel
  }
}