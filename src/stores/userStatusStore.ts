/**
 * Pure User Status Store
 * 
 * Clean, professional implementation of user status management.
 * Completely separated from user profile data to avoid corruption.
 * 
 * Architecture:
 * - Pure reactive Map for status data
 * - No side effects on user profiles
 * - Clean initialization from backend
 * - Real-time updates via presence service
 * - No watchers or debouncing hacks
 */

import { ref, computed, type Ref } from 'vue'
import { defineStore } from 'pinia'
import { UserStatus } from '@/types'
import { globalPresenceService } from '@/services/globalPresenceService'

export interface CleanUserStatus {
  userId: string
  status: UserStatus
  isOnline: boolean
  lastSeen: string
  customStatusText?: string
}

export const useUserStatusStore = defineStore('userStatus', () => {
  // Pure status data - completely independent from user profiles
  const statusMap: Ref<Map<string, CleanUserStatus>> = ref(new Map())
  const isInitialized = ref(false)
  const currentUserId = ref<string | null>(null)

  // Computed getters
  const getAllStatuses = computed(() => statusMap.value)
  
  const getStatus = (userId: string): CleanUserStatus => {
    return statusMap.value.get(userId) || {
      userId,
      status: UserStatus.Offline,
      isOnline: false,
      lastSeen: new Date().toISOString()
    }
  }

  const getCurrentUserStatus = computed(() => {
    if (!currentUserId.value) return null
    return getStatus(currentUserId.value)
  })

  const getOnlineUsers = computed(() => {
    return Array.from(statusMap.value.values()).filter(status => status.isOnline)
  })

  const getUsersByStatus = computed(() => {
    const groups = {
      online: [] as CleanUserStatus[],
      away: [] as CleanUserStatus[],
      busy: [] as CleanUserStatus[],
      offline: [] as CleanUserStatus[]
    }

    statusMap.value.forEach(status => {
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
  })

  // Actions
  const setStatus = (userId: string, status: Partial<CleanUserStatus>): void => {
    const current = statusMap.value.get(userId) || {
      userId,
      status: UserStatus.Offline,
      isOnline: false,
      lastSeen: new Date().toISOString()
    }

    const updated = { ...current, ...status }
    statusMap.value.set(userId, updated)
  }

  const setCurrentUser = (userId: string): void => {
    currentUserId.value = userId
  }

  const updateStatus = (userId: string, newStatus: UserStatus): void => {
    setStatus(userId, {
      status: newStatus,
      isOnline: newStatus !== UserStatus.Offline,
      lastSeen: new Date().toISOString()
    })
  }

  const setUserOnline = (userId: string): void => {
    const current = getStatus(userId)
    setStatus(userId, {
      isOnline: true,
      status: current.status === UserStatus.Offline ? UserStatus.Online : current.status,
      lastSeen: new Date().toISOString()
    })
  }

  const setUserOffline = (userId: string): void => {
    setStatus(userId, {
      status: UserStatus.Offline,
      isOnline: false,
      lastSeen: new Date().toISOString()
    })
  }

  const removeUser = (userId: string): void => {
    statusMap.value.delete(userId)
  }

  const clear = (): void => {
    statusMap.value.clear()
    currentUserId.value = null
    isInitialized.value = false
  }

  // Initialization from presence service
  const initializeFromPresenceService = async (userId: string): Promise<void> => {
    if (isInitialized.value) return

    try {
      console.log('🔄 Initializing status store from presence service...')
      
      setCurrentUser(userId)
      
      // Set up presence service event listeners once
      await setupPresenceListeners()
      
      // Get initial status from presence service
      const presence = globalPresenceService.getUserPresence(userId)
      if (presence) {
        setStatus(userId, {
          userId,
          status: presence.status,
          isOnline: presence.isOnline,
          lastSeen: presence.lastSeen || new Date().toISOString()
        })
      } else {
        // If no presence data, try to fetch from backend
        try {
          const { supabase } = await import('@/supabase')
          const { data: profile } = await supabase
            .from('profiles')
            .select('status')
            .eq('id', userId)
            .single()
          
          if (profile?.status !== undefined) {
            const status = profile.status as UserStatus
            setStatus(userId, {
              userId,
              status,
              isOnline: status !== UserStatus.Offline,
              lastSeen: new Date().toISOString()
            })
            console.log('✅ Loaded initial status from backend:', UserStatus[status])
          } else {
            // Default to online for active users
            setStatus(userId, {
              userId,
              status: UserStatus.Online,
              isOnline: true,
              lastSeen: new Date().toISOString()
            })
            console.log('✅ Set default online status for current user')
          }
        } catch (error) {
          console.error('❌ Failed to fetch initial status from backend:', error)
          // Default to online
          setStatus(userId, {
            userId,
            status: UserStatus.Online,
            isOnline: true,
            lastSeen: new Date().toISOString()
          })
        }
      }

      isInitialized.value = true
      console.log('✅ Status store initialized')
    } catch (error) {
      console.error('❌ Failed to initialize status store:', error)
      throw error
    }
  }

  // Clean event listener setup
  const setupPresenceListeners = async (): Promise<void> => {
    const { globalPresenceService } = await import('@/services/globalPresenceService')
    
    // Listen for status change events
    globalPresenceService.addEventListener('user-status-changed', (event: CustomEvent) => {
      const { userId, status } = event.detail
      console.log('📊 Status store: Status update received:', userId, UserStatus[status])
      updateStatus(userId, status)
    })

    // Listen for user online events
    globalPresenceService.addEventListener('user-online', (event: CustomEvent) => {
      const { userId } = event.detail
      console.log('📊 Status store: User came online:', userId)
      setUserOnline(userId)
    })

    // Listen for user offline events
    globalPresenceService.addEventListener('user-offline', (event: CustomEvent) => {
      const { userId } = event.detail
      console.log('📊 Status store: User went offline:', userId)
      setUserOffline(userId)
    })
  }

  // Bulk initialization for server users
  const initializeServerUsers = async (userIds: string[]): Promise<void> => {
    console.log('🔄 Initializing server users statuses:', userIds.length)
    
    // Load statuses from backend for all users
    try {
      const { supabase } = await import('@/supabase')
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, status')
        .in('id', userIds)
      
      if (profiles) {
        profiles.forEach(profile => {
          const status = profile.status as UserStatus ?? UserStatus.Offline
          
          // Check if user is online in presence service
          const presence = globalPresenceService.getUserPresence(profile.id)
          const isOnline = presence?.isOnline ?? false
          
          setStatus(profile.id, {
            userId: profile.id,
            status: isOnline ? status : UserStatus.Offline, // Show offline if not in presence
            isOnline,
            lastSeen: presence?.lastSeen ?? new Date().toISOString()
          })
        })
        
        console.log(`✅ Loaded statuses for ${profiles.length} server users`)
      }
      
      // Initialize any missing users with default offline status
      userIds.forEach(userId => {
        if (!statusMap.value.has(userId)) {
          setStatus(userId, {
            userId,
            status: UserStatus.Offline,
            isOnline: false,
            lastSeen: new Date().toISOString()
          })
        }
      })
      
    } catch (error) {
      console.error('❌ Failed to load server users statuses:', error)
      
      // Fallback: initialize with defaults and try to get from presence service
      userIds.forEach(userId => {
        if (!statusMap.value.has(userId)) {
          // Initialize with default offline status
          setStatus(userId, {
            userId,
            status: UserStatus.Offline,
            isOnline: false,
            lastSeen: new Date().toISOString()
          })

          // Try to get real status from presence service
          const presence = globalPresenceService.getUserPresence(userId)
          if (presence) {
            setStatus(userId, presence)
          }
        }
      })
    }
  }

  return {
    // State
    statusMap: computed(() => statusMap.value),
    isInitialized: computed(() => isInitialized.value),
    currentUserId: computed(() => currentUserId.value),

    // Getters
    getAllStatuses,
    getStatus,
    getCurrentUserStatus,
    getOnlineUsers,
    getUsersByStatus,

    // Actions
    setStatus,
    setCurrentUser,
    updateStatus,
    setUserOnline,
    setUserOffline,
    removeUser,
    clear,
    initializeFromPresenceService,
    initializeServerUsers
  }
})
