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
vi.mock('../activitypub/ServerActor.js', () => ({
  signAsServer: vi.fn(async (serverId: string) => ({ headers: { Signature: `keyId="https://harmony.test/servers/${serverId}#main-key"` } })),
}))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(),
  validateExternalUrl: vi.fn(),
}))

const inserted: any[] = []
const updated: any[] = []
vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: () => Promise.resolve({ error: null }),
    from: () => {
      const c: any = {
        select: () => c,
        eq: () => c,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: (row: any) => { inserted.push(row); return Promise.resolve({ error: null }) },
        update: (row: any) => { updated.push(row); return c },
      }
      return c
    },
  }),
}))

const { DeliveryQueue, isUnsalvageableStatus } = await import('../activitypub/DeliveryQueue.js')
const { safeFetch } = await import('../utils/ssrfProtection.js')
const { SignatureService } = await import('../activitypub/SignatureService.js')
const { signAsServer } = await import('../activitypub/ServerActor.js')

beforeEach(() => {
  inserted.length = 0
  updated.length = 0
  vi.mocked(safeFetch).mockReset()
  vi.mocked(SignatureService.signRequest).mockClear()
  vi.mocked(signAsServer).mockClear()
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

describe('Group-signed delivery', () => {
  const accept = { type: 'Accept', actor: 'https://harmony.test/servers/srv' }

  it('signs with the Group key and queues the retry under the Group, not a profile', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 503 }))

    await DeliveryQueue.enqueue(accept, 'https://busy.test/inbox', { serverId: 'srv' })

    expect(vi.mocked(signAsServer).mock.calls.map((c) => [c[0], c[1]])).toEqual([['srv', 'https://busy.test/inbox']])
    expect(SignatureService.signRequest).not.toHaveBeenCalled()
    expect(vi.mocked(safeFetch).mock.calls[0][1]?.headers).toMatchObject({
      Signature: 'keyId="https://harmony.test/servers/srv#main-key"',
    })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ sender_server_id: 'srv' })
    expect(inserted[0]).not.toHaveProperty('sender_id')
  })

  it('keeps a profile delivery off the Group column', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 503 }))

    await DeliveryQueue.enqueue({ type: 'Create' }, 'https://busy.test/inbox', 'alice')

    expect(inserted[0]).toMatchObject({ sender_id: 'alice' })
    expect(inserted[0]).not.toHaveProperty('sender_server_id')
  })

  it('retries a queued Group delivery with the Group key', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 202 }))

    const delivered = await (DeliveryQueue as any).deliverActivity({
      id: 'q1',
      activity_data: accept,
      target_inbox_url: 'https://peer.test/inbox',
      sender_id: null,
      sender_server_id: 'srv',
      actor_username: null,
      attempts: 1,
      max_attempts: 5,
      next_attempt_at: new Date().toISOString(),
    })

    expect(delivered).toBe(true)
    expect(vi.mocked(signAsServer).mock.calls.map((c) => c[0])).toEqual(['srv'])
    expect(SignatureService.signRequest).not.toHaveBeenCalled()
    expect(updated.map((u) => u.status)).toEqual(['delivered'])
  })
})
