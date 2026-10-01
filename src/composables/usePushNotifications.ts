/**
 * Push registration for this device.
 *
 * Browsers: the browser owns the PushSubscription; the server keeps one row per (account,
 * endpoint). This device's last registered endpoint and VAPID key are kept in
 * localStorage so a rotated, expired or re-keyed subscription is replaced
 * silently on the next reconcile instead of asking the user to set push up again.
 * Only a revoked permission needs the user.
 *
 * Android app: FCM or UnifiedPush through the harmony-push plugin (src/services/androidPush.ts).
 * The same reconcile registers the chosen transport's token or endpoint after sign-in.
 *
 * iOS delivers Web Push only to an installed PWA (16.4+).
 */

import { ref, computed } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { isPWA } from '@/utils/pwaUtils'
import { apiUrl } from '@/services/instanceConfig'
import {
  type AndroidPushRecord,
  type NativePushStatus,
  type ServerPushSupport,
  type ServerRow,
  type TransportChoice,
  type TransportPreference,
  chooseTransport,
  decideAndroidRegistration,
  getFcmToken,
  initAndroidPush,
  isAndroidApp,
  nativePushStatus,
  openNativeNotificationSettings,
  readAndroidRecord,
  readTransportPreference,
  registerUnifiedPush,
  requestNativePermission,
  unregisterUnifiedPush,
  writeAndroidRecord,
  writeTransportPreference,
} from '@/services/androidPush'

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

const androidStatus = ref<NativePushStatus | null>(null)
const androidChoice = ref<TransportChoice | null>(null)
const androidPreference = ref<TransportPreference>('auto')
const serverSupport = ref<ServerPushSupport | null>(null)

let initPromise: Promise<void> | null = null
let reconcilePromise: Promise<void> | null = null
let permissionWatchAttached = false
let unifiedPushRegisteredThisSession = false

export interface PushSubscriptionInfo {
  id: string
  /** fcm:<id> for FCM rows; the server does not return tokens. */
  endpoint: string
  transport?: 'webpush' | 'unifiedpush' | 'fcm'
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
  if (isAndroidApp()) {
    reconcilePromise = reconcileAndroid().finally(() => {
      reconcilePromise = null
    })
    return reconcilePromise
  }
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
  if (isAndroidApp()) {
    const work = (async () => {
      const record = readAndroidRecord()
      const token = await getAuthToken()
      if (!record || !token) return
      await detachAndroidServerRow(record, token)
    })().catch((err) => debug.warn('Android push detach on logout failed:', err))
    await Promise.race([work, new Promise(resolve => setTimeout(resolve, timeoutMs))])
    return
  }
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
  if (isAndroidApp() && subscription.endpoint === currentEndpoint.value) {
    await setAndroidTransport('off')
    return error.value ? { success: false, error: error.value } : { success: true }
  }
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
  androidChoice.value = null
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
    const androidRecord = isAndroidApp() ? readAndroidRecord() : null
    const endpoint = androidRecord ? undefined : (await getCurrentSubscription())?.endpoint
    const target = androidRecord
      ? (androidRecord.transport === 'fcm' ? { fcmToken: androidRecord.endpoint } : { endpoint: androidRecord.endpoint })
      : endpoint ? { endpoint } : {}

