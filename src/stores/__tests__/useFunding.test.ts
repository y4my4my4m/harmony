/**
 * Funding store: one summary read shared by every caller, reused for FRESH_MS and up to the
 * monthly period's end; nothing polls. Returning to the page after a payment link reads until
 * the donation shows. clear() drops the summary, and a load running at sign-out writes
 * nothing back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const funding = vi.hoisted(() => ({ getFundingSummary: vi.fn() }))
vi.mock('@/services/FundingService', () => ({ fundingService: funding, primeBadgeCache: vi.fn() }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { useFundingStore, FRESH_MS, PAYMENT_RETRY_MS } from '@/stores/useFunding'

const SUMMARY = { id: 'f1', enabled: true, displayed_amount: 10, period_end: null, me: null } as any
const OTHER = { id: 'f2', enabled: true, displayed_amount: 20, period_end: null, me: null } as any

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-05T12:00:00Z'))
  funding.getFundingSummary.mockReset()
  localStorage.clear()
  setVisibility('visible')
})

afterEach(() => {
  useFundingStore().clear()
  vi.useRealTimers()
})

describe('useFundingStore', () => {
  it('drops what a load running at clear() returns', async () => {
    const read = deferred<any>()
    funding.getFundingSummary.mockReturnValueOnce(read.promise)
    const store = useFundingStore()
    const pending = store.load()
    store.clear()
    read.resolve(SUMMARY)
    expect(await pending).toBeNull()
    expect(store.config).toBeNull()
    expect(store.lastLoadedAt).toBe(0)
  })

  it('a load after clear() reads anew, and the earlier one leaves it be', async () => {
    const before = deferred<any>()
    const after = deferred<any>()
    funding.getFundingSummary.mockReturnValueOnce(before.promise).mockReturnValueOnce(after.promise)
    const store = useFundingStore()
    void store.load()
    store.clear()
    const fresh = store.load()
    expect(funding.getFundingSummary).toHaveBeenCalledTimes(2)
    before.resolve(SUMMARY)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.inflight).not.toBeNull()
    after.resolve(OTHER)
    expect(await fresh).toBe(OTHER)
    expect(store.config).toEqual(OTHER)
  })

  it('shares one read between concurrent callers and reuses it while fresh', async () => {
    funding.getFundingSummary.mockResolvedValue(SUMMARY)
    const store = useFundingStore()
    await Promise.all([store.load(), store.load(), store.load()])
    expect(funding.getFundingSummary).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(FRESH_MS - 1000)
    await store.load()
    expect(funding.getFundingSummary).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    await store.load()
    expect(funding.getFundingSummary).toHaveBeenCalledTimes(2)
  })

  it('reads nothing while idle', async () => {
    funding.getFundingSummary.mockResolvedValue(SUMMARY)
    const store = useFundingStore()
    await store.load()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(funding.getFundingSummary).toHaveBeenCalledTimes(1)
  })

  it('reads again once the monthly period has ended', async () => {
    funding.getFundingSummary.mockResolvedValue({ ...SUMMARY, period_end: '2026-11-05T12:01:00Z' })
    const store = useFundingStore()
    await store.load()
    await store.load()
    expect(funding.getFundingSummary).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-11-05T12:01:00Z'))
    await store.load()
    expect(funding.getFundingSummary).toHaveBeenCalledTimes(2)
  })

  it('returning after a payment link reads until the donation shows', async () => {
    const opened = Date.parse('2026-11-05T12:00:00Z')
    const paid = { ...SUMMARY, me: { profile_id: 'p', badge: null, messages: [], donations: [{ id: 'd', donated_at: new Date(opened + 90_000).toISOString() }] } }
    funding.getFundingSummary
      .mockResolvedValueOnce(SUMMARY)
      .mockResolvedValueOnce(SUMMARY)
      .mockResolvedValueOnce(paid)
    const store = useFundingStore()
    await store.load()
    store.notePaymentOpened()
    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(60_000)
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(funding.getFundingSummary).toHaveBeenCalledTimes(2)
    expect(store.thankedAt).toBe(0)
    await vi.advanceTimersByTimeAsync(PAYMENT_RETRY_MS[1])
    expect(funding.getFundingSummary).toHaveBeenCalledTimes(3)
    expect(store.thankedAt).toBeGreaterThan(0)
    expect(store.paymentOpenedAt).toBe(0)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(funding.getFundingSummary).toHaveBeenCalledTimes(3)
  })

  it('stops after the last retry when no donation shows', async () => {
    funding.getFundingSummary.mockResolvedValue(SUMMARY)
    const store = useFundingStore()
    await store.load()
    store.notePaymentOpened()
    setVisibility('hidden')
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(funding.getFundingSummary).toHaveBeenCalledTimes(1 + PAYMENT_RETRY_MS.length)
  })

  it('opens and closes the Support window on a tab', () => {
    const store = useFundingStore()
    store.openModal('project')
    expect(store.modal).toBe('project')
    store.closeModal()
    expect(store.modal).toBeNull()
    store.openModal()
    expect(store.modal).toBe('instance')
  })
})
