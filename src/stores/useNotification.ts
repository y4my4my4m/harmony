import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import router from '@/router'
import { useAuthStore } from './auth'
import { viewContextTracker } from '@/services/ViewContextTracker'
import { NotificationFormatter } from '@/services/NotificationFormatter'
import { getEmojiUrl } from '@/utils/emojiUtils'
import { services } from '@/services'
import { authContextService } from '@/services/AuthContextService'
import { userDataService } from '@/services/userDataService'
import { userEventChannel } from '@/services/UserEventChannel'
import { debug } from '@/utils/debug'
import { updateFaviconBadge } from '@/utils/faviconBadge'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import type { 
  Notification, 
  NotificationType,
  NotificationPreferences,
  NotificationToast,
  AudioAction
} from '@/types'

/**
 * Shape returned by the `notificationCounts` getter. Hoisted to an
 * exported interface so dependent getters can reference it cleanly
 * (vue-tsc/Pinia's inference for cross-getter `this` access struggles
 * with inline anonymous return types).
 */
export interface NotificationCounts {
  total: number
  unread: number
  unreadMentions: number
  unreadDMs: number
  mentionsAll: number
  dms: number
  reactions: number
  social: number
  follows: number
  unreadChannelMentions: Map<string, number>
  unreadServerMentions: Map<string, number>
  unreadConversationMentions: Map<string, number>
}

interface NotificationState {
  notifications: Notification[]
  unreadCount: number
  isLoading: boolean
  lastFetchedAt: Date | null
  preferences: NotificationPreferences | null
  isDndActive: boolean
  toasts: NotificationToast[]
  lastNotificationTime: Map<string, number>
  isInitialized: boolean
  fullListLoaded: boolean
  hasPermission: boolean
  currentFilter: string
  cachedProfileId: string | null
  cachedAuthUserId: string | null
}

// Sound mappings for different notification types to audio actions
const NOTIFICATION_SOUND_MAPPING: Record<NotificationType, AudioAction> = {
  mention: 'mention',
  dm: 'dm', 
  chat_message: 'dm',
  reaction: 'reaction',
  reply: 'reply',
  thread_reply: 'reply',
  voice_channel_activity: 'voice_channel_activity',
  server_invite: 'server_invite',
  friend_request: 'friend_request',
  server_update: 'server_update',
  emoji_added: 'emoji_added',
  activitypub_follow: 'friend_request',
  activitypub_favorite: 'reaction',
  activitypub_reblog: 'reaction',
  activitypub_reaction: 'reaction',
  activitypub_mention: 'mention',
  activitypub_reply: 'reply',
  activitypub_follow_request: 'friend_request',
  report_update: 'server_update',
  error: 'server_update',
}

// Default notification preferences
const DEFAULT_PREFERENCES: Omit<NotificationPreferences, 'id' | 'user_id' | 'created_at' | 'updated_at'> = {
  desktop_notifications: true,
  desktop_mentions: true,
  desktop_dms: true,
  desktop_reactions: true,
  desktop_replies: true,
  desktop_chat_messages: true,
  sound_notifications: true,
  sound_mentions: true,
  sound_dms: true,
  sound_reactions: true,
  sound_replies: true,
  sound_chat_messages: true,
  sound_voice_activity: true,
  push_notifications: true,
  push_mentions: true,
  push_dms: true,
  push_offline_only: true,
  email_notifications: false,
  email_digest: false,
  email_digest_frequency: 'weekly' as const,
  dnd_enabled: false,
  dnd_start_time: '22:00:00',
  dnd_end_time: '08:00:00',
  
  // ActivityPub notifications
  activitypub_notifications: true,
  activitypub_follows: true,
  activitypub_favorites: true,
  activitypub_reblogs: true,
  activitypub_mentions: true,
  activitypub_replies: true,
  activitypub_follow_requests: true,
  
  // ActivityPub desktop notifications
  activitypub_desktop_notifications: true,
  activitypub_desktop_follows: true,
  activitypub_desktop_favorites: false,
  activitypub_desktop_reblogs: false,
  activitypub_desktop_mentions: true,
  activitypub_desktop_replies: true,
  
  // ActivityPub sound notifications
  activitypub_sound_notifications: true,
  activitypub_sound_follows: true,
  activitypub_sound_favorites: false,
  activitypub_sound_reblogs: false,
  activitypub_sound_mentions: true,
  activitypub_sound_replies: true
}

// Unsubscribe functions for UserEventChannel handlers (module-level to avoid
// polluting Pinia serializable state).
let _unsubNewNotification: (() => void) | null = null
let _unsubUpdateNotification: (() => void) | null = null
let _unsubBulkRead: (() => void) | null = null
let _unsubPrefsUpdated: (() => void) | null = null
let _unsubReconnected: (() => void) | null = null
let _dndInterval: ReturnType<typeof setInterval> | null = null
// Track notification IDs recently processed to deduplicate
const _recentlyProcessedIds = new Set<string>()
const DEDUP_TTL_MS = 10_000

