/**
 * Discover list cache: reuse across opens, background revalidation that keeps
 * unchanged rows, and refresh failures that leave the cached list in place.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { toRaw } from 'vue'
import { supabase } from '@/supabase'
import { usePublicServersStore } from '@/stores/usePublicServers'

vi.mock('@/services/serverMembershipService', () => ({
  getServerMemberCounts: vi.fn(async () => new Map([['a', 3]])),
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: { ensureUsersLoaded: vi.fn(async () => {}) },
}))

type Row = { id: string; name: string; description: string | null; owner: string; category: string | null; is_local_server: boolean }

const row = (id: string, name = `Server ${id}`): Row =>
  ({ id, name, description: null, owner: 'u1', category: null, is_local_server: true })

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** Each servers query answers with the next queued response. */
function queueResponses(...responses: Array<{ data: Row[] | null; error: unknown } | Promise<{ data: Row[] | null; error: unknown }>>) {
  let calls = 0
  vi.mocked(supabase.from).mockImplementation(((table: string) => {
    if (table !== 'servers') throw new Error(`unexpected table ${table}`)
    const chain = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      order: () => chain,
      limit: async () => {
        const next = responses[Math.min(calls++, responses.length - 1)]
        const { data, error } = await next
        return { data: data ? data.map(r => ({ ...r })) : null, error }
      },
    }
    return chain
  }) as any)
  return { calls: () => calls }
}

describe('public servers cache', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(supabase.from).mockReset()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('serves a fresh list without querying again', async () => {
    const q = queueResponses({ data: [row('a')], error: null })
    const store = usePublicServersStore()
    await store.fetchPublicServers()
    await store.fetchPublicServers()
    expect(q.calls()).toBe(1)
    expect(store.servers.map(s => s.id)).toEqual(['a'])
    expect(store.servers[0].member_count).toBe(3)
  })

  it('revalidates a stale list and keeps the same array when nothing changed', async () => {
    const q = queueResponses({ data: [row('a'), row('b')], error: null })
    const store = usePublicServersStore()
    await store.fetchPublicServers()
    const before = toRaw(store.servers)

    vi.setSystemTime(new Date('2026-10-02T00:01:01Z'))
    expect(store.needsFreshData()).toBe(true)
    await store.fetchPublicServers()

    expect(q.calls()).toBe(2)
    expect(toRaw(store.servers)).toBe(before)
    expect(store.needsFreshData()).toBe(false)
  })

  it('replaces only the rows that changed', async () => {
    queueResponses({ data: [row('a'), row('b')], error: null }, { data: [row('a'), row('b', 'Renamed')], error: null })
    const store = usePublicServersStore()
    await store.fetchPublicServers()
    const [a, b] = toRaw(store.servers)

    await store.fetchPublicServers(true)

    const after = toRaw(store.servers)
    expect(after[0]).toBe(a)
    expect(after[1]).not.toBe(b)
    expect(after[1].name).toBe('Renamed')
  })

  it('keeps the cached list visible while a refresh is in flight', async () => {
    const pending = deferred<{ data: Row[]; error: null }>()
    queueResponses({ data: [row('a')], error: null }, pending.promise)
    const store = usePublicServersStore()
    await store.fetchPublicServers()

    const refresh = store.forceRefresh()
    expect(store.isLoading).toBe(true)
    expect(store.isInitialLoading).toBe(false)
    expect(store.hasLoaded).toBe(true)
    expect(store.servers.map(s => s.id)).toEqual(['a'])

    pending.resolve({ data: [row('a'), row('c')], error: null })
    await refresh
    expect(store.servers.map(s => s.id)).toEqual(['a', 'c'])
  })

  it('reports initial loading only before the first list arrives', async () => {
    const pending = deferred<{ data: Row[]; error: null }>()
    queueResponses(pending.promise)
    const store = usePublicServersStore()
    const load = store.fetchPublicServers()
    expect(store.isInitialLoading).toBe(true)
    pending.resolve({ data: [row('a')], error: null })
    await load
    expect(store.isInitialLoading).toBe(false)
  })

  it('keeps the cached list when a refresh fails', async () => {
    queueResponses({ data: [row('a')], error: null }, { data: null, error: { message: 'down' } })
    const store = usePublicServersStore()
    await store.fetchPublicServers()

    await store.forceRefresh()

    expect(store.error).toBeNull()
    expect(store.servers.map(s => s.id)).toEqual(['a'])
    expect(store.hasLoaded).toBe(true)
  })

  it('reports an error when the first load fails', async () => {
    queueResponses({ data: null, error: { message: 'down' } })
    const store = usePublicServersStore()
    await store.fetchPublicServers()
    expect(store.error).toBe('Failed to load servers. Please try again.')
    expect(store.hasLoaded).toBe(false)
  })
})
