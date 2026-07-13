// Single source of truth for user data: fetching/caching, realtime presence sync, context-based subscriptions.

import { supabase } from '@/supabase'
import { UserStatus, type UserData, type UserContext, type CustomUserStatus, type DisplayNamePart } from '@/types'
import { activityTracker } from '@/services/ActivityTracker'
import { debug } from '@/utils/debug'
import { userStorage } from '@/utils/userScopedStorage'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { loadEmojiData, isLoaded as unifiedEmojiLoaded } from '@/services/unifiedEmojiService'
import { realtimeApiService } from '@/services/RealtimeApiService'
import {
  createShortcodeRegex,
  parseEmojiShortcodeToken,
  findCustomEmojiInCache,
  getDbCachedEmoji,
  ensureCustomEmojisResolved,
  isDbMissCached,
  resolveUnifiedEmojiDisplay,
} from '@/services/emojiShortcodeResolver'

const EMOJI_SHORTCODE_TEST_REGEX = createShortcodeRegex()

/**
 * Detect if user is on a mobile device
 * Touch-enabled desktops/laptops with a mouse are NOT considered mobile
 */
function detectMobileDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  
  // Check user agent for mobile devices
  const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera || ''
  const mobileRegex = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|CriOS/i
  
  // Small screen is definitely mobile
  const hasSmallScreen = window.innerWidth <= 768
  
  // Touch-only device (no mouse/fine pointer) is mobile
  const isTouchOnlyDevice = 'ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches
  
  return mobileRegex.test(userAgent) || hasSmallScreen || isTouchOnlyDevice
}

/**
 * Server member lists larger than this hydrate online members first and
 * backfill the remaining (offline) profiles in the background, in chunks of
 * this size.
 */
const PROFILE_BACKFILL_CHUNK = 30

