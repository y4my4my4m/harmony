/**
 * Web Push subscription management.
 *
 * The browser owns the PushSubscription; the server keeps one row per (account,
 * endpoint). This device's last registered endpoint and VAPID key are kept in
 * localStorage so a rotated, expired or re-keyed subscription is replaced
 * silently on the next reconcile instead of asking the user to set push up again.
 * Only a revoked permission needs the user.
 *
 * iOS delivers Web Push only to an installed PWA (16.4+).
 */

import { ref, computed } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { isPWA } from '@/utils/pwaUtils'
import { apiUrl } from '@/services/instanceConfig'

const PUSH_BASE = '/api/federation/push'
const DEVICE_KEY = 'harmony.push.device'
// Server-side get_user_push_subscriptions skips rows at this failure count.
const MAX_SERVER_FAILURES = 5

const isSupported = ref(false)
const isSubscribed = ref(false)
const isLoading = ref(false)
const permission = ref<NotificationPermission>('default')
const vapidPublicKey = ref<string | null>(null)
const subscriptions = ref<PushSubscriptionInfo[]>([])
const currentEndpoint = ref<string | null>(null)
const error = ref<string | null>(null)

let initPromise: Promise<void> | null = null
let reconcilePromise: Promise<void> | null = null
let permissionWatchAttached = false

export interface PushSubscriptionInfo {
  id: string
  endpoint: string
  device_name?: string
  user_agent?: string
  created_at: string
  last_successful_push?: string
  failure_count: number
}

export interface DeviceRecord {
  endpoint: string
  vapidKey: string
}

export type ReconcileAction =
  | { kind: 'none' }
  | { kind: 'register'; previousEndpoint?: string }
  | { kind: 'resubscribe'; previousEndpoint?: string }
  | { kind: 'forget' }

export interface ReconcileInput {
  permission: NotificationPermission
  /** keyMatches is false when the subscription was made with another VAPID key. */
  subscription: { endpoint: string; keyMatches: boolean } | null
  stored: DeviceRecord | null
  /** endpoint -> failure_count for the signed-in account; null when the list is unavailable. */
  serverEndpoints: Map<string, number> | null
}

/**
 * What this device needs so that pushes reach it, given browser, local and server
 * state. Never asks for permission: 'resubscribe' runs only under a granted one.
 */
export function decideReconcile(input: ReconcileInput): ReconcileAction {
  const { subscription, stored, serverEndpoints } = input

  if (input.permission === 'denied') return stored ? { kind: 'forget' } : { kind: 'none' }
  if (input.permission !== 'granted') return { kind: 'none' }

  if (!subscription) {
    return stored ? { kind: 'resubscribe', previousEndpoint: stored.endpoint } : { kind: 'none' }
  }
  if (!subscription.keyMatches) {
    return { kind: 'resubscribe', previousEndpoint: subscription.endpoint }
  }

  const previousEndpoint = stored && stored.endpoint !== subscription.endpoint ? stored.endpoint : undefined
  if (previousEndpoint) return { kind: 'register', previousEndpoint }
  if (!serverEndpoints) return { kind: 'register' }

  const failures = serverEndpoints.get(subscription.endpoint)
  if (failures === undefined || failures >= MAX_SERVER_FAILURES) return { kind: 'register' }
  return { kind: 'none' }
}

export function readDeviceRecord(): DeviceRecord | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return typeof parsed?.endpoint === 'string' && typeof parsed?.vapidKey === 'string' ? parsed : null
  } catch {
    return null
  }
}

function writeDeviceRecord(record: DeviceRecord | null): void {
  try {
    if (record) localStorage.setItem(DEVICE_KEY, JSON.stringify(record))
    else localStorage.removeItem(DEVICE_KEY)
  } catch {
    // Storage unavailable; the next reconcile falls back to server state.
  }
}

function checkSupport(): boolean {
  if (typeof window === 'undefined') return false
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

async function getAuthToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession()
  return session?.access_token || null
}

/** base64url to Uint8Array, as pushManager.subscribe expects for applicationServerKey. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i)
  return outputArray
}

/**
 * True unless the subscription provably uses another key. PushSubscription.options
 * is missing on some engines; the stored key covers those.
 */
