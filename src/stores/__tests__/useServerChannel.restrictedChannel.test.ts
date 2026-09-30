import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import { useServerChannelStore } from '@/stores/useServerChannel'

// broadcast_channel_change sends a channel not every member can view as ids only; the store
// refetches it and channels RLS decides what this user sees.

const CAT = 'cat-1'
const row = (over: Record<string, unknown> = {}) => ({
  id: 'ch-hidden', server_id: 'srv-1', name: 'mods', category: CAT, order: 3, type: 0, ...over,
})

function mockChannelFetch(result: { data: unknown; error?: unknown }) {
  const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: result.data, error: result.error ?? null }) }))
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    if (table !== 'channels') throw new Error(`unexpected table ${table}`)
    return { select: () => ({ eq }) }
  }) as any)
  return eq
}

const restricted = (type: string) => ({
  type, restricted: true,
  new: { id: 'ch-hidden', server_id: 'srv-1', category: CAT, type: 0, order: 3 },
  old: { id: 'ch-hidden', server_id: 'srv-1', category: CAT, type: 0, order: 3 },
})

describe('useServerChannelStore restricted channel broadcasts', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(supabase.from).mockReset()
  })

  it('adds the channel when the refetch returns it', async () => {
    const eq = mockChannelFetch({ data: row() })
    const store = useServerChannelStore()

    await store._reconcileRestrictedChannel(restricted('channel:insert'))

    expect(eq).toHaveBeenCalledWith('id', 'ch-hidden')
    expect(store.channels.map(c => c.id)).toEqual(['ch-hidden'])
    expect(store.channels[0].name).toBe('mods')
    expect(store.categoryChannels[CAT].map(c => c.id)).toEqual(['ch-hidden'])
  })

  it('never adds a channel the refetch does not return', async () => {
    mockChannelFetch({ data: null })
    const store = useServerChannelStore()

    await store._reconcileRestrictedChannel(restricted('channel:insert'))

    expect(store.channels).toEqual([])
  })

  it('removes a listed channel the user can no longer view', async () => {
    mockChannelFetch({ data: null })
    const store = useServerChannelStore()
    store.channels = [row() as any]
    store.categoryChannels = { [CAT]: [row() as any] }

    await store._reconcileRestrictedChannel(restricted('channel:update'))

    expect(store.channels).toEqual([])
    expect(store.categoryChannels[CAT]).toEqual([])
  })

  it('collapses a burst of permission changes into one forced refetch', async () => {
    vi.useFakeTimers()
    try {
      const store = useServerChannelStore()
      store.currentServerId = 'srv-1'
      const fetch = vi.spyOn(store, 'fetchCategoriesAndChannels').mockResolvedValue(undefined)

      store._scheduleVisibleChannelRefresh('srv-1')
      store._scheduleVisibleChannelRefresh('srv-1')
      store._scheduleVisibleChannelRefresh('srv-1')
      await vi.runAllTimersAsync()

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith('srv-1', undefined, true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('updates a listed channel from the refetched row', async () => {
    mockChannelFetch({ data: row({ name: 'mods-renamed' }) })
    const store = useServerChannelStore()
    store.channels = [row() as any]
    store.categoryChannels = { [CAT]: [row() as any] }

    await store._reconcileRestrictedChannel(restricted('channel:update'))

    expect(store.channels[0].name).toBe('mods-renamed')
    expect(store.categoryChannels[CAT][0].name).toBe('mods-renamed')
  })
})
