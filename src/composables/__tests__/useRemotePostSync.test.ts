/**
 * Mount-time reaction syncs of remote posts: queued and sent as /fetch-reactions-batch
 * requests of up to 30 posts, never one request per post.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'

const service = vi.hoisted(() => ({
  fetchRemoteReactions: vi.fn(),
  fetchRemoteReactionsBatch: vi.fn(),
  fetchRemoteReplies: vi.fn(),
  getRemoteRepliesStatus: vi.fn(),
}))
vi.mock('@/services/activityPubService', () => ({ activityPubService: service }))

import { useRemotePostSync, fetchedReactionsThisSession, flushReactionSyncs } from '../useRemotePostSync'

const remotePost = (n: number) => ({
  id: `post-${n}`,
  ap_id: `https://mastodon.test/users/a/statuses/${n}`,
  is_local: false,
  metadata: {},
}) as any

function mountSync(post: any, onReactionsUpdate = vi.fn()) {
  const Probe = defineComponent({
    setup() {
      const sync = useRemotePostSync(() => post, { isRemote: () => true, onReactionsUpdate })
      return () => h('div', String(sync.isFetchingReplies.value))
    },
  })
  mount(Probe)
  return onReactionsUpdate
}

describe('useRemotePostSync reaction batching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetchedReactionsThisSession.clear()
    service.fetchRemoteReactionsBatch.mockImplementation(async (posts: any[]) =>
      Object.fromEntries(posts.map((p) => [p.post_ap_id, { success: true, favorites_count: 1, post: p.post_id }])))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the posts mounted together in one request and hands each its result', async () => {
    const updates = [1, 2, 3].map((n) => mountSync(remotePost(n)))
    expect(service.fetchRemoteReactionsBatch).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(300)

    expect(service.fetchRemoteReactionsBatch).toHaveBeenCalledTimes(1)
    expect(service.fetchRemoteReactionsBatch.mock.calls[0][0]).toHaveLength(3)
    expect(service.fetchRemoteReactions).not.toHaveBeenCalled()
    updates.forEach((update, i) => expect(update).toHaveBeenCalledWith(expect.objectContaining({ post: `post-${i + 1}` })))
  })

  it('splits a long timeline into requests of thirty', async () => {
    for (let n = 0; n < 35; n++) mountSync(remotePost(100 + n))
    await vi.advanceTimersByTimeAsync(300)
    expect(service.fetchRemoteReactionsBatch.mock.calls.map((c) => c[0].length)).toEqual([30, 5])
  })

  it('syncs a post once per session across remounts', async () => {
    const post = remotePost(200)
    mountSync(post)
    mountSync(post)
    await flushReactionSyncs()
    mountSync(post)
    await vi.advanceTimersByTimeAsync(300)
    expect(service.fetchRemoteReactionsBatch).toHaveBeenCalledTimes(1)
    expect(service.fetchRemoteReactionsBatch.mock.calls[0][0]).toEqual([
      { post_ap_id: post.ap_id, post_id: post.id },
    ])
  })

  it('leaves the posts alone when the batch fails', async () => {
    service.fetchRemoteReactionsBatch.mockResolvedValueOnce(null)
    const update = mountSync(remotePost(300))
    await vi.advanceTimersByTimeAsync(300)
    expect(update).not.toHaveBeenCalled()
  })
})