function subscriptionKeyMatches(sub: PushSubscription, vapidKey: string, stored: DeviceRecord | null): boolean {
  const key = sub.options?.applicationServerKey
  if (key) {
    const a = new Uint8Array(key)
    const b = urlBase64ToUint8Array(vapidKey)
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  if (stored && stored.endpoint === sub.endpoint) return stored.vapidKey === vapidKey
  return true
}

async function pushFetch(path: string, init: RequestInit = {}, token?: string | null): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
  if (token) headers.Authorization = `Bearer ${token}`
  if (init.body) headers['Content-Type'] = 'application/json'
  return fetch(apiUrl(`${PUSH_BASE}${path}`), { ...init, headers })
}

interface VapidFetchResult {
  publicKey: string | null
  rateLimited?: boolean
  retryAfter?: number
}

async function fetchVapidKey(): Promise<VapidFetchResult> {
  try {
    const response = await pushFetch('/vapid-key')
    if (response.status === 429) {
      const data = await response.json().catch(() => ({}))
      return { publicKey: null, rateLimited: true, retryAfter: data.retryAfter || 60 }
    }
    if (!response.ok) return { publicKey: null }
    const data = await response.json()
    return { publicKey: data.publicKey || null }
  } catch (err) {
    debug.warn('Failed to fetch VAPID key:', err)
    return { publicKey: null }
  }
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    return await navigator.serviceWorker.ready
  } catch (err) {
    debug.error('Service worker not ready:', err)
    return null
  }
}

async function getCurrentSubscription(): Promise<PushSubscription | null> {
  const registration = await getRegistration()
  if (!registration) return null
  try {
    return await registration.pushManager.getSubscription()
  } catch (err) {
    debug.error('Failed to get current subscription:', err)
    return null
  }
}

async function fetchSubscriptions(): Promise<boolean> {
  try {
    const token = await getAuthToken()
    if (!token) return false
    const response = await pushFetch('/subscriptions', {}, token)
    if (!response.ok) return false
    const data = await response.json()
    subscriptions.value = data.subscriptions || []
    return true
  } catch (err) {
    debug.error('Failed to fetch subscriptions:', err)
    return false
  }
}

async function registerWithServer(sub: PushSubscription, previousEndpoint?: string): Promise<void> {
  const token = await getAuthToken()
  if (!token) throw new Error('Not authenticated')
  const response = await pushFetch('/subscribe', {
    method: 'POST',
    body: JSON.stringify({ subscription: sub.toJSON(), previousEndpoint }),
  }, token)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || data.message || `Server error ${response.status}`)
  }
  writeDeviceRecord({ endpoint: sub.endpoint, vapidKey: vapidPublicKey.value! })
  currentEndpoint.value = sub.endpoint
}

async function createBrowserSubscription(existing: PushSubscription | null): Promise<PushSubscription> {
  const registration = await getRegistration()
  if (!registration) throw new Error('Service worker unavailable')
  if (existing) await existing.unsubscribe().catch(() => false)
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey.value!) as BufferSource,
  })
}

function refreshSubscribedFlag(sub: PushSubscription | null): void {
  currentEndpoint.value = sub?.endpoint ?? null
  isSubscribed.value = !!sub && subscriptions.value.some(s => s.endpoint === sub.endpoint)
}

function watchPermission(): void {
  if (permissionWatchAttached || !navigator.permissions?.query) return
  permissionWatchAttached = true
  navigator.permissions.query({ name: 'notifications' as PermissionName }).then((status) => {
    status.onchange = () => {
      permission.value = Notification.permission
      void reconcile()
    }
  }).catch(() => {
    permissionWatchAttached = false
  })
}

/**
 * Loads support, permission, VAPID key and the account's device list. Idempotent;
 * concurrent callers share one run.
 */
async function initialize(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      error.value = null
      isSupported.value = checkSupport()
      if (!isSupported.value) {
        // Devices can still be managed from a browser that cannot subscribe itself.
        await fetchSubscriptions()
        return
      }
      permission.value = Notification.permission
      watchPermission()

      if (!vapidPublicKey.value) {
        const result = await fetchVapidKey()
        if (result.rateLimited) {
          error.value = `Too many requests. Please wait ${result.retryAfter ?? 60} seconds and try again.`
          initPromise = null
          return
        }
        vapidPublicKey.value = result.publicKey
      }

      await fetchSubscriptions()
      refreshSubscribedFlag(await getCurrentSubscription())
    })().catch((err) => {
      initPromise = null
      debug.error('Push initialization failed:', err)
    })
  }
  return initPromise
}

