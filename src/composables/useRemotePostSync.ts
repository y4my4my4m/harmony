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
    if (!p.ap_id) return

    isFetchingReactions.value = true
    try {
      const result = await activityPubService.fetchRemoteReactions(p.ap_id, p.id)
      if (result) {
        debug.log(`📬 Fetched ${result.count} reactions for remote post`)
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
    if (!p.ap_id) return

    isFetchingReplies.value = true
    try {
      const result = await activityPubService.fetchRemoteReplies(p.ap_id, p.id)
      if (result) {
        debug.log(`📬 Fetched ${result.count} replies for remote post`)
        if (result.replies_count !== undefined || result.favorites_count !== undefined || result.reblogs_count !== undefined) {
          options.onReactionsUpdate?.(result)
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