    const sendTest = async () => {
      const response = await pushFetch('/test', {
        method: 'POST',
        body: JSON.stringify(target),
      }, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Failed to send test notification')
      return data
    }

    let data = await sendTest()
    if (data.sent === 0 && endpoint && !androidRecord) {
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

// ---------------------------------------------------------------------------
// Android app
// ---------------------------------------------------------------------------

async function fetchServerSupport(): Promise<ServerPushSupport> {
  try {
    const response = await pushFetch('/status')
    if (!response.ok) return { fcm: false, unifiedpush: false }
    const data = await response.json()
    return { fcm: data.fcm === true, unifiedpush: data.unifiedpush === true }
  } catch {
    return { fcm: false, unifiedpush: false }
  }
}

function serverRows(): ServerRow[] {
  return subscriptions.value.map(s => ({ id: s.id, endpoint: s.endpoint, transport: s.transport, failure_count: s.failure_count }))
}

function androidDeviceName(): string {
  const model = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\)/.exec(navigator.userAgent)?.[1]?.trim()
  return (model ? `Harmony on ${model}` : 'Harmony for Android').slice(0, 120)
}

/** Removes this device's server row; the device keeps its token or distributor registration. */
async function detachAndroidServerRow(record: AndroidPushRecord, token: string): Promise<void> {
  if (record.transport === 'fcm') {
    await pushFetch('/fcm/unregister', { method: 'POST', body: JSON.stringify({ token: record.endpoint }) }, token)
  } else {
    await pushFetch('/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: record.endpoint }) }, token)
  }
}

async function dropAndroidRecord(record: AndroidPushRecord, token: string | null): Promise<void> {
  if (token) await detachAndroidServerRow(record, token).catch(err => debug.warn('Push detach failed:', err))
  if (record.transport === 'unifiedpush') {
    await unregisterUnifiedPush().catch(err => debug.warn('UnifiedPush unregister failed:', err))
    unifiedPushRegisteredThisSession = false
  }
  writeAndroidRecord(null)
}

function refreshAndroidFlags(): void {
  const record = readAndroidRecord()
  if (!record || androidChoice.value?.kind !== record.transport) {
    currentEndpoint.value = null
    isSubscribed.value = false
    return
  }
  currentEndpoint.value = record.transport === 'fcm' ? (record.id ? `fcm:${record.id}` : null) : record.endpoint
  isSubscribed.value = !!currentEndpoint.value && subscriptions.value.some(s => s.endpoint === currentEndpoint.value)
}

async function waitForUnifiedPushEndpoint(previousUrl: string | null, timeoutMs = 10_000): Promise<NativePushStatus | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const status = await nativePushStatus()
    const endpoint = status?.unifiedPush.endpoint
    if (status?.unifiedPush.failure && !endpoint) return status
    if (endpoint && endpoint.url !== previousUrl) return status
  }
  return nativePushStatus()
}

/**
 * Brings this installation's server registration in line with the chosen transport. Never
 * prompts: without the notification permission nothing is registered.
 */
async function reconcileAndroid(): Promise<void> {
  const token = await getAuthToken()
  if (!token) return
  const status = await nativePushStatus()
  if (!status) return
  androidStatus.value = status
  androidPreference.value = readTransportPreference()
  isSupported.value = true
  permission.value = status.permission === 'prompt' ? 'default' : status.permission

  const server = await fetchServerSupport()
  serverSupport.value = server
  const choice = chooseTransport(androidPreference.value, status, server)
  androidChoice.value = choice
  const listed = await fetchSubscriptions()
  const record = readAndroidRecord()
  error.value = null

  try {
    // An unavailable transport may be a server hiccup; only a switch or "Off" drops the record.
    const switched = choice.kind === 'off' ? choice.reason === 'user' : record?.transport !== choice.kind
    if (record && switched) {
      await dropAndroidRecord(record, token)
      await fetchSubscriptions()
    }
    if (choice.kind === 'off' || status.permission !== 'granted') return

    if (choice.kind === 'fcm') {
      const fcmToken = await getFcmToken()
      const current = readAndroidRecord()
      const decision = decideAndroidRegistration({
        transport: 'fcm', current: fcmToken, record: current, rows: listed ? serverRows() : null, now: Date.now(),
      })
      if (decision.kind === 'register') {
        const response = await pushFetch('/fcm/register', {
          method: 'POST',
          body: JSON.stringify({ token: fcmToken, previousToken: decision.previous, deviceName: androidDeviceName() }),
        }, token)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `Server error ${response.status}`)
        writeAndroidRecord({ transport: 'fcm', endpoint: fcmToken, id: data.id, registeredAt: Date.now() })
        await fetchSubscriptions()
        debug.log('FCM token registered for this account')
      }
      return
    }

    let upStatus = status
    const stored = status.unifiedPush.endpoint
    if (status.unifiedPush.distributor !== choice.distributor || !stored) {
      await registerUnifiedPush(choice.distributor, vapidPublicKey.value ?? await fetchVapidKey().then(r => r.publicKey))
      unifiedPushRegisteredThisSession = true
      upStatus = (await waitForUnifiedPushEndpoint(stored?.url ?? null)) ?? status
    } else if (!unifiedPushRegisteredThisSession) {
      // Distributors expect a periodic REGISTER; a changed endpoint comes back as an event.
      unifiedPushRegisteredThisSession = true
      void registerUnifiedPush(choice.distributor, vapidPublicKey.value ?? await fetchVapidKey().then(r => r.publicKey))
        .catch(err => debug.warn('UnifiedPush re-register failed:', err))
    }
    androidStatus.value = upStatus
    const endpoint = upStatus.unifiedPush.endpoint
    if (!endpoint) throw new Error(upStatus.unifiedPush.failure
      ? `The push service refused registration (${upStatus.unifiedPush.failure})`
      : 'The push service did not answer')

    const current = readAndroidRecord()
    const decision = decideAndroidRegistration({
      transport: 'unifiedpush', current: endpoint.url, record: current, rows: listed ? serverRows() : null, now: Date.now(),
    })
    if (decision.kind === 'register') {
      const response = await pushFetch('/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          subscription: { endpoint: endpoint.url, keys: { p256dh: endpoint.p256dh, auth: endpoint.auth } },
          previousEndpoint: decision.previous,
          deviceName: androidDeviceName(),
          transport: 'unifiedpush',
        }),
      }, token)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Server error ${response.status}`)
      writeAndroidRecord({ transport: 'unifiedpush', endpoint: endpoint.url, distributor: choice.distributor, registeredAt: Date.now() })
      await fetchSubscriptions()
      debug.log('UnifiedPush endpoint registered for this account')
    }
  } catch (err: any) {
    error.value = err?.message || 'Push registration failed'
    debug.warn('Android push reconcile failed:', err)
  } finally {
    refreshAndroidFlags()
  }
}

/** Switches this device's transport; the previous one is detached by the reconcile. */
async function setAndroidTransport(preference: TransportPreference): Promise<void> {
  writeTransportPreference(preference)
  androidPreference.value = preference
  error.value = null
  await reconcile()
}

/** Asks for POST_NOTIFICATIONS, then registers when granted. */
async function enableAndroidNotifications(): Promise<boolean> {
  const status = androidStatus.value ?? await nativePushStatus()
  if (status?.permission === 'denied') {
    await openNativeNotificationSettings().catch(() => {})
    return false
  }
  const result = await requestNativePermission().catch(() => 'denied' as const)
  permission.value = result === 'prompt' ? 'default' : result
  if (result === 'granted') await reconcile()
  return result === 'granted'
}

/**
 * Plugin events: FCM rotated the token or the distributor changed the endpoint. A distributor
 * that dropped the registration clears the row until the next start or a new choice.
 */
function onAndroidRegistrationChange(event: Record<string, unknown>): void {
  if (event.event === 'unregistered') {
    const record = readAndroidRecord()
    if (record?.transport === 'unifiedpush') {
      void getAuthToken().then(token => dropAndroidRecord(record, token)).finally(refreshAndroidFlags)
    }
    return
  }
  void reconcile()
}

/** Tap routing and registration events. Idempotent; runs after sign-in. */
async function startAndroidPush(): Promise<void> {
  await initAndroidPush(onAndroidRegistrationChange)
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

    androidStatus,
    androidChoice,
    androidPreference,
    serverSupport,

    initialize,
    reconcile,
    setAndroidTransport,
    enableAndroidNotifications,
    startAndroidPush,
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
