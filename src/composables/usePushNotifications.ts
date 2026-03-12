/**
 * Push Notifications Composable
 * 
 * Handles Web Push notification subscription management for PWA
 * Supports iOS 16.4+, Android, and desktop browsers
 */

import { ref, computed } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

// Federation backend base path (proxied via nginx)
const FEDERATION_BACKEND_URL = '/api/federation'

// Push notification state (shared across all composable instances)
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
 * Check if running as installed PWA (for iOS)
 */
function isPWA(): boolean {
  // Check for standalone mode (installed PWA)
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
  const isIOSStandalone = (navigator as any).standalone === true
  
  return isStandalone || isIOSStandalone
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

/**
 * Fetch VAPID public key from server
 */
async function fetchVapidKey(): Promise<string | null> {
  try {
    const response = await fetch(`${FEDERATION_BACKEND_URL}/push/vapid-key`)
    
    if (!response.ok) {
      debug.warn('Push notifications not available on server')
      return null
    }
    
    const data = await response.json()
    return data.publicKey || null
  } catch (err) {
    debug.error('Failed to fetch VAPID key:', JSON.stringify(err))
    return null
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

    // Get service worker registration
    const registration = await navigator.serviceWorker.ready
    
    // Subscribe to push
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey.value)
    })

    // Get auth token
    const token = await getAuthToken()
    if (!token) {
      return { success: false, error: 'Not authenticated' }
    }

    // Send subscription to server
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
    
    // Refresh subscriptions list
    await fetchSubscriptions()
    
    return { success: true }
  } catch (err: any) {
    error.value = err.message || 'Failed to subscribe to push notifications'
    debug.error('Push subscription error:', err)
    return { success: false, error: error.value }
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
    // Get current subscription
    const subscription = await getCurrentSubscription()
    
    if (!subscription) {
      isSubscribed.value = false
      return { success: true }
    }

    // Unsubscribe from browser
    await subscription.unsubscribe()
    
    // Browser unsubscribed successfully - update state immediately
    // This ensures UI is consistent even if server request fails
    isSubscribed.value = false

    // Get auth token
    const token = await getAuthToken()
    if (!token) {
      // Browser already unsubscribed, but couldn't notify server
      // State is already updated, just log the issue
      debug.warn('Browser unsubscribed but could not notify server (not authenticated)')
      return { success: true } // Return success since browser is unsubscribed
    }

    // Remove from server
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
      const data = await response.json()
      debug.warn('Server unsubscribe failed:', data.error)
      // Continue anyway since browser unsubscribe succeeded
    }

    debug.log('✅ Push notification unsubscribed')
    
    // Refresh subscriptions list
    await fetchSubscriptions()
    
    return { success: true }
  } catch (err: any) {
    error.value = err.message || 'Failed to unsubscribe'
    debug.error('Push unsubscribe error:', err)
    return { success: false, error: error.value }
  } finally {
    isLoading.value = false
  }
}

/**
 * Delete a specific subscription by ID
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

    // Refresh subscriptions list
    await fetchSubscriptions()
    
    // Check if current device is still subscribed
    await checkSubscriptionStatus()

    return { success: true }
  } catch (err: any) {
    error.value = err.message || 'Failed to delete subscription'
    debug.error('Delete subscription error:', err)
    return { success: false, error: error.value }
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
    // with the server and retry — covers desync after logout/login
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
    return { success: false, error: error.value }
  } finally {
    isLoading.value = false
  }
}

/**
 * Initialize push notification system
 * Safe to call multiple times - will only initialize once
 * Only fetches VAPID key if running as PWA or user has existing subscription
 */
async function initialize(): Promise<void> {
  // Prevent duplicate initialization
  if (isInitialized || isInitializing) {
    debug.log('🔔 Push notifications already initialized, skipping')
    return
  }
  
  isInitializing = true
  
  try {
    // Check browser support
    isSupported.value = checkSupport()
    
    if (!isSupported.value) {
      debug.log('Push notifications not supported in this browser')
      return
    }

    // Check permission status
    permission.value = Notification.permission

    // Only fetch VAPID key if:
    // 1. Running as installed PWA, OR
    // 2. User already has a subscription (check first without VAPID key)
    const isPWAInstalled = isPWA()
    
    // Check if user already has a subscription (this doesn't require VAPID key)
    const existingSubscription = await getCurrentSubscription()
    
    if (!isPWAInstalled && !existingSubscription) {
      debug.log('🔔 Push notifications: Not PWA and no existing subscription, skipping VAPID fetch')
      // Still mark as initialized but don't fetch VAPID key
      isInitialized = true
      return
    }

    // Fetch VAPID key (only if PWA or has existing subscription)
    if (!vapidPublicKey.value) {
      vapidPublicKey.value = await fetchVapidKey()
    }
    
    if (!vapidPublicKey.value) {
      debug.log('Push notifications not configured on server')
      return
    }

    // Check current subscription status
    await checkSubscriptionStatus()
    
    // Fetch all subscriptions (only if not already fetched)
    if (subscriptions.value.length === 0) {
      await fetchSubscriptions()
    }

    isInitialized = true
    debug.log('🔔 Push notification system initialized', {
      supported: isSupported.value,
      permission: permission.value,
      subscribed: isSubscribed.value,
      subscriptionCount: subscriptions.value.length,
      isPWA: isPWAInstalled
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
    fetchSubscriptions,
    sendTestNotification,
    checkSubscriptionStatus,
    resetState
  }
}

