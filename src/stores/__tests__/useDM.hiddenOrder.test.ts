/**
 * set_conversation_hidden calls for one conversation reach the server in call order: an
 * Undo sent while its dismiss is in flight must not land first and be overwritten.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Each rpc call waits for release(n); `sent` records the calls in the order they were made.
const rpc = vi.hoisted(() => {
  const sent: Array<{ hidden: boolean }> = []
  const gates: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []
  const fn = vi.fn((_name: string, args: { p_hidden: boolean }) => {
    sent.push({ hidden: args.p_hidden })
    return new Promise((resolve, reject) => gates.push({ resolve, reject }))
  })
  return {
    fn, sent, gates,
    release: (i: number, error: unknown = null) => gates[i].resolve({ data: null, error }),
    fail: (i: number) => gates[i].reject(new Error('network')),
  }
})

const h = vi.hoisted(() => {
  const handlers = new Map<string, Set<(d: any) => void>>()
  const userEventChannel = {
    connect: vi.fn(),
    on: vi.fn((type: string, fn: (d: any) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(fn)
      return () => { handlers.get(type)?.delete(fn) }
    }),
  }
  const emit = (type: string, data: any) => handlers.get(type)?.forEach(fn => fn({ type, ...data }))

  // supabase.from(...) chain; every call records its args, awaiting yields `result`.
  const queries: Array<{ table: string; calls: Array<[string, any[]]> }> = []
  let result: { data: any; error: any } = { data: [], error: null }
  const from = vi.fn((table: string) => {
    const q = { table, calls: [] as Array<[string, any[]]> }
    queries.push(q)
    const chain: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === 'then') return (res: any, rej: any) => Promise.resolve(result).then(res, rej)
        return (...args: any[]) => { q.calls.push([prop, args]); return chain }
      },
    })
    return chain
  })

  const subs: any[] = []
  const realtimeConnectionManager = {
    hasSubscription: vi.fn(() => false),
    getSubscriptionStatus: vi.fn(() => null),
    unsubscribe: vi.fn(),
    subscribeToTable: vi.fn((cfg: any) => { subs.push(cfg); return vi.fn() }),
  }
  return {
    handlers, userEventChannel, emit, queries, from, subs, realtimeConnectionManager,
    setResult: (r: { data: any; error: any }) => { result = r },
  }
})

vi.mock('@/supabase', () => ({ supabase: { from: h.from, rpc: rpc.fn, removeChannel: vi.fn() } }))
vi.mock('@/services', () => ({ services: { messages: { loadConversationMessages: vi.fn(async () => ({ messages: [], hasMore: false })) } } }))
vi.mock('@/services/core/CoreMessageService', () => ({ coreMessageService: {} }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ fetchMultipleUserProfiles: vi.fn(async () => {}) }) }))
const fetchReactions = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/stores/useReactions', () => ({
  useReactionsStore: () => ({ handleRealtimeUpdate: vi.fn(), fetchMultipleMessageReactions: fetchReactions }),
}))
vi.mock('@/stores/usePins', () => ({ usePinsStore: () => ({ applyRealtimeRow: vi.fn(), applyRealtimeDelete: vi.fn(), overlayPending: (m: any) => m }) }))
vi.mock('@/services/userDataService', () => ({
  userDataService: { getCurrentUser: () => ({ id: 'me' }), addEventListener: vi.fn(), removeEventListener: vi.fn() },
}))
vi.mock('@/utils/unifiedContentProcessing', () => ({ extractMentionsFromMessageParts: vi.fn(() => []) }))
vi.mock('@/utils/messageEmbedUtils', () => ({ ensureMessageEmbeds: vi.fn() }))
vi.mock('@/utils/messageDecryption', () => ({ processMessageDecryption: vi.fn(async (m: any[]) => m) }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/services/RealtimeConnectionManager', () => ({ realtimeConnectionManager: h.realtimeConnectionManager }))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: h.userEventChannel }))
vi.mock('@/services/readState', () => ({ fetchUnreadCounts: vi.fn(async () => []), markConversationRead: vi.fn(async () => {}) }))
vi.mock('@/services/AutoModService', () => ({ isModerationRejectionCode: () => false }))
vi.mock('@/composables/useFloatingVideo', () => ({ releaseFloatingVideo: vi.fn() }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentContext: async () => ({ isAuthenticated: true, profileId: 'me' }) },
}))

import { useDMStore } from '@/stores/useDM'

const flush = () => new Promise(r => setTimeout(r, 0))

const conversation = {
  id: 'c1', created_at: '2026-10-01T00:00:00Z', type: 'direct', unread_count: 0,
  last_activity: '2026-10-01T00:00:00Z',
} as any

beforeEach(() => {
  setActivePinia(createPinia())
  rpc.fn.mockClear()
  rpc.sent.length = 0
  rpc.gates.length = 0
})

describe('dismiss then Undo', () => {
  it('sends the restore only after the dismiss settles', async () => {
    const dm = useDMStore()
    dm.conversations.push({ ...conversation })
    const hidden = dm.hideConversation('c1')
    const restored = dm.restoreConversation(conversation)
    await flush()
    expect(rpc.sent).toEqual([{ hidden: true }])
    expect(dm.conversations.map((c: any) => c.id)).toEqual(['c1'])

    rpc.release(0)
    await flush()
    expect(rpc.sent).toEqual([{ hidden: true }, { hidden: false }])
    rpc.release(1)
    expect(await hidden).toBe(true)
    expect(await restored).toBe(true)
  })

  it('still sends the restore when the dismiss request fails', async () => {
    const dm = useDMStore()
    dm.conversations.push({ ...conversation })
    const hidden = dm.hideConversation('c1')
    const restored = dm.restoreConversation(conversation)
    await flush()
    rpc.fail(0)
    await flush()
    expect(rpc.sent).toEqual([{ hidden: true }, { hidden: false }])
    rpc.release(1)
    expect(await hidden).toBe(false)
    expect(await restored).toBe(true)
    expect(dm.conversations.filter((c: any) => c.id === 'c1')).toHaveLength(1)
  })
})
