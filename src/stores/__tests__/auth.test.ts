import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

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
  })),
}))
vi.mock('@/utils/userScopedStorage', () => ({
  userStorage: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    clearAll: vi.fn(),
    setUserId: vi.fn(),
  },
}))

import { useAuthStore } from '@/stores/auth'

describe('useAuthStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
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
      const payload = { aal: 'aal2' }
      const encodedPayload = btoa(JSON.stringify(payload))
      const session = { access_token: `h.${encodedPayload}.s` } as any
      expect(store.getAAL(session)).toBe('aal2')
    })

    it('defaults to aal1 when AAL not in token', () => {
      const store = useAuthStore()
      const payload = { sub: 'user' }
      const encodedPayload = btoa(JSON.stringify(payload))
      const session = { access_token: `h.${encodedPayload}.s` } as any
      expect(store.getAAL(session)).toBe('aal1')
    })
  })
})
