/**
 * Reactive wrapper around userDataService.
 * Reactivity is driven by a forceUpdate counter bumped from service events;
 * the service itself holds plain, non-reactive state.
 */

import { computed, ref } from 'vue'
import { userDataService } from '@/services/userDataService'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useVisualTheme } from '@/composables/useVisualTheme'
import { UserStatus, type DisplayNamePart } from '@/types'
import { getAvatarUrl } from '@/utils/avatarUtils'
import { debug } from '@/utils/debug'

// Module scope, not per call. userDataService is a singleton and every caller
// wants the same signal, so one counter and one set of listeners serve all of
// them. Registering per call leaked seven listeners per invocation, each
// closing over that call's setup scope; across 43 call sites - several of them
// per message or per mention - a channel switch cost hundreds of permanent
// listeners, and every 'user-updated' emit then fanned out across all of them.
const forceUpdate = ref(0)

const triggerUpdate = () => {
  forceUpdate.value++
}

const SERVICE_EVENTS = [
  'user-updated',
  'status-changed',
  'custom-status-changed',
  'presence-sync',
  'data-refreshed',
  'context-updated',
  'global-presence-updated',
] as const

// Bound once for the module's lifetime. The service outlives every consumer,
// so there is nothing to unbind.
const isInitialized = ref(false)

const bindServiceListeners = () => {
  if (isInitialized.value) return
  for (const type of SERVICE_EVENTS) {
    userDataService.addEventListener(type, triggerUpdate)
  }
  isInitialized.value = true
}

