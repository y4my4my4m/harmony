/**
 * Contextual Presence Service - Professional Discord-style Implementation
 * 
 * Efficient, scalable presence management that only tracks users you can see.
 * Includes full profile data (not just status) for real-time UI updates.
 * 
 * Architecture:
 * - Context-based channels (server, DM, user-specific)
 * - Full profile data in presence updates
 * - Smart subscription management
 * - Efficient batch updates and cleanup
 */

import { supabase } from '@/supabase'
import { UserStatus } from '@/types'
import type { RealtimeChannel } from '@supabase/supabase-js'

export interface FullUserPresence {
  userId: string
  status: UserStatus
  isOnline: boolean
  lastSeen: string
  
  // Core profile data for real-time UI updates
  username: string
  displayName: string
  avatarUrl?: string
  bannerUrl?: string
  userColor?: string
  bio?: string
  customStatusText?: string
  
  // Verification and badges
  verified?: boolean
  roles?: Array<{ id: string; name: string; color: string }>
  
  // Federation data
  domain?: string
  handle?: string
  isLocal?: boolean
  federatedId?: string
  apId?: string
  
  // Social stats (for ActivityPub users)
  followersCount?: number
  followingCount?: number
  postsCount?: number
  
  // Timestamps
  createdAt?: string
  updatedAt?: string
  
  // Activity data
  currentActivity?: string
  isTyping?: boolean
  voiceChannelId?: string
  
  // Chat stats (for local users)
  messageCount?: number
  voiceTime?: number
}

export interface PresenceContext {
  type: 'server' | 'dm' | 'user'
  id: string
  channel: RealtimeChannel | null
  subscribedUsers: Set<string>
  lastHeartbeat: number
}

class ContextualPresenceService {
  // Context management
  private activeContexts = new Map<string, PresenceContext>()
  private currentUserId: string | null = null
  private currentUserPresence: FullUserPresence | null = null
  
  // Local presence cache
  private presenceCache = new Map<string, FullUserPresence>()
  private cacheExpiryTimes = new Map<string, number>()
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes
  
  // Event handling
  private eventTarget = new EventTarget()
  
  // Cleanup tracking
  private heartbeatInterval: NodeJS.Timeout | null = null
  private cleanupInterval: NodeJS.Timeout | null = null

  /**
   * Initialize presence service for current user
   */
  async initialize(userId: string, userProfile: any): Promise<void> {
    console.log('🔄 Initializing contextual presence service for user:', userId)
    
    this.currentUserId = userId
    this.currentUserPresence = {
      userId,
      status: userProfile.status || UserStatus.Online,
      isOnline: true,
      lastSeen: new Date().toISOString(),
      
      // Core profile data
      username: userProfile.username || 'Unknown',
      displayName: userProfile.display_name || userProfile.username || 'Unknown User',
      avatarUrl: userProfile.avatar_url,
      bannerUrl: userProfile.banner_url,
      userColor: userProfile.color,
      bio: userProfile.bio,
      customStatusText: userProfile.custom_status_text,
      
      // Verification and badges
      verified: userProfile.verified || false,
      roles: userProfile.roles || [],
      
      // Federation data
      domain: userProfile.domain,
      handle: userProfile.handle,
      isLocal: userProfile.is_local ?? true,
      federatedId: userProfile.federated_id,
      apId: userProfile.ap_id,
      
      // Social stats
      followersCount: userProfile.followers_count,
      followingCount: userProfile.following_count,
      postsCount: userProfile.posts_count,
      
      // Timestamps
      createdAt: userProfile.created_at,
      updatedAt: userProfile.updated_at,
      
      // Chat stats
      messageCount: userProfile.message_count,
      voiceTime: userProfile.voice_time
    }
    
    // Start heartbeat for current user
    this.startHeartbeat()
    
    // Start cleanup routine
    this.startCleanupRoutine()
    
    console.log('✅ Contextual presence service initialized')
  }

  /**
   * Subscribe to presence for a server context
   */
  async subscribeToServerPresence(serverId: string, memberIds: string[]): Promise<void> {
    const contextKey = `server_${serverId}`
    
    if (this.activeContexts.has(contextKey)) {
      console.log('🔄 Already subscribed to server presence:', serverId)
      return
    }

    console.log('🔄 Subscribing to server presence:', serverId, 'members:', memberIds.length)

    const channel = supabase.channel(`server_presence_${serverId}`)
      .on('presence', { event: 'sync' }, () => {
        this.handlePresenceSync(contextKey, channel)
      })
      .on('presence', { event: 'join' }, (payload) => {
        this.handleUserJoin(contextKey, payload)
      })
      .on('presence', { event: 'leave' }, (payload) => {
        this.handleUserLeave(contextKey, payload)
      })
      .on('broadcast', { event: 'profile_update' }, (payload) => {
        this.handleProfileUpdate(payload.payload)
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          // Track current user presence in this context
          if (this.currentUserPresence) {
            await channel.track(this.currentUserPresence)
          }
          console.log('✅ Subscribed to server presence:', serverId)
        }
      })

