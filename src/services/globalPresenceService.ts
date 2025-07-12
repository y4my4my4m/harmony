/**
 * Global Presence Service - Professional Discord-style Implementation
 * 
 * This service maintains the authoritative global presence state for all users,
 * implementing industry-standard patterns used by Discord, Slack, and other
 * professional chat applications.
 * 
 * Architecture:
 * - Single source of truth for user presence
 * - Context-aware subscription management
 * - Efficient bandwidth usage through smart filtering
 * - Real-time profile synchronization
 * - Scalable connection pooling
 */

import { supabase } from '@/supabase'
import { UserStatus } from '@/types'
import type { FullUserPresence } from './contextualPresenceService'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { updateUserStatus } from '@/services/profileService'

export interface PresenceScope {
  // Server members that this user can see
  serverMembers: Set<string>
  
  // DM participants that this user can see
  dmParticipants: Set<string>
  
  // Friends that this user can see
  friends: Set<string>
  
  // Additional tracked users (profile views, etc.)
  additional: Set<string>
}

export interface GlobalPresenceState {
  userId: string
  presence: FullUserPresence
  lastHeartbeat: number
  connectionId: string
}

// Event types for presence updates
export interface PresenceEvents {
  'user-status-changed': { userId: string; status: UserStatus; timestamp: string }
  'user-profile-changed': { userId: string; profileData: Partial<FullUserPresence>; timestamp: string }
  'user-online': { userId: string; timestamp: string }
  'user-offline': { userId: string; timestamp: string }
  'presence-sync': { onlineUsers: Set<string>; timestamp: string }
  'global-status-updated': { userId: string; status: UserStatus; customText?: string }
  'global-profile-updated': { userId: string; updates: Partial<FullUserPresence> }
}

// Legacy interface for backwards compatibility
export interface UserPresence {
  userId: string
  status: UserStatus
  isOnline: boolean
  lastSeen: string
  username?: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  color?: string
}

export interface ContextSubscription {
  contextId: string
  contextType: 'server' | 'dm' | 'activitypub' | 'global'
  userIds: Set<string>
  priority: number // Higher priority contexts get updates first
}

class GlobalPresenceService {
  // Core state
  private globalPresence = new Map<string, UserPresence>()
  private currentUserStatus: UserStatus = UserStatus.Offline
  private currentUserId: string | null = null
  private lastStatusChangeTime: number = 0 // Timestamp of last status change
  
  // Real-time subscriptions
  private globalPresenceChannel: RealtimeChannel | null = null
  private statusUpdatesChannel: RealtimeChannel | null = null
  private offlineBroadcastChannel: RealtimeChannel | null = null
  
  // Context-based subscriptions
  private contextSubscriptions = new Map<string, ContextSubscription>()
  private activeUserSubscriptions = new Set<string>() // Currently subscribed user IDs
  
  // Event handling
  private eventTarget = new EventTarget()
  private isInitialized = false
  
  // Cleanup tracking
  private cleanupFunctions: Array<() => void> = []

  /**
   * Initialize the global presence service with immediate data loading
   */
  async initialize(userId: string, username: string, avatar?: string): Promise<void> {
    if (this.isInitialized && this.currentUserId === userId) {
      console.log('🟢 Global presence already initialized for user:', userId)
      return
    }

    console.log('🔄 Initializing global presence service for user:', userId)
    
    // Clean up any existing connections
    await this.cleanup()
    
    this.currentUserId = userId
    
    // Load the user's actual status from the database
    try {
      const { getProfile } = await import('./profileService')
      const userProfile = await getProfile(userId)
      this.currentUserStatus = userProfile?.status || UserStatus.Online
      console.log(`🔄 Loaded user status from database: ${UserStatus[this.currentUserStatus]}`)
    } catch (error) {
      console.error('Failed to load user status from database, defaulting to Online:', error)
      this.currentUserStatus = UserStatus.Online
    }
    
    // **CRITICAL**: Load all relevant users' data immediately from database
    await this.loadRelevantUsersData(userId)
    
    // Initialize real-time channels
    await this.initializeGlobalPresence(userId, username, avatar)
    await this.initializeStatusUpdates()
    await this.initializeOfflineBroadcast()
    
    // Update current user's presence
    this.updateUserPresence(userId, {
      status: this.currentUserStatus,
      isOnline: (this.currentUserStatus as UserStatus) !== UserStatus.Offline,
      lastSeen: new Date().toISOString(),
      username,
      displayName: username,
      avatarUrl: avatar
    })
    
    // Set up cleanup handlers
    this.setupCleanupHandlers()
    
    this.isInitialized = true
    console.log('✅ Global presence service initialized with immediate data')
  }

