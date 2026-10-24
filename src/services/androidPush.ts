/**
 * Android app push: the bridge to the harmony-push Tauri plugin and the decisions around it.
 *
 * Three transports reach a closed app. FCM needs Google Play Services, a build carrying
 * google-services.json and a server holding the service account of that build's Firebase
 * project. UnifiedPush needs a distributor app (ntfy, NextPush, ...) and a server with VAPID
 * keys; the server then delivers to it as Web Push. The relay serves a build's FCM to any
 * server with VAPID keys: the server sends Web Push to the relay (federation-backend
 * routes/pushRelay.ts) at an endpoint naming this device's FCM token, and the relay forwards
 * the ciphertext through the build's Firebase project. With none, the running app still
 * shows notifications itself through the same plugin.
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
  /** Firebase project of this build; null without google-services.json. */
  fcmProject?: string | null
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
  /** Firebase project of the server's service account; absent before 1.9.0. */
  fcmProject?: string | null
}

/** A push relay that forwards to FCM, as its GET /push/status reports it. */
export interface RelaySupport {
  /** Origin of the relay's instance, e.g. https://har.mony.lol. */
  origin: string
  relay: boolean
  fcmProject: string | null
}

export type TransportPreference = 'auto' | 'fcm' | 'off' | `unifiedpush:${string}`

export type TransportChoice =
  | { kind: 'fcm' }
  | { kind: 'relay'; origin: string }
  | { kind: 'unifiedpush'; distributor: string }
  | { kind: 'off'; reason: 'user' | 'unavailable' | 'choose_distributor' }

export interface AndroidPushRecord {
  transport: 'fcm' | 'relay' | 'unifiedpush'
  /** FCM token, or the relay or UnifiedPush endpoint URL. */
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
 * Whether the server reaches this build's FCM tokens itself: it holds a service account of
 * the build's Firebase project. A server or build that names no project counts as matching.
 */
export function fcmDirect(status: Pick<NativePushStatus, 'fcm' | 'fcmProject'>, server: ServerPushSupport): boolean {
  if (status.fcm !== 'available' || !server.fcm) return false
  return !server.fcmProject || !status.fcmProject || server.fcmProject === status.fcmProject
}

/**
 * Whether this device reaches the server through the relay: FCM works on the device, the
 * server cannot reach this build's tokens but sends Web Push, and the relay forwards for this
 * build's Firebase project.
 */
export function relayReady(
  status: Pick<NativePushStatus, 'fcm' | 'fcmProject'>,
  server: ServerPushSupport,
  relay: RelaySupport | null,
): boolean {
  return relayNeeded(status, server) && !!relay?.relay && relay.fcmProject === status.fcmProject
}

/** Whether FCM would reach this device only through a relay: the relay's status is then asked. */
export function relayNeeded(status: Pick<NativePushStatus, 'fcm' | 'fcmProject'>, server: ServerPushSupport): boolean {
  return status.fcm === 'available' && !!status.fcmProject && server.unifiedpush && !fcmDirect(status, server)
}

/**
 * Which transport this device uses. A distributor the user picked wins in automatic mode;
 * otherwise FCM when the server reaches this build's tokens, then the relay, then a sole
 * installed distributor. Several distributors and no choice yet leave push off until the user
 * picks one in Settings. "Google (FCM)" means FCM directly or through the relay.
 */
export function chooseTransport(
  preference: TransportPreference,
  status: Pick<NativePushStatus, 'fcm' | 'fcmProject' | 'unifiedPush'>,
  server: ServerPushSupport,
  relay: RelaySupport | null = null,
): TransportChoice {
  const installed = status.unifiedPush.distributors.map(d => d.id)
  const direct = fcmDirect(status, server)
  const relayed = relayReady(status, server, relay)
  const google = (): TransportChoice | null =>
    direct ? { kind: 'fcm' } : relayed && relay ? { kind: 'relay', origin: relay.origin } : null

  if (preference === 'off') return { kind: 'off', reason: 'user' }
  if (preference === 'fcm') return google() ?? { kind: 'off', reason: 'unavailable' }
  if (preference.startsWith('unifiedpush:')) {
    const distributor = preference.slice('unifiedpush:'.length)
    return server.unifiedpush && installed.includes(distributor)
      ? { kind: 'unifiedpush', distributor }
      : { kind: 'off', reason: 'unavailable' }
  }

  const saved = status.unifiedPush.distributor
  if (server.unifiedpush && saved && installed.includes(saved)) return { kind: 'unifiedpush', distributor: saved }
  const viaGoogle = google()
  if (viaGoogle) return viaGoogle
  if (server.unifiedpush && installed.length === 1) return { kind: 'unifiedpush', distributor: installed[0] }
  if (server.unifiedpush && installed.length > 1) return { kind: 'off', reason: 'choose_distributor' }
  return { kind: 'off', reason: 'unavailable' }
}

/**
 * Whether the server must be told about this device's current token or endpoint. rows is
 * the account's device list, null when it could not be fetched.
 */
export function decideAndroidRegistration(input: {
  transport: 'fcm' | 'relay' | 'unifiedpush'
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
  if (choice.kind === 'relay') return `Google (FCM) through ${hostOf(choice.origin)}`
  const name = distributors.find(d => d.id === choice.distributor)?.name || choice.distributor
  return `UnifiedPush via ${name}`
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/**
 * Origin of the push relay this build's FCM messages go through: VITE_PUSH_RELAY_ORIGIN, the
 * instance that holds the build's Firebase service account. Null when unset or not https.
 */
export function pushRelayOrigin(value: string | undefined = import.meta.env.VITE_PUSH_RELAY_ORIGIN): string | null {
  const raw = (value || '').trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

/** The relay's Web Push endpoint for one FCM token (POST /push/relay/fcm/:token). */
export function relayEndpoint(origin: string, token: string): string {
  return `${origin}/api/federation/push/relay/fcm/${encodeURIComponent(token)}`
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
    if ((parsed?.transport === 'fcm' || parsed?.transport === 'relay' || parsed?.transport === 'unifiedpush') &&
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

export type RingerMode = 'normal' | 'vibrate' | 'silent'

/**
 * The phone's ringer mode, Do Not Disturb counting as silent. Null outside the Android app
 * or with a build whose plugin lacks the command.
 */
export async function ringerMode(): Promise<RingerMode | null> {
  if (!isAndroidApp()) return null
  try {
    return (await call<{ mode: RingerMode }>('ringer_mode')).mode
  } catch {
    return null
  }
}

/** One short buzz, in place of an alert sound while the phone is on vibrate. */
export async function buzz(): Promise<void> {
  if (!isAndroidApp()) return
  try {
    await call('vibrate')
  } catch { /* plugin without the command */ }
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

/** This device's FCM token and the Web Push keys the relay's messages are encrypted to. */
export async function getRelayRegistration(): Promise<{ token: string; p256dh: string; auth: string }> {
  return call<{ token: string; p256dh: string; auth: string }>('get_relay_registration')
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