    this.activeContexts.set(contextKey, {
      type: 'server',
      id: serverId,
      channel,
      subscribedUsers: new Set(memberIds),
      lastHeartbeat: Date.now()
    })

    // Load initial presence data for server members
    await this.loadInitialPresenceData(memberIds)
  }

  /**
   * Subscribe to presence for a DM context
   */
  async subscribeToDMPresence(conversationId: string, participantIds: string[]): Promise<void> {
    const contextKey = `dm_${conversationId}`
    
    if (this.activeContexts.has(contextKey)) {
      return
    }

    console.log('🔄 Subscribing to DM presence:', conversationId)

    const channel = supabase.channel(`dm_presence_${conversationId}`)
      .on('presence', { event: 'sync' }, () => {
        this.handlePresenceSync(contextKey, channel)
      })
      .on('presence', { event: 'join' }, (payload) => {
        this.handleUserJoin(contextKey, payload)
      })
      .on('presence', { event: 'leave' }, (payload) => {
        this.handleUserLeave(contextKey, payload)
      })
      .on('broadcast', { event: 'typing' }, (payload) => {
        this.handleTypingUpdate(payload.payload)
      })
      .on('broadcast', { event: 'profile_update' }, (payload) => {
        this.handleProfileUpdate(payload.payload)
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          if (this.currentUserPresence) {
            await channel.track(this.currentUserPresence)
          }
        }
      })

    this.activeContexts.set(contextKey, {
      type: 'dm',
      id: conversationId,
      channel,
      subscribedUsers: new Set(participantIds),
      lastHeartbeat: Date.now()
    })

    await this.loadInitialPresenceData(participantIds)
  }

  /**
   * Subscribe to a specific user's presence (for profile views, etc.)
   */
  async subscribeToUserPresence(userId: string): Promise<void> {
    const contextKey = `user_${userId}`
    
    if (this.activeContexts.has(contextKey)) {
      return
    }

    console.log('🔄 Subscribing to user presence:', userId)

    const channel = supabase.channel(`user_presence_${userId}`)
      .on('presence', { event: 'sync' }, () => {
        this.handlePresenceSync(contextKey, channel)
      })
      .on('presence', { event: 'join' }, (payload) => {
        this.handleUserJoin(contextKey, payload)
      })
      .on('presence', { event: 'leave' }, (payload) => {
        this.handleUserLeave(contextKey, payload)
      })
      .on('broadcast', { event: 'profile_update' }, (payload) => {
        this.handleProfileUpdate(payload.payload)
      })
      .subscribe()

    this.activeContexts.set(contextKey, {
      type: 'user',
      id: userId,
      channel,
      subscribedUsers: new Set([userId]),
      lastHeartbeat: Date.now()
    })

    await this.loadInitialPresenceData([userId])
  }

  /**
   * Unsubscribe from a context (cleanup when leaving server, closing DM, etc.)
   */
  async unsubscribeFromContext(contextType: 'server' | 'dm' | 'user', contextId: string): Promise<void> {
    const contextKey = `${contextType}_${contextId}`
    const context = this.activeContexts.get(contextKey)
    
    if (!context) return

    console.log('🧹 Unsubscribing from context:', contextKey)

    // Unsubscribe from channel
    if (context.channel) {
      await context.channel.unsubscribe()
    }

    // Clean up cache for users only in this context
    context.subscribedUsers.forEach(userId => {
      const isInOtherContexts = Array.from(this.activeContexts.values())
        .some(otherContext => 
          otherContext !== context && otherContext.subscribedUsers.has(userId)
        )
      
      if (!isInOtherContexts) {
        this.presenceCache.delete(userId)
        this.cacheExpiryTimes.delete(userId)
      }
    })

    this.activeContexts.delete(contextKey)
  }

  /**
   * Update current user's status
   */
  async updateCurrentUserStatus(newStatus: UserStatus, customText?: string): Promise<void> {
    if (!this.currentUserPresence || !this.currentUserId) return

    console.log('🔄 Updating current user status:', UserStatus[newStatus])

    // Update local presence
    this.currentUserPresence = {
      ...this.currentUserPresence,
      status: newStatus,
      isOnline: newStatus !== UserStatus.Offline,
      customStatusText: customText,
      lastSeen: new Date().toISOString()
    }

    // Update cache
    this.presenceCache.set(this.currentUserId, this.currentUserPresence)

    // Broadcast to all active contexts
    const updatePromises = Array.from(this.activeContexts.values()).map(context => {
      if (context.channel) {
        return context.channel.track(this.currentUserPresence!)
      }
    })

    await Promise.all(updatePromises)

    // Update in database
    try {
      await supabase
        .from('profiles')
        .update({ 
          status: newStatus,
          custom_status_text: customText
        })
        .eq('id', this.currentUserId)
    } catch (error) {
      console.error('❌ Failed to update status in database:', error)
    }

    this.emitEvent('presence-updated', { userId: this.currentUserId, presence: this.currentUserPresence })
  }

  /**
   * Broadcast profile update to all contexts
   */
  async broadcastProfileUpdate(profileData: Partial<FullUserPresence>): Promise<void> {
    if (!this.currentUserPresence || !this.currentUserId) return

    // Update local presence
    this.currentUserPresence = {
      ...this.currentUserPresence,
      ...profileData,
      lastSeen: new Date().toISOString()
    }

    // Update cache
    this.presenceCache.set(this.currentUserId, this.currentUserPresence)

    // Broadcast to all active contexts
    const broadcastPromises = Array.from(this.activeContexts.values()).map(context => {
      if (context.channel) {
        return context.channel.send({
          type: 'broadcast',
          event: 'profile_update',
          payload: {
            userId: this.currentUserId,
            ...profileData
          }
        })
      }
    })

    await Promise.all(broadcastPromises)

    this.emitEvent('profile-updated', { userId: this.currentUserId, updates: profileData })
  }

  /**
   * Get cached presence for a user
   */
  getUserPresence(userId: string): FullUserPresence | null {
    const cached = this.presenceCache.get(userId)
    const expiry = this.cacheExpiryTimes.get(userId)
    
    if (cached && expiry && Date.now() < expiry) {
      return cached
    }
    
    // Cache expired or doesn't exist
    this.presenceCache.delete(userId)
    this.cacheExpiryTimes.delete(userId)
    return null
  }

  /**
   * Load initial presence data from database
   */
  private async loadInitialPresenceData(userIds: string[]): Promise<void> {
    try {
      const { data: profiles } = await supabase
        .from('profiles')
        .select(`
          id, username, display_name, avatar_url, banner_url, status, color, bio, 
          custom_status_text, verified, domain, handle, is_local, federated_id, ap_id,
          followers_count, following_count, posts_count, message_count, voice_time,
          created_at, updated_at
        `)
        .in('id', userIds)

      if (profiles) {
        profiles.forEach(profile => {
          const presence: FullUserPresence = {
            userId: profile.id,
            status: profile.status || UserStatus.Offline,
            isOnline: false, // Will be updated by real-time presence
            lastSeen: new Date().toISOString(),
            
            // Core profile data
            username: profile.username || 'Unknown',
            displayName: profile.display_name || profile.username || 'Unknown User',
            avatarUrl: profile.avatar_url,
            bannerUrl: profile.banner_url,
            userColor: profile.color,
            bio: profile.bio,
            customStatusText: profile.custom_status_text,
            
            // Verification and badges
            verified: profile.verified || false,
            roles: [], // TODO: Load roles from separate table if needed
            
            // Federation data
            domain: profile.domain,
            handle: profile.handle,
            isLocal: profile.is_local ?? true,
            federatedId: profile.federated_id,
            apId: profile.ap_id,
            
            // Social stats
            followersCount: profile.followers_count,
            followingCount: profile.following_count,
            postsCount: profile.posts_count,
            
            // Timestamps
            createdAt: profile.created_at,
            updatedAt: profile.updated_at,
            
            // Chat stats
            messageCount: profile.message_count,
            voiceTime: profile.voice_time
          }

          this.presenceCache.set(profile.id, presence)
          this.cacheExpiryTimes.set(profile.id, Date.now() + this.CACHE_TTL)
        })

        console.log(`✅ Loaded initial presence data for ${profiles.length} users`)
      }
    } catch (error) {
      console.error('❌ Failed to load initial presence data:', error)
    }
  }

  /**
   * Handle presence sync events
   */
  private handlePresenceSync(contextKey: string, channel: RealtimeChannel): void {
    const state = channel.presenceState()
    
    Object.entries(state).forEach(([userId, presences]) => {
      if (presences.length > 0) {
        // Supabase presence state format is different, get the actual presence data
        const presenceData = presences[0] as any
        const cached = this.presenceCache.get(userId)
        
        if (cached) {
          // Update the cached presence to show user as online
          this.updatePresenceCache(userId, { ...cached, isOnline: true })
        } else if (presenceData && typeof presenceData === 'object' && presenceData.userId) {
          // If we have full presence data, use it
          const presence = presenceData as FullUserPresence
          this.updatePresenceCache(userId, { ...presence, isOnline: true })
        }
      }
    })

    console.log(`📡 Presence sync for ${contextKey}:`, Object.keys(state).length, 'users')
    this.emitEvent('presence-sync', { contextKey, userCount: Object.keys(state).length })
  }

  /**
   * Handle user join events
   */
  private handleUserJoin(contextKey: string, payload: any): void {
    if (payload.newPresences && payload.newPresences.length > 0) {
      const presence = payload.newPresences[0] as FullUserPresence
      this.updatePresenceCache(presence.userId, { ...presence, isOnline: true })
      
      console.log('👋 User joined:', presence.userId, 'in context:', contextKey)
      this.emitEvent('user-joined', { userId: presence.userId, contextKey, presence })
    }
  }

  /**
   * Handle user leave events
   */
  private handleUserLeave(contextKey: string, payload: any): void {
    if (payload.leftPresences && payload.leftPresences.length > 0) {
      const presence = payload.leftPresences[0] as FullUserPresence
      this.updatePresenceCache(presence.userId, { ...presence, isOnline: false })
      
      console.log('👋 User left:', presence.userId, 'from context:', contextKey)
      this.emitEvent('user-left', { userId: presence.userId, contextKey })
    }
  }

  /**
   * Handle profile update broadcasts
   */
  private handleProfileUpdate(payload: any): void {
    const { userId, ...updates } = payload
    const cached = this.presenceCache.get(userId)
    
    if (cached) {
      const updatedPresence = { ...cached, ...updates }
      this.updatePresenceCache(userId, updatedPresence)
      
      console.log('📝 Profile updated for user:', userId, 'updates:', Object.keys(updates))
      this.emitEvent('profile-updated', { userId, updates })
    }
  }

  /**
   * Handle typing updates
   */
  private handleTypingUpdate(payload: any): void {
    const { userId, isTyping } = payload
    const cached = this.presenceCache.get(userId)
    
    if (cached) {
      this.updatePresenceCache(userId, { ...cached, isTyping })
      this.emitEvent('typing-updated', { userId, isTyping })
    }
  }

  /**
   * Update presence cache with TTL
   */
  private updatePresenceCache(userId: string, presence: FullUserPresence): void {
    this.presenceCache.set(userId, presence)
    this.cacheExpiryTimes.set(userId, Date.now() + this.CACHE_TTL)
  }

  /**
   * Start heartbeat for current user
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.currentUserPresence) {
        this.currentUserPresence.lastSeen = new Date().toISOString()
        
        // Update all active contexts
        this.activeContexts.forEach(context => {
          if (context.channel) {
            context.channel.track(this.currentUserPresence!)
          }
        })
      }
    }, 30000) // 30 second heartbeat
  }

  /**
   * Start cleanup routine for expired cache
   */
  private startCleanupRoutine(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now()
      
      this.cacheExpiryTimes.forEach((expiry, userId) => {
        if (now > expiry) {
          this.presenceCache.delete(userId)
          this.cacheExpiryTimes.delete(userId)
        }
      })
    }, 60000) // Clean up every minute
  }

  /**
   * Cleanup all resources
   */
  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up contextual presence service')

    // Clear intervals
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }

    // Unsubscribe from all contexts
    const unsubscribePromises = Array.from(this.activeContexts.keys()).map(contextKey => {
      const [type, id] = contextKey.split('_', 2)
      return this.unsubscribeFromContext(type as any, id)
    })

    await Promise.all(unsubscribePromises)

    // Clear all data
    this.activeContexts.clear()
    this.presenceCache.clear()
    this.cacheExpiryTimes.clear()
    this.currentUserId = null
    this.currentUserPresence = null
  }

  /**
   * Event listener management
   */
  addEventListener(event: string, listener: EventListener): void {
    this.eventTarget.addEventListener(event, listener)
  }

  removeEventListener(event: string, listener: EventListener): void {
    this.eventTarget.removeEventListener(event, listener)
  }

  private emitEvent(type: string, detail: any): void {
    this.eventTarget.dispatchEvent(new CustomEvent(type, { detail }))
  }

  /**
   * Debug information
   */
  getDebugInfo(): any {
    return {
      currentUserId: this.currentUserId,
      activeContexts: Array.from(this.activeContexts.keys()),
      cachedUsers: Array.from(this.presenceCache.keys()),
      currentUserPresence: this.currentUserPresence
    }
  }
}

export const contextualPresenceService = new ContextualPresenceService()
