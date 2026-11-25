/**
 * Service worker bridge: notification messaging between app and SW.
 */

import router from '@/router'
import { debug } from '@/utils/debug'
import { toAppPath } from '@/utils/notificationRoute'
import { isLastingRejectionCode } from '@/services/AutoModService'

// Quick-reply queue (IndexedDB) - schema shared with public/service-worker.js.
// The SW persists notification-input replies here so they survive
// "no client open" / "client just booted" / postMessage races; the frontend
// drains them through messageService, each only as the account it was typed
// for. A sign-out empties the queue.

const QUICK_REPLY_DB_NAME = 'harmony-sw'
const QUICK_REPLY_DB_VERSION = 1
const QUICK_REPLY_STORE = 'pending-quick-replies'

interface QuickReplyEntry {
  /** Auto-incremented IndexedDB key. Optional when enqueueing. */
  id?: number
  replyText: string
  /** Notification data payload (conversation_id, server_id, channel_id, ...) */
  data: any
  /** Profile id the push was for (data.recipient_id); absent from workers before 3.10. */
  account?: string | null
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
    debug.error('Quick reply queue: peek failed:', err)
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
    debug.error('Quick reply queue: delete failed:', err)
  }
}

/** Empties the queue: replies typed for an account leave with its sign-out. */
export async function forgetQuickReplies(): Promise<void> {
  try {
    const db = await openQuickReplyDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(QUICK_REPLY_STORE, 'readwrite')
      tx.objectStore(QUICK_REPLY_STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    db.close()
  } catch (err) {
    debug.error('Quick reply queue: clear failed:', err)
  }
}

/**
 * Epoch ms from which this device's session was signed in: the earliest timestamp in its token's amr
 * claim. amr timestamps are whole seconds; the second after it bounds the sign-in from above.
 */
function sessionSignedInAt(claims: any): number | null {
  const stamps = (Array.isArray(claims?.amr) ? claims.amr : [])
    .map((entry: any) => Number(entry?.timestamp))
    .filter((n: number) => Number.isFinite(n) && n > 0)
  return stamps.length > 0 ? (Math.min(...stamps) + 1) * 1000 : null
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
    debug.error('Quick reply queue: enqueue failed:', err)
  }
}

export class ServiceWorkerManager {
  private static instance: ServiceWorkerManager
  private registration: ServiceWorkerRegistration | null = null
  private isRegistered = false
  private isDrainingQuickReplies = false
  // A drain asked for while one runs; the running one drains again when it ends.
  private drainAgain = false
  private drainOnUserDataPending = false

  public static getInstance(): ServiceWorkerManager {
    if (!ServiceWorkerManager.instance) {
      ServiceWorkerManager.instance = new ServiceWorkerManager()
    }
    return ServiceWorkerManager.instance
  }

