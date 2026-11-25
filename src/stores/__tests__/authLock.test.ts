import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// auth-js awaits its listeners, and holds its lock meanwhile for the events of a refresh and of a tab
// shown again. Every supabase request waits for that lock, so a listener that waits for one hangs the
// tab, and the others that share the lock. Runs against the real auth-js over a stubbed fetch.

const AUTH_KEY = vi.hoisted(() => 'sb-test-auth-token')
const net = vi.hoisted(() => ({
  sent: [] as string[],
  storage: new Map<string, string>(),
  user: { id: 'me', aud: 'authenticated', factors: [] as unknown[] },
}))
const push = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('@/supabase', async () => {
  const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' },
  })
  const supabase = createClient('http://auth.test', 'anon', {
    auth: {
      autoRefreshToken: false,
      persistSession: true,
      storageKey: AUTH_KEY,
      storage: {
        getItem: (key: string) => net.storage.get(key) ?? null,
        setItem: (key: string, value: string) => { net.storage.set(key, value) },
        removeItem: (key: string) => { net.storage.delete(key) },
      },
    },
    global: {
      fetch: async (input: RequestInfo | URL) => {
        const { pathname } = new URL(String(input))
        net.sent.push(pathname)
        if (pathname === '/auth/v1/token') return json({ code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' }, 400)
        if (pathname === '/auth/v1/user') return json(net.user)
        return json(null)
      },
    },
  })
  return { supabase, onSessionRejected: () => () => {}, signOutAndForget: async () => {}, signOutEverywhere: async () => {} }
})
vi.mock('@/router', () => ({ default: { push } }))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => ({ initialize: async () => {} }) }))
vi.mock('@/stores/useFunding', () => ({ useFundingStore: () => ({ load: async () => {} }) }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: { clearCache: () => {} } }))
vi.mock('@/services/userDataService', async () => {
  const { supabase } = await import('@/supabase')
  return { userDataService: { goOffline: async () => { await supabase.rpc('presence_offline', { p_device_id: 'd' }) } } }
})
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn(), setCurrentUser: vi.fn(), clearCurrentUser: vi.fn(), getCurrentUser: () => null },
}))

import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'

const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims))}.s`
function stored(id: string, { aal = 'aal2', expired = false } = {}) {
  const expires_at = Math.floor(Date.now() / 1000) + (expired ? -60 : 3600)
  const session = {
    access_token: jwt({ aal, sub: id, amr: [{ method: 'password' }], exp: expires_at }),
    refresh_token: `refresh-${id}`, token_type: 'bearer', expires_in: 3600, expires_at,
    user: { id, aud: 'authenticated' },
  }
  net.storage.set(AUTH_KEY, JSON.stringify(session))
  return session
}

/** The outcome, or 'hung' once auth-js has held its lock for a second. */
const orHung = <T>(work: Promise<T>) => Promise.race([work, new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000))])

let auth: any

beforeAll(async () => {
  setActivePinia(createPinia())
  auth = useAuthStore()
  auth.cleanupNotificationSystem = vi.fn()
  auth.initializeUserSettings = vi.fn()
  stored('me')
  await auth.initializeAuth()
  expect(auth.session.user.id).toBe('me')
  // What a sign-out clears reaches the server too.
  auth.clearAccountState = vi.fn(async () => { await supabase.from('voice_channel_participants').delete().eq('user_id', 'me') })
})

beforeEach(() => {
  net.sent.length = 0
  push.mockClear()
  auth.clearAccountState.mockClear()
})

describe('an auth event fired under auth-js\'s lock', () => {
  it('a refused refresh (SIGNED_OUT) returns to sign-in, and the lock is free again', async () => {
    stored('me', { expired: true })
    const refreshed = await orHung(supabase.auth.getSession())
    expect(refreshed).toMatchObject({ data: { session: null } })
    expect(auth.session).toBeNull()

    await vi.waitFor(() => expect(auth.clearAccountState).toHaveBeenCalledTimes(1))
    expect(push).toHaveBeenCalledWith('/login')
    await vi.waitFor(() => expect(net.sent).toEqual(expect.arrayContaining(['/auth/v1/token', '/rest/v1/rpc/presence_offline', '/rest/v1/voice_channel_participants'])))
    expect(await orHung(supabase.auth.getSession())).toMatchObject({ data: { session: null }, error: null })
  })

  it('another account\'s session found as the tab is shown (SIGNED_IN) is checked and adopted', async () => {
    auth.session = stored('me')
    stored('other', { aal: 'aal1' })
    net.user = { ...net.user, id: 'other' }
    const client = supabase.auth as any
    // GoTrueClient._onVisibilityChanged.
    expect(await orHung(client._acquireLock(-1, () => client._recoverAndRefresh()).then(() => 'shown'))).toBe('shown')
    await vi.waitFor(() => expect(auth.session?.user?.id).toBe('other'))
    expect(net.sent).toContain('/auth/v1/user')
    expect(auth.clearAccountState).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
  })
})
