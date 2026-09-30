import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@/types'

const service = vi.hoisted(() => ({
  getChannelThreads: vi.fn(),
  getThreadRow: vi.fn(),
}))

vi.mock('@/services/ThreadService', () => ({ threadService: service }))

import {
  useThreadsStore,
  isOptimisticThreadId,
  mergeFreshThreadMessages,
  isThreadExpired,
  CHANNEL_THREAD_PAGE,
} from '@/stores/useThreads'

const CH = 'chan-1'

function parent(id = 'parent-1', userId = 'author'): Message {
  return { id, channel_id: CH, user_id: userId, created_at: new Date(), content: [] } as unknown as Message
}

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    channel_id: CH,
    parent_message_id: `p-${id}`,
    name: id,
    created_by: 'someone',
    created_at: '2026-09-01T00:00:00Z',
    archived: false,
    locked: false,
    auto_archive_duration: 1440,
    message_count: 0,
    member_count: 1,
    ...extra,
  }
}

function msg(id: string, at: string): Message {
  return { id, created_at: new Date(at), content: [] } as unknown as Message
}

describe('useThreadsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    service.getChannelThreads.mockReset()
    service.getThreadRow.mockReset()
  })

  describe('optimistic create', () => {
    it('indexes the optimistic thread under its parent at once', () => {
      const store = useThreadsStore()
      const t = store.addOptimistic({ parent: parent(), name: 'Plan', channelId: CH, creatorId: 'me' })

      expect(isOptimisticThreadId(t.id)).toBe(true)
      expect(store.threadForMessage('parent-1')).toBe(t)
      expect(store.channelThreads(CH).map(x => x.id)).toEqual([t.id])
      expect(store.activeChannelThreads(CH)).toHaveLength(1)
      expect(t.member_count).toBe(2)
      expect(t.is_member).toBe(true)
    })

    it('re-keys the same object when create_thread returns', () => {
      const store = useThreadsStore()
      const t = store.addOptimistic({ parent: parent(), name: 'Plan', channelId: CH, creatorId: 'me' })
      const tempId = t.id

      const bound = store.reconcileOptimistic(tempId, 'real-1')

      expect(bound).toBe(t)
      expect(t.id).toBe('real-1')
      expect(store.byId[tempId]).toBeUndefined()
      expect(store.threadForMessage('parent-1')).toBe(t)
      expect(store.channelThreads(CH)).toHaveLength(1)
    })

    it('does not duplicate when the broadcast row arrives before the RPC result', () => {
      const store = useThreadsStore()
      const t = store.addOptimistic({ parent: parent(), name: 'Plan', channelId: CH, creatorId: 'me' })
      const tempId = t.id

      void store.applyBroadcast({ type: 'thread:insert', new: row('real-1', { parent_message_id: 'parent-1', name: 'Plan' }) })
      expect(store.channelThreads(CH).map(x => x.id)).toEqual(['real-1'])
      expect(t.id).toBe('real-1')
      expect(t.parent_message?.id).toBe('parent-1')

      const bound = store.reconcileOptimistic(tempId, 'real-1')
      expect(bound).toBe(t)
      expect(store.channelThreads(CH)).toHaveLength(1)
    })

    it('rollback removes the optimistic entry and its index', () => {
      const store = useThreadsStore()
      const t = store.addOptimistic({ parent: parent(), name: 'Plan', channelId: CH })

      store.remove(t.id)

      expect(store.threadForMessage('parent-1')).toBeUndefined()
      expect(store.channelThreads(CH)).toEqual([])
    })

    it('keeps a local reply count while replies are pending', () => {
      const store = useThreadsStore()
      const t = store.addOptimistic({ parent: parent(), name: 'Plan', channelId: CH })
      t.message_count = 1
      t.pending_replies = 1
      store.reconcileOptimistic(t.id, 'real-1')

      void store.applyBroadcast({ type: 'thread:update', new: row('real-1', { parent_message_id: 'parent-1', message_count: 0 }) })
      expect(t.message_count).toBe(1)

      t.pending_replies = 0
      void store.applyBroadcast({ type: 'thread:update', new: row('real-1', { parent_message_id: 'parent-1', message_count: 3 }) })
      expect(t.message_count).toBe(3)
    })
  })

  describe('server rows', () => {
    it('never erases enrichment with undefined list fields', () => {
      const store = useThreadsStore()
      store.upsert({ ...row('t1'), channel_name: 'general', is_member: true })
      store.upsert({ ...row('t1', { message_count: 4 }), channel_name: undefined, is_member: undefined })

      expect(store.byId.t1.channel_name).toBe('general')
      expect(store.byId.t1.is_member).toBe(true)
      expect(store.byId.t1.message_count).toBe(4)
    })

    it('a complete channel read drops absent entries but keeps optimistic ones', async () => {
      const store = useThreadsStore()
      store.upsert(row('gone'))
      store.upsert(row('archived', { archived: true }))
      const t = store.addOptimistic({ parent: parent(), name: 'Plan', channelId: CH })
      service.getChannelThreads.mockResolvedValueOnce([row('kept')])

      await store.loadChannelThreads(CH)

      const ids = store.channelThreads(CH, { includeArchived: true }).map(x => x.id).sort()
      expect(ids).toEqual(['archived', 'kept', t.id].sort())
    })

    it('a truncated channel read only adds', async () => {
      const store = useThreadsStore()
      store.upsert(row('older'))
      const page = Array.from({ length: CHANNEL_THREAD_PAGE }, (_, i) => row(`t${i}`))
      service.getChannelThreads.mockResolvedValueOnce(page)

      await store.loadChannelThreads(CH)

      expect(store.byId.older).toBeDefined()
    })

    it('shares one in-flight read per channel and mode', async () => {
      const store = useThreadsStore()
      service.getChannelThreads.mockResolvedValue([])
      await Promise.all([store.loadChannelThreads(CH), store.loadChannelThreads(CH)])
      expect(service.getChannelThreads).toHaveBeenCalledTimes(1)
    })

    it('applies delete broadcasts', () => {
      const store = useThreadsStore()
      store.upsert(row('t1'))
      void store.applyBroadcast({ type: 'thread:delete', old: { id: 't1' } })
      expect(store.byId.t1).toBeUndefined()
      expect(store.threadForMessage('p-t1')).toBeUndefined()
    })

    it('reads the row for a restricted broadcast, and drops it when not visible', async () => {
      const store = useThreadsStore()
      service.getThreadRow.mockResolvedValueOnce(row('t1', { name: 'fresh' }))
      await store.applyBroadcast({ type: 'thread:insert', restricted: true, new: { id: 't1' } })
      expect(store.byId.t1.name).toBe('fresh')

      service.getThreadRow.mockResolvedValueOnce(null)
      await store.applyBroadcast({ type: 'thread:update', restricted: true, new: { id: 't1' } })
      expect(store.byId.t1).toBeUndefined()
    })

    it('treats threads past auto-archive expiry as inactive', () => {
      const store = useThreadsStore()
      store.upsert(row('stale', { last_message_at: '2026-01-01T00:00:00Z', auto_archive_duration: 60 }))
      store.upsert(row('fresh', { last_message_at: new Date().toISOString() }))

      expect(store.activeChannelThreads(CH).map(t => t.id)).toEqual(['fresh'])
      expect(isThreadExpired(store.byId.stale)).toBe(true)
    })
  })
})

