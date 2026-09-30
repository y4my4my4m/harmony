import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'

vi.mock('@/services/instanceConfig', () => ({
  apiUrl: (path: string) => `https://instance.test${path}`,
  isTauriRuntime: () => false,
}))

vi.mock('@/utils/pwaUtils', () => ({ isPWA: () => false }))

import { decideReconcile, readDeviceRecord } from '@/composables/usePushNotifications'

const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'

describe('decideReconcile', () => {
  const sub = (endpoint: string, keyMatches = true) => ({ endpoint, keyMatches })
  const stored = (endpoint: string) => ({ endpoint, vapidKey: KEY })

  it('never acts without a granted permission', () => {
    expect(decideReconcile({ permission: 'default', subscription: null, stored: stored('e1'), serverEndpoints: null }))
      .toEqual({ kind: 'none' })
    expect(decideReconcile({ permission: 'denied', subscription: null, stored: null, serverEndpoints: null }))
      .toEqual({ kind: 'none' })
  })

  it('forgets the device when permission is revoked', () => {
    expect(decideReconcile({ permission: 'denied', subscription: null, stored: stored('e1'), serverEndpoints: null }))
      .toEqual({ kind: 'forget' })
  })

  it('leaves a device that never opted in alone', () => {
    expect(decideReconcile({ permission: 'granted', subscription: null, stored: null, serverEndpoints: new Map() }))
      .toEqual({ kind: 'none' })
  })

  it('renews a subscription the browser dropped, replacing the old endpoint', () => {
    expect(decideReconcile({ permission: 'granted', subscription: null, stored: stored('e-old'), serverEndpoints: new Map() }))
      .toEqual({ kind: 'resubscribe', previousEndpoint: 'e-old' })
  })

  it('renews a subscription made with another VAPID key', () => {
    expect(decideReconcile({ permission: 'granted', subscription: sub('e1', false), stored: stored('e1'), serverEndpoints: new Map([['e1', 0]]) }))
      .toEqual({ kind: 'resubscribe', previousEndpoint: 'e1' })
  })

  it('registers a rotated endpoint and names the one it replaces', () => {
    expect(decideReconcile({ permission: 'granted', subscription: sub('e-new'), stored: stored('e-old'), serverEndpoints: new Map([['e-old', 0]]) }))
      .toEqual({ kind: 'register', previousEndpoint: 'e-old' })
  })

  it('re-registers after sign-in when the server lost this device', () => {
    expect(decideReconcile({ permission: 'granted', subscription: sub('e1'), stored: stored('e1'), serverEndpoints: new Map() }))
      .toEqual({ kind: 'register' })
  })

  it('re-registers a device the server stopped sending to', () => {
    expect(decideReconcile({ permission: 'granted', subscription: sub('e1'), stored: stored('e1'), serverEndpoints: new Map([['e1', 5]]) }))
      .toEqual({ kind: 'register' })
  })

  it('does nothing when browser, device and server agree', () => {
    expect(decideReconcile({ permission: 'granted', subscription: sub('e1'), stored: stored('e1'), serverEndpoints: new Map([['e1', 2]]) }))
      .toEqual({ kind: 'none' })
  })
})

describe('reconcile against browser and server', () => {
  let browserSub: any
  let fetchMock: ReturnType<typeof vi.fn>
  const subscribe = vi.fn()

  const makeSub = (endpoint: string) => ({
    endpoint,
    options: { applicationServerKey: null },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  })

  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    browserSub = null
    subscribe.mockReset()
    subscribe.mockImplementation(async () => {
      browserSub = makeSub('https://push.test/renewed')
      return browserSub
    })
    const registration = {
      pushManager: {
        getSubscription: vi.fn(async () => browserSub),
        subscribe,
      },
    }
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration) } })
    ;(window as any).PushManager = function PushManager() {}
    ;(window as any).Notification = { permission: 'granted', requestPermission: vi.fn() }
    ;(supabase.auth.getSession as any).mockResolvedValue({ data: { session: { access_token: 'tok' } }, error: null })

    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/vapid-key')) return new Response(JSON.stringify({ publicKey: KEY }))
      if (url.endsWith('/subscriptions')) return new Response(JSON.stringify({ subscriptions: [] }))
      if (url.endsWith('/subscribe') && init?.method === 'POST') return new Response(JSON.stringify({ success: true }))
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  it('renews silently after the browser dropped the subscription, through apiUrl', async () => {
    localStorage.setItem('harmony.push.device', JSON.stringify({ endpoint: 'https://push.test/old', vapidKey: KEY }))
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    const push = usePushNotifications()

    await push.reconcile()

    expect((window as any).Notification.requestPermission).not.toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalledTimes(1)
    const post = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/subscribe') && init?.method === 'POST')
    expect(post?.[0]).toBe('https://instance.test/api/federation/push/subscribe')
    expect(JSON.parse(post?.[1]?.body as string)).toMatchObject({
      subscription: { endpoint: 'https://push.test/renewed' },
      previousEndpoint: 'https://push.test/old',
    })
    expect(readDeviceRecord()).toEqual({ endpoint: 'https://push.test/renewed', vapidKey: KEY })
  })

  it('does not subscribe a device that never opted in', async () => {
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    await usePushNotifications().reconcile()

    expect(subscribe).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/subscribe'))).toBe(false)
  })

  it('detaches only this endpoint on sign-out and keeps the browser subscription', async () => {
    browserSub = makeSub('https://push.test/current')
    const { usePushNotifications } = await import('@/composables/usePushNotifications')
    await usePushNotifications().detachForLogout()

    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/unsubscribe'))
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ endpoint: 'https://push.test/current' })
    expect(browserSub.unsubscribe).not.toHaveBeenCalled()
  })
})