  /**
   * Set the current user's status globally
   */
  async setUserStatus(status: UserStatus): Promise<void> {
    if (!this.currentUserId) {
      console.error('Cannot set status: no current user')
      console.error('Debug info:', this.getDebugInfo())
      
      // Try to recover by checking if we have session data
      const { useAuthStore } = await import('@/stores/auth')
      const authStore = useAuthStore()
      const userId = authStore.session?.user?.id
      
      if (userId) {
        console.log('🔄 Found user ID from auth store, attempting recovery...')
        this.currentUserId = userId
        this.forceUpdateCurrentUserPresence()
      } else {
        console.error('❌ No user ID available for recovery')
        throw new Error('No current user available for status update')
      }
    }

    const previousStatus = this.currentUserStatus
    this.currentUserStatus = status
    this.lastStatusChangeTime = Date.now() // Track when status was changed

    try {
      // Update in database
      await updateUserStatus(this.currentUserId, status)
      
      // Update local presence
      this.updateUserPresence(this.currentUserId, {
        status,
        isOnline: status !== UserStatus.Offline,
        lastSeen: new Date().toISOString()
      })

      // Update presence in real-time channels
      if (this.globalPresenceChannel && status !== UserStatus.Offline) {
        const currentPresence = this.globalPresence.get(this.currentUserId)
        await this.globalPresenceChannel.track({
          user_id: this.currentUserId,
          username: currentPresence?.username,
          display_name: currentPresence?.displayName,
          avatar_url: currentPresence?.avatarUrl,
          status: status,
          online_at: new Date().toISOString()
        })
      } else if (this.globalPresenceChannel && status === UserStatus.Offline) {
        await this.globalPresenceChannel.untrack()
      }

      // Emit status change event
      this.emitEvent('user-status-changed', {
        userId: this.currentUserId,
        status,
        timestamp: new Date().toISOString()
      })

      console.log(`🔄 User status updated: ${UserStatus[previousStatus]} → ${UserStatus[status]}`)
      
    } catch (error) {
      // Rollback on error
      this.currentUserStatus = previousStatus
      console.error('Failed to update user status:', error)
      throw error
    }
  }

  /**
   * Subscribe to presence updates for users in a specific context
   * Enhanced with immediate data availability
   */
  subscribeToContext(
    contextId: string, 
    contextType: ContextSubscription['contextType'], 
    userIds: string[],
    priority: number = 1
  ): void {
    console.log(`📡 Subscribing to context: ${contextId} (${contextType}) with ${userIds.length} users`)
    
    const subscription: ContextSubscription = {
      contextId,
      contextType,
      userIds: new Set(userIds),
      priority
    }
    
    this.contextSubscriptions.set(contextId, subscription)
    
    // Add these users to active subscriptions
    userIds.forEach(userId => this.activeUserSubscriptions.add(userId))
    
    // Ensure we have baseline data for these users
    this.ensureUserData(userIds)
    
    console.log(`✅ Context subscription active: ${contextId}`)
  }

  /**
   * Unsubscribe from a context
   */
  unsubscribeFromContext(contextId: string): void {
    const subscription = this.contextSubscriptions.get(contextId)
    if (!subscription) return

    console.log(`📡 Unsubscribing from context: ${contextId}`)
    
    // Remove users from active subscriptions if they're not in other contexts
    subscription.userIds.forEach(userId => {
      const stillNeeded = Array.from(this.contextSubscriptions.values())
        .some(sub => sub.contextId !== contextId && sub.userIds.has(userId))
      
      if (!stillNeeded) {
        this.activeUserSubscriptions.delete(userId)
      }
    })
    
    this.contextSubscriptions.delete(contextId)
  }

  /**
   * Get user presence data
   */
  getUserPresence(userId: string): UserPresence | null {
    return this.globalPresence.get(userId) || null
  }

  /**
   * Check if user is online
   */
  isUserOnline(userId: string): boolean {
    const presence = this.globalPresence.get(userId)
    return presence?.isOnline || false
  }

  /**
   * Get current user status
   */
  getCurrentUserStatus(): UserStatus {
    return this.currentUserStatus
  }

