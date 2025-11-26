import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import router from '@/router'
import { useAuthStore } from './auth'
import { viewContextTracker } from '@/services/ViewContextTracker'
import { NotificationFormatter } from '@/services/NotificationFormatter'
import { getEmojiUrl } from '@/utils/emojiUtils'
import { services } from '@/services'
import { debug } from '@/utils/debug'
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
  activitypub_mention: 'mention',
  activitypub_reply: 'reply',
  activitypub_follow_request: 'friend_request',
  error: 'server_update' // Map error notifications to server_update sound
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
    hasPermission: false,
    currentFilter: 'all',
    cachedProfileId: null,
    cachedAuthUserId: null
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
          icon: '📋',
          count: state.notifications.length
        },
        {
          key: 'unread',
          label: 'Unread',
          icon: '🔴',
          count: state.notifications.filter(n => !n.is_read).length
        },
        {
          key: 'mentions',
          label: 'Mentions',
          icon: '@',
          count: state.notifications.filter(n => n.type === 'mention' || n.type === 'activitypub_mention').length
        },
        {
          key: 'dms',
          label: 'Messages',
          icon: '💬',
          count: state.notifications.filter(n => n.type === 'dm').length
        },
        {
          key: 'social',
          label: 'Social',
          icon: '🌐',
          count: state.notifications.filter(n => n.type.startsWith('activitypub_')).length
        },
        {
          key: 'follows',
          label: 'Follows',
          icon: '👥',
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
     * ⚡ OPTIMIZED: Initialize only unread count (not full notification list)
     * For faster initial page load - full list loads when notification panel is opened
     */
    async initializeUnreadCountOnly(userId: string) {
      if (this.isInitialized) return
      
      try {
        debug.log('🔔 Notification Store: Fast initialization (unread count only)')
        
        // Check notification permission
        this.hasPermission = await this.checkNotificationPermission()
        
        // Load user preferences (lightweight)
        await this.loadPreferences(userId)
        
        // Get profile ID for queries
        const profileId = await this.getProfileId(userId)
        
        // ✅ Load ONLY unread count (not full notification list)
        const { data: countData, error: countError } = await supabase
          .rpc('get_unread_notification_count', { p_user_id: profileId })
        
        if (countError) {
          debug.error('Failed to get unread count:', countError)
          this.unreadCount = 0
        } else {
          this.unreadCount = countData || 0
          debug.log(`✅ Unread notification count: ${this.unreadCount}`)
        }
        
        // Setup realtime subscription for new notifications
        this.setupContextAwareRealtimeSubscription(userId)
        
        // Setup DND status check
        this.setupDndCheck()
        
        this.isInitialized = true
        debug.log('✅ Notification Store: Fast initialization complete')
      } catch (error) {
        debug.error('❌ Notification Store: Failed to initialize unread count:', error)
        this.unreadCount = 0
      }
    },

    /**
     * ⚡ Load full notification list (called when notification panel is opened)
     */
    async loadFullNotificationList(userId: string) {
      if (this.notifications.length > 0) {
        debug.log('📝 Full notification list already loaded')
        return
      }
      
      try {
        this.isLoading = true
        debug.log('📝 Loading full notification list...')
        await this.fetchNotifications(userId)
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
          if (process.env.NODE_ENV === 'development') {
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

              // Note: Block/mute filtering AND view context filtering are handled by database triggers/functions
              // If a notification reaches here, it means the user is NOT viewing the source channel/DM
              // (Notifications are suppressed at database level if user is viewing the context)
              
              // Check DND - if active, don't show UI but still add to list
              const isDndActive = this.isQuietHours
              if (isDndActive && newNotification.type !== 'server_update') {
                debug.log('🌙 DND active - notification added silently')
                // Still add to list but don't show UI
                this.notifications.unshift(newNotification)
                this.updateUnreadCount()
                return
              }

              // Add to notifications list
              this.notifications.unshift(newNotification)
              this.updateUnreadCount()

              // Format message using client-side formatter
              const formatted = NotificationFormatter.formatNotification(newNotification)

              // Since database already filters based on view context, show all notifications that reach here
              const uiDecision = {
                showToast: true,
                showDesktop: true,
                playSound: true,
                reason: 'Notification passed database filtering'
              }

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
          } else if (status === 'CHANNEL_ERROR') {
            debug.error('❌ Subscription error, retrying in 5s...')
            setTimeout(() => {
              this.setupContextAwareRealtimeSubscription(userId)
            }, 5000)
          } else if (status === 'TIMED_OUT') {
            debug.error('⏰ Subscription timed out, retrying...')
            setTimeout(() => {
              this.setupContextAwareRealtimeSubscription(userId)
            }, 2000)
          } else if (status === 'CLOSED') {
            debug.warn('🔒 Subscription closed')
          }
        })
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
          
          this.showToast(
            notification.type,
            formatted.title,
            formatted.message,
            4000,
            NotificationFormatter.getAvatarUrl(notification),
            emojiUrl,
            emojiName
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

        // Use formatter if not provided
        if (!formatted) {
          formatted = NotificationFormatter.formatNotification(notification)
        }

        const desktopNotification = new Notification(formatted.title, {
          body: formatted.message,
          icon: NotificationFormatter.getAvatarUrl(notification),
          badge: '/img/app_icon_square.png',
          tag: `harmony-${notification.type}-${notification.id}`,
          silent: false
        })

        // Handle click to navigate and close
        desktopNotification.onclick = () => {
          window.focus()
          this.handleNotificationClick(notification)
          desktopNotification.close()
        }

        // Auto-close non-critical notifications
        if (notification.type !== 'mention' && notification.type !== 'dm') {
          setTimeout(() => desktopNotification.close(), 8000)
        }

        debug.log(`✅ Desktop notification shown for ${notification.type}`)
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
      emojiName?: string
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
          .single()

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
      setInterval(() => {
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

        // Use NotificationService for consistent state management
        await services.notifications.markAsRead(notificationId)
      } catch (error) {
        debug.error('❌ Failed to mark notification as read:', error)
        
        // Revert optimistic update on error
        if (notification) {
          notification.is_read = false
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

        // Ensure theme system is initialized
        if (!themeStore.isInitialized) {
          await themeStore.initialize()
        }

        // Update the audio volume in theme store
        themeStore.audioVolume = Math.max(0, Math.min(1, volume))

        debug.log(`🔊 Set notification volume to ${Math.round(volume * 100)}%`)
      } catch (error) {
        debug.error('❌ Failed to set notification volume:', error)
      }
    },
    /**
     * Updated notification click handler to use formatter navigation data
     */
    handleNotificationClick(notification: Notification) {
      try {
        // Mark as read and clicked
        this.markAsRead(notification.id)
        
        // Get navigation data from formatter
        const navData = NotificationFormatter.getNavigationData(notification)
        
        if (navData) {
          switch (navData.type) {
            case 'conversation':
              // Navigate to DM
              router.push(`/dm/${navData.conversationId}`)
              break
              
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
                name: 'PostView',
                params: { postId: navData.postId }
              })
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
              avatar_url: '/default_avatar.png'
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
              avatar_url: '/default_avatar.png'
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
    async getProfileId(authUserId: string): Promise<string> {
      // Return cached value if available and auth user hasn't changed
      if (this.cachedProfileId && this.cachedAuthUserId === authUserId) {
        return this.cachedProfileId
      }

      try {
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('id')
          .eq('auth_user_id', authUserId)
          .single()

        if (profile && !error) {
          // Cache the result
          this.cachedProfileId = profile.id
          this.cachedAuthUserId = authUserId
          return profile.id
        } else {
          // Fallback to auth user ID for backward compatibility
          this.cachedProfileId = authUserId
          this.cachedAuthUserId = authUserId
          return authUserId
        }
      } catch (error) {
        debug.warn('Could not find profile for auth user, using auth user ID:', error)
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