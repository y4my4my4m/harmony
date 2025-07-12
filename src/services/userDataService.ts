/**
 * User Data Service
 * 
 * Discord/Slack-style user data management with:
 * - Smart fetching and caching
 * - Real-time presence sync
 * - Single source of truth for all user data
 * - Efficient context-based subscriptions
 */

import { supabase } from '@/supabase'
import { UserStatus } from '@/types'
import type { RealtimeChannel } from '@supabase/supabase-js'

export interface UserData {
  // Core identity
  id: string
  username: string
  displayName: string
  
  // Profile data
  avatarUrl?: string
  bio?: string
  color?: string
  domain?: string
  
  // Presence data (real-time)
  status: UserStatus
  isOnline: boolean
  lastSeen: string
  lastHeartbeat: string
  
  // Cache metadata
  lastUpdated: string
  source: 'database' | 'presence' | 'cache'
}

export interface UserContext {
  id: string
  type: 'server' | 'dm' | 'global'
  userIds: Set<string>
  channel?: RealtimeChannel
  lastSync: Date
}

class UserDataService extends EventTarget {
  private users = new Map<string, UserData>()
  private contexts = new Map<string, UserContext>()
  private currentUserId: string | null = null
  private globalChannel: RealtimeChannel | null = null
  private initialized = false
  
  // Cache settings
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes
  private readonly HEARTBEAT_INTERVAL = 30 * 1000 // 30 seconds
  private heartbeatTimer: NodeJS.Timeout | null = null

  /**
   * Initialize the service for a user
   */
  async initialize(userId: string, username: string, avatarUrl?: string): Promise<void> {
    if (this.initialized && this.currentUserId === userId) return
    
    console.log('🚀 Initializing User Data Service for:', username)
    
    this.cleanup()
    this.currentUserId = userId
    
    // Initialize current user
    await this.initializeCurrentUser(userId, username, avatarUrl)
    
    // Setup global presence channel
    await this.setupGlobalPresence()
    
    // Start heartbeat
    this.startHeartbeat()
    
    this.initialized = true
    console.log('✅ User Data Service initialized')
  }
  
  /**
   * Initialize current user data
   */
  private async initializeCurrentUser(userId: string, username: string, avatarUrl?: string): Promise<void> {
    try {
      // Try to load from database first
      const { data: profile } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, bio, color, status, domain, updated_at')
        .eq('id', userId)
        .single()
      
      if (profile) {
        const userData: UserData = {
          id: profile.id,
          username: profile.username || username,
          displayName: profile.display_name || profile.username || username,
          avatarUrl: profile.avatar_url || avatarUrl,
          bio: profile.bio,
          color: profile.color,
          domain: profile.domain || 'har.mony.lol',
          status: profile.status ?? UserStatus.Online,
          isOnline: true,
          lastSeen: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          source: 'database'
        }
        
        this.users.set(userId, userData)
        console.log('✅ Current user initialized from database:', userData.displayName)
      } else {
        // Create minimal user data
        const userData: UserData = {
          id: userId,
          username: username,
          displayName: username,
          avatarUrl: avatarUrl,
          status: UserStatus.Online,
          isOnline: true,
          lastSeen: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          source: 'cache'
        }
        
        this.users.set(userId, userData)
        console.log('✅ Current user initialized with minimal data:', username)
      }
      
      this.emitEvent('user-updated', { userId })
      
    } catch (error) {
      console.error('❌ Failed to initialize current user:', error)
      throw error
    }
  }
  
