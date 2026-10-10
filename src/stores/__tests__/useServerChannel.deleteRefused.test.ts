import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import { useServerChannelStore } from '@/stores/useServerChannel'

// A delete RLS refuses returns no row and no error: the store must not drop the row locally.

function deleteReturning(rows: Array<{ id: string }>) {
  const select = vi.fn(async () => ({ data: rows, error: null }))
  const query: any = { eq: vi.fn(() => query), in: vi.fn(() => query), select }
  const update: any = { in: vi.fn(async () => ({ error: null })) }
  vi.mocked(supabase.from).mockReturnValue({ delete: vi.fn(() => query), update: vi.fn(() => update) } as any)
  return select
}

describe('useServerChannelStore refused deletes', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keeps a channel the database did not delete', async () => {
    const store = useServerChannelStore()
    store.channels = [{ id: 'c1', name: 'stats', server_id: 's1' } as any]
    deleteReturning([])

    await expect(store.deleteChannel('c1')).rejects.toThrow(/not permitted/)
    expect(store.channels.map((c) => c.id)).toEqual(['c1'])
  })

  it('keeps a category the database did not delete', async () => {
    const store = useServerChannelStore()
    store.categories = [{ id: 'k1', name: 'Text Channels', server_id: 's1' } as any]
    store.categoryChannels = { k1: [] } as any
    deleteReturning([])

    await expect(store.deleteCategory('k1')).rejects.toThrow(/not permitted/)
    expect(store.categories.map((c) => c.id)).toEqual(['k1'])
  })

  it('removes a channel the database deleted', async () => {
    const store = useServerChannelStore()
    store.channels = [{ id: 'c1', name: 'stats', server_id: 's1' } as any]
    deleteReturning([{ id: 'c1' }])

    await store.deleteChannel('c1')
    expect(store.channels).toEqual([])
  })
})
