import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import router from '@/router'
import { useAuthStore } from './auth'
import { viewContextTracker } from '@/services/ViewContextTracker'
import { NotificationFormatter } from '@/services/NotificationFormatter'
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
  activitypub_follow_request: 'friend_request'
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
    currentFilter: 'all'
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
        console.log('🔔 Notification Store: Initializing Discord-like client for user:', userId)
        
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
        console.log('✅ Notification Store: Discord-like client initialized successfully')
      } catch (error) {
        console.error('❌ Notification Store: Failed to initialize:', error)
        this.showToast('server_update', 'Failed to load notifications', 'Please refresh the page', 5000)
      } finally {
        this.isLoading = false
      }
    },

    async fetchNotifications(userId: string, limit = 50, offset = 0) {
      try {
        console.log('🔔 Fetching notifications for user:', userId)
        
        // Get the profile ID for this auth user ID
        const profileId = await this.getProfileId(userId)
        console.log('🔄 Using profile ID for notifications:', profileId)
        
        const { data, error } = await supabase
          .from('notifications')
          .select('*')
          .eq('user_id', profileId)
          .order('created_at', { ascending: false })
          .limit(limit)

        if (error) {
          console.error('❌ Error fetching notifications:', error)
          throw error
        }

        console.log(`✅ Fetched ${data?.length || 0} notifications`)
        
        if (offset === 0) {
          this.notifications = data || []
        } else {
          this.notifications.push(...(data || []))
        }

        this.updateUnreadCount()
        this.lastFetchedAt = new Date()

        return data || []
      } catch (error) {
        console.error('❌ Failed to fetch notifications:', error)
        // Create mock notifications for development/testing
        if (process.env.NODE_ENV === 'development') {
          this.createMockNotifications(userId)
        }
        throw error
      }
    },

    /**
     * REAL-TIME NOTIFICATION SUBSCRIPTION
     * Database triggers send us structured data, we format messages client-side
     */
    async setupContextAwareRealtimeSubscription(userId: string) {
      // Clean up existing subscription
      if (this.realtimeSubscription) {
        console.log('🧹 Cleaning up existing notification subscription')
        supabase.removeChannel(this.realtimeSubscription)
      }

      console.log('🔔 Setting up real-time notification subscription for user:', userId)

      // Get the profile ID for realtime subscription
      const profileId = await this.getProfileId(userId)
      console.log('🔄 Using profile ID for realtime subscription:', profileId)

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
              console.log('🚨 RAW NOTIFICATION PAYLOAD RECEIVED:', payload)
              const newNotification = payload.new as Notification
              console.log('🔔 Structured notification received from database:', newNotification)
              
              // Prevent duplicates
              if (this.notifications.find(n => n.id === newNotification.id)) {
                console.log('⚠️ Duplicate notification ignored:', newNotification.id)
                return
              }

              // Add to notifications list
              this.notifications.unshift(newNotification)
              this.updateUnreadCount()

              // Format message using client-side formatter
              const formatted = NotificationFormatter.formatNotification(newNotification)
              console.log('✨ Formatted notification message:', formatted)

              // Use ViewContextTracker for smart UI decisions (Discord-like behavior)
              const uiDecision = viewContextTracker.shouldShowNotificationUI({
                server_id: newNotification.data.location?.server_id,
                channel_id: newNotification.data.location?.channel_id,
                conversation_id: newNotification.data.conversation?.id,
                type: newNotification.type
              })

              console.log('🎯 UI Decision:', uiDecision)

              // Show toast notification if appropriate
              if (uiDecision.showToast) {
                console.log('🍞 Showing toast notification')
                this.showToast(
                  newNotification.type,
                  formatted.title,
                  formatted.message,
                  4000,
                  NotificationFormatter.getAvatarUrl(newNotification)
                )
              } else {
                console.log('🚫 Toast notification suppressed by UI decision')
              }

              // Show desktop notification if appropriate
              if (uiDecision.showDesktop && this.shouldShowDesktopNotification(newNotification.type)) {
                console.log('🖥️ Showing desktop notification')
                this.showDesktopNotification(newNotification, formatted)
              } else {
                console.log('🚫 Desktop notification suppressed')
              }

              // Play sound if appropriate
              if (uiDecision.playSound && this.shouldPlaySound(newNotification.type)) {
                console.log('🔊 Playing notification sound')
                this.playNotificationSound(newNotification.type)
              } else {
                console.log('🔇 Sound notification suppressed')
              }

            } catch (error) {
              console.error('❌ Error handling real-time notification:', error)
            }
          }
        )
        .subscribe((status) => {
          console.log('🔔 Real-time notification subscription status:', status)
          
          if (status === 'SUBSCRIBED') {
            console.log('✅ Notification real-time subscription CONNECTED successfully!')
            console.log(`📡 Listening for notifications on table: notifications, filter: user_id=eq.${userId}`)
          } else if (status === 'CHANNEL_ERROR') {
            console.error('❌ Real-time subscription error, retrying in 5s...')
            setTimeout(() => {
              this.setupContextAwareRealtimeSubscription(userId)
            }, 5000)
          } else if (status === 'TIMED_OUT') {
            console.error('⏰ Real-time subscription timed out, retrying...')
            setTimeout(() => {
              this.setupContextAwareRealtimeSubscription(userId)
            }, 2000)
          } else if (status === 'CLOSED') {
            console.warn('🔒 Real-time subscription closed')
          }
        })
    },

    /**
     * Updated desktop notification method to use formatted messages
     */
    async showDesktopNotification(notification: Notification, formatted?: any) {
      try {
        if (typeof Notification === 'undefined') {
          console.log('Desktop notifications not supported')
          return
        }

        if (Notification.permission !== 'granted') {
          console.log('Desktop notification permission not granted')
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
          // requireInteraction: notification.type === 'mention' || notification.type === 'dm', // Add this if you want critical notifications to stay open
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

        console.log(`✅ Desktop notification shown for ${notification.type}`)
      } catch (error) {
        console.error('❌ Error showing desktop notification:', error)
      }
    },

    showToast(
      type: NotificationType,
      title: string,
      message: string,
      duration = 4000,
      avatar?: string
    ) {
      if (this.isQuietHours && type !== 'server_update') return
      
      const toast: NotificationToast = {
        id: `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type,
        title,
        message,
        avatar,
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
        
        console.log(`🔊 Played sound for ${type} using professional theme system`)
      } catch (error) {
        console.error(`❌ Failed to play sound for ${type}:`, error)
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
          console.error('Error loading preferences:', error)
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

        console.log('✅ Loaded notification preferences')
      } catch (error) {
        console.error('❌ Failed to load preferences:', error)
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

        console.log('✅ Updated notification preferences')
      } catch (error) {
        console.error('❌ Failed to update preferences:', error)
        throw error
      }
    },

    async checkNotificationPermission(): Promise<boolean> {
      if (typeof Notification === 'undefined') {
        console.log('Notifications not supported')
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
      try {
        // Optimistic update
        const notification = this.notifications.find(n => n.id === notificationId)
        if (notification) {
          notification.is_read = true
          this.updateUnreadCount()
        }

        console.log(notificationId);
        const { error } = await supabase
          .from('notifications')
          .update({ is_read: true })
          .eq('id', notificationId)

        if (error) {
          // Revert on error
          if (notification) {
            notification.is_read = false
            this.updateUnreadCount()
          }
          throw error
        }
      } catch (error) {
        console.error('Failed to mark notification as read:', error)
      }
    },

    async deleteNotification(notificationId: string) {
      try {
        const index = this.notifications.findIndex(n => n.id === notificationId)
        if (index === -1) return
        const notification = this.notifications[index]
        this.notifications.splice(index, 1)
        this.updateUnreadCount()
        const { error } = await supabase
          .from('notifications')
          .delete()
          .eq('id', notificationId)
        if (error) {
          // Revert on error
          this.notifications.splice(index, 0, notification)
          this.updateUnreadCount()
          throw error
        }
      } catch (error) {
        console.error('Failed to delete notification:', error)
        this.showToast('server_update', 'Failed to delete notification', 'Please try again', 3000)
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
        console.error('Failed to mark all notifications as read:', error)
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

        console.log(`🔊 Set notification volume to ${Math.round(volume * 100)}%`)
      } catch (error) {
        console.error('❌ Failed to set notification volume:', error)
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
                path += `?message=${navData.messageId}`
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
              
              console.log(`🎯 Navigated to ActivityPub post: ${navData.postId}`)
              if (navData.highlightUser) {
                console.log(`👤 Should highlight interaction from user: ${navData.highlightUser}`)
              }
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
              console.log('⚠️ No navigation data available for notification type:', navData.type)
          }
          console.log('📍 Navigated to notification source using formatted data')
        }
      } catch (error) {
        console.error('❌ Error handling notification click:', error)
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
      console.log('📝 Created mock notifications with structured data for development')
    },

    // Helper function to get profile ID from auth user ID
    async getProfileId(authUserId: string): Promise<string> {
      try {
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('id')
          .eq('auth_user_id', authUserId)
          .single()

        if (profile && !error) {
          return profile.id
        } else {
          // Fallback to auth user ID for backward compatibility
          return authUserId
        }
      } catch (error) {
        console.warn('Could not find profile for auth user, using auth user ID:', error)
        return authUserId
      }
    },
  }
})

// Utility function
function timeStringToMinutes(timeString: string): number {
  const [hours, minutes] = timeString.split(':').map(Number)
  return hours * 60 + minutes
}