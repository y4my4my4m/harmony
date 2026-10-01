/**
 * Android app push: the bridge to the harmony-push Tauri plugin and the decisions around it.
 *
 * Two transports reach a closed app. FCM needs Google Play Services, a build carrying
 * google-services.json and a server with a Firebase service account. UnifiedPush needs a
 * distributor app (ntfy, NextPush, ...) and a server with VAPID keys; the server then
 * delivers to it as Web Push. With neither, the running app still shows notifications
 * itself through the same plugin.
 *
 * Kotlin side: src-tauri/crates/tauri-plugin-harmony-push/android.
 */

import { isAndroidApp } from '@/services/androidReleaseNotice'
import { resolveNotificationRoute, toAppPath } from '@/utils/notificationRoute'
import { debug } from '@/utils/debug'

export { isAndroidApp }

const PLUGIN = 'plugin:harmony-push'
const PREFERENCE_KEY = 'harmony.push.transport'
const RECORD_KEY = 'harmony.push.android'
/** Registrations are refreshed monthly so cleanup_stale_push_subscriptions never expires them. */
export const REREGISTER_AFTER_MS = 30 * 24 * 60 * 60 * 1000
const MAX_SERVER_FAILURES = 5

export type FcmState = 'available' | 'no_config' | 'no_play_services'
export type NativePermission = 'granted' | 'denied' | 'prompt'

export interface Distributor {
  id: string
  name: string
}

export interface UnifiedPushEndpoint {
  url: string
  p256dh: string
  auth: string
  temporary: boolean
}

export interface NativePushStatus {
  fcm: FcmState
  permission: NativePermission
  unifiedPush: {
    distributors: Distributor[]
    /** Distributor the connector has saved, if still installed. */
    distributor: string | null
    endpoint: UnifiedPushEndpoint | null
    failure: string | null
  }
}

/** Transports the federation backend can deliver to (GET /push/status). */
export interface ServerPushSupport {
  fcm: boolean
  unifiedpush: boolean
}

export type TransportPreference = 'auto' | 'fcm' | 'off' | `unifiedpush:${string}`

export type TransportChoice =
  | { kind: 'fcm' }
  | { kind: 'unifiedpush'; distributor: string }
  | { kind: 'off'; reason: 'user' | 'unavailable' | 'choose_distributor' }

export interface AndroidPushRecord {
  transport: 'fcm' | 'unifiedpush'
  /** FCM token, or the UnifiedPush endpoint URL. */
  endpoint: string
  /** push_subscriptions row id; the server lists FCM rows by id only. */
  id?: string
  distributor?: string
  registeredAt: number
}

export interface ServerRow {
  id: string
  endpoint: string
  transport?: string
  failure_count?: number
}

export type AndroidRegistration =
  | { kind: 'none' }
  | { kind: 'register'; previous?: string }

export interface PushLaunchTarget {
  id?: string
  ids?: string[]
  type?: string
  url?: string
  conversation_id?: string
  server_id?: string
  channel_id?: string
  thread_id?: string
  message_id?: string
  post_id?: string
}

/** Payload of the plugin's show command; the field names of appPushData on the server. */
export interface NativeNotification {
  id: string
  type: string
  title: string
  body: string
  sender?: string
  conv?: string
  avatar?: string
  icon?: string
  url?: string
  conversation_id?: string
  server_id?: string
  channel_id?: string
  thread_id?: string
  message_id?: string
  post_id?: string
}

