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
import { activityTracker } from '@/services/ActivityTracker'
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
  createdAt: string // When the user account was created
  updatedAt?: string // When the profile was last updated in database
  roles?: any[]
  messageCount?: number
  voiceTime?: number
  
  // Presence data (real-time)
  status: UserStatus
  isOnline: boolean
  lastSeen: string
  lastHeartbeat: string
  
  // Cache metadata
  isLocal: boolean // true if loaded from local cache, false if fetched from server
  lastCacheUpdate: string // When we last fetched/updated this data in our local cache
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
  
  // Status management
  private wasManuallySet = false
  private manualStatus: UserStatus | null = null
  private lastAutoStatus: UserStatus = UserStatus.Online
  
  // Cache settings
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes
  private readonly HEARTBEAT_INTERVAL = 30 * 1000 // 30 seconds
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatFailures = 0
  private readonly MAX_HEARTBEAT_FAILURES = 3

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
    
    // Start activity tracking and lifecycle management
    this.setupActivityTracking()
    
    // Start heartbeat
    this.startHeartbeat()
    
    this.initialized = true
    console.log('✅ User Data Service initialized')
  }
  
  /**
   * Professional status restoration from localStorage backup
   */
  private getStatusFromLocalStorage(): UserStatus | null {
    try {
      const saved = localStorage.getItem('harmony_user_status')
      if (saved !== null) {
        const statusNumber = parseInt(saved, 10)
        if (!isNaN(statusNumber) && statusNumber >= 0 && statusNumber <= 3) {
          console.log('📱 Found status backup in localStorage:', UserStatus[statusNumber])
          return statusNumber as UserStatus
        }
      }
    } catch (error) {
      console.warn('⚠️ Failed to read status from localStorage:', error)
    }
    return null
  }
  
  /**
   * Setup activity tracking and lifecycle management
   */
  private setupActivityTracking(): void {
    // Start activity tracking
    activityTracker.startTracking()
    
    // Listen for activity events
    activityTracker.addEventListener('activity-resumed', () => {
      this.handleActivityResumed()
    })
    
    activityTracker.addEventListener('status-should-change', (event: any) => {
      this.handleAutomaticStatusChange(event.detail)
    })
    
    console.log('🎯 Activity tracking started')
  }
  
  /**
   * Handle user activity resumption
   */
  private async handleActivityResumed(): Promise<void> {
    if (!this.currentUserId) return
    
    // If user was set to Away/Offline automatically, restore their preferred status
    const userData = this.users.get(this.currentUserId)
    if (!userData) return
    
    // If status was manually set (Away, Busy), respect that
    if (this.wasManuallySet && this.manualStatus !== null) {
      console.log('👋 User active again, restoring manual status:', UserStatus[this.manualStatus])
      await this.updateCurrentUserStatus(this.manualStatus, false) // Don't mark as manual again
    } else {
      // Restore to Online if they were auto-set to Away/Offline
      if (userData.status === UserStatus.Away || userData.status === UserStatus.Offline) {
        console.log('👋 User active again, restoring to Online')
        await this.updateCurrentUserStatus(UserStatus.Online, false)
      }
    }
    
    // Reset activity tracking
    activityTracker.resetStatusTracking()
  }
  
  /**
   * Handle automatic status changes due to inactivity
   */
  private async handleAutomaticStatusChange(detail: { status: UserStatus, reason: string, inactiveTime: number }): Promise<void> {
    if (!this.currentUserId) return
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) return
    
    // Only auto-change status if it's currently Online or if going to Offline
    // Don't override manual Away/Busy settings
    if (this.wasManuallySet && userData.status !== UserStatus.Online && detail.status !== UserStatus.Offline) {
      console.log('⏭️ Skipping auto status change - user manually set to:', UserStatus[userData.status])
      return
    }
    
    console.log(`😴 Auto-changing status to ${UserStatus[detail.status]} due to ${detail.reason} (${Math.round(detail.inactiveTime / 60000)}min)`)
    
    // Store current status if it's manual
    if (!this.wasManuallySet && userData.status !== UserStatus.Online) {
      this.manualStatus = userData.status
      this.wasManuallySet = true
    }
    
    await this.updateCurrentUserStatus(detail.status, false) // Don't mark as manual
  }
  
  /**
   * Initialize current user data (Discord/Slack style)
   */
  private async initializeCurrentUser(userId: string, username: string, avatarUrl?: string): Promise<void> {
    try {
      // Try to load from database first - this is the primary source of truth
      const { data: profile } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, bio, color, status, domain, is_local, updated_at, created_at')
        .eq('id', userId)
        .single()
      
      if (profile) {
        // Professional status handling: database is truth, localStorage is backup
        // IMPORTANT: Active users should be Online by default, not Offline
        let finalStatus = UserStatus.Online // Always default to Online for active users
        
        // Primary: Use database status if it exists and is valid AND not offline
        if (profile.status !== null && profile.status !== undefined) {
          // If user was explicitly set to Away/Busy, preserve that
          if (profile.status === UserStatus.Away || profile.status === UserStatus.Busy) {
            finalStatus = profile.status
            console.log('✅ Preserving user-set status from database:', UserStatus[finalStatus])
          } else if (profile.status === UserStatus.Online) {
            finalStatus = UserStatus.Online
            console.log('✅ Status loaded from database:', UserStatus[finalStatus])
          } else {
            // User was offline in database, but they're actively using the app now
            finalStatus = UserStatus.Online
            console.log('🔄 User was offline in DB but is now active, setting to Online')
            
            // Update database to reflect they're now online
            try {
              await supabase
                .from('profiles')
                .update({ status: UserStatus.Online })
                .eq('id', userId)
              console.log('💾 Updated database to show user as Online')
            } catch (syncError) {
              console.warn('⚠️ Failed to update online status in database:', syncError)
            }
          }
        } else {
          // No status in database, try localStorage backup for Away/Busy only
          const backupStatus = this.getStatusFromLocalStorage()
          if (backupStatus === UserStatus.Away || backupStatus === UserStatus.Busy) {
            finalStatus = backupStatus
            console.log('🔄 Using Away/Busy status from localStorage backup:', UserStatus[finalStatus])
            
            // Sync backup to database for consistency
            try {
              await supabase
                .from('profiles')
                .update({ status: finalStatus })
                .eq('id', userId)
              console.log('💾 Synced localStorage status to database')
            } catch (syncError) {
              console.warn('⚠️ Failed to sync status to database:', syncError)
            }
          } else {
            // Default to Online - user is actively using the app
            console.log('🆕 No valid status found, defaulting to Online (user is active)')
          }
        }
        
        console.log('🔧 Profile data for isLocal check:', {
          userId: profile.id,
          username: profile.username,
          is_local: profile.is_local,
          domain: profile.domain
        });
        
        const userData: UserData = {
          id: profile.id,
          username: profile.username || username,
          displayName: profile.display_name || profile.username || username,
          avatarUrl: profile.avatar_url || avatarUrl,
          bio: profile.bio,
          color: profile.color,
          domain: profile.domain || 'har.mony.lol',
          isLocal: profile.is_local || false,
          status: finalStatus,
          isOnline: true,
          lastSeen: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
          lastCacheUpdate: new Date().toISOString(),
          createdAt: profile.created_at || new Date().toISOString(),
          source: 'database'
        }
        
        this.users.set(userId, userData)
        console.log('✅ Current user initialized:', userData.displayName, 'Final Status:', UserStatus[finalStatus])
      } else {
        // No profile exists - user is actively using the app, so they should be Online
        const backupStatus = this.getStatusFromLocalStorage()
        // Only use backup status if it's Away or Busy (user preference states)
        // Never use Offline from backup since user is actively using the app
        const initialStatus = (backupStatus === UserStatus.Away || backupStatus === UserStatus.Busy) 
          ? backupStatus 
          : UserStatus.Online
        
        const userData: UserData = {
          id: userId,
          username: username,
          displayName: username,
          avatarUrl: avatarUrl,
          status: initialStatus,
          isOnline: true,
          isLocal: true,
          lastSeen: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
          lastCacheUpdate: new Date().toISOString(),
          createdAt: new Date().toISOString(), //TODO: does that make sense?
          source: 'cache'
        }
        
        this.users.set(userId, userData)
        console.log('✅ Current user initialized with minimal data:', username, 'Status:', UserStatus[initialStatus])
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
      isLocal: existing?.isLocal || false,
      status: presence.status ?? existing?.status ?? UserStatus.Online,
      isOnline: true,
      lastSeen: presence.online_at || new Date().toISOString(),
      lastHeartbeat: presence.online_at || new Date().toISOString(),
      lastCacheUpdate: new Date().toISOString(),
      createdAt: existing?.createdAt || new Date().toISOString(),
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
          try {
            userData.lastHeartbeat = new Date().toISOString()
            await this.trackCurrentUser()
            
            // Reset failure count on successful heartbeat
            this.heartbeatFailures = 0
            
          } catch (error) {
            console.warn('💔 Heartbeat failed:', error)
            this.heartbeatFailures++
            
            // If heartbeat fails repeatedly, set offline
            if (this.heartbeatFailures >= this.MAX_HEARTBEAT_FAILURES) {
              console.log('💀 Connection lost - setting offline after', this.heartbeatFailures, 'failures')
              await this.handleConnectionLost()
            }
          }
        }
      }
    }, this.HEARTBEAT_INTERVAL)
  }
  
  /**
   * Handle connection loss - set offline status
   */
  private async handleConnectionLost(): Promise<void> {
    if (!this.currentUserId) return
    
    console.log('📡 Connection lost - setting user offline')
    
    try {
      // Set offline status (this will be automatic, not manual)
      await this.updateCurrentUserStatus(UserStatus.Offline, false)
    } catch (error) {
      console.error('Failed to set offline status on connection loss:', error)
    }
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
      // 🔥 Listen for profile update broadcasts (the correct way for real-time profile changes)
      .on('broadcast', { event: 'profile_update' }, (payload) => this.handleProfileUpdateBroadcast(serverId, payload))
      // Listen for real-time server membership changes
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'user_servers',
        filter: `server_id=eq.${serverId}`
      }, (payload) => this.handleServerMemberJoin(serverId, payload))
      .on('postgres_changes', {
        event: 'DELETE', 
        schema: 'public',
        table: 'user_servers',
        filter: `server_id=eq.${serverId}`
      }, (payload) => this.handleServerMemberLeave(serverId, payload))
      // 🔥 Listen for real-time PROFILE changes (avatar, display name, color, bio)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public', 
        table: 'profiles'
      }, (payload) => this.handleProfileUpdate(serverId, payload))
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
        userData.lastCacheUpdate = new Date().toISOString()
        this.emitEvent('user-updated', { userId: presence.user_id })
      }
      console.log(`👋 User left server ${serverId}:`, presence.display_name || presence.username)
    })
  }

  /**
   * Handle real-time server membership join
   */
  private async handleServerMemberJoin(serverId: string, payload: any): Promise<void> {
    const newUserId = payload.new.user_id
    console.log(`👤 New member joined server ${serverId}:`, newUserId)
    
    const context = this.contexts.get(serverId)
    if (context) {
      // Add user to context
      context.userIds.add(newUserId)
      
      // Load user data
      await this.loadUsersData([newUserId])
      
      // Emit context update
      this.emitEvent('context-updated', { contextId: serverId, type: 'member-join', userId: newUserId })
    }
  }

  /**
   * Handle real-time server membership leave  
   */
  private async handleServerMemberLeave(serverId: string, payload: any): Promise<void> {
    const leftUserId = payload.old.user_id
    console.log(`👋 Member left server ${serverId}:`, leftUserId)
    
    const context = this.contexts.get(serverId)
    if (context) {
      // Remove user from context
      context.userIds.delete(leftUserId)
      
      // Mark user as offline for this context
      const userData = this.users.get(leftUserId)
      if (userData) {
        userData.isOnline = false
        userData.lastSeen = new Date().toISOString()
        userData.lastCacheUpdate = new Date().toISOString()
      }
      
      // Emit context update
      this.emitEvent('context-updated', { contextId: serverId, type: 'member-leave', userId: leftUserId })
    }
  }

  /**
   * Handle real-time profile updates (avatar, display name, color, bio)
   * This ensures all users in the server see profile changes in real-time
   */
  private async handleProfileUpdate(serverId: string, payload: any): Promise<void> {
    const updatedProfile = payload.new
    const userId = updatedProfile.id
    
    console.log(`🔄 Profile update received for user ${userId} in server ${serverId}:`, {
      display_name: updatedProfile.display_name,
      avatar_url: updatedProfile.avatar_url,
      color: updatedProfile.color
    })
    
    // Update our local user data if we have it
    const userData = this.users.get(userId)
    if (userData) {
      // Update all profile fields that might have changed
      if (updatedProfile.display_name !== undefined) {
        userData.displayName = updatedProfile.display_name
      }
      if (updatedProfile.avatar_url !== undefined) {
        userData.avatarUrl = updatedProfile.avatar_url
      }
      if (updatedProfile.bio !== undefined) {
        userData.bio = updatedProfile.bio
      }
      if (updatedProfile.color !== undefined) {
        userData.color = updatedProfile.color
      }
      if (updatedProfile.username !== undefined) {
        userData.username = updatedProfile.username
      }
      
      userData.lastCacheUpdate = new Date().toISOString()
      userData.source = 'database'
      
      // Emit update event so UI components can react
      this.emitEvent('user-updated', { userId })
      
      console.log(`✅ Updated user data for ${userData.displayName} in server ${serverId}`)
    } else {
      // If we don't have the user data, load it fresh from the database
      console.log(`🔄 Loading fresh user data for ${userId} after profile update`)
      await this.loadUsersData([userId])
      
      // Emit event after loading
      this.emitEvent('user-updated', { userId })
    }
    
    // Also emit a context-specific update event
    this.emitEvent('context-updated', { 
      contextId: serverId, 
      type: 'profile-update', 
      userId 
    })
  }
  
  /**
   * Handle profile update broadcast events from other users
   * This is how we receive real-time profile changes from other clients
   */
  private async handleProfileUpdateBroadcast(serverId: string, payload: any): Promise<void> {
    const { userId, ...profileUpdates } = payload.payload
    
    if (!userId || userId === this.currentUserId) {
      // Don't process our own broadcasts or invalid payloads
      return
    }
    
    console.log(`📡 Received profile update broadcast for user ${userId} in server ${serverId}:`, profileUpdates)
    
    // Update our local user data if we have it
    const userData = this.users.get(userId)
    if (userData) {
      // Update profile fields that were broadcast
      if (profileUpdates.displayName !== undefined) {
        userData.displayName = profileUpdates.displayName
      }
      if (profileUpdates.avatarUrl !== undefined) {
        userData.avatarUrl = profileUpdates.avatarUrl
      }
      if (profileUpdates.bio !== undefined) {
        userData.bio = profileUpdates.bio
      }
      if (profileUpdates.color !== undefined) {
        userData.color = profileUpdates.color
      }
      if (profileUpdates.username !== undefined) {
        userData.username = profileUpdates.username
      }
      
      userData.lastCacheUpdate = new Date().toISOString()
      userData.source = 'presence' // Updated via real-time broadcast
      
      // Emit update event so UI components can react immediately
      this.emitEvent('user-updated', { userId })
      
      console.log(`✅ Updated user data for ${userData.displayName} from broadcast`)
    } else {
      // If we don't have the user data, load it fresh from the database
      console.log(`🔄 Loading fresh user data for ${userId} after profile broadcast`)
      await this.loadUsersData([userId])
      
      // Emit event after loading
      this.emitEvent('user-updated', { userId })
    }
    
    // Also emit a context-specific update event
    this.emitEvent('context-updated', { 
      contextId: serverId, 
      type: 'profile-broadcast', 
      userId 
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
        .select('id, username, display_name, avatar_url, bio, color, status, domain, updated_at, created_at, is_local')
        .in('id', missingUserIds)
      
      if (profiles) {
        profiles.forEach((profile: any) => {
          console.log('🔧 Batch profile data for isLocal check:', {
            userId: profile.id,
            username: profile.username,
            is_local: profile.is_local,
            domain: profile.domain
          });
          
          const userData: UserData = {
            id: profile.id,
            username: profile.username || 'Unknown',
            displayName: profile.display_name || profile.username || 'Unknown',
            avatarUrl: profile.avatar_url,
            bio: profile.bio,
            color: profile.color,
            domain: profile.domain || 'har.mony.lol',
            isLocal: profile.is_local || false,
            status: profile.status ?? UserStatus.Offline,
            isOnline: false, // Will be updated by presence
            lastSeen: profile.updated_at || new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            lastCacheUpdate: new Date().toISOString(),
            createdAt: profile.created_at || new Date().toISOString(),
            updatedAt: profile.updated_at,
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
   * Get user in a format compatible with User interface (for backwards compatibility)
   */
  getUserProfile(userId: string): any | null {
    const userData = this.users.get(userId)
    if (!userData) return null
    
    return {
      id: userData.id,
      username: userData.username,
      display_name: userData.displayName,
      avatar_url: userData.avatarUrl,
      bio: userData.bio,
      color: userData.color,
      created_at: userData.createdAt,
      updated_at: userData.updatedAt,
      status: userData.status,
      domain: userData.domain,
      roles: userData.roles || [],
      is_local: userData.isLocal,
      online_at: userData.lastSeen,
      last_seen: userData.lastSeen
    }
  }
  
  /**
   * Professional cache management - automatically fetch missing user data
   */
  async fetchUserProfile(userId: string, forceRefresh: boolean = false): Promise<any | null> {
    // If force refresh or user not in cache, fetch from database
    if (forceRefresh || !this.users.has(userId) || this.isUserDataStale(userId)) {
      await this.loadUsersData([userId])
    }
    
    return this.getUserProfile(userId)
  }
  
  /**
   * Batch fetch multiple user profiles efficiently
   */
  async fetchMultipleUserProfiles(userIds: string[], forceRefresh: boolean = false): Promise<Record<string, any>> {
    // Load missing users
    if (forceRefresh) {
      // Force refresh all users
      userIds.forEach(id => this.users.delete(id))
    }
    
    await this.loadUsersData(userIds)
    
    // Return profiles in expected format
    const results: Record<string, any> = {}
    userIds.forEach(userId => {
      const profile = this.getUserProfile(userId)
      if (profile) {
        results[userId] = profile
      }
    })
    
    return results
  }

  /**
   * Public method to ensure user data is loaded (for external stores)
   */
  async ensureUsersLoaded(userIds: string[]): Promise<void> {
    await this.loadUsersData(userIds)
  }

  /**
   * Check if user data is stale and needs refresh
   */
  private isUserDataStale(userId: string): boolean {
    const userData = this.users.get(userId)
    if (!userData) return true
    
    const age = Date.now() - new Date(userData.lastCacheUpdate).getTime()
    return age > this.CACHE_TTL
  }
  
  /**
   * Update current user status (Discord/Slack style persistence)
   */
  async updateCurrentUserStatus(status: UserStatus, isManual: boolean = true): Promise<void> {
    if (!this.currentUserId) throw new Error('No current user')
    
    console.log('🔄 Updating current user status to:', UserStatus[status], isManual ? '(manual)' : '(automatic)')
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) throw new Error('Current user data not found')
    
    // Track manual status changes
    if (isManual) {
      this.wasManuallySet = (status === UserStatus.Away || status === UserStatus.Busy)
      this.manualStatus = this.wasManuallySet ? status : null
      // Note: activityTracker would be called here if available
      console.log('📌 Status manually set:', this.wasManuallySet ? 'Yes' : 'No')
    }
    
    // Update local data immediately for instant UI feedback
    userData.status = status
    userData.lastCacheUpdate = new Date().toISOString()
    userData.lastHeartbeat = new Date().toISOString()
    
    try {
      // Professional status persistence - update database with verification
      const { data, error } = await supabase
        .from('profiles')
        .update({ 
          status,
          updated_at: new Date().toISOString()
        })
        .eq('id', this.currentUserId)
        .select('status')
      
      if (error) {
        throw new Error(`Database update failed: ${error.message}`)
      }
      
      // Verify the status was actually saved
      if (data && data[0] && data[0].status !== status) {
        throw new Error(`Status verification failed. Expected: ${status}, Got: ${data[0].status}`)
      }
      
      console.log('✅ Status verified in database:', UserStatus[status])
      
      // Update all presence channels
      await this.updatePresenceStatus(status)
      
      // Save to localStorage as professional backup (like Discord/Slack)
      try {
        localStorage.setItem('harmony_user_status', status.toString())
        console.log('💾 Status backed up to localStorage')
      } catch (localStorageError) {
        console.warn('⚠️ Failed to backup status to localStorage:', localStorageError)
      }
      
      this.emitEvent('status-changed', { userId: this.currentUserId, status })
      console.log('✅ Status updated successfully to:', UserStatus[status])
      
    } catch (error) {
      console.error('❌ Failed to update status:', error)
      // Note: local change already applied, database update failed
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
   * Update current user profile data and broadcast to relevant contexts only
   * This is context-aware - only users who can see this user will get the update
   */
  async updateCurrentUserProfile(profileData: {
    displayName?: string
    avatarUrl?: string
    bio?: string
    color?: string
    username?: string
  }): Promise<void> {
    if (!this.currentUserId) throw new Error('No current user')
    
    console.log('🔄 Updating current user profile:', profileData)
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) throw new Error('Current user data not found')
    
    // Update local data immediately for instant UI feedback
    if (profileData.displayName !== undefined) userData.displayName = profileData.displayName
    if (profileData.avatarUrl !== undefined) userData.avatarUrl = profileData.avatarUrl
    if (profileData.bio !== undefined) userData.bio = profileData.bio
    if (profileData.color !== undefined) userData.color = profileData.color
    if (profileData.username !== undefined) userData.username = profileData.username
    userData.lastCacheUpdate = new Date().toISOString()
    
    try {
      // Broadcast profile changes to relevant contexts only (context-aware)
      await this.broadcastProfileToContexts(profileData)
      
      this.emitEvent('user-updated', { userId: this.currentUserId })
      console.log('✅ Profile updated and broadcast to relevant contexts')
      
    } catch (error) {
      console.error('❌ Failed to broadcast profile update:', error)
      throw error
    }
  }
  
  /**
   * Broadcast profile updates using proper broadcast events (not presence tracking)
   * Only users in the same server/DM contexts will receive the update - scalable approach
   */
  private async broadcastProfileToContexts(profileData: {
    displayName?: string
    avatarUrl?: string
    bio?: string
    color?: string
    username?: string
  }): Promise<void> {
    if (!this.currentUserId) return
    
    console.log(`🔄 Broadcasting profile update to ${this.contexts.size} contexts`)
    
    // Broadcast profile updates as events (not presence state)
    for (const context of this.contexts.values()) {
      if (context.channel && context.userIds.has(this.currentUserId)) {
        try {
          // Use broadcast events for profile updates (the correct way)
          await context.channel.send({
            type: 'broadcast',
            event: 'profile_update',
            payload: {
              userId: this.currentUserId,
              ...profileData
            }
          })
          
          console.log(`📡 Profile broadcast to ${context.type} context: ${context.id}`)
        } catch (error) {
          console.error(`❌ Failed to broadcast profile to context ${context.id}:`, error)
        }
      }
    }
    
    console.log(`📡 Profile broadcast completed to ${this.contexts.size} context channels`)
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
  
  /**
   * Find user ID by username (for mention parsing)
   */
  findUserIdByUsername(username: string, domain?: string): string | null {
    // Create search key - if domain provided, search for username@domain, otherwise just username
    const searchKey = domain ? `${username}@${domain}`.toLowerCase() : username.toLowerCase();
    
    // Search through all cached users
    for (const [userId, userData] of this.users.entries()) {
      // Check exact username match for local users
      if (!domain && userData.username.toLowerCase() === searchKey) {
        return userId;
      }
      
      // Check username@domain match for remote users or when domain is specified
      if (domain && userData.domain) {
        const userKey = `${userData.username}@${userData.domain}`.toLowerCase();
        if (userKey === searchKey) {
          return userId;
        }
      }
    }
    
    return null;
  }
}

// Export singleton instance
export const userDataService = new UserDataService()