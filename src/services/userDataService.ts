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
import { UserStatus, type UserData, type UserContext, type CustomUserStatus } from '@/types'
import { activityTracker } from '@/services/ActivityTracker'
import { debug } from '@/utils/debug'
import type { RealtimeChannel } from '@supabase/supabase-js'

/**
 * Detect if user is on a mobile device
 */
function detectMobileDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  
  // Check user agent for mobile devices
  const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera || ''
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i
  
  // Also check for touch capability + small screen (tablets with keyboards excluded)
  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
  const isSmallScreen = window.innerWidth <= 768
  
  return mobileRegex.test(userAgent) || (isTouchDevice && isSmallScreen)
}



class UserDataService extends EventTarget {
  private users = new Map<string, UserData>()
  private contexts = new Map<string, UserContext>()
  private currentUserId: string | null = null
  private globalChannel: RealtimeChannel | null = null
  private initialized = false
  
  // Subscription tracking to prevent duplicates
  private pendingSubscriptions = new Set<string>()
  
  // Status management
  private wasManuallySet = false
  private manualStatus: UserStatus | null = null
  private lastAutoStatus: UserStatus = UserStatus.Online
  
  // Cache settings
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes
  private readonly HEARTBEAT_INTERVAL = 30 * 1000 // 30 seconds
  
  // Presence sync debouncing
  private presenceSyncTimeouts = new Map<string, NodeJS.Timeout>()
  private readonly PRESENCE_SYNC_DEBOUNCE = 200 // 200ms debounce for presence sync
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatFailures = 0
  private readonly MAX_HEARTBEAT_FAILURES = 3

  /**
   * Initialize the service for a user
   */
  async initialize(userId: string, username: string, avatarUrl?: string, existingProfile?: any): Promise<void> {
    if (this.initialized && this.currentUserId === userId) return
    
    debug.log('🚀 Initializing User Data Service for:', username)
    
    // IMPORTANT: Await cleanup to prevent race conditions with subscriptions
    await this.cleanup()
    this.currentUserId = userId
    
    // Initialize current user
    await this.initializeCurrentUser(userId, username, avatarUrl, existingProfile)
    
    // Setup global presence channel
    await this.setupGlobalPresence()
    
    // Start heartbeat for core functionality
    this.startHeartbeat()
    
    this.initialized = true
    debug.log('✅ User Data Service initialized')
  }

  /**
   * ✅ PERFORMANCE FIX: Initialize background features after critical path
   * This includes activity tracking which is not needed for initial render
   */
  async initializeBackgroundFeatures(): Promise<void> {
    if (!this.initialized) {
      debug.warn('⚠️ Cannot initialize background features - service not initialized')
      return
    }
    
    // Start activity tracking and lifecycle management
    this.setupActivityTracking()
    debug.log('✅ Background features initialized (activity tracking)')
  }
  
  /**
   * Professional status restoration from localStorage backup
   */
  private getStatusFromLocalStorage(): UserStatus | null {
    try {
      const saved = localStorage.getItem('harmony_user_status')
      if (saved !== null) {
        const statusNumber = parseInt(saved, 10)
        // Updated range to include Invisible (4)
        if (!isNaN(statusNumber) && statusNumber >= 0 && statusNumber <= 4) {
          debug.log('📱 Found status backup in localStorage:', UserStatus[statusNumber])
          return statusNumber as UserStatus
        }
      }
    } catch (error) {
      debug.warn('⚠️ Failed to read status from localStorage:', error)
    }
    return null
  }

  /**
   * Get custom status from localStorage (for persistence across sessions)
   */
  private getCustomStatusFromLocalStorage(): CustomUserStatus | null {
    try {
      const saved = localStorage.getItem('harmony_custom_status')
      if (saved) {
        const customStatus = JSON.parse(saved) as CustomUserStatus
        // Check if expired
        if (customStatus.expiresAt && new Date(customStatus.expiresAt) < new Date()) {
          localStorage.removeItem('harmony_custom_status')
          return null
        }
        return customStatus
      }
    } catch (error) {
      debug.warn('⚠️ Failed to read custom status from localStorage:', error)
    }
    return null
  }

  /**
   * Save custom status to localStorage
   */
  private saveCustomStatusToLocalStorage(customStatus: CustomUserStatus | undefined): void {
    try {
      if (customStatus) {
        localStorage.setItem('harmony_custom_status', JSON.stringify(customStatus))
      } else {
        localStorage.removeItem('harmony_custom_status')
      }
    } catch (error) {
      debug.warn('⚠️ Failed to save custom status to localStorage:', error)
    }
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
    
    debug.log('🎯 Activity tracking started')
  }
  
  /**
   * Handle user activity resumption
   */
  private async handleActivityResumed(): Promise<void> {
    if (!this.currentUserId) return
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) return
    
