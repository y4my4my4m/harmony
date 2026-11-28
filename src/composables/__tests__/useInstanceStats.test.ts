/**
 * useInstanceStats: changes made here outlive a re-read of a snapshot computed before them, and
 * end with the first one computed after; an older answer never replaces a newer one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { InstanceStats } from '@/services/AdminService'

const read = vi.hoisted(() => vi.fn())
vi.mock('@/services/AdminService', () => ({ adminService: { getAdminInstanceStats: read } }))

const T0 = Date.parse('2026-11-25T10:00:00Z')

/** A snapshot computed at `at` (ms), as the server answers it now. */
function snapshot(at: number, suspended = 3): InstanceStats {
  return {
    computedAt: new Date(at).toISOString(),
    ageSeconds: Math.floor((Date.now() - at) / 1000),
    refreshingElsewhere: false,
    approximate: [],
    users: { total: 100, local: 40, federated: 60, suspended, new24h: 0 },
  } as unknown as InstanceStats
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

type Store = ReturnType<typeof import('../useInstanceStats')['useInstanceStats']>
let store: Store
const suspended = () => store.stats.value?.users.suspended
const suspendOne = () => store.adjust((s) => { s.users.suspended += 1 })

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.resetModules()
  read.mockReset()
  // The shared state is the module's. Outside a component the age ticker does not start.
  store = (await import('../useInstanceStats')).useInstanceStats()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('a change made here', () => {
  it('stays when the same snapshot is read again', async () => {
    read.mockImplementation(async () => snapshot(T0 - 60_000))
    await store.load()
    vi.setSystemTime(T0 + 5_000)
    suspendOne()
    expect(suspended()).toBe(4)

    vi.setSystemTime(T0 + 20_000)
    await store.load()
    expect(suspended()).toBe(4)
    suspendOne()
    await store.load()
    expect(suspended()).toBe(5)
  })

  it('stays on a newer snapshot computed before it and ends with one computed after it', async () => {
    read.mockImplementation(async () => snapshot(T0 - 60_000))
    await store.load()
    vi.setSystemTime(T0 + 200_000)
    suspendOne()

    vi.setSystemTime(T0 + 260_000)
    read.mockImplementation(async () => snapshot(T0 + 180_000))
    await store.load()
    expect(suspended()).toBe(4)

    vi.setSystemTime(T0 + 500_000)
    read.mockImplementation(async () => snapshot(T0 + 480_000, 4))
    await store.load()
    expect(suspended()).toBe(4)
    await store.load()
    expect(suspended()).toBe(4)
  })

  it('is in a refresh asked for after it', async () => {
    read.mockImplementation(async () => snapshot(T0 - 120_000))
    await store.load()
    vi.setSystemTime(T0 + 1_000)
    suspendOne()
    vi.setSystemTime(T0 + 2_000)
    read.mockImplementation(async () => snapshot(T0 + 2_000, 4))
    await store.load(true)
    expect(read).toHaveBeenLastCalledWith(true)
    expect(suspended()).toBe(4)
  })

  it('counts into the first snapshot read after it, computed before it', async () => {
    vi.setSystemTime(T0)
    window.dispatchEvent(new CustomEvent('admin:users-changed', { detail: { suspended: 2 } }))
    expect(store.stats.value).toBeNull()
    vi.setSystemTime(T0 + 10_000)
    read.mockImplementation(async () => snapshot(T0 - 60_000))
    await store.load()
    expect(suspended()).toBe(5)
  })
})

describe('answers out of order', () => {
  it('keeps the newer snapshot when an older one lands last', async () => {
    const slow = deferred<InstanceStats>()
    read.mockReturnValueOnce(slow.promise).mockImplementation(async () => snapshot(T0 - 10_000, 7))
    const first = store.load()
    await store.load()
    expect(suspended()).toBe(7)
    expect(store.loading.value).toBe(false)
    slow.resolve(snapshot(T0 - 400_000, 3))
    await first
    expect(suspended()).toBe(7)
  })

  it('takes a refresh that lands after a later plain read of the old snapshot', async () => {
    const refresh = deferred<InstanceStats>()
    read.mockReturnValueOnce(refresh.promise).mockImplementation(async () => snapshot(T0 - 400_000, 3))
    const first = store.load(true)
    await store.load()
    expect(suspended()).toBe(3)
    refresh.resolve(snapshot(T0, 8))
    await first
    expect(suspended()).toBe(8)
  })

  it('keeps the answer of the later request for the same snapshot', async () => {
    const slow = deferred<InstanceStats>()
    read.mockReturnValueOnce(slow.promise)
      .mockImplementation(async () => ({ ...snapshot(T0 - 10_000), responseMs: 2 }))
    const first = store.load()
    await store.load()
    slow.resolve({ ...snapshot(T0 - 10_000), responseMs: 900 })
    await first
    expect(store.stats.value?.responseMs).toBe(2)
  })

  it('does not count a superseded request as failed, and loads until the latest answers', async () => {
    const slow = deferred<InstanceStats>(), latest = deferred<InstanceStats>()
    read.mockReturnValueOnce(slow.promise).mockReturnValueOnce(latest.promise)
    const first = store.load()
    const second = store.load()
    slow.reject(new Error('timeout'))
    await first
    expect(store.failed.value).toBe(true)
    expect(store.loading.value).toBe(true)
    latest.resolve(snapshot(T0 - 10_000))
    await second
    expect(store.failed.value).toBe(false)
    expect(store.loading.value).toBe(false)

    const late = deferred<InstanceStats>()
    read.mockReturnValueOnce(late.promise).mockImplementation(async () => snapshot(T0 - 10_000))
    const third = store.load()
    await store.load()
    late.reject(new Error('timeout'))
    await third
    await flushPromises()
    expect(store.failed.value).toBe(false)
  })
})