  /**
   * Get current user ID
   */
  getCurrentUserId(): string | null {
    return this.currentUserId
  }

  /**
   * Get all users currently considered online
   */
  getOnlineUsers(): string[] {
    return Array.from(this.globalPresence.values())
      .filter(presence => presence.isOnline)
      .map(presence => presence.userId)
  }

  /**
   * Add event listener for presence events
   */
  addEventListener<K extends keyof PresenceEvents>(
    type: K,
    listener: (event: CustomEvent<PresenceEvents[K]>) => void
  ): void {
    this.eventTarget.addEventListener(type, listener as EventListener)
  }

  /**
   * Remove event listener
   */
  removeEventListener<K extends keyof PresenceEvents>(
    type: K,
    listener: (event: CustomEvent<PresenceEvents[K]>) => void
  ): void {
    this.eventTarget.removeEventListener(type, listener as EventListener)
  }

  /**
   * Clean up all presence connections and subscriptions
   */
  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up global presence service')
    
    // Run all cleanup functions
    this.cleanupFunctions.forEach(cleanup => {
      try {
        cleanup()
      } catch (error) {
        console.error('Error in cleanup function:', error)
      }
    })
    this.cleanupFunctions = []
    
    // Unsubscribe from all channels
    if (this.globalPresenceChannel) {
      await this.globalPresenceChannel.unsubscribe()
      this.globalPresenceChannel = null
    }
    
    if (this.statusUpdatesChannel) {
      await this.statusUpdatesChannel.unsubscribe()
      this.statusUpdatesChannel = null
    }
    
    if (this.offlineBroadcastChannel) {
      await this.offlineBroadcastChannel.unsubscribe()
      this.offlineBroadcastChannel = null
    }
    
    // Clear state
    this.contextSubscriptions.clear()
    this.activeUserSubscriptions.clear()
    this.globalPresence.clear()
    this.currentUserId = null
    this.isInitialized = false
    
