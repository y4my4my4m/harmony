import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { supabase } from '@/supabase'

const PROFILE_ID = '22222222-2222-2222-2222-222222222222'

const handlers = vi.hoisted(() => new Map<string, (payload: any) => any>())
const sw = vi.hoisted(() => ({
  dismissNotifications: vi.fn().mockResolvedValue(undefined),
  showNotification: vi.fn().mockResolvedValue(true),
}))
const currentUser = vi.hoisted(() => ({ value: null as any }))
const routerPush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: vi.fn().mockResolvedValue({ isAuthenticated: true, profileId: '22222222-2222-2222-2222-222222222222' }),
    getCurrentProfileId: vi.fn().mockResolvedValue('22222222-2222-2222-2222-222222222222'),
  },
}))

vi.mock('@/services/userDataService', () => ({
  userDataService: {
    ensureUsersLoaded: vi.fn().mockResolvedValue(undefined),
    getCurrentUser: () => currentUser.value,
  },
}))

vi.mock('@/services', () => ({
  services: {
    notifications: {
      markAsRead: vi.fn().mockResolvedValue(undefined),
      markAsUnread: vi.fn().mockResolvedValue(undefined),
      fetchNotifications: vi.fn().mockResolvedValue([]),
      deleteNotification: vi.fn().mockResolvedValue(undefined),
      deleteAllNotifications: vi.fn().mockResolvedValue(undefined),
      markMentionNotificationsForPostsAsRead: vi.fn().mockResolvedValue(true),
    },
  },
}))

vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: {
    connect: vi.fn(),
    on: vi.fn((type: string, handler: (payload: any) => any) => {
      handlers.set(type, handler)
      return () => handlers.delete(type)
    }),
    send: vi.fn(),
    disconnect: vi.fn(),
  },
}))

vi.mock('@/services/ViewContextTracker', () => ({
  viewContextTracker: {
    shouldShowNotificationUI: vi.fn().mockReturnValue({ showToast: true, showDesktop: true, playSound: true }),
    reset: vi.fn(),
  },
}))

vi.mock('@/services/ServiceWorkerManager', () => ({ serviceWorkerManager: sw }))
vi.mock('@/router', () => ({ default: { push: routerPush } }))
vi.mock('@/utils/faviconBadge', () => ({ updateFaviconBadge: vi.fn() }))
vi.mock('@/stores/auth', () => ({
  useAuthStore: vi.fn(() => ({ session: { user: { id: '11111111-1111-1111-1111-111111111111' } } })),
}))

import { useNotificationStore, mergeNotificationPage } from '@/stores/useNotification'
import { services } from '@/services'

const mk = (id: string, isRead: boolean, minutesAgo: number, type = 'mention', data: any = {}) => ({
  id,
  user_id: PROFILE_ID,
  type,
  is_read: isRead,
  data,
  created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
}) as any

// Chainable PostgREST stand-in; awaiting any link resolves to `result`, which may be a promise.
function chain(result: any) {
  const calls: Array<[string, any[]]> = []
  const proxy: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject)
      return (...args: any[]) => {
        calls.push([prop, args])
        return proxy
      }
    },
  })
  return { proxy, calls }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  handlers.clear()
  currentUser.value = null
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('merging pages keeps the badge honest', () => {
  it('keeps unread rows outside a replacing page and drops read ones', () => {
    const merged = mergeNotificationPage(
      [mk('old-unread', false, 500), mk('old-read', true, 400)],
      [mk('p1', true, 1), mk('p2', true, 2)],
      true,
    )
    expect(merged.map(n => n.id)).toEqual(['p1', 'p2', 'old-unread'])
  })

  it('does not lower the unread count when the full list loads', async () => {
    const store = useNotificationStore()
    store.notifications = Array.from({ length: 60 }, (_, i) => mk(`u${i}`, false, 100 + i))
    store.updateUnreadCount()
    ;(services.notifications.fetchNotifications as any).mockResolvedValueOnce(
      Array.from({ length: 25 }, (_, i) => mk(`r${i}`, true, i)),
    )

    await store.loadFullNotificationList('auth-id')

    expect(store.unreadCount).toBe(60)
    expect(store.hasMore).toBe(true)
  })
})

describe('paging the full list', () => {
  it('skips pages that only hold preloaded unread rows', async () => {
    const store = useNotificationStore()
    const unread = Array.from({ length: 50 }, (_, i) => mk(`u${i}`, false, 10 + i))
    store.notifications = [...unread]
    store.loadedCount = 25
    store.hasMore = true
    const fetch = services.notifications.fetchNotifications as any
    fetch
      .mockResolvedValueOnce(unread.slice(25, 50))
      .mockResolvedValueOnce([mk('old-read', true, 500)])

    await store.loadMoreNotifications('auth-id')

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(store.notifications.some(n => n.id === 'old-read')).toBe(true)
    expect(store.hasMore).toBe(false)
  })
})

