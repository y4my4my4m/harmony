import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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

const POST = 'https://mastodon.test/users/a/statuses/1'
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init })

describe('remote reply requests', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks for an answer before the crawl ends', async () => {
    fetchMock.mockResolvedValue(json({ success: true, status: 'started', result: null, replies_count: 4 }))
    const answer = await activityPubService.fetchRemoteReplies(POST, 'post-1', { force: true })

    expect(answer).toEqual({ success: true, status: 'started', result: null, replies_count: 4 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://harmony.test/api/federation/fetch-replies')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ post_ap_id: POST, post_id: 'post-1', force: true, async: true })
  })

  it('reads a crawl\'s progress with a GET', async () => {
    fetchMock.mockResolvedValue(json({ success: true, status: 'running', result: null }))
    await activityPubService.getRemoteRepliesStatus(POST)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`https://harmony.test/api/federation/fetch-replies/status?post_ap_id=${encodeURIComponent(POST)}`)
    expect(init.method).toBeUndefined()
  })

  it('turns a 429 into rate_limited with the seconds the backend gives', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Too Many Requests', retryAfter: 17 }, { status: 429, headers: { 'Retry-After': '17' } }))
    expect(await activityPubService.fetchRemoteReplies(POST, 'post-1'))
      .toEqual({ success: false, status: 'rate_limited', retry_after: 17 })

    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'Retry-After': '8' } }))
    expect(await activityPubService.fetchRemoteReplies(POST, 'post-1'))
      .toEqual({ success: false, status: 'rate_limited', retry_after: 8 })
  })

  it('turns a 503 into busy, and anything else into failed', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: false, status: 'busy', retry_after: 5 }, { status: 503, headers: { 'Retry-After': '5' } }))
    expect(await activityPubService.fetchRemoteReplies(POST, 'post-1')).toEqual({ success: false, status: 'busy', retry_after: 5 })

    fetchMock.mockResolvedValueOnce(json({ error: 'boom' }, { status: 500 }))
    expect(await activityPubService.fetchRemoteReplies(POST, 'post-1')).toEqual({ success: false, status: 'failed' })

    fetchMock.mockRejectedValueOnce(new TypeError('network down'))
    expect(await activityPubService.getRemoteRepliesStatus(POST)).toEqual({ success: false, status: 'failed' })
  })

  it('sends reaction syncs as one batch', async () => {
    fetchMock.mockResolvedValueOnce(json({ results: { [POST]: { success: true, favorites_count: 3 } } }))
    const results = await activityPubService.fetchRemoteReactionsBatch([{ post_ap_id: POST, post_id: 'post-1' }])
    expect(results).toEqual({ [POST]: { success: true, favorites_count: 3 } })
    expect(fetchMock.mock.calls[0][0]).toBe('https://harmony.test/api/federation/fetch-reactions-batch')

    fetchMock.mockResolvedValueOnce(json({ error: 'Too Many Requests' }, { status: 429 }))
    expect(await activityPubService.fetchRemoteReactionsBatch([{ post_ap_id: POST, post_id: 'post-1' }])).toBeNull()
  })
})
