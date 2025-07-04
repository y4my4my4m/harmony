import { defineStore } from 'pinia'
import { supabase } from '@/supabase'
import { useRouter } from 'vue-router'
import { useAuthStore } from './auth'
import { viewContextTracker } from '@/services/ViewContextTracker'
import type { 
  Notification, 
  NotificationType, 
  NotificationData, 
  NotificationPreferences,
  NotificationToast
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
    /**
     * STABLE INITIALIZATION with proper error handling
     */
    async initialize(userId: string) {
      if (this.isInitialized) return
      
      try {
        this.isLoading = true
        console.log('🔔 Notification Store: Initializing for user:', userId)
        
        // Check notification permission first
        this.hasPermission = await this.checkNotificationPermission()
        
        // Load user preferences
        await this.loadPreferences(userId)
        
        // Load notifications
        await this.fetchNotifications(userId)
        
        // Setup context-aware realtime subscription
        this.setupContextAwareRealtimeSubscription(userId)
        
        // Setup DND status check
        this.setupDndCheck()
        
        this.isInitialized = true
        console.log('✅ Notification Store: Initialized successfully')
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
        
        const { data, error } = await supabase
          .from('notifications')
          .select('*')
          .eq('user_id', userId)
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
     * CONTEXT-AWARE REALTIME SUBSCRIPTION
     * Uses ViewContextTracker to make intelligent decisions about UI notifications
     */
    setupContextAwareRealtimeSubscription(userId: string) {
      // Clean up existing subscription
      if (this.realtimeSubscription) {
        supabase.removeChannel(this.realtimeSubscription)
      }

      this.realtimeSubscription = supabase
        .channel('notifications-context-aware')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${userId}`
          },
          async (payload) => {
            try {
              const newNotification = payload.new as Notification
              console.log('🔔 Real-time notification received:', newNotification)
              
              // Prevent duplicates
              if (this.notifications.find(n => n.id === newNotification.id)) {
                console.log('⚠️ Duplicate notification ignored:', newNotification.id)
                return
              }

              // Add to notifications list
              this.notifications.unshift(newNotification)
              this.updateUnreadCount()

              // Use ViewContextTracker to make smart UI decisions
              const uiDecision = viewContextTracker.shouldShowNotificationUI({
                server_id: newNotification.data.server_id,
                channel_id: newNotification.data.channel_id,
                conversation_id: newNotification.data.conversation_id,
                type: newNotification.type
              })

              console.log('🎯 UI Decision:', uiDecision)

              // Show toast notification if appropriate
              if (uiDecision.showToast) {
                this.showToast(
                  newNotification.type,
                  newNotification.title,
                  newNotification.message || '',
                  4000,
                  newNotification.data?.avatar_url
                )
              }

              // Show desktop notification if appropriate
              if (uiDecision.showDesktop && this.shouldShowDesktopNotification(newNotification.type)) {
                this.showDesktopNotification(newNotification)
              }

              // Play sound if appropriate
              if (uiDecision.playSound && this.shouldPlaySound(newNotification.type)) {
                this.playNotificationSound(newNotification.type)
              }

            } catch (error) {
              console.error('❌ Error handling real-time notification:', error)
            }
          }
        )
        .subscribe((status) => {
          console.log('🔔 Real-time subscription status:', status)
          
          if (status === 'CHANNEL_ERROR') {
            console.error('❌ Real-time subscription error, retrying in 5s...')
            setTimeout(() => {
              this.setupContextAwareRealtimeSubscription(userId)
            }, 5000)
          }
        })
    },

    /**
     * Show desktop notification with proper error handling
     */
    async showDesktopNotification(notification: Notification) {
      try {
        if (typeof Notification === 'undefined') {
          console.log('Desktop notifications not supported')
          return
        }

        if (Notification.permission !== 'granted') {
          console.log('Desktop notification permission not granted')
          return
        }

        const desktopNotification = new Notification(notification.title, {
          body: notification.message || '',
          icon: notification.data?.avatar_url || '/harmony_icon1.png',
          badge: '/harmony_icon1.png',
          tag: `harmony-${notification.type}-${notification.id}`,
          requireInteraction: notification.type === 'mention' || notification.type === 'dm',
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

    /**
     * SIMPLIFIED createNotification - only handles database creation
     */
    async createNotification(
      userId: string,
      type: NotificationType,
      title: string,
      message: string,
      data: NotificationData = {}
    ) {
      try {
        // Use the database function to respect DND settings
        const { data: notificationId, error } = await supabase
          .rpc('create_notification', {
            p_user_id: userId,
            p_type: type,
            p_title: title,
            p_message: message,
            p_data: data
          })

        if (error) {
          console.error('❌ Error creating notification:', error)
          throw error
        }

        // Return the notification ID if created (not blocked by DND)
        return notificationId
      } catch (error) {
        console.error('❌ Failed to create notification:', error)
        throw error
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

        const soundUrl = NOTIFICATION_SOUNDS[type]
        if (!soundUrl) return

        // Use cached audio or create new
        let audio = this.soundCache.get(soundUrl)
        if (!audio) {
          audio = new Audio(soundUrl)
          audio.volume = 0.5
          this.soundCache.set(soundUrl, audio)
        }

        await audio.play()
        console.log(`🔊 Played sound for ${type}`)
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

    // Helper actions
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
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
          return
        }

        this.preferences = data || {
          ...DEFAULT_PREFERENCES,
          id: crypto.randomUUID(),
          user_id: userId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }

        console.log('✅ Loaded notification preferences')
      } catch (error) {
        console.error('❌ Failed to load preferences:', error)
        this.preferences = {
          ...DEFAULT_PREFERENCES,
          id: crypto.randomUUID(),
          user_id: userId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
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

    async markAsRead(notificationId: string) {
      try {
        // Optimistic update
        const notification = this.notifications.find(n => n.id === notificationId)
        if (notification) {
          notification.is_read = true
          this.updateUnreadCount()
        }

        const { error } = await supabase
          .from('notifications')
          .update({ is_read: true, updated_at: new Date().toISOString() })
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

        this.showToast('server_update', 'All notifications marked as read', '', 2000)
      } catch (error) {
        console.error('Failed to mark all notifications as read:', error)
        this.showToast('server_update', 'Failed to mark notifications as read', 'Please try again', 3000)
      }
    },

    handleNotificationClick(notification: Notification) {
      try {
        // Mark as read and clicked
        this.markAsRead(notification.id)
        
        // Navigate to the notification source
        const router = useRouter()
        
        if (notification.data?.conversation_id) {
          // Navigate to DM
          router.push(`/dm/${notification.data.conversation_id}`)
        } else if (notification.data?.server_id && notification.data?.channel_id) {
          // Navigate to server channel
          let path = `/chat/${notification.data.server_id}/${notification.data.channel_id}`
          if (notification.data?.message_id) {
            path += `?message=${notification.data.message_id}`
          }
          router.push(path)
        } else if (notification.data?.server_id) {
          // Navigate to server
          router.push(`/servers/${notification.data.server_id}`)
        }

        console.log('📍 Navigated to notification source')
      } catch (error) {
        console.error('❌ Error handling notification click:', error)
      }
    },

    createMockNotifications(userId: string) {
      // Development helper for testing
      const mockNotifications: Notification[] = [
        {
          id: '1',
          user_id: userId,
          type: 'mention',
          title: 'You were mentioned',
          message: 'Check out this cool feature!',
          data: {
            username: 'Developer',
            avatar_url: '/default_avatar.png',
            server_name: 'Test Server',
            channel_name: 'general'
          },
          is_read: false,
          is_clicked: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        },
        {
          id: '2',
          user_id: userId,
          type: 'dm',
          title: 'New direct message',
          message: 'Hey! How are you doing?',
          data: {
            username: 'Friend',
            avatar_url: '/default_avatar.png',
            conversation_id: 'test-conv'
          },
          is_read: false,
          is_clicked: false,
          created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        }
      ]

      this.notifications = mockNotifications
      this.updateUnreadCount()
      console.log('📝 Created mock notifications for development')
    }
  }
})

// Utility function
function timeStringToMinutes(timeString: string): number {
  const [hours, minutes] = timeString.split(':').map(Number)
  return hours * 60 + minutes
}