    console.log('✅ Global presence service cleaned up')
  }

  // Private methods

  private async initializeGlobalPresence(userId: string, username: string, avatar?: string): Promise<void> {
    console.log('🔄 Initializing global presence channel for user:', userId)
    
    // Create the global presence channel for new users
    this.globalPresenceChannel = supabase
      .channel('global-presence')
      .on('presence', { event: 'sync' }, () => {
        const presenceState = this.globalPresenceChannel?.presenceState()
        console.log('🔄 Global presence sync event, current state:', presenceState)
        if (presenceState) {
          this.handlePresenceSync(presenceState)
        }
      })
      .on('presence', { event: 'join' }, ({ key, newPresences }) => {
        console.log('👋 User joined global presence:', key, newPresences)
        this.handleUserJoin(key, newPresences)
      })
      .on('presence', { event: 'leave' }, ({ key }) => {
        console.log('👋 User left global presence:', key)
        this.handleUserLeave(key)
      })

    console.log('🔄 Subscribing to global presence channel...')
    await this.globalPresenceChannel.subscribe(async (status: string) => {
      console.log('📡 Global presence subscription status:', status)
      if (status === 'SUBSCRIBED') {
        // Track current user's presence in BOTH global and server-specific channels
        const presenceData = {
          user_id: userId,
          username: username,
          display_name: username,
          avatar_url: avatar,
          status: this.currentUserStatus,
          online_at: new Date().toISOString()
        }
        console.log('🔄 Tracking current user presence:', presenceData)
        await this.globalPresenceChannel?.track(presenceData)
        console.log('✅ Global presence tracking started')
      }
    })
  }

  private async initializeStatusUpdates(): Promise<void> {
    this.statusUpdatesChannel = supabase
      .channel('global-user-statuses')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles' },
        (payload) => {
          this.handleStatusUpdate(payload)
        }
      )

    await this.statusUpdatesChannel.subscribe((status: string) => {
      console.log('📡 Status updates subscription:', status)
    })
  }

  private async initializeOfflineBroadcast(): Promise<void> {
    this.offlineBroadcastChannel = supabase
      .channel('global-offline-broadcasts')
      .on('broadcast', { event: 'user-offline' }, (payload) => {
        this.handleOfflineBroadcast(payload)
      })

    await this.offlineBroadcastChannel.subscribe()
  }

  private setupCleanupHandlers(): void {
    // Store cleanup function globally for immediate access during beforeunload
    const immediateCleanup = () => {
      console.log('⚡ Immediate presence cleanup triggered')
      if (this.currentUserId && this.globalPresenceChannel) {
        // Immediate untrack and broadcast offline
        this.globalPresenceChannel.untrack()
        this.broadcastOfflineStatus(this.currentUserId)
      }
    }

    // Store in window for access during beforeunload
    ;(window as any).__harmonyPresenceCleanup = immediateCleanup
    
    // Also store in our cleanup functions
    this.cleanupFunctions.push(() => {
      ;(window as any).__harmonyPresenceCleanup = null
    })

    // Handle browser events
    const handleBeforeUnload = () => immediateCleanup()
    const handleVisibilityChange = () => {
      if (document.hidden && this.currentUserStatus !== UserStatus.Offline) {
        this.setUserStatus(UserStatus.Away)
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    
    this.cleanupFunctions.push(() => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    })
  }

  private handlePresenceSync(presenceState: Record<string, any>): void {
    console.log('🔄 Handling presence sync, raw state:', presenceState)
    const onlineUserIds = new Set<string>()
    
    Object.entries(presenceState).forEach(([userId, presences]) => {
      console.log('🔄 Processing presence for user:', userId, presences)
      if (Array.isArray(presences) && presences.length > 0) {
        const latestPresence = presences[0]
        onlineUserIds.add(userId)
        
        // Update presence with real-time data, but preserve database info if missing
        const existingPresence = this.globalPresence.get(userId)
        this.updateUserPresence(userId, {
          status: latestPresence.status || UserStatus.Online,
          isOnline: true,
          lastSeen: latestPresence.online_at || new Date().toISOString(),
          username: latestPresence.username || existingPresence?.username || 'Unknown',
          displayName: latestPresence.display_name || existingPresence?.displayName || 'Unknown',
          avatarUrl: latestPresence.avatar_url || existingPresence?.avatarUrl,
          bio: latestPresence.bio || existingPresence?.bio,
          color: latestPresence.color || existingPresence?.color
        })
        console.log('✅ Updated presence for user:', userId, 'status:', UserStatus[latestPresence.status || UserStatus.Online])
      }
    })

    console.log('🔄 Online users after sync:', Array.from(onlineUserIds))

    // Mark users not in presence as offline, but preserve their profile data
    this.globalPresence.forEach((presence, userId) => {
      if (!onlineUserIds.has(userId) && presence.isOnline) {
        // Don't mark current user as offline if they just set an online status (within last 5 seconds)
        if (userId === this.currentUserId && this.currentUserStatus !== UserStatus.Offline) {
          const timeSinceStatusChange = Date.now() - this.lastStatusChangeTime
          if (timeSinceStatusChange < 5000) { // 5 seconds grace period
            console.log('🟡 Skipping offline marking for current user who recently set online status:', userId, 'time since change:', timeSinceStatusChange)
            return
          }
        }
        
        // Update only connection status, preserve user's chosen status from database
        this.updateUserPresence(userId, {
          isOnline: false,
          lastSeen: new Date().toISOString()
          // Don't override status - user might be away/busy by choice, not just disconnected
        })
        console.log('🔴 Marked user as not connected:', userId)
      }
    })

    this.emitEvent('presence-sync', {
      onlineUsers: onlineUserIds,
      timestamp: new Date().toISOString()
    })
  }

  private handleUserJoin(userId: string, presences: any[]): void {
    if (presences.length > 0) {
      const presence = presences[0]
      this.updateUserPresence(userId, {
        status: presence.status || UserStatus.Online,
        isOnline: true,
        lastSeen: presence.online_at || new Date().toISOString(),
        username: presence.username,
        displayName: presence.display_name,
        avatarUrl: presence.avatar_url
      })

      this.emitEvent('user-online', {
        userId,
        timestamp: new Date().toISOString()
      })
    }
  }

  private handleUserLeave(userId: string): void {
    this.updateUserPresence(userId, {
      isOnline: false,
      status: UserStatus.Offline,
      lastSeen: new Date().toISOString()
    })

    this.emitEvent('user-offline', {
      userId,
      timestamp: new Date().toISOString()
    })
  }

  private handleStatusUpdate(payload: any): void {
    const userId = payload.new.id
    const newStatus = payload.new.status as number
    
    if (userId && typeof newStatus === 'number') {
      this.updateUserPresence(userId, {
        status: newStatus as UserStatus,
        lastSeen: new Date().toISOString()
      })

      this.emitEvent('user-status-changed', {
        userId,
        status: newStatus as UserStatus,
        timestamp: new Date().toISOString()
      })
    }
  }

  private handleOfflineBroadcast(payload: any): void {
    const { user_id, timestamp } = payload.payload
    if (user_id) {
      this.updateUserPresence(user_id, {
        isOnline: false,
        status: UserStatus.Offline,
        lastSeen: timestamp || new Date().toISOString()
      })

      this.emitEvent('user-offline', {
        userId: user_id,
        timestamp: timestamp || new Date().toISOString()
      })
    }
  }

  private updateUserPresence(userId: string, updates: Partial<Omit<UserPresence, 'userId'>>): void {
    const existing = this.globalPresence.get(userId) || {
      userId,
      status: UserStatus.Offline,
      isOnline: false,
      lastSeen: new Date().toISOString()
    }

    const updated: UserPresence = { ...existing, ...updates }
    this.globalPresence.set(userId, updated)
  }

  private async requestPresenceData(userIds: string[]): Promise<void> {
    // For newly subscribed users, ensure we have their presence data
    userIds.forEach(userId => {
      if (!this.globalPresence.has(userId)) {
        // Initialize with offline status, will be updated by presence sync
        this.updateUserPresence(userId, {
          status: UserStatus.Offline,
          isOnline: false,
          lastSeen: new Date().toISOString()
        })
      }
    })
  }

  private broadcastOfflineStatus(userId: string): void {
    if (!this.offlineBroadcastChannel) return

    this.offlineBroadcastChannel.send({
      type: 'broadcast',
      event: 'user-offline',
      payload: {
        user_id: userId,
        timestamp: new Date().toISOString()
      }
    })
  }

  private emitEvent<K extends keyof PresenceEvents>(type: K, detail: PresenceEvents[K]): void {
    const event = new CustomEvent(type, { detail })
    this.eventTarget.dispatchEvent(event)
  }

  /**
   * Debug method to check initialization status
   */
  getDebugInfo(): {
    isInitialized: boolean;
    currentUserId: string | null;
    currentUserStatus: UserStatus;
    presenceMapSize: number;
    hasCurrentUserPresence: boolean;
  } {
    return {
      isInitialized: this.isInitialized,
      currentUserId: this.currentUserId,
      currentUserStatus: this.currentUserStatus,
      presenceMapSize: this.globalPresence.size,
      hasCurrentUserPresence: this.currentUserId ? this.globalPresence.has(this.currentUserId) : false
    }
  }

  /**
   * Debug method to force update current user presence
   */
  forceUpdateCurrentUserPresence(): void {
    if (!this.currentUserId) {
      console.warn('Cannot force update: no current user')
      return
    }

    console.log('🔄 Force updating current user presence...')
    this.updateUserPresence(this.currentUserId, {
      status: this.currentUserStatus,
      isOnline: this.currentUserStatus !== UserStatus.Offline,
      lastSeen: new Date().toISOString()
    })
    
    console.log('✅ Current user presence force updated')
  }

  /**
   * Update user profile data and broadcast to all relevant presence channels
   */
  async updateUserProfile(userId: string, profileData: Partial<FullUserPresence>): Promise<void> {
    console.log(`🔄 Broadcasting profile update for user: ${userId}`, profileData)

    // Update local presence with new profile data
    const currentPresence = this.globalPresence.get(userId)
    if (currentPresence) {
      this.updateUserPresence(userId, {
        username: profileData.username || currentPresence.username,
        displayName: profileData.displayName || currentPresence.displayName,
        avatarUrl: profileData.avatarUrl || currentPresence.avatarUrl,
        bio: profileData.bio || currentPresence.bio,
        color: profileData.userColor || currentPresence.color
      })
    }

    // Update presence in real-time channels if user is online
    if (this.globalPresenceChannel && this.isUserOnline(userId)) {
      const updatedPresence = this.globalPresence.get(userId)
      await this.globalPresenceChannel.track({
        user_id: userId,
        username: updatedPresence?.username,
        display_name: updatedPresence?.displayName,
        avatar_url: updatedPresence?.avatarUrl,
        bio: updatedPresence?.bio,
        color: profileData.userColor || updatedPresence?.color,
        status: updatedPresence?.status || UserStatus.Online,
        online_at: new Date().toISOString()
      })
    }

    // Emit profile change event
    this.emitEvent('user-profile-changed', {
      userId,
      profileData: profileData,
      timestamp: new Date().toISOString()
    })

    console.log(`✅ Profile update broadcasted for user: ${userId}`)
  }

  /**
   * Update current user's profile and broadcast changes
   */
  async updateCurrentUserProfile(profileData: Partial<UserPresence>): Promise<void> {
    if (!this.currentUserId) {
      console.error('Cannot update profile: no current user')
      return
    }

    await this.updateUserProfile(this.currentUserId, profileData)
  }

  /**
   * Load relevant users' data immediately from database (Discord-style)
   * This ensures users always see data immediately, no "Loading..." states
   */
  private async loadRelevantUsersData(currentUserId: string): Promise<void> {
    console.log('🔄 Loading relevant users data from database...')
    
    try {
      // Get all users this person should track
      const relevantUserIds = await this.calculateRelevantUsers(currentUserId)
      console.log(`📊 Found ${relevantUserIds.length} relevant users to track`)
      
      if (relevantUserIds.length === 0) {
        console.log('✅ No relevant users to load')
        return
      }
      
      // Batch load profiles from database
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, bio, color, status, updated_at')
        .in('id', relevantUserIds)
      
      if (error) {
        console.error('Failed to load user profiles:', error)
        return
      }
      
      // Initialize presence data with database values
      profiles?.forEach(profile => {
        this.updateUserPresence(profile.id, {
          status: profile.status || UserStatus.Offline,
          isOnline: false, // Will be updated by real-time presence
          lastSeen: profile.updated_at || new Date().toISOString(),
          username: profile.username || 'Unknown',
          displayName: profile.display_name || profile.username || 'Unknown',
          avatarUrl: profile.avatar_url,
          bio: profile.bio,
          color: profile.color
          // verified: profile.verified || false // TODO: Add when verified column exists
        })
      })
      
      console.log(`✅ Loaded ${profiles?.length || 0} user profiles from database`)
      
    } catch (error) {
      console.error('Error loading relevant users data:', error)
    }
  }

  /**
   * Calculate all users this person should track (Discord-style relationship-based)
   */
  private async calculateRelevantUsers(currentUserId: string): Promise<string[]> {
    const relevantUsers = new Set<string>()
    
    try {
      // 1. Get users from servers this person is in
      const { data: serverMembers } = await supabase
        .rpc('get_server_members_for_user', { user_id: currentUserId })
      
      if (serverMembers) {
        serverMembers.forEach((userId: string) => {
          if (userId !== currentUserId) {
            relevantUsers.add(userId)
          }
        })
      }
      
      // 2. Get users from DM conversations  
      const { data: dmParticipants } = await supabase
        .rpc('get_dm_participants_for_user', { user_id: currentUserId })
      
      if (dmParticipants) {
        dmParticipants.forEach((userId: string) => {
          if (userId !== currentUserId) {
            relevantUsers.add(userId)
          }
        })
      }
      
      // 3. Add friends (if we have a friends system)
      // TODO: Add friends query when friends system is implemented
      
      return Array.from(relevantUsers)
      
    } catch (error) {
      console.error('Error calculating relevant users:', error)
      return []
    }
  }

  /**
   * Ensure we have data for specific users (load from DB if not in cache)
   */
  private async ensureUserData(userIds: string[]): Promise<void> {
    const missingUsers = userIds.filter(userId => !this.globalPresence.has(userId))
    
    if (missingUsers.length === 0) {
      return // All users already have data
    }
    
    console.log(`🔄 Loading missing user data for ${missingUsers.length} users`)
    
    try {
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, bio, color, status, updated_at')
        .in('id', missingUsers)
      
      if (error) {
        console.error('Failed to load missing user profiles:', error)
        return
      }
      
      profiles?.forEach(profile => {
        this.updateUserPresence(profile.id, {
          status: profile.status || UserStatus.Offline,
          isOnline: false, // Will be updated by real-time presence if they're online
          lastSeen: profile.updated_at || new Date().toISOString(),
          username: profile.username || 'Unknown',
          displayName: profile.display_name || profile.username || 'Unknown',
          avatarUrl: profile.avatar_url,
          bio: profile.bio,
          color: profile.color
          // verified: profile.verified || false // TODO: Add when verified column exists
        })
      })
      
      console.log(`✅ Loaded ${profiles?.length || 0} missing user profiles`)
      
    } catch (error) {
      console.error('Error loading missing user data:', error)
    }
  }
}

// Export singleton instance
export const globalPresenceService = new GlobalPresenceService()
