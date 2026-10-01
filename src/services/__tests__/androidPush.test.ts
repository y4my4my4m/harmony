import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'

const { invoke, addPluginListener, routerPush, markManyAsRead } = vi.hoisted(() => ({
  invoke: vi.fn(),
  addPluginListener: vi.fn(async () => ({ unregister: vi.fn() })),
  routerPush: vi.fn(async () => undefined),
  markManyAsRead: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke, addPluginListener }))
vi.mock('@/services/androidReleaseNotice', () => ({ isAndroidApp: () => true }))
vi.mock('@/services/instanceConfig', () => ({
  apiUrl: (path: string) => `https://instance.test${path}`,
  isTauriRuntime: () => true,
  getStoredInstance: () => null,
}))
vi.mock('@/utils/pwaUtils', () => ({ isPWA: () => false }))
vi.mock('@/router', () => ({ default: { push: routerPush } }))
vi.mock('@/stores/useNotification', () => ({ useNotificationStore: () => ({ markManyAsRead }) }))
const auth = vi.hoisted(() => ({ isLoggedIn: true }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))

import {
  type NativePushStatus,
  cancelNativeNotifications,
  chooseTransport,
  consumeLaunchTarget,
  decideAndroidRegistration,
  launchTargetIds,
  readAndroidRecord,
  resolveLaunchRoute,
  REREGISTER_AFTER_MS,
  transportLabel,
} from '@/services/androidPush'

const NTFY = { id: 'io.heckel.ntfy', name: 'ntfy' }
const NEXTPUSH = { id: 'org.unifiedpush.distributor.nextpush', name: 'NextPush' }
const VAPID = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
const FCM_TOKEN = 'fcm-token-' + 'x'.repeat(120)

function status(over: Partial<NativePushStatus> & { up?: Partial<NativePushStatus['unifiedPush']> } = {}): NativePushStatus {
  return {
    fcm: over.fcm ?? 'available',
    permission: over.permission ?? 'granted',
    unifiedPush: { distributors: [], distributor: null, endpoint: null, failure: null, ...over.up },
  }
}

describe('chooseTransport', () => {
  const both = { fcm: true, unifiedpush: true }

  it('uses FCM automatically when device and server support it', () => {
    expect(chooseTransport('auto', status(), both)).toEqual({ kind: 'fcm' })
  })

  it('prefers a distributor the user picked before', () => {
    const s = status({ up: { distributors: [NTFY], distributor: NTFY.id } })
    expect(chooseTransport('auto', s, both)).toEqual({ kind: 'unifiedpush', distributor: NTFY.id })
  })

  it('falls back to a sole distributor without Play Services', () => {
    const s = status({ fcm: 'no_play_services', up: { distributors: [NTFY] } })
    expect(chooseTransport('auto', s, both)).toEqual({ kind: 'unifiedpush', distributor: NTFY.id })
  })

  it('waits for the user when several distributors are installed', () => {
    const s = status({ fcm: 'no_config', up: { distributors: [NTFY, NEXTPUSH] } })
    expect(chooseTransport('auto', s, both)).toEqual({ kind: 'off', reason: 'choose_distributor' })
  })

  it('stays off with neither transport, as the app behaved before push', () => {
    expect(chooseTransport('auto', status({ fcm: 'no_config' }), both)).toEqual({ kind: 'off', reason: 'unavailable' })
    expect(chooseTransport('auto', status(), { fcm: false, unifiedpush: false })).toEqual({ kind: 'off', reason: 'unavailable' })
  })

  it('honours explicit choices, and reports them unavailable rather than substituting', () => {
    const s = status({ up: { distributors: [NTFY] } })
    expect(chooseTransport('off', s, both)).toEqual({ kind: 'off', reason: 'user' })
    expect(chooseTransport('fcm', status({ fcm: 'no_play_services' }), both)).toEqual({ kind: 'off', reason: 'unavailable' })
    expect(chooseTransport(`unifiedpush:${NTFY.id}`, s, both)).toEqual({ kind: 'unifiedpush', distributor: NTFY.id })
    expect(chooseTransport(`unifiedpush:${NEXTPUSH.id}`, s, both)).toEqual({ kind: 'off', reason: 'unavailable' })
    expect(chooseTransport(`unifiedpush:${NTFY.id}`, s, { fcm: true, unifiedpush: false })).toEqual({ kind: 'off', reason: 'unavailable' })
  })

  it('labels the active transport', () => {
    expect(transportLabel({ kind: 'fcm' }, [])).toBe('Google (FCM)')
    expect(transportLabel({ kind: 'unifiedpush', distributor: NTFY.id }, [NTFY])).toBe('UnifiedPush via ntfy')
    expect(transportLabel({ kind: 'off', reason: 'user' }, [])).toBe('Off')
  })
})

