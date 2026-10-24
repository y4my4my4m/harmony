import { describe, it, expect, vi, beforeEach } from 'vitest'

// Where the instance's federation switches take effect (migration 20261028500001): every
// delivery, immediate or queued; every inbox POST; every signed request.

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
  SignatureService: {
    signRequest: vi.fn(async () => ({ headers: {} })),
    verifySignature: vi.fn(async () => ({ verified: true, actorUrl: 'https://peer.test/users/eve' })),
  },
}))
vi.mock('../activitypub/ServerActor.js', () => ({ signAsServer: vi.fn(async () => ({ headers: {} })) }))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn(), validateExternalUrl: vi.fn() }))

const switches = vi.hoisted(() => ({ inbound: true, outbound: true }))
vi.mock('../services/FederationSwitches.js', () => ({
  outboundAllows: vi.fn(async () => switches.outbound),
  inboundAllowed: vi.fn(async () => switches.inbound),
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
        in: () => c,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: (row: any) => { inserted.push(row); return Promise.resolve({ error: null }) },
        update: (row: any) => { updated.push(row); return c },
        then: (resolve: any) => resolve({ data: null, error: null }),
      }
      return c
    },
  }),
}))

const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')
const { refuseInboxWhenInboundOff } = await import('../middleware/inboundFederation.js')
const { verifiedSigner } = await import('../activitypub/groupAccess.js')
const { safeFetch } = await import('../utils/ssrfProtection.js')
const { SignatureService } = await import('../activitypub/SignatureService.js')

beforeEach(() => {
  switches.inbound = true
  switches.outbound = true
  inserted.length = 0
  updated.length = 0
  vi.mocked(safeFetch).mockReset()
  vi.mocked(SignatureService.verifySignature).mockClear()
})

describe('outbound', () => {
  it('drops an immediate delivery: nothing is sent and nothing queued', async () => {
    switches.outbound = false
    await DeliveryQueue.enqueue({ type: 'Create', id: 'https://harmony.test/activities/1' }, 'https://peer.test/inbox', 'sender')
    expect(safeFetch).not.toHaveBeenCalled()
    expect(inserted).toHaveLength(0)
  })

  it('cancels a queued retry without sending it', async () => {
    switches.outbound = false
    const delivered = await (DeliveryQueue as any).deliverActivity({
      id: 'q1', activity_data: { type: 'Create' }, target_inbox_url: 'https://peer.test/inbox',
      sender_id: 'sender', actor_username: null, attempts: 1, max_attempts: 5, next_attempt_at: new Date().toISOString(),
    })
    expect(delivered).toBe(false)
    expect(safeFetch).not.toHaveBeenCalled()
    expect(updated).toContainEqual(expect.objectContaining({ status: 'cancelled', error_message: 'Outbound federation is off' }))
  })

  it('sends while outbound is on', async () => {
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 202 }))
    await DeliveryQueue.enqueue({ type: 'Create' }, 'https://peer.test/inbox', 'sender')
    expect(safeFetch).toHaveBeenCalledTimes(1)
  })
})

describe('inbound', () => {
  const reply = () => {
    const res: any = { statusCode: 200, body: undefined }
    res.status = (code: number) => { res.statusCode = code; return res }
    res.json = (body: unknown) => { res.body = body; return res }
    return res
  }

  it('refuses an inbox POST with 403 while inbound is off', async () => {
    switches.inbound = false
    const res = reply()
    const next = vi.fn()
    await refuseInboxWhenInboundOff({ method: 'POST', originalUrl: '/inbox' } as any, res, next)
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('passes a GET of an inbox path, and any POST while inbound is on', async () => {
    switches.inbound = false
    const next = vi.fn()
    await refuseInboxWhenInboundOff({ method: 'GET', originalUrl: '/users/ann/inbox' } as any, reply(), next)
    switches.inbound = true
    await refuseInboxWhenInboundOff({ method: 'POST', originalUrl: '/inbox' } as any, reply(), next)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('reads a signed GET as anonymous while inbound is off, fetching no key', async () => {
    const req: any = {
      method: 'GET', originalUrl: '/servers/s', protocol: 'https',
      headers: { signature: 'keyId="https://peer.test/users/eve#main-key",headers="(request-target) host date",signature="x"' },
    }
    switches.inbound = false
    expect(await verifiedSigner(req)).toBeNull()
    expect(SignatureService.verifySignature).not.toHaveBeenCalled()
    switches.inbound = true
    expect(await verifiedSigner(req)).toBe('https://peer.test/users/eve')
  })
})
