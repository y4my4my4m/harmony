/**
 * The reply crawl of the remote post a detail view shows: started when due or on request,
 * followed to its end, and its outcome as a RepliesFetchView.
 */

import { ref } from 'vue'
import { activityPubService, type RemoteRepliesResult } from '@/services/activityPubService'
import { followRepliesFetch, repliesFetchView, type RepliesFetchView } from '@/utils/remoteReplies'

export interface RemoteRepliesTarget {
  apId: string
  postId: string
  /** The post's replies_count when the crawl starts. */
  repliesCount?: number
}

export function useRemoteRepliesFetch() {
  const view = ref<RepliesFetchView | null>(null)
  const activeApId = ref<string | null>(null)
  let generation = 0

  /**
   * Crawls the target's replies. Answers the crawl's last answer, or null when a later run or
   * reset() superseded this one, or a crawl of the same post is already followed and `force`
   * is not set.
   */
  async function run(target: RemoteRepliesTarget, options: { force?: boolean } = {}): Promise<RemoteRepliesResult | null> {
    if (activeApId.value === target.apId && !options.force) return null
    const mine = ++generation
    activeApId.value = target.apId
    view.value = { kind: 'fetching' }
    const answer = await followRepliesFetch(
      () => activityPubService.fetchRemoteReplies(target.apId, target.postId, { force: options.force }),
      () => activityPubService.getRemoteRepliesStatus(target.apId),
      { cancelled: () => mine !== generation },
    )
    if (mine !== generation || !answer) return null
    activeApId.value = null
    view.value = repliesFetchView(answer, target.repliesCount ?? 0)
    return answer
  }

  /** Drops the view and abandons a followed crawl; the crawl itself goes on server-side. */
  function reset(): void {
    generation++
    activeApId.value = null
    view.value = null
  }

  return { view, run, reset }
}