export interface CancelCriteria {
  notificationIds?: string[]
  conversationId?: string
  channelId?: string
  all?: boolean
  keepIds?: string[]
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * Which transport this device uses. A distributor the user picked wins in automatic mode;
 * otherwise FCM when both ends support it, then a sole installed distributor. Several
 * distributors and no choice yet leave push off until the user picks one in Settings.
 */
export function chooseTransport(
  preference: TransportPreference,
  status: Pick<NativePushStatus, 'fcm' | 'unifiedPush'>,
  server: ServerPushSupport,
): TransportChoice {
  const installed = status.unifiedPush.distributors.map(d => d.id)
  const fcmReady = status.fcm === 'available' && server.fcm

  if (preference === 'off') return { kind: 'off', reason: 'user' }
  if (preference === 'fcm') return fcmReady ? { kind: 'fcm' } : { kind: 'off', reason: 'unavailable' }
  if (preference.startsWith('unifiedpush:')) {
    const distributor = preference.slice('unifiedpush:'.length)
    return server.unifiedpush && installed.includes(distributor)
      ? { kind: 'unifiedpush', distributor }
      : { kind: 'off', reason: 'unavailable' }
  }

  const saved = status.unifiedPush.distributor
  if (server.unifiedpush && saved && installed.includes(saved)) return { kind: 'unifiedpush', distributor: saved }
  if (fcmReady) return { kind: 'fcm' }
  if (server.unifiedpush && installed.length === 1) return { kind: 'unifiedpush', distributor: installed[0] }
  if (server.unifiedpush && installed.length > 1) return { kind: 'off', reason: 'choose_distributor' }
  return { kind: 'off', reason: 'unavailable' }
}

/**
 * Whether the server must be told about this device's current token or endpoint. rows is
 * the account's device list, null when it could not be fetched.
 */
export function decideAndroidRegistration(input: {
  transport: 'fcm' | 'unifiedpush'
  current: string
  record: AndroidPushRecord | null
  rows: ServerRow[] | null
  now: number
}): AndroidRegistration {
  const { transport, current, record, rows, now } = input
  if (!record || record.transport !== transport) return { kind: 'register' }
  if (record.endpoint !== current) return { kind: 'register', previous: record.endpoint }
  if (now - record.registeredAt > REREGISTER_AFTER_MS) return { kind: 'register' }
  if (!rows) return { kind: 'none' }
  const row = transport === 'fcm'
    ? rows.find(r => r.id === record.id && r.transport === 'fcm')
    : rows.find(r => r.endpoint === current)
  if (!row || (row.failure_count ?? 0) >= MAX_SERVER_FAILURES) return { kind: 'register' }
  return { kind: 'none' }
}

/** App path a tapped notification opens: its url when it stays in the app, else the resolver's. */
export function resolveLaunchRoute(target: PushLaunchTarget, origin: string): string {
  const path = toAppPath(target.url, origin)
  if (path && path.startsWith('/') && !path.startsWith('//')) return path
  return resolveNotificationRoute({
    type: target.type || '',
    data: {
      conversation_id: target.conversation_id,
      server_id: target.server_id,
      channel_id: target.channel_id,
      thread_id: target.thread_id,
      message_id: target.message_id,
      post_id: target.post_id,
    },
  })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Notification rows a tap marks read; test and local ids are not rows. */
export function launchTargetIds(target: PushLaunchTarget): string[] {
  const ids = target.ids?.length ? target.ids : target.id ? [target.id] : []
  return [...new Set(ids.filter(id => UUID_RE.test(id)))]
}

export function transportLabel(choice: TransportChoice | null, distributors: Distributor[]): string {
  if (!choice || choice.kind === 'off') return 'Off'
  if (choice.kind === 'fcm') return 'Google (FCM)'
  const name = distributors.find(d => d.id === choice.distributor)?.name || choice.distributor
  return `UnifiedPush via ${name}`
}

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------

export function readTransportPreference(): TransportPreference {
  try {
    const value = localStorage.getItem(PREFERENCE_KEY)
    if (value === 'fcm' || value === 'off' || value === 'auto') return value
    if (value?.startsWith('unifiedpush:') && value.length > 'unifiedpush:'.length) return value as TransportPreference
  } catch {
    // Storage unavailable.
  }
  return 'auto'
}

export function writeTransportPreference(preference: TransportPreference): void {
  try {
    if (preference === 'auto') localStorage.removeItem(PREFERENCE_KEY)
    else localStorage.setItem(PREFERENCE_KEY, preference)
  } catch {
    // Storage unavailable; the choice lasts for this session only.
  }
}

export function readAndroidRecord(): AndroidPushRecord | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECORD_KEY) || 'null')
    if ((parsed?.transport === 'fcm' || parsed?.transport === 'unifiedpush') &&
        typeof parsed.endpoint === 'string' && typeof parsed.registeredAt === 'number') {
      return parsed
    }
  } catch {
    // Unreadable record; the next reconcile registers afresh.
  }
  return null
}

export function writeAndroidRecord(record: AndroidPushRecord | null): void {
  try {
    if (record) localStorage.setItem(RECORD_KEY, JSON.stringify(record))
    else localStorage.removeItem(RECORD_KEY)
  } catch {
    // Storage unavailable; the next reconcile falls back to server state.
  }
}