describe('refreshUnread', () => {
  it('adds missed rows and clears rows read on another device', async () => {
    const store = useNotificationStore()
    store.notifications = [mk('stale', false, 5), mk('kept', false, 3)]
    const { proxy } = chain({ data: [mk('kept', false, 3), mk('missed', false, 1)], error: null })
    ;(supabase.from as any).mockReturnValue(proxy)

    await store.refreshUnread(PROFILE_ID)

    const byId = Object.fromEntries(store.notifications.map(n => [n.id, n.is_read]))
    expect(byId).toEqual({ missed: false, kept: false, stale: true })
    expect(store.unreadCount).toBe(2)
  })

  it('keeps a read made while the request was in flight', async () => {
    const store = useNotificationStore()
    store.notifications = [mk('a', false, 5, 'dm', { conversation_id: 'c1' })]
    let respond!: (v: unknown) => void
    ;(supabase.from as any).mockReturnValue(chain(new Promise((r) => { respond = r })).proxy)

    const refreshing = store.refreshUnread(PROFILE_ID)
    await Promise.resolve()
    store.applyContextRead('conversation', 'c1')
    // The snapshot was taken before the read.
    respond({ data: [mk('a', false, 5, 'dm', { conversation_id: 'c1' })], error: null })
    await refreshing

    expect(store.notifications.find(n => n.id === 'a')?.is_read).toBe(true)
    expect(store.unreadCount).toBe(0)
  })

  it('keeps a row that arrived while the request was in flight', async () => {
    const store = useNotificationStore()
    store.notifications = [mk('old', false, 10)]
    let respond!: (v: unknown) => void
    ;(supabase.from as any).mockReturnValue(chain(new Promise((r) => { respond = r })).proxy)

    const refreshing = store.refreshUnread(PROFILE_ID)
    await Promise.resolve()
    store.notifications.unshift(mk('new', false, 0))
    respond({ data: [mk('old', false, 10)], error: null })
    await refreshing

    expect(store.notifications.find(n => n.id === 'new')?.is_read).toBe(false)
    expect(store.unreadCount).toBe(2)
  })

  it('leaves rows older than a full page untouched', async () => {
    const store = useNotificationStore()
    store.notifications = [mk('ancient', false, 100_000)]
    const page = Array.from({ length: 200 }, (_, i) => mk(`p${i}`, false, i))
    ;(supabase.from as any).mockReturnValue(chain({ data: page, error: null }).proxy)

    await store.refreshUnread(PROFILE_ID)

    expect(store.notifications.find(n => n.id === 'ancient')?.is_read).toBe(false)
  })
})

describe('start-up', () => {
  it('registers the event handlers before the first unread fetch', async () => {
    const store = useNotificationStore()
    let registeredAtFetch: boolean | null = null
    ;(supabase.from as any).mockImplementation((table: string) => {
      if (table === 'notifications' && registeredAtFetch === null) registeredAtFetch = handlers.has('notification:new')
      return chain({ data: table === 'notifications' ? [] : null, error: null }).proxy
    })

    try {
      await store.initializeUnreadCountOnly('auth-id')
      expect(registeredAtFetch).toBe(true)
    } finally {
      store.cleanupBroadcastHandlers()
    }
  })

  it('a read received during the full-list fetch survives the fetched page', async () => {
    const store = useNotificationStore()
    store.notifications = [mk('a', false, 3)]
    let respond!: (v: unknown) => void
    ;(services.notifications.fetchNotifications as any).mockReturnValueOnce(new Promise((r) => { respond = r }))
    await store.setupBroadcastNotificationHandlers('auth-id')
    try {
      const loading = store.loadFullNotificationList('auth-id')
      await vi.waitFor(() => expect(services.notifications.fetchNotifications).toHaveBeenCalled())
      handlers.get('notification:update')!({ id: 'a', is_read: true })
      respond([mk('a', false, 3), mk('b', true, 4)])
      await loading

      expect(store.notifications.find(n => n.id === 'a')?.is_read).toBe(true)
      expect(store.unreadCount).toBe(0)
    } finally {
      store.cleanupBroadcastHandlers()
    }
  })
})

describe('the Mentions feed', () => {
  it('rejects when the read cannot be stored, so the view retries, and keeps the local read', async () => {
    const store = useNotificationStore()
    store.notifications = [mk('m', false, 1, 'activitypub_mention', { post_id: 'p1' })]
    ;(services.notifications.markMentionNotificationsForPostsAsRead as any).mockRejectedValueOnce(new Error('offline'))

    await expect(store.markMentionNotificationsForPostsAsRead(['p1'])).rejects.toThrow('offline')
    expect(store.unreadCount).toBe(0)
  })
})

