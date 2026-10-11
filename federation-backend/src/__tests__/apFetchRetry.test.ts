import { describe, it, expect, vi, beforeEach } from 'vitest'

// fetchApDocument: one retry after a connection-level failure, none after an HTTP status or a
// non-network error.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', NODE_ENV: 'test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn() }))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: vi.fn(() => false) },
}))
vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichPostLinkPreviews: vi.fn(async () => false),
}))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({}) }))
const signedApFetch = vi.hoisted(() => vi.fn())
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { signedApFetch, verifySignature: vi.fn() },
}))

const { ActivityProcessor, transientNetworkCause } = await import('../activitypub/ActivityProcessor.js')

const URL_ = 'https://mastodon.test/users/strypey/statuses/1'
const note = () => new Response(JSON.stringify({ id: URL_, type: 'Note' }), {
  status: 200, headers: { 'content-type': 'application/activity+json' },
})
const fetchFailed = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) })

beforeEach(() => {
  signedApFetch.mockReset()
})

describe('transientNetworkCause', () => {
  it('reads the code under undici\'s "fetch failed", including Happy Eyeballs aggregates', () => {
    expect(transientNetworkCause(fetchFailed('ETIMEDOUT'))).toBe('ETIMEDOUT')
    const aggregate = new TypeError('fetch failed', {
      cause: Object.assign(new AggregateError([], 'x'), { errors: [{ code: 'ENETUNREACH' }, { code: 'ETIMEDOUT' }] }),
    })
    expect(transientNetworkCause(aggregate)).toBe('ENETUNREACH')
    expect(transientNetworkCause(new Error('safeFetch: timeout after 10000ms'))).toBeNull()
    expect(transientNetworkCause(fetchFailed('CERT_HAS_EXPIRED'))).toBeNull()
  })
})

describe('fetchApDocument', () => {
  it('retries once after a connection-level failure', async () => {
    vi.useFakeTimers()
    signedApFetch.mockRejectedValueOnce(fetchFailed('ETIMEDOUT')).mockResolvedValueOnce(note())
    const pending = ActivityProcessor.fetchApDocument(URL_)
    await vi.runAllTimersAsync()
    const fetched = await pending
    vi.useRealTimers()
    expect(fetched?.doc).toMatchObject({ id: URL_, type: 'Note' })
    expect(signedApFetch).toHaveBeenCalledTimes(2)
  })

  it('gives up after the second failure', async () => {
    vi.useFakeTimers()
    signedApFetch.mockRejectedValue(fetchFailed('ECONNRESET'))
    const pending = ActivityProcessor.fetchApDocument(URL_)
    await vi.runAllTimersAsync()
    expect(await pending).toBeNull()
    vi.useRealTimers()
    expect(signedApFetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry an HTTP status or a non-network error', async () => {
    signedApFetch.mockResolvedValueOnce(new Response('gone', { status: 410 }))
    expect(await ActivityProcessor.fetchApDocument(URL_)).toBeNull()
    signedApFetch.mockRejectedValueOnce(new Error('safeFetch: timeout after 10000ms'))
    expect(await ActivityProcessor.fetchApDocument(URL_)).toBeNull()
    expect(signedApFetch).toHaveBeenCalledTimes(2)
  })
})
