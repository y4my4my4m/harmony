/**
 * Service Worker Integration Handler
 * Manages communication between the main app and service worker for notifications
 */

import { debug } from '@/utils/debug'
export class ServiceWorkerManager {
  private static instance: ServiceWorkerManager
  private registration: ServiceWorkerRegistration | null = null
  private isRegistered = false

  public static getInstance(): ServiceWorkerManager {
    if (!ServiceWorkerManager.instance) {
      ServiceWorkerManager.instance = new ServiceWorkerManager()
    }
    return ServiceWorkerManager.instance
  }

  /**
   * Initialize service worker for notifications
   */
  async initialize(): Promise<boolean> {
    try {
      debug.log('🔧 ServiceWorker: Initializing...')

      // Check if service workers are supported
      if (!('serviceWorker' in navigator)) {
        debug.warn('⚠️ ServiceWorker: Not supported in this browser')
        return false
      }

      // Register service worker
      this.registration = await navigator.serviceWorker.register('/service-worker.js', {
        scope: '/'
      })

      debug.log('✅ ServiceWorker: Registered successfully')

      // Handle service worker updates with better UX - Mobile friendly
      this.registration.addEventListener('updatefound', () => {
        debug.log('🔄 ServiceWorker: Update found')
        const newWorker = this.registration!.installing
        
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              debug.log('🆕 ServiceWorker: New version available - waiting for user action')
              // Don't force immediate activation - let user control updates
              // Emit custom event for update notification (non-intrusive)
              window.dispatchEvent(new CustomEvent('sw-update-available', {
                detail: { 
                  registration: this.registration,
                  newWorker: newWorker,
                  skipWaiting: () => {
                    newWorker.postMessage({ type: 'SKIP_WAITING' })
                  }
                }
              }))
            }
          })
        }
      })

      // Listen for messages from service worker
      navigator.serviceWorker.addEventListener('message', this.handleServiceWorkerMessage.bind(this))

      // Prefetch critical resources in background (non-blocking)
      this.prefetchCriticalResources().catch(err => {
        debug.warn('⚠️ ServiceWorker: Prefetch failed:', err)
      })

      this.isRegistered = true
      return true

    } catch (error) {
      debug.error('❌ ServiceWorker: Registration failed:', error)
      return false
    }
  }

  /**
   * Request notification permission
   */
  async requestNotificationPermission(): Promise<NotificationPermission> {
    try {
      if (!('Notification' in window)) {
        debug.warn('⚠️ Notifications not supported')
        return 'denied'
      }

      if (Notification.permission === 'granted') {
        return 'granted'
      }

      const permission = await Notification.requestPermission()
      debug.log('🔔 Notification permission:', permission)
      
      return permission
    } catch (error) {
      debug.error('❌ Error requesting notification permission:', error)
      return 'denied'
    }
  }

  /**
   * Subscribe to push notifications
   */
  async subscribeToPushNotifications(userId: string): Promise<PushSubscription | null> {
    try {
      if (!this.registration) {
        debug.error('❌ ServiceWorker not registered')
        return null
      }

      // Check if already subscribed
      let subscription = await this.registration.pushManager.getSubscription()
      
      if (!subscription) {
        // Create new subscription
        const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY
        
        if (!vapidPublicKey) {
          debug.error('❌ VAPID public key not configured')
          return null
        }

        subscription = await this.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.urlBase64ToUint8Array(vapidPublicKey)
        })

        debug.log('✅ Push subscription created:', subscription)
      }

      // Send subscription to server
      await this.sendSubscriptionToServer(subscription, userId)
      
      return subscription
    } catch (error) {
      debug.error('❌ Error subscribing to push notifications:', error)
      return null
    }
  }

  /**
   * Send push subscription to server
   */
  private async sendSubscriptionToServer(subscription: PushSubscription, userId: string): Promise<void> {
    try {
      const { supabase } = await import('@/supabase')
      
      const { error } = await supabase
        .from('push_subscriptions')
        .upsert({
          user_id: userId,
          subscription: subscription.toJSON(),
          endpoint: subscription.endpoint
        }, {
          onConflict: 'user_id'
        })

      if (error) {
        throw error
      }

      debug.log('✅ Push subscription saved to server')
    } catch (error) {
      debug.error('❌ Error saving push subscription:', error)
    }
  }

  /**
   * Handle messages from service worker
   */
  private handleServiceWorkerMessage(event: MessageEvent): void {
    debug.log('📧 Message from ServiceWorker:', event.data)

    switch (event.data.type) {
      case 'NAVIGATE_TO_NOTIFICATION':
        this.handleNavigateToNotification(event.data)
        break
      case 'MARK_NOTIFICATION_READ':
        this.handleMarkNotificationRead(event.data.data)
        break
      case 'QUICK_REPLY':
        this.handleQuickReply(event.data)
        break
      default:
        debug.log('⚠️ Unknown ServiceWorker message type:', event.data.type)
    }
  }

  /**
   * Handle navigation from service worker notification click
   */
  private async handleNavigateToNotification(data: any): Promise<void> {
    try {
      const { useRouter } = await import('vue-router')
      const router = useRouter()

      if (data.data.conversation_id) {
        let dmPath = `/dm/${data.data.conversation_id}`
        if (data.data.message_id) {
          dmPath += `?messageId=${encodeURIComponent(data.data.message_id)}`
        }
        await router.push(dmPath)
      } else if (data.data.server_id && data.data.channel_id) {
        let path = `/chat/${data.data.server_id}/${data.data.channel_id}`
        if (data.data.message_id) {
          path += `?messageId=${encodeURIComponent(data.data.message_id)}`
        }
        await router.push(path)
      } else if (data.data.server_id) {
        await router.push(`/chat/${data.data.server_id}`)
      }

      // Mark notification as read
      await this.handleMarkNotificationRead(data.data)
    } catch (error) {
      debug.error('❌ Error navigating to notification:', error)
    }
  }

  /**
   * Handle quick reply from service worker notification action
   */
  private async handleQuickReply(data: any): Promise<void> {
    try {
      const replyText = data.replyText
      const notifData = data.data

      if (!replyText || !notifData) {
        await this.handleNavigateToNotification(data)
        return
      }

      const { supabase } = await import('@/supabase')
      const { useAuthStore } = await import('@/stores/auth')
      const authStore = useAuthStore()
      const profileId = (authStore as any).currentProfile?.id

      if (!profileId) {
        debug.error('❌ Quick reply: no active profile')
        return
      }

      if (notifData.conversation_id) {
        await supabase.from('messages').insert({
          conversation_id: notifData.conversation_id,
          profile_id: profileId,
          content: replyText
        })
      } else if (notifData.server_id && notifData.channel_id) {
        await supabase.from('messages').insert({
          channel_id: notifData.channel_id,
          profile_id: profileId,
          content: replyText
        })
      }

      await this.handleMarkNotificationRead(notifData)
      debug.log('✅ Quick reply sent successfully')
    } catch (error) {
      debug.error('❌ Error handling quick reply:', error)
      await this.handleNavigateToNotification(data)
    }
  }

  /**
   * Handle marking notification as read from service worker
   */
  private async handleMarkNotificationRead(data: any): Promise<void> {
    try {
      const { useNotificationStore } = await import('@/stores/useNotification')
      const notificationStore = useNotificationStore()

      // Find and mark the notification as read
      const notification = notificationStore.notifications.find(n => 
        n.data?.message_id === data.message_id ||
        n.data?.conversation_id === data.conversation_id
      )

      if (notification) {
        await notificationStore.markAsRead(notification.id)
      }
    } catch (error) {
      debug.error('❌ Error marking notification as read:', error)
    }
  }

  /**
   * Handle service worker updates
   */
  private handleServiceWorkerUpdate(): void {
    // Show update available notification
    debug.log('🆕 ServiceWorker update available')
    
    // You could show a toast notification here
    // For now, just log it
  }

  /**
   * Send message to service worker
   */
  async sendMessage(message: any): Promise<void> {
    if (!this.registration?.active) {
      debug.warn('⚠️ ServiceWorker not active, cannot send message')
      return
    }

    this.registration.active.postMessage(message)
  }

  /**
   * Update notification settings in service worker
   */
  async updateNotificationSettings(settings: any): Promise<void> {
    await this.sendMessage({
      type: 'UPDATE_NOTIFICATION_SETTINGS',
      settings
    })
  }

  /**
   * Clear stored notifications in service worker
   */
  async clearStoredNotifications(): Promise<void> {
    await this.sendMessage({
      type: 'CLEAR_NOTIFICATIONS'
    })
  }

  /**
   * Dismiss specific system notifications (cross-device read state sync).
   * Tells the service worker to close matching notifications and update the badge.
   */
  async dismissNotifications(criteria: {
    notificationId?: string
    tag?: string
    conversationId?: string
    channelId?: string
  }): Promise<void> {
    await this.sendMessage({
      type: 'DISMISS_NOTIFICATIONS',
      ...criteria
    })
  }

  /**
   * Unsubscribe from push notifications
   */
  async unsubscribeFromPush(userId: string): Promise<boolean> {
    try {
      if (!this.registration) return false

      const subscription = await this.registration.pushManager.getSubscription()
      
      if (subscription) {
        await subscription.unsubscribe()
        
        // Remove from server
        const { supabase } = await import('@/supabase')
        await supabase
          .from('push_subscriptions')
          .delete()
          .eq('user_id', userId)

        debug.log('✅ Unsubscribed from push notifications')
        return true
      }

      return false
    } catch (error) {
      debug.error('❌ Error unsubscribing from push:', error)
      return false
    }
  }

  /**
   * Convert VAPID key to Uint8Array
   */
  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - base64String.length % 4) % 4)
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/')

    const rawData = window.atob(base64)
    const outputArray = new Uint8Array(rawData.length)

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i)
    }
    return outputArray
  }

  /**
   * Manually activate waiting service worker - User controlled updates
   */
  async activateWaitingServiceWorker(): Promise<void> {
    if (!this.registration?.waiting) {
      debug.warn('⚠️ No waiting service worker to activate')
      return
    }

    debug.log('⏭️ Manually activating waiting service worker')
    
    // Send skip waiting message to the waiting service worker
    this.registration.waiting.postMessage({ type: 'SKIP_WAITING' })
    
    // Listen for the controlling change
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      debug.log('🔄 Service worker controller changed - reloading page')
      window.location.reload()
    })
  }

  /**
   * Check if service worker is supported and ready
   */
  get isSupported(): boolean {
    return 'serviceWorker' in navigator && 'PushManager' in window
  }

  /**
   * Check if currently registered
   */
  get ready(): boolean {
    return this.isRegistered && this.registration !== null
  }

  /**
   * Get current registration
   */
  get serviceWorkerRegistration(): ServiceWorkerRegistration | null {
    return this.registration
  }

  /**
   * Prefetch critical resources for better performance
   */
  async prefetchCriticalResources(): Promise<void> {
    if (!this.registration) return

    try {
      await this.sendMessage({ type: 'PREFETCH_CRITICAL' })
      debug.log('📦 ServiceWorker: Critical resources prefetched')
    } catch (error) {
      debug.warn('⚠️ ServiceWorker: Failed to prefetch critical resources:', error)
    }
  }

  /**
   * Get service worker version info
   */
  async getVersion(): Promise<{ version: string; updated: string } | null> {
    if (!this.registration?.active) return null

    try {
      return new Promise((resolve) => {
        const messageChannel = new MessageChannel()
        
        messageChannel.port1.onmessage = (event) => {
          resolve(event.data)
        }
        
        this.registration!.active!.postMessage(
          { type: 'GET_VERSION' },
          [messageChannel.port2]
        )
        
        // Timeout after 5 seconds
        setTimeout(() => resolve(null), 5000)
      })
    } catch (error) {
      debug.error('❌ Failed to get service worker version:', error)
      return null
    }
  }

  /**
   * Check if app update is available
   */
  async checkForUpdate(): Promise<boolean> {
    if (!this.registration) return false

    try {
      await this.registration.update()
      return this.registration.waiting !== null
    } catch (error) {
      debug.error('❌ Failed to check for updates:', error)
      return false
    }
  }

}

// Export singleton instance
export const serviceWorkerManager = ServiceWorkerManager.getInstance()