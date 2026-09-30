import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Message } from '@/types'

const service = vi.hoisted(() => ({
  pinMessage: vi.fn(),
  unpinMessage: vi.fn(),
  getPinnedCount: vi.fn(),
  getPinnedChannelMessages: vi.fn(),
  getPinnedDMMessages: vi.fn(),
}))

const chat = vi.hoisted(() => ({
  messages: [] as any[],
  patchMessageFields: vi.fn((id: string, fields: object) => {
    for (const m of chat.messages) if (m.id === id) Object.assign(m, fields)
  }),
}))

const dm = vi.hoisted(() => ({
  currentDMMessages: [] as any[],
  patchMessageFields: vi.fn(),
}))

vi.mock('@/services/MessageService', () => ({ messageService: service }))
vi.mock('@/stores/useChat', () => ({ useChatStore: () => chat }))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => dm }))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profileId: 'me' }) }))

import { usePinsStore, pinScopeKey, COUNT_REFRESH_DELAY_MS } from '@/stores/usePins'

const CH = 'chan-1'
const SCOPE = pinScopeKey(CH)!

function msg(id: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    channel_id: CH,
    user_id: 'author',
    created_at: new Date('2026-09-01T00:00:00Z'),
    content: [{ type: 'text', text: id }],
    is_pinned: false,
    ...extra,
  } as Message
}

function deferred<T = boolean>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function loadedStore(count: number) {
  service.getPinnedCount.mockResolvedValueOnce(count)
  const store = usePinsStore()
  await store.loadCount(CH)
  return store
}