describe('mergeFreshThreadMessages', () => {
  const none = new Set<string>()

  it('replaces the fetch window and drops rows deleted since the cache', () => {
    const local = [msg('a', '2026-09-01T00:00:01Z'), msg('deleted', '2026-09-01T00:00:02Z')]
    const fresh = [msg('a', '2026-09-01T00:00:01Z'), msg('b', '2026-09-01T00:00:03Z')]
    expect(mergeFreshThreadMessages(local, fresh, { freshHasMore: false, arrivedDuringFetch: none }).map(m => m.id))
      .toEqual(['a', 'b'])
  })

  it('keeps optimistic sends and rows delivered during the fetch', () => {
    const local = [msg('temp-1', '2026-09-01T00:00:05Z'), msg('live', '2026-09-01T00:00:04Z')]
    const fresh = [msg('a', '2026-09-01T00:00:01Z')]
    const merged = mergeFreshThreadMessages(local, fresh, { freshHasMore: false, arrivedDuringFetch: new Set(['live']) })
    expect(merged.map(m => m.id)).toEqual(['a', 'live', 'temp-1'])
  })

  it('keeps older cached pages outside a truncated fetch', () => {
    const local = [msg('old', '2026-08-01T00:00:00Z'), msg('a', '2026-09-01T00:00:01Z')]
    const fresh = [msg('a', '2026-09-01T00:00:01Z')]
    expect(mergeFreshThreadMessages(local, fresh, { freshHasMore: true, arrivedDuringFetch: none }).map(m => m.id))
      .toEqual(['old', 'a'])
    expect(mergeFreshThreadMessages(local, fresh, { freshHasMore: false, arrivedDuringFetch: none }).map(m => m.id))
      .toEqual(['a'])
  })

  it('empties to the fetch when nothing local survives', () => {
    const local = [msg('x', '2026-09-01T00:00:01Z')]
    expect(mergeFreshThreadMessages(local, [], { freshHasMore: false, arrivedDuringFetch: none })).toEqual([])
  })
})