// ---------------------------------------------------------------------------
// Plugin bridge
// ---------------------------------------------------------------------------

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(`${PLUGIN}|${command}`, args)
}

/** Null outside the Android app, or when the plugin is missing from the build. */
export async function nativePushStatus(): Promise<NativePushStatus | null> {
  if (!isAndroidApp()) return null
  try {
    return await call<NativePushStatus>('status')
  } catch (error) {
    debug.warn('[androidPush] status unavailable:', error)
    return null
  }
}

export async function requestNativePermission(): Promise<NativePermission> {
  const result = await call<{ permission: NativePermission }>('request_permission')
  return result.permission
}

export async function openNativeNotificationSettings(): Promise<void> {
  await call('open_settings')
}

export async function getFcmToken(): Promise<string> {
  const result = await call<{ token: string }>('get_fcm_token')
  return result.token
}

export async function registerUnifiedPush(distributor: string, vapid: string | null): Promise<void> {
  await call('unified_push_register', { distributor, vapid })
}

export async function unregisterUnifiedPush(): Promise<void> {
  await call('unified_push_unregister')
}

export async function showNativeNotification(notification: NativeNotification): Promise<void> {
  await call('show', notification as unknown as Record<string, unknown>)
}

/**
 * keepIds is ignored: the loaded unread list can trail a push that reached the plugin while
 * the webview slept, and reads the app missed arrive as dismissal pushes instead.
 */
export async function cancelNativeNotifications(criteria: CancelCriteria): Promise<void> {
  if (!isAndroidApp()) return
  try {
    if (criteria.all) {
      await call('cancel', { all: true })
      return
    }
    if (criteria.notificationIds?.length) await call('cancel', { ids: criteria.notificationIds })
    if (criteria.conversationId || criteria.channelId) {
      await call('cancel', { conversationId: criteria.conversationId ?? null, channelId: criteria.channelId ?? null })
    }
  } catch (error) {
    debug.warn('[androidPush] cancel failed:', error)
  }
}

export async function takeLaunchTarget(): Promise<PushLaunchTarget | null> {
  try {
    const result = await call<{ target: PushLaunchTarget | null }>('take_launch_target')
    return result?.target ?? null
  } catch {
    return null
  }
}

export async function onNativePushEvent<T = Record<string, unknown>>(
  event: 'tap' | 'fcm-token' | 'unifiedpush',
  handler: (payload: T) => void,
): Promise<() => void> {
  const { addPluginListener } = await import('@tauri-apps/api/core')
  const listener = await addPluginListener<T>('harmony-push', event, handler)
  return () => { void listener.unregister() }
}

// ---------------------------------------------------------------------------
// Tap routing
// ---------------------------------------------------------------------------

/**
 * Opens the target of a tapped notification, if one is pending, and marks it read. Signed
 * out, the target stays with the plugin until the next sign-in.
 */
export async function consumeLaunchTarget(): Promise<boolean> {
  const { useAuthStore } = await import('@/stores/auth')
  if (!useAuthStore().isLoggedIn) return false
  const target = await takeLaunchTarget()
  if (!target) return false
  const ids = launchTargetIds(target)
  if (ids.length) {
    const { useNotificationStore } = await import('@/stores/useNotification')
    useNotificationStore().markManyAsRead(ids).catch(error => debug.warn('[androidPush] mark read failed:', error))
  }
  const { default: router } = await import('@/router')
  await router.push(resolveLaunchRoute(target, window.location.origin)).catch(error => {
    debug.warn('[androidPush] navigation failed:', error)
  })
  return true
}

let initialized = false

/**
 * Hooks taps, token rotation and UnifiedPush endpoint changes. Taps are consumed here, after
 * sign-in: the plugin holds a cold-start target until then.
 */
export async function initAndroidPush(onRegistrationChange: (event: Record<string, unknown>) => void): Promise<void> {
  if (initialized || !isAndroidApp()) return
  initialized = true
  try {
    await onNativePushEvent('tap', () => { void consumeLaunchTarget() })
    await onNativePushEvent('fcm-token', payload => onRegistrationChange({ event: 'fcm-token', ...payload }))
    await onNativePushEvent('unifiedpush', payload => onRegistrationChange(payload))
  } catch (error) {
    initialized = false
    debug.warn('[androidPush] listeners unavailable:', error)
    return
  }
  await consumeLaunchTarget()
}
