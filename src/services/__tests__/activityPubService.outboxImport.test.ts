import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// importRemoteOutboxPage: a network error, 429 or 5xx is sent again twice, 600 ms then
// 1200 ms later; any other error status is not.

vi.mock('@/services/userDataService', () => ({
  userDataService: { getCurrentUser: () => ({ id: 'me' }) },
}))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: async () => ({ isAuthenticated: true, authUser: { id: 'auth-me' }, profileId: 'me' }),
    getCurrentProfileId: async () => 'me',
  },
}))

vi.mock('@/stores/useActivityPub', () => ({
  useActivityPubStore: () => ({ federationApiUrl: 'https://harmony.test/api/federation' }),
}))

import { activityPubService } from '@/services/activityPubService'

const OUTBOX = 'https://mastodon.test/users/a/outbox'
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const end = () => json({ success: true, has_more: false, oldest_id: null })

describe('outbox import requests', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Runs the import with the backoff timers advanced; resolves to its result or its error. */
  async function importPage() {
    const settled = activityPubService.importRemoteOutboxPage('alice-id', OUTBOX, { maxId: 'next' })
      .then((result) => ({ result }), (error: Error) => ({ error }))
    await vi.advanceTimersByTimeAsync(2000)
    return settled
  }

  it('sends a 503 and a network error again, and returns the answer that follows', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'unavailable' }, 503))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(end())
    expect(await importPage()).toEqual({ result: { hasMore: false, oldestId: null } })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ user_id: 'alice-id', outbox_url: OUTBOX, max_id: 'next', limit: 20 })
  })

  it('gives up after three 502s', async () => {
    fetchMock.mockImplementation(async () => json({ error: 'Remote outbox could not be read' }, 502))
    const { error } = await importPage() as { error: Error }
    expect(error.message).toBe('Outbox import failed: 502')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('sends a 429 again', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Too Many Requests' }, 429)).mockResolvedValueOnce(end())
    expect(await importPage()).toEqual({ result: { hasMore: false, oldestId: null } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sends a 400 once', async () => {
    fetchMock.mockResolvedValue(json({ error: 'outbox_url does not match the stored profile' }, 400))
    const { error } = await importPage() as { error: Error }
    expect(error.message).toBe('Outbox import failed: 400')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
