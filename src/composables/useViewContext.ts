/**
 * Where this tab is looking and whether its device is in use, for notification suppression.
 *
 * The report goes to device_view_contexts through sync_view_context_from_presence:
 * send_notification skips a channel or DM a device is viewing, and, under "Only when I'm away"
 * (on by default), push is held from every device while any device is in use
 * (heldWhileDeviceInUse in federation-backend/src/services/pushPolicy.ts). A row counts for
 * 150 s after its last write; the tab rewrites it every 60 s unless it reports 'away'.
 *
 * A tab reports
 *   its view      shown on screen, with input in the last IDLE_MS;
 *   'background'  hidden, with input in the last IDLE_MS, on a computer that shows system
 *                 notifications itself (the desktop app, or a desktop browser with notification
 *                 permission): in use, viewing nothing;
 *   'away'        otherwise: no input for IDLE_MS; hidden on a phone or tablet, which notifies
 *                 through its own push; hidden without notification permission; closed; signed
 *                 out.
 *
 * Every route reports its view. One without a channel, DM or social view reports
 * 'home' or 'settings', so the last channel shown does not stay viewed.
 *
 * Nothing else carries the view: no Realtime channel, so no other client reads it.
 */

import { watch } from 'vue'
import { useRoute, type RouteLocationNormalizedLoaded } from 'vue-router'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/supabase'
import { debug } from '@/utils/debug'
import { viewContextTracker } from '@/services/ViewContextTracker'
import { sessionHeartbeat } from '@/services/SessionHeartbeat'
import { getClientDeviceId } from '@/utils/clientDeviceId'
import { isMobileDevice, isTauri } from '@/utils/platform'

export type ViewType = 'server_channel' | 'dm' | 'activitypub_home' | 'settings' | 'home'

/** viewing: the tab reports its view. */
type DevicePresence = 'viewing' | 'background' | 'away'

interface SyncedView {
  viewType: ViewType | Exclude<DevicePresence, 'viewing'>
  serverId?: string
  channelId?: string
  conversationId?: string
}

const HEARTBEAT_MS = 60_000
const IDLE_MS = 10 * 60_000
// A closing page fires pagehide right after visibilitychange. 'background' is written once
// the page has outlived this delay, so it never lands after the closing 'away'.
const BACKGROUND_DELAY_MS = 500
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

let lastView: SyncedView = { viewType: 'home' }
let presence: DevicePresence = 'viewing'
let lastInputAt = Date.now()
let heartbeat: ReturnType<typeof setInterval> | null = null
let backgroundWrite: ReturnType<typeof setTimeout> | null = null
// Between pagehide and pageshow the page is unloading or in the back/forward cache.
let pageGone = false
let accessToken: string | null = null
let detachListeners: (() => void) | null = null

/** The view this tab reports. */
export function getCurrentViewContext() {
  return viewContextTracker.getCurrentContext()
}

function rpcArgs(view: SyncedView) {
  return {
    p_view_type: view.viewType,
    p_server_id: view.serverId || null,
    p_channel_id: view.channelId || null,
    p_conversation_id: view.conversationId || null,
    p_device_id: getClientDeviceId(),
  }
}

// Signed out, nothing is sent: the RPC refuses anon. BaseLayout mounts on the initial
// route before an auth page replaces it, and the heartbeat outlives that mount.
function syncView(view: SyncedView): Promise<void> {
  return supabase.auth.getSession().then(async ({ data: { session } }) => {
    if (!session) return
    const { error } = await supabase.rpc('sync_view_context_from_presence', rpcArgs(view))
    if (error) debug.warn('Failed to sync view context to DB:', error)
  }).catch((error) => debug.warn('Failed to sync view context to DB:', error))
}

