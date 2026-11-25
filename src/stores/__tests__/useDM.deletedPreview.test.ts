/**
 * A deleted message leaves the DM list preview and the message cache of a conversation that is
 * not open: conversation:message_deleted on the user channel (20261118100001).
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
  const loadConversationMessages = vi.fn(async () => ({ messages: [] as any[], hasMore: false }))
  return {
    handlers, userEventChannel, emit, queries, from, loadConversationMessages,
    setResult: (r: { data: any; error: any }) => { result = r },
  }
})

vi.mock('@/supabase', () => ({ supabase: { from: h.from, rpc: vi.fn(), removeChannel: vi.fn() } }))
vi.mock('@/services', () => ({ services: { messages: { loadConversationMessages: h.loadConversationMessages } } }))
vi.mock('@/services/core/CoreMessageService', () => ({ coreMessageService: {} }))
vi.mock('@/stores/useServerUsers', () => ({ useServerUsersStore: () => ({ fetchMultipleUserProfiles: vi.fn(async () => {}) }) }))
vi.mock('@/stores/useReactions', () => ({ useReactionsStore: () => ({}), seedNoReactions: vi.fn() }))
vi.mock('@/stores/usePins', () => ({ usePinsStore: () => ({ applyRealtimeRow: vi.fn(), applyRealtimeDelete: vi.fn() }) }))
vi.mock('@/services/userDataService', () => ({
  userDataService: { getCurrentUser: () => ({ id: 'me' }), addEventListener: vi.fn(), removeEventListener: vi.fn() },
}))
vi.mock('@/utils/unifiedContentProcessing', () => ({ extractMentionsFromMessageParts: vi.fn(() => []) }))
vi.mock('@/utils/messageEmbedUtils', () => ({ ensureMessageEmbeds: vi.fn() }))
vi.mock('@/utils/messageDecryption', () => ({ processMessageDecryption: vi.fn(async (m: any[]) => m) }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/services/RealtimeConnectionManager', () => ({
  realtimeConnectionManager: { hasSubscription: vi.fn(() => false), unsubscribe: vi.fn(), subscribeBroadcast: vi.fn(() => vi.fn()) },
}))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: h.userEventChannel }))
vi.mock('@/services/readState', () => ({ fetchUnreadCounts: vi.fn(async () => []), markConversationRead: vi.fn(async () => {}) }))
vi.mock('@/composables/useFloatingVideo', () => ({ releaseFloatingVideo: vi.fn() }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentContext: async () => ({ isAuthenticated: true, profileId: 'me' }) },
}))

import { useDMStore } from '@/stores/useDM'

const flush = () => new Promise(r => setTimeout(r, 0))

const row = (id: string, text: string, at: string) => ({
  id, user_id: 'them', conversation_id: 'c1', content: [{ type: 'text', text }], created_at: at,
})

const conversation = (previewId: string) => ({
  id: 'c1',
  created_at: '2026-10-01T00:00:00Z',
  type: 'direct',
  unread_count: 0,
  last_activity: '2026-10-08T10:00:00Z',
  last_message: { ...row(previewId, 'secret', '2026-10-08T10:00:00Z'), created_at: new Date('2026-10-08T10:00:00Z'), channel_id: '', reactions: [] },
})

const deleted = (messageId: string) => h.emit('conversation:message_deleted', { conversation_id: 'c1', message_id: messageId })

beforeEach(() => {
  setActivePinia(createPinia())
  h.handlers.clear()
  h.queries.length = 0
  h.from.mockClear()
  h.setResult({ data: [], error: null })
  h.loadConversationMessages.mockReset()
  h.loadConversationMessages.mockResolvedValue({ messages: [], hasMore: false })
})

describe('conversation:message_deleted', () => {
  it('replaces a deleted preview with the newest row left, showing no text meanwhile', async () => {
    const dm = useDMStore()
    await dm.registerGlobalBroadcastHandlers('auth-me')
    dm.conversations = [conversation('m2')] as any
    h.setResult({ data: [row('m1', 'before', '2026-10-08T09:00:00Z')], error: null })

    deleted('m2')
    const conv = dm.conversations[0]
    expect(conv.last_message).toBeUndefined()
    expect(conv.preview_pending).toBe(true)

    await flush()
    expect(conv.last_message?.id).toBe('m1')
    expect(conv.last_message?.content).toEqual([{ type: 'text', text: 'before' }])
    expect(conv.last_activity).toBe('2026-10-08T09:00:00.000Z')
    expect(conv.preview_pending).toBe(false)
    const q = h.queries.find(x => x.table === 'messages')!
    expect(q.calls).toContainEqual(['eq', ['conversation_id', 'c1']])
    expect(q.calls).toContainEqual(['or', ['is_deleted.is.null,is_deleted.eq.false']])
  })

  it('takes the previous cached row without a fetch and drops the deleted one from the cache', async () => {
    const dm = useDMStore()
    await dm.registerGlobalBroadcastHandlers('auth-me')
    dm.conversations = [conversation('m2')] as any
    h.loadConversationMessages.mockResolvedValue({
      messages: [row('m1', 'before', '2026-10-08T09:00:00Z'), row('m2', 'secret', '2026-10-08T10:00:00Z')],
      hasMore: false,
    })
    await dm.loadCachedConversationPage('c1')
    h.queries.length = 0

    deleted('m2')
    await flush()

    const conv = dm.conversations[0]
    expect(conv.last_message?.id).toBe('m1')
    expect(conv.preview_pending).toBeFalsy()
    expect(dm.cachedConversation('c1')?.messages.map(m => m.id)).toEqual(['m1'])
    expect(h.queries.filter(x => x.table === 'messages')).toHaveLength(0)
  })

  it('leaves the preview of another message and still drops the row from the cache', async () => {
    const dm = useDMStore()
    await dm.registerGlobalBroadcastHandlers('auth-me')
    dm.conversations = [conversation('m2')] as any
    h.loadConversationMessages.mockResolvedValue({
      messages: [row('m1', 'before', '2026-10-08T09:00:00Z'), row('m2', 'secret', '2026-10-08T10:00:00Z')],
      hasMore: false,
    })
    await dm.loadCachedConversationPage('c1')

    deleted('m1')
    await flush()

    expect(dm.conversations[0].last_message?.id).toBe('m2')
    expect(dm.cachedConversation('c1')?.messages.map(m => m.id)).toEqual(['m2'])
  })

  it('ends with no preview when nothing is left', async () => {
    const dm = useDMStore()
    await dm.registerGlobalBroadcastHandlers('auth-me')
    dm.conversations = [conversation('m2')] as any

    deleted('m2')
    await flush()

    const conv = dm.conversations[0]
    expect(conv.last_message).toBeUndefined()
    expect(conv.preview_pending).toBe(false)
  })

  it('is removed at logout', async () => {
    const dm = useDMStore()
    await dm.registerGlobalBroadcastHandlers('auth-me')
    dm.cleanup(true)
    expect(h.handlers.get('conversation:message_deleted')?.size ?? 0).toBe(0)
  })
})