/**
 * Brings this device's server registration in line with the browser without any
 * prompt. Runs after sign-in, on service worker PUSH_SUBSCRIPTION_CHANGED and when
 * the permission changes.
 */
async function reconcile(): Promise<void> {
  if (reconcilePromise) return reconcilePromise
  reconcilePromise = (async () => {
    await initialize()
    if (!isSupported.value || !vapidPublicKey.value) return
    if (!(await getAuthToken())) return

    permission.value = Notification.permission
    const stored = readDeviceRecord()
    let sub = await getCurrentSubscription()
    const listed = await fetchSubscriptions()

    const action = decideReconcile({
      permission: permission.value,
      subscription: sub ? { endpoint: sub.endpoint, keyMatches: subscriptionKeyMatches(sub, vapidPublicKey.value, stored) } : null,
      stored,
      serverEndpoints: listed ? new Map(subscriptions.value.map(s => [s.endpoint, s.failure_count ?? 0])) : null,
    })

    try {
      if (action.kind === 'forget') {
        writeDeviceRecord(null)
      } else if (action.kind === 'resubscribe') {
        sub = await createBrowserSubscription(sub)
        await registerWithServer(sub, action.previousEndpoint)
        await fetchSubscriptions()
        debug.log('Push subscription renewed')
      } else if (action.kind === 'register') {
        await registerWithServer(sub!, action.previousEndpoint)
        await fetchSubscriptions()
        debug.log('Push subscription registered for this account')
      } else if (sub && !stored) {
        writeDeviceRecord({ endpoint: sub.endpoint, vapidKey: vapidPublicKey.value })
      }
    } catch (err) {
      debug.warn('Push reconcile failed:', err)
    }
    refreshSubscribedFlag(sub)
  })().finally(() => {
    reconcilePromise = null
  })
  return reconcilePromise
}

/** Enables push on this device. Prompts for permission only when it is 'default'. */
async function subscribe(): Promise<{ success: boolean; error?: string }> {
  await initialize()
  if (!isSupported.value || !vapidPublicKey.value) {
    return { success: false, error: 'Push notifications not supported or not configured' }
  }

  isLoading.value = true
  error.value = null
  try {
    if (Notification.permission === 'default') {
      permission.value = await Notification.requestPermission()
    } else {
      permission.value = Notification.permission
    }
    if (permission.value !== 'granted') {
      return { success: false, error: 'Notification permission denied. Allow notifications for this site in your browser settings.' }
    }

    const stored = readDeviceRecord()
    let sub = await getCurrentSubscription()
    let previousEndpoint = stored?.endpoint
    if (!sub || !subscriptionKeyMatches(sub, vapidPublicKey.value, stored)) {
      previousEndpoint = sub?.endpoint ?? previousEndpoint
      sub = await createBrowserSubscription(sub)
    }
    await registerWithServer(sub, previousEndpoint !== sub.endpoint ? previousEndpoint : undefined)
    await fetchSubscriptions()
    refreshSubscribedFlag(sub)
    return { success: true }
  } catch (err: any) {
    error.value = err?.message || 'Failed to subscribe to push notifications'
    debug.error('Push subscription error:', err)
    return { success: false, error: error.value ?? undefined }
  } finally {
    isLoading.value = false
  }
}

/** Disables push on this device only: server row first, then the browser subscription. */
async function unsubscribe(): Promise<{ success: boolean; error?: string }> {
  isLoading.value = true
  error.value = null
  try {
    const sub = await getCurrentSubscription()
    const endpoint = sub?.endpoint ?? readDeviceRecord()?.endpoint
    const token = await getAuthToken()

    if (endpoint && token) {
      const response = await pushFetch('/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }, token)
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        const message = data.message || data.error || `Server error ${response.status}`
        if (response.status === 429) {
          error.value = message
          return { success: false, error: message }
        }
        debug.warn('Server unsubscribe failed:', message)
      }
    }

    if (sub) await sub.unsubscribe().catch(() => false)
    writeDeviceRecord(null)
    await fetchSubscriptions()
    refreshSubscribedFlag(null)
    return { success: true }
  } catch (err: any) {
    error.value = err?.message || 'Failed to unsubscribe'
    debug.error('Push unsubscribe error:', err)
    return { success: false, error: error.value ?? undefined }
  } finally {
    isLoading.value = false
  }
}

/**
 * Stops pushes to this device for the account signing out. The browser subscription
 * and device record stay, so the next sign-in on this device re-registers silently.
 * Bounded so a slow server cannot hold up sign-out.
 */
