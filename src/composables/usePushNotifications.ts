/**
 * Push Notifications Composable
 * 
 * Handles Web Push notification subscription management for PWA
 * Supports iOS 16.4+, Android, and desktop browsers
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

// Initialization state (prevents duplicate API calls)
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

/**
 * Check if push notifications are supported in this browser
 */
function checkSupport(): boolean {
  if (typeof window === 'undefined') return false
  
  // Check for required APIs
  const hasServiceWorker = 'serviceWorker' in navigator
  const hasPushManager = 'PushManager' in window
  const hasNotification = 'Notification' in window
  
  return hasServiceWorker && hasPushManager && hasNotification
}

/**
 * Get auth token for API requests
 */
async function getAuthToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token || null
}

/**
 * Convert base64 URL to Uint8Array for VAPID key
 */
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

/** Result of fetchVapidKey - includes rate limit info when 429 */
interface VapidFetchResult {
  publicKey: string | null
  rateLimited?: boolean
  retryAfter?: number
}

/**
 * Fetch VAPID public key from server
 */
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

/**
 * Get current push subscription from service worker
 */
async function getCurrentSubscription(): Promise<PushSubscription | null> {
  try {
    const registration = await navigator.serviceWorker.ready
    return await registration.pushManager.getSubscription()
  } catch (err) {
    debug.error('Failed to get current subscription:', err)
    return null
  }
}

/**
 * Subscribe to push notifications
 */
async function subscribe(deviceName?: string): Promise<{ success: boolean; error?: string }> {
  if (!isSupported.value || !vapidPublicKey.value) {
    return { success: false, error: 'Push notifications not supported or not configured' }
  }

  isLoading.value = true
  error.value = null

  try {
    // Request notification permission if needed
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
    debug.log('✅ Push notification subscription successful')
    
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

/**
 * Unsubscribe from push notifications on current device
 */
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
    
    // Browser unsubscribed successfully - update state immediately
    isSubscribed.value = false

    const token = await getAuthToken()
    if (!token) {
      // Browser already unsubscribed, but couldn't notify server
      // State is already updated, just log the issue
      debug.warn('Browser unsubscribed but could not notify server (not authenticated)')
      return { success: true } // Return success since browser is unsubscribed
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
      // Surface 429 and other errors so user knows server still has the subscription
      if (response.status === 429) {
        error.value = errMsg
        return { success: false, error: error.value ?? undefined }
      }
      debug.warn('Server unsubscribe failed:', errMsg)
    }

    debug.log('✅ Push notification unsubscribed')
    
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
 * Remove a subscription (device from list).
 * If it's the current browser's subscription, use unsubscribe() which calls
 * POST /push/unsubscribe. Otherwise use deleteSubscription() (DELETE by ID).
 * Using unsubscribe for current device avoids rate-limit issues and is the
 * canonical path for removing the active device.
 */
async function removeSubscription(subscription: { id: string; endpoint: string }): Promise<{ success: boolean; error?: string }> {
  try {
    const currentSub = await getCurrentSubscription()
    const isCurrentDevice = currentSub && currentSub.endpoint === subscription.endpoint
    if (isCurrentDevice) {
      return unsubscribe()
    }
  } catch {
    // Fall through to deleteSubscription if we can't determine current device
  }
  return deleteSubscription(subscription.id)
}

/**
 * Delete a specific subscription by ID (for removing OTHER devices)
 */
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

/**
 * Fetch all subscriptions for current user
 */
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
 * Check if this browser's push subscription belongs to the current user.
 * A PushSubscription is browser-level, not user-level. When users switch
 * accounts we must verify the subscription is registered server-side for
 * the logged-in user, not a previous one.
 */
async function checkSubscriptionStatus(): Promise<void> {
  try {
    const subscription = await getCurrentSubscription()
    if (!subscription) {
      isSubscribed.value = false
      return
    }

    // If we already fetched the user's server-side subscriptions, check
    // whether this browser's endpoint is among them.
    if (subscriptions.value.length > 0) {
      const endpoint = subscription.endpoint
      const belongsToUser = subscriptions.value.some(s => s.endpoint === endpoint)
      isSubscribed.value = belongsToUser
      return
    }

    // Subscriptions not loaded yet -- fetch them now and compare
    await fetchSubscriptions()
    const endpoint = subscription.endpoint
    isSubscribed.value = subscriptions.value.some(s => s.endpoint === endpoint)
  } catch (err) {
    debug.error('Failed to check subscription status:', err)
  }
}

/**
 * Retry initialization (e.g. after 429). Resets init state so initialize() runs again.
 */
async function retryInitialize(): Promise<void> {
  isInitialized = false
  isInitializing = false
  error.value = null
  await initialize()
}

/**
 * Reset push notification state on logout.
 * Does NOT unsubscribe from the browser so the subscription can be
 * quickly re-associated when the same user logs back in.
 */
function resetState(): void {
  isSubscribed.value = false
  subscriptions.value = []
  error.value = null
  isInitialized = false
  isInitializing = false
  debug.log('🔔 Push notification state reset (logout)')
}

/**
 * Send a test push notification.
 * If the current device's subscription isn't found on the server (e.g. after
 * logout/login cycle), automatically re-register it before retrying.
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
      // Fall back to sending to all devices
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

    // If device-specific lookup failed, re-register the browser subscription
    // with the server and retry - covers desync after logout/login
    if (data.sent === 0 && currentEndpoint) {
      debug.log('🔔 Test notification found no subscription, re-registering device...')
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
 * Initialize push notification system
 * Safe to call multiple times - will only initialize once
 * Always fetches VAPID key so the subscribe button works after removing all subscriptions
 */
async function initialize(): Promise<void> {
  // Prevent duplicate initialization
  if (isInitialized || isInitializing) {
    debug.log('🔔 Push notifications already initialized, skipping')
    return
  }
  
  isInitializing = true
  error.value = null
  
  try {
    // Check browser support
    isSupported.value = checkSupport()
    
    if (!isSupported.value) {
      debug.log('Push notifications not supported in this browser')
      return
    }

    // Check permission status
    permission.value = Notification.permission

    // Always fetch VAPID key so subscribe works after user removed all subscriptions
    if (!vapidPublicKey.value) {
      const result = await fetchVapidKey()
      if (result.rateLimited) {
        error.value = `Too many requests. Please wait ${result.retryAfter ?? 60} seconds and try again.`
        return // Don't set isInitialized so retry will work
      }
      vapidPublicKey.value = result.publicKey
    }
    
    if (!vapidPublicKey.value) {
      debug.log('Push notifications not configured on server')
      return
    }

    // Check current subscription status
    await checkSubscriptionStatus()
    
    if (subscriptions.value.length === 0) {
      await fetchSubscriptions()
    }

    isInitialized = true
    debug.log('🔔 Push notification system initialized', {
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

/**
 * Composable for push notification management
 */
export function usePushNotifications() {
  // Note: Initialize is NOT auto-called anymore to prevent duplicate API calls
  // Components should call initialize() explicitly when needed

  // Computed helpers
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
    // iOS requires PWA to be installed for push notifications
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

