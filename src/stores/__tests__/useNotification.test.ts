import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { supabase } from '@/supabase'

const AUTH_USER_ID = '11111111-1111-1111-1111-111111111111'
const PROFILE_ID = '22222222-2222-2222-2222-222222222222'

vi.mock('@/services/AuthContextService', () => {
  const AUTH = '11111111-1111-1111-1111-111111111111'
  const PROFILE = '22222222-2222-2222-2222-222222222222'
  return {
    authContextService: {
      getCurrentContext: vi.fn().mockResolvedValue({
        isAuthenticated: true,
        authUser: { id: AUTH },
        profileId: PROFILE,
      }),
      getCurrentProfileId: vi.fn().mockResolvedValue(PROFILE),
    },
  }
})

vi.mock('@/services/userDataService', () => ({
  userDataService: {
    ensureUsersLoaded: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/services', () => ({
  services: {
    notifications: {
      markAsRead: vi.fn().mockResolvedValue(undefined),
      fetchNotifications: vi.fn().mockResolvedValue([]),
      deleteNotification: vi.fn().mockResolvedValue(undefined),
      markAsUnread: vi.fn().mockResolvedValue(undefined),
    },
  },
}))

vi.mock('@/services/NotificationFormatter', () => ({
  NotificationFormatter: {
    formatNotification: vi.fn().mockReturnValue({ title: '', message: '' }),
    getActorInfo: vi.fn().mockReturnValue(null),
    getAvatarUrl: vi.fn().mockReturnValue(undefined),
    getNavigationData: vi.fn().mockReturnValue(null),
  },
}))

vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: {
    connect: vi.fn(),
    on: vi.fn().mockReturnValue(() => {}),
    send: vi.fn(),
    disconnect: vi.fn(),
  },
}))

vi.mock('@/services/ViewContextTracker', () => ({
  viewContextTracker: {
    shouldShowNotificationUI: vi.fn().mockReturnValue({ showToast: false, showDesktop: false, playSound: false }),
    reset: vi.fn(),
  },
}))

vi.mock('@/router', () => ({ default: { push: vi.fn() } }))

vi.mock('@/utils/faviconBadge', () => ({ updateFaviconBadge: vi.fn() }))

vi.mock('@/stores/auth', () => {
  const AUTH = '11111111-1111-1111-1111-111111111111'
  return {
    useAuthStore: vi.fn(() => ({
      session: { user: { id: AUTH }, access_token: 'token' },
    })),
  }
})

import { useNotificationStore } from '@/stores/useNotification'

function mockRpc(error: any = null) {
  ;(supabase.rpc as any).mockImplementation((..._args: any[]) =>
    Promise.resolve({ data: null, error }),
  )
}

function mockFromSelect(rows: any[] | null, error: any = null) {
  const builder: any = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: rows && rows.length ? rows[0] : null, error }),
    upsert: vi.fn().mockResolvedValue({ error: null }),
  }
  ;(supabase.from as any).mockReturnValue(builder)
  return builder
}

describe('useNotificationStore - identity safety', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  describe('markAllAsRead', () => {
    it('passes the profile id (not the auth user id) to mark_all_notifications_read RPC', async () => {
      mockRpc()
      const store = useNotificationStore()
      store.notifications = [
        { id: 'n1', is_read: false } as any,
        { id: 'n2', is_read: false } as any,
      ]

      await store.markAllAsRead()

      expect(supabase.rpc).toHaveBeenCalledWith('mark_all_notifications_read', {
        p_user_id: PROFILE_ID,
      })
      expect(supabase.rpc).not.toHaveBeenCalledWith('mark_all_notifications_read', {
        p_user_id: AUTH_USER_ID,
      })
    })

    it('does not optimistically mark read when no auth session', async () => {
      const { useAuthStore } = await import('@/stores/auth')
      ;(useAuthStore as any).mockReturnValueOnce({ session: null })
      mockRpc()

      const store = useNotificationStore()
      store.notifications = [{ id: 'n1', is_read: false } as any]

      await store.markAllAsRead()

      // No RPC fired, and the unread state is preserved (UI stays consistent).
      expect(supabase.rpc).not.toHaveBeenCalled()
      expect(store.notifications[0].is_read).toBe(false)
    })

    it('reverts optimistic update when RPC returns an error', async () => {
      mockRpc({ message: 'Not authorized' })
      const store = useNotificationStore()
      store.notifications = [
        { id: 'n1', is_read: false } as any,
        { id: 'n2', is_read: true } as any,
      ]

      await store.markAllAsRead()

      expect(store.notifications[0].is_read).toBe(false)
      expect(store.notifications[1].is_read).toBe(true)
    })
  })

  describe('loadPreferences', () => {
    it('resolves auth user id to profile id before querying notification_preferences', async () => {
      const builder = mockFromSelect([{
        id: 'pref-1',
        user_id: PROFILE_ID,
        desktop_notifications: true,
      }])
      const store = useNotificationStore()

      await store.loadPreferences(AUTH_USER_ID)

      expect(supabase.from).toHaveBeenCalledWith('notification_preferences')
      // The select chain must filter by profile id, not auth id.
      expect(builder.eq).toHaveBeenCalledWith('user_id', PROFILE_ID)
      expect(builder.eq).not.toHaveBeenCalledWith('user_id', AUTH_USER_ID)
      expect(store.preferences?.user_id).toBe(PROFILE_ID)
    })

    it('falls back to DEFAULT_PREFERENCES keyed on profile id when no row exists', async () => {
      mockFromSelect(null)
      const store = useNotificationStore()

      await store.loadPreferences(AUTH_USER_ID)

      expect(store.preferences).not.toBeNull()
      expect(store.preferences?.user_id).toBe(PROFILE_ID)
    })
  })
})