// A hiding or closing page may be torn down before a normal request completes.
function syncAwayKeepalive(): void {
  if (!accessToken) {
    void syncView({ viewType: 'away' })
    return
  }
  try {
    void fetch(`${SUPABASE_URL}/rest/v1/rpc/sync_view_context_from_presence`, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rpcArgs({ viewType: 'away' })),
    }).catch(() => {})
  } catch {
    void syncView({ viewType: 'away' })
  }
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** Shows system notifications of its own while hidden: the desktop app, or a desktop browser allowed to. */
function notifiesInBackground(): boolean {
  if (isMobileDevice()) return false
  if (isTauri()) return true
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

function presenceNow(): DevicePresence {
  if (Date.now() - lastInputAt > IDLE_MS) return 'away'
  if (!isHidden()) return 'viewing'
  return !pageGone && notifiesInBackground() ? 'background' : 'away'
}

function report(state: DevicePresence): SyncedView {
  return state === 'viewing' ? lastView : { viewType: state }
}

function cancelBackgroundWrite(): void {
  if (backgroundWrite) clearTimeout(backgroundWrite)
  backgroundWrite = null
}

function enterBackground(): void {
  if (presence === 'background') return
  presence = 'background'
  viewContextTracker.setAttentive(false)
  cancelBackgroundWrite()
  backgroundWrite = setTimeout(() => {
    backgroundWrite = null
    if (presence === 'background') void syncView(report('background'))
  }, BACKGROUND_DELAY_MS)
}

function setPresence(next: DevicePresence, viaKeepalive = false): void {
  if (next === 'background') {
    enterBackground()
    return
  }
  cancelBackgroundWrite()
  if (presence === next) return
  const was = presence
  presence = next
  viewContextTracker.setAttentive(next === 'viewing')
  if (next === 'away' && viaKeepalive) syncAwayKeepalive()
  else void syncView(report(next))
  // Notifications that arrived while not viewing were kept unread; the view is seen again.
  if (next === 'viewing' && was !== 'viewing'
    && (lastView.viewType === 'server_channel' || lastView.viewType === 'dm')) {
    void viewContextTracker.clearExistingNotificationsForContext()
  }
}

function attachListeners(): void {
  if (detachListeners || typeof window === 'undefined') return

  const onVisibility = () => {
    if (!isHidden()) {
      pageGone = false
      lastInputAt = Date.now()
    }
    setPresence(presenceNow(), true)
  }
  const onInput = () => {
    lastInputAt = Date.now()
    if (presence === 'away' && !isHidden()) setPresence('viewing')
  }
  const onPageHide = () => {
    pageGone = true
    setPresence('away', true)
  }
  const onPageShow = () => {
    pageGone = false
    onVisibility()
  }

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  INPUT_EVENTS.forEach((type) => window.addEventListener(type, onInput, { passive: true, capture: true }))

  heartbeat = setInterval(() => {
    const next = presenceNow()
    if (next !== presence) {
      setPresence(next)
      return
    }
    if (presence !== 'away' && !backgroundWrite) void syncView(report(presence))
  }, HEARTBEAT_MS)

  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    accessToken = session?.access_token ?? null
  })
  void supabase.auth.getSession().then(({ data: { session } }) => {
    accessToken = session?.access_token ?? accessToken
  })

  detachListeners = () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', onPageShow)
    INPUT_EVENTS.forEach((type) => window.removeEventListener(type, onInput, { capture: true }))
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    cancelBackgroundWrite()
    data.subscription.unsubscribe()
  }
}

/**
 * Records the view this tab shows: local suppression immediately, then the
 * database. A hidden or idle tab reports 'background' or 'away' until it is used.
 */
