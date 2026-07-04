/**
 * Service Worker Integration Handler
 * Manages communication between the main app and service worker for notifications
 */

import { debug } from '@/utils/debug'

// Quick-reply queue (IndexedDB) - shared schema with public/service-worker.js.
// The SW persists notification-input replies here so they survive
// "no client open" / "client just booted" / postMessage races, and the
// frontend drains them via the real messageService below.

const QUICK_REPLY_DB_NAME = 'harmony-sw'
const QUICK_REPLY_DB_VERSION = 1
const QUICK_REPLY_STORE = 'pending-quick-replies'

interface QuickReplyEntry {
  /** Auto-incremented IndexedDB key. Optional when enqueueing. */
  id?: number
  replyText: string
  /** Notification data payload (conversation_id, server_id, channel_id, ...) */
  data: any
  navigationUrl?: string | null
  queuedAt: number
}

function openQuickReplyDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUICK_REPLY_DB_NAME, QUICK_REPLY_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(QUICK_REPLY_STORE)) {
        db.createObjectStore(QUICK_REPLY_STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function peekAllQuickReplies(): Promise<Required<QuickReplyEntry>[]> {
  try {
    const db = await openQuickReplyDB()
    const entries = await new Promise<Required<QuickReplyEntry>[]>((resolve, reject) => {
      const tx = db.transaction(QUICK_REPLY_STORE, 'readonly')
      const store = tx.objectStore(QUICK_REPLY_STORE)
      const req = store.getAll()
      req.onsuccess = () => resolve((req.result as Required<QuickReplyEntry>[]) || [])
      req.onerror = () => reject(req.error)
    })
    db.close()
    return entries
  } catch (err) {
    debug.error('❌ Quick reply queue: peek failed:', err)
    return []
  }
}

async function removeQuickReply(id: number): Promise<void> {
  try {
    const db = await openQuickReplyDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(QUICK_REPLY_STORE, 'readwrite')
      tx.objectStore(QUICK_REPLY_STORE).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  } catch (err) {
    debug.error('❌ Quick reply queue: delete failed:', err)
  }
}

async function enqueueQuickReply(entry: QuickReplyEntry): Promise<void> {
  try {
    const db = await openQuickReplyDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(QUICK_REPLY_STORE, 'readwrite')
      tx.objectStore(QUICK_REPLY_STORE).add(entry)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  } catch (err) {
    debug.error('❌ Quick reply queue: enqueue failed:', err)
  }
}

export class ServiceWorkerManager {
  private static instance: ServiceWorkerManager
  private registration: ServiceWorkerRegistration | null = null
  private isRegistered = false
  private isDrainingQuickReplies = false

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

      if (!('serviceWorker' in navigator)) {
        debug.warn('⚠️ ServiceWorker: Not supported in this browser')
        return false
      }

      this.registration = await navigator.serviceWorker.register('/service-worker.js', {
        scope: '/'
      })

      debug.log('✅ ServiceWorker: Registered successfully')

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

      // Drain any quick replies persisted by the SW while the app was
      // closed / unfocused / mid-boot. Defer slightly so the auth store
      // has a chance to hydrate before the drain checks isLoggedIn -
      // otherwise the very first attempt always no-ops on cold start.
      this.scheduleQuickReplyDrainOnAuthReady()

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

      let subscription = await this.registration.pushManager.getSubscription()
      
      if (!subscription) {
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
        // Legacy in-flight message (pre-queue SW). Forward through the same
        // drain path so encryption/optimistic flows still apply.
        this.handleLegacyQuickReply(event.data)
        break
      case 'QUICK_REPLY_QUEUED':
        // SW just enqueued a reply - drain immediately rather than waiting
        // for the next visibility/route event.
        this.drainQuickReplyQueue().catch(err => {
          debug.error('❌ ServiceWorker: drainQuickReplyQueue after QUICK_REPLY_QUEUED failed:', err)
        })
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

      await this.handleMarkNotificationRead(data.data)
    } catch (error) {
      debug.error('❌ Error navigating to notification:', error)
    }
  }

  /**
   * Drain queued quick replies once auth is ready. The auth store may not
   * have hydrated yet when the SW manager initializes, so we attach a
   * one-shot listener that fires on the first auth-state event (or
   * immediately if we're already logged in) and then keeps a low-frequency
   * retry so transient failures (offline, encryption setup pending) recover
   * on the next state change.
   */
  private scheduleQuickReplyDrainOnAuthReady(): void {
    const attemptDrain = () => {
      this.drainQuickReplyQueue().catch(err => {
        debug.error('❌ ServiceWorker: scheduled quick reply drain failed:', err)
      })
    }

    // Best-effort immediate attempt - cheap if the queue is empty.
    setTimeout(attemptDrain, 500)

    // Also drain on every auth state change. drainQuickReplyQueue is a
    // no-op when not logged in or when the queue is empty, so subscribing
    // here is safe and cheap.
    import('@/supabase').then(({ supabase }) => {
      supabase.auth.onAuthStateChange((_event, session) => {
        if (session) attemptDrain()
      })
    }).catch(err => {
      debug.warn('⚠️ ServiceWorker: failed to attach quick reply drain listener:', err)
    })

    // Drain when the tab regains focus - covers the "user typed reply,
    // app was already running but tab unfocused, OS delivered postMessage
    // late" race.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') attemptDrain()
      })
    }
  }

  /**
   * Legacy entry point - the SW used to postMessage replies directly. New SWs
   * persist to IndexedDB and ping QUICK_REPLY_QUEUED instead; for forward
   * compatibility with stale SW versions, treat a direct QUICK_REPLY as an
   * enqueue + drain request.
   */
  private async handleLegacyQuickReply(data: any): Promise<void> {
    try {
      const replyText = data?.replyText
      const notifData = data?.data
      if (!replyText || !notifData) {
        await this.handleNavigateToNotification(data)
        return
      }
      await enqueueQuickReply({
        replyText,
        data: notifData,
        navigationUrl: data?.url ?? null,
        queuedAt: Date.now(),
      })
      await this.drainQuickReplyQueue()
    } catch (error) {
      debug.error('❌ Error handling legacy quick reply:', error)
    }
  }

  /**
   * Drain queued quick replies (written by the service worker when the user
   * types into a notification's reply input). Idempotent and re-entrant-safe.
   *
   * Each entry is sent through the real `messageService` so we keep
   * encryption, optimistic UI, and federation triggers identical to a
   * regular send. Entries are only removed from the queue after a successful
   * send - failures keep them queued so the next drain (next app boot,
   * route change, or QUICK_REPLY_QUEUED ping) can retry.
   */
  async drainQuickReplyQueue(): Promise<void> {
    if (this.isDrainingQuickReplies) {
      // A concurrent drain is in flight - it will pick up everything we
      // care about, so just return.
      return
    }
    this.isDrainingQuickReplies = true
    try {
      const pending = await peekAllQuickReplies()
      if (pending.length === 0) return

      const { useAuthStore } = await import('@/stores/auth')
      const authStore = useAuthStore()
      if (!authStore.isLoggedIn) {
        debug.log(`⏸️ Quick reply drain: not logged in, deferring ${pending.length} entries`)
        return
      }

      // Lazy-import services so the SW manager can boot before stores
      // exist (it's initialized very early in app startup).
      const [{ messageService }, { authContextService }] = await Promise.all([
        import('@/services'),
        import('@/services/AuthContextService'),
      ])

      // Validate that we have a resolvable profile before doing any work.
      // If the auth context can't yet resolve, defer - we'll retry on the
      // next event.
      try {
        await authContextService.getCurrentProfileId()
      } catch {
        debug.log('⏸️ Quick reply drain: no profile resolved yet, deferring')
        return
      }

      for (const entry of pending) {
        const replyText = (entry.replyText || '').trim()
        const notifData = entry.data || {}
        if (!replyText) {
          await removeQuickReply(entry.id)
          continue
        }

        const content = [{ type: 'text' as const, text: replyText }]
        try {
          if (notifData.conversation_id) {
            await messageService.sendDMMessage(
              notifData.conversation_id,
              content as any,
              notifData.message_id || undefined,
            )
          } else if (notifData.server_id && notifData.channel_id) {
            await messageService.sendChannelMessage(
              notifData.server_id,
              notifData.channel_id,
              content as any,
              notifData.message_id || undefined,
            )
          } else {
            // Unaddressable entry - drop it so we don't keep retrying forever.
            debug.warn('⚠️ Quick reply drain: entry has no conversation/channel target, dropping', entry)
            await removeQuickReply(entry.id)
            continue
          }
          await removeQuickReply(entry.id)
          await this.handleMarkNotificationRead(notifData)
          debug.log('✅ Quick reply flushed from queue')
        } catch (err) {
          // Leave the entry in the queue for a future retry. We log loudly
          // so flaky sends are visible during dev/QA.
          debug.error('❌ Quick reply drain failed for entry, will retry later:', err, entry)
        }
      }
    } finally {
      this.isDrainingQuickReplies = false
    }
  }

  /**
   * Handle marking notification as read from service worker
   */
  private async handleMarkNotificationRead(data: any): Promise<void> {
    try {
      const { useNotificationStore } = await import('@/stores/useNotification')
      const notificationStore = useNotificationStore()

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