describe('decideAndroidRegistration', () => {
  const now = 1_800_000_000_000
  const fcmRecord = { transport: 'fcm' as const, endpoint: 'tok-1', id: 'row-1', registeredAt: now - 1000 }

  it('registers a device the server has not seen', () => {
    expect(decideAndroidRegistration({ transport: 'fcm', current: 'tok-1', record: null, rows: [], now }))
      .toEqual({ kind: 'register' })
  })

  it('replaces a rotated token', () => {
    expect(decideAndroidRegistration({ transport: 'fcm', current: 'tok-2', record: fcmRecord, rows: [], now }))
      .toEqual({ kind: 'register', previous: 'tok-1' })
  })

  it('finds FCM rows by id, since the server masks tokens', () => {
    const rows = [{ id: 'row-1', endpoint: 'fcm:row-1', transport: 'fcm', failure_count: 0 }]
    expect(decideAndroidRegistration({ transport: 'fcm', current: 'tok-1', record: fcmRecord, rows, now }))
      .toEqual({ kind: 'none' })
    expect(decideAndroidRegistration({ transport: 'fcm', current: 'tok-1', record: fcmRecord, rows: [{ ...rows[0], failure_count: 5 }], now }))
      .toEqual({ kind: 'register' })
  })

  it('re-registers after sign-in on another account and monthly', () => {
    expect(decideAndroidRegistration({ transport: 'fcm', current: 'tok-1', record: fcmRecord, rows: [], now }))
      .toEqual({ kind: 'register' })
    expect(decideAndroidRegistration({
      transport: 'fcm', current: 'tok-1', record: { ...fcmRecord, registeredAt: now - REREGISTER_AFTER_MS - 1 }, rows: null, now,
    })).toEqual({ kind: 'register' })
  })

  it('matches UnifiedPush rows by endpoint', () => {
    const record = { transport: 'unifiedpush' as const, endpoint: 'https://ntfy.test/up1', registeredAt: now }
    expect(decideAndroidRegistration({
      transport: 'unifiedpush', current: 'https://ntfy.test/up1', record, rows: [{ id: 'r', endpoint: 'https://ntfy.test/up1', transport: 'unifiedpush' }], now,
    })).toEqual({ kind: 'none' })
    expect(decideAndroidRegistration({ transport: 'unifiedpush', current: 'https://ntfy.test/up1', record: { ...fcmRecord }, rows: [], now }))
      .toEqual({ kind: 'register' })
  })
})

describe('tap routing', () => {
  const origin = 'http://tauri.localhost'

  it('opens the url the push carried', () => {
    expect(resolveLaunchRoute({ url: '/dm/c1?messageId=m1', type: 'dm' }, origin)).toBe('/dm/c1?messageId=m1')
  })

  it('resolves from routing ids when the url is missing or leaves the app', () => {
    expect(resolveLaunchRoute({ type: 'mention', server_id: 's1', channel_id: 'c1', message_id: 'm1' }, origin))
      .toBe('/chat/s1/c1?messageId=m1')
    expect(resolveLaunchRoute({ type: 'thread_reply', url: 'https://evil.test/x', server_id: 's1', thread_id: 't1' }, origin))
      .toBe('/chat/s1/thread/t1')
    expect(resolveLaunchRoute({ type: 'activitypub_reply', post_id: 'p1' }, origin)).toBe('/social/post/p1')
  })

  it('marks every stacked row read but no local test ids', () => {
    expect(launchTargetIds({ id: 'local-3', ids: ['11111111-1111-1111-1111-111111111111', 'local-3'] }))
      .toEqual(['11111111-1111-1111-1111-111111111111'])
    expect(launchTargetIds({ id: '22222222-2222-2222-2222-222222222222' })).toEqual(['22222222-2222-2222-2222-222222222222'])
  })

  it('consumes a pending target: marks read, then navigates', async () => {
    invoke.mockReset()
    invoke.mockImplementation(async (cmd: string) => cmd === 'plugin:harmony-push|take_launch_target'
      ? { target: { id: '33333333-3333-3333-3333-333333333333', type: 'dm', url: '/dm/c9', conversation_id: 'c9' } }
      : null)
    expect(await consumeLaunchTarget()).toBe(true)
    expect(markManyAsRead).toHaveBeenCalledWith(['33333333-3333-3333-3333-333333333333'])
    expect(routerPush).toHaveBeenCalledWith('/dm/c9')
  })

  it('leaves the target pending while signed out', async () => {
    invoke.mockReset()
    auth.isLoggedIn = false
    try {
      expect(await consumeLaunchTarget()).toBe(false)
      expect(invoke).not.toHaveBeenCalled()
    } finally {
      auth.isLoggedIn = true
    }
  })

  it('does nothing without a pending target', async () => {
    invoke.mockReset()
    invoke.mockResolvedValue({ target: null })
    routerPush.mockClear()
    expect(await consumeLaunchTarget()).toBe(false)
    expect(routerPush).not.toHaveBeenCalled()
  })
})