export function useUserData() {
  bindServiceListeners()

  // User Data Getters (all reactive)
  
  const getUser = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getUser(userId)
  })
  
  const getCurrentUser = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getCurrentUser()
  })
  
  const getUserAvatarUrl = (userId: string | null | undefined) => computed(() => {
    forceUpdate.value // Force reactivity
    if (!userId) return '/default_avatar.webp'
    const user = userDataService.getUser(userId)
    return user?.avatarUrl || '/default_avatar.webp'
  })

  const getUserAvatarUrlCurrent = computed(() => {
    forceUpdate.value // Force reactivity
    const currentUser = userDataService.getCurrentUser()
    if (!currentUser) {
      return '/default_avatar.webp'
    }
    // getAvatarUrl handles null/undefined and CDN optimization.
    return getAvatarUrl(currentUser.avatarUrl)
  })
  
  const stripEmojiShortcodes = (text: string): string => {
    if (!text) return text
    const stripped = text.replace(/:[a-zA-Z0-9_+-]+:/g, '').replace(/\s+/g, ' ').trim()
    return stripped || text
  }

  /**
   * Get user display name (plain text, shortcodes stripped when emojis disabled).
   *
   * Fallback chain: trimmed `displayName` → trimmed `username` → `'Unknown User'`.
   * Every level rejects whitespace-only strings. Rows predating the
   * `PROFILES_DISPLAY_NAME_NOT_BLANK` CHECK constraint and the
   * `UserAccountSettings.vue` guard can still hold blank display names.
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
    // A name consisting only of shortcodes strips to empty; fall back again
    // rather than render a blank pill.
    if (!name || !name.trim()) {
      return trimmedUsername || 'Unknown User'
    }
    return name
  })

  /**
   * Display name split into text and inline custom-emoji parts.
   * Undefined when the name has no custom emojis, or when the instance or
   * theme disables custom emojis in display names.
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
  
  /** Presence overrides the stored status: an absent user always reads Offline. */
  const getUserStatusText = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    if (!user) return 'Offline'
    
    if (!user.isOnline) {
      return 'Offline'
    }
    
    // Custom status is encoded in bio after a `status:` marker.
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
  
  const getUserColor = (userId: string | null | undefined) => computed(() => {
    forceUpdate.value // Force reactivity
    if (!userId) return '#ffffff'
    const user = userDataService.getUser(userId)
    return user?.color || '#ffffff'
  })
  
  const isUserOnline = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.isOnline || false
  })
  
  const getCurrentUserStatus = computed(() => {
    forceUpdate.value // Force reactivity
    const currentUser = userDataService.getCurrentUser()
    return currentUser?.status ?? UserStatus.Offline
  })
  
  const getUserStatus = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.status ?? UserStatus.Offline
  })
  
  const getUserCreatedAt = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.createdAt || null
  })

  const getUserProfile = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getUserProfile(userId)
  })

  const getUserBio = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.bio || null
  })

  const getUserRoles = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.roles || []
  })

  const getUserMessageCount = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.messageCount || 0
  })

  const getUserVoiceTime = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.voiceTime || 0
  })

  const getUserBannerUrl = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.bannerUrl || null
  })

  const isUserLocal = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    // Absent data defaults to local.
    return user?.isLocal ?? true
  })

  const getUserDomain = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.domain || null
  })

  const fetchUserProfile = async (userId: string, forceRefresh: boolean = false) => {
    bindServiceListeners()
    return await userDataService.fetchUserProfile(userId, forceRefresh)
  }

  const fetchMultipleUserProfiles = async (userIds: string[], forceRefresh: boolean = false) => {
    bindServiceListeners()
    return await userDataService.fetchMultipleUserProfiles(userIds, forceRefresh)
  }

  /** Loads any missing profiles into the cache. Call before rendering user data. */
  const ensureProfilesAvailable = async (userIds: string[]) => {
    bindServiceListeners()
    await userDataService.ensureUsersLoaded(userIds)
  }
  
  // Actions
  
  const initialize = async (userId: string, username: string, avatarUrl?: string, existingProfile?: any) => {
    bindServiceListeners()
    await userDataService.initialize(userId, username, avatarUrl, existingProfile)
  }

  /** Runs after the critical path; not required for first render. */
  const initializeBackgroundFeatures = async () => {
    bindServiceListeners()
    await userDataService.initializeBackgroundFeatures()
  }
  
  const subscribeToContext = async (contextId: string, type: 'server' | 'dm' | 'profile' | 'friends', userIds: string[]) => {
    bindServiceListeners()
    await userDataService.subscribeToContext(contextId, type, userIds)
  }
  
  const unsubscribeFromContext = async (contextId: string) => {
    await userDataService.unsubscribeFromContext(contextId)
  }
  
  const updateCurrentUserStatus = async (status: UserStatus) => {
    await userDataService.updateCurrentUserStatus(status)
  }

  /** Custom status text with optional emoji and expiry. */
  const setCustomStatus = async (customStatus: { text: string; emoji?: string; expiresAt?: string } | undefined) => {
    await userDataService.setCustomStatus(customStatus)
  }

  const clearCustomStatus = async () => {
    await userDataService.clearCustomStatus()
  }

  const getCustomStatus = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getCustomStatus()
  })

  const isCurrentUserMobile = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.isCurrentUserMobile()
  })

  const isUserMobile = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.isMobile || false
  })

  const getUserCustomStatus = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    return user?.customStatus
  })
  
  /** Persists the profile and broadcasts the change to connected clients. */
  const updateCurrentUserProfile = async (profileData: {
    displayName?: string
    avatarUrl?: string
    bannerUrl?: string
    color?: string
    bio?: string
  }) => {
    await userDataService.updateCurrentUserProfile(profileData)
  }
  
  const refresh = async () => {
    await userDataService.refresh()
  }
  
  const getStats = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getStats()
  })
  
  const getUsersInContext = (contextId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getUsersInContext(contextId)
  })
  
  const getOnlineUsers = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getOnlineUsers()
  })
  
  const getAllUsers = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getAllUsers()
  })

  // Presence is tracked per context; only users visible in the current view
  // are subscribed.
  
  /** Presence context 'dm-conversations': participants of active conversations. */
  const subscribeToDMPresence = async (conversationUserIds: string[]) => {
    bindServiceListeners()
    
    const contextId = 'dm-conversations'
    await userDataService.subscribeToContext(contextId, 'dm', conversationUserIds)
    return contextId
  }
  
  /** Presence context `profile-<userId>`: a single user, for the profile view. */
  const subscribeToProfilePresence = async (userId: string) => {
    bindServiceListeners()
    
    const contextId = `profile-${userId}`
    await userDataService.subscribeToContext(contextId, 'profile', [userId])
    return contextId
  }
  
  /** Presence context 'friends-list'. */
  const subscribeToFriendsPresence = async (friendUserIds: string[]) => {
    bindServiceListeners()
    
    const contextId = 'friends-list'
    await userDataService.subscribeToContext(contextId, 'friends', friendUserIds)
    
    debug.log(`Friends Presence: Tracking ${friendUserIds.length} friends`)
    return contextId
  }
  
  /**
   * Avatar status indicator. Supersedes getUserStatusForAvatar.
   * Realtime presence gates the stored status; absent users read 'offline'.
   */
  const getPresenceAwareStatus = (userId: string) => computed(() => {
    forceUpdate.value // Force reactivity
    const user = userDataService.getUser(userId)
    
    if (!user) return 'offline'
    
    // Invisible users always appear offline to others
    if (user.status === UserStatus.Invisible) {
      return 'invisible'  // Rendered as a hollow circle
    }
    
    const isPresent = user.isOnline || false
    
    if (!isPresent) {
      return 'offline'
    }
    
    switch (user.status) {
      case UserStatus.Online:
        return 'online'
      case UserStatus.Away:
        return 'away'
      case UserStatus.Busy:
        return 'busy'
      default:
        // Present with unknown status.
        return 'online'
    }
  })

  const unsubscribeFromProfilePresence = async (userId: string) => {
    const contextId = `profile-${userId}`
    await unsubscribeFromContext(contextId)
  }
  
  /** Resubscribes 'dm-conversations'. Call when the DM list changes. */
  const updateDMPresence = async (conversationUserIds: string[]) => {
    await unsubscribeFromContext('dm-conversations')
    
    if (conversationUserIds.length > 0) {
      return await subscribeToDMPresence(conversationUserIds)
    }
    
    return null
  }
  
  /** Resubscribes 'friends-list'. Call when the friends list changes. */
  const updateFriendsPresence = async (friendUserIds: string[]) => {
    await unsubscribeFromContext('friends-list')
    
    if (friendUserIds.length > 0) {
      return await subscribeToFriendsPresence(friendUserIds)
    }
    
    debug.log(`Friends Presence: No friends to track`)
    return null
  }
  
  const getActiveContexts = computed(() => {
    forceUpdate.value // Force reactivity
    return userDataService.getStats().contexts || 0
  })
  
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
      bindServiceListeners()
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