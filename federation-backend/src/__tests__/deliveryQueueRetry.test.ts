import { describe, it, expect, vi, beforeEach } from 'vitest'

// Retry policy of DeliveryQueue.enqueue: a failed immediate delivery is queued
// only when a redelivery can succeed.

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../services/PerformanceMonitor.js', () => ({
  performanceMonitor: { recordMetric: vi.fn() },
}))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: vi.fn(() => false) },
}))
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { signRequest: vi.fn(async () => ({ headers: {} })) },
}))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(),
  validateExternalUrl: vi.fn(),
}))

const inserted: any[] = []
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: () => Promise.resolve({ error: null }),
    from: () => {
      const c: any = {
        select: () => c,
        eq: () => c,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: (row: any) => { inserted.push(row); return Promise.resolve({ error: null }) },
      }
      return c
    },
  }),
}))

const { DeliveryQueue, isUnsalvageableStatus } = await import('../activitypub/DeliveryQueue.js')
const { safeFetch } = await import('../utils/ssrfProtection.js')

beforeEach(() => {
  inserted.length = 0
  vi.mocked(safeFetch).mockReset()
})

describe('isUnsalvageableStatus', () => {
  it('treats 4xx other than 401/408/429 as permanent', () => {
    for (const s of [400, 403, 404, 410, 422]) expect(isUnsalvageableStatus(s)).toBe(true)
    for (const s of [401, 408, 429, 500, 502, 503, undefined]) expect(isUnsalvageableStatus(s)).toBe(false)
  })
})

describe('DeliveryQueue.enqueue', () => {
  it('does not queue a retry after 410 Gone', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 410 }))

    await DeliveryQueue.enqueue({ type: 'Create' }, 'https://gone.test/inbox', 'sender')

    expect(inserted).toHaveLength(0)
  })

  it('queues a retry after a 503', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 503 }))

    await DeliveryQueue.enqueue({ type: 'Create' }, 'https://busy.test/inbox', 'sender')

    expect(inserted).toHaveLength(1)
    expect(inserted[0].target_inbox_url).toBe('https://busy.test/inbox')
  })

  it('queues a retry after a network error', async () => {
    vi.mocked(safeFetch).mockRejectedValue(new Error('ECONNRESET'))

    await DeliveryQueue.enqueue({ type: 'Create' }, 'https://flaky.test/inbox', 'sender')

    expect(inserted).toHaveLength(1)
  })
})