describe('native cancellation', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(null)
  })

  it('maps dismissal criteria onto the plugin', async () => {
    await cancelNativeNotifications({ all: true })
    await cancelNativeNotifications({ notificationIds: ['a', 'b'], conversationId: 'c1' })
    expect(invoke.mock.calls).toEqual([
      ['plugin:harmony-push|cancel', { all: true }],
      ['plugin:harmony-push|cancel', { ids: ['a', 'b'] }],
      ['plugin:harmony-push|cancel', { conversationId: 'c1', channelId: null }],
    ])
  })

  it('ignores the keep-list sweep', async () => {
    await cancelNativeNotifications({ keepIds: ['a'] })
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('Android reconcile', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let native: NativePushStatus
  let serverRows: any[]

  const posts = (suffix: string) => fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith(suffix) && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)))

  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    serverRows = []
    native = status()
    invoke.mockReset()
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'plugin:harmony-push|status') return native
      if (cmd === 'plugin:harmony-push|get_fcm_token') return { token: FCM_TOKEN }
      return null
    })
    ;(supabase.auth.getSession as any).mockResolvedValue({ data: { session: { access_token: 'tok' } }, error: null })
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/status')) return new Response(JSON.stringify({ fcm: true, unifiedpush: true }))
      if (url.endsWith('/vapid-key')) return new Response(JSON.stringify({ publicKey: VAPID }))
      if (url.endsWith('/subscriptions')) return new Response(JSON.stringify({ subscriptions: serverRows }))
      if (url.endsWith('/fcm/register')) {
        serverRows = [{ id: 'row-9', endpoint: 'fcm:row-9', transport: 'fcm', failure_count: 0, created_at: '' }]
        return new Response(JSON.stringify({ success: true, id: 'row-9' }))
      }
      if (init?.method === 'POST') return new Response(JSON.stringify({ success: true }))
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('registers the FCM token after sign-in without prompting', async () => {
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    const push = usePushNotifications()
    await push.reconcile()

    expect(posts('/fcm/register')).toEqual([expect.objectContaining({ token: FCM_TOKEN })])
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('plugin:harmony-push|request_permission')
    expect(readAndroidRecord()).toMatchObject({ transport: 'fcm', endpoint: FCM_TOKEN, id: 'row-9' })
    expect(push.isSubscribed.value).toBe(true)
    expect(push.currentEndpoint.value).toBe('fcm:row-9')
  })

  it('leaves an agreeing registration alone', async () => {
    localStorage.setItem('harmony.push.android', JSON.stringify({ transport: 'fcm', endpoint: FCM_TOKEN, id: 'row-9', registeredAt: Date.now() }))
    serverRows = [{ id: 'row-9', endpoint: 'fcm:row-9', transport: 'fcm', failure_count: 0, created_at: '' }]
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    await usePushNotifications().reconcile()
    expect(posts('/fcm/register')).toEqual([])
  })

  it('registers a UnifiedPush endpoint as a Web Push subscription', async () => {
    native = status({
      fcm: 'no_play_services',
      up: { distributors: [NTFY], distributor: NTFY.id, endpoint: { url: 'https://ntfy.test/upA?up=1', p256dh: 'P', auth: 'A', temporary: false } },
    })
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    await usePushNotifications().reconcile()

    expect(posts('/subscribe')).toEqual([expect.objectContaining({
      transport: 'unifiedpush',
      subscription: { endpoint: 'https://ntfy.test/upA?up=1', keys: { p256dh: 'P', auth: 'A' } },
    })])
    expect(invoke).toHaveBeenCalledWith('plugin:harmony-push|unified_push_register', { distributor: NTFY.id, vapid: VAPID })
    expect(readAndroidRecord()).toMatchObject({ transport: 'unifiedpush', endpoint: 'https://ntfy.test/upA?up=1', distributor: NTFY.id })
  })

  it('registers nothing until notifications are allowed', async () => {
    native = status({ permission: 'prompt' })
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    await usePushNotifications().reconcile()
    expect(posts('/fcm/register')).toEqual([])
    expect(invoke.mock.calls.map(c => c[0])).not.toContain('plugin:harmony-push|get_fcm_token')
  })

  it('switching to Off detaches this device', async () => {
    localStorage.setItem('harmony.push.android', JSON.stringify({ transport: 'fcm', endpoint: FCM_TOKEN, id: 'row-9', registeredAt: Date.now() }))
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    await usePushNotifications().setAndroidTransport('off')
    expect(posts('/fcm/unregister')).toEqual([{ token: FCM_TOKEN }])
    expect(readAndroidRecord()).toBeNull()
  })

  it('switching from UnifiedPush to FCM unregisters the distributor and the endpoint', async () => {
    localStorage.setItem('harmony.push.android', JSON.stringify({ transport: 'unifiedpush', endpoint: 'https://ntfy.test/upA', distributor: NTFY.id, registeredAt: Date.now() }))
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    await usePushNotifications().setAndroidTransport('fcm')
    expect(posts('/unsubscribe')).toEqual([{ endpoint: 'https://ntfy.test/upA' }])
    expect(invoke.mock.calls.map(c => c[0])).toContain('plugin:harmony-push|unified_push_unregister')
    expect(posts('/fcm/register')).toHaveLength(1)
  })

  it('keeps the record when the server is briefly unreachable', async () => {
    localStorage.setItem('harmony.push.android', JSON.stringify({ transport: 'fcm', endpoint: FCM_TOKEN, id: 'row-9', registeredAt: Date.now() }))
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/status')
      ? new Response('down', { status: 503 })
      : new Response(JSON.stringify({ subscriptions: [] })))
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    await usePushNotifications().reconcile()
    expect(posts('/fcm/unregister')).toEqual([])
    expect(readAndroidRecord()).not.toBeNull()
  })

  it('detaches the server row on sign-out and keeps the device registration', async () => {
    localStorage.setItem('harmony.push.android', JSON.stringify({ transport: 'fcm', endpoint: FCM_TOKEN, id: 'row-9', registeredAt: Date.now() }))
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    await usePushNotifications().detachForLogout()
    expect(posts('/fcm/unregister')).toEqual([{ token: FCM_TOKEN }])
    expect(readAndroidRecord()).not.toBeNull()
  })

  it('tests this device through its own transport', async () => {
    localStorage.setItem('harmony.push.android', JSON.stringify({ transport: 'fcm', endpoint: FCM_TOKEN, id: 'row-9', registeredAt: Date.now() }))
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, sent: 1 })))
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    const result = await usePushNotifications().sendTestNotification()
    expect(result.success).toBe(true)
    expect(posts('/test')).toEqual([{ fcmToken: FCM_TOKEN }])
  })
})

