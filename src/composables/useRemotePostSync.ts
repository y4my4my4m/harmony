/**
 * useRemotePostSync - Background sync for remote post reactions/replies
 *
 * Manages fetching remote reactions/replies from origin instances.
 * Uses a module-level Set to deduplicate fetches across virtual scroller remounts.
 * Auto-syncs reactions once per session on mount; replies remain manual.
 */

import { ref, onMounted, type Ref } from 'vue'
import { debug } from '@/utils/debug'
import { activityPubService } from '@/services/activityPubService'
import { getOriginalApId, getOriginalPostId } from '@/utils/postReblog'
import type { TimelinePost } from '@/types'

export const fetchedReactionsThisSession = new Set<string>()

export function useRemotePostSync(
  post: Ref<TimelinePost> | (() => TimelinePost),
  options: {
    autoFetchReactions?: boolean
    isRemote: Ref<boolean> | (() => boolean)
    onReactionsUpdate?: (result: any) => void
    onRefresh?: (postId: string) => void
  }
) {
  const isFetchingReactions = ref(false)
  const isFetchingReplies = ref(false)

  const getPost = (): TimelinePost =>
    typeof post === 'function' ? post() : post.value

  const getIsRemote = (): boolean =>
    typeof options.isRemote === 'function' ? options.isRemote() : options.isRemote.value

  const fetchRemoteReactions = async () => {
    if (!getIsRemote() || isFetchingReactions.value) return

    const p = getPost()
    // Reactions/replies live on the original Note, not on the Announce wrapper.
    const apId = getOriginalApId(p)
    if (!apId) return

    isFetchingReactions.value = true
    try {
      const result = await activityPubService.fetchRemoteReactions(apId, getOriginalPostId(p))
      if (result) {
        debug.log(`Fetched ${result.count} reactions for remote post`)
        options.onReactionsUpdate?.(result)
        options.onRefresh?.(p.id)
      }
    } catch (error) {
      debug.error('Error fetching remote reactions:', error)
    } finally {
      isFetchingReactions.value = false
    }
  }

  const fetchRemoteReplies = async () => {
    if (!getIsRemote() || isFetchingReplies.value) return

    const p = getPost()
    const apId = getOriginalApId(p)
    if (!apId) return

    isFetchingReplies.value = true
    try {
      const result = await activityPubService.fetchRemoteReplies(apId, getOriginalPostId(p))
      if (result) {
        debug.log(`Fetched ${result.count} replies for remote post`)
        // The service may attach extra counters when the remote responds with
        // updated tallies; they aren't part of the strict return type, so cast.
        const r = result as any
        if (r.replies_count !== undefined || r.favorites_count !== undefined || r.reblogs_count !== undefined) {
          options.onReactionsUpdate?.(r)
        }
        options.onRefresh?.(p.id)
      }
    } catch (error) {
      debug.error('Error fetching remote replies:', error)
    } finally {
      isFetchingReplies.value = false
    }
  }

  if (options.autoFetchReactions !== false) {
    onMounted(() => {
      const p = getPost()
      if (getIsRemote() && !fetchedReactionsThisSession.has(p.id)) {
        fetchedReactionsThisSession.add(p.id)
        fetchRemoteReactions()
      }
    })
  }

  return {
    isFetchingReactions,
    isFetchingReplies,
    fetchRemoteReactions,
    fetchRemoteReplies,
  }
}
