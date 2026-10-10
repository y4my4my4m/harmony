import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const service = vi.hoisted(() => ({
  fetchRemoteReplies: vi.fn(),
  getRemoteRepliesStatus: vi.fn(),
}))
vi.mock('@/services/activityPubService', () => ({ activityPubService: service }))

import { useRemoteRepliesFetch } from '../useRemoteRepliesFetch'

const TARGET = { apId: 'https://mastodon.test/users/a/statuses/1', postId: 'post-1' }

describe('useRemoteRepliesFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('moves from fetching to the crawl\'s outcome', async () => {
    service.fetchRemoteReplies.mockResolvedValue({ success: true, status: 'started', result: null })
    service.getRemoteRepliesStatus.mockResolvedValue({
      success: true, status: 'done',
      result: { outcome: 'unauthorized', found: 0, stored: 0, existing: 0, skipped: 0, truncated: false, complete: false },
    })
    const { view, run } = useRemoteRepliesFetch()
    const running = run(TARGET)
    await vi.advanceTimersByTimeAsync(0)
    expect(view.value).toEqual({ kind: 'fetching' })

    await vi.advanceTimersByTimeAsync(2000)
    expect(await running).toMatchObject({ status: 'done' })
    expect(view.value).toEqual({ kind: 'unauthorized' })
  })

  it('joins a crawl it already follows unless forced', async () => {
    service.fetchRemoteReplies.mockResolvedValue({ success: true, status: 'started', result: null })
    service.getRemoteRepliesStatus.mockResolvedValue({ success: true, status: 'running', result: null })
    const { run } = useRemoteRepliesFetch()
    void run(TARGET)
    expect(await run(TARGET)).toBeNull()
    expect(service.fetchRemoteReplies).toHaveBeenCalledTimes(1)
  })

  it('drops a superseded crawl\'s answer', async () => {
    service.fetchRemoteReplies.mockResolvedValue({ success: true, status: 'started', result: null })
    service.getRemoteRepliesStatus.mockResolvedValue({ success: true, status: 'idle', result: null })
    const { view, run, reset } = useRemoteRepliesFetch()
    const running = run(TARGET)
    await vi.advanceTimersByTimeAsync(0)
    reset()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await running).toBeNull()
    expect(view.value).toBeNull()
  })
})