  /**
   * Setup selective global presence channel - only for connectivity, not user tracking
   */
  private async setupGlobalPresence(): Promise<void> {
    if (!this.currentUserId) return
    
    // Use a lightweight global channel only for current user's connectivity
    this.globalChannel = supabase.channel(`user-presence:${this.currentUserId}`)
      .subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED') {
          console.log('✅ Personal presence channel connected')
          await this.trackCurrentUser()
        }
      })
  }
  
  /**
   * Track current user connectivity (lightweight)
   */
  private async trackCurrentUser(): Promise<void> {
    if (!this.globalChannel || !this.currentUserId) return
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) return
    
    // Just maintain basic connectivity, detailed presence handled by context channels
    await this.globalChannel.track({
      user_id: this.currentUserId,
      online_at: new Date().toISOString()
    })
    
    console.log('✅ Current user connectivity tracked')
  }
  
  // Global presence sync handlers removed - we now only track context-specific users
  
  /**
   * Update user data from presence
   */
  private updateUserFromPresence(userId: string, presence: any): void {
    const existing = this.users.get(userId)
    
    const userData: UserData = {
      id: userId,
      username: presence.username || existing?.username || 'Unknown',
      displayName: presence.display_name || presence.username || existing?.displayName || 'Unknown',
      avatarUrl: presence.avatar_url || existing?.avatarUrl,
      bio: existing?.bio,
      color: existing?.color,
      domain: existing?.domain || 'har.mony.lol',
      status: presence.status ?? existing?.status ?? UserStatus.Online,
      isOnline: true,
      lastSeen: presence.online_at || new Date().toISOString(),
      lastHeartbeat: presence.online_at || new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      source: 'presence'
    }
    
    this.users.set(userId, userData)
    this.emitEvent('user-updated', { userId })
  }
  
  /**
   * Start heartbeat to maintain presence
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    
    this.heartbeatTimer = setInterval(async () => {
      if (this.currentUserId) {
        const userData = this.users.get(this.currentUserId)
        if (userData) {
          userData.lastHeartbeat = new Date().toISOString()
          await this.trackCurrentUser()
        }
      }
    }, this.HEARTBEAT_INTERVAL)
  }
  
  /**
   * Subscribe to a context (server, DM)
   */
  async subscribeToContext(contextId: string, type: 'server' | 'dm', userIds: string[]): Promise<void> {
    console.log(`🔄 Subscribing to ${type} context:`, contextId, `(${userIds.length} users)`)
    
    // Load user data for context
    await this.loadUsersData(userIds)
    
    // Create context
    const context: UserContext = {
      id: contextId,
      type,
      userIds: new Set(userIds),
      lastSync: new Date()
    }
    
    this.contexts.set(contextId, context)
    
    // Setup context-specific presence if needed
    if (type === 'server') {
      await this.setupServerPresence(contextId, userIds)
    }
    
    console.log(`✅ Subscribed to ${type} context:`, contextId)
  }
  
  /**
   * Setup server-specific presence channel
   */
  private async setupServerPresence(serverId: string, userIds: string[]): Promise<void> {
    const channelName = `server-presence:${serverId}`
    const channel = supabase.channel(channelName)
      .on('presence', { event: 'sync' }, () => this.handleServerSync(serverId))
      .on('presence', { event: 'join' }, ({ newPresences }: { newPresences: any[] }) => this.handleServerUserJoin(serverId, newPresences))
      .on('presence', { event: 'leave' }, ({ leftPresences }: { leftPresences: any[] }) => this.handleServerUserLeave(serverId, leftPresences))
      .subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED') {
          console.log(`✅ Server presence connected: ${serverId}`)
          
          // Track current user if they're in this server
          if (this.currentUserId && userIds.includes(this.currentUserId)) {
            await this.trackCurrentUserInServer(channel, serverId)
          }
        }
      })
    
    const context = this.contexts.get(serverId)
    if (context) {
      context.channel = channel
    }
  }
  
  /**
   * Track current user in server presence
   */
  private async trackCurrentUserInServer(channel: RealtimeChannel, serverId: string): Promise<void> {
    if (!this.currentUserId) return
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) return
    
    await channel.track({
      user_id: this.currentUserId,
      username: userData.username,
      display_name: userData.displayName,
      avatar_url: userData.avatarUrl,
      status: userData.status,
      server_id: serverId,
      online_at: new Date().toISOString()
    })
  }
  
  /**
   * Handle server presence sync
   */
  private handleServerSync(serverId: string): void {
    const context = this.contexts.get(serverId)
    if (!context?.channel) return
    
    const state = context.channel.presenceState()
    console.log(`📡 Server ${serverId} presence sync:`, Object.keys(state).length, 'users')
    
    Object.entries(state).forEach(([userId, presences]) => {
      if (Array.isArray(presences) && presences.length > 0) {
        const presence = presences[0] as any
        this.updateUserFromPresence(userId, presence)
      }
    })
  }
  
  /**
   * Handle server user join
   */
  private handleServerUserJoin(serverId: string, newPresences: any[]): void {
    newPresences.forEach(presence => {
      this.updateUserFromPresence(presence.user_id, presence)
      console.log(`👋 User joined server ${serverId}:`, presence.display_name || presence.username)
    })
  }
  
  /**
   * Handle server user leave
   */
  private handleServerUserLeave(serverId: string, leftPresences: any[]): void {
    leftPresences.forEach(presence => {
      const userData = this.users.get(presence.user_id)
      if (userData) {
        userData.isOnline = false
        userData.lastSeen = new Date().toISOString()
        userData.lastUpdated = new Date().toISOString()
        this.emitEvent('user-updated', { userId: presence.user_id })
      }
      console.log(`👋 User left server ${serverId}:`, presence.display_name || presence.username)
    })
  }
  
  /**
   * Load user data from database
   */
  private async loadUsersData(userIds: string[]): Promise<void> {
    const missingUserIds = userIds.filter(id => !this.users.has(id) || this.isUserDataStale(id))
    
    if (missingUserIds.length === 0) return
    
    console.log(`🔄 Loading user data for ${missingUserIds.length} users`)
    
    try {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, bio, color, status, domain, updated_at')
        .in('id', missingUserIds)
      
      if (profiles) {
        profiles.forEach((profile: any) => {
          const userData: UserData = {
            id: profile.id,
            username: profile.username || 'Unknown',
            displayName: profile.display_name || profile.username || 'Unknown',
            avatarUrl: profile.avatar_url,
            bio: profile.bio,
            color: profile.color,
            domain: profile.domain || 'har.mony.lol',
            status: profile.status ?? UserStatus.Offline,
            isOnline: false, // Will be updated by presence
            lastSeen: profile.updated_at || new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            source: 'database'
          }
          
          this.users.set(profile.id, userData)
        })
        
        console.log(`✅ Loaded ${profiles.length} user profiles from database`)
      }
      
    } catch (error) {
      console.error('❌ Failed to load user data:', error)
    }
  }
  
  /**
   * Check if user data is stale and needs refresh
   */
  private isUserDataStale(userId: string): boolean {
    const userData = this.users.get(userId)
    if (!userData) return true
    
    const age = Date.now() - new Date(userData.lastUpdated).getTime()
    return age > this.CACHE_TTL
  }
  
  /**
   * Update current user status
   */
  async updateCurrentUserStatus(status: UserStatus): Promise<void> {
    if (!this.currentUserId) throw new Error('No current user')
    
    console.log('🔄 Updating current user status to:', UserStatus[status])
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) throw new Error('Current user data not found')
    
    // Update local data immediately
    userData.status = status
    userData.lastUpdated = new Date().toISOString()
    userData.lastHeartbeat = new Date().toISOString()
    
    try {
      // Update database
      await supabase
        .from('profiles')
        .update({ status })
        .eq('id', this.currentUserId)
      
      // Update all presence channels
      await this.updatePresenceStatus(status)
      
      this.emitEvent('status-changed', { userId: this.currentUserId, status })
      console.log('✅ Status updated successfully to:', UserStatus[status])
      
    } catch (error) {
      console.error('❌ Failed to update status:', error)
      throw error
    }
  }
  
  /**
   * Update status in context-specific presence channels only
   */
  private async updatePresenceStatus(status: UserStatus): Promise<void> {
    // Only update context-specific presence channels (servers, DMs)
    for (const context of this.contexts.values()) {
      if (context.channel && context.userIds.has(this.currentUserId!)) {
        const userData = this.users.get(this.currentUserId!)
        if (userData) {
          await context.channel.track({
            user_id: this.currentUserId,
            username: userData.username,
            display_name: userData.displayName,
            avatar_url: userData.avatarUrl,
            status: status,
            server_id: context.id,
            online_at: new Date().toISOString()
          })
        }
      }
    }
    
    console.log(`📡 Status updated in ${this.contexts.size} context channels`)
  }
  
  /**
   * Public API - Get user data
   */
  getUser(userId: string): UserData | null {
    return this.users.get(userId) || null
  }
  
  getCurrentUser(): UserData | null {
    return this.currentUserId ? this.users.get(this.currentUserId) || null : null
  }
  
  getUsersInContext(contextId: string): UserData[] {
    const context = this.contexts.get(contextId)
    if (!context) return []
    
    return Array.from(context.userIds)
      .map(id => this.users.get(id))
      .filter(Boolean) as UserData[]
  }
  
  getAllUsers(): UserData[] {
    return Array.from(this.users.values())
  }
  
  getOnlineUsers(): UserData[] {
    return Array.from(this.users.values()).filter(user => user.isOnline)
  }
  
  /**
   * Unsubscribe from context
   */
  async unsubscribeFromContext(contextId: string): Promise<void> {
    const context = this.contexts.get(contextId)
    if (context?.channel) {
      await context.channel.unsubscribe()
    }
    
    this.contexts.delete(contextId)
    console.log('✅ Unsubscribed from context:', contextId)
  }
  
  /**
   * Emit custom events
   */
  private emitEvent(type: string, data: any): void {
    this.dispatchEvent(new CustomEvent(type, { detail: data }))
  }
  
  /**
   * Cleanup and reset
   */
  async cleanup(): Promise<void> {
    console.log('🧹 Cleaning up User Data Service')
    
    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    
    // Unsubscribe from all contexts
    for (const context of this.contexts.values()) {
      if (context.channel) {
        await context.channel.unsubscribe()
      }
    }
    
    // Unsubscribe from global presence
    if (this.globalChannel) {
      await this.globalChannel.unsubscribe()
      this.globalChannel = null
    }
    
    // Clear data
    this.users.clear()
    this.contexts.clear()
    this.currentUserId = null
    this.initialized = false
    
    console.log('✅ User Data Service cleaned up')
  }
  
  /**
   * Force refresh of all data
   */
  async refresh(): Promise<void> {
    console.log('🔄 Refreshing all user data')
    
    // Reload all cached users
    const userIds = Array.from(this.users.keys())
    this.users.clear()
    
    if (userIds.length > 0) {
      await this.loadUsersData(userIds)
    }
    
    // Reinitialize current user
    if (this.currentUserId) {
      const userData = this.users.get(this.currentUserId)
      if (userData) {
        await this.initializeCurrentUser(this.currentUserId, userData.username, userData.avatarUrl)
      }
    }
    
    this.emitEvent('data-refreshed', {})
    console.log('✅ User data refreshed')
  }
  
  /**
   * Get service stats for debugging
   */
  getStats() {
    return {
      totalUsers: this.users.size,
      onlineUsers: this.getOnlineUsers().length,
      contexts: this.contexts.size,
      currentUser: this.currentUserId,
      initialized: this.initialized,
      globalChannelConnected: !!this.globalChannel
    }
  }
}

// Export singleton instance
export const userDataService = new UserDataService()