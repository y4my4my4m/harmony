import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const PROFILE_ID = '22222222-2222-2222-2222-222222222222'

const getThread = vi.hoisted(() => vi.fn())
const patch = vi.hoisted(() => vi.fn())
const upsert = vi.hoisted(() => vi.fn())
const threadsState = vi.hoisted(() => ({ byId: {} as Record<string, unknown> }))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: vi.fn().mockResolvedValue({ isAuthenticated: true, profileId: '22222222-2222-2222-2222-222222222222' }),
    getCurrentProfileId: vi.fn().mockResolvedValue('22222222-2222-2222-2222-222222222222'),
  },
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: { ensureUsersLoaded: vi.fn().mockResolvedValue(undefined), getCurrentUser: () => null },
}))
vi.mock('@/services', () => ({
  services: {
    notifications: {
      markAsRead: vi.fn().mockResolvedValue(undefined),
      markAsUnread: vi.fn().mockResolvedValue(undefined),
      fetchNotifications: vi.fn().mockResolvedValue([]),
    },
  },
}))
vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: { connect: vi.fn(), on: vi.fn(() => () => {}), send: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('@/services/ViewContextTracker', () => ({
  viewContextTracker: {
    shouldShowNotificationUI: vi.fn().mockReturnValue({ showToast: false, showDesktop: false, playSound: false }),
    reset: vi.fn(),
  },
}))
vi.mock('@/services/ServiceWorkerManager', () => ({
  serviceWorkerManager: { dismissNotifications: vi.fn(), showNotification: vi.fn() },
}))
vi.mock('@/router', () => ({ default: { push: vi.fn() } }))
vi.mock('@/utils/faviconBadge', () => ({ updateFaviconBadge: vi.fn() }))
vi.mock('@/stores/auth', () => ({
  useAuthStore: vi.fn(() => ({ session: { user: { id: '11111111-1111-1111-1111-111111111111' } } })),
}))
vi.mock('@/services/ThreadService', () => ({ threadService: { getThread } }))
vi.mock('@/stores/useThreads', () => ({ useThreadsStore: () => ({ patch, upsert, byId: threadsState.byId }) }))

import { useNotificationStore } from '@/stores/useNotification'

let seq = 0
const mk = (type: string, data: any) => ({
  id: `n${++seq}`,
  user_id: PROFILE_ID,
  type,
  is_read: false,
  data,
  created_at: new Date().toISOString(),
}) as any

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  threadsState.byId = {}
  getThread.mockResolvedValue({ id: 't1', is_member: true })
})

describe('a mention notification refreshes its thread', () => {
  it('re-reads the thread and marks it joined in the stored list', async () => {
    threadsState.byId = { t1: { id: 't1' } }
    await useNotificationStore()._processIncomingNotification(mk('mention', { thread: { id: 't1' } }))
    await flush()
    expect(getThread).toHaveBeenCalledTimes(1)
    expect(getThread).toHaveBeenCalledWith('t1', true)
    expect(patch).toHaveBeenCalledWith('t1', { is_member: true, left: false })
    expect(upsert).not.toHaveBeenCalled()
  })

  it('adds the thread to an empty store as joined', async () => {
    await useNotificationStore()._processIncomingNotification(mk('mention', { thread: { id: 't1' } }))
    await flush()
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 't1', is_member: true, left: false }))
    expect(patch).not.toHaveBeenCalled()
  })

  it('leaves the stored thread alone when the read fails', async () => {
    getThread.mockResolvedValue(null)
    await useNotificationStore()._processIncomingNotification(mk('mention', { thread: { id: 't1' } }))
    await flush()
    expect(patch).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('does nothing for a channel mention', async () => {
    await useNotificationStore()._processIncomingNotification(mk('mention', { thread: null }))
    await flush()
    expect(getThread).not.toHaveBeenCalled()
  })

  it('does nothing for an activitypub mention', async () => {
    await useNotificationStore()._processIncomingNotification(mk('activitypub_mention', { thread: { id: 't1' } }))
    await flush()
    expect(getThread).not.toHaveBeenCalled()
  })
})
