import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import { useRouter } from 'vue-router'
import { useAuthStore } from './auth'
import type { 
  Notification, 
  NotificationType, 
  NotificationData, 
  NotificationPreferences,
  NotificationToast,
  ToastAction
} from '@/types'

interface NotificationState {
  notifications: Notification[]
  unreadCount: number
  isLoading: boolean
  lastFetchedAt: Date | null
  settings: NotificationPreferences
  preferences: NotificationPreferences | null
  isDndActive: boolean
  toasts: NotificationToast[]
  realtimeSubscription: any
  soundCache: Map<string, HTMLAudioElement>
  lastNotificationTime: Map<string, number>
  isInitialized: boolean
  hasPermission: boolean
  currentFilter: string
}

// Sound mappings for different notification types
const NOTIFICATION_SOUNDS: Record<NotificationType, string> = {
  mention: '/assets/sounds/poi1.mp3',
  dm: '/assets/sounds/bubble1.mp3', 
  reaction: '/assets/sounds/pirori-wet.mp3',
  reply: '/assets/sounds/pirori-square-wet.mp3',
  voice_channel_activity: '/assets/sounds/voice_connect.mp3',
  server_invite: '/assets/sounds/n-ea-harmony.mp3',
  friend_request: '/assets/sounds/n-aec-8va.mp3',
  server_update: '/assets/sounds/3.mp3',
  emoji_added: '/assets/sounds/pirori-wet.mp3'
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
  dnd_end_time: '08:00:00'
}