export const useNotificationStore = defineStore('notification', {
  state: (): NotificationState => ({
    notifications: [],
    unreadCount: 0,
    isLoading: false,
    lastFetchedAt: null,
    preferences: null,
    isDndActive: false,
    toasts: [],
    lastNotificationTime: new Map(),
    isInitialized: false,
    fullListLoaded: false,
    hasPermission: false,
    currentFilter: 'all',
    cachedProfileId: null,
    cachedAuthUserId: null,
  }),

  getters: {
    sortedNotifications: (state) => {
      return [...state.notifications].sort((a, b) => {
        // Unread notifications first
        if (a.is_read !== b.is_read) {
          return a.is_read ? 1 : -1
        }
        // Then by creation date (newest first)
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      })
    },

    /**
     * Single-pass projection of the notifications array into the counters
     * the rest of the UI needs. Replaces 5+ separate `filter().length`
     * getters that each scanned the full array (BUGS.md PC5).
     *
     * For parameterized counts (per-channel, per-server, per-conversation)
     * we build Maps so callers do an O(1) lookup instead of an O(n) scan.
     * Maps and primitive counters here are recomputed by Pinia/Vue only
     * when `state.notifications` changes, so dependents that read multiple
     * counts in one frame share a single full scan.
     */
    notificationCounts(): NotificationCounts {
      const total = this.notifications.length
      let unread = 0
      let unreadMentions = 0          // activitypub_mention only (matches legacy `unreadMentions` getter)
      let unreadDMs = 0
      let mentionsAll = 0             // mention OR activitypub_mention
      let dms = 0
      let reactions = 0
      let social = 0
      let follows = 0

      const unreadChannelMentions = new Map<string, number>()
      const unreadServerMentions = new Map<string, number>()
      const unreadConversationMentions = new Map<string, number>()

      const bumpMap = (m: Map<string, number>, key: string | undefined | null) => {
        if (!key) return
        m.set(key, (m.get(key) ?? 0) + 1)
      }

      for (const n of this.notifications) {
        const isMention = n.type === 'mention'
        const isApMention = n.type === 'activitypub_mention'
        const isDM = n.type === 'dm'
        const isReaction = n.type === 'reaction'
        const isFollow = n.type === 'activitypub_follow' || n.type === 'activitypub_follow_request'
        const isSocial = typeof n.type === 'string' && n.type.startsWith('activitypub_')

        if (isMention || isApMention) mentionsAll++
        if (isDM) dms++
        if (isReaction) reactions++
        if (isSocial) social++
        if (isFollow) follows++

        if (!n.is_read) {
          unread++
          if (isApMention) unreadMentions++
          if (isDM) unreadDMs++
          if (isMention) {
            // The legacy getters used `||` between top-level and nested
            // forms, which means a notification carrying BOTH
            // `data.channel_id = X` AND `data.location.channel_id = Y`
            // (with X !== Y) would count for both X and Y. We preserve
            // that semantics here by bumping both keys when they differ,
            // rather than collapsing via `??` which would count only one.
            // BUGS.md M3 from code review.
            const cid = n.data?.channel_id
            const cidLoc = n.data?.location?.channel_id
            if (cid) bumpMap(unreadChannelMentions, cid)
            if (cidLoc && cidLoc !== cid) bumpMap(unreadChannelMentions, cidLoc)

            const sid = n.data?.server_id
            const sidLoc = n.data?.location?.server_id
            if (sid) bumpMap(unreadServerMentions, sid)
            if (sidLoc && sidLoc !== sid) bumpMap(unreadServerMentions, sidLoc)
          }
          if (isMention || isDM) {
            const cv = n.data?.conversation_id
            const cvNested = n.data?.conversation?.id
            if (cv) bumpMap(unreadConversationMentions, cv)
            if (cvNested && cvNested !== cv) bumpMap(unreadConversationMentions, cvNested)
          }
        }
      }

      return {
        total,
        unread,
        unreadMentions,
        unreadDMs,
        mentionsAll,
        dms,
        reactions,
        social,
        follows,
        unreadChannelMentions,
        unreadServerMentions,
        unreadConversationMentions,
      }
    },

    filteredNotifications(): Notification[] {
      if (this.currentFilter === 'all') {
        return this.sortedNotifications
      }
      
      return this.sortedNotifications.filter((notification: Notification) => {
        switch (this.currentFilter) {
          case 'unread':
            return !notification.is_read
          case 'mentions':
            return notification.type === 'mention' || notification.type === 'activitypub_mention'
          case 'dms':
            return notification.type === 'dm'
          case 'reactions':
            return notification.type === 'reaction'
          case 'social':
            return notification.type.startsWith('activitypub_')
          case 'follows':
            return notification.type === 'activitypub_follow' || notification.type === 'activitypub_follow_request'
          default:
            return true
        }
      })
    },

    // Per-type unread counts. These now read from the single-pass
    // `notificationCounts` projection above instead of each running their
    // own full-array scan.
    //
    // The `(this as any).notificationCounts` cast is a workaround for a
    // vue-tsc / Pinia type-inference limitation: when one method-form
    // getter references another via `this`, TypeScript surfaces the
    // getter as its raw `() => T` function type instead of unwrapping
    // to `T`. At runtime Pinia unwraps correctly. Tracking issue in
    // upstream vue-tsc.

    unreadMentions(): number {
      return (this as any).notificationCounts.unreadMentions
    },

    unreadDMs(): number {
      return (this as any).notificationCounts.unreadDMs
    },

    unreadChannelMentions(): (channelId: string) => number {
      const map: Map<string, number> = (this as any).notificationCounts.unreadChannelMentions
      return (channelId: string) => map.get(channelId) ?? 0
    },

    unreadServerMentions(): (serverId: string) => number {
      const map: Map<string, number> = (this as any).notificationCounts.unreadServerMentions
      return (serverId: string) => map.get(serverId) ?? 0
    },

    unreadConversationMentions(): (conversationId: string) => number {
      const map: Map<string, number> = (this as any).notificationCounts.unreadConversationMentions
      return (conversationId: string) => map.get(conversationId) ?? 0
    },

    isQuietHours: (state) => {
      if (!state.preferences?.dnd_enabled) return false

      const now = new Date()
      const currentTime = now.getHours() * 60 + now.getMinutes()

      // DND times are stored as UTC; convert to local minutes for comparison
      const startTime = utcTimeStringToLocalMinutes(state.preferences.dnd_start_time)
      const endTime = utcTimeStringToLocalMinutes(state.preferences.dnd_end_time)

      if (startTime > endTime) {
        return currentTime >= startTime || currentTime <= endTime
      }

      return currentTime >= startTime && currentTime <= endTime
    },

    shouldShowDesktopNotification: (state) => {
      return (type: NotificationType) => {
        const store = useNotificationStore()
        if (!state.preferences?.desktop_notifications || store.isQuietHours) return false
        
        switch (type) {
          case 'mention':
            return state.preferences.desktop_mentions
          case 'dm':
            return state.preferences.desktop_dms
          case 'reaction':
            return state.preferences.desktop_reactions
          case 'reply':
            return state.preferences.desktop_replies
          
          // ActivityPub desktop notifications
          case 'activitypub_follow':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_follows
          case 'activitypub_favorite':
          case 'activitypub_reaction':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_favorites
          case 'activitypub_reblog':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_reblogs
          case 'activitypub_mention':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_mentions
          case 'activitypub_reply':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_replies
          case 'activitypub_follow_request':
            return state.preferences.activitypub_desktop_notifications && state.preferences.activitypub_desktop_follows
          
          default:
            return true
        }
      }
    },

    shouldPlaySound: (state) => {
      return (type: NotificationType) => {
        const store = useNotificationStore()
        if (!state.preferences?.sound_notifications || store.isQuietHours) return false
        
        switch (type) {
          case 'mention':
            return state.preferences.sound_mentions
          case 'dm':
            return state.preferences.sound_dms
          case 'reaction':
            return state.preferences.sound_reactions
          case 'voice_channel_activity':
            return state.preferences.sound_voice_activity
          
          // ActivityPub sound notifications
          case 'activitypub_follow':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_follows
          case 'activitypub_favorite':
          case 'activitypub_reaction':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_favorites
          case 'activitypub_reblog':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_reblogs
          case 'activitypub_mention':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_mentions
          case 'activitypub_reply':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_replies
          case 'activitypub_follow_request':
            return state.preferences.activitypub_sound_notifications && state.preferences.activitypub_sound_follows
          
          default:
            return true
        }
      }
    },

    notificationFilters() {
      // Counts come from the single-pass `notificationCounts` projection so
      // a single read of this getter no longer triggers five separate
      // O(n) scans of `notifications`. The `as any` cast is the same
      // vue-tsc workaround documented on the per-type getters above.
      const c: NotificationCounts = (this as any).notificationCounts
      return [
        {
          key: 'all',
          label: 'All',
          icon: 'list',
          count: c.total
        },
        {
          key: 'unread',
          label: 'Unread',
          icon: 'circle',
          count: c.unread
        },
        {
          key: 'mentions',
          label: 'Mentions',
          icon: 'at-sign',
          count: c.mentionsAll
        },
        {
          key: 'dms',
          label: 'Messages',
          icon: 'message-circle',
          count: c.dms
        },
        {
          key: 'social',
          label: 'Social',
          icon: 'globe',
          count: c.social
        },
        {
          key: 'follows',
          label: 'Follows',
          icon: 'users',
          count: c.follows
        }
      ]
    }
  },

  actions: {
    /**
     * Initialize notification system - Discord-like client setup
     * Database handles all notification creation via triggers
     */
    async initialize(userId: string) {
      if (this.isInitialized) return
      
      try {
        this.isLoading = true
        debug.log('🔔 Notification Store: Initializing for user:', userId)
        
        // Check notification permission first
        this.hasPermission = await this.checkNotificationPermission()
        
        // Load user preferences
        await this.loadPreferences(userId)
        
        // Load existing notifications
        await this.fetchNotifications(userId)
        
        // Register handlers on the shared broadcast channel
        this.setupBroadcastNotificationHandlers(userId)
        
        // Setup DND status check
        this.setupDndCheck()
        
        this.isInitialized = true
        debug.log('✅ Notification Store: Initialized successfully')
      } catch (error) {
        debug.error('❌ Notification Store: Failed to initialize:', error)
        this.showToast('server_update', 'Failed to load notifications', 'Please refresh the page', 5000)
      } finally {
        this.isLoading = false
      }
    },

    /**
     * Initialize notification store: loads unread notifications for badge computation
     * and sets up realtime subscription for new notifications.
     */
    async initializeUnreadCountOnly(userId: string) {
      if (this.isInitialized) return
      
      try {
        debug.log('🔔 Notification Store: Initializing with unread notifications')
        
        // Check notification permission
        this.hasPermission = await this.checkNotificationPermission()
        
        // Load user preferences (lightweight)
        await this.loadPreferences(userId)
        
        // Get profile ID for queries
        const profileId = await this.getProfileId(userId)
        
        // Load unread notifications so sidebar badge getters (unreadDMs,
        // unreadServerMentions, ActivityPub count) work immediately on page load.
        try {
          const { data, error } = await supabase
            .from('notifications')
            .select('id, type, is_read, data, created_at, user_id')
            .eq('user_id', profileId)
            .eq('is_read', false)
            .order('created_at', { ascending: false })
            .limit(200)

          if (error) {
            debug.error('Failed to load unread notifications:', error)
          } else {
            this.notifications = (data || []) as any
            debug.log(`✅ Loaded ${this.notifications.length} unread notifications for badges`)
          }
        } catch (err) {
          debug.error('Failed to load unread notifications:', err)
        }
        
        this.updateUnreadCount()
        
        // Register handlers on the shared broadcast channel
        this.setupBroadcastNotificationHandlers(userId)
        
        // Setup DND status check
        this.setupDndCheck()
        
        this.isInitialized = true
        debug.log('✅ Notification Store: Initialization complete')
      } catch (error) {
        debug.error('❌ Notification Store: Failed to initialize:', error)
        this.unreadCount = 0
      }
    },

    /**
     * Load full notification list including read ones (called when notification panel is opened)
     */
    async loadFullNotificationList(userId: string) {
      if (this.fullListLoaded) {
        debug.log('📝 Full notification list already loaded')
        return
      }
      
      try {
        this.isLoading = true
        debug.log('📝 Loading full notification list...')
        await this.fetchNotifications(userId)
        this.fullListLoaded = true
        debug.log('✅ Full notification list loaded')
      } catch (error) {
        debug.error('❌ Failed to load full notification list:', error)
      } finally {
        this.isLoading = false
      }
    },

    async fetchNotifications(userId: string, limit = 50, offset = 0) {
      try {
        debug.log('🔄 Fetching notifications for user:', userId)
        
        // Get the profile ID for this auth user ID
        const profileId = await this.getProfileId(userId)
        
        // Use NotificationService for consistent notification management
        const data = await services.notifications.fetchNotifications(profileId, {
          limit,
          offset
        })

        debug.log(`✅ Fetched ${data?.length || 0} notifications`)
        
        if (offset === 0) {
          this.notifications = data || []
        } else {
          this.notifications.push(...(data || []))
        }

        // Prime user cache so NotificationItem DisplayName can resolve custom emojis
        const actorIds = (data || []).flatMap((n: Notification) => {
          const d = n.data
          const id = d?.from_user_id ?? d?.sender?.user_id ?? d?.reactor?.user_id ?? d?.reactor?.id ?? d?.inviter?.user_id
          return id && typeof id === 'string' ? [id] : []
        })
        if (actorIds.length) userDataService.ensureUsersLoaded([...new Set(actorIds)]).catch(() => {})

        this.updateUnreadCount()
        this.lastFetchedAt = new Date()

        return data || []
      } catch (error) {
        debug.error('❌ Failed to fetch notifications:', error)
        
        // Fallback to direct query if service fails
        try {
          debug.log('🔄 Falling back to direct notification fetch')
          await this._fetchNotificationsFallback(userId, limit, offset)
        } catch (fallbackError) {
          debug.error('❌ Fallback fetch also failed:', fallbackError)
          // Create mock notifications for development/testing
          if (import.meta.env.DEV) {
            this.createMockNotifications(userId)
          }
        }
        throw error
      }
    },

    /**
     * Fallback method for fetching notifications
     */
    async _fetchNotificationsFallback(userId: string, limit = 50, offset = 0) {
      const profileId = await this.getProfileId(userId)
      
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', profileId)
        .order('created_at', { ascending: false })
        .limit(limit)

      if (error) throw error

      if (offset === 0) {
        this.notifications = data || []
      } else {
        this.notifications.push(...(data || []))
      }

      // Prime user cache so NotificationItem DisplayName can resolve custom emojis
      const actorIds = (data || []).flatMap((n: Notification) => {
        const d = n.data
        const id = d?.from_user_id ?? d?.sender?.user_id ?? d?.reactor?.user_id ?? d?.reactor?.id ?? d?.inviter?.user_id
        return id && typeof id === 'string' ? [id] : []
      })
      if (actorIds.length) userDataService.ensureUsersLoaded([...new Set(actorIds)]).catch(() => {})

      this.updateUnreadCount()
      this.lastFetchedAt = new Date()

      return data || []
    },

    /**
     * DUAL-MODE NOTIFICATION SUBSCRIPTION
     *
     * Sets up two parallel listeners for maximum reliability:
     *
     * 1. Broadcast handler - via UserEventChannel (realtime.send() from DB triggers).
     *    Lower latency, fewer channels, but depends on realtime.send() working.
     *
     * 2. postgres_changes fallback - classic CDC subscription on the notifications
     *    table.  Always works if the table is in the supabase_realtime publication.
     *
     * Both paths funnel through _processIncomingNotification / _processNotificationUpdate
     * which deduplicate by notification ID so double-delivery is harmless.
     */
    async setupBroadcastNotificationHandlers(userId: string) {
      if (_unsubNewNotification) {
        debug.log('✅ Notification handlers already registered, skipping')
        return
      }

      const profileId = await this.getProfileId(userId)
      debug.log('🔔 Setting up dual-mode notification handlers for profile:', profileId)

      // ---- 1. Broadcast handlers (best-effort, low latency) ----
      if (!_unsubNewNotification) {
        userEventChannel.connect(profileId)

        _unsubNewNotification = userEventChannel.on('notification:new', async (data) => {
          try {
            const n = data.notification as Notification
            if (!n?.id) return
            debug.log('📡 Broadcast notification:new →', n.id)
            await this._processIncomingNotification(n)
          } catch (error) {
            debug.error('❌ Broadcast notification:new error:', error)
          }
        })

        _unsubUpdateNotification = userEventChannel.on('notification:update', async (data) => {
          try {
            this._processNotificationUpdate(data.id as string, data.is_read as boolean)
          } catch (error) {
            debug.error('❌ Broadcast notification:update error:', error)
          }
        })

        _unsubBulkRead = userEventChannel.on('notification:bulk_read', (_data) => {
          debug.log('📡 Bulk read event received, marking all notifications as read locally')
          this.notifications.forEach(n => { n.is_read = true })
          this.updateUnreadCount()
        })

        _unsubPrefsUpdated = userEventChannel.on('preferences:updated', () => {
          debug.log('📡 Preferences updated on another tab/device, reloading...')
          // Prefer profile id (the column the row is keyed on). Fall back to
          // the auth id only as a last resort - loadPreferences resolves
          // either to a profile id internally.
          const id = this.cachedProfileId || this.cachedAuthUserId
          if (id) {
            this.loadPreferences(id)
          }
        })

        _unsubReconnected = userEventChannel.on('_reconnected', async () => {
          debug.log('🔄 UserEventChannel reconnected - gap-filling notifications')
          await this.fetchNotifications(profileId)
        })

        debug.log('✅ Broadcast notification handlers registered')
      }

    },

    /**
     * Shared processing for a new notification arriving from either broadcast or CDC.
     * Deduplicates by ID so double-delivery from both paths is harmless.
     */
    async _processIncomingNotification(newNotification: Notification) {
      if (!newNotification?.id) return

      // Dedup: skip if already processed recently or already in store
      if (_recentlyProcessedIds.has(newNotification.id)) return
      if (this.notifications.find(n => n.id === newNotification.id)) return

      // Mark as processed and schedule TTL cleanup
      _recentlyProcessedIds.add(newNotification.id)
      setTimeout(() => _recentlyProcessedIds.delete(newNotification.id), DEDUP_TTL_MS)

      const notifData = newNotification.data || {}
      const notificationContext = {
        server_id: notifData.location?.server_id || notifData.server_id,
        channel_id: notifData.location?.channel_id || notifData.channel_id,
        conversation_id: notifData.conversation?.id || notifData.conversation_id || notifData.location?.conversation_id,
        type: newNotification.type
      }

      let activeConversationId: string | undefined
      if (!notificationContext.conversation_id && newNotification.type === 'dm') {
        try {
          const { useDMStore } = await import('./useDM')
          const dmStore = useDMStore()
          activeConversationId = dmStore.currentConversationId || undefined
        } catch { /* DM store may not be loaded */ }
      }

      const uiDecision = viewContextTracker.shouldShowNotificationUI(notificationContext, activeConversationId)

      if (!uiDecision.showToast && !uiDecision.showDesktop && !uiDecision.playSound) {
        newNotification.is_read = true
        this.notifications.unshift(newNotification)
        services.notifications.markAsRead(newNotification.id).catch(() => {})
        return
      }

      if (this.isQuietHours && newNotification.type !== 'server_update') {
        this.notifications.unshift(newNotification)
        this.updateUnreadCount()
        return
      }

      this.notifications.unshift(newNotification)
      this.updateUnreadCount()

      const formatted = NotificationFormatter.formatNotification(newNotification)
      this.handleRealtimeNotification(newNotification, formatted, uiDecision)
    },

    /**
     * Shared processing for a notification update (read state change).
     * Deduplicates so double-delivery from both paths is harmless.
     */
    _processNotificationUpdate(id: string, isRead: boolean) {
      if (!id) return
      const existing = this.notifications.find(n => n.id === id)
      if (!existing) return
      if (existing.is_read === isRead) return

      debug.log('🔄 Notification read state synced:', id, 'is_read:', isRead)
      existing.is_read = isRead
      this.updateUnreadCount()

      if (isRead) {
        this.dismissSystemNotification(existing)
      }
    },

    /**
     * Unregister notification handlers and tear down fallback channel.
     * Does NOT disconnect the UserEventChannel (other consumers may still use it).
     */
    cleanupBroadcastHandlers() {
      if (_unsubNewNotification) { _unsubNewNotification(); _unsubNewNotification = null }
      if (_unsubUpdateNotification) { _unsubUpdateNotification(); _unsubUpdateNotification = null }
      if (_unsubBulkRead) { _unsubBulkRead(); _unsubBulkRead = null }
      if (_unsubPrefsUpdated) { _unsubPrefsUpdated(); _unsubPrefsUpdated = null }
      if (_unsubReconnected) { _unsubReconnected(); _unsubReconnected = null }
      // BUGS.md M11: the DND check `setInterval` used to live until tab close
      // because nothing in the cleanup path cleared `_dndInterval`. Stopping
      // it here ensures it doesn't keep firing after logout / store reset.
      if (_dndInterval) {
        clearInterval(_dndInterval)
        _dndInterval = null
      }
      _recentlyProcessedIds.clear()
    },


    /**
     * Handle realtime notification through unified notification system
     * This method processes incoming notifications from database triggers
     * and determines the appropriate UI actions based on user context
     */
    handleRealtimeNotification(
      notification: Notification, 
      formatted: any, 
      uiDecision: any
    ) {
      try {
        debug.log('🔔 Processing notification:', notification.type)

        // Show toast notification if appropriate
        if (uiDecision.showToast) {
          // Extract emoji data for reaction notifications
          let emojiUrl: string | undefined
          let emojiName: string | undefined
          if (notification.type === 'activitypub_reaction' || notification.type === 'reaction') {
            const data = notification.data
            const reactionData = data.reaction || data
            
            // Try multiple paths for emoji data
            emojiName = reactionData?.emoji_name || reactionData?.custom_emoji_content || data.emoji_name
            emojiUrl = reactionData?.emoji_url || data.emoji_url
            
            // Get emoji URL if available
            if (emojiUrl) {
              emojiUrl = getEmojiUrl(emojiUrl, 48)
            }
          }
          
          const actorInfo = NotificationFormatter.getActorInfo(notification)
          this.showToast(
            notification.type,
            formatted.title,
            formatted.message,
            4000,
            NotificationFormatter.getAvatarUrl(notification),
            emojiUrl,
            emojiName,
            actorInfo?.actorUserId,
            actorInfo?.titleSuffix,
            notification.id
          )
        }

        // Show desktop notification if appropriate
        if (uiDecision.showDesktop && this.shouldShowDesktopNotification(notification.type)) {
          this.showDesktopNotification(notification, formatted)
        }

        // Play sound if appropriate
        if (uiDecision.playSound && this.shouldPlaySound(notification.type)) {
          this.playNotificationSound(notification.type)
        }

        debug.log('✅ Notification processed successfully')
      } catch (error) {
        debug.error('❌ Error processing notification:', error)
        // Fallback: show minimal toast notification
        this.showToast(
          'server_update',
          'New notification',
          'A notification was received but could not be processed properly',
          3000
        )
      }
    },

    /**
     * Updated desktop notification method to use formatted messages
     */
    async showDesktopNotification(notification: Notification, formatted?: any) {
      try {
        if (typeof Notification === 'undefined') {
          return
        }

        if (Notification.permission !== 'granted') {
          return
        }

        // Only show desktop notifications when the tab is hidden/inactive
        // (in-app toasts handle notifications while the tab is visible)
        if (!document.hidden) {
          return
        }

        // Use formatter if not provided
        if (!formatted) {
          formatted = NotificationFormatter.formatNotification(notification)
        }

        // Use per-context tags so new notifications from the same source replace the previous one
        // instead of stacking up (e.g., multiple DMs from the same conversation)
        const contextTag = notification.data?.conversation_id
          ? `harmony-${notification.type}-conv-${notification.data.conversation_id}`
          : notification.data?.channel_id
            ? `harmony-${notification.type}-ch-${notification.data.channel_id}`
            : `harmony-${notification.type}-${notification.id}`

        const notificationOptions = {
          body: formatted.message,
          icon: NotificationFormatter.getAvatarUrl(notification),
          badge: '/img/app_icon_badge.png',
          tag: contextTag,
          renotify: true,
          silent: false,
          data: {
            notificationId: notification.id,
            type: notification.type,
            url: this.getNotificationUrl(notification)
          }
        }

        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          const registration = await navigator.serviceWorker.ready
          await registration.showNotification(formatted.title, {
            ...notificationOptions,
            requireInteraction: false
          })
          debug.log(`✅ Desktop notification shown via SW for ${notification.type}`)
        } else {
          const desktopNotification = new window.Notification(formatted.title, {
            ...notificationOptions,
            requireInteraction: false
          })

          desktopNotification.onclick = () => {
            window.focus()
            this.handleNotificationClick(notification)
            desktopNotification.close()
          }

          const timeout = (notification.type === 'mention' || notification.type === 'dm') ? 12000 : 8000
          setTimeout(() => desktopNotification.close(), timeout)

          debug.log(`✅ Desktop notification shown for ${notification.type}`)
        }
      } catch (error) {
        debug.error('❌ Error showing desktop notification:', error)
      }
    },

    /**
     * Dismiss system (OS-level) notifications matching a notification that was read on another device.
     * Closes matching notifications shown via the service worker's showNotification API.
     */
    async dismissSystemNotification(notification: Notification) {
      try {
        if (!('serviceWorker' in navigator)) return
        
        const registration = await navigator.serviceWorker.ready
        const shown = await registration.getNotifications()
        
        for (const sysNotif of shown) {
          const matchesId = sysNotif.data?.notificationId === notification.id
          const matchesConversation = notification.data?.conversation_id &&
            sysNotif.tag?.includes(`conv-${notification.data.conversation_id}`)
          const matchesChannel = notification.data?.channel_id &&
            sysNotif.tag?.includes(`ch-${notification.data.channel_id}`)
          
          if (matchesId || matchesConversation || matchesChannel) {
            sysNotif.close()
            debug.log('🔕 Dismissed system notification synced from another device:', sysNotif.tag)
          }
        }
        
        // Update badge after dismissals
        if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
          const remaining = await registration.getNotifications()
          if (remaining.length > 0) {
            ;(navigator as any).setAppBadge(remaining.length)
          } else {
            ;(navigator as any).clearAppBadge()
          }
        }
      } catch (error) {
        debug.error('❌ Error dismissing system notification:', error)
      }
    },

    showToast(
      type: NotificationType,
      title: string,
      message: string,
      duration = 4000,
      avatar?: string,
      emojiUrl?: string,
      emojiName?: string,
      actorUserId?: string,
      titleSuffix?: string,
      notificationId?: string
    ) {
      if (this.isQuietHours && type !== 'server_update') return
      
      const toast: NotificationToast = {
        id: `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type,
        title,
        message,
        avatar,
        emojiUrl,
        emojiName,
        actorUserId,
        titleSuffix,
        duration,
        timestamp: new Date(),
        notificationId
      }
      
      this.toasts.push(toast)
      
      // Auto-remove toast after duration
      setTimeout(() => {
        this.removeToast(toast.id)
      }, duration)
    },

    removeToast(toastId: string) {
      const index = this.toasts.findIndex(t => t.id === toastId)
      if (index >= 0) {
        this.toasts.splice(index, 1)
      }
    },

    async playNotificationSound(type: NotificationType) {
      try {
        if (!this.shouldPlaySound(type)) return

        const audioAction = NOTIFICATION_SOUND_MAPPING[type]
        if (!audioAction) return

        // Get theme store for audio playback
        const { useThemeStore } = await import('./useTheme')
        const themeStore = useThemeStore()
        
        // Ensure theme system is initialized
        if (!themeStore.isInitialized) {
          await themeStore.initialize()
        }
        
        await themeStore.playAudio(audioAction)
        
        debug.log(`🔊 Played sound for ${type}`)
      } catch (error) {
        debug.error(`❌ Failed to play sound for ${type}:`, error)
      }
    },

    updateUnreadCount() {
      this.unreadCount = this.notifications.filter(n => !n.is_read).length
      
      // Update browser badge if supported
      if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
        if (this.unreadCount > 0) {
          ;(navigator as any).setAppBadge(this.unreadCount)
        } else {
          ;(navigator as any).clearAppBadge()
        }
      }

      // Update document title (base title follows the instance name)
      if (typeof document !== 'undefined') {
        const baseTitle = useInstanceSettingsStore().settings.instanceName || 'Harmony'
        if (this.unreadCount > 0) {
          document.title = `(${this.unreadCount}) ${baseTitle}`
        } else {
          document.title = baseTitle
        }
      }

      // Update favicon badge
      updateFaviconBadge(this.unreadCount)
    },

    /**
     * PREFERENCE MANAGEMENT - Client-side only
     *
     * notification_preferences.user_id references profiles(id). Callers may
     * pass either an auth user id (legacy) or a profile id; we always resolve
     * to a profile id before touching the row so loads, upserts, and broadcast
     * reload-handlers stay consistent.
     */
    async loadPreferences(userIdOrAuthId: string) {
      const profileId = await this.getProfileId(userIdOrAuthId)
      try {
        const { data, error } = await supabase
          .from('notification_preferences')
          .select('*')
          .eq('user_id', profileId)
          .maybeSingle()

        if (error && error.code !== 'PGRST116') {
          debug.error('Error loading preferences:', error)
          // Use defaults if no preferences found
          this.preferences = {
            ...DEFAULT_PREFERENCES,
            id: crypto.randomUUID(),
            user_id: profileId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
          return
        }

        this.preferences = data || {
          ...DEFAULT_PREFERENCES,
          id: crypto.randomUUID(),
          user_id: profileId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }

        // BUGS.md H1: setupDndCheck early-returns when dnd_enabled is false,
        // so we must re-invoke it whenever preferences change so the
        // interval (re)starts on enable and stops on disable. Without this,
        // toggling DND in another tab leaves this tab's check dead until
        // page reload.
        this.setupDndCheck()

        debug.log('✅ Loaded notification preferences')
      } catch (error) {
        debug.error('❌ Failed to load preferences:', error)
        this.preferences = {
          ...DEFAULT_PREFERENCES,
          id: crypto.randomUUID(),
          user_id: profileId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        this.setupDndCheck()
      }
    },

    async updatePreferences(newPreferences: Partial<NotificationPreferences>) {
      try {
        if (!this.preferences) return

        const previousPreferences = { ...this.preferences }
        // BUGS.md H1: detect changes that affect the DND check so we can
        // (re)start/stop the interval at the end. dnd_enabled flipping is
        // the obvious one; dnd_start_time / dnd_end_time changes require
        // re-evaluating `isQuietHours` immediately.
        const dndFieldsChanged =
          ('dnd_enabled' in newPreferences && newPreferences.dnd_enabled !== previousPreferences.dnd_enabled) ||
          ('dnd_start_time' in newPreferences && newPreferences.dnd_start_time !== previousPreferences.dnd_start_time) ||
          ('dnd_end_time' in newPreferences && newPreferences.dnd_end_time !== previousPreferences.dnd_end_time)

        Object.assign(this.preferences, newPreferences)

        const { error } = await supabase
          .from('notification_preferences')
          .upsert({
            ...this.preferences,
          })

        if (error) {
          this.preferences = previousPreferences
          throw error
        }

        // Re-arm the DND interval if any relevant field changed. This
        // re-evaluates `isQuietHours` synchronously and (re)starts or stops
        // the 60 s tick to match the new `dnd_enabled` state.
        if (dndFieldsChanged) {
          this.setupDndCheck()
        }

        // Broadcast preferences change to other tabs/devices
        if (this.cachedProfileId) {
          userEventChannel.send('preferences:updated', {})
        }

        debug.log('✅ Updated notification preferences')
      } catch (error) {
        debug.error('❌ Failed to update preferences:', error)
        throw error
      }
    },

    async checkNotificationPermission(): Promise<boolean> {
      if (typeof Notification === 'undefined') {
        return false
      }

      if (Notification.permission === 'granted') {
        return true
      }

      if (Notification.permission !== 'denied') {
        const permission = await Notification.requestPermission()
        return permission === 'granted'
      }

      return false
    },

    setupDndCheck() {
      if (_dndInterval) {
        clearInterval(_dndInterval)
        _dndInterval = null
      }
      // Compute current state synchronously so the UI reflects DND status
      // immediately without waiting for the first interval tick.
      this.isDndActive = this.isQuietHours
      // Don't bother polling if DND is disabled - there are no transitions
      // to detect. The interval is (re)started by callers when preferences
      // change to enable DND (see action paths around lines 375 / 433).
      if (!this.preferences?.dnd_enabled) return
      _dndInterval = setInterval(() => {
        this.isDndActive = this.isQuietHours
      }, 60000)
    },

    /**
     * NOTIFICATION MANAGEMENT - UI actions only
     */
    async markAsRead(notificationId: string) {
      // Find notification for optimistic updates
      const notification = this.notifications.find(n => n.id === notificationId)
      
      try {
        // Optimistic update
        if (notification) {
          notification.is_read = true
          this.updateUnreadCount()
        }

        await services.notifications.markAsRead(notificationId)
      } catch (error) {
        debug.error('❌ Failed to mark notification as read:', error)
        
        if (notification) {
          notification.is_read = false
          this.updateUnreadCount()
        }
        throw error
      }
    },

    async markAsUnread(notificationId: string) {
      const notification = this.notifications.find(n => n.id === notificationId)
      
      try {
        if (notification) {
          notification.is_read = false
          this.updateUnreadCount()
        }

        await services.notifications.markAsUnread(notificationId)
      } catch (error) {
        debug.error('❌ Failed to mark notification as unread:', error)
        
        if (notification) {
          notification.is_read = true
          this.updateUnreadCount()
        }
        throw error
      }
    },

    async deleteNotification(notificationId: string) {
      // Find notification and index for optimistic updates
      const index = this.notifications.findIndex(n => n.id === notificationId)
      if (index === -1) return
      
      const notification = this.notifications[index]
      
      try {
        // Optimistic update
        this.notifications.splice(index, 1)
        this.updateUnreadCount()
        
        // Use NotificationService for consistent state management
        await services.notifications.deleteNotification(notificationId)
      } catch (error) {
        debug.error('❌ Failed to delete notification:', error)
        
        // Revert optimistic update on error
        this.notifications.splice(index, 0, notification)
        this.updateUnreadCount()
        this.showToast('server_update', 'Failed to delete notification', 'Please try again', 3000)
        throw error
      }
    },  

    /**
     * Mark mention/reply notifications matching the given post ids as read.
     * Called by the Mentions view as posts enter the rendered viewport. The
     * goal (per user request) is "only clear notifications for the mentions
     * actually seen in view" - not blanket-clear every mention notification
     * when the page opens.
     *
     * Strategy: do an optimistic local update for whatever the in-memory
     * store knows about, then mirror to the DB so anything the store hasn't
     * loaded yet (NotificationBell hasn't been opened, etc.) still gets
     * persisted. The DB call is fire-and-forget; failures are logged but
     * don't revert local state (revisiting will re-attempt next time the
     * posts scroll into view).
     */
    async markMentionNotificationsForPostsAsRead(postIds: string[]) {
      if (!postIds.length) return

      const idSet = new Set(postIds.map(String))
      const types = new Set(['activitypub_mention', 'activitypub_reply'])

      const localToMark = this.notifications.filter(n => {
        if (n.is_read) return false
        if (!types.has(n.type)) return false
        const refId = n.data?.post_id ?? n.data?.post?.id
        return refId !== undefined && idSet.has(String(refId))
      })

      if (localToMark.length > 0) {
        // Optimistic local update so the badge/unread count reacts immediately.
        // No revert path here: if the DB write later fails the next view of
        // these same posts will retry. Stale `read=true` for unread DB rows
        // is preferable to a flicker on the badge while the user is reading.
        localToMark.forEach(n => { n.is_read = true })
        this.updateUnreadCount()
      }

      try {
        const authStore = useAuthStore()
        const authUserId = authStore.session?.user?.id
        if (!authUserId) return
        const profileId = await this.getProfileId(authUserId)
        if (!profileId) return

        await services.notifications.markMentionNotificationsForPostsAsRead(profileId, postIds)
      } catch (error) {
        debug.error('Failed to persist mention notifications as read:', error)
      }
    },

    /**
     * Delete every notification for the current user. Optimistically clears
     * the in-memory list and reverts on failure so the panel doesn't strand
     * the user staring at an empty list after a network/RLS error.
     */
    async clearAllNotifications() {
      if (this.notifications.length === 0) return

      const snapshot = [...this.notifications]

      try {
        const authStore = useAuthStore()
        const authUserId = authStore.session?.user?.id
        if (!authUserId) return

        const profileId = await this.getProfileId(authUserId)
        if (!profileId) return

        // Optimistic: clear immediately so the panel reacts instantly.
        this.notifications = []
        this.updateUnreadCount()

        await services.notifications.deleteAllNotifications(profileId)
      } catch (error) {
        debug.error('Failed to clear all notifications:', error)
        // Revert if the server rejected the delete (RLS, network, etc.).
        this.notifications = snapshot
        this.updateUnreadCount()
        this.showToast('server_update', 'Failed to clear notifications', 'Please try again', 3000)
      }
    },

    async markAllAsRead() {
      // Snapshot read state for revert if RPC fails. Mark optimistically
      // only after we have an authenticated profile id - otherwise the UI
      // flips to "all read" but the next refresh restores the unread state.
      const previousReadStates = this.notifications.map(n => ({ id: n.id, is_read: n.is_read }))

      const revertOptimistic = () => {
        previousReadStates.forEach(({ id, is_read }) => {
          const notification = this.notifications.find(n => n.id === id)
          if (notification) notification.is_read = is_read
        })
        this.updateUnreadCount()
      }

      try {
        const authStore = useAuthStore()
        const authUserId = authStore.session?.user?.id
        if (!authUserId) return

        // The RPC validates p_user_id against get_current_profile_id(), so we
        // must resolve the *profile* id, not the auth user id. Passing the
        // auth id triggers the DB's "Not authorized" guard and reverts the UI.
        const profileId = await this.getProfileId(authUserId)
        if (!profileId) return

        this.notifications.forEach(n => { n.is_read = true })
        this.updateUnreadCount()

        const { error } = await supabase
          .rpc('mark_all_notifications_read', { p_user_id: profileId })

        if (error) {
          revertOptimistic()
          throw error
        }

      } catch (error) {
        debug.error('Failed to mark all notifications as read:', error)
        this.showToast('server_update', 'Failed to mark notifications as read', 'Please try again', 3000)
      }
    },

    setFilter(filter: string) {
      this.currentFilter = filter;
    },

    /**
     * Set volume for notification sounds
     */
    async setVolume(volume: number) {
      try {
        const { useThemeStore } = await import('./useTheme')
        const themeStore = useThemeStore()

        if (!themeStore.isInitialized) {
          await themeStore.initialize()
        }

        themeStore.setAudioVolume(Math.max(0, Math.min(1, volume)))

        debug.log(`🔊 Set notification volume to ${Math.round(volume * 100)}%`)
      } catch (error) {
        debug.error('❌ Failed to set notification volume:', error)
      }
    },
    /**
     * Updated notification click handler to use formatter navigation data
     */
    /**
     * Get URL for a notification (used for service worker click handling)
     */
    getNotificationUrl(notification: Notification): string {
      try {
        const navData = NotificationFormatter.getNavigationData(notification)
        
        if (navData) {
          switch (navData.type) {
            case 'conversation': {
              let dmPath = `/dm/${navData.conversationId}`
              if (navData.messageId) {
                dmPath += `?messageId=${navData.messageId}`
              }
              return dmPath
            }

            case 'channel': {
              let path = `/chat/${navData.serverId}/${navData.channelId}`
              if (navData.messageId) {
                path += `?messageId=${navData.messageId}`
              }
              return path
            }
              
            case 'server':
              return `/server/${navData.serverId}`

            case 'activitypub_post':
              return `/post/${navData.postId}`

            case 'profile':
              return `/social/profile/${navData.handle}`

            default:
              return '/'
          }
        }
        return '/'
      } catch (error) {
        debug.error('❌ Error getting notification URL:', error)
        return '/'
      }
    },

    handleNotificationClick(notification: Notification) {
      try {
        // Mark as read and explicitly clicked
        this.markAsRead(notification.id)
        supabase
          .from('notifications')
          .update({ is_clicked: true })
          .eq('id', notification.id)
          .then(({ error }) => {
            if (error) debug.warn('Failed to set is_clicked:', error)
          })
        
        // Get navigation data from formatter
        const navData = NotificationFormatter.getNavigationData(notification)
        
        if (navData) {
          switch (navData.type) {
            case 'conversation': {
              let dmPath = `/dm/${navData.conversationId}`
              if (navData.messageId) {
                dmPath += `?messageId=${navData.messageId}`
              }
              router.push(dmPath)
              break
            }
              
            case 'channel': {
              // Navigate to server channel
              let path = `/chat/${navData.serverId}/${navData.channelId}`
              if (navData.messageId) {
                path += `?messageId=${navData.messageId}`
              }
              router.push(path)
              break
            }
              
            case 'server':
              // Navigate to server
              router.push(`/server/${navData.serverId}`)
              break

            case 'activitypub_post':
              // Navigate to specific ActivityPub post using unified view
              router.push({
                name: 'PostDetail',
                params: { postId: navData.postId }
              })
              break

            case 'profile':
              // Navigate to user's profile (e.g. new follower)
              router.push({ name: 'UserProfile', params: { handle: (navData.handle || '').replace(/^@/, '') } })
              break

            default:
              // Exhaustive narrowing collapses `navData.type` to `never` in
              // the default branch; cast through `any` so we can log it.
              debug.log('⚠️ No navigation data for notification type:', (navData as any).type)
          }
        } else {
          // FIX: Fallback navigation for notifications without proper navData
          debug.warn('⚠️ No navigation data extracted for notification:', notification.type)
          
          // Try to provide sensible defaults based on notification type
          if (notification.type.startsWith('activitypub_')) {
            router.push('/social/home')
          } else if (notification.type === 'dm') {
            // Try to get conversation ID from data
            const conversationId = notification.data?.conversation?.id || notification.data?.conversation_id
            if (conversationId) {
              router.push(`/dm/${conversationId}`)
            } else {
              router.push('/dm')
            }
          } else {
            // Default to home
            debug.warn('⚠️ Could not determine navigation for notification, going to home')
          }
        }
      } catch (error) {
        debug.error('❌ Error handling notification click:', error)
      }
    },

    /**
     * DEVELOPMENT HELPER - Updated to use structured data
     */
    createMockNotifications(userId: string) {
      // Development helper for testing. Mock shape includes legacy
      // `sender`/`message`/`conversation`/`title` fields that aren't on the
      // current `Notification`/`NotificationData` typings; cast through `any`.
      const mockNotifications: Notification[] = ([
        {
          id: '1',
          user_id: userId,
          type: 'mention',
          data: {
            sender: {
              user_id: 'dev-user-1',
              username: 'Developer',
              avatar_url: '/default_avatar.webp'
            },
            location: {
              server_id: 'test-server',
              server_name: 'Test Server',
              channel_id: 'test-channel',
              channel_name: 'general'
            },
            message: {
              id: 'test-message-1',
              content_preview: 'Check out this cool feature!',
            }
          },
          is_read: false,
          is_clicked: false,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          title: ''
        },
        {
          id: '2',
          user_id: userId,
          type: 'dm',
          data: {
            sender: {
              user_id: 'dev-user-2',
              username: 'Friend',
              avatar_url: '/default_avatar.webp'
            },
            conversation: {
              id: 'test-conv'
            },
            message: {
              id: 'test-message-2',
              content_preview: 'Hey! How are you doing?',
            }
          },
          is_read: false,
          is_clicked: false,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          title: ''
        }
      ] as any) as Notification[]

      this.notifications = mockNotifications
      this.updateUnreadCount()
      debug.log('📝 Created mock notifications for development')
    },

    // Helper function to get profile ID from auth user ID with caching
    // Uses AuthContextService for centralized caching
    async getProfileId(authUserId: string): Promise<string> {
      // Return cached value if available and auth user hasn't changed
      if (this.cachedProfileId && this.cachedAuthUserId === authUserId) {
        return this.cachedProfileId
      }

      try {
        // Use AuthContextService which caches the auth -> profile ID mapping
        const context = await authContextService.getCurrentContext()
        
        if (context.isAuthenticated) {
          // Cache the result
          this.cachedProfileId = context.profileId
          this.cachedAuthUserId = authUserId
          return context.profileId
        } else {
          // Fallback to auth user ID for backward compatibility
          this.cachedProfileId = authUserId
          this.cachedAuthUserId = authUserId
          return authUserId
        }
      } catch (error) {
        debug.warn('Could not get profile from AuthContextService, using auth user ID:', error)
        // Cache the fallback
        this.cachedProfileId = authUserId
        this.cachedAuthUserId = authUserId
        return authUserId
      }
    },

    // Clear the profile ID cache (called on logout)
    clearProfileCache() {
      this.cachedProfileId = null
      this.cachedAuthUserId = null
    },
  }
})

// Utility function
// eslint-disable-next-line unused-imports/no-unused-vars
function timeStringToMinutes(timeString: string): number {
  const [hours, minutes] = timeString.split(':').map(Number)
  return hours * 60 + minutes
}

function utcTimeStringToLocalMinutes(utcTimeString: string): number {
  const [h, m] = utcTimeString.split(':').map(Number)
  const now = new Date()
  const utcDate = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), h, m))
  return utcDate.getHours() * 60 + utcDate.getMinutes()
}