describe('cross-device events', () => {
  it('removes rows deleted elsewhere and closes their system notifications', async () => {
    const store = useNotificationStore()
    store.notifications = [mk('a', false, 1), mk('b', false, 2)]
    store.loadedCount = 2
    await store.setupBroadcastNotificationHandlers('auth-id')

    handlers.get('notification:deleted')!({ ids: ['a'] })
    await Promise.resolve()

    expect(store.notifications.map(n => n.id)).toEqual(['b'])
    expect(store.unreadCount).toBe(1)
    expect(store.loadedCount).toBe(1)
    await vi.waitFor(() => expect(sw.dismissNotifications).toHaveBeenCalledWith({ notificationIds: ['a'] }))
    store.cleanupBroadcastHandlers()
  })

  it('marks everything read and clears the tray on bulk_read', async () => {
    const store = useNotificationStore()
    store.notifications = [mk('a', false, 1), mk('b', false, 2)]
    await store.setupBroadcastNotificationHandlers('auth-id')

    handlers.get('notification:bulk_read')!({ count: 2 })

    expect(store.unreadCount).toBe(0)
    await vi.waitFor(() => expect(sw.dismissNotifications).toHaveBeenCalledWith({ all: true }))
    store.cleanupBroadcastHandlers()
  })

  it('closes the system notification when a row is read elsewhere', async () => {
    const store = useNotificationStore()
    store.notifications = [mk('a', false, 1, 'dm', { conversation_id: 'c1' })]
    await store.setupBroadcastNotificationHandlers('auth-id')

    handlers.get('notification:update')!({ id: 'a', is_read: true })

    expect(store.unreadCount).toBe(0)
    await vi.waitFor(() => expect(sw.dismissNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ notificationIds: ['a'], conversationId: 'c1' }),
    ))
    store.cleanupBroadcastHandlers()
  })
})

describe('opening a conversation', () => {
  it('marks its loaded rows read without waiting for realtime', async () => {
    const store = useNotificationStore()
    store.notifications = [
      mk('a', false, 1, 'dm', { conversation: { id: 'c1' } }),
      mk('b', false, 2, 'dm', { conversation_id: 'c1' }),
      mk('c', false, 3, 'dm', { conversation_id: 'c2' }),
    ]

    store.applyContextRead('conversation', 'c1')

    expect(store.notifications.filter(n => !n.is_read).map(n => n.id)).toEqual(['c'])
    expect(store.unreadCount).toBe(1)
    await vi.waitFor(() => expect(sw.dismissNotifications).toHaveBeenCalledWith({ notificationIds: ['a', 'b'] }))
  })
})

describe('reads from the system tray', () => {
  it('marks rows read by id, loaded or not', async () => {
    const store = useNotificationStore()
    store.notifications = [mk('a', false, 1)]
    const { proxy, calls } = chain({ error: null })
    ;(supabase.from as any).mockReturnValue(proxy)

    await store.markManyAsRead(['a', 'not-loaded', 'a'])

    expect(store.unreadCount).toBe(0)
    expect(calls).toContainEqual(['in', ['id', ['a', 'not-loaded']]])
  })
})

describe('silence and sign-out', () => {
  it('stores but does not alert while the user is Busy', async () => {
    currentUser.value = { status: 3 }
    const store = useNotificationStore()
    store.preferences = { sound_notifications: true, desktop_notifications: true } as any

    await store._processIncomingNotification(mk('n1', false, 0))

    expect(store.unreadCount).toBe(1)
    expect(store.toasts).toHaveLength(0)
  })

  it('clears rows, title and tray on sign-out', async () => {
    const store = useNotificationStore()
    store.notifications = [mk('a', false, 1)]
    store.updateUnreadCount()
    expect(document.title).toMatch(/^\(1\)/)

    store.resetForLogout()

    expect(store.notifications).toHaveLength(0)
    expect(store.isInitialized).toBe(false)
    expect(document.title).not.toMatch(/^\(/)
    await vi.waitFor(() => expect(sw.dismissNotifications).toHaveBeenCalledWith({ all: true }))
  })
})

describe('click-through', () => {
  it('opens a thread reply in its thread and marks it read', async () => {
    const store = useNotificationStore()
    const n = mk('t', false, 1, 'thread_reply', { server_id: 's1', channel_id: 'c1', thread_id: 'th1', message_id: 'm1' })
    store.notifications = [n]
    ;(supabase.from as any).mockReturnValue(chain({ error: null }).proxy)

    store.handleNotificationClick(n)

    expect(routerPush).toHaveBeenCalledWith('/chat/s1/thread/th1?messageId=m1')
    expect(services.notifications.markAsRead).toHaveBeenCalledWith('t')
  })

  it('hands the worker the id and route for the system notification', async () => {
    const store = useNotificationStore()
    const n = mk('d1', false, 0, 'dm', { conversation: { id: 'c9' }, message_id: 'm9', sender: { username: 'ann' } })
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    vi.stubGlobal('Notification', { permission: 'granted' })

    await store.showDesktopNotification(n, { title: 'ann sent you a message', message: 'hi' }, { silent: true })
    focus.mockRestore()

    expect(sw.showNotification).toHaveBeenCalledWith('ann sent you a message', expect.objectContaining({
      tag: 'harmony-dm-conv-c9',
      silent: true,
      data: expect.objectContaining({ notification_id: 'd1', url: '/dm/c9?messageId=m9', conversation_id: 'c9' }),
    }))
  })
})
