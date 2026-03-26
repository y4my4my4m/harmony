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
import type { 
  Notification, 
  NotificationType,
  NotificationPreferences,
  NotificationToast,
  AudioAction
} from '@/types'

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
  sound_notifications: true,
  sound_mentions: true,
  sound_dms: true,
  sound_reactions: true,
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

    // Get unread count for specific notification types
    unreadMentions: (state) => {
      return state.notifications.filter(
        n => !n.is_read && n.type === 'activitypub_mention'
      ).length
    },

    unreadDMs: (state) => {
      return state.notifications.filter(
        n => !n.is_read && n.type === 'dm'
      ).length
    },

    unreadChannelMentions: (state) => {
      return (channelId: string) => {
        return state.notifications.filter(
          n => !n.is_read && n.type === 'mention' && 
          (n.data?.channel_id === channelId || n.data?.location?.channel_id === channelId)
        ).length
      }
    },

    unreadServerMentions: (state) => {
      return (serverId: string) => {
        return state.notifications.filter(
          n => !n.is_read && n.type === 'mention' && 
          (n.data?.server_id === serverId || n.data?.location?.server_id === serverId)
        ).length
      }
    },

    unreadConversationMentions: (state) => {
      return (conversationId: string) => {
        return state.notifications.filter(
          n => !n.is_read && (n.type === 'mention' || n.type === 'dm') && 
          (n.data?.conversation_id === conversationId || n.data?.conversation?.id === conversationId)
        ).length
      }
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

    notificationFilters: (state) => {
      return [
        {
          key: 'all',
          label: 'All',
          icon: 'list',
          count: state.notifications.length
        },
        {
          key: 'unread',
          label: 'Unread',
          icon: 'circle',
          count: state.notifications.filter(n => !n.is_read).length
        },
        {
          key: 'mentions',
          label: 'Mentions',
          icon: 'at-sign',
          count: state.notifications.filter(n => n.type === 'mention' || n.type === 'activitypub_mention').length
        },
        {
          key: 'dms',
          label: 'Messages',
          icon: 'message-circle',
          count: state.notifications.filter(n => n.type === 'dm').length
        },
        {
          key: 'social',
          label: 'Social',
          icon: 'globe',
          count: state.notifications.filter(n => n.type.startsWith('activitypub_')).length
        },
        {
          key: 'follows',
          label: 'Follows',
          icon: 'users',
          count: state.notifications.filter(n => n.type === 'activitypub_follow' || n.type === 'activitypub_follow_request').length
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
            this.notifications = data || []
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
     * 1. Broadcast handler — via UserEventChannel (realtime.send() from DB triggers).
     *    Lower latency, fewer channels, but depends on realtime.send() working.
     *
     * 2. postgres_changes fallback — classic CDC subscription on the notifications
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

        _unsubBulkRead = userEventChannel.on('notification:bulk_read', (data) => {
          debug.log('📡 Bulk read event received, marking all notifications as read locally')
          this.notifications.forEach(n => { n.is_read = true })
          this.updateUnreadCount()
        })

        _unsubPrefsUpdated = userEventChannel.on('preferences:updated', () => {
          debug.log('📡 Preferences updated on another tab/device, reloading...')
          if (this.cachedAuthUserId) {
            this.loadPreferences(this.cachedProfileId || this.cachedAuthUserId)
          }
        })

        _unsubReconnected = userEventChannel.on('_reconnected', async () => {
          debug.log('🔄 UserEventChannel reconnected — gap-filling notifications')
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
            actorInfo?.titleSuffix
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
      titleSuffix?: string
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
        timestamp: new Date()
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

      // Update document title
      if (typeof document !== 'undefined') {
        const baseTitle = 'Harmony'
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
     */
    async loadPreferences(userId: string) {
      try {
        const { data, error } = await supabase
          .from('notification_preferences')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle()

        if (error && error.code !== 'PGRST116') {
          debug.error('Error loading preferences:', error)
          // Use defaults if no preferences found
          this.preferences = { 
            ...DEFAULT_PREFERENCES,
            id: crypto.randomUUID(),
            user_id: userId,
          }
          return
        }

        this.preferences = data || {
          ...DEFAULT_PREFERENCES,
          id: crypto.randomUUID(),
          user_id: userId,
        }

        debug.log('✅ Loaded notification preferences')
      } catch (error) {
        debug.error('❌ Failed to load preferences:', error)
        this.preferences = {
          ...DEFAULT_PREFERENCES,
          id: crypto.randomUUID(),
          user_id: userId,
        }
      }
    },

    async updatePreferences(newPreferences: Partial<NotificationPreferences>) {
      try {
        if (!this.preferences) return

        const previousPreferences = { ...this.preferences }
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
      if (_dndInterval) clearInterval(_dndInterval)
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

    async markAllAsRead() {
      try {
        // Optimistic update
        const previousReadStates = this.notifications.map(n => ({ id: n.id, is_read: n.is_read }))
        this.notifications.forEach(n => { n.is_read = true })
        this.updateUnreadCount()

        const authStore = useAuthStore()
        if (!authStore.session?.user?.id) return

        const { error } = await supabase
          .rpc('mark_all_notifications_read', { p_user_id: authStore.session.user.id })

        if (error) {
          // Revert on error
          previousReadStates.forEach(({ id, is_read }) => {
            const notification = this.notifications.find(n => n.id === id)
            if (notification) notification.is_read = is_read
          })
          this.updateUnreadCount()
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
              router.push(`/social/profile/${navData.handle}`)
              break

            default:
              debug.log('⚠️ No navigation data for notification type:', navData.type)
          }
        } else {
          // ✅ FIX: Fallback navigation for notifications without proper navData
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
      // Development helper for testing
      const mockNotifications: Notification[] = [
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
      ]

      this.notifications = mockNotifications
      this.updateUnreadCount()
      debug.log('📝 Created mock notifications for development')
    },

    // Helper function to get profile ID from auth user ID with caching
    // OPTIMIZED: Uses AuthContextService for centralized caching
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