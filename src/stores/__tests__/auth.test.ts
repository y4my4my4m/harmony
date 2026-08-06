import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { supabase } from '@/supabase'

vi.mock('@/services/ProfileService', () => ({
  updateUserStatus: vi.fn(),
}))
vi.mock('@/stores/useChat', () => ({
  useChatStore: vi.fn(() => ({})),
}))
vi.mock('@/stores/useActivityPub', () => ({
  useActivityPubStore: vi.fn(() => ({
    fetchBlockedUsers: vi.fn(),
    fetchMutedUsers: vi.fn(),
    loadBlockingData: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    cleanupRealtimeSubscriptions: vi.fn(),
    clearTimelineCache: vi.fn(),
    resetUserRelationshipState: vi.fn(),
  })),
}))
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    clearAll: vi.fn(),
    setCurrentUser: vi.fn(),
    clearCurrentUser: vi.fn(),
  },
}))
vi.mock('@/services/RealtimeApiService', () => ({
  realtimeApiService: {
    goOffline: vi.fn().mockResolvedValue(undefined),
  },
}))

import { useAuthStore } from '@/stores/auth'
import { userStorage } from '@/utils/userScopedStorage'

function jwtWithAAL(aal: 'aal1' | 'aal2'): string {
  const payload = { aal, sub: 'sub-1' }
  const encoded = btoa(JSON.stringify(payload))
  return `header.${encoded}.signature`
}

// Build a JWT carrying both an AAL claim and an AMR claim. Mirrors the real
// Supabase token shape: `amr` is an array of `{ method, timestamp }` entries
// (see https://supabase.com/docs/guides/auth/auth-mfa#access-token-claims).
function jwtWithAALAndAMR(aal: 'aal1' | 'aal2', methods: string[]): string {
  const payload = {
    aal,
    sub: 'sub-1',
    amr: methods.map((m) => ({ method: m, timestamp: 1700000000 })),
  }
  const encoded = btoa(JSON.stringify(payload))
  return `header.${encoded}.signature`
}

