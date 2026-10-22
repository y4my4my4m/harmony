import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import { useServerChannelStore } from '@/stores/useServerChannel'

// broadcast_category_change sends a category not every member sees as ids only; the store reads
// it back and channel_categories RLS decides. Private categories carry a template whose
// @everyone row denies VIEW_CHANNEL.

const category = (over: Record<string, unknown> = {}) => ({
  id: 'cat-staff', server_id: 'srv-1', name: 'Staff', order: 2, ...over,
})
const channel = (over: Record<string, unknown> = {}) => ({
  id: 'ch-1', server_id: 'srv-1', name: 'mods', category: 'cat-staff', order: 0, type: 0, ...over,
})

/** supabase.from(table) answering each table with `rows[table]`. */
function mockTables(rows: Record<string, unknown>) {
  const calls: Array<{ table: string; filters: unknown[][] }> = []
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    const call = { table, filters: [] as unknown[][] }
    calls.push(call)
    const value = rows[table]
    const q: any = {
      select: () => q,
      eq: (...args: unknown[]) => { call.filters.push(['eq', ...args]); return q },
      in: (...args: unknown[]) => { call.filters.push(['in', ...args]); return q },
      maybeSingle: async () => ({ data: Array.isArray(value) ? value[0] ?? null : value ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: value ?? [], error: null }),
    }
    return q
  }) as any)
  return calls
}

describe('useServerChannelStore private categories', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(supabase.from).mockReset()
    vi.mocked(supabase.rpc).mockReset()
  })

  it('adds a restricted category the read-back returns', async () => {
    const calls = mockTables({ channel_categories: category() })
    const store = useServerChannelStore()

    await store._reconcileRestrictedCategory({ type: 'category:insert', restricted: true, new: { id: 'cat-staff' } })

    expect(calls[0]).toMatchObject({ table: 'channel_categories', filters: [['eq', 'id', 'cat-staff']] })
    expect(store.categories.map(c => c.name)).toEqual(['Staff'])
  })

  it('never adds a category the read-back does not return, and drops a listed one', async () => {
    mockTables({ channel_categories: null })
    const store = useServerChannelStore()
    await store._reconcileRestrictedCategory({ type: 'category:insert', restricted: true, new: { id: 'cat-staff' } })
    expect(store.categories).toEqual([])

    store.categories = [category() as any]
    await store._reconcileRestrictedCategory({ type: 'category:update', restricted: true, new: { id: 'cat-staff' } })
    expect(store.categories).toEqual([])
  })

  it('a channel arriving under an unlisted category reads the category back and stays under it', async () => {
    mockTables({ channel_categories: category() })
    const store = useServerChannelStore()

    store._handleChannelInsert({ new: channel() })
    await vi.waitFor(() => expect(store.categories.map(c => c.id)).toEqual(['cat-staff']))

    expect(store.categoryChannels['cat-staff'].map(c => c.id)).toEqual(['ch-1'])
  })

  it('marks categories whose @everyone row denies VIEW_CHANNEL', async () => {
    const calls = mockTables({
      channel_category_permission_overrides: [
        { category_id: 'cat-staff', deny_permissions: 2 },
        { category_id: 'cat-open', deny_permissions: 4096 },
      ],
    })
    const store = useServerChannelStore()
    store.privateCategories = { 'cat-open': true }

    await store._loadPrivateCategories(['cat-staff', 'cat-open'])

    expect(calls[0].filters).toContainEqual(['eq', 'server_roles.is_default', true])
    expect(store.isPrivateCategory('cat-staff')).toBe(true)
    expect(store.isPrivateCategory('cat-open')).toBe(false)
  })

  it('a category is hidden from members when empty or holding only private channels', () => {
    const store = useServerChannelStore()
    store.categoryChannels = { 'cat-staff': [channel() as any], 'cat-mixed': [channel({ id: 'ch-2' }) as any, channel({ id: 'ch-3' }) as any] }
    store.privateChannels = { 'ch-1': true, 'ch-2': true }

    expect(store.isCategoryHiddenFromMembers('cat-staff')).toBe(true)
    expect(store.isCategoryHiddenFromMembers('cat-empty')).toBe(true)
    expect(store.isCategoryHiddenFromMembers('cat-mixed')).toBe(false)
  })

  it('setCategoryPrivacy writes the template from the current one and rereads the synced channels', async () => {
    mockTables({
      server_roles: { id: 'role-everyone' },
      channel_category_permission_overrides: [
        { target_type: 'role', role_id: 'role-everyone', user_id: null, allow_permissions: 0, deny_permissions: 4096, category_id: 'cat-staff' },
      ],
    })
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { synced_channel_ids: ['ch-1'] }, error: null } as any)
    const store = useServerChannelStore()

    const synced = await store.setCategoryPrivacy('cat-staff', 'srv-1', { isPrivate: true, roleIds: ['role-staff'], userIds: [] })

    expect(synced).toEqual(['ch-1'])
    expect(supabase.rpc).toHaveBeenCalledWith('set_category_permissions', {
      p_category_id: 'cat-staff',
      p_overrides: [
        { target_type: 'role', role_id: 'role-everyone', user_id: null, allow_permissions: '0', deny_permissions: '4098' },
        { target_type: 'role', role_id: 'role-staff', user_id: null, allow_permissions: '2', deny_permissions: '0' },
      ],
    })
  })

  it('createCategory applies a private setting to the new category', async () => {
    const store = useServerChannelStore()
    const row = vi.spyOn(store, '_createCategoryRow').mockResolvedValue(category() as any)
    const privacy = vi.spyOn(store, 'setCategoryPrivacy').mockResolvedValue([])

    await store.createCategory('Staff', 'srv-1', { isPrivate: true, roleIds: ['role-staff'], userIds: [] })
    expect(row).toHaveBeenCalledWith('Staff', 'srv-1')
    expect(privacy).toHaveBeenCalledWith('cat-staff', 'srv-1', { isPrivate: true, roleIds: ['role-staff'], userIds: [] })

    privacy.mockClear()
    await store.createCategory('Lounge', 'srv-1', { isPrivate: false, roleIds: [], userIds: [] })
    expect(privacy).not.toHaveBeenCalled()
  })

  it('syncChannelPermissions calls the RPC and rereads the channel\'s private mark', async () => {
    mockTables({ channel_permission_overrides: [{ channel_id: 'ch-1', deny_permissions: 2 }] })
    vi.mocked(supabase.rpc).mockResolvedValue({ data: true, error: null } as any)
    const store = useServerChannelStore()

    await store.syncChannelPermissions('ch-1')

    expect(supabase.rpc).toHaveBeenCalledWith('sync_channel_permissions', { p_channel_id: 'ch-1' })
    expect(store.isPrivateChannel('ch-1')).toBe(true)
  })
})
