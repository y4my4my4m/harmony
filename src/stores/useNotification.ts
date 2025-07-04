import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { supabase } from '@/supabase'
import { useAuthStore } from './auth'
import { useServerUsersStore } from './useServerUsers'
import type { 
  Notification, 
  NotificationPreferences, 
  NotificationChannel, 
  UnreadCount,
  NotificationType,
  NotificationData,
  NotificationToast,
  NotificationSound
} from '@/types'

export const useNotificationStore = defineStore('notifications', () => {
  // State
  const notifications = ref<Notification[]>([])
  const preferences = ref<NotificationPreferences | null>(null)
  const notificationChannels = ref<NotificationChannel[]>([])
  const unreadCounts = ref<UnreadCount[]>([])
  const toasts = ref<NotificationToast[]>([])
  
  // Loading states
  const isLoading = ref(false)
  const isInitialized = ref(false)
  
  // Real-time subscriptions
  const subscriptions = ref<Map<string, any>>(new Map())
  
  // Notification sounds
  const sounds = ref<Map<NotificationType, NotificationSound>>(new Map([
    ['mention', { name: 'Mention', url: '/assets/sounds/mention.mp3', volume: 0.7 }],
    ['dm', { name: 'DM', url: '/assets/sounds/dm.mp3', volume: 0.6 }],
    ['reaction', { name: 'Reaction', url: '/assets/sounds/bubble1.mp3', volume: 0.5 }],
    ['reply', { name: 'Reply', url: '/assets/sounds/reply.mp3', volume: 0.6 }],
    ['voice_channel_activity', { name: 'Voice', url: '/assets/sounds/voice_connect.mp3', volume: 0.8 }],
    ['server_invite', { name: 'Invite', url: '/assets/sounds/server_invite.mp3', volume: 0.7 }],
    ['friend_request', { name: 'Friend Request', url: '/assets/sounds/friend_request.mp3', volume: 0.7 }],
    ['server_update', { name: 'Server Update', url: '/assets/sounds/server_update.mp3', volume: 0.5 }],
    ['emoji_added', { name: 'Emoji Added', url: '/assets/sounds/emoji_added.mp3', volume: 0.4 }]
  ]))
  
  // Computed
  const unreadNotifications = computed(() => 
    notifications.value.filter(n => !n.is_read)
  )
  
  const unreadCount = computed(() => unreadNotifications.value.length)
  
  const mentionCount = computed(() => 
    unreadNotifications.value.filter(n => n.type === 'mention').length
  )
  
  const dmCount = computed(() => 
    unreadNotifications.value.filter(n => n.type === 'dm').length
  )
  
  const totalUnreadMessages = computed(() => 
    unreadCounts.value.reduce((total, count) => total + count.unread_messages, 0)
  )
  
  const totalUnreadMentions = computed(() => 
    unreadCounts.value.reduce((total, count) => total + count.unread_mentions, 0)
  )
  
  const isDndActive = computed(() => {
    if (!preferences.value?.dnd_enabled) return false
    
    const now = new Date()
    const currentTime = now.toTimeString().split(' ')[0] // HH:MM:SS
    const start = preferences.value.dnd_start_time
    const end = preferences.value.dnd_end_time
    
    if (start <= end) {
      return currentTime >= start && currentTime <= end
    } else {
      return currentTime >= start || currentTime <= end
    }
  })
  
  // Actions
  const initialize = async (userId: string) => {
    if (isInitialized.value) return
    
    try {
      isLoading.value = true
      
      // Initialize all notification data
      await Promise.all([
        fetchNotifications(userId),
        fetchPreferences(userId),
        fetchNotificationChannels(userId),
        fetchUnreadCounts(userId)
      ])
      
      // Set up real-time subscriptions
      setupRealtimeSubscriptions(userId)
      
      isInitialized.value = true
    } catch (error) {
      console.error('Failed to initialize notifications:', error)
    } finally {
      isLoading.value = false
    }
  }
  
  const fetchNotifications = async (userId: string, limit = 50) => {
    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit)
      
      if (error) throw error
      notifications.value = data || []
    } catch (error) {
      console.error('Failed to fetch notifications:', error)
    }
  }
  
  const fetchPreferences = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('notification_preferences')
        .select('*')
        .eq('user_id', userId)
        .single()
      
      if (error && error.code !== 'PGRST116') throw error
      preferences.value = data
    } catch (error) {
      console.error('Failed to fetch notification preferences:', error)
    }
  }
  
  const fetchNotificationChannels = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('notification_channels')
        .select('*')
        .eq('user_id', userId)
      
      if (error) throw error
      notificationChannels.value = data || []
    } catch (error) {
      console.error('Failed to fetch notification channels:', error)
    }
  }
  
  const fetchUnreadCounts = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('unread_counts')
        .select('*')
        .eq('user_id', userId)
      
      if (error) throw error
      unreadCounts.value = data || []
    } catch (error) {
      console.error('Failed to fetch unread counts:', error)
    }
  }
  
  const createNotification = async (
    userId: string,
    type: NotificationType,
    title: string,
    message?: string,
    data: NotificationData = {}
  ) => {
    try {
      const { data: notification, error } = await supabase
        .rpc('create_notification', {
          p_user_id: userId,
          p_type: type,
          p_title: title,
          p_message: message,
          p_data: data
        })
      
      if (error) throw error
      
      // The real-time subscription will handle adding to local state
      return notification
    } catch (error) {
      console.error('Failed to create notification:', error)
      return null
    }
  }
  
  const markAsRead = async (notificationId: string) => {
    try {
      await supabase.rpc('mark_notification_read', { notification_id: notificationId })
      
      // Update local state optimistically
      const notification = notifications.value.find(n => n.id === notificationId)
      if (notification) {
        notification.is_read = true
        notification.updated_at = new Date().toISOString()
      }
    } catch (error) {
      console.error('Failed to mark notification as read:', error)
    }
  }
  
  const markAllAsRead = async (userId: string) => {
    try {
      await supabase.rpc('mark_all_notifications_read', { p_user_id: userId })
      
      // Update local state optimistically
      notifications.value.forEach(notification => {
        if (!notification.is_read) {
          notification.is_read = true
          notification.updated_at = new Date().toISOString()
        }
      })
    } catch (error) {
      console.error('Failed to mark all notifications as read:', error)
    }
  }
  
  const updatePreferences = async (newPreferences: Partial<NotificationPreferences>) => {
    if (!preferences.value) return
    
    try {
      const { data, error } = await supabase
        .from('notification_preferences')
        .update(newPreferences)
        .eq('user_id', preferences.value.user_id)
        .select()
        .single()
      
      if (error) throw error
      preferences.value = data
    } catch (error) {
      console.error('Failed to update notification preferences:', error)
    }
  }
  
  const muteChannel = async (
    userId: string,
    serverId?: string,
    channelId?: string,
    conversationId?: string,
    duration?: number // minutes
  ) => {
    try {
      const mutedUntil = duration ? 
        new Date(Date.now() + duration * 60000).toISOString() : 
        null
      
      const { data, error } = await supabase
        .from('notification_channels')
        .upsert({
          user_id: userId,
          server_id: serverId,
          channel_id: channelId,
          conversation_id: conversationId,
          muted: true,
          muted_until: mutedUntil,
          updated_at: new Date().toISOString()
        })
        .select()
        .single()
      
      if (error) throw error
      
      // Update local state
      const existingIndex = notificationChannels.value.findIndex(nc => 
        nc.user_id === userId &&
        nc.server_id === serverId &&
        nc.channel_id === channelId &&
        nc.conversation_id === conversationId
      )
      
      if (existingIndex >= 0) {
        notificationChannels.value[existingIndex] = data
      } else {
        notificationChannels.value.push(data)
      }
    } catch (error) {
      console.error('Failed to mute channel:', error)
    }
  }
  
  const unmuteChannel = async (
    userId: string,
    serverId?: string,
    channelId?: string,
    conversationId?: string
  ) => {
    try {
      const { error } = await supabase
        .from('notification_channels')
        .update({
          muted: false,
          muted_until: null,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('server_id', serverId)
        .eq('channel_id', channelId)
        .eq('conversation_id', conversationId)
      
      if (error) throw error
      
      // Update local state
      const channel = notificationChannels.value.find(nc => 
        nc.user_id === userId &&
        nc.server_id === serverId &&
        nc.channel_id === channelId &&
        nc.conversation_id === conversationId
      )
      
      if (channel) {
        channel.muted = false
        channel.muted_until = undefined
        channel.updated_at = new Date().toISOString()
      }
    } catch (error) {
      console.error('Failed to unmute channel:', error)
    }
  }
  
  const playNotificationSound = (type: NotificationType) => {
    if (!preferences.value?.sound_notifications) return
    
    const shouldPlay = (() => {
      switch (type) {
        case 'mention': return preferences.value.sound_mentions
        case 'dm': return preferences.value.sound_dms
        case 'reaction': return preferences.value.sound_reactions
        case 'voice_channel_activity': return preferences.value.sound_voice_activity
        default: return true
      }
    })()
    
    if (!shouldPlay || isDndActive.value) return
    
    const sound = sounds.value.get(type)
    if (sound) {
      try {
        const audio = new Audio(sound.url)
        audio.volume = sound.volume
        audio.play().catch(console.warn)
      } catch (error) {
        console.warn('Failed to play notification sound:', error)
      }
    }
  }
  
  const showDesktopNotification = async (notification: Notification) => {
    if (!preferences.value?.desktop_notifications || isDndActive.value) return
    
    const shouldShow = (() => {
      switch (notification.type) {
        case 'mention': return preferences.value.desktop_mentions
        case 'dm': return preferences.value.desktop_dms
        case 'reaction': return preferences.value.desktop_reactions
        case 'reply': return preferences.value.desktop_replies
        default: return true
      }
    })()
    
    if (!shouldShow) return
    
    // Request permission if not granted
    if (Notification.permission === 'default') {
      await Notification.requestPermission()
    }
    
    if (Notification.permission === 'granted') {
      try {
        const desktopNotification = new Notification(notification.title, {
          body: notification.message,
          icon: notification.data.avatar_url || '/harmony_icon1.png',
          badge: '/harmony_icon1.png',
          tag: notification.id,
          requireInteraction: false,
          silent: false
        })
        
        desktopNotification.onclick = () => {
          markAsClicked(notification.id)
          handleNotificationClick(notification)
          desktopNotification.close()
        }
        
        // Auto close after 5 seconds
        setTimeout(() => desktopNotification.close(), 5000)
      } catch (error) {
        console.warn('Failed to show desktop notification:', error)
      }
    }
  }
  
  const showToast = (
    type: NotificationType,
    title: string,
    message?: string,
    duration = 4000,
    avatar?: string
  ) => {
    const toast: NotificationToast = {
      id: crypto.randomUUID(),
      type,
      title,
      message,
      duration,
      avatar,
      timestamp: new Date()
    }
    
    toasts.value.push(toast)
    
    // Auto remove toast
    setTimeout(() => {
      removeToast(toast.id)
    }, duration)
  }
  
  const removeToast = (toastId: string) => {
    const index = toasts.value.findIndex(t => t.id === toastId)
    if (index >= 0) {
      toasts.value.splice(index, 1)
    }
  }
  
  const markAsClicked = async (notificationId: string) => {
    try {
      await supabase
        .from('notifications')
        .update({ is_clicked: true, updated_at: new Date().toISOString() })
        .eq('id', notificationId)
      
      // Update local state
      const notification = notifications.value.find(n => n.id === notificationId)
      if (notification) {
        notification.is_clicked = true
        notification.updated_at = new Date().toISOString()
      }
    } catch (error) {
      console.error('Failed to mark notification as clicked:', error)
    }
  }
  
  const handleNotificationClick = (notification: Notification) => {
    // Navigation logic based on notification type and data
    const router = (window as any).__harmonyRouter
    if (!router) return
    
    switch (notification.type) {
      case 'mention':
      case 'reply':
        if (notification.data.server_id && notification.data.channel_id) {
          router.push({
            name: 'Chat',
            params: {
              serverId: notification.data.server_id,
              channelId: notification.data.channel_id
            },
            query: notification.data.message_id ? { messageId: notification.data.message_id } : {}
          })
        }
        break
        
      case 'dm':
        if (notification.data.conversation_id) {
          router.push({
            name: 'DM',
            params: { conversationId: notification.data.conversation_id }
          })
        }
        break
        
      case 'server_invite':
        if (notification.data.invite_id) {
          router.push({
            name: 'InviteAccept',
            params: { inviteId: notification.data.invite_id }
          })
        }
        break
        
      case 'reaction':
        if (notification.data.server_id && notification.data.channel_id) {
          router.push({
            name: 'Chat',
            params: {
              serverId: notification.data.server_id,
              channelId: notification.data.channel_id
            }
          })
        }
        break
    }
  }
  
  const setupRealtimeSubscriptions = (userId: string) => {
    // Clean up existing subscriptions
    cleanupSubscriptions()
    
    // Subscribe to notifications
    const notificationsChannel = supabase
      .channel(`notifications-${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${userId}`
      }, (payload) => {
        const newNotification = payload.new as Notification
        notifications.value.unshift(newNotification)
        
        // Play sound and show desktop notification
        playNotificationSound(newNotification.type)
        showDesktopNotification(newNotification)
        
        // Show toast notification
        showToast(
          newNotification.type,
          newNotification.title,
          newNotification.message,
          4000,
          newNotification.data.avatar_url
        )
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${userId}`
      }, (payload) => {
        const updatedNotification = payload.new as Notification
        const index = notifications.value.findIndex(n => n.id === updatedNotification.id)
        if (index >= 0) {
          notifications.value[index] = updatedNotification
        }
      })
      .subscribe()
    
    subscriptions.value.set('notifications', notificationsChannel)
    
    // Subscribe to preferences updates
    const preferencesChannel = supabase
      .channel(`notification-preferences-${userId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'notification_preferences',
        filter: `user_id=eq.${userId}`
      }, (payload) => {
        preferences.value = payload.new as NotificationPreferences
      })
      .subscribe()
    
    subscriptions.value.set('preferences', preferencesChannel)
    
    // Subscribe to unread counts
    const unreadCountsChannel = supabase
      .channel(`unread-counts-${userId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'unread_counts',
        filter: `user_id=eq.${userId}`
      }, (payload) => {
        if (payload.eventType === 'INSERT') {
          unreadCounts.value.push(payload.new as UnreadCount)
        } else if (payload.eventType === 'UPDATE') {
          const index = unreadCounts.value.findIndex(uc => uc.id === payload.new.id)
          if (index >= 0) {
            unreadCounts.value[index] = payload.new as UnreadCount
          }
        } else if (payload.eventType === 'DELETE') {
          const index = unreadCounts.value.findIndex(uc => uc.id === payload.old.id)
          if (index >= 0) {
            unreadCounts.value.splice(index, 1)
          }
        }
      })
      .subscribe()
    
    subscriptions.value.set('unreadCounts', unreadCountsChannel)
  }
  
  const cleanupSubscriptions = () => {
    subscriptions.value.forEach((subscription, key) => {
      supabase.removeChannel(subscription)
    })
    subscriptions.value.clear()
  }
  
  const cleanup = () => {
    cleanupSubscriptions()
    notifications.value = []
    preferences.value = null
    notificationChannels.value = []
    unreadCounts.value = []
    toasts.value = []
    isInitialized.value = false
  }
  
  // Auto-cleanup old read notifications every 5 minutes
  setInterval(() => {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    notifications.value = notifications.value.filter(n => 
      !n.is_read || new Date(n.created_at) > weekAgo
    )
  }, 5 * 60 * 1000)
  
  return {
    // State
    notifications,
    preferences,
    notificationChannels,
    unreadCounts,
    toasts,
    isLoading,
    isInitialized,
    sounds,
    
    // Computed
    unreadNotifications,
    unreadCount,
    mentionCount,
    dmCount,
    totalUnreadMessages,
    totalUnreadMentions,
    isDndActive,
    
    // Actions
    initialize,
    createNotification,
    markAsRead,
    markAllAsRead,
    updatePreferences,
    muteChannel,
    unmuteChannel,
    playNotificationSound,
    showDesktopNotification,
    showToast,
    removeToast,
    markAsClicked,
    handleNotificationClick,
    cleanup
  }
})