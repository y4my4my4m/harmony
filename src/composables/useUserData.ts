/**
 * useUserData Composable
 * 
 * Clean, simple wrapper around userDataService for component usage.
 * Provides reactive user data without the complexity of the old system.
 */

import { computed, ref } from 'vue'
import { userDataService } from '@/services/userDataService'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useVisualTheme } from '@/composables/useVisualTheme'
import { UserStatus, type DisplayNamePart } from '@/types'
import { getAvatarUrl } from '@/utils/avatarUtils'
import { debug } from '@/utils/debug'

export function useUserData() {
  const isInitialized = ref(false)
  const forceUpdate = ref(0)
  
  // Force reactivity by updating the counter
  const triggerUpdate = () => {
    forceUpdate.value++
  }
  
  const setupEventListeners = () => {
    const listeners = [
      { type: 'user-updated', listener: triggerUpdate },
      { type: 'status-changed', listener: triggerUpdate },
      { type: 'custom-status-changed', listener: triggerUpdate },
      { type: 'presence-sync', listener: triggerUpdate },
      { type: 'data-refreshed', listener: triggerUpdate },
      { type: 'context-updated', listener: triggerUpdate },
      { type: 'global-presence-updated', listener: triggerUpdate }
    ]
    
    listeners.forEach(({ type, listener }) => {
      userDataService.addEventListener(type, listener)
    })
  }
  
  const ensureInitialized = () => {
    if (!isInitialized.value) {
      setupEventListeners()
      isInitialized.value = true
    }
  }
  
  ensureInitialized()
  
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
  const getUserAvatarUrl = (userId: string | null | undefined) => computed(() => {
    forceUpdate.value // Force reactivity
    if (!userId) return '/default_avatar.webp'
    const user = userDataService.getUser(userId)
    return user?.avatarUrl || '/default_avatar.webp'
  })

  /**
   * Get user avatar URL for current user
   * Always use getAvatarUrl to handle null/undefined and optimization
   */
  const getUserAvatarUrlCurrent = computed(() => {
    forceUpdate.value // Force reactivity
    const currentUser = userDataService.getCurrentUser()
    if (!currentUser) {
      return '/default_avatar.webp'
    }
    // Always use getAvatarUrl - it handles null/undefined and optimization
    return getAvatarUrl(currentUser.avatarUrl)
  })
  
  /**
   * Strip :shortcode: patterns from display name when emojis are disabled
   */
  const stripEmojiShortcodes = (text: string): string => {
    if (!text) return text
    const stripped = text.replace(/:[a-zA-Z0-9_+-]+:/g, '').replace(/\s+/g, ' ').trim()
    return stripped || text
  }

  /**
   * Get user display name (plain text, shortcodes stripped when emojis disabled).
   *
   * Fallback chain: trimmed `displayName` → trimmed `username` → `'Unknown User'`.
   * Each level rejects whitespace-only / empty strings so that bad data
   * stored before the display-name-empty validation landed (`PROFILES_DISPLAY_NAME_NOT_BLANK`
   * CHECK constraint + `UserAccountSettings.vue` UI guard) doesn't leak a
   * blank row into the UI.
   */
  const getUserDisplayName = (userId: string | null | undefined) => computed(() => {
    forceUpdate.value // Force reactivity
    if (!userId) return 'Unknown User'
    const user = userDataService.getUser(userId)
    const trimmedDisplay = (user?.displayName || '').trim()
    const trimmedUsername = (user?.username || '').trim()
    let name = trimmedDisplay || trimmedUsername || 'Unknown User'
    const instanceSettings = useInstanceSettingsStore()
    const theme = useVisualTheme()
    const hideEmojis = !instanceSettings.settings.allowCustomEmojisInDisplayNames ||
      theme.currentSettings.value?.showCustomEmojisInDisplayNames === false
    if (hideEmojis && name) name = stripEmojiShortcodes(name)
    // If stripping shortcodes produced an empty string (e.g. the display
    // name was nothing but custom emojis and the user disabled them), fall
    // back the same way again rather than rendering a blank pill.
    if (!name || !name.trim()) {
      return trimmedUsername || 'Unknown User'
    }
    return name
  })

  /**
   * Get pre-resolved display name parts (with inline emoji data).
   * Returns undefined when display name has no custom emojis,
   * or when instance disables custom emojis in display names.
   */
  const getUserDisplayNameParts = (userId: string) => computed<DisplayNamePart[] | undefined>(() => {
    forceUpdate.value
    const instanceSettings = useInstanceSettingsStore()
    if (!instanceSettings.settings.allowCustomEmojisInDisplayNames) {
      return undefined
    }
    const theme = useVisualTheme()
    if (theme.currentSettings.value?.showCustomEmojisInDisplayNames === false) {
      return undefined
    }
    return userDataService.getUser(userId)?.displayNameParts
  })
  
  /**
   * Get user status text
   * Takes into account whether user is actually online (present)
   */
  const getUserStatusText = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    if (!user) return 'Offline'
    
    // If user is not present (not online), show as Offline
    // regardless of their stored status preference
    if (!user.isOnline) {
      return 'Offline'
    }
    
    // User is online - check for custom status first
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
  const getUserColor = (userId: string | null | undefined) => computed(() => {
    forceUpdate.value // Force reactivity
    if (!userId) return '#ffffff'
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
   * Check if user is a local user (not federated)
   */
  const isUserLocal = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    // Default to true if we don't have the data yet
    return user?.isLocal ?? true
  })

  /**
   * Get user's domain (for federated users)
   */
  const getUserDomain = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.domain || null
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
  const initialize = async (userId: string, username: string, avatarUrl?: string, existingProfile?: any) => {
    ensureInitialized()
    await userDataService.initialize(userId, username, avatarUrl, existingProfile)
  }

  /**
   * Initialize background features after critical path.
   */
  const initializeBackgroundFeatures = async () => {
    ensureInitialized()
    await userDataService.initializeBackgroundFeatures()
  }
  
  /**
   * Subscribe to a context
   */
  const subscribeToContext = async (contextId: string, type: 'server' | 'dm' | 'profile' | 'friends', userIds: string[]) => {
    ensureInitialized()
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
   * Set custom status (Discord-style "Playing X", etc.)
   */
  const setCustomStatus = async (customStatus: { text: string; emoji?: string; expiresAt?: string } | undefined) => {
    await userDataService.setCustomStatus(customStatus)
  }

  /**
   * Clear custom status
   */
  const clearCustomStatus = async () => {
    await userDataService.clearCustomStatus()
  }

  /**
   * Get current user's custom status
   */
  const getCustomStatus = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getCustomStatus()
  })

  /**
   * Check if current user is on mobile
   */
  const isCurrentUserMobile = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.isCurrentUserMobile()
  })

  /**
   * Check if a specific user is on mobile
   */
  const isUserMobile = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.isMobile || false
  })

  /**
   * Get a specific user's custom status
   */
  const getUserCustomStatus = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.customStatus
  })
  
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
    
    const contextId = 'dm-conversations'
    await userDataService.subscribeToContext(contextId, 'dm', conversationUserIds)
    return contextId
  }
  
  /**
   * Subscribe to profile presence context  
   * Tracks a single user when viewing their profile
   */
  const subscribeToProfilePresence = async (userId: string) => {
    await ensureInitialized()
    
    const contextId = `profile-${userId}`
    await userDataService.subscribeToContext(contextId, 'profile', [userId])
    return contextId
  }
  
  /**
   * Subscribe to friends presence context
   * Tracks users on our friends list
   */
  const subscribeToFriendsPresence = async (friendUserIds: string[]) => {
    await ensureInitialized()
    
    const contextId = 'friends-list'
    await userDataService.subscribeToContext(contextId, 'friends', friendUserIds)
    
    debug.log(`Friends Presence: Tracking ${friendUserIds.length} friends`)
    return contextId
  }
  
  /**
   * Get presence-aware status for avatar (replaces getUserStatusForAvatar)
   * Uses real-time presence if available, falls back to database status
   */
  const getPresenceAwareStatus = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    
    if (!user) return 'offline'
    
    // Invisible users always appear offline to others
    if (user.status === UserStatus.Invisible) {
      return 'invisible'  // This will show as hollow circle
    }
    
    const isPresent = user.isOnline || false
    
    if (!isPresent) {
      // User is not present - always show as offline
      return 'offline'
    }
    
    // User is present - return their preferred status
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
  }
  
  /**
   * Update DM conversations presence
   * Call this when DM list changes (new conversations, removed conversations)
   */
  const updateDMPresence = async (conversationUserIds: string[]) => {
    await unsubscribeFromContext('dm-conversations')
    
    if (conversationUserIds.length > 0) {
      return await subscribeToDMPresence(conversationUserIds)
    }
    
    return null
  }
  
  /**
   * Update friends list presence
   * Call this when friends list changes
   */
  const updateFriendsPresence = async (friendUserIds: string[]) => {
    await unsubscribeFromContext('friends-list')
    
    if (friendUserIds.length > 0) {
      return await subscribeToFriendsPresence(friendUserIds)
    }
    
    debug.log(`Friends Presence: No friends to track`)
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

  return {
    // Initialization
    initialize,
    initializeBackgroundFeatures,
    refresh,
    
    // User Data (reactive)
    getUser,
    getCurrentUser,
    getUserAvatarUrl,
    getUserBannerUrl,
    getUserDisplayName,
    getUserDisplayNameParts,
    getUserStatus,
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
    isUserLocal,
    getUserDomain,
    
    // Context Data (reactive)
    getUsersInContext,
    getOnlineUsers,
    getAllUsers,
    
    // Actions
    subscribeToContext,
    unsubscribeFromContext,
    updateCurrentUserStatus,
    updateCurrentUserProfile,
    setCustomStatus,
    clearCustomStatus,
    getCustomStatus,
    getUserCustomStatus,
    isCurrentUserMobile,
    isUserMobile,
    
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
    refreshGlobalPresence: async () => {
      await ensureInitialized()
      return await userDataService.refreshGlobalPresence()
    },
    
    // Context Management
    unsubscribeFromProfilePresence,
    updateDMPresence,
    updateFriendsPresence,
    
    // Debugging
    getActiveContexts,
    getPresenceStats
  }
}