// The view context follows every route: a route without a channel or DM must not leave
// the last one viewed, or send_notification skips it and arriving notifications are
// marked read on sight.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive } from 'vue'
import { supabase } from '@/supabase'

const route = vi.hoisted(() => ({ current: null as any }))
const applyContextRead = vi.hoisted(() => vi.fn())
const notifications = vi.hoisted(() => ({
  preferences: { desktop_notifications: true } as { desktop_notifications: boolean } | null,
  isQuietHours: false,
}))
const native = vi.hoisted(() => ({ tauri: false, granted: true }))

vi.mock('vue-router', () => ({ useRoute: () => route.current }))
vi.mock('@/stores/useNotification', () => ({
  useNotificationStore: () => ({
    applyContextRead,
    get preferences() { return notifications.preferences },
    get isQuietHours() { return notifications.isQuietHours },
  }),
}))
vi.mock('@/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform')>()),
  isTauri: () => native.tauri,
}))
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: async () => native.granted }))

import {
  viewContextForRoute,
  useViewContextTracking,
  cleanupViewContext,
  markDeviceAway,
} from '@/composables/useViewContext'
import { viewContextTracker } from '@/services/ViewContextTracker'

const rpc = vi.mocked(supabase.rpc)
const getSession = vi.mocked(supabase.auth.getSession)
// No access_token: an away report takes the RPC, not the keepalive fetch.
const signedIn = { data: { session: { user: { id: 'u1' } } }, error: null } as any
const signedOut = { data: { session: null }, error: null } as any

// syncView resolves the session before its RPC.
const settle = () => vi.advanceTimersByTimeAsync(0)

const at = (name: string, path: string, params: Record<string, string> = {}) => ({ name, path, params })

const syncedViews = () =>
  rpc.mock.calls.filter(([fn]) => fn === 'sync_view_context_from_presence').map(([, args]: any) => args.p_view_type)

const contextReads = () =>
  rpc.mock.calls.filter(([fn]) => fn === 'mark_notifications_read_by_context').map(([, args]) => args)

let hidden = false

describe('viewContextForRoute', () => {
  it('maps a channel and a DM to a viewed context and the notifications to clear', () => {
    expect(viewContextForRoute(at('ChatChannel', '/chat/s1/c1', { serverId: 's1', channelId: 'c1' }))).toEqual({
      viewType: 'server_channel', serverId: 's1', channelId: 'c1', clear: { channelId: 'c1', serverId: 's1' },
    })
    expect(viewContextForRoute(at('DMConversation', '/dm/d1', { conversationId: 'd1' }))).toEqual({
      viewType: 'dm', conversationId: 'd1', clear: { conversationId: 'd1' },
    })
  })

  it('maps a post to the social view, clearing its notifications', () => {
    expect(viewContextForRoute(at('PostDetail', '/social/post/p1', { postId: 'p1' })))
      .toEqual({ viewType: 'activitypub_home', clear: { postId: 'p1' } })
    expect(viewContextForRoute(at('DirectPost', '/posts/p2', { postId: 'p2' })))
      .toEqual({ viewType: 'activitypub_home', clear: { postId: 'p2' } })
    expect(viewContextForRoute(at('Mentions', '/social/mentions'))).toEqual({ viewType: 'activitypub_home' })
  })

  it('maps every other route to no viewed context', () => {
    expect(viewContextForRoute(at('UserSettings', '/settings/profile', { section: 'profile' }))).toEqual({ viewType: 'settings' })
    expect(viewContextForRoute(at('ServerSettings', '/server/s1', { serverId: 's1' }))).toEqual({ viewType: 'settings' })
    expect(viewContextForRoute(at('AdminPanel', '/admin'))).toEqual({ viewType: 'settings' })
    expect(viewContextForRoute(at('Today', '/today'))).toEqual({ viewType: 'home' })
    expect(viewContextForRoute(at('ThreadView', '/chat/s1/thread/t1', { serverId: 's1', threadId: 't1' })))
      .toEqual({ viewType: 'home' })
    expect(viewContextForRoute(at('Chat', '/chat'))).toEqual({ viewType: 'home' })
    expect(viewContextForRoute(at('DMHome', '/dm'))).toEqual({ viewType: 'home' })
  })
})

