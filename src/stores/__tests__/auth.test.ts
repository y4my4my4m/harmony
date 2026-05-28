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

    // Regression: prior to the AMR-aware fix, MFA users got logged out on
    // every device after Supabase's ~24h AAL2 grace period expired. The
    // fix accepts AAL1 sessions whose JWT amr already records a `totp`
    // verification, matching the documented "stay logged in for weeks"
    // model in `docs/2FA_SECURITY_MODEL.md`.
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
      // The amr-fast-path means we don't even need to call listFactors -
      // the JWT alone tells us MFA was completed on this session.
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

      // Simulate Supabase firing SIGNED_IN with a brand-new AAL1 session for a
      // user that has MFA enrolled. The store must NOT adopt this session.
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

  // Regression test for the OAuth callback / MFA-handoff race. Before this fix,
  // `initializeAuth` ran `validateSessionForMFA` on the AAL1 session that
  // Supabase's `detectSessionInUrl: true` had already exchanged for us, hit the
  // "MFA enrolled, no totp in amr" reject branch, and called `signOut()` -
  // which destroyed the session before `AuthCallbackView` mounted. The view's
  // `getSession()` then returned null and the user saw "Authentication failed".
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
      // listFactors WOULD return a verified factor - proving the path-check
      // bypasses MFA validation regardless of the user's MFA state.
      ;(supabase.auth as any).mfa = {
        listFactors: vi.fn().mockResolvedValue({
          data: { totp: [{ status: 'verified' }] },
          error: null,
        }),
      }

      const store = useAuthStore()
      await store.initializeAuth()

      // The whole point: no signOut, so AuthCallbackView's getSession()
      // will still find the AAL1 session and can run its MFA challenge.
      expect(signOutSpy).not.toHaveBeenCalled()
      // We don't adopt yet either - that's AuthCallbackView's job after
      // it either passes validation or completes the MFA challenge.
      expect(store.session).toBeNull()
      // And the flag is set so any in-flight SIGNED_IN / INITIAL_SESSION
      // events from the OAuth code-exchange don't run the same reject
      // path inside `onAuthStateChange`.
      expect((store as any)._pendingMFAVerification).toBe(true)
    })

    // Regression test for the bug the code-reviewer flagged: gotrue-js fires
    // INITIAL_SESSION as a microtask immediately after `detectSessionInUrl`
    // exchanges the OAuth code, BEFORE `AuthCallbackView` mounts. The
    // previous version of the SIGNED_IN-only flag check would let
    // INITIAL_SESSION's reject branch run, signOut() the AAL1 session, and
    // leave the callback view with no session to challenge against.
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

      // The handler must have early-returned. NO signOut, NO listFactors
      // call (the early return is BEFORE `validateSessionForMFA`).
      expect(signOutSpy).not.toHaveBeenCalled()
      expect(listFactorsSpy).not.toHaveBeenCalled()
      expect(store.session).toBeNull()
      // Flag is still set - AuthCallbackView clears it after handling.
      expect((store as any)._pendingMFAVerification).toBe(true)
    })

    // Same blocker, different event type. Belt-and-suspenders for the
    // catch-all branch - TOKEN_REFRESHED can fire if the OAuth flow takes
    // longer than the access-token TTL.
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

  // Regression test for the race condition where SIGNED_IN's `validateSessionForMFA`
  // fired BEFORE `login()` had time to flag the in-flight MFA attempt, causing the
  // freshly-issued AAL1 session to be torn down - `listFactors` then ran against a
  // dead session, returned empty, and `login()` reported "no 2FA needed" even though
  // the user had a verified TOTP factor. The login UI navigated to the home route
  // with no session and the page rendered blank.
  describe('login() - concurrent SIGNED_IN handling', () => {
    it('keeps the AAL1 session alive across SIGNED_IN microtask so listFactors can detect 2FA', async () => {
      // Mocks: a 2FA-enrolled user. signInWithPassword resolves and would
      // normally fire SIGNED_IN on the global handler - we simulate that
      // mid-login by invoking the captured handler ourselves between the
      // `signInWithPassword` resolution and the rest of `login()` running.
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

      // signInWithPassword: race the SIGNED_IN handler in *before* returning.
      // This reproduces the real-world ordering where Supabase fires SIGNED_IN
      // as a microtask while login() is awaiting its next `await`.
      ;(supabase.auth as any).signInWithPassword = vi.fn(async () => {
        // Schedule the SIGNED_IN dispatch to run as soon as login() yields.
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

      // The whole point: we get the MFA-required signal back, NOT a silent
      // "{ requires2FA: false }" caused by the SIGNED_IN handler having
      // already destroyed the session.
      expect(result.requires2FA).toBe(true)
      expect(result.factorId).toBe('factor-1')
      expect(result.challengeId).toBe('challenge-1')
      // And critically, the SIGNED_IN handler did NOT sign us out: the
      // pending-MFA flag was set before signInWithPassword resolved, so
      // the handler's early return triggered.
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
      // The flag must be cleared on the error path. If it leaked, the next
      // SIGNED_IN event (e.g. from a successful retry) would be silently
      // skipped and the user would be stuck looking at a "logged in but
      // empty" state.
      expect((store as any)._pendingMFAVerification).toBe(false)
    })
  })
})