    debug.log('👋 Activity resumed, current status:', UserStatus[userData.status], 'wasManuallySet:', this.wasManuallySet)
    
    // If status was manually set to Away/Busy/Invisible, respect that choice
    if (this.wasManuallySet) {
      if (this.manualStatus === UserStatus.Away) {
        debug.log('👋 Keeping manual Away status (user preference)')
        return
      }
      if (this.manualStatus === UserStatus.Busy) {
        debug.log('👋 Keeping manual Busy status (user preference)')
        return
      }
      if (this.manualStatus === UserStatus.Invisible) {
        debug.log('👋 Keeping manual Invisible status (user preference)')
        return
      }
    }
    
    // Restore to Online if they were auto-set to Away/Offline due to inactivity
    if (userData.status === UserStatus.Away || userData.status === UserStatus.Offline) {
      debug.log('👋 User active again, restoring to Online (was auto-set to', UserStatus[userData.status], ')')
      try {
        await this.updateCurrentUserStatus(UserStatus.Online, false)
        debug.log('✅ Status restored to Online')
      } catch (error) {
        debug.error('❌ Failed to restore status to Online:', error)
      }
    }
    
    // Reset activity tracking flags
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
      debug.log('⏭️ Skipping auto status change - user manually set to:', UserStatus[userData.status])
      return
    }
    
    debug.log(`😴 Auto-changing status to ${UserStatus[detail.status]} due to ${detail.reason} (${Math.round(detail.inactiveTime / 60000)}min)`)
    
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
  private async initializeCurrentUser(userId: string, username: string, avatarUrl?: string, existingProfile?: any): Promise<void> {
    try {
      // ✅ PERFORMANCE FIX: Use existing profile if provided to avoid duplicate database query
      let profile = existingProfile
      
      if (!profile) {
        // Only query database if profile wasn't already loaded
        debug.log('🔄 Loading user profile from database...')
        const { data: profileData } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url, banner_url, bio, color, status, domain, is_local, updated_at, created_at')
          .eq('id', userId)
          .single()
        profile = profileData
      } else {
        debug.log('✅ Using existing profile data, skipping database query')
      }
      
      if (profile) {
        // Professional status handling: database is truth, localStorage is backup
        // IMPORTANT: Active users should be Online by default, not Offline
        let finalStatus = UserStatus.Online // Always default to Online for active users
        
        // Primary: Use database status if it exists and is valid AND not offline
        if (profile.status !== null && profile.status !== undefined) {
          // If user was explicitly set to Away/Busy/Invisible, preserve that
          if (profile.status === UserStatus.Away || profile.status === UserStatus.Busy || profile.status === UserStatus.Invisible) {
            finalStatus = profile.status
            debug.log('✅ Preserving user-set status from database:', UserStatus[finalStatus])
          } else if (profile.status === UserStatus.Online) {
            finalStatus = UserStatus.Online
            debug.log('✅ Status loaded from database:', UserStatus[finalStatus])
          } else {
            // User was offline in database, but they're actively using the app now
            finalStatus = UserStatus.Online
            debug.log('🔄 User was offline in DB but is now active, setting to Online')
            
            // Update database to reflect they're now online
            try {
              await supabase
                .from('profiles')
                .update({ status: UserStatus.Online })
                .eq('id', userId)
              debug.log('💾 Updated database to show user as Online')
            } catch (syncError) {
              debug.warn('⚠️ Failed to update online status in database:', syncError)
            }
          }
        } else {
          // No status in database, try localStorage backup for Away/Busy/Invisible only
          const backupStatus = this.getStatusFromLocalStorage()
          if (backupStatus === UserStatus.Away || backupStatus === UserStatus.Busy || backupStatus === UserStatus.Invisible) {
            finalStatus = backupStatus
            debug.log('🔄 Using user-preferred status from localStorage backup:', UserStatus[finalStatus])
            
            // Sync backup to database for consistency
            try {
              await supabase
                .from('profiles')
                .update({ status: finalStatus })
                .eq('id', userId)
              debug.log('💾 Synced localStorage status to database')
            } catch (syncError) {
              debug.warn('⚠️ Failed to sync status to database:', syncError)
            }
          } else {
            // Default to Online - user is actively using the app
            debug.log('🆕 No valid status found, defaulting to Online (user is active)')
          }
        }
        
        const userData: UserData = {
          id: profile.id,
          username: profile.username || username,
          displayName: profile.display_name || profile.username || username,
          avatarUrl: profile.avatar_url || avatarUrl,
          bannerUrl: profile.banner_url,
          bio: profile.bio,
          color: profile.color,
          domain: profile.domain || 'har.mony.lol',
          isLocal: profile.is_local || false,
          status: finalStatus,
          customStatus: undefined, // Will be loaded separately if exists
          isOnline: true,
          isMobile: detectMobileDevice(), // Track if user is on mobile
          lastSeen: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
          lastCacheUpdate: new Date().toISOString(),
          createdAt: profile.created_at || new Date().toISOString(),
          source: 'database'
        }
        
        this.users.set(userId, userData)
        debug.log('✅ Current user initialized:', userData.displayName, 'Final Status:', UserStatus[finalStatus])
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
          customStatus: undefined,
          isOnline: true,
          isMobile: detectMobileDevice(),
          isLocal: true,
          lastSeen: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
          lastCacheUpdate: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          source: 'cache'
        }
        
        this.users.set(userId, userData)
        debug.log('✅ Current user initialized with minimal data:', username, 'Status:', UserStatus[initialStatus])
      }
      
      this.emitEvent('user-updated', { userId })
      
    } catch (error) {
      debug.error('❌ Failed to initialize current user:', error)
      throw error
    }
  }
  
  /**
   * Setup global presence channel for cross-context online/offline tracking
   * 
   * SIMPLIFIED: Only track once on subscription, no repeated tracking.
   * The presence events are logged but we don't react aggressively to them.
   */
  private async setupGlobalPresence(): Promise<void> {
    if (!this.currentUserId) return
    
    // 🌐 GLOBAL PRESENCE SYSTEM - Keep it simple
    this.globalChannel = supabase.channel('harmony-global-presence')
      .on('presence', { event: 'sync' }, () => {
        // Just update our local state, don't log spam
        this.handleGlobalPresenceSync()
      })
      .on('presence', { event: 'join' }, ({ newPresences }: { newPresences: any[] }) => {
        this.handleGlobalPresenceJoin(newPresences)
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }: { leftPresences: any[] }) => {
        this.handleGlobalPresenceLeave(leftPresences)
      })
      .subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED') {
          debug.log('✅ Global presence channel connected')
          // Track ONCE on subscription - that's all we need
          await this.trackCurrentUserGlobally()
        }
      })
  }
  
  /**
   * Track current user in global presence
   * 
   * IMPORTANT: This should only be called on:
   * - Initial connection
   * - Status changes
   * - Profile updates (avatar, color, etc.)
   * 
   * DO NOT call this on heartbeat or route changes - that causes churn!
   */
  private async trackCurrentUserGlobally(): Promise<void> {
    if (!this.globalChannel || !this.currentUserId) return
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) return
    
    // Handle invisible status - untrack from presence
    if (userData.status === UserStatus.Offline || userData.status === UserStatus.Invisible) {
      try {
        await this.globalChannel.untrack()
      } catch {
        // Ignore untrack errors
      }
      return
    }
    
    try {
      await this.globalChannel.track({
        user_id: this.currentUserId,
        username: userData.username,
        display_name: userData.displayName,
        avatar_url: userData.avatarUrl,
        color: userData.color,
        status: userData.status,
        custom_status: userData.customStatus,
        is_mobile: userData.isMobile,
        online_at: new Date().toISOString()
      })
      
      debug.log(`✅ User ${this.currentUserId} tracked globally with status: ${UserStatus[userData.status]}`)
    } catch (error) {
      debug.warn('⚠️ Global presence track failed:', error)
    }
  }
  
  /**
   * Handle global presence sync - update basic online/offline status
   * Kept minimal to avoid churn
   */
  private handleGlobalPresenceSync(): void {
    if (!this.globalChannel) return
    
    const state = this.globalChannel.presenceState()
    const userCount = Object.keys(state).length
    
    // Track which users are globally online
    const globallyOnlineUserIds = new Set<string>()
    
    Object.values(state).forEach((presences: any[]) => {
      presences.forEach((presence: any) => {
        if (presence.user_id) {
          globallyOnlineUserIds.add(presence.user_id)
          this.updateUserFromGlobalPresence(presence.user_id, presence)
        }
      })
    })
    
    // Mark users not in global presence as offline (but preserve their status if it's not Online)
    this.users.forEach((userData, userId) => {
      if (userId !== this.currentUserId && !globallyOnlineUserIds.has(userId)) {
        // Only update isOnline, don't change status unless it was Online
        if (userData.isOnline) {
          userData.isOnline = false
          userData.lastSeen = new Date().toISOString()
          
          // Only change status to Offline if they were Online (preserve Away/Busy)
          if (userData.status === UserStatus.Online) {
            userData.status = UserStatus.Offline
          }
          
          this.emitEvent('user-updated', { userId })
        }
      }
    })
    
    debug.log(`✅ Global presence: ${globallyOnlineUserIds.size} users online globally`)
  }
  
  /**
   * Handle users joining global presence
   */
  private handleGlobalPresenceJoin(newPresences: any[]): void {
    newPresences.forEach((presence: any) => {
      if (presence.user_id) {
        this.updateUserFromGlobalPresence(presence.user_id, presence)
        // Reduce log spam - don't log every join
      }
    })
  }
  
  /**
   * Handle users leaving global presence
   */
  private handleGlobalPresenceLeave(leftPresences: any[]): void {
    leftPresences.forEach((presence: any) => {
      if (presence.user_id && presence.user_id !== this.currentUserId) {
        const userData = this.users.get(presence.user_id)
        if (userData) {
          userData.isOnline = false
          userData.lastSeen = new Date().toISOString()
          
          // Only change status to Offline if they were Online (preserve Away/Busy)
          if (userData.status === UserStatus.Online) {
            userData.status = UserStatus.Offline
          }
          
          // Force UI updates for global presence changes
          this.emitEvent('user-updated', { userId: presence.user_id })
          this.emitEvent('global-presence-updated', { userId: presence.user_id, isOnline: false })
        }
      }
    })
  }
  
  /**
   * Update user data from global presence
   */
  private updateUserFromGlobalPresence(userId: string, presence: any): void {
    const existing = this.users.get(userId)
    const userStatus = presence.status ?? existing?.status ?? UserStatus.Online
    
    // 🎯 PROFESSIONAL INVISIBLE IMPLEMENTATION  
    // If user has status set to Offline (invisible), don't show them as online
    // This should never happen due to trackCurrentUserGlobally() checks, but handle it as safety net
    if (userStatus === UserStatus.Offline) {
      debug.log(`👻 User ${userId} has offline status in global presence - skipping update (they should be invisible)`)
      // If they exist in our cache, mark them as offline
      if (existing) {
        existing.isOnline = false
        existing.lastSeen = presence.online_at || new Date().toISOString()
        this.emitEvent('user-updated', { userId })
        this.emitEvent('global-presence-updated', { userId, isOnline: false })
      }
      return
    }
    
    const userData: UserData = {
      id: userId,
      username: presence.username || existing?.username || 'Unknown',
      displayName: presence.display_name || presence.username || existing?.displayName || 'Unknown',
      avatarUrl: presence.avatar_url || existing?.avatarUrl,
      bannerUrl: existing?.bannerUrl,
      bio: existing?.bio,
      // 🎨 Use color from presence if provided (real-time color sync)
      color: presence.color || existing?.color,
      domain: existing?.domain,
      isLocal: existing?.isLocal || false,
      status: userStatus,
      customStatus: presence.custom_status || existing?.customStatus,
      isOnline: true, // They're in global presence with a visible status, so they're online
      isMobile: presence.is_mobile || existing?.isMobile || false,
      lastSeen: presence.online_at || new Date().toISOString(),
      lastHeartbeat: presence.online_at || new Date().toISOString(),
      lastCacheUpdate: new Date().toISOString(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      source: 'presence' // Global presence is still presence source
    }
    
    this.users.set(userId, userData)
    
    // Force UI updates for global presence changes
    this.emitEvent('user-updated', { userId })
    this.emitEvent('global-presence-updated', { userId, isOnline: true })
  }
  
  // Global presence sync handlers removed - we now only track context-specific users
  
  /**
   * Update user data from presence
   */
  private updateUserFromPresence(userId: string, presence: any): void {
    const existing = this.users.get(userId)
    const userStatus = presence.status ?? existing?.status ?? UserStatus.Online
    
    // 🎯 PROFESSIONAL INVISIBLE IMPLEMENTATION  
    // If user has status set to Offline (invisible), don't show them as online
    // This should never happen due to untrackFromAllPresenceChannels() calls, but handle it as safety net
    if (userStatus === UserStatus.Offline) {
      debug.log(`👻 User ${userId} has offline status in context presence - skipping update (they should be invisible)`)
      // If they exist in our cache, mark them as offline
      if (existing) {
        existing.isOnline = false
        existing.lastSeen = presence.online_at || new Date().toISOString()
        this.emitEvent('user-updated', { userId })
      }
      return
    }
    
    const userData: UserData = {
      id: userId,
      username: presence.username || existing?.username || 'Unknown',
      displayName: presence.display_name || presence.username || existing?.displayName || 'Unknown',
      avatarUrl: presence.avatar_url || existing?.avatarUrl,
      bannerUrl: presence.banner_url || existing?.bannerUrl,
      bio: existing?.bio,
      // 🎨 Use color from presence if provided (real-time color sync)
      color: presence.color || existing?.color,
      domain: existing?.domain || 'har.mony.lol',
      isLocal: existing?.isLocal || false,
      status: userStatus,
      customStatus: presence.custom_status || existing?.customStatus,
      isOnline: true, // They're in context presence with a visible status, so they're online
      isMobile: presence.is_mobile || existing?.isMobile || false,
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
   * Start heartbeat for internal health tracking only
   * NOTE: Heartbeat should NOT call presence track - that causes churn
   * Presence is tracked once on connection, not repeatedly
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    
    this.heartbeatTimer = setInterval(async () => {
      if (this.currentUserId) {
        const userData = this.users.get(this.currentUserId)
        if (userData) {
          // Just update internal timestamp, don't call trackCurrentUserGlobally()
          // Presence tracking on heartbeat causes join/leave churn
          userData.lastHeartbeat = new Date().toISOString()
        }
      }
    }, this.HEARTBEAT_INTERVAL)
  }
  
  /**
   * Handle connection loss - set offline status
   */
  private async handleConnectionLost(): Promise<void> {
    if (!this.currentUserId) return
    
    debug.log('📡 Connection lost - setting user offline')
    
    try {
      // Set offline status (this will be automatic, not manual)
      await this.updateCurrentUserStatus(UserStatus.Offline, false)
    } catch (error) {
      debug.error('Failed to set offline status on connection loss:', error)
    }
  }
  
  /**
   * Subscribe to a context (server, DM, profile, friends)
   */
  async subscribeToContext(contextId: string, type: 'server' | 'dm' | 'profile' | 'friends', userIds: string[]): Promise<void> {
    // Check if already subscribed to this context
    if (this.contexts.has(contextId)) {
      debug.log(`⚠️ Already subscribed to ${type} context:`, contextId, '- skipping duplicate subscription')
      return
    }
    
    // Check if subscription is already in progress
    if (this.pendingSubscriptions.has(contextId)) {
      debug.log(`⚠️ Subscription already in progress for ${type} context:`, contextId, '- skipping duplicate')
      return
    }
    
    // Mark subscription as in progress
    this.pendingSubscriptions.add(contextId)
    
    try {
      debug.log(`🔄 Subscribing to ${type} context:`, contextId, `(${userIds.length} users)`)
      
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
      
      debug.log(`✅ Subscribed to ${type} context:`, contextId)
    } finally {
      // Remove from pending subscriptions
      this.pendingSubscriptions.delete(contextId)
    }
  }
  
  /**
   * Setup server-specific presence channel
   */
  private async setupServerPresence(serverId: string, userIds: string[]): Promise<void> {
    const channelName = `server-presence:${serverId}`
    debug.log('🔄 Setting up presence for server:', serverId, 'with', userIds.length, 'users')
    
    const channel = supabase.channel(channelName)
      .on('presence', { event: 'sync' }, () => {
        debug.log('🔄 Presence sync for server:', serverId)
        this.handleServerSync(serverId)
      })
      .on('presence', { event: 'join' }, ({ newPresences }: { newPresences: any[] }) => {
        // debug.log('👋 User(s) joined presence in server:', serverId, newPresences)
        this.handleServerUserJoin(serverId, newPresences)
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }: { leftPresences: any[] }) => {
        // debug.log('👋 User(s) left presence in server:', serverId, leftPresences)
        this.handleServerUserLeave(serverId, leftPresences)
      })
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
        debug.log(`📡 Server presence subscription status for ${serverId}:`, status)
        if (status === 'SUBSCRIBED') {
          // debug.log(`✅ Server presence connected: ${serverId}`)
          
          // Track current user if they're in this server
          if (this.currentUserId && userIds.includes(this.currentUserId)) {
            await this.trackCurrentUserInServer(channel, serverId)
          }
        } else if (status === 'CHANNEL_ERROR') {
          debug.error(`❌ Server presence error for ${serverId}, retrying...`)
          setTimeout(() => this.setupServerPresence(serverId, userIds), 5000)
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
    
    // 🎯 PROFESSIONAL INVISIBLE IMPLEMENTATION
    // If user has set status to Offline (0), they should be invisible to others
    // Don't track presence at all - this is the cleanest approach
    if (userData.status === UserStatus.Offline) {
      debug.log(`👻 User ${this.currentUserId} is invisible (status: Offline) - not tracking presence in server ${serverId}`)
      return
    }
    
    // 👻 INVISIBLE STATUS: Don't track presence if user is invisible
    if (userData.status === UserStatus.Invisible) {
      debug.log(`👻 User ${this.currentUserId} is Invisible - not tracking in server ${serverId}`)
      await channel.untrack()
      return
    }
    
    await channel.track({
      user_id: this.currentUserId,
      username: userData.username,
      display_name: userData.displayName,
      avatar_url: userData.avatarUrl,
      banner_url: userData.bannerUrl,
      color: userData.color,
      status: userData.status,
      custom_status: userData.customStatus,
      is_mobile: userData.isMobile,
      server_id: serverId,
      online_at: new Date().toISOString()
    })
    
    debug.log(`✅ User ${this.currentUserId} presence tracked in server ${serverId} with status: ${UserStatus[userData.status]}${userData.isMobile ? ' (mobile)' : ''}`)
  }
  
  /**
   * Handle server presence sync with debouncing to prevent excessive syncs
   */
  private handleServerSync(serverId: string): void {
    // ✅ PERFORMANCE FIX: Debounce presence sync to prevent double syncs
    const existingTimeout = this.presenceSyncTimeouts.get(serverId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }
    
    this.presenceSyncTimeouts.set(serverId, setTimeout(() => {
      this.executeServerSync(serverId)
      this.presenceSyncTimeouts.delete(serverId)
    }, this.PRESENCE_SYNC_DEBOUNCE))
  }
  
  /**
   * Execute the actual server sync (separated for debouncing)
   */
  private executeServerSync(serverId: string): void {
    const context = this.contexts.get(serverId)
    if (!context?.channel) {
      debug.warn('⚠️ No context or channel found for server sync:', serverId)
      return
    }
    
    const state = context.channel.presenceState()
    debug.log(`📡 Server ${serverId} presence sync:`, Object.keys(state).length, 'presence keys')
    debug.log('📊 Full presence state:', state)
    
    // Track which users are online based on presence
    const onlineUserIds = new Set<string>()
    
    Object.entries(state).forEach(([presenceKey, presences]) => {
      debug.log(`👤 Presence key ${presenceKey}:`, presences)
      if (Array.isArray(presences) && presences.length > 0) {
        const presence = presences[0] as any
        if (presence.user_id) {
          onlineUserIds.add(presence.user_id)
          this.updateUserFromPresence(presence.user_id, presence)
        }
      }
    })
    
    // Mark users as offline if they're not in presence
    const contextUsers = Array.from(context.userIds)
    contextUsers.forEach(userId => {
      if (!onlineUserIds.has(userId)) {
        const userData = this.users.get(userId)
        if (userData && userData.isOnline) {
          debug.log(`🔴 Marking user ${userId} as offline (not in presence)`)
          userData.isOnline = false
          userData.status = UserStatus.Offline
          userData.lastSeen = new Date().toISOString()
          userData.lastCacheUpdate = new Date().toISOString()
          this.emitEvent('user-updated', { userId })
        }
      }
    })
    
    debug.log(`✅ Sync complete: ${onlineUserIds.size} online, ${contextUsers.length - onlineUserIds.size} offline`)
  }
  
  /**
   * Handle server user join
   */
  private handleServerUserJoin(serverId: string, newPresences: any[]): void {
    newPresences.forEach(presence => {
      this.updateUserFromPresence(presence.user_id, presence)
      debug.log(`👋 User joined server ${serverId}:`, presence.display_name || presence.username)
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
        userData.status = 0 // Set to Offline
        this.emitEvent('user-updated', { userId: presence.user_id })
      }
      debug.log(`👋 User left server ${serverId}:`, presence.display_name || presence.username)
    })
  }

  /**
   * Handle real-time server membership join
   */
  private async handleServerMemberJoin(serverId: string, payload: any): Promise<void> {
    const newUserId = payload.new.user_id
    debug.log(`👤 New member joined server ${serverId}:`, newUserId)
    
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
    debug.log(`👋 Member left server ${serverId}:`, leftUserId)
    
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
    
    debug.log(`🔄 Profile update received for user ${userId} in server ${serverId}:`, {
      display_name: updatedProfile.display_name,
      avatar_url: updatedProfile.avatar_url,
      banner_url: updatedProfile.banner_url,
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
      if (updatedProfile.banner_url !== undefined) {
        userData.bannerUrl = updatedProfile.banner_url
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
      
      debug.log(`✅ Updated user data for ${userData.displayName} in server ${serverId}`)
    } else {
      // If we don't have the user data, load it fresh from the database
      debug.log(`🔄 Loading fresh user data for ${userId} after profile update`)
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
    
    debug.log(`📡 Received profile update broadcast for user ${userId} in server ${serverId}:`, profileUpdates)
    
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
      
      debug.log(`✅ Updated user data for ${userData.displayName} from broadcast`)
    } else {
      // If we don't have the user data, load it fresh from the database
      debug.log(`🔄 Loading fresh user data for ${userId} after profile broadcast`)
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
    
    debug.log(`🔄 Loading user data for ${missingUserIds.length} users`)

    try {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, banner_url, bio, color, status, domain, updated_at, created_at, is_local')
        .in('id', missingUserIds)
      
      if (profiles) {
        profiles.forEach((profile: any) => {
          const userData: UserData = {
            id: profile.id,
            username: profile.username || 'Unknown',
            displayName: profile.display_name || profile.username || 'Unknown',
            avatarUrl: profile.avatar_url,
            bannerUrl: profile.banner_url,
            bio: profile.bio,
            color: profile.color,
            domain: profile.domain || 'har.mony.lol',
            isLocal: profile.is_local || false,
            status: profile.status ?? UserStatus.Offline,
            customStatus: undefined, // Would need separate table for custom status
            isOnline: false, // Will be updated by presence
            isMobile: false, // Will be updated by presence
            lastSeen: profile.updated_at || new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            lastCacheUpdate: new Date().toISOString(),
            createdAt: profile.created_at || new Date().toISOString(),
            updatedAt: profile.updated_at,
            source: 'database'
          }
          
          this.users.set(profile.id, userData)
        })
        
        debug.log(`✅ Loaded ${profiles.length} user profiles from database`)
      }
      
    } catch (error) {
      debug.error('❌ Failed to load user data:', error)
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
      banner_url: userData.bannerUrl,
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
    
    debug.log('🔄 Updating current user status to:', UserStatus[status], isManual ? '(manual)' : '(automatic)')
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) throw new Error('Current user data not found')
    
    // Track manual status changes
    if (isManual) {
      // If user manually sets to Away, Busy, or Invisible, remember that choice
      if (status === UserStatus.Away || status === UserStatus.Busy || status === UserStatus.Invisible) {
        this.wasManuallySet = true
        this.manualStatus = status
        debug.log('📌 Status manually set to:', UserStatus[status])
      } 
      // If user manually sets to Online, clear the manual flag (back to automatic mode)
      else if (status === UserStatus.Online) {
        this.wasManuallySet = false
        this.manualStatus = null
        debug.log('📌 Status manually set to Online - clearing manual flag')
      }
      // Note: activityTracker would be called here if available
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
      
      debug.log('✅ Status verified in database:', UserStatus[status])
      
      // Update all presence channels
      await this.updatePresenceStatus(status)
      
      // Save to localStorage as professional backup (like Discord/Slack)
      try {
        localStorage.setItem('harmony_user_status', status.toString())
        debug.log('💾 Status backed up to localStorage')
      } catch (localStorageError) {
        debug.warn('⚠️ Failed to backup status to localStorage:', localStorageError)
      }
      
      this.emitEvent('status-changed', { userId: this.currentUserId, status })
      debug.log('✅ Status updated successfully to:', UserStatus[status])
      
    } catch (error) {
      debug.error('❌ Failed to update status:', error)
      // Note: local change already applied, database update failed
      throw error
    }
  }

  /**
   * Set custom status (Discord-style "Playing X", "Listening to Y", etc.)
   * @param customStatus - The custom status to set, or undefined to clear
   */
  async setCustomStatus(customStatus: CustomUserStatus | undefined): Promise<void> {
    if (!this.currentUserId) throw new Error('No current user')
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) throw new Error('Current user data not found')
    
    debug.log('🎭 Setting custom status:', customStatus?.text || '(clearing)')
    
    // Update local data
    userData.customStatus = customStatus
    userData.lastCacheUpdate = new Date().toISOString()
    
    // Save to localStorage for persistence
    this.saveCustomStatusToLocalStorage(customStatus)
    
    // Update presence to broadcast custom status
    await this.updatePresenceStatus(userData.status)
    
    this.emitEvent('custom-status-changed', { userId: this.currentUserId, customStatus })
    debug.log('✅ Custom status updated')
  }

  /**
   * Clear custom status
   */
  async clearCustomStatus(): Promise<void> {
    await this.setCustomStatus(undefined)
  }

  /**
   * Get current user's custom status
   */
  getCustomStatus(): CustomUserStatus | undefined {
    if (!this.currentUserId) return undefined
    return this.users.get(this.currentUserId)?.customStatus
  }

  /**
   * Check if current user is on mobile
   */
  isCurrentUserMobile(): boolean {
    if (!this.currentUserId) return false
    return this.users.get(this.currentUserId)?.isMobile || false
  }
  
  /**
   * Update status in presence channels
   * SIMPLIFIED: Only update if going invisible (untrack) 
   * For visible statuses, the initial track is sufficient
   */
  private async updatePresenceStatus(status: UserStatus): Promise<void> {
    // 👻 INVISIBLE STATUS: User should appear offline to everyone
    if (status === UserStatus.Invisible) {
      debug.log(`👻 User going Invisible - untracking from all presence channels`)
      await this.untrackFromAllPresenceChannels()
      return
    }
    
    // For visible statuses, we rely on the initial track that happened on channel subscription
    // Calling track() again causes join/leave churn in Supabase
    debug.log(`🌟 Status updated to: ${UserStatus[status]}`)
  }
  
  /**
   * Update current user profile data and broadcast to relevant contexts only
   * This is context-aware - only users who can see this user will get the update
   */
  async updateCurrentUserProfile(profileData: {
    displayName?: string
    avatarUrl?: string
    bannerUrl?: string
    bio?: string
    color?: string
    username?: string
  }): Promise<void> {
    if (!this.currentUserId) throw new Error('No current user')
    
    debug.log('🔄 Updating current user profile:', profileData)
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) throw new Error('Current user data not found')
    
    // Update local data immediately for instant UI feedback
    if (profileData.displayName !== undefined) userData.displayName = profileData.displayName
    if (profileData.avatarUrl !== undefined) userData.avatarUrl = profileData.avatarUrl
    if (profileData.bannerUrl !== undefined) userData.bannerUrl = profileData.bannerUrl
    if (profileData.bio !== undefined) userData.bio = profileData.bio
    if (profileData.color !== undefined) userData.color = profileData.color
    if (profileData.username !== undefined) userData.username = profileData.username
    userData.lastCacheUpdate = new Date().toISOString()
    
    try {
      // Broadcast profile changes to relevant contexts only (context-aware)
      await this.broadcastProfileToContexts(profileData)
      
      // Note: We don't re-track globally here anymore
      // The initial track is sufficient, and re-tracking causes churn
      // Profile broadcasts handle the update propagation
      
      this.emitEvent('user-updated', { userId: this.currentUserId })
      debug.log('✅ Profile updated and broadcast to relevant contexts')
      
    } catch (error) {
      debug.error('❌ Failed to broadcast profile update:', error)
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
    bannerUrl?: string
    bio?: string
    color?: string
    username?: string
  }): Promise<void> {
    if (!this.currentUserId) return
    
    debug.log(`🔄 Broadcasting profile update to ${this.contexts.size} contexts`)
    
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
          
          debug.log(`📡 Profile broadcast to ${context.type} context: ${context.id}`)
        } catch (error) {
          debug.error(`❌ Failed to broadcast profile to context ${context.id}:`, error)
        }
      }
    }
    
    debug.log(`📡 Profile broadcast completed to ${this.contexts.size} context channels`)
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
    debug.log('✅ Unsubscribed from context:', contextId)
  }
  
  /**
   * Emit custom events
   */
  private emitEvent(type: string, data: any): void {
    this.dispatchEvent(new CustomEvent(type, { detail: data }))
  }
  
  /**
   * Refresh global presence - now a no-op
   * 
   * NOTE: This used to re-track on route changes, but that caused churn.
   * Once you're tracked on initial connection, you stay tracked.
   * Supabase presence maintains connection automatically.
   * Only actual status/profile changes should update presence.
   */
  async refreshGlobalPresence(): Promise<void> {
    // No-op - presence is maintained by Supabase automatically
    // Calling trackCurrentUserGlobally() on route changes causes join/leave churn
  }
  
  /**
   * Cleanup and reset
   */
  async cleanup(): Promise<void> {
    debug.log('🧹 Cleaning up User Data Service')
    
    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    
    // Clear any pending presence sync timeouts
    for (const timeout of this.presenceSyncTimeouts.values()) {
      clearTimeout(timeout)
    }
    this.presenceSyncTimeouts.clear()
    
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
    
    debug.log('✅ User Data Service cleaned up')
  }
  
  /**
   * Force refresh of all data
   */
  async refresh(): Promise<void> {
    debug.log('🔄 Refreshing all user data')
    
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
    debug.log('✅ User data refreshed')
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

  /**
   * Manually trigger presence sync for a server context (useful for debugging or forcing updates)
   */
  async triggerPresenceSync(contextId: string): Promise<void> {
    debug.log('🔄 Manually triggering presence sync for context:', contextId)
    
    const context = this.contexts.get(contextId)
    if (!context?.channel) {
      debug.warn('⚠️ No context or channel found for manual sync:', contextId)
      return
    }
    
    // Force a presence sync
    this.handleServerSync(contextId)
    
    debug.log('✅ Manual presence sync completed for:', contextId)
  }
  
  /**
   * Get current online status for all users in a context
   */
  getOnlineUsersInContext(contextId: string): { online: UserData[], offline: UserData[] } {
    const context = this.contexts.get(contextId)
    if (!context) {
      return { online: [], offline: [] }
    }
    
    const users = Array.from(context.userIds)
      .map(id => this.users.get(id))
      .filter(Boolean) as UserData[]
    
    const online = users.filter(user => user.isOnline)
    const offline = users.filter(user => !user.isOnline)
    
    return { online, offline }
  }
  
  /**
   * Untrack current user from all presence channels (for invisible status)
   */
  private async untrackFromAllPresenceChannels(): Promise<void> {
    if (!this.currentUserId) return
    
    // Untrack from global presence
    if (this.globalChannel) {
      try {
        await this.globalChannel.untrack()
        debug.log('👻 Untracked from global presence channel')
      } catch (error) {
        debug.warn('⚠️ Failed to untrack from global presence:', error)
      }
    }
    
    // Untrack from all context channels
    for (const context of this.contexts.values()) {
      if (context.channel) {
        try {
          await context.channel.untrack()
          debug.log(`👻 Untracked from ${context.type} context: ${context.id}`)
        } catch (error) {
          debug.warn(`⚠️ Failed to untrack from ${context.type} context ${context.id}:`, error)
        }
      }
    }
    
    debug.log('👻 User is now invisible to all other users')
  }
}

// Export singleton instance
export const userDataService = new UserDataService()