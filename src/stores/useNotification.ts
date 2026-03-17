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
  realtimeSubscription: any
  lastNotificationTime: Map<string, number>
  isInitialized: boolean
  fullListLoaded: boolean
  hasPermission: boolean
  currentFilter: string
  // Cache for profileId to avoid repeated lookups
  cachedProfileId: string | null
  cachedAuthUserId: string | null
}

// Sound mappings for different notification types to audio actions
const NOTIFICATION_SOUND_MAPPING: Record<NotificationType, AudioAction> = {
  mention: 'mention',
  dm: 'dm', 
  reaction: 'reaction',
  reply: 'reply',
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
  desktop_reactions: false,
  desktop_replies: true,
  sound_notifications: true,
  sound_mentions: true,
  sound_dms: true,
  sound_reactions: false,
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

// Retry configuration for realtime reconnection
const NOTIFICATION_RETRY_CONFIG = {
  maxRetries: 10,
  baseDelay: 1000,
  maxDelay: 30000,
  jitterFactor: 0.2
}

export const useNotificationStore = defineStore('notification', {
  state: (): NotificationState => ({
    notifications: [],
    unreadCount: 0,
    isLoading: false,
    lastFetchedAt: null,
    preferences: null,
    isDndActive: false,
    toasts: [],
    realtimeSubscription: null,
    lastNotificationTime: new Map(),
    isInitialized: false,
    fullListLoaded: false,
    hasPermission: false,
    currentFilter: 'all',
    cachedProfileId: null,
    cachedAuthUserId: null,
    // Reconnection state
    notificationRetryCount: 0,
    notificationRetryTimeout: null as ReturnType<typeof setTimeout> | null,
    _dndCheckInterval: null as number | null
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
        n => !n.is_read && (n.type === 'mention' || n.type === 'activitypub_mention')
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
      const startTime = timeStringToMinutes(state.preferences.dnd_start_time)
      const endTime = timeStringToMinutes(state.preferences.dnd_end_time)
      
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
        
        // Setup context-aware realtime subscription (database sends us notifications)
        this.setupContextAwareRealtimeSubscription(userId)
        
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
        
        // Setup realtime subscription for new notifications
        this.setupContextAwareRealtimeSubscription(userId)
        
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
     * REAL-TIME NOTIFICATION SUBSCRIPTION
     * Database triggers send us structured data, we format messages client-side
     */
    async setupContextAwareRealtimeSubscription(userId: string) {
      // ✅ PERFORMANCE FIX: Prevent duplicate subscription setup
      if (this.realtimeSubscription) {
        // Check if the existing subscription is for the same user and still active
        const profileId = await this.getProfileId(userId);
        const existingChannelName = `harmony-notifications-${profileId}`;
        if (this.realtimeSubscription.topic === existingChannelName) {
          debug.log('✅ Notification subscription already exists, reusing')
          return; // Reuse existing subscription
        }
        
        // Only clean up if we're changing users (shouldn't happen in normal flow)
        debug.log('🧹 Cleaning up existing notification subscription for different user')
        supabase.removeChannel(this.realtimeSubscription)
        this.realtimeSubscription = null
      }

      debug.log('🔔 Setting up real-time notification subscription')

      // Get the profile ID for realtime subscription
      const profileId = await this.getProfileId(userId)

      this.realtimeSubscription = supabase
        .channel(`harmony-notifications-${profileId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${profileId}`
          },
          async (payload) => {
            try {
              debug.log('🚨 Notification payload received:', payload)
              const newNotification = payload.new as Notification
              
              // Prevent duplicates
              if (this.notifications.find(n => n.id === newNotification.id)) {
                debug.log('⚠️ Duplicate notification ignored:', newNotification.id)
                return
              }

              // Check if user is currently viewing the source context BEFORE adding to list
              // This prevents unread count from incrementing for conversations the user is actively in
              const notificationContext = {
                server_id: newNotification.data?.location?.server_id || newNotification.data?.server_id,
                channel_id: newNotification.data?.location?.channel_id || newNotification.data?.channel_id,
                conversation_id: newNotification.data?.conversation?.id || newNotification.data?.conversation_id,
                type: newNotification.type
              }
              
              const uiDecision = viewContextTracker.shouldShowNotificationUI(notificationContext)
              debug.log('🎯 Notification UI decision:', uiDecision)
              
              // If user is viewing the source context, auto-mark as read and skip all UI
              if (!uiDecision.showToast && !uiDecision.showDesktop && !uiDecision.playSound) {
                debug.log('🔕 Notification suppressed: User is viewing source context')
                newNotification.is_read = true
                this.notifications.unshift(newNotification)
                // Don't update unread count since we marked it read
                // Also mark as read in the database
                services.notifications.markAsRead(newNotification.id).catch(() => {})
                return
              }
              
              // Check DND - if active, don't show UI but still add to list
              const isDndActive = this.isQuietHours
              if (isDndActive && newNotification.type !== 'server_update') {
                debug.log('🌙 DND active - notification added silently')
                this.notifications.unshift(newNotification)
                this.updateUnreadCount()
                return
              }

              // Add to notifications list
              this.notifications.unshift(newNotification)
              this.updateUnreadCount()

              // Format message using client-side formatter
              const formatted = NotificationFormatter.formatNotification(newNotification)

              // Process notification through unified notification system
              this.handleRealtimeNotification(newNotification, formatted, uiDecision)

            } catch (error) {
              debug.error('❌ Error handling real-time notification:', error)
            }
          }
        )
        .subscribe((status) => {
          debug.log('🔔 Notification subscription status:', status)
          
          if (status === 'SUBSCRIBED') {
            debug.log('✅ Notification subscription connected')
            // Reset retry count on successful connection
            this.notificationRetryCount = 0
          } else if (status === 'CHANNEL_ERROR') {
            debug.error('❌ Subscription error')
            this.scheduleNotificationReconnect(userId)
          } else if (status === 'TIMED_OUT') {
            debug.error('⏰ Subscription timed out')
            this.scheduleNotificationReconnect(userId)
          } else if (status === 'CLOSED') {
            debug.warn('🔒 Subscription closed')
            this.scheduleNotificationReconnect(userId)
          }
        })
    },
    
    /**
     * Schedule notification subscription reconnection with exponential backoff
     */
    scheduleNotificationReconnect(userId: string) {
      // Check if max retries exceeded
      if (this.notificationRetryCount >= NOTIFICATION_RETRY_CONFIG.maxRetries) {
        debug.error(`❌ Notification subscription: Max retries (${NOTIFICATION_RETRY_CONFIG.maxRetries}) exceeded`)
        return
      }
      
      // Calculate delay with exponential backoff
      const delay = Math.min(
        NOTIFICATION_RETRY_CONFIG.baseDelay * Math.pow(2, this.notificationRetryCount),
        NOTIFICATION_RETRY_CONFIG.maxDelay
      )
      const jitter = delay * NOTIFICATION_RETRY_CONFIG.jitterFactor * Math.random()
      const finalDelay = Math.floor(delay + jitter)
      
      debug.log(`🔄 Notification subscription: Scheduling reconnect in ${finalDelay}ms (attempt ${this.notificationRetryCount + 1}/${NOTIFICATION_RETRY_CONFIG.maxRetries})`)
      
      // Clear any existing retry timeout
      if (this.notificationRetryTimeout) {
        clearTimeout(this.notificationRetryTimeout)
      }
      
      // Schedule reconnect
      this.notificationRetryTimeout = setTimeout(() => {
        this.notificationRetryCount++
        this.notificationRetryTimeout = null
        
        debug.log(`🔄 Notification subscription: Attempting reconnect...`)
        // Clean up old subscription first
        if (this.realtimeSubscription) {
          supabase.removeChannel(this.realtimeSubscription)
          this.realtimeSubscription = null
        }
        this.setupContextAwareRealtimeSubscription(userId)
      }, finalDelay)
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

        // Only show desktop notifications when the tab isn't focused
        if (document.hasFocus()) {
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

        // Optimistic update
        const previousPreferences = { ...this.preferences }
        Object.assign(this.preferences, newPreferences)

        const { error } = await supabase
          .from('notification_preferences')
          .upsert({
            ...this.preferences,
          })

        if (error) {
          // Revert on error
          this.preferences = previousPreferences
          throw error
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
      // Check DND status every minute
      if (this._dndCheckInterval) clearInterval(this._dndCheckInterval)
      this._dndCheckInterval = setInterval(() => {
        this.isDndActive = this.isQuietHours
      }, 60000) as unknown as number
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
            case 'conversation':
              return `/dm/${navData.conversationId}`
              
            case 'channel': {
              let path = `/chat/${navData.serverId}/${navData.channelId}`
              if (navData.messageId) {
                path += `?messageId=${navData.messageId}`
              }
              return path
            }
              
            case 'server':
              return `/servers/${navData.serverId}`

            case 'activitypub_post':
              return `/post/${navData.postId}`
              
            case 'activitypub':
            case 'mention':
            case 'like':
            case 'reblog':
            case 'follow':
              return '/social/home'
            
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
        // Mark as read and clicked
        this.markAsRead(notification.id)
        
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
              router.push(`/servers/${navData.serverId}`)
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
              
            case 'activitypub':
            case 'mention':
            case 'like':
            case 'reblog':
            case 'follow':
              // Navigate to ActivityPub timeline for federated notifications
              router.push('/social/home')
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