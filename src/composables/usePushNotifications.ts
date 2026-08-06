/**
 * Web Push subscription management.
 * Requires iOS 16.4+ (installed PWA only); Android and desktop browsers work directly.
 */

import { ref, computed } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { isPWA } from '@/utils/pwaUtils'

// Federation backend base path (proxied via nginx)
const FEDERATION_BACKEND_URL = '/api/federation'

const isSupported = ref(false)
const isSubscribed = ref(false)
const isLoading = ref(false)
const permission = ref<NotificationPermission>('default')
const vapidPublicKey = ref<string | null>(null)
const subscriptions = ref<PushSubscriptionInfo[]>([])
const error = ref<string | null>(null)

// Guards against duplicate initialize() API calls.
let isInitializing = false
let isInitialized = false

export interface PushSubscriptionInfo {
  id: string
  endpoint: string
  device_name?: string
  user_agent?: string
  created_at: string
  last_successful_push?: string
  failure_count: number
}

function checkSupport(): boolean {
  if (typeof window === 'undefined') return false
  
  const hasServiceWorker = 'serviceWorker' in navigator
  const hasPushManager = 'PushManager' in window
  const hasNotification = 'Notification' in window
  
  return hasServiceWorker && hasPushManager && hasNotification
}

async function getAuthToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token || null
}

/** base64url to Uint8Array, as required by pushManager.subscribe applicationServerKey. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
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

/** Carries retryAfter (seconds) when the server responds 429. */
interface VapidFetchResult {
  publicKey: string | null
  rateLimited?: boolean
  retryAfter?: number
}

async function fetchVapidKey(): Promise<VapidFetchResult> {
  try {
    const response = await fetch(`${FEDERATION_BACKEND_URL}/push/vapid-key`)

    if (response.status === 429) {
      const data = await response.json().catch(() => ({}))
      return {
        publicKey: null,
        rateLimited: true,
        retryAfter: data.retryAfter || 60
      }
    }

    if (!response.ok) {
      debug.warn('Push notifications not available on server')
      return { publicKey: null }
    }

    const data = await response.json()
    return { publicKey: data.publicKey || null }
  } catch (err) {
    debug.error('Failed to fetch VAPID key:', JSON.stringify(err))
    return { publicKey: null }
  }
}

async function getCurrentSubscription(): Promise<PushSubscription | null> {
  try {
    const registration = await navigator.serviceWorker.ready
    return await registration.pushManager.getSubscription()
  } catch (err) {
    debug.error('Failed to get current subscription:', err)
    return null
  }
}

async function subscribe(deviceName?: string): Promise<{ success: boolean; error?: string }> {
  if (!isSupported.value || !vapidPublicKey.value) {
    return { success: false, error: 'Push notifications not supported or not configured' }
  }

  isLoading.value = true
  error.value = null

  try {
    if (Notification.permission === 'default') {
      const result = await Notification.requestPermission()
      permission.value = result
      
      if (result !== 'granted') {
        return { success: false, error: 'Notification permission denied' }
      }
    } else if (Notification.permission === 'denied') {
      return { success: false, error: 'Notification permission denied. Please enable in browser settings.' }
    }

    const registration = await navigator.serviceWorker.ready
    
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey.value)
    })

    const token = await getAuthToken()
    if (!token) {
      return { success: false, error: 'Not authenticated' }
    }

    const response = await fetch(`${FEDERATION_BACKEND_URL}/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        deviceName
      })
    })

    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error || 'Failed to save subscription')
    }

    isSubscribed.value = true
    debug.log('Push notification subscription successful')
    
    await fetchSubscriptions()
    
    return { success: true }
  } catch (err: any) {
    error.value = err.message || 'Failed to subscribe to push notifications'
    debug.error('Push subscription error:', err)
    return { success: false, error: error.value ?? undefined }
  } finally {
    isLoading.value = false
  }
}

/** Unsubscribes the current device, browser-side first, then server-side. */
async function unsubscribe(): Promise<{ success: boolean; error?: string }> {
  isLoading.value = true
  error.value = null

  try {
    const subscription = await getCurrentSubscription()
    
    if (!subscription) {
      isSubscribed.value = false
      return { success: true }
    }

    await subscription.unsubscribe()
    
    // Browser-side unsubscribe succeeded; reflect it before the server round-trip.
    isSubscribed.value = false

    const token = await getAuthToken()
    if (!token) {
      // Server keeps its record; the browser subscription is already gone.
      debug.warn('Browser unsubscribed but could not notify server (not authenticated)')
      return { success: true }
    }

    const response = await fetch(`${FEDERATION_BACKEND_URL}/push/unsubscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        endpoint: subscription.endpoint
      })
    })

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      const errMsg = data.message || data.error || `Server error ${response.status}`
      // 429 is surfaced to the caller: the server still holds the subscription.
      if (response.status === 429) {
        error.value = errMsg
        return { success: false, error: error.value ?? undefined }
      }
      debug.warn('Server unsubscribe failed:', errMsg)
    }

    debug.log('Push notification unsubscribed')
    
    await fetchSubscriptions()
    
    return { success: true }
  } catch (err: any) {
    error.value = err.message || 'Failed to unsubscribe'
    debug.error('Push unsubscribe error:', err)
    return { success: false, error: error.value ?? undefined }
  } finally {
    isLoading.value = false
  }
}

