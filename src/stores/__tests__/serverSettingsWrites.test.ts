import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import { usePublicServersStore } from '@/stores/usePublicServers'
import { useServerStore } from '@/stores/server'
import { useServerChannelStore } from '@/stores/useServerChannel'

vi.mock('@/services/serverMembershipService', () => ({
  getServerMemberCounts: vi.fn(async () => new Map()),
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: { ensureUsersLoaded: vi.fn(async () => {}) },
}))
vi.mock('vue-toastification', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}))

const ROWS = [
  { id: 'chosen', name: 'Minecraft Club', description: null, owner: 'u1', category: 'music', is_local_server: true },
  { id: 'inferred', name: 'Minecraft Hub', description: null, owner: 'u1', category: null, is_local_server: true },
  { id: 'jazz', name: 'Jazz Night', description: null, owner: 'u1', category: null, is_local_server: true },
  { id: 'chosen-other', name: 'Jazz Cellar', description: null, owner: 'u1', category: 'other', is_local_server: true },
]

function mockDiscovery(rows: object[]): { selects: string[] } {
  const seen = { selects: [] as string[] }
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    if (table !== 'servers') throw new Error(`unexpected table ${table}`)
    const chain = {
      select: (columns: string) => { seen.selects.push(columns); return chain },
      eq: () => chain,
      neq: () => chain,
      or: () => chain,
      order: () => chain,
      limit: async () => ({ data: rows.map(r => ({ ...r })), error: null }),
    }
    return chain
  }) as any)
  return seen
}

describe('discovery category precedence', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(supabase.from).mockReset()
    vi.mocked(supabase.rpc).mockReset()
  })

  it('selects servers.category', async () => {
    const seen = mockDiscovery(ROWS)
    await usePublicServersStore().fetchPublicServers(true)
    expect(seen.selects[0]).toMatch(/\bcategory\b/)
  })

  it('filters by the chosen category, inferring only where none is chosen', async () => {
    mockDiscovery(ROWS)
    const store = usePublicServersStore()
    await store.fetchPublicServers(true)

    store.setSelectedCategory('music')
    expect(store.filteredServers.map(s => s.id)).toEqual(['chosen', 'jazz'])

    store.setSelectedCategory('gaming')
    expect(store.filteredServers.map(s => s.id)).toEqual(['inferred'])

    store.setSelectedCategory('other')
    expect(store.filteredServers.map(s => s.id)).toEqual(['chosen-other'])
  })

  it('ignores a category on a remote row', async () => {
    mockDiscovery([{ id: 'remote', name: 'Minecraft Club', description: null, owner: 'u1', category: 'music', is_local_server: false }])
    const store = usePublicServersStore()
    await store.fetchPublicServers(true)
    expect(store.servers[0].discovery_category).toBe('gaming')
  })
})

describe('updateServer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(supabase.rpc).mockReset()
    vi.mocked(supabase.from).mockReset()
  })

  it('writes only settings keys through update_server and marks Discover stale', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { id: 'srv-1' }, error: null } as any)
    const discovery = usePublicServersStore()
    discovery.lastFetchTime = Date.now()

    const ok = await useServerStore().updateServer({
      id: 'srv-1',
      name: 'Renamed',
      category: 'science',
      owner: 'someone-else',
      is_local_server: true,
      created_at: '2026-01-01',
    })

    expect(ok).toBe(true)
    expect(supabase.rpc).toHaveBeenCalledWith('update_server', {
      p_server_id: 'srv-1',
      p_changes: { name: 'Renamed', category: 'science' },
    })
    expect(supabase.from).not.toHaveBeenCalled()
    expect(discovery.isDataStale).toBe(true)
  })

  it('reports failure when update_server refuses the caller', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Missing permission: MANAGE_SERVER' },
    } as any)
    const discovery = usePublicServersStore()
    discovery.lastFetchTime = Date.now()

    expect(await useServerStore().updateServer({ id: 'srv-1', name: 'Renamed' })).toBe(false)
    expect(discovery.isDataStale).toBe(false)
  })

  it('passes null to clear the category', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: {}, error: null } as any)
    await useServerStore().updateServer({ id: 'srv-1', category: null })
    expect(supabase.rpc).toHaveBeenCalledWith('update_server', {
      p_server_id: 'srv-1',
      p_changes: { category: null },
    })
  })
})

describe('serverChannel updateServer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(supabase.rpc).mockReset()
    vi.mocked(supabase.from).mockReset()
  })

  it('writes through update_server and merges the result', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { id: 'srv-1', icon: 'srv-1/icon.png' }, error: null } as any)
    const store = useServerChannelStore()
    store.servers = [{ id: 'srv-1', name: 'S', icon: '' } as any]

    await store.updateServer({ id: 'srv-1', icon: 'srv-1/icon.png' })

    expect(supabase.rpc).toHaveBeenCalledWith('update_server', {
      p_server_id: 'srv-1',
      p_changes: { icon: 'srv-1/icon.png' },
    })
    expect(supabase.from).not.toHaveBeenCalled()
    expect(store.servers[0].icon).toBe('srv-1/icon.png')
  })

  it('throws when update_server refuses the caller', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'Missing permission: MANAGE_SERVER' },
    } as any)
    await expect(useServerChannelStore().updateServer({ id: 'srv-1', name: 'X' }))
      .rejects.toThrow('Missing permission: MANAGE_SERVER')
  })
})

describe('createServer category', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(supabase.from).mockReset()
  })

  function captureInsert(): object[] {
    const inserted: object[] = []
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table !== 'servers') throw new Error(`unexpected table ${table}`)
      return {
        insert: (rows: object[]) => {
          inserted.push(...rows)
          return { select: () => ({ single: async () => ({ data: { id: 'srv-1', ...rows[0] }, error: null }) }) }
        },
      }
    }) as any)
    return inserted
  }

  it('inserts the chosen category', async () => {
    const inserted = captureInsert()
    await useServerChannelStore().createServer({ name: 'New', owner: 'u1', category: 'education' })
    expect(inserted[0]).toMatchObject({ category: 'education' })
  })

  it('leaves the column unset when none is chosen', async () => {
    const inserted = captureInsert()
    await useServerChannelStore().createServer({ name: 'New', owner: 'u1', category: null })
    expect(inserted[0]).not.toHaveProperty('category')
  })
})