describe('running-app notifications on Android', () => {
  it('go through the plugin with the row id and route', async () => {
    invoke.mockReset()
    invoke.mockImplementation(async (cmd: string) => cmd === 'plugin:notification|is_permission_granted' ? true : null)
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Harmony' })
    ;(globalThis as any).__TAURI_INTERNALS__ = {}
    vi.resetModules()
    vi.doMock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: async () => true, requestPermission: async () => 'granted' }))
    const { nativeNotify } = await import('@/services/nativeNotify')
    await nativeNotify({
      title: 'Alice mentioned you',
      sender: 'Alice',
      conversationTitle: 'Guild #general',
      message: 'hi :wave: there',
      avatarUrl: 'https://cdn.test/a.webp',
      target: { id: '44444444-4444-4444-4444-444444444444', type: 'mention', url: '/chat/s/c', server_id: 's', channel_id: 'c' },
    })
    expect(invoke).toHaveBeenCalledWith('plugin:harmony-push|show', expect.objectContaining({
      id: '44444444-4444-4444-4444-444444444444',
      type: 'mention',
      url: '/chat/s/c',
      sender: 'Alice',
      conv: 'Guild #general',
      body: 'hi there',
      avatar: 'https://cdn.test/a.webp',
    }))
    delete (globalThis as any).__TAURI_INTERNALS__
  })
})
