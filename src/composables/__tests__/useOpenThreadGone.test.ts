import { describe, it, expect, vi, beforeEach } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { ThreadWithDetails } from '@/services/ThreadService'

const service = vi.hoisted(() => ({
  getThreadRow: vi.fn(),
  getChannelThreads: vi.fn(),
  clearThreadCache: vi.fn(),
}))

vi.mock('@/services/ThreadService', () => ({ threadService: service }))

import { useThreadsStore } from '@/stores/useThreads'
import { useOpenThreadGone } from '@/composables/useOpenThreadGone'

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    channel_id: 'chan-1',
    parent_message_id: `p-${id}`,
    name: id,
    created_by: 'someone',
    created_at: '2026-11-01T00:00:00Z',
    archived: false,
    locked: false,
    auto_archive_duration: 1440,
    message_count: 1,
    member_count: 1,
    ...extra,
  } as unknown as ThreadWithDetails
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await nextTick()
}

describe('useOpenThreadGone', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    service.getThreadRow.mockReset()
    service.clearThreadCache.mockReset()
  })

  function open(id: string) {
    const store = useThreadsStore()
    const thread = ref<ThreadWithDetails | null>(store.upsert(row(id, { channel_name: 'general' })))
    const onGone = vi.fn()
    const scope = effectScope()
    const api = scope.run(() => useOpenThreadGone(thread, onGone))!
    return { store, thread, onGone, scope, ...api }
  }

  it('calls onGone once the open thread leaves the index and the server has no row', async () => {
    const { store, onGone } = open('t1')
    service.getThreadRow.mockResolvedValueOnce(null)
    store.remove('t1')
    await settle()
    expect(service.getThreadRow).toHaveBeenCalledWith('t1')
    expect(onGone).toHaveBeenCalledTimes(1)
    expect(onGone).toHaveBeenCalledWith('removed')
  })

  it('puts back an entry dropped while its row exists and stays', async () => {
    const { store, thread, onGone } = open('t1')
    service.getThreadRow.mockResolvedValueOnce(row('t1', { name: 'still here' }))
    store.remove('t1')
    await settle()
    expect(onGone).not.toHaveBeenCalled()
    expect(store.byId.t1?.name).toBe('still here')
    expect(store.byId.t1?.channel_name).toBe('general')
    expect(thread.value).toBe(store.byId.t1)
  })

  it('stays when the re-read fails', async () => {
    const { store, onGone } = open('t1')
    service.getThreadRow.mockRejectedValueOnce(new Error('offline'))
    store.remove('t1')
    await settle()
    expect(onGone).not.toHaveBeenCalled()
  })

  it('a thread opened after its deletion is reported missing once the server has no row', async () => {
    const { thread, onGone, checkMissing } = open('t1')
    thread.value = { id: 't9', name: 'From a notice' } as ThreadWithDetails
    service.getThreadRow.mockResolvedValueOnce(row('t9'))
    await checkMissing('t9')
    expect(onGone).not.toHaveBeenCalled()

    service.getThreadRow.mockResolvedValueOnce(null)
    await checkMissing('t9')
    expect(onGone).toHaveBeenCalledWith('missing')
  })

  it('a stale entry of a missing thread is dropped and reported once', async () => {
    const { store, onGone, checkMissing } = open('t1')
    service.getThreadRow.mockResolvedValue(null)
    await checkMissing('t1')
    await settle()
    expect(store.byId.t1).toBeUndefined()
    expect(service.clearThreadCache).toHaveBeenCalledWith('t1')
    expect(onGone).toHaveBeenCalledTimes(1)
    expect(onGone).toHaveBeenCalledWith('missing')
  })

  it('ignores a switch to a thread the index does not hold yet', async () => {
    const { thread, onGone } = open('t1')
    thread.value = { id: 't2', name: 'Opened from a link' } as ThreadWithDetails
    await settle()
    expect(service.getThreadRow).not.toHaveBeenCalled()
    expect(onGone).not.toHaveBeenCalled()
  })
})
