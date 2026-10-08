/**
 * DM realtime paths that left the UI stale until a reload:
 * - ChatLayout's unmount (cleanup(false)) dropped the user-channel handlers
 *   (unread:change, conversation:new, _reconnected) that only BaseLayout's
 *   one-time init registers.
 * - unread:change for a conversation without an open subscription moved its
 *   badge and order but left the sidebar preview on the previous message.
 * - Rows inserted between the page fetch and the conversation channel's join
 *   reached no transport.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

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

vi.mock('@/supabase', () => ({ supabase: { from: h.from, rpc: vi.fn(), removeChannel: vi.fn() } }))
vi.mock('@/services', () => ({ services: { messages: { loadConversationMessages: vi.fn(async () => ({ messages: [], hasMore: false })) } } }))
vi.mock('@/services/core/CoreMessageService', () => ({ coreMessageService: {} }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ fetchMultipleUserProfiles: vi.fn(async () => {}) }) }))
vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({ handleRealtimeUpdate: vi.fn() }) }))
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

const conversation = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  created_at: '2026-10-01T00:00:00Z',
  type: 'direct',
  unread_count: 0,
  last_activity: '2026-10-01T00:00:00Z',
  last_message: {
    id: 'old', user_id: 'them', content: [{ type: 'text', text: 'old' }],
    created_at: new Date('2026-10-01T00:00:00Z'), channel_id: '', conversation_id: id, reactions: [],
  },
  ...extra,
})

const unread = (conversationId: string, n: number) =>
  h.emit('unread:change', { action: 'upsert', count: { conversation_id: conversationId, unread_messages: n } })

beforeEach(() => {
  setActivePinia(createPinia())
  h.handlers.clear()
  h.queries.length = 0
  h.subs.length = 0
  h.from.mockClear()
  h.setResult({ data: [], error: null })
})

describe('global DM handlers across a chat layout unmount', () => {
  it('cleanup(false) keeps unread:change wired; the sidebar badge still moves', async () => {
    const dm = useDMStore()
    await dm.registerGlobalBroadcastHandlers('auth-me')
    dm.conversations = [conversation('c1')] as any

    dm.cleanup(false)
    unread('c1', 3)

    expect(dm.conversations[0].unread_count).toBe(3)
    expect(dm.getTotalUnreadCount).toBe(3)
  })

  it('cleanup(true) (logout) removes them', async () => {
    const dm = useDMStore()
    await dm.registerGlobalBroadcastHandlers('auth-me')
    dm.conversations = [conversation('c1')] as any

    dm.cleanup(true)
    expect(h.handlers.get('unread:change')?.size ?? 0).toBe(0)
  })

  it('registration stays idempotent after cleanup(false)', async () => {
    const dm = useDMStore()
    await dm.registerGlobalBroadcastHandlers('auth-me')
    dm.cleanup(false)
    await dm.registerGlobalBroadcastHandlers('auth-me')
    expect(h.handlers.get('unread:change')?.size).toBe(1)
  })
})

describe('sidebar preview for a conversation without an open subscription', () => {
  it('replaces last_message with the newest row on a rising count', async () => {
    const dm = useDMStore()
    await dm.registerGlobalBroadcastHandlers('auth-me')
    dm.conversations = [conversation('c1')] as any
    h.setResult({
      data: [{ id: 'new', user_id: 'them', conversation_id: 'c1', content: [{ type: 'text', text: 'hi' }], created_at: '2026-10-08T10:00:00Z' }],
      error: null,
    })

    unread('c1', 1)
    await flush()

    const conv = dm.conversations[0]
    expect(conv.last_message?.id).toBe('new')
    expect(conv.last_message?.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(conv.last_activity).toBe('2026-10-08T10:00:00.000Z')
    const q = h.queries.find(x => x.table === 'messages')!
    expect(q.calls).toContainEqual(['eq', ['conversation_id', 'c1']])
    expect(q.calls).toContainEqual(['limit', [1]])
  })

  it('does not fetch for a read (falling count) or for the open conversation', async () => {
    const dm = useDMStore()
    await dm.registerGlobalBroadcastHandlers('auth-me')
    dm.conversations = [conversation('c1', { unread_count: 4 }), conversation('c2')] as any
    dm.currentConversationId = 'c2'

    unread('c1', 0)
    await flush()
    expect(h.queries.filter(x => x.table === 'messages')).toHaveLength(0)
  })

  it('coalesces a burst into one trailing refetch', async () => {
    const dm = useDMStore()
    await dm.registerGlobalBroadcastHandlers('auth-me')
    dm.conversations = [conversation('c1')] as any

    unread('c1', 1)
    unread('c1', 2)
    unread('c1', 3)
    await flush()
    await flush()
    expect(h.queries.filter(x => x.table === 'messages')).toHaveLength(2)
  })
})

describe('open conversation channel join', () => {
  it('pulls rows newer than the newest held on every SUBSCRIBED', async () => {
    const dm = useDMStore()
    dm.conversations = [conversation('c1')] as any
    dm.setCurrentConversation('c1')
    const cfg = h.subs.find(s => s.channelName === 'dm-conversation-c1')
    expect(cfg).toBeTruthy()

    dm.currentDMMessages = [{
      id: 'm1', user_id: 'them', conversation_id: 'c1', channel_id: '', content: [],
      created_at: new Date('2026-10-08T09:00:00Z'), reactions: [],
    }] as any
    h.setResult({
      data: [{ id: 'm2', user_id: 'them', conversation_id: 'c1', content: [], created_at: '2026-10-08T09:00:05Z' }],
      error: null,
    })

    cfg.onStatusChange('connected', 'dm-conversation-c1')
    await flush()

    expect(dm.currentDMMessages.map((m: any) => m.id)).toEqual(['m1', 'm2'])
    const q = h.queries.find(x => x.table === 'messages')!
    expect(q.calls).toContainEqual(['gt', ['created_at', '2026-10-08T09:00:00.000Z']])
  })

  it('leaves an empty list to the page fetch', async () => {
    const dm = useDMStore()
    dm.conversations = [conversation('c1')] as any
    dm.setCurrentConversation('c1')
    const cfg = h.subs.find(s => s.channelName === 'dm-conversation-c1')

    cfg.onStatusChange('connected', 'dm-conversation-c1')
    await flush()
    expect(h.queries.filter(x => x.table === 'messages')).toHaveLength(0)
  })
})