describe('useViewContextTracking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    rpc.mockReset()
    rpc.mockResolvedValue({ data: 0, error: null } as any)
    getSession.mockResolvedValue(signedIn)
    applyContextRead.mockReset()
    hidden = false
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  })

  afterEach(async () => {
    await cleanupViewContext()
    delete (document as any).visibilityState
    vi.useRealTimers()
  })

  const track = () => {
    const scope = effectScope()
    scope.run(() => useViewContextTracking())
    return scope
  }

  it('leaves the channel when the route leaves it, and the heartbeat repeats the new view', async () => {
    route.current = reactive(at('ChatChannel', '/chat/s1/c1', { serverId: 's1', channelId: 'c1' }))
    const scope = track()
    expect(viewContextTracker.isViewingChannel('s1', 'c1')).toBe(true)
    expect(contextReads()).toEqual([{ p_context_type: 'channel', p_context_id: 'c1' }])

    Object.assign(route.current, at('Today', '/today'))
    await nextTick()
    expect(viewContextTracker.getCurrentContext().view_type).toBe('home')
    expect(viewContextTracker.shouldShowNotificationUI({ server_id: 's1', channel_id: 'c1', type: 'mention' }).showToast).toBe(true)

    await settle()
    rpc.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(syncedViews()).toEqual(['home'])
    scope.stop()
  })

  it('reports settings and the full thread view as no viewed context', async () => {
    route.current = reactive(at('DMConversation', '/dm/d1', { conversationId: 'd1' }))
    const scope = track()
    Object.assign(route.current, at('UserSettings', '/settings/profile', { section: 'profile' }))
    await nextTick()
    Object.assign(route.current, at('ThreadView', '/chat/s1/thread/t1', { serverId: 's1', threadId: 't1' }))
    await nextTick()
    await settle()

    expect(syncedViews()).toEqual(['dm', 'settings', 'home'])
    expect(viewContextTracker.isViewingConversation('d1')).toBe(false)
    scope.stop()
  })

  it('clears the viewed channel\'s notifications when the tab is used again', async () => {
    route.current = reactive(at('ChatChannel', '/chat/s1/c1', { serverId: 's1', channelId: 'c1' }))
    const scope = track()
    await settle()
    rpc.mockClear()

    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(syncedViews()).toEqual(['away'])
    expect(contextReads()).toEqual([])

    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(syncedViews()).toEqual(['away', 'server_channel'])
    expect(contextReads()).toEqual([{ p_context_type: 'channel', p_context_id: 'c1' }])
    scope.stop()
  })

  it('clears nothing on return when no channel or DM is shown', async () => {
    route.current = reactive(at('Today', '/today'))
    const scope = track()
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    expect(contextReads()).toEqual([])
    scope.stop()
  })

  describe('device in use', () => {
    const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
    const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36'
    let permission: NotificationPermission = 'granted'
    let userAgent = DESKTOP_UA
    const realNotification = (globalThis as any).Notification

    beforeEach(() => {
      permission = 'granted'
      userAgent = DESKTOP_UA
      notifications.preferences = { desktop_notifications: true }
      notifications.isQuietHours = false
      native.tauri = false
      native.granted = true
      ;(globalThis as any).Notification = { get permission() { return permission } }
      Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => userAgent })
    })

    afterEach(() => {
      ;(globalThis as any).Notification = realNotification
      delete (navigator as any).userAgent
    })

    const hide = () => { hidden = true; document.dispatchEvent(new Event('visibilitychange')) }
    const show = () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')) }
    const inChannel = async () => {
      route.current = reactive(at('ChatChannel', '/chat/s1/c1', { serverId: 's1', channelId: 'c1' }))
      const scope = track()
      await settle()
      rpc.mockClear()
      return scope
    }

    it('keeps a computer that shows its own notifications in use while hidden, viewing nothing', async () => {
      const scope = await inChannel()
      hide()
      await vi.advanceTimersByTimeAsync(500)
      expect(syncedViews()).toEqual(['background'])
      expect(viewContextTracker.shouldShowNotificationUI({ server_id: 's1', channel_id: 'c1', type: 'mention' }).showDesktop).toBe(true)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(syncedViews()).toEqual(['background', 'background'])
      scope.stop()
    })

    it('reports away once a hidden computer has had no input for 10 minutes', async () => {
      const scope = await inChannel()
      hide()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(syncedViews().filter((v) => v !== 'background')).toEqual([])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(syncedViews().at(-1)).toBe('away')
      scope.stop()
    })

    it('reports a phone in the background away at once', async () => {
      userAgent = PHONE_UA
      const scope = await inChannel()
      hide()
      await settle()
      expect(syncedViews()).toEqual(['away'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(syncedViews()).toEqual(['away'])
      scope.stop()
    })

    it('reports a hidden browser without notification permission away at once', async () => {
      permission = 'default'
      const scope = await inChannel()
      hide()
      await settle()
      expect(syncedViews()).toEqual(['away'])
      scope.stop()
    })

    // 'background' holds push on every device; one that shows nothing itself must not report it.
    it('reports a hidden computer away when desktop notifications are off', async () => {
      notifications.preferences = { desktop_notifications: false }
      const scope = await inChannel()
      hide()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(syncedViews()).toEqual(['away'])
      scope.stop()
    })

    it('reports a hidden computer away in quiet hours', async () => {
      notifications.isQuietHours = true
      const scope = await inChannel()
      hide()
      await vi.advanceTimersByTimeAsync(500)
      expect(syncedViews()).toEqual(['away'])
      scope.stop()
    })

    it('reports a hidden computer away before its preferences load', async () => {
      notifications.preferences = null
      const scope = await inChannel()
      hide()
      await vi.advanceTimersByTimeAsync(500)
      expect(syncedViews()).toEqual(['away'])
      scope.stop()
    })

    it('reports a touch-only tablet with a desktop user agent away at once', async () => {
      const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
        matches: query === '(hover: none) and (pointer: coarse)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList)
      try {
        const scope = await inChannel()
        hide()
        await vi.advanceTimersByTimeAsync(500)
        expect(syncedViews()).toEqual(['away'])
        scope.stop()
      } finally {
        matchMedia.mockRestore()
      }
    })

    it('follows the OS notification permission in the desktop app', async () => {
      native.tauri = true
      native.granted = false
      ;(globalThis as any).Notification = undefined
      const denied = await inChannel()
      hide()
      await vi.advanceTimersByTimeAsync(500)
      expect(syncedViews()).toEqual(['away'])
      denied.stop()
      await cleanupViewContext()

      rpc.mockClear()
      native.granted = true
      hidden = false
      const granted = await inChannel()
      hide()
      await vi.advanceTimersByTimeAsync(500)
      expect(syncedViews()).toEqual(['background'])
      granted.stop()
    })

    it('reports a closing page away, never in the background', async () => {
      const scope = await inChannel()
      hide()
      window.dispatchEvent(new Event('pagehide'))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(syncedViews()).toEqual(['away'])
      scope.stop()
    })

    it('shows the view again on return from the background and reads its notifications', async () => {
      const scope = await inChannel()
      hide()
      await vi.advanceTimersByTimeAsync(500)
      show()
      await settle()
      expect(syncedViews()).toEqual(['background', 'server_channel'])
      expect(contextReads()).toEqual([{ p_context_type: 'channel', p_context_id: 'c1' }])
      scope.stop()
    })

    it('counts pointer movement as input on a visible tab', async () => {
      const scope = await inChannel()
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      window.dispatchEvent(new Event('pointermove'))
      await vi.advanceTimersByTimeAsync(3 * 60_000)
      expect(syncedViews()).not.toContain('away')
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      expect(syncedViews().at(-1)).toBe('away')
      scope.stop()
    })
  })

  // Pointer movement during sign-out, or the heartbeat, would report the tab in use again with
  // the session still valid: the account's push held and the channel's notifications skipped.
  it('keeps a signed-out tab away through input and the heartbeat until a view is recorded', async () => {
    route.current = reactive(at('ChatChannel', '/chat/s1/c1', { serverId: 's1', channelId: 'c1' }))
    const scope = track()
    await settle()
    rpc.mockClear()

    await markDeviceAway()
    window.dispatchEvent(new Event('pointermove'))
    window.dispatchEvent(new Event('keydown'))
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(syncedViews()).toEqual(['away'])

    Object.assign(route.current, at('Today', '/today'))
    await nextTick()
    await settle()
    expect(syncedViews()).toEqual(['away', 'home'])
    scope.stop()
  })

  it('drops a view report already waiting on the session when the tab signs out', async () => {
    route.current = reactive(at('ChatChannel', '/chat/s1/c1', { serverId: 's1', channelId: 'c1' }))
    const scope = track()
    await settle()
    rpc.mockClear()

    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    // The return reports the channel once getSession resolves; sign-out starts first.
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    await markDeviceAway()
    await settle()
    expect(syncedViews()).toEqual(['away', 'away'])
    scope.stop()
  })

  it('sends nothing while signed out, heartbeat included', async () => {
    getSession.mockResolvedValue(signedOut)
    route.current = reactive(at('Chat', '/'))
    const scope = track()
    await settle()
    await vi.advanceTimersByTimeAsync(60_000)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(syncedViews()).toEqual([])
    scope.stop()
  })
})
