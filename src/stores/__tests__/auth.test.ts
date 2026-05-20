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
  })

  describe('onAuthStateChange — SIGNED_IN with invalid AAL1 session', () => {
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
})
