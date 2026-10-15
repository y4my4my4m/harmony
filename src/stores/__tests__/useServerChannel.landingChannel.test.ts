import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { statePersistence } from '@/services/StatePersistence'
import { useServerChannelStore } from '@/stores/useServerChannel'

// A server opens on the channel last viewed in it, else on its default channel: the first
// text channel of the first category.

const ch = (id: string, type = 0, category: string | null = 'cat') =>
  ({ id, server_id: 'srv', name: id, type, category, order: 0 }) as any

function remember(lastByServer: Record<string, string>) {
  vi.spyOn(statePersistence, 'getLastChannel').mockImplementation((serverId: string) => lastByServer[serverId] ?? null)
}

describe('useServerChannelStore.landingChannelFor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  function loaded(channels: any[]) {
    const store = useServerChannelStore()
    store._loadedCategoriesServerId = 'srv'
    store.categories = [{ id: 'cat', name: 'Text', server_id: 'srv', order: 0 } as any]
    store.channels = channels
    store.categoryChannels = { cat: channels.filter(c => c.category === 'cat') }
    return store
  }

  it('returns the remembered channel of the loaded server', () => {
    remember({ srv: 'gaming' })
    const store = loaded([ch('general'), ch('gaming')])
    expect(store.landingChannelFor('srv')).toBe('gaming')
  })

  it('falls back to the default channel when the remembered one is gone', () => {
    remember({ srv: 'deleted' })
    const store = loaded([ch('general'), ch('gaming')])
    expect(store.landingChannelFor('srv')).toBe('general')
  })

  it('does not land on a remembered voice channel', () => {
    remember({ srv: 'lounge' })
    const store = loaded([ch('general'), ch('lounge', 1)])
    expect(store.landingChannelFor('srv')).toBe('general')
  })

  it('reads a cached snapshot for a server that is not loaded', () => {
    remember({ other: 'news' })
    const store = loaded([ch('general')])
    store._structureCacheByServer.other = {
      categories: [{ id: 'cat2', name: 'Text', server_id: 'other', order: 0 } as any],
      channels: [ch('rules', 0, 'cat2'), ch('news', 0, 'cat2')],
      categoryChannels: { cat2: [ch('rules', 0, 'cat2'), ch('news', 0, 'cat2')] },
    }
    expect(store.landingChannelFor('other')).toBe('news')
  })

  it('returns null for a server with no loaded or cached structure', () => {
    remember({ unknown: 'x' })
    const store = loaded([ch('general')])
    expect(store.landingChannelFor('unknown')).toBeNull()
  })

  it('records the channel under the server the route names', () => {
    const set = vi.spyOn(statePersistence, 'setLastChannel').mockResolvedValue()
    const store = loaded([ch('general')])
    store.currentServerId = 'previous'
    store.setCurrentChannel('gaming', 'srv')
    expect(set).toHaveBeenCalledWith('srv', 'gaming')
  })
})