/** Bulk member-list hydration - omit federation_metadata (large JSONB, rarely needed). */
const PROFILE_BULK_SELECT =
  'id, username, web_handle, display_name, avatar_url, banner_url, bio, color, status, domain, updated_at, created_at, is_local, custom_status, is_admin, is_moderator'

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
  private readonly HEARTBEAT_INTERVAL = 60 * 1000 // 60 seconds

  // Coalescing batch loader (DataLoader pattern). Collapses bursts of single-id
  // profile loads - e.g. one <DisplayName> per message/conversation - into a
  // single id=in.(...) query instead of N separate requests.
  private userLoadQueue = new Set<string>()
  private userLoadBatchPromise: Promise<void> | null = null

  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatFailures = 0
  private readonly MAX_HEARTBEAT_FAILURES = 3
  private customStatusExpiryTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Initialize the service for a user
   */
  async initialize(userId: string, username: string, avatarUrl?: string, existingProfile?: any): Promise<void> {
    if (this.initialized && this.currentUserId === userId) return
    
    debug.log('Initializing User Data Service for:', username)
    
    // Await cleanup to prevent race conditions with subscriptions
    await this.cleanup()
    this.currentUserId = userId

    // Load unified emoji data before resolving display names so shortcodes and
    // unicode emojis render correctly on first paint (uses IndexedDB cache, fast)
    if (!unifiedEmojiLoaded.value) {
      try { await loadEmojiData() } catch { /* non-critical */ }
    }
    
    await this.initializeCurrentUser(userId, username, avatarUrl, existingProfile)
    
    await this.setupGlobalPresence()
    
    this.startHeartbeat()
    
    this.initialized = true
    debug.log('User Data Service initialized')
  }

  /**
   * This includes activity tracking which is not needed for initial render
   */
  async initializeBackgroundFeatures(): Promise<void> {
    if (!this.initialized) {
      debug.warn('Cannot initialize background features - service not initialized')
      return
    }
    
    this.setupActivityTracking()
    debug.log('Background features initialized (activity tracking)')
  }
  
  /**
   * Professional status restoration from localStorage backup
   */
  private getStatusFromLocalStorage(): UserStatus | null {
    try {
      const saved = userStorage.getItem('user_status')
      if (saved !== null) {
        const statusNumber = parseInt(saved, 10)
        if (!isNaN(statusNumber) && statusNumber >= 0 && statusNumber <= 4) {
          debug.log('Found status backup in localStorage:', UserStatus[statusNumber])
          return statusNumber as UserStatus
        }
      }
    } catch (error) {
      debug.warn('Failed to read status from localStorage:', error)
    }
    return null
  }

  private getManualStatusFlag(): { wasManuallySet: boolean, manualStatus: UserStatus | null } {
    try {
      const saved = userStorage.getItem('manual_status_flag')
      if (saved) {
        const parsed = JSON.parse(saved)
        if (parsed.wasManuallySet && parsed.manualStatus !== null && parsed.manualStatus !== undefined) {
          return { wasManuallySet: true, manualStatus: parsed.manualStatus as UserStatus }
        }
      }
    } catch (_) { /* non-critical */ }
    return { wasManuallySet: false, manualStatus: null }
  }

  private saveManualStatusFlag(): void {
    try {
      userStorage.setItem('manual_status_flag', JSON.stringify({
        wasManuallySet: this.wasManuallySet,
        manualStatus: this.manualStatus
      }))
    } catch (_) { /* non-critical */ }
  }

  private clearManualStatusFlag(): void {
    try {
      userStorage.removeItem('manual_status_flag')
    } catch (_) { /* non-critical */ }
  }

  /**
   * Get custom status from localStorage (for persistence across sessions)
   */
  private getCustomStatusFromLocalStorage(): CustomUserStatus | null {
    try {
      const saved = userStorage.getItem('custom_status')
      if (saved) {
        const customStatus = JSON.parse(saved) as CustomUserStatus
        if (customStatus.expiresAt && new Date(customStatus.expiresAt) < new Date()) {
          userStorage.removeItem('custom_status')
          return null
        }
        return customStatus
      }
    } catch (error) {
      debug.warn('Failed to read custom status from localStorage:', error)
    }
    return null
  }

  /**
   * Save custom status to localStorage
   */
  private saveCustomStatusToLocalStorage(customStatus: CustomUserStatus | undefined): void {
    try {
      if (customStatus) {
        userStorage.setItem('custom_status', JSON.stringify(customStatus))
      } else {
        userStorage.removeItem('custom_status')
      }
    } catch (error) {
      debug.warn('Failed to save custom status to localStorage:', error)
    }
  }

  /**
   * Parse custom_status JSONB from database to CustomUserStatus format
   */
  private parseCustomStatus(customStatusJson: any): CustomUserStatus | undefined {
    if (!customStatusJson) return undefined

    try {
      // If it's already an object (from JSONB), use it directly
      // If it's a string, parse it
      const status = typeof customStatusJson === 'string' 
        ? JSON.parse(customStatusJson) 
        : customStatusJson

      if (status.expires_at || status.expiresAt) {
        const expiresAt = status.expires_at || status.expiresAt
        if (new Date(expiresAt) < new Date()) {
          return undefined // Status has expired
        }
      }

      const customStatus: CustomUserStatus = {
        text: status.text || undefined,
        emoji: status.emoji || undefined,
        emoji_url: status.emoji_url || undefined,
        type: status.type || 'custom',
        expiresAt: status.expires_at || status.expiresAt || undefined,
        details: status.details || undefined,
        state: status.state || undefined,
        setAt: status.set_at || status.setAt || undefined,
      }

      // Return undefined if status is empty (allow activity-only, e.g. "Playing" with no text)
      const hasContent = !!(customStatus.text || customStatus.emoji || customStatus.emoji_url)
      const hasActivity = customStatus.type && customStatus.type !== 'custom'
      if (!hasContent && !hasActivity) {
        return undefined
      }

      return customStatus
    } catch (error) {
      debug.warn('Failed to parse custom status:', error)
      return undefined
    }
  }
  
  /**
   * Setup activity tracking and lifecycle management
   */
  private setupActivityTracking(): void {
    activityTracker.startTracking()
    
    // Listen for activity events
    activityTracker.addEventListener('activity-resumed', () => {
      this.handleActivityResumed()
    })
    
    activityTracker.addEventListener('status-should-change', (event: any) => {
      this.handleAutomaticStatusChange(event.detail)
    })
    
    debug.log('Activity tracking started')
  }
  
  /**
   * Handle user activity resumption
   */
  private async handleActivityResumed(): Promise<void> {
    if (!this.currentUserId) return
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) return
    
    debug.log('Activity resumed, current status:', UserStatus[userData.status], 'wasManuallySet:', this.wasManuallySet, 'manualStatus:', this.manualStatus !== null ? UserStatus[this.manualStatus] : 'null')
    
    // If user manually chose a status, restore to that (not necessarily Online)
    if (this.wasManuallySet && this.manualStatus !== null) {
      // If current status already matches their manual choice, nothing to do
      if (userData.status === this.manualStatus) {
        debug.log('Already at manual status:', UserStatus[this.manualStatus])
        activityTracker.resetStatusTracking()
        return
      }
      
      // Invisible/Away/Busy chosen manually - restore to that choice
      // (e.g., user was Busy, went auto-Offline from inactivity, now restore to Busy)
      if (this.manualStatus === UserStatus.Invisible) {
        debug.log('Keeping manual Invisible status')
        activityTracker.resetStatusTracking()
        return
      }
      
      debug.log('Restoring to manual status:', UserStatus[this.manualStatus])
      try {
        await this.updateCurrentUserStatus(this.manualStatus, false)
        debug.log('Status restored to', UserStatus[this.manualStatus])
      } catch (error) {
        debug.error('Failed to restore manual status:', error)
      }
      activityTracker.resetStatusTracking()
      return
    }
    
    // No manual status set - restore to Online if auto-set to Away/Offline
    if (userData.status === UserStatus.Away || userData.status === UserStatus.Offline) {
      debug.log('User active again, restoring to Online (was auto-set to', UserStatus[userData.status], ')')
      try {
        await this.updateCurrentUserStatus(UserStatus.Online, false)
        debug.log('Status restored to Online')
      } catch (error) {
        debug.error('Failed to restore status to Online:', error)
      }
    }
    
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
      debug.log('⏭Skipping auto status change - user manually set to:', UserStatus[userData.status])
      return
    }
    
    debug.log(`Auto-changing status to ${UserStatus[detail.status]} due to ${detail.reason} (${Math.round(detail.inactiveTime / 60000)}min)`)
    
    await this.updateCurrentUserStatus(detail.status, false) // Don't mark as manual
  }
  
  /**
   * Initialize current user data (Discord/Slack style)
   */
  private async initializeCurrentUser(userId: string, username: string, avatarUrl?: string, existingProfile?: any): Promise<void> {
    try {
      let profile = existingProfile
      
      if (!profile) {
        // Only query database if profile wasn't already loaded
        debug.log('Loading user profile from database...')
        const { data: profileData } = await supabase
          .from('profiles')
          .select('id, username, web_handle, display_name, avatar_url, banner_url, bio, color, status, domain, is_local, updated_at, created_at, custom_status, is_admin, is_moderator, federation_metadata')
          .eq('id', userId)
          .single()
        profile = profileData
      } else {
        debug.log('Using existing profile data, skipping database query')
      }
      
      if (profile) {
        // Professional status handling: database is truth, localStorage is backup
        // Active users should be Online by default, not Offline
        let finalStatus = UserStatus.Online // Always default to Online for active users
        
        // Restore manual status flag from localStorage (survives tab close)
        const savedManualFlag = this.getManualStatusFlag()
        if (savedManualFlag.wasManuallySet) {
          this.wasManuallySet = true
          this.manualStatus = savedManualFlag.manualStatus
        }

        // Primary: Use database status if it exists and is valid
        if (profile.status !== null && profile.status !== undefined) {
          if (profile.status === UserStatus.Away || profile.status === UserStatus.Busy || profile.status === UserStatus.Invisible) {
            if (this.wasManuallySet && this.manualStatus === profile.status) {
              // User explicitly chose this status - preserve it
              finalStatus = profile.status
              debug.log('Preserving manually-set status from database:', UserStatus[finalStatus])
            } else if (profile.status === UserStatus.Away && !this.wasManuallySet) {
              // Away in DB but no manual flag → was auto-idle, reset to Online
              finalStatus = UserStatus.Online
              debug.log('User was auto-idle Away, resetting to Online (user just opened the app)')
            } else if (this.wasManuallySet && this.manualStatus !== null) {
              // Manual flag exists but DB status diverged (e.g. auto-idle overrode manual) - restore manual choice
              finalStatus = this.manualStatus
              debug.log('Restoring manual status:', UserStatus[finalStatus])
            } else {
              finalStatus = profile.status
              debug.log('Preserving status from database:', UserStatus[finalStatus])
            }
          } else if (profile.status === UserStatus.Online) {
            finalStatus = UserStatus.Online
            debug.log('Status loaded from database:', UserStatus[finalStatus])
          } else {
            // Offline in DB - user is actively opening the app, reset to Online
            finalStatus = UserStatus.Online
            debug.log('User was offline in DB but is now active, setting to Online')
          }

          // If final status differs from DB, sync it
          if (finalStatus !== profile.status) {
            try {
              await supabase
                .from('profiles')
                .update({ status: finalStatus })
                .eq('id', userId)
              debug.log('Updated database status to', UserStatus[finalStatus])
            } catch (syncError) {
              debug.warn('Failed to update status in database:', syncError)
            }
          }
        } else {
          // No status in database - use manual flag if set, otherwise localStorage backup
          const backupStatus = this.getStatusFromLocalStorage()
          if (this.wasManuallySet && this.manualStatus !== null) {
            finalStatus = this.manualStatus
            debug.log('Using manually-set status from localStorage flag:', UserStatus[finalStatus])
          } else if (backupStatus === UserStatus.Busy || backupStatus === UserStatus.Invisible) {
            finalStatus = backupStatus
            debug.log('Using user-preferred status from localStorage backup:', UserStatus[finalStatus])
            
            // Sync backup to database for consistency
            try {
              await supabase
                .from('profiles')
                .update({ status: finalStatus })
                .eq('id', userId)
              debug.log('Synced localStorage status to database')
            } catch (syncError) {
              debug.warn('Failed to sync status to database:', syncError)
            }
          } else {
            // Default to Online - user is actively using the app
            debug.log('No valid status found, defaulting to Online (user is active)')
          }
        }
        
        let customStatus = this.parseCustomStatus(profile.custom_status)
        
        // If DB has expired custom_status, clear it so the row stays clean
        if (profile.custom_status && !customStatus && profile.id === userId) {
          const raw = typeof profile.custom_status === 'string' ? JSON.parse(profile.custom_status) : profile.custom_status
          const expiresAt = raw?.expires_at || raw?.expiresAt
          if (expiresAt && new Date(expiresAt) < new Date()) {
            try {
              await supabase.rpc('clear_custom_status', { p_user_id: userId })
              debug.log('Cleared expired custom status from database')
            } catch (_) { /* non-critical */ }
          }
        }
        
        // For current user, try localStorage as backup if database doesn't have it
        if (!customStatus && profile.id === userId) {
          const backupStatus = this.getCustomStatusFromLocalStorage()
          if (backupStatus) {
            customStatus = backupStatus
            // Sync backup to database
            try {
              await supabase.rpc('set_custom_status', {
                p_user_id: userId,
                p_type: backupStatus.type || 'custom',
                p_text: backupStatus.text || '',
                p_emoji: backupStatus.emoji || null,
                p_emoji_url: (backupStatus as any).emoji_url || null,
                p_details: (backupStatus as any).details || null,
                p_state: (backupStatus as any).state || null,
                p_duration_minutes: null,
              })
              debug.log('Synced localStorage custom status to database')
            } catch (syncError) {
              debug.warn('Failed to sync custom status to database:', syncError)
            }
          }
        }
        
        const currentDisplayName = profile.display_name || profile.username || username
        const dnEmojis = this.extractDisplayNameEmojis(profile.federation_metadata)
        const userData: UserData = {
          id: profile.id,
          username: profile.username || username,
          handle: profile.web_handle ?? undefined,
          displayName: currentDisplayName,
          displayNameEmojis: dnEmojis,
          displayNameParts: this.resolveDisplayNameParts(currentDisplayName, dnEmojis),
          avatarUrl: profile.avatar_url || avatarUrl,
          bannerUrl: profile.banner_url,
          bio: profile.bio,
          color: profile.color,
          domain: profile.domain || import.meta.env.VITE_DOMAIN as string,
          isLocal: profile.is_local ?? (
            !profile.domain || 
            profile.domain === import.meta.env.VITE_DOMAIN
          ),
          status: finalStatus,
          customStatus: customStatus,
          isOnline: true,
          isMobile: detectMobileDevice(),
          lastSeen: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
          lastCacheUpdate: new Date().toISOString(),
          createdAt: profile.created_at || new Date().toISOString(),
          isAdmin: profile.is_admin || false,
          isModerator: profile.is_moderator || false,
          source: 'database'
        }
        
        this.users.set(userId, userData)
        debug.log('Current user initialized:', userData.displayName, 'Final Status:', UserStatus[finalStatus])
      } else {
        // No profile exists - check if user had a manual status preference
        const savedFlag = this.getManualStatusFlag()
        const backupStatus = this.getStatusFromLocalStorage()
        const initialStatus = (savedFlag.wasManuallySet && savedFlag.manualStatus !== null)
          ? savedFlag.manualStatus
          : (backupStatus === UserStatus.Away || backupStatus === UserStatus.Busy || backupStatus === UserStatus.Invisible)
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
        debug.log('Current user initialized with minimal data:', username, 'Status:', UserStatus[initialStatus])
      }
      
      this.emitEvent('user-updated', { userId })
      
    } catch (error) {
      debug.error('Failed to initialize current user:', error)
      throw error
    }
  }
  
  /**
   * Setup global presence channel for cross-context online/offline tracking
   * 
   * Track presence once per subscription.
   * The presence events are logged but we don't react aggressively to them.
   */
  private async setupGlobalPresence(): Promise<void> {
    if (!this.currentUserId) return

    // BUGS.md H31 v2: install __harmonyPresenceCleanup BEFORE opening any presence
    // channel, else a fast close hits auth.ts setupOfflineHandlers' cleanup call
    // before the fn exists. Safe pre-subscribe: untrackFromAll... no-ops when no
    // channels are open.
    if (typeof window !== 'undefined') {
      ;(window as any).__harmonyPresenceCleanup = () => {
        // Sync best-effort: fire untrack, let browser keepalive flush; no await
        // since beforeunload can't reliably await promises past unload.
        this.untrackFromAllPresenceChannels().catch(err => {
          debug.warn('__harmonyPresenceCleanup untrack failed:', err)
        })
      }
    }

    // GLOBAL PRESENCE SYSTEM - Keep it simple
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
          debug.log('Global presence channel connected')
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
      
      debug.log(`User ${this.currentUserId} tracked globally with status: ${UserStatus[userData.status]}`)
    } catch (error) {
      debug.warn('Global presence track failed:', error)
    }
  }
  
  /**
   * Handle global presence sync - update basic online/offline status
   * Kept minimal to avoid churn
   */
  private handleGlobalPresenceSync(): void {
    if (!this.globalChannel) return
    
    const state = this.globalChannel.presenceState()
    // eslint-disable-next-line unused-imports/no-unused-vars
    const userCount = Object.keys(state).length
    
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
    
    debug.log(`Global presence: ${globallyOnlineUserIds.size} users online globally`)
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
    
    // If user has status set to Offline (invisible), don't show them as online
    // This should never happen due to trackCurrentUserGlobally() checks, but handle it as safety net
    if (userStatus === UserStatus.Offline) {
      debug.log(`User ${userId} has offline status in global presence - skipping update (they should be invisible)`)
      // If they exist in our cache, mark them as offline
      if (existing) {
        existing.isOnline = false
        existing.lastSeen = presence.online_at || new Date().toISOString()
        this.emitEvent('user-updated', { userId })
        this.emitEvent('global-presence-updated', { userId, isOnline: false })
      }
      return
    }

    const nextUsername = presence.username || existing?.username || 'Unknown'
    const nextDisplayName = presence.display_name || presence.username || existing?.displayName || 'Unknown'
    // Cache/DB wins - presence can be stale (tracked before avatar upload)
    const nextAvatar = existing?.avatarUrl || presence.avatar_url
    const nextColor = presence.color || existing?.color
    const nextCustomStatus = presence.custom_status || existing?.customStatus
    const nextMobile = presence.is_mobile || existing?.isMobile || false

    // Fast-path: if nothing user-visible changed and user is already online, only
    // bump bookkeeping (no reactive write/emit). Otherwise every presence sync event
    // (fired per peer join/leave/track) re-renders every Avatar/DisplayName, remounting
    // <img> and refetching through R2/imgproxy - visible avatar flicker under latency.
    if (
      existing &&
      existing.isOnline === true &&
      existing.username === nextUsername &&
      existing.displayName === nextDisplayName &&
      existing.avatarUrl === nextAvatar &&
      existing.color === nextColor &&
      existing.status === userStatus &&
      existing.isMobile === nextMobile &&
      JSON.stringify(existing.customStatus) === JSON.stringify(nextCustomStatus)
    ) {
      existing.lastSeen = presence.online_at || new Date().toISOString()
      existing.lastHeartbeat = existing.lastSeen
      return
    }

    const userData: UserData = {
      ...existing,
      id: userId,
      username: nextUsername,
      displayName: nextDisplayName,
      avatarUrl: nextAvatar,
      bannerUrl: existing?.bannerUrl,
      bio: existing?.bio,
      color: nextColor,
      domain: existing?.domain,
      isLocal: existing?.isLocal ?? true,
      status: userStatus,
      customStatus: nextCustomStatus,
      isOnline: true,
      isMobile: nextMobile,
      lastSeen: presence.online_at || new Date().toISOString(),
      lastHeartbeat: presence.online_at || new Date().toISOString(),
      lastCacheUpdate: new Date().toISOString(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      source: 'presence'
    }
    
    this.users.set(userId, userData)
    
    // Force UI updates for global presence changes
    this.emitEvent('user-updated', { userId })
    this.emitEvent('global-presence-updated', { userId, isOnline: true })
  }
  
  // updateUserFromPresence removed with the per-server Presence handlers (see
  // setupServerPresence comment). All presence data now flows through
  // updateUserFromGlobalPresence above.

  
  /**
   * Start heartbeat for both internal tracking and Redis presence.
   * Redis heartbeats keep the server-side presence sorted set alive.
   * Supabase Realtime Presence remains active separately for backward compat.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)

    const mapStatusToRedis = (s: UserStatus): string => {
      switch (s) {
        case UserStatus.Online: return 'online'
        case UserStatus.Away: return 'idle'
        case UserStatus.Busy: return 'dnd'
        case UserStatus.Invisible: return 'invisible'
        default: return 'online'
      }
    }

    const currentUser = this.currentUserId ? this.users.get(this.currentUserId) : null
    const redisStatus = currentUser ? mapStatusToRedis(currentUser.status) : 'online'
    const customSt = currentUser?.customStatus?.text

    realtimeApiService.startHeartbeat(
      redisStatus as any,
      customSt || undefined
    )
    
    this.heartbeatTimer = setInterval(async () => {
      if (this.currentUserId) {
        const userData = this.users.get(this.currentUserId)
        if (userData) {
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
    
    debug.log('Connection lost - setting user offline')
    
    try {
      await this.updateCurrentUserStatus(UserStatus.Offline, false)
      realtimeApiService.goOffline().catch(() => {})
    } catch (error) {
      debug.error('Failed to set offline status on connection loss:', error)
    }
  }
  
  /**
   * Subscribe to a context (server, DM, profile, friends)
   */
  async subscribeToContext(contextId: string, type: 'server' | 'dm' | 'profile' | 'friends', userIds: string[]): Promise<void> {
    if (this.contexts.has(contextId)) {
      debug.log(`Already subscribed to ${type} context:`, contextId, '- skipping duplicate subscription')
      return
    }
    
    if (this.pendingSubscriptions.has(contextId)) {
      debug.log(`Subscription already in progress for ${type} context:`, contextId, '- skipping duplicate')
      return
    }
    
    this.pendingSubscriptions.add(contextId)
    
    try {
      debug.log(`Subscribing to ${type} context:`, contextId, `(${userIds.length} users)`)

      // Online-first hydration for large server member lists: load the
      // online members (or, if global presence hasn't synced yet, the first
      // chunk) up front so the list paints immediately, then backfill the
      // remaining (offline) profiles in the background. This keeps big
      // servers from blocking the member list on loading every profile.
      let offlineBackfillIds: string[] = []
      if (type === 'server' && userIds.length > PROFILE_BACKFILL_CHUNK) {
        const onlineIds = userIds.filter(id => this.users.get(id)?.isOnline === true)
        const offlineIds = userIds.filter(id => this.users.get(id)?.isOnline !== true)
        const firstBatch = onlineIds.length > 0 ? onlineIds : offlineIds.slice(0, PROFILE_BACKFILL_CHUNK)
        offlineBackfillIds = onlineIds.length > 0 ? offlineIds : offlineIds.slice(PROFILE_BACKFILL_CHUNK)
        await this.loadUsersData(firstBatch)
      } else {
        // Small contexts (DMs, friends, small servers): just load everyone.
        await this.loadUsersData(userIds)
      }

      const context: UserContext = {
        id: contextId,
        type,
        userIds: new Set(userIds),
        lastSync: new Date()
      }
      
      this.contexts.set(contextId, context)

      // Context is registered above BEFORE this notify: the profile load emits
      // `data-refreshed` while the context doesn't yet exist, so the member-list
      // computed recomputes against an empty context. Without this explicit notify
      // the list stays blank until an unrelated event bumps reactivity (the "users
      // only appear when presence changes" regression).
      this.emitEvent('context-updated', { contextId })

      if (type === 'server') {
        await this.setupServerPresence(contextId, userIds)
      }

      // Backfill the remaining (offline) profiles in the background.
      if (offlineBackfillIds.length > 0) {
        void this.backfillContextProfiles(contextId, offlineBackfillIds)
      }

      debug.log(`Subscribed to ${type} context:`, contextId)
    } finally {
      this.pendingSubscriptions.delete(contextId)
    }
  }

  /**
   * Progressively load a context's remaining profiles (typically offline
   * members) in the background, emitting `context-updated` after each chunk so
   * the member list fills in without ever blocking the initial paint. Bails if
   * the context is torn down (user navigated away) mid-backfill.
   */
  private async backfillContextProfiles(contextId: string, userIds: string[]): Promise<void> {
    for (let i = 0; i < userIds.length; i += PROFILE_BACKFILL_CHUNK) {
      if (!this.contexts.has(contextId)) return
      const chunk = userIds.slice(i, i + PROFILE_BACKFILL_CHUNK)
      try {
        await this.loadUsersData(chunk)
        if (!this.contexts.has(contextId)) return
        this.emitEvent('context-updated', { contextId })
      } catch (error) {
        debug.warn(`Profile backfill chunk failed for context ${contextId}:`, error)
      }
    }
    debug.log(`Profile backfill complete for context ${contextId} (${userIds.length} users)`)
  }
  
  /**
   * Setup server broadcast channel. BROADCAST-ONLY: receives profile_update
   * broadcasts from peers and presence_event broadcasts from DB triggers (member
   * join/leave, profile/emoji changes).
   *
   * It used to ALSO use Supabase Presence to track "online in this server", which
   * was wrong: switching servers fired `presence:leave`, marking the user OFFLINE to
   * everyone in the server they just left; and handleServerSync force-marked members
   * absent from per-server presence as offline even when global presence showed them
   * online. Online/offline is now GLOBAL - `harmony-global-presence` is the single
   * source of truth; per-server channels are pure pub/sub.
   *
   * BUGS.md C14 retry behaviour for `CHANNEL_ERROR` is preserved.
   */
  private async setupServerPresence(serverId: string, userIds: string[]): Promise<void> {
    const channelName = `server-presence:${serverId}`
    debug.log('Subscribing to server broadcast channel:', serverId, 'with', userIds.length, 'users')

    // Tear down any prior channel + retry timer on this context before
    // subscribing a new one. This is what prevents accumulating duplicates.
    const existingContext = this.contexts.get(serverId)
    if (existingContext?.channel) {
      try {
        await supabase.removeChannel(existingContext.channel)
      } catch (err) {
        debug.warn(`[Realtime] failed to remove previous server-presence:${serverId} channel:`, err)
      }
      existingContext.channel = undefined
    }
    if (existingContext && (existingContext as any)._presenceRetryTimer) {
      clearTimeout((existingContext as any)._presenceRetryTimer)
      ;(existingContext as any)._presenceRetryTimer = null
    }

    const channel = supabase.channel(channelName, { config: { private: true } })
      // Listen for profile update broadcasts (the correct way for real-time profile changes)
      .on('broadcast', { event: 'profile_update' }, (payload) => this.handleProfileUpdateBroadcast(serverId, payload))
      .on('broadcast', { event: 'presence_event' }, (payload) => {
        const data = payload.payload ?? payload
        const type = data?.type as string
        console.log(`[Realtime] presence_event on server-presence:${serverId}`, { type, data })
        if (type === 'member:join') {
          this.handleServerMemberJoin(serverId, { new: { user_id: data.user_id } })
        } else if (type === 'member:leave') {
          this.handleServerMemberLeave(serverId, { old: { user_id: data.user_id } })
        } else if (type === 'profile:updated') {
          this.handleProfileUpdate(serverId, { new: data })
        } else if (type?.startsWith('emoji:')) {
          this.handleEmojiBroadcast(data)
        }
      })
      .subscribe(async (status: string) => {
        if (status === 'SUBSCRIBED') {
          console.log(`[Realtime] server-presence:${serverId} → SUBSCRIBED`)
          // No .track() call: this channel does not participate in presence
          // tracking. Online/offline is owned by `harmony-global-presence`.
        } else if (status === 'CHANNEL_ERROR') {
          console.error(`[Realtime] server-presence:${serverId} → CHANNEL_ERROR`)
          // Store the timer on the context so it can be cancelled if the
          // context is unsubscribed before retry fires. Also defensively
          // bail if the context disappeared (logout / leave server).
          const ctx = this.contexts.get(serverId)
          if (!ctx) {
            debug.log(`[Realtime] server-presence:${serverId} dropped - no context, skipping retry`)
            return
          }
          if ((ctx as any)._presenceRetryTimer) {
            clearTimeout((ctx as any)._presenceRetryTimer)
          }
          ;(ctx as any)._presenceRetryTimer = setTimeout(() => {
            ;(ctx as any)._presenceRetryTimer = null
            // Re-check context still exists when timer fires.
            if (!this.contexts.has(serverId)) return
            this.setupServerPresence(serverId, userIds).catch(err => {
              debug.error(`[Realtime] server-presence:${serverId} retry failed:`, err)
            })
          }, 5000)
        } else {
          console.log(`[Realtime] server-presence:${serverId} →`, status)
        }
      })

    const context = this.contexts.get(serverId)
    if (context) {
      context.channel = channel
    }
  }
  
  // REMOVED: trackCurrentUserInServer / handleServerSync / executeServerSync /
  // handleServerUserJoin / handleServerUserLeave - they coupled per-server Presence
  // to online/offline (see setupServerPresence for the bugs). Per
  // .cursor/rules/realtime-architecture.mdc, server-presence:{serverId} is
  // broadcast-only; online/offline lives on harmony-global-presence.
  // ---------------------------------------------------------------------

  /**
   * Handle real-time server membership join
   */
  private async handleServerMemberJoin(serverId: string, payload: any): Promise<void> {
    const newUserId = payload.new.user_id
    debug.log(`New member joined server ${serverId}:`, newUserId)
    
    const context = this.contexts.get(serverId)
    if (context) {
      context.userIds.add(newUserId)
      
      await this.loadUsersData([newUserId])
      
      this.emitEvent('context-updated', { contextId: serverId, type: 'member-join', userId: newUserId })
    }
  }

  /**
   * Handle real-time server membership leave (DB user_servers row deleted -
   * the user actually left this server, not just switched away from viewing it).
   */
  private async handleServerMemberLeave(serverId: string, payload: any): Promise<void> {
    const leftUserId = payload.old.user_id
    debug.log(`Member left server ${serverId}:`, leftUserId)

    const context = this.contexts.get(serverId)
    if (context) {
      // Remove user from this server's member list. We deliberately DO NOT
      // touch `userData.isOnline` - leaving one server doesn't make a user
      // offline globally. They might still be in other servers, in DMs with
      // us, or on our friends list, and global presence is the single
      // source of truth for online/offline status now.
      context.userIds.delete(leftUserId)

      this.emitEvent('context-updated', { contextId: serverId, type: 'member-leave', userId: leftUserId })
    }
  }

  /**
   * Handle real-time profile updates (avatar, display name, color, bio)
   * This ensures all users in the server see profile changes in real-time
   */
  private async handleProfileUpdate(serverId: string, payload: any): Promise<void> {
    const updatedProfile = payload.new
    const userId = updatedProfile.user_id || updatedProfile.id
    
    debug.log(`Profile update received for user ${userId} in server ${serverId}:`, {
      display_name: updatedProfile.display_name,
      avatar_url: updatedProfile.avatar_url,
      banner_url: updatedProfile.banner_url,
      color: updatedProfile.color
    })
    
    const userData = this.users.get(userId)
    if (userData) {
      if (updatedProfile.federation_metadata !== undefined) {
        const dnEmojis = this.extractDisplayNameEmojis(updatedProfile.federation_metadata)
        if (dnEmojis) {
          userData.displayNameEmojis = dnEmojis
        }
      }
      if (updatedProfile.display_name !== undefined) {
        userData.displayName = updatedProfile.display_name
        userData.displayNameParts = this.resolveDisplayNameParts(updatedProfile.display_name, userData.displayNameEmojis)
      }
      const avatarChanged = updatedProfile.avatar_url !== undefined &&
        updatedProfile.avatar_url !== userData.avatarUrl
      const bannerChanged = updatedProfile.banner_url !== undefined &&
        updatedProfile.banner_url !== userData.bannerUrl
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
      if (updatedProfile.custom_status !== undefined) {
        userData.customStatus = this.parseCustomStatus(updatedProfile.custom_status)
      }
      
      userData.lastCacheUpdate = new Date().toISOString()
      userData.source = 'database'
      
      this.emitEvent('user-updated', { userId })

      if (userId === this.currentUserId && (avatarChanged || bannerChanged)) {
        await this.refreshPresenceMediaFields()
      }
      
      debug.log(`Updated user data for ${userData.displayName} in server ${serverId}`)
    } else {
      debug.log(`Loading fresh user data for ${userId} after profile update`)
      await this.loadUsersData([userId])
      
      this.emitEvent('user-updated', { userId })
    }
    
    this.emitEvent('context-updated', { 
      contextId: serverId, 
      type: 'profile-update', 
      userId 
    })
  }
  
  /**
   * Relay emoji broadcast events to the emoji cache store.
   */
  private handleEmojiBroadcast(data: any): void {
    try {
      const { useEmojiCacheStore } = require('@/stores/useEmojiCache')
      const emojiStore = useEmojiCacheStore()
      const eventType = data.type === 'emoji:insert' ? 'INSERT'
                      : data.type === 'emoji:update' ? 'UPDATE'
                      : data.type === 'emoji:delete' ? 'DELETE'
                      : null
      if (!eventType) return
      emojiStore.handleEmojiUpdate({ eventType, new: data.new, old: data.old })
    } catch (err) {
      debug.warn('Failed to relay emoji broadcast:', err)
    }
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
    
    debug.log(`Received profile update broadcast for user ${userId} in server ${serverId}:`, profileUpdates)
    
    const userData = this.users.get(userId)
    if (userData) {
      if (profileUpdates.displayName !== undefined) {
        userData.displayName = profileUpdates.displayName
        userData.displayNameParts = this.resolveDisplayNameParts(profileUpdates.displayName, userData.displayNameEmojis)
      }
      if (profileUpdates.avatarUrl !== undefined) {
        userData.avatarUrl = profileUpdates.avatarUrl
      }
      if (profileUpdates.bannerUrl !== undefined) {
        userData.bannerUrl = profileUpdates.bannerUrl
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
      if ('customStatus' in profileUpdates) {
        userData.customStatus = profileUpdates.customStatus
      }
      
      userData.lastCacheUpdate = new Date().toISOString()
      userData.source = 'presence'
      
      this.emitEvent('user-updated', { userId })
      
      debug.log(`Updated user data for ${userData.displayName} from broadcast`)
    } else {
      // If we don't have the user data, load it fresh from the database
      debug.log(`Loading fresh user data for ${userId} after profile broadcast`)
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
    // UUID v4 regex pattern
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    
    // Filter: load if missing, stale, has Unknown username, or presence snapshot
    // still needs a DB row for custom display-name emoji shortcodes.
    const missingUserIds = userIds.filter(id => {
      if (!uuidPattern.test(id)) {
        debug.warn(`Skipping non-UUID user ID in loadUsersData: ${id}`)
        return false
      }
      const existing = this.users.get(id)
      const hasUnknownUsername = !existing?.username || existing.username === 'Unknown' || existing.username === 'unknown'
      const needsPresenceEnrichment = existing?.source === 'presence' &&
        typeof existing.displayName === 'string' &&
        (EMOJI_SHORTCODE_TEST_REGEX.lastIndex = 0, EMOJI_SHORTCODE_TEST_REGEX.test(existing.displayName))
      return !existing || this.isUserDataStale(id) || hasUnknownUsername || needsPresenceEnrichment
    })
    
    if (missingUserIds.length === 0) return

    // Coalesce single-id callers (e.g. one <DisplayName> per message) into one
    // id=in.(...) fetch per microtask window, avoiding an N+1 query storm. Cache
    // check above keeps already-loaded users out of the queue.
    missingUserIds.forEach(id => this.userLoadQueue.add(id))

    if (!this.userLoadBatchPromise) {
      this.userLoadBatchPromise = new Promise<void>((resolve) => {
        queueMicrotask(() => {
          const batchIds = Array.from(this.userLoadQueue)
          this.userLoadQueue.clear()
          this.userLoadBatchPromise = null
          this.executeUserLoad(batchIds).finally(() => resolve())
        })
      })
    }

    return this.userLoadBatchPromise
  }

  /**
   * Execute the actual profile fetch for a coalesced, de-duplicated set of IDs.
   * Only ever called by loadUsersData() via the batch queue.
   */
  private async executeUserLoad(missingUserIds: string[]): Promise<void> {
    if (missingUserIds.length === 0) return

    debug.log(`Loading user data for ${missingUserIds.length} users`)

    const loadedIds: string[] = []

    try {
      // The microtask batch coalescer can merge dozens of single-id callers into
      // one id=in.(...) query. Keep each HTTP request small so reverse proxies
      // don't 502 (which surfaces in the browser as a bogus CORS error).
      for (let i = 0; i < missingUserIds.length; i += PROFILE_BACKFILL_CHUNK) {
        const chunk = missingUserIds.slice(i, i + PROFILE_BACKFILL_CHUNK)
        const { data: profiles, error } = await supabase
          .from('profiles')
          .select(PROFILE_BULK_SELECT)
          .in('id', chunk)

        if (error) {
          debug.error('Failed to load user data chunk:', error)
          continue
        }

        if (!profiles?.length) continue

        profiles.forEach((profile: any) => {
          const existing = this.users.get(profile.id)
          const dn = profile.display_name || profile.username || 'Unknown'
          const userData: UserData = {
            id: profile.id,
            username: profile.username || 'Unknown',
            handle: profile.web_handle ?? undefined,
            displayName: dn,
            displayNameEmojis: existing?.displayNameEmojis,
            displayNameParts: this.resolveDisplayNameParts(dn, existing?.displayNameEmojis),
            avatarUrl: profile.avatar_url,
            bannerUrl: profile.banner_url,
            bio: profile.bio,
            color: profile.color,
            domain: profile.domain || import.meta.env.VITE_DOMAIN as string,
            isLocal: profile.is_local ?? (
              !profile.domain ||
              profile.domain === import.meta.env.VITE_DOMAIN
            ),
            status: profile.status ?? existing?.status ?? UserStatus.Offline,
            customStatus: this.parseCustomStatus(profile.custom_status),
            isOnline: existing?.isOnline ?? false,
            isMobile: existing?.isMobile ?? false,
            lastSeen: existing?.lastSeen ?? profile.updated_at ?? new Date().toISOString(),
            lastHeartbeat: existing?.lastHeartbeat ?? new Date().toISOString(),
            lastCacheUpdate: new Date().toISOString(),
            createdAt: profile.created_at || new Date().toISOString(),
            updatedAt: profile.updated_at,
            isAdmin: profile.is_admin ?? existing?.isAdmin ?? false,
            isModerator: profile.is_moderator ?? existing?.isModerator ?? false,
            source: 'database'
          }

          this.users.set(profile.id, userData)
          loadedIds.push(profile.id)
        })
      }

      if (loadedIds.length > 0) {
        debug.log(`Loaded ${loadedIds.length} user profiles from database`)
        await this.enrichDisplayNameEmojis(loadedIds)
        this.emitEvent('data-refreshed', { userIds: loadedIds })
      }
    } catch (error) {
      debug.error('Failed to load user data:', error)
    }
  }

  /**
   * Lazy-load federation_metadata only for profiles whose display name contains
   * custom-emoji shortcodes. Avoids shipping large JSONB blobs in every bulk
   * member-list hydration.
   */
  private async enrichDisplayNameEmojis(userIds: string[]): Promise<void> {
    const needEnrich = userIds.filter(id => {
      const u = this.users.get(id)
      if (!u || u.displayNameEmojis?.length) return false
      if (typeof u.displayName !== 'string') return false
      EMOJI_SHORTCODE_TEST_REGEX.lastIndex = 0
      return EMOJI_SHORTCODE_TEST_REGEX.test(u.displayName)
    })
    if (needEnrich.length === 0) return

    const enrichedIds: string[] = []

    for (let i = 0; i < needEnrich.length; i += PROFILE_BACKFILL_CHUNK) {
      const chunk = needEnrich.slice(i, i + PROFILE_BACKFILL_CHUNK)
      const { data, error } = await supabase
        .from('profiles')
        .select('id, federation_metadata')
        .in('id', chunk)

      if (error || !data?.length) continue

      for (const row of data as Array<{ id: string; federation_metadata: unknown }>) {
        const dnEmojis = this.extractDisplayNameEmojis(row.federation_metadata)
        if (!dnEmojis?.length) continue
        const existing = this.users.get(row.id)
        if (!existing) continue
        existing.displayNameEmojis = dnEmojis
        existing.displayNameParts = this.resolveDisplayNameParts(existing.displayName, dnEmojis)
        enrichedIds.push(row.id)
      }
    }

    if (enrichedIds.length > 0) {
      this.emitEvent('data-refreshed', { userIds: enrichedIds })
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
      is_admin: userData.isAdmin || false,
      is_moderator: userData.isModerator || false,
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
    if (forceRefresh) {
      // Force refresh all users
      userIds.forEach(id => this.users.delete(id))
    }
    
    await this.loadUsersData(userIds)
    
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
    
    debug.log('Updating current user status to:', UserStatus[status], isManual ? '(manual)' : '(automatic)')
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) throw new Error('Current user data not found')
    
    if (isManual) {
      if (status === UserStatus.Away || status === UserStatus.Busy || status === UserStatus.Invisible) {
        this.wasManuallySet = true
        this.manualStatus = status
        this.saveManualStatusFlag()
        debug.log('Status manually set to:', UserStatus[status])
      } else if (status === UserStatus.Online) {
        this.wasManuallySet = false
        this.manualStatus = null
        this.clearManualStatusFlag()
        debug.log('Status manually set to Online - clearing manual flag')
      }
    }
    
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
      
      if (data && data[0] && data[0].status !== status) {
        throw new Error(`Status verification failed. Expected: ${status}, Got: ${data[0].status}`)
      }
      
      debug.log('Status verified in database:', UserStatus[status])
      
      await this.updatePresenceStatus(status)

      // Sync to Redis presence
      const redisStatus = status === UserStatus.Online ? 'online'
        : status === UserStatus.Away ? 'idle'
        : status === UserStatus.Busy ? 'dnd'
        : status === UserStatus.Invisible ? 'invisible'
        : 'offline'
      realtimeApiService.updateStatus(redisStatus as any, userData.customStatus?.text)
      
      // Backup to localStorage
      try {
        userStorage.setItem('user_status', status.toString())
        debug.log('Status backed up to localStorage')
      } catch (localStorageError) {
        debug.warn('Failed to backup status to localStorage:', localStorageError)
      }
      
      this.emitEvent('status-changed', { userId: this.currentUserId, status })
      debug.log('Status updated successfully to:', UserStatus[status])
      
    } catch (error) {
      debug.error('Failed to update status:', error)
      // Note: local change already applied, database update failed
      throw error
    }
  }

  /**
   * Set custom status (Discord-style "Playing X", "Listening to Y", etc.)
   * @param customStatus - The custom status to set, or undefined to clear
   * @param durationMinutes - Optional duration in minutes (null = forever)
   */
  async setCustomStatus(customStatus: CustomUserStatus | undefined, durationMinutes?: number): Promise<void> {
    if (!this.currentUserId) throw new Error('No current user')
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) throw new Error('Current user data not found')
    
    debug.log('Setting custom status:', customStatus?.text || '(clearing)')
    
    if (this.customStatusExpiryTimer) {
      clearTimeout(this.customStatusExpiryTimer)
      this.customStatusExpiryTimer = null
    }
    
    userData.customStatus = customStatus
    userData.lastCacheUpdate = new Date().toISOString()
    
    this.saveCustomStatusToLocalStorage(customStatus)
    
    // Schedule client-side clear when expiresAt is reached (no pg_cron; scale-friendly)
    if (customStatus?.expiresAt) {
      const expiresAtMs = new Date(customStatus.expiresAt).getTime()
      const delay = Math.max(0, expiresAtMs - Date.now())
      this.customStatusExpiryTimer = setTimeout(() => {
        this.customStatusExpiryTimer = null
        this.clearCustomStatus().catch((err) => debug.warn('Auto-clear custom status failed:', err))
      }, delay)
    }
    
    // Persist to database for federation
    try {
      if (customStatus) {
        await supabase.rpc('set_custom_status', {
          p_user_id: this.currentUserId,
          p_type: (customStatus as any).type || 'custom',
          p_text: customStatus.text,
          p_emoji: customStatus.emoji,
          p_emoji_url: (customStatus as any).emoji_url,
          p_details: (customStatus as any).details,
          p_state: (customStatus as any).state,
          p_duration_minutes: durationMinutes || null,
        })
      } else {
        await supabase.rpc('clear_custom_status', {
          p_user_id: this.currentUserId,
        })
      }
    } catch (error) {
      debug.warn('Failed to persist custom status to database:', error)
      // Continue - local state is updated
    }
    
    // Broadcast custom status change to users in shared contexts
    await this.broadcastProfileToContexts({ customStatus })
    
    this.emitEvent('custom-status-changed', { userId: this.currentUserId, customStatus })
    debug.log('Custom status updated and broadcast')
  }

  /**
   * Set rich presence status (extended Discord-style with activity types)
   * @param type - Activity type: 'custom', 'playing', 'listening', 'watching', 'competing', 'streaming'
   * @param text - Primary status text
   * @param options - Additional options (emoji, details, state, duration)
   */
  async setRichPresence(
    type: 'custom' | 'playing' | 'listening' | 'watching' | 'competing' | 'streaming',
    text: string,
    options?: {
      emoji?: string
      emoji_url?: string
      details?: string
      state?: string
      durationMinutes?: number
    }
  ): Promise<void> {
    const customStatus: any = {
      type,
      text,
      emoji: options?.emoji,
      emoji_url: options?.emoji_url,
      details: options?.details,
      state: options?.state,
    }
    
    if (options?.durationMinutes) {
      customStatus.expiresAt = new Date(Date.now() + options.durationMinutes * 60 * 1000).toISOString()
    }
    
    await this.setCustomStatus(customStatus, options?.durationMinutes)
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
   * Get custom status for any user (from database)
   */
  async getUserCustomStatus(userId: string): Promise<CustomUserStatus | undefined> {
    // First check local cache
    const userData = this.users.get(userId)
    if (userData?.customStatus !== undefined) {
      return userData.customStatus
    }
    
    // If user data exists but customStatus is undefined, try to load it
    if (userData) {
      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('custom_status')
          .eq('id', userId)
          .single()
        
        if (profile?.custom_status) {
          const customStatus = this.parseCustomStatus(profile.custom_status)
          userData.customStatus = customStatus
          return customStatus
        }
      } catch (error) {
        debug.warn('Failed to fetch user custom status:', error)
      }
    } else {
      // User not in cache, load full profile (which includes custom_status)
      await this.loadUsersData([userId])
      return this.users.get(userId)?.customStatus
    }
    
    return undefined
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
   * Update presence channels when status changes.
   * Re-tracks to broadcast the new status to other clients.
   */
  private async updatePresenceStatus(status: UserStatus): Promise<void> {
    if (status === UserStatus.Invisible) {
      debug.log(`User going Invisible - untracking from all presence channels`)
      await this.untrackFromAllPresenceChannels()
      return
    }
    
    // Re-track with updated status so other clients see the change
    await this.trackCurrentUserGlobally()
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
    
    debug.log('Updating current user profile:', profileData)
    
    const userData = this.users.get(this.currentUserId)
    if (!userData) throw new Error('Current user data not found')
    
    if (profileData.displayName !== undefined) {
      userData.displayName = profileData.displayName
      userData.displayNameParts = this.resolveDisplayNameParts(profileData.displayName, userData.displayNameEmojis)
    }
    if (profileData.avatarUrl !== undefined) userData.avatarUrl = profileData.avatarUrl
    if (profileData.bannerUrl !== undefined) userData.bannerUrl = profileData.bannerUrl
    if (profileData.bio !== undefined) userData.bio = profileData.bio
    if (profileData.color !== undefined) userData.color = profileData.color
    if (profileData.username !== undefined) userData.username = profileData.username
    userData.lastCacheUpdate = new Date().toISOString()
    
    try {
      // Broadcast profile changes to relevant contexts only (context-aware)
      await this.broadcastProfileToContexts(profileData)

      if (profileData.avatarUrl !== undefined || profileData.bannerUrl !== undefined) {
        await this.refreshPresenceMediaFields()
      }
      
      this.emitEvent('user-updated', { userId: this.currentUserId })
      debug.log('Profile updated and broadcast to relevant contexts')
      
    } catch (error) {
      debug.error('Failed to broadcast profile update:', error)
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
    customStatus?: CustomUserStatus | undefined
  }): Promise<void> {
    if (!this.currentUserId) return
    
    debug.log(`Broadcasting profile update to ${this.contexts.size} contexts`)
    
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
          
          debug.log(`Profile broadcast to ${context.type} context: ${context.id}`)
        } catch (error) {
          debug.error(`Failed to broadcast profile to context ${context.id}:`, error)
        }
      }
    }
    
    debug.log(`Profile broadcast completed to ${this.contexts.size} context channels`)
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
    if (context) {
      // BUGS.md C14 v2: the presence-error retry timer attached in
      // `setupServerPresence`'s CHANNEL_ERROR branch needs to be cancelled
      // here too, otherwise a pending retry can resurrect the channel after
      // the context has been torn down (the in-timer `this.contexts.has`
      // guard saves correctness, but the timer still pins memory until it
      // fires).
      if ((context as any)._presenceRetryTimer) {
        clearTimeout((context as any)._presenceRetryTimer)
        ;(context as any)._presenceRetryTimer = null
      }
      if (context.channel) {
        await context.channel.unsubscribe()
      }
    }

    this.contexts.delete(contextId)
    debug.log('Unsubscribed from context:', contextId)
  }
  
  /**
   * Emit custom events
   */
  private emitEvent(type: string, data: any): void {
    this.dispatchEvent(new CustomEvent(type, { detail: data }))
  }
  
  /**
   * Extract display_name_emojis from federation_metadata.
   * Normalizes to { id, name, url } so display names render for users not in cache (e.g. server card owner).
   */
  private extractDisplayNameEmojis(federationMetadata: any): Array<{ id: string; name: string; url: string }> | undefined {
    if (!federationMetadata) return undefined
    try {
      const meta = typeof federationMetadata === 'string' ? JSON.parse(federationMetadata) : federationMetadata
      if (Array.isArray(meta.display_name_emojis) && meta.display_name_emojis.length > 0) {
        return meta.display_name_emojis.map((e: any) => {
          const name = (e.name || '').replace(/:/g, '')
          return { id: e.id || e.name || name || '', name, url: e.url || '' }
        }).filter((e: { name: string; url: string }) => e.name && e.url)
      }
    } catch { /* ignore */ }
    return undefined
  }

  /**
   * Resolve display name shortcodes into structured parts.
   * Priority: pinnedEmojis (from federation_metadata) > emoji cache > unified emoji pack.
   * Called once per profile load/update - not on every render.
   */
  resolveDisplayNameParts(displayName: string | any[], pinnedEmojis?: Array<{ id: string; name: string; url: string }>): DisplayNamePart[] | undefined {
    if (!displayName) return undefined

    if (typeof displayName !== 'string') {
      if (Array.isArray(displayName)) return displayName as DisplayNamePart[]
      return undefined
    }

    EMOJI_SHORTCODE_TEST_REGEX.lastIndex = 0
    if (!EMOJI_SHORTCODE_TEST_REGEX.test(displayName)) return undefined

    // Trigger lazy load of emoji data if not loaded - reResolveAllDisplayNames()
    // will be called automatically when the load completes (see unifiedEmojiService)
    if (!unifiedEmojiLoaded.value) {
      loadEmojiData().catch(() => {})
    }

    const pinnedMap = new Map<string, { id: string; name: string; url: string }>()
    if (pinnedEmojis) {
      for (const e of pinnedEmojis) {
        pinnedMap.set(e.name, e)
      }
    }

    const parts: DisplayNamePart[] = []
    const pendingDbTokens: string[] = []
    let lastIndex = 0
    let match: RegExpExecArray | null

    // Fresh regex per call - never share `g`-flag regexes with `.exec()` loops
    // (see emojiShortcodeResolver.createShortcodeRegex for rationale).
    const matcher = createShortcodeRegex()
    while ((match = matcher.exec(displayName)) !== null) {
      const token = match[1]
      const parsed = parseEmojiShortcodeToken(token)

      if (match.index > lastIndex) {
        parts.push({ type: 'text', text: displayName.substring(lastIndex, match.index) })
      }

      const pinned =
        pinnedMap.get(parsed.token) ??
        pinnedMap.get(parsed.baseName)

      let emojiPart: { id: string; name: string; url: string } | null = null
      if (pinned?.url) {
        emojiPart = { id: pinned.id || pinned.name || '', name: pinned.name, url: pinned.url }
      } else {
        const fromCache = findCustomEmojiInCache(parsed.token) ?? getDbCachedEmoji(parsed.token)
        if (fromCache?.url) {
          emojiPart = { id: fromCache.id, name: fromCache.name, url: fromCache.url }
        } else {
          emojiPart = resolveUnifiedEmojiDisplay(parsed.baseName)
        }
      }

      if (emojiPart?.url) {
        parts.push({ type: 'emoji', emoji: emojiPart })
      } else {
        parts.push({ type: 'text', text: match[0] })
        // Only enqueue tokens we haven't already proven absent - prevents
        // ensureCustomEmojisResolved → reResolveAllDisplayNames loops.
        if (!parsed.isUuid && !isDbMissCached(parsed.token)) {
          pendingDbTokens.push(parsed.token)
        }
      }

      lastIndex = match.index + match[0].length
    }

    if (lastIndex < displayName.length) {
      parts.push({ type: 'text', text: displayName.substring(lastIndex) })
    }

    if (pendingDbTokens.length > 0) {
      ensureCustomEmojisResolved(pendingDbTokens)
        .then(resolved => {
          // Only trigger re-resolve if at least one token actually loaded;
          // otherwise we'd loop forever on legitimately-missing emojis.
          if (resolved > 0) this.reResolveAllDisplayNames()
        })
        .catch(() => {})
    }

    const hasEmoji = parts.some(p => p.type === 'emoji')
    return hasEmoji ? parts : undefined
  }

  /**
   * Re-resolve display name parts for all cached users.
   * Called when the emoji cache updates (emoji renamed/deleted/added).
   */
  reResolveAllDisplayNames(): void {
    let changed = false
    for (const [_userId, userData] of this.users) {
      const newParts = this.resolveDisplayNameParts(userData.displayName, userData.displayNameEmojis)
      const hadParts = !!userData.displayNameParts
      const hasParts = !!newParts
      if (hadParts !== hasParts || JSON.stringify(userData.displayNameParts) !== JSON.stringify(newParts)) {
        userData.displayNameParts = newParts
        changed = true
      }
    }
    if (changed) {
      this.emitEvent('user-updated', { reason: 'emoji-cache-changed' })
    }
  }

  // No-op: used to re-track on route changes, but that caused join/leave churn.
  // Presence stays tracked after initial connection; only status/profile changes should update it.
  async refreshGlobalPresence(): Promise<void> {
  }

  async cleanup(): Promise<void> {
    debug.log('Cleaning up User Data Service')
    
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    realtimeApiService.goOffline().catch(() => {})
    realtimeApiService.cleanup()

    if (this.customStatusExpiryTimer) {
      clearTimeout(this.customStatusExpiryTimer)
      this.customStatusExpiryTimer = null
    }
    
    // Unsubscribe from all contexts (also cancel any pending presence-error
    // retry timers - BUGS.md C14 v2; see unsubscribeFromContext for context).
    for (const context of this.contexts.values()) {
      if ((context as any)._presenceRetryTimer) {
        clearTimeout((context as any)._presenceRetryTimer)
        ;(context as any)._presenceRetryTimer = null
      }
      if (context.channel) {
        await context.channel.unsubscribe()
      }
    }
    
    if (this.globalChannel) {
      await this.globalChannel.unsubscribe()
      this.globalChannel = null
    }

    // Clear the beforeunload presence-cleanup hook installed by
    // `setupGlobalPresence` (BUGS.md H31) - otherwise a logout followed by a
    // tab close would call untrack against a service that's already torn
    // down. Safe to noop-delete; the next sign-in will re-install it.
    if (typeof window !== 'undefined' && (window as any).__harmonyPresenceCleanup) {
      delete (window as any).__harmonyPresenceCleanup
    }
    
    this.users.clear()
    this.contexts.clear()
    this.currentUserId = null
    this.initialized = false
    
    debug.log('User Data Service cleaned up')
  }
  
  /**
   * Force refresh of all data
   */
  async refresh(): Promise<void> {
    debug.log('Refreshing all user data')
    
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
    debug.log('User data refreshed')
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
  // triggerPresenceSync removed - there's no per-server presence state to
  // sync anymore. If a caller needs to force-refresh user data for a
  // context, they should call `refresh()` (which re-loads from DB) or
  // `refreshGlobalPresence()` (which re-syncs the global presence state).

  
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
   * Re-track presence after avatar/banner changes so other clients don't keep
   * seeing stale media from an old track payload.
   *
   * Only the global presence channel needs re-tracking now; per-server
   * channels are broadcast-only and don't carry our presence payload.
   */
  private async refreshPresenceMediaFields(): Promise<void> {
    await this.trackCurrentUserGlobally()
  }

  /**
   * Untrack current user from presence (for invisible status).
   *
   * Only the global channel carries our presence payload now; per-server
   * channels are broadcast-only and have nothing to untrack.
   */
  private async untrackFromAllPresenceChannels(): Promise<void> {
    if (!this.currentUserId) return

    if (this.globalChannel) {
      try {
        await this.globalChannel.untrack()
        debug.log('Untracked from global presence channel')
      } catch (error) {
        debug.warn('Failed to untrack from global presence:', error)
      }
    }

    debug.log('User is now invisible to all other users')
  }
}

export const userDataService = new UserDataService()