  async initialize(): Promise<boolean> {
    try {
      debug.log('ServiceWorker: Initializing...')

      if (!('serviceWorker' in navigator)) {
        debug.warn('ServiceWorker: Not supported in this browser')
        return false
      }

      this.registration = await navigator.serviceWorker.register('/service-worker.js', {
        scope: '/'
      })

      debug.log('ServiceWorker: Registered successfully')

      this.registration.addEventListener('updatefound', () => {
        debug.log('ServiceWorker: Update found')
        const newWorker = this.registration!.installing
        
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              debug.log('ServiceWorker: New version available - waiting for user action')
              // No skipWaiting here; activation is user-triggered via the event payload.
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

      navigator.serviceWorker.addEventListener('message', this.handleServiceWorkerMessage.bind(this))

      this.prefetchCriticalResources().catch(err => {
        debug.warn('ServiceWorker: Prefetch failed:', err)
      })

      // Drains quick replies persisted by the SW while the app was closed,
      // unfocused, or mid-boot. Deferred: the drain checks isLoggedIn, which
      // no-ops on cold start until the auth store hydrates.
      this.scheduleQuickReplyDrainOnAuthReady()

      this.isRegistered = true
      return true

    } catch (error) {
      debug.error('ServiceWorker: Registration failed:', error)
      return false
    }
  }

  async requestNotificationPermission(): Promise<NotificationPermission> {
    try {
      if (!('Notification' in window)) {
        debug.warn('Notifications not supported')
        return 'denied'
      }

      if (Notification.permission === 'granted') {
        return 'granted'
      }

      const permission = await Notification.requestPermission()
      debug.log('Notification permission:', permission)
      
      return permission
    } catch (error) {
      debug.error('Error requesting notification permission:', error)
      return 'denied'
    }
  }

  private handleServiceWorkerMessage(event: MessageEvent): void {
    debug.log('Message from ServiceWorker:', event.data)

    switch (event.data?.type) {
      case 'NAVIGATE_TO_NOTIFICATION':
        this.handleNavigateToNotification(event.data)
        break
      case 'MARK_NOTIFICATION_READ':
        this.handleMarkNotificationRead(event.data.data)
        break
      case 'PUSH_SUBSCRIPTION_CHANGED':
        import('@/composables/usePushNotifications')
          .then(({ usePushNotifications }) => usePushNotifications().reconcile())
          .catch(err => debug.warn('ServiceWorker: push reconcile after subscription change failed:', err))
        break
      case 'QUICK_REPLY':
        // Pre-queue SW versions post replies directly. Routed through the
        // drain path to keep encryption and optimistic flows applied.
        this.handleLegacyQuickReply(event.data)
        break
      case 'QUICK_REPLY_QUEUED':
        // Drain now instead of waiting for the next visibility/route event.
        this.drainQuickReplyQueue().catch(err => {
          debug.error('ServiceWorker: drainQuickReplyQueue after QUICK_REPLY_QUEUED failed:', err)
        })
        break
      default:
        debug.log('Unknown ServiceWorker message type:', event.data.type)
    }
  }

  /**
   * A system notification was clicked while this window existed. The service worker
   * resolves `url` from the payload; ids are the fallback for pre-3.6 workers.
   */
  private async handleNavigateToNotification(message: any): Promise<void> {
    try {
      const data = message?.data || {}
      void this.handleMarkNotificationRead(data)

      const path = toAppPath(message?.url || data.url, window.location.origin)
      if (path) {
        await router.push(path)
        return
      }
      if (data.conversation_id) {
        const query = data.message_id ? `?messageId=${encodeURIComponent(data.message_id)}` : ''
        await router.push(`/dm/${data.conversation_id}${query}`)
      } else if (data.server_id && data.channel_id) {
        const query = data.message_id ? `?messageId=${encodeURIComponent(data.message_id)}` : ''
        await router.push(`/chat/${data.server_id}/${data.channel_id}${query}`)
      }
    } catch (error) {
      debug.error('Error navigating to notification:', error)
    }
  }

  /**
   * Marks read the notifications clicked or marked read in the system tray while no
   * window could take the write. Runs after sign-in; ids stay queued until then.
   */
  async drainPendingReads(): Promise<void> {
    const worker = this.registration?.active
    if (!worker) return
    try {
      const { useAuthStore } = await import('@/stores/auth')
      if (!useAuthStore().isLoggedIn) return

      const ids = await new Promise<string[]>((resolve) => {
        const channel = new MessageChannel()
        const timer = setTimeout(() => resolve([]), 3000)
        channel.port1.onmessage = (event) => {
          clearTimeout(timer)
          resolve(Array.isArray(event.data?.ids) ? event.data.ids : [])
        }
        worker.postMessage({ type: 'TAKE_PENDING_READS' }, [channel.port2])
      })
      if (ids.length === 0) return

      const { useNotificationStore } = await import('@/stores/useNotification')
      await useNotificationStore().markManyAsRead(ids)
    } catch (error) {
      debug.warn('ServiceWorker: pending read drain failed:', error)
    }
  }

  /**
   * Shows a system notification through the worker, which drops it when a push for
   * the same notification id was already shown. False when no worker is active.
   */
  async showNotification(title: string, options: NotificationOptions): Promise<boolean> {
    const registration = this.registration ?? await navigator.serviceWorker?.getRegistration?.().catch(() => undefined)
    const worker = registration?.active
    if (!registration || !worker) return false

    // Workers before 3.6 ignore SHOW_NOTIFICATION; without an answer the page shows
    // it itself. The shared tag makes a late answer replace, not stack.
    const acknowledged = await new Promise<boolean>((resolve) => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => resolve(false), 1500)
      channel.port1.onmessage = () => {
        clearTimeout(timer)
        resolve(true)
      }
      worker.postMessage({ type: 'SHOW_NOTIFICATION', title, options }, [channel.port2])
    })
    if (!acknowledged) await registration.showNotification(title, options)
    return true
  }