export async function updateViewContext(
  viewType: ViewType,
  serverId?: string,
  channelId?: string,
  conversationId?: string
): Promise<void> {
  try {
    // Local tracker first: client-side suppression must not wait for the network.
    viewContextTracker.updateContext({
      view_type: viewType === 'activitypub_home' ? 'home' : viewType,
      server_id: serverId,
      channel_id: channelId,
      conversation_id: conversationId
    })

    lastView = { viewType, serverId, channelId, conversationId }
    attachListeners()
    // Navigation is input; a tab that shows a new view is not idle.
    lastInputAt = Date.now()
    cancelBackgroundWrite()
    presence = presenceNow()
    viewContextTracker.setAttentive(presence === 'viewing')

    void syncView(report(presence))

    sessionHeartbeat.updateContext({
      serverId,
      channelId,
      conversationId
    })
  } catch (error) {
    debug.error('Error updating view context:', error)
  }
}

/**
 * Marks this tab away while the session is still valid. Used on sign-out; bounded
 * so it cannot hold sign-out up.
 */
export async function markDeviceAway(timeoutMs = 2000): Promise<void> {
  cancelBackgroundWrite()
  presence = 'away'
  viewContextTracker.setAttentive(false)
  await Promise.race([
    syncView({ viewType: 'away' }),
    new Promise(resolve => setTimeout(resolve, timeoutMs)),
  ])
}

/**
 * Initialize session heartbeat for smart push notifications
 * Call this when user logs in
 */
export async function initializeSessionHeartbeat(userId: string): Promise<void> {
  await sessionHeartbeat.initialize(userId)
}

/**
 * Cleanup view context channel on logout
 */
export async function cleanupViewContext(): Promise<void> {
  if (detachListeners) {
    detachListeners()
    detachListeners = null
  }
  cancelBackgroundWrite()
  lastView = { viewType: 'home' }
  presence = 'viewing'
  pageGone = false
  viewContextTracker.reset()

  await sessionHeartbeat.stop()
}

export interface RouteViewContext {
  viewType: ViewType
  serverId?: string
  channelId?: string
  conversationId?: string
  /** Context whose existing notifications are read on entry. */
  clear?: { channelId?: string; serverId?: string; conversationId?: string; postId?: string }
}

const SETTINGS_ROUTES = new Set(['UserSettings', 'ServerSettings', 'AdminPanel'])
const POST_ROUTES = new Set(['PostDetail', 'DirectPost'])

type RouteLike = Pick<RouteLocationNormalizedLoaded, 'name' | 'path' | 'params'>

function param(route: RouteLike, key: string): string | undefined {
  const value = route.params[key]
  const first = Array.isArray(value) ? value[0] : value
  return first || undefined
}

/**
 * The view a route shows. Only a channel or a DM is a viewed context to the
 * database; every other route reports where the tab is, so the previous one lapses.
 */
export function viewContextForRoute(route: RouteLike): RouteViewContext {
  const name = typeof route.name === 'string' ? route.name : ''
  const serverId = param(route, 'serverId')
  const channelId = param(route, 'channelId')
  const conversationId = param(route, 'conversationId')
  const postId = param(route, 'postId')

  if (name === 'ChatChannel' && serverId && channelId) {
    return { viewType: 'server_channel', serverId, channelId, clear: { channelId, serverId } }
  }
  if (name === 'DMConversation' && conversationId) {
    return { viewType: 'dm', conversationId, clear: { conversationId } }
  }
  if (POST_ROUTES.has(name) && postId) {
    return { viewType: 'activitypub_home', clear: { postId } }
  }
  if (route.path.startsWith('/social') || route.path.startsWith('/posts/')) {
    return { viewType: 'activitypub_home' }
  }
  if (SETTINGS_ROUTES.has(name)) {
    return { viewType: 'settings' }
  }
  return { viewType: 'home' }
}

/** Records the route's view on every navigation; one instance per app. */
export function useViewContextTracking() {
  const route = useRoute()

  watch(
    () => route.path,
    () => {
      const view = viewContextForRoute(route)
      void updateViewContext(view.viewType, view.serverId, view.channelId, view.conversationId)
      if (view.clear) void viewContextTracker.clearExistingNotificationsForContext(view.clear)
    },
    { immediate: true }
  )
}