export const useNotificationStore = defineStore('notification', {
  state: (): NotificationState => ({
    notifications: [],
    unreadCount: 0,
    isLoading: false,
    lastFetchedAt: null,
    settings: {
      push_enabled: true,
      desktop_enabled: true,
      sound_enabled: true,
      email_enabled: false,
      mentions_only: false,
      dm_enabled: true,
      reaction_enabled: true,
      reply_enabled: true,
      server_invite_enabled: true,
      voice_activity_enabled: false,
      quiet_hours_enabled: false,
      quiet_hours_start: '22:00',
      quiet_hours_end: '08:00',
      preview_enabled: true,
      desktop_mentions: true,
      desktop_dms: true,
      desktop_reactions: false,
      desktop_replies: true,
      sound_mentions: true,
      sound_dms: true,
      sound_reactions: false,
      sound_voice_activity: true,
      dnd_enabled: false,
      dnd_start_time: '22:00',
      dnd_end_time: '08:00'
    },
    preferences: null,
    isDndActive: false,
    toasts: [],
    realtimeSubscription: null,
    soundCache: new Map(),
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
            return notification.type === 'mention'
          case 'dms':
            return notification.type === 'dm'
          case 'reactions':
            return notification.type === 'reaction'
          default:
            return true
        }
      })
    },

    notificationsByType: (state) => {
      const grouped: Record<NotificationType, Notification[]> = {
        mention: [],
        dm: [],
        reaction: [],
        reply: [],
        server_invite: [],
        voice_channel_activity: [],
        emoji_added: [],
        server_update: [],
        friend_request: []
      }

      state.notifications.forEach(notification => {
        if (grouped[notification.type]) {
          grouped[notification.type].push(notification)
        }
      })

      return grouped
    },

    hasUnreadMentions: (state) => {
      return state.notifications.some(n => n.type === 'mention' && !n.is_read)
    },

    hasUnreadDMs: (state) => {
      return state.notifications.some(n => n.type === 'dm' && !n.is_read)
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
          count: state.notifications.filter(n => n.type === 'mention').length
        },
        {
          key: 'dms',
          label: 'Messages',
          icon: '💬',
          count: state.notifications.filter(n => n.type === 'dm').length
        }
      ]
    }
  },

  actions: {
    async initialize(userId: string) {
      if (this.isInitialized) return
      
      try {
        this.isLoading = true
        console.log('Initializing notification store for user:', userId)
        
        // Check notification permission first
        this.hasPermission = await this.checkNotificationPermission()
        
        // Load user preferences
        await this.loadPreferences(userId)
        
        // Load notifications
        await this.fetchNotifications(userId)
        
        // Setup realtime subscription
        this.setupRealtimeSubscription(userId)
        
        // Setup DND status check
        this.setupDndCheck()
        
        this.isInitialized = true
        console.log('Notification store initialized successfully')
      } catch (error) {
        console.error('Failed to initialize notifications:', error)
        this.showToast('server_update', 'Failed to load notifications', 'Please refresh the page', 5000)
      } finally {
        this.isLoading = false
      }
    },

    async fetchNotifications(userId: string, limit = 50, offset = 0) {
      try {
        console.log('Fetching notifications for user:', userId)
        
        const { data, error } = await supabase
          .from('notifications')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(limit)

        if (error) {
          console.error('Error fetching notifications:', error)
          throw error
        }

        console.log('Fetched notifications:', data?.length || 0)
        
        if (offset === 0) {
          this.notifications = data || []
        } else {
          this.notifications.push(...(data || []))
        }

        this.updateUnreadCount()
        this.lastFetchedAt = new Date()

        return data || []
      } catch (error) {
        console.error('Failed to fetch notifications:', error)
        // Create mock notifications for development/testing
        this.createMockNotifications(userId)
        throw error
      }
    },

    // Helper method to create mock notifications for testing
    createMockNotifications(userId: string) {
      if (process.env.NODE_ENV === 'development') {
        const mockNotifications: Notification[] = [
          {
            id: 'mock-1',
            user_id: userId,
            type: 'mention',
            title: 'You were mentioned',
            message: 'Hey @you, check this out!',
            data: {
              username: 'TestUser',
              avatar_url: '/default_avatar.png',
              server_name: 'Test Server',
              channel_name: 'general',
              message_id: 'msg-1',
              server_id: 'server-1',
              channel_id: 'channel-1'
            },
            is_read: false,
            is_clicked: false,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          },
          {
            id: 'mock-2',
            user_id: userId,
            type: 'dm',
            title: 'New direct message',
            message: 'Hello! How are you doing?',
            data: {
              username: 'Friend',
              avatar_url: '/default_avatar.png',
              conversation_id: 'conv-1',
              user_id: 'user-2'
            },
            is_read: false,
            is_clicked: false,
            created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            updated_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          },
          {
            id: 'mock-3',
            user_id: userId,
            type: 'reaction',
            title: 'Someone reacted to your message',
            message: 'with 👍 in #general',
            data: {
              username: 'ReactUser',
              avatar_url: '/default_avatar.png',
              server_name: 'Test Server',
              channel_name: 'general',
              emoji_name: '👍',
              message_id: 'msg-2'
            },
            is_read: true,
            is_clicked: false,
            created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          }
        ]
        
        this.notifications = mockNotifications
        this.updateUnreadCount()
        console.log('Created mock notifications for development')
      }
    },

    async loadPreferences(userId: string) {
      try {
        const { data, error } = await supabase
          .from('notification_preferences')
          .select('*')
          .eq('user_id', userId)
          .single()

        if (error && error.code !== 'PGRST116') {
          console.error('Error loading preferences:', error)
        }

        if (data) {
          this.preferences = data
        } else {
          // Create default preferences
          await this.createDefaultPreferences(userId)
        }
      } catch (error) {
        console.error('Failed to load notification preferences:', error)
        // Use default preferences
        this.preferences = {
          id: 'temp',
          user_id: userId,
          ...DEFAULT_PREFERENCES,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }
    },

    async createDefaultPreferences(userId: string) {
      try {
        const { data, error } = await supabase
          .from('notification_preferences')
          .insert({
            user_id: userId,
            ...DEFAULT_PREFERENCES
          })
          .select()
          .single()

        if (error) throw error
        
        this.preferences = data
      } catch (error) {
        console.error('Failed to create default preferences:', error)
        // Fallback to local preferences
        this.preferences = {
          id: 'temp',
          user_id: userId,
          ...DEFAULT_PREFERENCES,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }
    },

    async updatePreferences(newPreferences: Partial<NotificationPreferences>) {
      if (!this.preferences) return

      try {
        const updatedPreferences = { ...this.preferences, ...newPreferences }
        this.preferences = updatedPreferences

        const { error } = await supabase
          .from('notification_preferences')
          .upsert({
            user_id: this.preferences.user_id,
            ...newPreferences
          })

        if (error) throw error

        this.showToast('server_update', 'Settings updated', 'Your notification preferences have been saved', 2000)
      } catch (error) {
        console.error('Failed to update notification preferences:', error)
        this.showToast('server_update', 'Failed to update settings', 'Please try again', 3000)
      }
    },

    setFilter(filter: string) {
      this.currentFilter = filter
    },

    async markAsRead(notificationId: string) {
      try {
        // Optimistic update
        const notification = this.notifications.find(n => n.id === notificationId)
        if (notification && !notification.is_read) {
          notification.is_read = true
          this.updateUnreadCount()
        }

        const { error } = await supabase
          .from('notifications')
          .update({ is_read: true, read_at: new Date().toISOString() })
          .eq('id', notificationId)

        if (error) {
          // Revert optimistic update on error
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

    async markAllAsRead(userId: string) {
      try {
        // Optimistic update
        const unreadNotifications = this.notifications.filter(n => !n.is_read)
        unreadNotifications.forEach(n => n.is_read = true)
        this.updateUnreadCount()

        const { error } = await supabase
          .from('notifications')
          .update({ is_read: true, read_at: new Date().toISOString() })
          .eq('user_id', userId)
          .eq('is_read', false)

        if (error) {
          // Revert optimistic update on error
          unreadNotifications.forEach(n => n.is_read = false)
          this.updateUnreadCount()
          throw error
        }
      } catch (error) {
        console.error('Failed to mark all notifications as read:', error)
      }
    },

    async createNotification(
      userId: string,
      type: NotificationType,
      title: string,
      message: string,
      data: NotificationData = {}
    ) {
      try {
        const { data: notification, error } = await supabase
          .from('notifications')
          .insert({
            user_id: userId,
            type,
            title,
            message,
            data,
            is_read: false
          })
          .select()
          .single()

        if (error) throw error

        const authStore = useAuthStore()
        if (authStore.session?.user?.id === userId) {
          this.showToast(type, title, message, 4000, data.avatar_url)
          
          // Show desktop notification if enabled
          if (this.shouldShowDesktopNotification(type) && 
              typeof Notification !== 'undefined' && 
              Notification.permission === 'granted') {
            
            const desktopNotification = new Notification(title, {
              body: message,
              icon: data.avatar_url || '/harmony_icon1.png',
              badge: '/harmony_icon1.png',
              tag: `harmony-${type}`,
              requireInteraction: type === 'mention' || type === 'dm',
              silent: false
            })

            desktopNotification.onclick = () => {
              window.focus()
              this.handleNotificationClick(notification)
              desktopNotification.close()
            }

            if (type !== 'mention' && type !== 'dm') {
              setTimeout(() => desktopNotification.close(), 8000)
            }
          }
        }

        return notification
      } catch (error) {
        console.error('Failed to create notification:', error)
        throw error
      }
    },

    async deleteNotification(notificationId: string) {
      try {
        // Optimistic update
        const index = this.notifications.findIndex(n => n.id === notificationId)
        let removedNotification: Notification | null = null
        
        if (index >= 0) {
          removedNotification = this.notifications.splice(index, 1)[0]
          this.updateUnreadCount()
        }

        const { error } = await supabase
          .from('notifications')
          .delete()
          .eq('id', notificationId)

        if (error) {
          // Revert optimistic update on error
          if (removedNotification && index >= 0) {
            this.notifications.splice(index, 0, removedNotification)
            this.updateUnreadCount()
          }
          throw error
        }
      } catch (error) {
        console.error('Failed to delete notification:', error)
      }
    },

    async loadSettings(userId: string) {
      try {
        const { data, error } = await supabase
          .from('user_notification_settings')
          .select('*')
          .eq('user_id', userId)
          .single()

        if (error && error.code !== 'PGRST116') {
          throw error
        }

        if (data) {
          this.settings = { ...this.settings, ...data.settings }
        }
      } catch (error) {
        console.error('Failed to load notification settings:', error)
      }
    },

    async updateSettings(userId: string, newSettings: Partial<NotificationSettings>) {
      try {
        const updatedSettings = { ...this.settings, ...newSettings }
        this.settings = updatedSettings

        const { error } = await supabase
          .from('user_notification_settings')
          .upsert({
            user_id: userId,
            settings: updatedSettings
          })

        if (error) throw error

        this.showToast('server_update', 'Settings updated', 'Your notification preferences have been saved', 2000)
      } catch (error) {
        console.error('Failed to update notification settings:', error)
        this.showToast('server_update', 'Failed to update settings', 'Please try again', 3000)
      }
    },

    setupRealtimeSubscription(userId: string) {
      if (this.realtimeSubscription) {
        supabase.removeChannel(this.realtimeSubscription)
      }

      this.realtimeSubscription = supabase
        .channel('notifications')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${userId}`
          },
          (payload) => {
            const newNotification = payload.new as Notification
            
            // Add to notifications if not already present
            if (!this.notifications.find(n => n.id === newNotification.id)) {
              this.notifications.unshift(newNotification)
              this.updateUnreadCount()

              // Show desktop notification if enabled
              if (this.shouldShowDesktopNotification(newNotification.type) && 
                  typeof Notification !== 'undefined' && 
                  Notification.permission === 'granted') {
                
                const desktopNotification = new Notification(newNotification.title, {
                  body: newNotification.message || '',
                  icon: newNotification.data?.avatar_url || '/harmony_icon1.png',
                  badge: '/harmony_icon1.png',
                  tag: `harmony-${newNotification.type}`, // Prevents duplicate notifications
                  requireInteraction: newNotification.type === 'mention' || newNotification.type === 'dm',
                  silent: false
                })

                // Navigate to notification source on click
                desktopNotification.onclick = () => {
                  window.focus()
                  this.handleNotificationClick(newNotification)
                  desktopNotification.close()
                }

                // Auto-close after 8 seconds for non-critical notifications
                if (newNotification.type !== 'mention' && newNotification.type !== 'dm') {
                  setTimeout(() => desktopNotification.close(), 8000)
                }
              }

              // Play sound if enabled
              if (this.shouldPlaySound(newNotification.type)) {
                this.playNotificationSound(newNotification.type)
              }

              // Show toast for important notifications
              if (['mention', 'dm'].includes(newNotification.type)) {
                this.showToast(
                  newNotification.type,
                  newNotification.title,
                  newNotification.message || '',
                  4000
                )
              }
            }
          }
        )
        .subscribe()
    },

    async playNotificationSound(type: NotificationType) {
      if (!this.shouldPlaySound(type)) return
      
      const soundPath = NOTIFICATION_SOUNDS[type]
      if (!soundPath) return

      // Rate limiting - prevent spam
      const now = Date.now()
      const lastPlayed = this.lastNotificationTime.get(type) || 0
      if (now - lastPlayed < 1000) return // 1 second rate limit
      
      try {
        let audio = this.soundCache.get(soundPath)
        
        if (!audio) {
          audio = new Audio(soundPath)
          audio.volume = 0.6
          audio.preload = 'auto'
          this.soundCache.set(soundPath, audio)
        }
        
        // Reset audio to beginning and play
        audio.currentTime = 0
        await audio.play()
        
        this.lastNotificationTime.set(type, now)
      } catch (error) {
        console.warn('Failed to play notification sound:', error)
      }
    },

    showToast(
      type: NotificationType,
      title: string,
      message: string,
      duration = 4000,
      avatar?: string,
      actions?: ToastAction[]
    ) {
      if (this.isQuietHours && type !== 'server_update') return
      
      const toast: NotificationToast = {
        id: `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type,
        title,
        message,
        avatar,
        actions,
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

    handleNotificationClick(notification: Notification) {
      const router = useRouter()
      const data = notification.data

      try {
        switch (notification.type) {
          case 'mention':
          case 'reply':
            if (data.server_id && data.channel_id) {
              router.push({
                name: 'Chat',
                params: { 
                  serverId: data.server_id, 
                  channelId: data.channel_id 
                }
              })
            }
            break
            
          case 'dm':
            if (data.conversation_id) {
              router.push({
                name: 'DM',
                params: { conversationId: data.conversation_id }
              })
            }
            break
            
          case 'server_invite':
            if (data.server_id) {
              router.push({
                name: 'ServerInvite',
                params: { serverId: data.server_id }
              })
            }
            break
            
          case 'voice_channel_activity':
            if (data.server_id && data.channel_id) {
              router.push({
                name: 'Chat',
                params: { 
                  serverId: data.server_id, 
                  channelId: data.channel_id 
                }
              })
            }
            break
        }
        
        // Mark as read
        this.markAsRead(notification.id)
      } catch (error) {
        console.error('Failed to handle notification click:', error)
      }
    },

    async checkNotificationPermission() {
      if (!('Notification' in window)) {
        console.warn('This browser does not support desktop notification')
        return false
      }

      if (Notification.permission === 'granted') {
        return true
      }

      if (Notification.permission === 'denied') {
        return false
      }

      try {
        const permission = await Notification.requestPermission()
        this.hasPermission = permission === 'granted'
        return permission === 'granted'
      } catch (error) {
        console.error('Failed to request notification permission:', error);
      }
    },

    async requestNotificationPermission() {
      return await this.checkNotificationPermission()
    },

    setupDndCheck() {
      // Check DND status based on quiet hours
      const checkDndStatus = () => {
        this.isDndActive = this.isQuietHours
      }

      // Check every minute
      setInterval(checkDndStatus, 60000)
      checkDndStatus() // Initial check
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

    cleanup() {
      if (this.realtimeSubscription) {
        supabase.removeChannel(this.realtimeSubscription)
        this.realtimeSubscription = null
      }
      
      // Clear sound cache
      this.soundCache.clear()
      this.lastNotificationTime.clear()
      
      // Reset state
      this.isInitialized = false
      this.notifications = []
      this.unreadCount = 0
      this.toasts = []
      
      console.log('Notification store cleaned up')
    },

    // Development helper methods
    async createTestNotification(type: NotificationType = 'mention') {
      if (process.env.NODE_ENV !== 'development') return
      
      const authStore = useAuthStore()
      if (!authStore.session?.user?.id) return

      const testNotifications = {
        mention: {
          title: 'You were mentioned',
          message: 'Check out this cool feature!',
          data: {
            username: 'Developer',
            avatar_url: '/default_avatar.png',
            server_name: 'Test Server',
            channel_name: 'general'
          }
        },
        dm: {
          title: 'New direct message',
          message: 'Hey! How are you doing?',
          data: {
            username: 'Friend',
            avatar_url: '/default_avatar.png',
            conversation_id: 'test-conv'
          }
        },
        reaction: {
          title: 'Someone reacted to your message',
          message: 'with 🚀 in #general',
          data: {
            username: 'ReactUser',
            emoji_name: '🚀',
            server_name: 'Test Server',
            channel_name: 'general'
          }
        }
      }

      const notification = testNotifications[type] || testNotifications.mention
      
      try {
        await this.createNotification(
          authStore.session.user.id,
          type,
          notification.title,
          notification.message,
          notification.data
        )
        console.log(`Created test ${type} notification`)
      } catch (error) {
        console.error('Failed to create test notification:', error)
      }
    },

    async clearAllNotifications() {
      if (process.env.NODE_ENV !== 'development') return
      
      const authStore = useAuthStore()
      if (!authStore.session?.user?.id) return

      try {
        const { error } = await supabase
          .from('notifications')
          .delete()
          .eq('user_id', authStore.session.user.id)

        if (error) throw error

        this.notifications = []
        this.updateUnreadCount()
        console.log('Cleared all notifications')
      } catch (error) {
        console.error('Failed to clear notifications:', error)
      }
    }
  }
})

// Utility function
function timeStringToMinutes(timeString: string): number {
  const [hours, minutes] = timeString.split(':').map(Number)
  return hours * 60 + minutes
}