  /**
   * Drains queued quick replies once auth is ready. The auth store may not be
   * hydrated when the SW manager initializes, so drains are triggered from
   * auth-state changes and tab visibility as well as a timed first attempt.
   * Transient failures (offline, encryption setup pending) recover on the
   * next trigger.
   */
  private scheduleQuickReplyDrainOnAuthReady(): void {
    const attemptDrain = () => {
      this.drainQuickReplyQueue().catch(err => {
        debug.error('ServiceWorker: scheduled quick reply drain failed:', err)
      })
    }

    // Early attempt; no-op when the queue is empty.
    setTimeout(attemptDrain, 500)

    // drainQuickReplyQueue is a no-op when logged out or the queue is empty,
    // so firing on every auth state change is safe.
    import('@/supabase').then(({ supabase }) => {
      supabase.auth.onAuthStateChange((_event, session) => {
        if (session) {
          attemptDrain()
          // Deferred: isLoggedIn follows the auth store, which updates after this event.
          setTimeout(() => { void this.drainPendingReads() }, 1500)
        }
      })
    }).catch(err => {
      debug.warn('ServiceWorker: failed to attach quick reply drain listener:', err)
    })

    // Covers the case where the app is running with the tab unfocused and
    // the OS delivers the SW postMessage late.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          attemptDrain()
          void this.drainPendingReads()
        }
      })
    }
  }

  /**
   * Drains again once the signed-in user's data has loaded (userDataService
   * `initialized`): sends need it, and it loads after sign-in and at boot,
   * after the triggers above may have run.
   */
  private drainWhenUserDataLoads(userData: EventTarget): void {
    if (this.drainOnUserDataPending) return
    this.drainOnUserDataPending = true
    userData.addEventListener('initialized', () => {
      this.drainOnUserDataPending = false
      this.drainQuickReplyQueue().catch(err => {
        debug.error('ServiceWorker: quick reply drain after user data load failed:', err)
      })
    }, { once: true })
  }

  /**
   * Legacy path for SW versions that postMessage replies directly instead of
   * persisting to IndexedDB and pinging QUICK_REPLY_QUEUED. A direct
   * QUICK_REPLY is treated as enqueue + drain.
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
        account: typeof notifData.recipient_id === 'string' ? notifData.recipient_id : null,
        navigationUrl: data?.url ?? null,
        queuedAt: Date.now(),
      })
      await this.drainQuickReplyQueue()
    } catch (error) {
      debug.error('Error handling legacy quick reply:', error)
    }
  }

  /**
   * Drains quick replies written by the service worker from a notification
   * reply input. Idempotent and re-entrant-safe.
   *
   * Entries are sent through `messageService` so encryption, optimistic UI,
   * and federation triggers match a regular send. An entry is removed only
   * after a successful send; failures stay queued for the next drain (app
   * boot, route change, or QUICK_REPLY_QUEUED ping). Entries the signed-in
   * account may send wait, unsent, until its user data has loaded.
   */
  async drainQuickReplyQueue(): Promise<void> {
    if (this.isDrainingQuickReplies) {
      this.drainAgain = true
      return
    }
    this.isDrainingQuickReplies = true
    this.drainAgain = false
    try {
      const pending = await peekAllQuickReplies()
      if (pending.length === 0) return

      // Lazy imports: the SW manager initializes before the stores exist.
      const [{ useAuthStore }, { userDataService }] = await Promise.all([
        import('@/stores/auth'),
        import('@/services/userDataService'),
      ])
      const authStore = useAuthStore()
      if (!authStore.isLoggedIn) {
        debug.log(`Quick reply drain: not logged in, deferring ${pending.length} entries`)
        this.drainWhenUserDataLoads(userDataService)
        return
      }

      const [{ messageService }, { authContextService }] = await Promise.all([
        import('@/services'),
        import('@/services/AuthContextService'),
      ])

      // Requires a resolvable profile; defer to the next trigger otherwise.
      let profileId: string
      try {
        profileId = await authContextService.getCurrentProfileId()
      } catch {
        debug.log('Quick reply drain: no profile resolved yet, deferring')
        this.drainWhenUserDataLoads(userDataService)
        return
      }
      // messageService sends as userDataService's current user.
      const userDataLoaded = !!userDataService.getCurrentUser()
      let waiting = false
      // An entry of a worker before 3.10 names no account: it is this account's when it was queued
      // during this device's session.
      const token = authStore.session?.access_token
      const signedInAt = token ? sessionSignedInAt(authStore.decodeJWT(token)) : null

      for (const entry of pending) {
        const replyText = (entry.replyText || '').trim()
        const notifData = entry.data || {}
        if (!replyText) {
          await removeQuickReply(entry.id)
          continue
        }
        const owned = entry.account
          ? entry.account === profileId
          : signedInAt !== null && entry.queuedAt >= signedInAt
        if (!owned) {
          debug.warn('Quick reply typed for another account or session, dropping', entry.id)
          await removeQuickReply(entry.id)
          continue
        }
        if (!userDataLoaded) {
          waiting = true
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
            // Unaddressable entry; dropped to avoid an unbounded retry loop.
            debug.warn('Quick reply drain: entry has no conversation/channel target, dropping', entry)
            await removeQuickReply(entry.id)
            continue
          }
          await removeQuickReply(entry.id)
          await this.handleMarkNotificationRead(notifData)
          debug.log('Quick reply flushed from queue')
        } catch (err) {
          // A refusal that answers the same on every retry, or a timeout, drops the reply; a rate
          // limit passes, and the reply waits for the next drain.
          if (isLastingRejectionCode((err as { code?: string } | null)?.code)) {
            debug.warn('Quick reply refused, dropping:', err, entry)
            await removeQuickReply(entry.id)
            continue
          }
          // Entry stays queued for a later retry.
          debug.error('Quick reply drain failed for entry, will retry later:', err, entry)
        }
      }
      if (waiting) {
        // Loaded while this drain ran: the event is past, so drain again now.
        if (userDataService.getCurrentUser()) this.drainAgain = true
        else this.drainWhenUserDataLoads(userDataService)
      }
    } finally {
      this.isDrainingQuickReplies = false
    }
    if (this.drainAgain) {
      this.drainAgain = false
      await this.drainQuickReplyQueue()
    }
  }

  // By notification id; payloads without one fall back to the message id.
  private async handleMarkNotificationRead(data: any): Promise<void> {
    try {
      const { useNotificationStore } = await import('@/stores/useNotification')
      const notificationStore = useNotificationStore()

      const id = data?.notification_id || data?.notificationId
      if (id) {
        await notificationStore.markManyAsRead([id])
        return
      }
      // Both sides undefined would match an unrelated notification.
      const notification = data?.message_id
        ? notificationStore.notifications.find(n => n.data?.message_id === data.message_id)
        : undefined
      if (notification) await notificationStore.markAsRead(notification.id)
    } catch (error) {
      debug.error('Error marking notification as read:', error)
    }
  }

  // Logs only; no UI surface for update availability.
  private handleServiceWorkerUpdate(): void {
    debug.log('ServiceWorker update available')
  }

  async sendMessage(message: any): Promise<void> {
    if (!this.registration?.active) {
      debug.warn('ServiceWorker not active, cannot send message')
      return
    }

    this.registration.active.postMessage(message)
  }

  async updateNotificationSettings(settings: any): Promise<void> {
    await this.sendMessage({
      type: 'UPDATE_NOTIFICATION_SETTINGS',
      settings
    })
  }

  async clearStoredNotifications(): Promise<void> {
    await this.sendMessage({
      type: 'CLEAR_NOTIFICATIONS'
    })
  }

  /**
   * Closes matching system notifications and updates the badge in the SW.
   * Used for cross-device read-state sync.
   */
  async dismissNotifications(criteria: {
    notificationId?: string
    notificationIds?: string[]
    tag?: string
    conversationId?: string
    channelId?: string
    /** Close every notification. */
    all?: boolean
    /** Close every notification whose id is not listed. */
    keepIds?: string[]
  }): Promise<void> {
    await this.sendMessage({
      type: 'DISMISS_NOTIFICATIONS',
      ...criteria
    })
  }

  // Reloads the page once the new worker takes control.
  async activateWaitingServiceWorker(): Promise<void> {
    if (!this.registration?.waiting) {
      debug.warn('No waiting service worker to activate')
      return
    }

    debug.log('Manually activating waiting service worker')
    
    this.registration.waiting.postMessage({ type: 'SKIP_WAITING' })
    
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      debug.log('Service worker controller changed - reloading page')
      window.location.reload()
    })
  }

  get isSupported(): boolean {
    return 'serviceWorker' in navigator && 'PushManager' in window
  }

  get ready(): boolean {
    return this.isRegistered && this.registration !== null
  }

  get serviceWorkerRegistration(): ServiceWorkerRegistration | null {
    return this.registration
  }

  async prefetchCriticalResources(): Promise<void> {
    if (!this.registration) return

    try {
      await this.sendMessage({ type: 'PREFETCH_CRITICAL' })
      debug.log('ServiceWorker: Critical resources prefetched')
    } catch (error) {
      debug.warn('ServiceWorker: Failed to prefetch critical resources:', error)
    }
  }

  // Resolves null if the SW does not answer GET_VERSION within 5s.
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
        
        setTimeout(() => resolve(null), 5000)
      })
    } catch (error) {
      debug.error('Failed to get service worker version:', error)
      return null
    }
  }

  async checkForUpdate(): Promise<boolean> {
    if (!this.registration) return false

    try {
      await this.registration.update()
      return this.registration.waiting !== null
    } catch (error) {
      debug.error('Failed to check for updates:', error)
      return false
    }
  }

}

export const serviceWorkerManager = ServiceWorkerManager.getInstance()