/**
 * A DM partner's profile change reaches conversation.other_user, the copy DMHeader reads:
 * user-updated from userDataService (profile:updated, 20261118200001).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<(e: any) => void>>()
  const cache = new Map<string, any>()
  const userDataService = {
    getCurrentUser: () => ({ id: 'me' }),
    getUser: (id: string) => cache.get(id) ?? null,
    addEventListener: vi.fn((type: string, fn: (e: any) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    }),
    removeEventListener: vi.fn((type: string, fn: (e: any) => void) => { listeners.get(type)?.delete(fn) }),
  }
  const userUpdated = (userId: string) =>
    listeners.get('user-updated')?.forEach(fn => fn({ detail: { userId } }))

  // supabase.from(...) chain resolving to no rows; rpc never answers, so the background
  // revalidation of a warm list leaves it as set.
  const from = vi.fn(() => {
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') return (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej)
        return () => chain
      },
    })
    return chain
  })
  const rpc = vi.fn(() => new Promise(() => {}))
  return { listeners, cache, userDataService, userUpdated, from, rpc }
})

vi.mock('@/supabase', () => ({ supabase: { from: h.from, rpc: h.rpc, removeChannel: vi.fn() } }))
vi.mock('@/services', () => ({ services: { messages: { loadConversationMessages: vi.fn(async () => ({ messages: [], hasMore: false })) } } }))
vi.mock('@/services/core/CoreMessageService', () => ({ coreMessageService: {} }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ fetchMultipleUserProfiles: vi.fn(async () => {}) }) }))
vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({}), seedNoReactions: vi.fn() }))
vi.mock('@/stores/usePins', () => ({ usePinsStore: () => ({ applyRealtimeRow: vi.fn(), applyRealtimeDelete: vi.fn() }) }))
vi.mock('@/services/userDataService', () => ({ userDataService: h.userDataService }))
vi.mock('@/utils/unifiedContentProcessing', () => ({ extractMentionsFromMessageParts: vi.fn(() => []) }))
vi.mock('@/utils/messageEmbedUtils', () => ({ ensureMessageEmbeds: vi.fn() }))
vi.mock('@/utils/messageDecryption', () => ({ processMessageDecryption: vi.fn(async (m: any[]) => m) }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/services/RealtimeConnectionManager', () => ({
  realtimeConnectionManager: { hasSubscription: vi.fn(() => false), unsubscribe: vi.fn(), subscribeBroadcast: vi.fn(() => vi.fn()) },
}))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { connect: vi.fn(), on: vi.fn(() => () => {}) } }))
vi.mock('@/services/readState', () => ({ fetchUnreadCounts: vi.fn(async () => []), markConversationRead: vi.fn(async () => {}) }))
vi.mock('@/composables/useFloatingVideo', () => ({ releaseFloatingVideo: vi.fn() }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentContext: async () => ({ isAuthenticated: true, profileId: 'me' }) },
}))

import { useDMStore } from '@/stores/useDM'

const partner = { id: 'them', username: 'them', display_name: 'Them', avatar_url: 'https://cdn.test/old.webp', color: '#112233', domain: 'local.test', is_local: true }

const conversation = (id: string, other: any) => ({
  id, created_at: '2026-10-01T00:00:00Z', type: 'direct', unread_count: 0, other_user: { ...other },
})

beforeEach(() => {
  setActivePinia(createPinia())
  h.listeners.clear()
  h.cache.clear()
})

async function storeWithList(list: any[]) {
  const dm = useDMStore()
  dm.conversations = list as any
  await dm.initializeDMEnvironment('me')
  return dm
}

describe('a DM partner profile change', () => {
  it('updates the partner copy of each conversation with them', async () => {
    const dm = await storeWithList([conversation('c1', partner), conversation('c2', { ...partner, id: 'other', username: 'other' })])
    h.cache.set('them', { id: 'them', username: 'them', displayName: 'Them renamed', avatarUrl: 'https://cdn.test/new.webp', color: '#445566' })

    h.userUpdated('them')

    expect(dm.conversations[0].other_user).toMatchObject({
      id: 'them', display_name: 'Them renamed', avatar_url: 'https://cdn.test/new.webp', color: '#445566',
      domain: 'local.test', is_local: true,
    })
    expect(dm.conversations[1].other_user?.avatar_url).toBe('https://cdn.test/old.webp')
  })

  it('a removed avatar leaves none on the copy', async () => {
    const dm = await storeWithList([conversation('c1', partner)])
    h.cache.set('them', { id: 'them', username: 'them', displayName: 'Them', avatarUrl: null, color: '#112233' })

    h.userUpdated('them')

    expect(dm.conversations[0].other_user?.avatar_url).toBeUndefined()
  })

  it('leaves the list untouched when nothing shown changed, and placeholders to their own load', async () => {
    const dm = await storeWithList([conversation('c1', partner), conversation('c3', { id: 'them', username: 'them', _isPlaceholder: true })])
    h.cache.set('them', { id: 'them', username: 'them', displayName: 'Them', avatarUrl: 'https://cdn.test/old.webp', color: '#112233' })
    const before = dm.conversations[0]

    h.userUpdated('them')

    expect(dm.conversations[0]).toBe(before)
    expect(dm.conversations[1].other_user).toEqual({ id: 'them', username: 'them', _isPlaceholder: true })
  })
})
