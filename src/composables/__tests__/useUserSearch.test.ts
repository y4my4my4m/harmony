import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, ref } from 'vue'

const searchUsers = vi.fn()
vi.mock('@/services/activityPubService', () => ({ activityPubService: { searchUsers: (...a: unknown[]) => searchUsers(...a) } }))

import { supabase } from '@/supabase'
import { normalizeUserQuery, useUserSearch, type UseUserSearchOptions } from '@/composables/useUserSearch'

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

function row(id: string, username = id) {
  return { id, username, display_name: null, avatar_url: `${id}/avatar.webp` }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function mount(options: UseUserSearchOptions) {
  const scope = effectScope()
  const search = scope.run(() => useUserSearch(options))!
  return { search, scope }
}

beforeEach(() => {
  vi.useFakeTimers()
  rpc.mockReset()
  searchUsers.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useUserSearch', () => {
  it('debounces keystrokes into one local search', async () => {
    rpc.mockResolvedValue({ data: [row('u1', 'bob')], error: null })
    const { search } = mount({ localOnly: true, debounceMs: 100, limit: 5 })

    search.query.value = 'b'
    search.query.value = 'bo'
    search.query.value = '@bob'
    expect(search.searching.value).toBe(true)
    await vi.advanceTimersByTimeAsync(99)
    expect(rpc).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('search_local_users', { p_query: 'bob', p_limit: 5 })
    expect(search.results.value).toEqual([{ ...row('u1', 'bob'), is_local: true }])
    expect(search.searching.value).toBe(false)
    expect(search.error.value).toBeNull()
  })

  it('drops a response that arrives after a newer query', async () => {
    const slow = deferred<{ data: unknown[]; error: null }>()
    const fast = deferred<{ data: unknown[]; error: null }>()
    rpc.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
    const { search } = mount({ localOnly: true, debounceMs: 10 })

    search.query.value = 'al'
    await vi.advanceTimersByTimeAsync(10)
    search.query.value = 'alice'
    await vi.advanceTimersByTimeAsync(10)
    expect(rpc).toHaveBeenCalledTimes(2)

    fast.resolve({ data: [row('alice')], error: null })
    await vi.advanceTimersByTimeAsync(0)
    slow.resolve({ data: [row('alfred'), row('alice')], error: null })
    await vi.advanceTimersByTimeAsync(0)

    expect(search.results.value.map((u) => u.id)).toEqual(['alice'])
    expect(search.searching.value).toBe(false)
  })

  it('keeps searching while the newest query is in flight', async () => {
    const first = deferred<{ data: unknown[]; error: null }>()
    const second = deferred<{ data: unknown[]; error: null }>()
    rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { search } = mount({ localOnly: true, debounceMs: 10 })

    search.query.value = 'ca'
    await vi.advanceTimersByTimeAsync(10)
    search.query.value = 'car'
    await vi.advanceTimersByTimeAsync(10)
    first.resolve({ data: [row('cat')], error: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(search.searching.value).toBe(true)

    second.resolve({ data: [row('carl')], error: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(search.searching.value).toBe(false)
    expect(search.results.value.map((u) => u.id)).toEqual(['carl'])
  })

  it('does not search below the minimum length and clears results', async () => {
    rpc.mockResolvedValue({ data: [row('dan')], error: null })
    const { search } = mount({ localOnly: true, minLength: 2, debounceMs: 10 })

    search.query.value = '@d'
    await vi.advanceTimersByTimeAsync(50)
    expect(rpc).not.toHaveBeenCalled()
    expect(search.searching.value).toBe(false)

    search.query.value = 'da'
    await vi.advanceTimersByTimeAsync(10)
    expect(search.results.value).toHaveLength(1)

    search.query.value = 'd'
    expect(search.results.value).toEqual([])
    expect(search.searching.value).toBe(false)
  })

  it('a pending search for a shortened query never lands', async () => {
    const pending = deferred<{ data: unknown[]; error: null }>()
    rpc.mockReturnValueOnce(pending.promise)
    const { search } = mount({ localOnly: true, minLength: 2, debounceMs: 10 })

    search.query.value = 'ed'
    await vi.advanceTimersByTimeAsync(10)
    search.query.value = ''
    pending.resolve({ data: [row('edna')], error: null })
    await vi.advanceTimersByTimeAsync(0)

    expect(search.results.value).toEqual([])
  })

  it('leaves out excluded ids, reactively', async () => {
    rpc.mockResolvedValue({ data: [row('a'), row('b'), row('c')], error: null })
    const taken = ref<string[]>(['b'])
    const { search } = mount({ localOnly: true, debounceMs: 0, exclude: () => taken.value })

    search.query.value = 'x'
    await vi.advanceTimersByTimeAsync(0)
    expect(search.results.value.map((u) => u.id)).toEqual(['a', 'c'])

    taken.value = ['a', 'c']
    expect(search.results.value.map((u) => u.id)).toEqual(['b'])
  })

  it('accepts a Set to exclude', async () => {
    rpc.mockResolvedValue({ data: [row('a'), row('b')], error: null })
    const { search } = mount({ localOnly: true, debounceMs: 0, exclude: () => new Set(['a']) })

    search.query.value = 'x'
    await vi.advanceTimersByTimeAsync(0)
    expect(search.results.value.map((u) => u.id)).toEqual(['b'])
  })

  it('reports an error and empties the results', async () => {
    rpc.mockResolvedValueOnce({ data: [row('a')], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'boom', code: 'XX000' } })
    const { search } = mount({ localOnly: true, debounceMs: 0 })

    search.query.value = 'a'
    await vi.advanceTimersByTimeAsync(0)
    search.query.value = 'ab'
    await vi.advanceTimersByTimeAsync(0)

    expect(search.error.value).toBe('boom')
    expect(search.results.value).toEqual([])
    expect(search.searching.value).toBe(false)
  })

  it('searches federated users when not local-only', async () => {
    searchUsers.mockResolvedValue([
      { id: 'r1', username: 'zed', display_name: 'Zed', avatar_url: 'https://remote.example/z.png', domain: 'remote.example', handle: 'zed@remote.example', is_local: false },
    ])
    const { search } = mount({ debounceMs: 0, limit: 10 })

    search.query.value = '@zed@remote'
    await vi.advanceTimersByTimeAsync(0)

    expect(searchUsers).toHaveBeenCalledWith('zed@remote', 10)
    expect(rpc).not.toHaveBeenCalled()
    expect(search.results.value[0]).toMatchObject({ id: 'r1', domain: 'remote.example', handle: 'zed@remote.example', is_local: false })
  })

  it('clear() empties everything and cancels the pending search', async () => {
    rpc.mockResolvedValue({ data: [row('a')], error: null })
    const { search } = mount({ localOnly: true, debounceMs: 50 })

    search.query.value = 'abc'
    search.clear()
    await vi.advanceTimersByTimeAsync(100)

    expect(rpc).not.toHaveBeenCalled()
    expect(search.query.value).toBe('')
    expect(search.searching.value).toBe(false)
  })

  it('stops when its scope is disposed', async () => {
    rpc.mockResolvedValue({ data: [row('a')], error: null })
    const { search, scope } = mount({ localOnly: true, debounceMs: 50 })

    search.query.value = 'abc'
    scope.stop()
    await vi.advanceTimersByTimeAsync(100)

    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('normalizeUserQuery', () => {
  it('trims and drops leading @', () => {
    expect(normalizeUserQuery('  @@bob ')).toBe('bob')
    expect(normalizeUserQuery('@ ')).toBe('')
    expect(normalizeUserQuery('bob@remote')).toBe('bob@remote')
  })
})