async function detachForLogout(timeoutMs = 3000): Promise<void> {
  if (!checkSupport()) return
  const work = (async () => {
    const sub = await getCurrentSubscription()
    const token = await getAuthToken()
    if (!sub || !token) return
    await pushFetch('/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }, token)
  })().catch((err) => debug.warn('Push detach on logout failed:', err))
  await Promise.race([work, new Promise(resolve => setTimeout(resolve, timeoutMs))])
}

/** Removes a device from the account; this browser routes through unsubscribe(). */
async function removeSubscription(subscription: { id: string; endpoint: string }): Promise<{ success: boolean; error?: string }> {
  const current = await getCurrentSubscription().catch(() => null)
  if (current && current.endpoint === subscription.endpoint) return unsubscribe()
  return deleteSubscription(subscription.id)
}

async function deleteSubscription(subscriptionId: string): Promise<{ success: boolean; error?: string }> {
  isLoading.value = true
  error.value = null
  try {
    const token = await getAuthToken()
    if (!token) return { success: false, error: 'Not authenticated' }
    const response = await pushFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' }, token)
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || 'Failed to delete subscription')
    }
    await fetchSubscriptions()
    refreshSubscribedFlag(await getCurrentSubscription())
    return { success: true }
  } catch (err: any) {
    error.value = err?.message || 'Failed to delete subscription'
    debug.error('Delete subscription error:', err)
    return { success: false, error: error.value ?? undefined }
  } finally {
    isLoading.value = false
  }
}

async function checkSubscriptionStatus(): Promise<void> {
  await fetchSubscriptions()
  refreshSubscribedFlag(await getCurrentSubscription())
}

async function retryInitialize(): Promise<void> {
  initPromise = null
  error.value = null
  await initialize()
}

/** Clears account-scoped state on sign-out; the browser subscription is kept. */
function resetState(): void {
  isSubscribed.value = false
  subscriptions.value = []
  error.value = null
  initPromise = null
}

/**
 * Sends a test push to this device. A device the server lost track of is
 * re-registered and the send retried once.
 */
async function sendTestNotification(): Promise<{ success: boolean; error?: string }> {
  isLoading.value = true
  error.value = null
  try {
    const token = await getAuthToken()
    if (!token) return { success: false, error: 'Not authenticated' }
    const endpoint = (await getCurrentSubscription())?.endpoint

    const sendTest = async () => {
      const response = await pushFetch('/test', {
        method: 'POST',
        body: JSON.stringify(endpoint ? { endpoint } : {}),
      }, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Failed to send test notification')
      return data
    }

    let data = await sendTest()
    if (data.sent === 0 && endpoint) {
      const resub = await subscribe()
      if (resub.success) data = await sendTest()
    }
    return {
      success: data.sent > 0,
      error: data.sent === 0 ? (data.message || 'No active subscriptions found') : undefined,
    }
  } catch (err: any) {
    error.value = err?.message || 'Failed to send test notification'
    debug.error('Test notification error:', err)
    return { success: false, error: error.value ?? undefined }
  } finally {
    isLoading.value = false
  }
}

export function usePushNotifications() {
  const canSubscribe = computed(() =>
    isSupported.value && !!vapidPublicKey.value && permission.value !== 'denied' && !isSubscribed.value
  )

  const canUnsubscribe = computed(() => isSupported.value && isSubscribed.value)

  const statusText = computed(() => {
    if (!isSupported.value) return 'Push notifications are not supported in this browser'
    if (!vapidPublicKey.value) return 'Push notifications are not configured on this server'
    if (permission.value === 'denied') return 'Notifications are blocked for this site'
    if (isSubscribed.value) return 'Push notifications are on for this device'
    return 'Push notifications are off for this device'
  })

  const requiresPWA = computed(() => {
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
    return isIOS && !isPWA()
  })

  return {
    isSupported,
    isSubscribed,
    isLoading,
    permission,
    subscriptions,
    currentEndpoint,
    error,

    canSubscribe,
    canUnsubscribe,
    statusText,
    requiresPWA,

    initialize,
    reconcile,
    subscribe,
    unsubscribe,
    detachForLogout,
    deleteSubscription,
    removeSubscription,
    fetchSubscriptions,
    sendTestNotification,
    checkSubscriptionStatus,
    resetState,
    retryInitialize,
  }
}