describe('usePinsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    Object.values(service).forEach(fn => fn.mockReset())
    chat.messages = []
    chat.patchMessageFields.mockClear()
    dm.currentDMMessages = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('optimistic pin', () => {
    it('moves the count and the message before the RPC resolves', async () => {
      const store = await loadedStore(2)
      const m = msg('m1')
      chat.messages = [m]
      const rpc = deferred()
      service.pinMessage.mockReturnValueOnce(rpc.promise)

      const op = store.setPinned(m, true)

      expect(store.pinnedCount(SCOPE)).toBe(3)
      expect(m.is_pinned).toBe(true)
      expect(m.pinned_by).toBe('me')
      expect(chat.patchMessageFields).toHaveBeenCalledWith('m1', expect.objectContaining({ is_pinned: true }))

      rpc.resolve(true)
      await op
      expect(store.pinnedCount(SCOPE)).toBe(3)
      expect(store.pending.m1).toBeUndefined()
    })

    it('rolls back count and message fields when the RPC fails', async () => {
      const store = await loadedStore(2)
      const m = msg('m1', { is_pinned: true, pinned_at: '2026-09-02T00:00:00Z', pinned_by: 'mod' })
      service.unpinMessage.mockRejectedValueOnce(new Error('Permission denied'))

      const op = store.setPinned(m, false)
      expect(store.pinnedCount(SCOPE)).toBe(1)
      expect(m.is_pinned).toBe(false)

      await expect(op).rejects.toThrow('Permission denied')
      expect(store.pinnedCount(SCOPE)).toBe(2)
      expect(m.is_pinned).toBe(true)
      expect(m.pinned_at).toBe('2026-09-02T00:00:00Z')
      expect(m.pinned_by).toBe('mod')
    })

    it('a superseded failure neither rolls back nor throws', async () => {
      const store = await loadedStore(0)
      const m = msg('m1')
      const pin = deferred()
      const unpin = deferred()
      service.pinMessage.mockReturnValueOnce(pin.promise)
      service.unpinMessage.mockReturnValueOnce(unpin.promise)

      const first = store.setPinned(m, true)
      const second = store.setPinned(m, false)
      expect(store.pinnedCount(SCOPE)).toBe(0)

      pin.reject(new Error('Maximum pin limit (50) reached'))
      await expect(first).resolves.toBeUndefined()
      expect(m.is_pinned).toBe(false)

      unpin.resolve(true)
      await second
      expect(store.pinnedCount(SCOPE)).toBe(0)
      expect(m.is_pinned).toBe(false)
    })

    it('a failed later op restores the state an earlier confirmed op left', async () => {
      const store = await loadedStore(0)
      const m = msg('m1')
      const pin = deferred()
      service.pinMessage.mockReturnValueOnce(pin.promise)
      service.unpinMessage.mockRejectedValueOnce(new Error('network'))

      const first = store.setPinned(m, true)
      const second = store.setPinned(m, false)
      pin.resolve(true)
      await first
      await expect(second).rejects.toThrow('network')

      expect(store.pinnedCount(SCOPE)).toBe(1)
      expect(m.is_pinned).toBe(true)
    })

    it('restores the confirmed state when the later op fails after it', async () => {
      const store = await loadedStore(0)
      const m = msg('m1')
      const pin = deferred()
      const unpin = deferred()
      service.pinMessage.mockReturnValueOnce(pin.promise)
      service.unpinMessage.mockReturnValueOnce(unpin.promise)

      const first = store.setPinned(m, true)
      const second = store.setPinned(m, false)
      pin.resolve(true)
      await first
      expect(m.is_pinned).toBe(false)
      expect(store.pinnedCount(SCOPE)).toBe(0)

      unpin.reject(new Error('network'))
      await expect(second).rejects.toThrow('network')
      expect(m.is_pinned).toBe(true)
      expect(store.pinnedCount(SCOPE)).toBe(1)
    })

    it('ignores optimistic (unsent) messages', async () => {
      const store = await loadedStore(0)
      await store.setPinned(msg('temp-123'), true)
      expect(service.pinMessage).not.toHaveBeenCalled()
      expect(store.pinnedCount(SCOPE)).toBe(0)
    })
  })

  describe('realtime', () => {
    it('counts the echo of an own pin once, whichever arrives first', async () => {
      const store = await loadedStore(1)
      const m = msg('m1')
      chat.messages = [m]
      const rpc = deferred()
      service.pinMessage.mockReturnValueOnce(rpc.promise)

      const op = store.setPinned(m, true)
      // postgres_changes and broadcast both deliver the row.
      store.applyRealtimeRow({ id: 'm1', channel_id: CH, is_pinned: true })
      store.applyRealtimeRow({ id: 'm1', channel_id: CH, is_pinned: true })
      expect(store.pinnedCount(SCOPE)).toBe(2)

      rpc.resolve(true)
      await op
      expect(store.pinnedCount(SCOPE)).toBe(2)

      store.applyRealtimeRow({ id: 'm1', channel_id: CH, is_pinned: true })
      expect(store.pinnedCount(SCOPE)).toBe(2)
    })

    it('applies another user\'s pin and unpin of a loaded message', async () => {
      const store = await loadedStore(0)
      chat.messages = [msg('m1')]

      store.applyRealtimeRow({ id: 'm1', channel_id: CH, is_pinned: true })
      store.applyRealtimeRow({ id: 'm1', channel_id: CH, is_pinned: true })
      expect(store.pinnedCount(SCOPE)).toBe(1)

      store.applyRealtimeRow({ id: 'm1', channel_id: CH, is_pinned: false })
      expect(store.pinnedCount(SCOPE)).toBe(0)
    })

    it('treats a soft delete of a pinned message as an unpin', async () => {
      const store = await loadedStore(1)
      chat.messages = [msg('m1', { is_pinned: true })]

      store.applyRealtimeRow({ id: 'm1', channel_id: CH, is_pinned: true, is_deleted: true })
      expect(store.pinnedCount(SCOPE)).toBe(0)
    })

    it('refetches the count when the prior state is unknown', async () => {
      const store = await loadedStore(3)
      service.getPinnedCount.mockResolvedValueOnce(4)

      store.applyRealtimeRow({ id: 'not-loaded', channel_id: CH, is_pinned: true })
      expect(store.pinnedCount(SCOPE)).toBe(3)

      await vi.advanceTimersByTimeAsync(COUNT_REFRESH_DELAY_MS)
      expect(service.getPinnedCount).toHaveBeenCalledTimes(2)
      expect(store.pinnedCount(SCOPE)).toBe(4)
    })

    it('uses a loaded pinned list as the exact prior', async () => {
      const store = usePinsStore()
      service.getPinnedChannelMessages.mockResolvedValueOnce([msg('p1', { is_pinned: true })])
      await store.loadList(CH)
      expect(store.pinnedCount(SCOPE)).toBe(1)

      store.applyRealtimeRow({ id: 'p1', channel_id: CH, is_pinned: false })
      store.applyRealtimeRow({ id: 'other', channel_id: CH, is_pinned: false })
      expect(store.pinnedCount(SCOPE)).toBe(0)
      expect(store.pinnedMessages(SCOPE)).toEqual([])
      await vi.advanceTimersByTimeAsync(COUNT_REFRESH_DELAY_MS)
      expect(service.getPinnedCount).not.toHaveBeenCalled()
    })

    it('keeps the optimistic state on a realtime copy of a pending message', async () => {
      const store = await loadedStore(0)
      const m = msg('m1')
      service.pinMessage.mockReturnValueOnce(new Promise(() => {}))
      void store.setPinned(m, true)

      expect(store.overlayPending({ id: 'm1', is_pinned: false }).is_pinned).toBe(true)
      expect(store.overlayPending({ id: 'm2', is_pinned: false }).is_pinned).toBe(false)
    })

    it('applies a DELETE carrying only the primary key', async () => {
      const store = await loadedStore(1)
      chat.messages = [msg('m1', { is_pinned: true })]

      store.applyRealtimeDelete({ id: 'm1' })
      expect(store.pinnedCount(SCOPE)).toBe(0)
    })
  })

  describe('pinned list', () => {
    it('shows an optimistic pin at the head and drops it on rollback', async () => {
      const store = usePinsStore()
      service.getPinnedChannelMessages.mockResolvedValueOnce([msg('p1', { is_pinned: true })])
      await store.loadList(CH)
      const rpc = deferred()
      service.pinMessage.mockReturnValueOnce(rpc.promise)

      const op = store.setPinned(msg('m1'), true)
      expect(store.pinnedMessages(SCOPE)!.map(m => m.id)).toEqual(['m1', 'p1'])

      rpc.reject(new Error('network'))
      await expect(op).rejects.toThrow()
      expect(store.pinnedMessages(SCOPE)!.map(m => m.id)).toEqual(['p1'])
    })

    it('hides an unpinned entry at once and restores its position on rollback', async () => {
      const store = usePinsStore()
      const listed = [msg('p1', { is_pinned: true }), msg('p2', { is_pinned: true }), msg('p3', { is_pinned: true })]
      service.getPinnedChannelMessages.mockResolvedValueOnce(listed)
      await store.loadList(CH)
      service.unpinMessage.mockRejectedValueOnce(new Error('network'))

      const op = store.setPinned(store.pinnedMessages(SCOPE)![1], false)
      expect(store.pinnedMessages(SCOPE)!.map(m => m.id)).toEqual(['p1', 'p3'])
      expect(store.pinnedCount(SCOPE)).toBe(2)

      await expect(op).rejects.toThrow()
      expect(store.pinnedMessages(SCOPE)!.map(m => m.id)).toEqual(['p1', 'p2', 'p3'])
      expect(store.pinnedCount(SCOPE)).toBe(3)
    })

    it('marks the list stale for a remote pin of a message not held locally', async () => {
      const store = usePinsStore()
      service.getPinnedChannelMessages.mockResolvedValueOnce([])
      await store.loadList(CH)

      store.applyRealtimeRow({ id: 'remote', channel_id: CH, is_pinned: true })
      expect(store.isListStale(SCOPE)).toBe(true)
      expect(store.pinnedCount(SCOPE)).toBe(1)
    })

    it('inserts a remote pin of a loaded message without refetching', async () => {
      const store = usePinsStore()
      service.getPinnedChannelMessages.mockResolvedValueOnce([])
      await store.loadList(CH)
      chat.messages = [msg('m1')]

      store.applyRealtimeRow({ id: 'm1', channel_id: CH, is_pinned: true })
      expect(store.isListStale(SCOPE)).toBe(false)
      expect(store.pinnedMessages(SCOPE)!.map(m => m.id)).toEqual(['m1'])
    })
  })

  describe('fetch races', () => {
    it('discards a count fetched across a delta and refetches', async () => {
      const store = await loadedStore(1)
      chat.messages = [msg('m1')]
      const slow = deferred<number>()
      service.getPinnedCount.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(2)

      const load = store.loadCount(CH)
      store.applyRealtimeRow({ id: 'm1', channel_id: CH, is_pinned: true })
      slow.resolve(1)
      await load
      expect(store.pinnedCount(SCOPE)).toBe(2)

      await vi.advanceTimersByTimeAsync(COUNT_REFRESH_DELAY_MS)
      expect(service.getPinnedCount).toHaveBeenCalledTimes(3)
      expect(store.pinnedCount(SCOPE)).toBe(2)
    })

    it('holds a count fetched under a pending op until the op settles', async () => {
      const store = await loadedStore(0)
      const rpc = deferred()
      service.pinMessage.mockReturnValueOnce(rpc.promise)
      const op = store.setPinned(msg('m1'), true)

      service.getPinnedCount.mockResolvedValueOnce(1)
      await store.loadCount(CH)
      expect(store.pinnedCount(SCOPE)).toBe(1)

      service.getPinnedCount.mockResolvedValueOnce(1)
      rpc.resolve(true)
      await op
      await vi.advanceTimersByTimeAsync(COUNT_REFRESH_DELAY_MS)
      expect(store.pinnedCount(SCOPE)).toBe(1)
    })

    it('keeps the previous count when the fetch fails', async () => {
      const store = await loadedStore(5)
      service.getPinnedCount.mockRejectedValueOnce(new Error('offline'))
      await store.loadCount(CH)
      expect(store.pinnedCount(SCOPE)).toBe(5)
    })
  })

  it('keys DM scopes by conversation', () => {
    expect(pinScopeKey('c', 'conv')).toBe('dm:conv')
    expect(pinScopeKey('c')).toBe('channel:c')
    expect(pinScopeKey()).toBeNull()
  })
})