describe('useAuthStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('initializes with null session', () => {
    const store = useAuthStore()
    expect(store.session).toBeNull()
    expect(store.isLoggedIn).toBe(false)
    expect(store.isPasswordResetMode).toBe(false)
  })

  describe('isLoggedIn getter', () => {
    it('returns false when session is null', () => {
      const store = useAuthStore()
      expect(store.isLoggedIn).toBe(false)
    })

    it('returns true when session exists', () => {
      const store = useAuthStore()
      store.session = { access_token: 'test', user: { id: '1' } } as any
      expect(store.isLoggedIn).toBe(true)
    })

    it('returns false when in password reset mode even with session', () => {
      const store = useAuthStore()
      store.session = { access_token: 'test', user: { id: '1' } } as any
      store.isPasswordResetMode = true
      expect(store.isLoggedIn).toBe(false)
    })
  })

  describe('decodeJWT', () => {
    it('decodes a valid JWT payload', () => {
      const store = useAuthStore()
      const payload = { sub: 'user-123', aal: 'aal1', exp: 9999999999 }
      const encodedPayload = btoa(JSON.stringify(payload))
      const fakeJwt = `header.${encodedPayload}.signature`
      const decoded = store.decodeJWT(fakeJwt)
      expect(decoded.sub).toBe('user-123')
      expect(decoded.aal).toBe('aal1')
    })

    it('returns null for invalid JWT', () => {
      const store = useAuthStore()
      expect(store.decodeJWT('invalid')).toBeNull()
    })
  })

  describe('getAAL', () => {
    it('returns none when session is null', () => {
      const store = useAuthStore()
      expect(store.getAAL(null)).toBe('none')
    })

    it('extracts AAL from JWT', () => {
      const store = useAuthStore()
      expect(store.getAAL({ access_token: jwtWithAAL('aal2') } as any)).toBe('aal2')
    })

    it('defaults to aal1 when AAL not in token', () => {
      const store = useAuthStore()
      const payload = { sub: 'user' }
      const encodedPayload = btoa(JSON.stringify(payload))
      const session = { access_token: `h.${encodedPayload}.s` } as any
      expect(store.getAAL(session)).toBe('aal1')
    })
  })

  describe('validateSessionForMFA', () => {
    it('returns true when session is already AAL2', async () => {
      const store = useAuthStore()
      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn().mockResolvedValue({ data: { totp: [] }, error: null }),
      }
      const ok = await store.validateSessionForMFA({ access_token: jwtWithAAL('aal2') } as any)
      expect(ok).toBe(true)
    })

    it('returns true when user has no MFA enrolled (AAL1 sufficient)', async () => {
      const store = useAuthStore()
      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn().mockResolvedValue({ data: { totp: [] }, error: null }),
      }
      const ok = await store.validateSessionForMFA({ access_token: jwtWithAAL('aal1') } as any)
      expect(ok).toBe(true)
    })

    it('returns false when MFA is enrolled but session is only AAL1', async () => {
      const store = useAuthStore()
      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn().mockResolvedValue({
          data: { totp: [{ status: 'verified' }] },
          error: null,
        }),
      }
      const ok = await store.validateSessionForMFA({ access_token: jwtWithAAL('aal1') } as any)
      expect(ok).toBe(false)
    })

    it('returns false (conservative) when listFactors errors', async () => {
      const store = useAuthStore()
      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn().mockResolvedValue({ data: null, error: new Error('boom') }),
      }
      const ok = await store.validateSessionForMFA({ access_token: jwtWithAAL('aal1') } as any)
      expect(ok).toBe(false)
    })

    // AAL1 sessions whose JWT amr already records a `totp` verification are
    // accepted after Supabase's ~24h AAL2 grace period expires. Matches the
    // long-session model in `docs/2FA_SECURITY_MODEL.md`.
    it('accepts AAL1 session when amr already records totp (post-AAL2-expiry long session)', async () => {
      const store = useAuthStore()
      const listFactors = vi.fn().mockResolvedValue({
        data: { totp: [{ status: 'verified' }] },
        error: null,
      })
      ;(supabase.auth as any).mfa = { listFactors }
      const session = {
        access_token: jwtWithAALAndAMR('aal1', ['password', 'totp']),
      } as any
      const ok = await store.validateSessionForMFA(session)
      expect(ok).toBe(true)
      // The amr fast path skips listFactors; the JWT alone records that MFA
      // completed for this session.
      expect(listFactors).not.toHaveBeenCalled()
    })

    it('still rejects AAL1 session whose amr lacks totp (mid-login or OAuth)', async () => {
      const store = useAuthStore()
      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn().mockResolvedValue({
          data: { totp: [{ status: 'verified' }] },
          error: null,
        }),
      }
      // amr only carries `password` - same shape as a fresh password
      // sign-in that hasn't yet completed MFA, or an OAuth callback.
      const session = {
        access_token: jwtWithAALAndAMR('aal1', ['password']),
      } as any
      const ok = await store.validateSessionForMFA(session)
      expect(ok).toBe(false)
    })

    // Edge: user who once verified MFA then disabled it. amr still carries
    // historical totp, but listFactors is empty. Must accept.
    it('accepts AAL1 session when amr has totp but MFA was later removed', async () => {
      const store = useAuthStore()
      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn().mockResolvedValue({ data: { totp: [] }, error: null }),
      }
      const session = {
        access_token: jwtWithAALAndAMR('aal1', ['password', 'totp']),
      } as any
      expect(await store.validateSessionForMFA(session)).toBe(true)
    })
  })

  describe('getAMR', () => {
    it('returns empty array when session is null', () => {
      const store = useAuthStore()
      expect(store.getAMR(null)).toEqual([])
    })

    it('extracts method names from amr claim', () => {
      const store = useAuthStore()
      const session = {
        access_token: jwtWithAALAndAMR('aal2', ['password', 'totp']),
      } as any
      expect(store.getAMR(session)).toEqual(['password', 'totp'])
    })

    it('returns empty array when amr is missing', () => {
      const store = useAuthStore()
      expect(store.getAMR({ access_token: jwtWithAAL('aal1') } as any)).toEqual([])
    })

    it('tolerates plain-string amr entries (older / non-Supabase tokens)', () => {
      const store = useAuthStore()
      const payload = { aal: 'aal2', sub: 'u', amr: ['password', 'totp'] }
      const encoded = btoa(JSON.stringify(payload))
      const session = { access_token: `h.${encoded}.s` } as any
      expect(store.getAMR(session)).toEqual(['password', 'totp'])
    })
  })

  describe('onAuthStateChange - SIGNED_IN with invalid AAL1 session', () => {
    it('signs out the AAL1 session, clears user storage, and leaves state null', async () => {
      let handler: ((event: string, session: any) => Promise<void>) | null = null
      ;(supabase.auth as any).onAuthStateChange = vi.fn((fn: any) => {
        handler = fn
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      })
      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn().mockResolvedValue({
          data: { totp: [{ status: 'verified' }] },
          error: null,
        }),
      }
      const signOutSpy = vi.fn().mockResolvedValue({ error: null })
      ;(supabase.auth as any).signOut = signOutSpy
      ;(supabase.auth as any).getSession = vi.fn().mockResolvedValue({ data: { session: null } })

      const store = useAuthStore()
      await store.initializeAuth()
      expect(handler).not.toBeNull()

      // Supabase fires SIGNED_IN with a brand-new AAL1 session for an
      // MFA-enrolled user. The store must not adopt it.
      await handler!('SIGNED_IN', {
        access_token: jwtWithAAL('aal1'),
        user: { id: 'new-user' },
      } as any)

      expect(signOutSpy).toHaveBeenCalled()
      expect(userStorage.clearCurrentUser).toHaveBeenCalled()
      expect(store.session).toBeNull()
    })

    it('adopts session when SIGNED_IN passes MFA validation', async () => {
      let handler: ((event: string, session: any) => Promise<void>) | null = null
      ;(supabase.auth as any).onAuthStateChange = vi.fn((fn: any) => {
        handler = fn
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      })
      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn().mockResolvedValue({ data: { totp: [] }, error: null }),
      }
      ;(supabase.auth as any).signOut = vi.fn().mockResolvedValue({ error: null })
      ;(supabase.auth as any).getSession = vi.fn().mockResolvedValue({ data: { session: null } })

      const store = useAuthStore()
      await store.initializeAuth()

      await handler!('SIGNED_IN', {
        access_token: jwtWithAAL('aal1'),
        user: { id: 'valid-user' },
      } as any)

      expect(store.session?.user?.id).toBe('valid-user')
    })
  })

  // On /auth/callback, `initializeAuth` must not run `validateSessionForMFA`.
  // `detectSessionInUrl: true` has already exchanged the code for an AAL1
  // session; the "MFA enrolled, no totp in amr" reject branch would `signOut()`
  // it before `AuthCallbackView` mounts, leaving that view's `getSession()`
  // with nothing.
  describe('initializeAuth - /auth/callback deferral', () => {
    let originalLocation: any
    beforeEach(() => {
      // happy-dom's `window.location` is read-only; redefine it for the test.
      originalLocation = window.location
      Object.defineProperty(window, 'location', {
        value: { pathname: '/auth/callback', hash: '', search: '' },
        writable: true,
        configurable: true,
      })
    })
    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    })

    it('does not validate or sign out the AAL1 OAuth session - defers to AuthCallbackView', async () => {
      const oauthSession = {
        access_token: jwtWithAALAndAMR('aal1', ['oauth']),
        user: { id: 'oauth-user' },
      }
      ;(supabase.auth as any).onAuthStateChange = vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      }))
      ;(supabase.auth as any).getSession = vi.fn().mockResolvedValue({
        data: { session: oauthSession },
      })
      const signOutSpy = vi.fn().mockResolvedValue({ error: null })
      ;(supabase.auth as any).signOut = signOutSpy
      // listFactors returns a verified factor: the path check bypasses MFA
      // validation regardless of the user's MFA state.
      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn().mockResolvedValue({
          data: { totp: [{ status: 'verified' }] },
          error: null,
        }),
      }

      const store = useAuthStore()
      await store.initializeAuth()

      // No signOut, so AuthCallbackView's getSession() still finds the AAL1
      // session and can run its MFA challenge.
      expect(signOutSpy).not.toHaveBeenCalled()
      // Adoption is AuthCallbackView's job, once validation passes or the MFA
      // challenge completes.
      expect(store.session).toBeNull()
      // Flag set so in-flight SIGNED_IN / INITIAL_SESSION events from the
      // OAuth code exchange skip the reject path in `onAuthStateChange`.
      expect((store as any)._pendingMFAVerification).toBe(true)
    })

    // gotrue-js fires INITIAL_SESSION as a microtask right after
    // `detectSessionInUrl` exchanges the OAuth code, before `AuthCallbackView`
    // mounts. The flag check must cover every event type, not only SIGNED_IN,
    // or INITIAL_SESSION's reject branch signs out the AAL1 session.
    it('INITIAL_SESSION during /auth/callback is skipped, not validated', async () => {
      const oauthSession = {
        access_token: jwtWithAALAndAMR('aal1', ['oauth']),
        user: { id: 'oauth-user' },
      }
      let stateChangeHandler:
        | ((event: string, session: any) => Promise<void>)
        | null = null
      ;(supabase.auth as any).onAuthStateChange = vi.fn((fn: any) => {
        stateChangeHandler = fn
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      })
      ;(supabase.auth as any).getSession = vi.fn().mockResolvedValue({
        data: { session: oauthSession },
      })
      const signOutSpy = vi.fn().mockResolvedValue({ error: null })
      ;(supabase.auth as any).signOut = signOutSpy
      const listFactorsSpy = vi.fn().mockResolvedValue({
        data: { totp: [{ status: 'verified' }] },
        error: null,
      })
      ;(supabase.auth as any).mfa = { listFactors: listFactorsSpy }

      const store = useAuthStore()
      await store.initializeAuth()

      // Simulate gotrue-js firing INITIAL_SESSION post-URL-exchange while
      // `_pendingMFAVerification` is still set by the callback path-check.
      await stateChangeHandler!('INITIAL_SESSION', oauthSession)

      // The handler early-returns before `validateSessionForMFA`: no signOut,
      // no listFactors call.
      expect(signOutSpy).not.toHaveBeenCalled()
      expect(listFactorsSpy).not.toHaveBeenCalled()
      expect(store.session).toBeNull()
      // Flag is still set - AuthCallbackView clears it after handling.
      expect((store as any)._pendingMFAVerification).toBe(true)
    })

    // TOKEN_REFRESHED fires when the OAuth flow outlasts the access-token TTL;
    // the catch-all branch must skip it as well.
    it('TOKEN_REFRESHED during /auth/callback is skipped, not validated', async () => {
      const refreshedSession = {
        access_token: jwtWithAALAndAMR('aal1', ['oauth']),
        user: { id: 'oauth-user' },
      }
      let stateChangeHandler:
        | ((event: string, session: any) => Promise<void>)
        | null = null
      ;(supabase.auth as any).onAuthStateChange = vi.fn((fn: any) => {
        stateChangeHandler = fn
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      })
      ;(supabase.auth as any).getSession = vi.fn().mockResolvedValue({
        data: { session: refreshedSession },
      })
      const signOutSpy = vi.fn().mockResolvedValue({ error: null })
      ;(supabase.auth as any).signOut = signOutSpy
      const listFactorsSpy = vi.fn().mockResolvedValue({
        data: { totp: [{ status: 'verified' }] },
        error: null,
      })
      ;(supabase.auth as any).mfa = { listFactors: listFactorsSpy }

      const store = useAuthStore()
      await store.initializeAuth()

      await stateChangeHandler!('TOKEN_REFRESHED', refreshedSession)

      expect(signOutSpy).not.toHaveBeenCalled()
      expect(listFactorsSpy).not.toHaveBeenCalled()
      expect(store.session).toBeNull()
      expect((store as any)._pendingMFAVerification).toBe(true)
    })
  })

  // `login()` sets the pending-MFA flag before `signInWithPassword` resolves.
  // Otherwise SIGNED_IN's `validateSessionForMFA` tears down the freshly-issued
  // AAL1 session, `listFactors` runs against a dead session and returns empty,
  // and `login()` reports "no 2FA needed" for a user with a verified TOTP
  // factor.
  describe('login() - concurrent SIGNED_IN handling', () => {
    it('keeps the AAL1 session alive across SIGNED_IN microtask so listFactors can detect 2FA', async () => {
      // 2FA-enrolled user. SIGNED_IN normally fires on the global handler when
      // signInWithPassword resolves; the captured handler is invoked directly
      // to reproduce that mid-login ordering.
      let stateChangeHandler: ((event: string, session: any) => Promise<void>) | null = null
      ;(supabase.auth as any).onAuthStateChange = vi.fn((fn: any) => {
        stateChangeHandler = fn
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      })

      const aal1Session = {
        access_token: jwtWithAALAndAMR('aal1', ['password']),
        user: { id: 'mfa-user' },
      }

      const signOutSpy = vi.fn().mockResolvedValue({ error: null })
      ;(supabase.auth as any).signOut = signOutSpy
      ;(supabase.auth as any).getSession = vi.fn().mockResolvedValue({ data: { session: null } })

      // SIGNED_IN is raced in before signInWithPassword returns, matching
      // Supabase firing it as a microtask while login() awaits.
      ;(supabase.auth as any).signInWithPassword = vi.fn(async () => {
        // SIGNED_IN dispatch runs as soon as login() yields.
        Promise.resolve().then(() => stateChangeHandler?.('SIGNED_IN', aal1Session))
        return { data: { user: aal1Session.user, session: aal1Session }, error: null }
      })

      const fromMock = vi.fn(() => ({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { is_suspended: false }, error: null }),
          }),
        }),
      }))
      ;(supabase as any).from = fromMock

      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn().mockResolvedValue({
          data: { totp: [{ id: 'factor-1', status: 'verified' }] },
          error: null,
        }),
        challenge: vi.fn().mockResolvedValue({
          data: { id: 'challenge-1' },
          error: null,
        }),
      }

      const store = useAuthStore()
      await store.initializeAuth()

      const result = await store.login('mfa@example.com', 'pw')

      // MFA-required signal, not a silent `{ requires2FA: false }` from the
      // SIGNED_IN handler having already destroyed the session.
      expect(result.requires2FA).toBe(true)
      expect(result.factorId).toBe('factor-1')
      expect(result.challengeId).toBe('challenge-1')
      // The pending-MFA flag was set before signInWithPassword resolved, so
      // the SIGNED_IN handler early-returned instead of signing out.
      expect(signOutSpy).not.toHaveBeenCalled()
    })

    it('clears _pendingMFAVerification when login() throws (so subsequent attempts are not stuck)', async () => {
      ;(supabase.auth as any).onAuthStateChange = vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      }))
      ;(supabase.auth as any).signInWithPassword = vi.fn().mockResolvedValue({
        data: { user: null, session: null },
        error: new Error('Invalid login credentials'),
      })
      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn(),
        challenge: vi.fn(),
      }
      ;(supabase.auth as any).getSession = vi.fn().mockResolvedValue({ data: { session: null } })

      const store = useAuthStore()
      await store.initializeAuth()

      await expect(store.login('bad@example.com', 'wrong')).rejects.toThrow()
      // The flag must be cleared on the error path. A leaked flag silently
      // skips the next SIGNED_IN event (e.g. a successful retry), leaving a
      // "logged in but empty" state.
      expect((store as any)._pendingMFAVerification).toBe(false)
    })
  })
})
