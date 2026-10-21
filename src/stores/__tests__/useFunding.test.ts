/**
 * Funding store across sign-out: clear() drops the config, and a load that was running when it
 * ran writes nothing back. The background refresh runs while signed in, so it starts again on
 * the first load after the next sign-in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const funding = vi.hoisted(() => ({ getFundingWithProgress: vi.fn() }))
vi.mock('@/services/FundingService', () => ({ fundingService: funding }))
const auth = vi.hoisted(() => ({ session: null as null | { access_token: string } }))
vi.mock('@/supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: auth.session } })) } },
}))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { useFundingStore } from '@/stores/useFunding'

const CONFIG = { id: 'f1', enabled: true, displayed_amount: 10 } as any
const OTHER = { id: 'f2', enabled: true, displayed_amount: 20 } as any

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  auth.session = { access_token: 'jwt' }
  funding.getFundingWithProgress.mockReset()
})

afterEach(() => {
  useFundingStore().clear()
  vi.useRealTimers()
})

describe('useFundingStore', () => {
  it('drops what a load running at clear() returns', async () => {
    const read = deferred<any>()
    funding.getFundingWithProgress.mockReturnValueOnce(read.promise)
    const store = useFundingStore()
    const pending = store.load()
    store.clear()
    read.resolve(CONFIG)
    expect(await pending).toBeNull()
    expect(store.config).toBeNull()
    expect(store.lastLoadedAt).toBe(0)
  })

  it('a load after clear() reads anew, and the earlier one leaves it be', async () => {
    const before = deferred<any>()
    const after = deferred<any>()
    funding.getFundingWithProgress.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise)
    const store = useFundingStore()
    void store.load()
    store.clear()
    const fresh = store.load()
    expect(funding.getFundingWithProgress).toHaveBeenCalledTimes(2)

    before.resolve(CONFIG)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.inflight).not.toBeNull()
    after.resolve(OTHER)
    expect(await fresh).toBe(OTHER)
    expect(store.config).toEqual(OTHER)
  })

  it('refreshes in the background while signed in, again after sign-out and sign-in', async () => {
    funding.getFundingWithProgress.mockResolvedValue(CONFIG)
    const store = useFundingStore()
    await store.load()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(funding.getFundingWithProgress).toHaveBeenCalledTimes(2)

    store.clear()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(funding.getFundingWithProgress).toHaveBeenCalledTimes(2)

    // A layout mounts after the next sign-in.
    await store.load()
    expect(funding.getFundingWithProgress).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(funding.getFundingWithProgress).toHaveBeenCalledTimes(4)
  })

  it('starts no background refresh without a session', async () => {
    auth.session = null
    funding.getFundingWithProgress.mockResolvedValue(null)
    const store = useFundingStore()
    await store.load()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(funding.getFundingWithProgress).toHaveBeenCalledTimes(1)
    expect(store.refreshTimer).toBeNull()
  })

  it('starts no background refresh when clear() runs during the session read', async () => {
    funding.getFundingWithProgress.mockResolvedValue(CONFIG)
    const store = useFundingStore()
    void store.load()
    store.clear()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(store.refreshTimer).toBeNull()
    expect(funding.getFundingWithProgress).toHaveBeenCalledTimes(1)
  })
})