/**
 * Removes a device from the subscription list.
 * Current browser routes through unsubscribe() (POST /push/unsubscribe), which
 * avoids the DELETE-by-id rate limit; other devices go to deleteSubscription().
 */
async function removeSubscription(subscription: { id: string; endpoint: string }): Promise<{ success: boolean; error?: string }> {
  try {
    const currentSub = await getCurrentSubscription()
    const isCurrentDevice = currentSub && currentSub.endpoint === subscription.endpoint
    if (isCurrentDevice) {
      return unsubscribe()
    }
  } catch {
    // Current device indeterminate; fall through to deleteSubscription.
  }
  return deleteSubscription(subscription.id)
}

/** DELETE by subscription id. Intended for devices other than this browser. */
async function deleteSubscription(subscriptionId: string): Promise<{ success: boolean; error?: string }> {
  isLoading.value = true
  error.value = null

  try {
    const token = await getAuthToken()
    if (!token) {
      return { success: false, error: 'Not authenticated' }
    }

    const response = await fetch(`${FEDERATION_BACKEND_URL}/push/subscriptions/${subscriptionId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })

    if (!response.ok) {
      const data = await response.json()
      throw new Error(data.error || 'Failed to delete subscription')
    }

    await fetchSubscriptions()
    
    await checkSubscriptionStatus()

    return { success: true }
  } catch (err: any) {
    error.value = err.message || 'Failed to delete subscription'
    debug.error('Delete subscription error:', err)
    return { success: false, error: error.value ?? undefined }
  } finally {
    isLoading.value = false
  }
}

async function fetchSubscriptions(): Promise<void> {
  try {
    const token = await getAuthToken()
    if (!token) return

    const response = await fetch(`${FEDERATION_BACKEND_URL}/push/subscriptions`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    })

    if (response.ok) {
      const data = await response.json()
      subscriptions.value = data.subscriptions || []
    }
  } catch (err) {
    debug.error('Failed to fetch subscriptions:', err)
  }
}

/**
 * Resolves isSubscribed by matching this browser's endpoint against the
 * server-side list for the logged-in user.
 * A PushSubscription is browser-scoped, not user-scoped, so after an account
 * switch it may still belong to the previous user.
 */
async function checkSubscriptionStatus(): Promise<void> {
  try {
    const subscription = await getCurrentSubscription()
    if (!subscription) {
      isSubscribed.value = false
      return
    }

    if (subscriptions.value.length > 0) {
      const endpoint = subscription.endpoint
      const belongsToUser = subscriptions.value.some(s => s.endpoint === endpoint)
      isSubscribed.value = belongsToUser
      return
    }

    // Subscription list not loaded yet.
    await fetchSubscriptions()
    const endpoint = subscription.endpoint
    isSubscribed.value = subscriptions.value.some(s => s.endpoint === endpoint)
  } catch (err) {
    debug.error('Failed to check subscription status:', err)
  }
}

/** Clears the init guards so initialize() runs again, e.g. after a 429. */
async function retryInitialize(): Promise<void> {
  isInitialized = false
  isInitializing = false
  error.value = null
  await initialize()
}

/**
 * Resets push state on logout.
 * The browser subscription is left intact so it can be re-associated when the
 * same user logs back in.
 */
function resetState(): void {
  isSubscribed.value = false
  subscriptions.value = []
  error.value = null
  isInitialized = false
  isInitializing = false
  debug.log('Push notification state reset (logout)')
}

/**
 * Sends a test push to this device.
 * When the server has no record of this endpoint (typical after a
 * logout/login cycle), the device is re-registered and the send retried once.
 */
async function sendTestNotification(): Promise<{ success: boolean; error?: string }> {
  isLoading.value = true
  error.value = null

  try {
    const token = await getAuthToken()
    if (!token) {
      return { success: false, error: 'Not authenticated' }
    }

    let currentEndpoint: string | undefined
    try {
      const registration = await navigator.serviceWorker?.ready
      const subscription = await registration?.pushManager?.getSubscription()
      if (subscription) {
        currentEndpoint = subscription.endpoint
      }
    } catch {
      // Endpoint unavailable; send to all devices.
    }

    const sendTest = async () => {
      const response = await fetch(`${FEDERATION_BACKEND_URL}/push/test`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(currentEndpoint ? { endpoint: currentEndpoint } : {})
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to send test notification')
      }
      return data
    }

    let data = await sendTest()

    // sent === 0 for a known endpoint means server/browser desync; re-register and retry once.
    if (data.sent === 0 && currentEndpoint) {
      debug.log('Test notification found no subscription, re-registering device...')
      const resubResult = await subscribe()
      if (resubResult.success) {
        data = await sendTest()
      }
    }

    return { 
      success: data.sent > 0, 
      error: data.sent === 0 ? 'No active subscriptions found' : undefined 
    }
  } catch (err: any) {
    error.value = err.message || 'Failed to send test notification'
    debug.error('Test notification error:', err)
    return { success: false, error: error.value ?? undefined }
  } finally {
    isLoading.value = false
  }
}

/**
 * Idempotent: repeat calls are no-ops once initialized.
 * The VAPID key is fetched unconditionally so subscribe() stays available after
 * the user removes every subscription.
 */
async function initialize(): Promise<void> {
  if (isInitialized || isInitializing) {
    debug.log('Push notifications already initialized, skipping')
    return
  }
  
  isInitializing = true
  error.value = null
  
  try {
    isSupported.value = checkSupport()
    
    if (!isSupported.value) {
      // No PushManager here, but subscriptions and prefs live server-side and
      // remain manageable across devices.
      debug.log('Push subscribe unsupported here; loading subscriptions for management only')
      await fetchSubscriptions().catch(() => {})
      return
    }

    permission.value = Notification.permission

    if (!vapidPublicKey.value) {
      const result = await fetchVapidKey()
      if (result.rateLimited) {
        error.value = `Too many requests. Please wait ${result.retryAfter ?? 60} seconds and try again.`
        return // isInitialized stays false so retryInitialize() can re-run
      }
      vapidPublicKey.value = result.publicKey
    }
    
    if (!vapidPublicKey.value) {
      debug.log('Push notifications not configured on server')
      return
    }

    await checkSubscriptionStatus()
    
    if (subscriptions.value.length === 0) {
      await fetchSubscriptions()
    }

    isInitialized = true
    debug.log('Push notification system initialized', {
      supported: isSupported.value,
      permission: permission.value,
      subscribed: isSubscribed.value,
      subscriptionCount: subscriptions.value.length,
      isPWA: isPWA()
    })
  } finally {
    isInitializing = false
  }
}

export function usePushNotifications() {
  // initialize() is not auto-called; callers invoke it explicitly to avoid
  // duplicate API calls when several components mount at once.

  const canSubscribe = computed(() => {
    return isSupported.value && 
           vapidPublicKey.value && 
           permission.value !== 'denied' &&
           !isSubscribed.value
  })

  const canUnsubscribe = computed(() => {
    return isSupported.value && isSubscribed.value
  })

  const statusText = computed(() => {
    if (!isSupported.value) {
      return 'Push notifications are not supported in this browser'
    }
    if (!vapidPublicKey.value) {
      return 'Push notifications are not configured on this server'
    }
    if (permission.value === 'denied') {
      return 'Notification permission denied. Please enable in browser settings.'
    }
    if (isSubscribed.value) {
      return 'Push notifications are enabled'
    }
    return 'Push notifications are available'
  })

  const requiresPWA = computed(() => {
    // iOS delivers push only to an installed PWA.
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
    return isIOS && !isPWA()
  })

  return {
    // State
    isSupported,
    isSubscribed,
    isLoading,
    permission,
    subscriptions,
    error,
    
    // Computed
    canSubscribe,
    canUnsubscribe,
    statusText,
    requiresPWA,
    
    // Methods
    initialize,
    subscribe,
    unsubscribe,
    deleteSubscription,
    removeSubscription,
    fetchSubscriptions,
    sendTestNotification,
    checkSubscriptionStatus,
    resetState,
    retryInitialize
  }
}

