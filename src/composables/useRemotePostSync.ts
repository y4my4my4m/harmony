/**
 * useRemotePostSync - Background sync for remote post reactions/replies
 *
 * Manages fetching remote reactions/replies from origin instances.
 * Uses a module-level Set to deduplicate fetches across virtual scroller remounts.
 * Auto-syncs reactions once per session on mount; replies remain manual.
 */

import { ref, onMounted, type Ref } from 'vue'
import { debug } from '@/utils/debug'
import type { TimelinePost } from '@/types'

export const fetchedReactionsThisSession = new Set<string>()

async function getFederationApiUrl(): Promise<string> {
  try {
    const { useActivityPubStore } = await import('@/stores/useActivityPub')
    return useActivityPubStore().federationApiUrl
  } catch {
    return '/api/federation'
  }
}

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
    const postApId = p.ap_id
    if (!postApId) return

    isFetchingReactions.value = true

    try {
      const apiUrl = await getFederationApiUrl()
      const response = await fetch(`${apiUrl}/fetch-reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_ap_id: postApId,
          post_id: p.id,
        }),
      })

      if (response.ok) {
        const result = await response.json()
        debug.log(`📬 Fetched ${result.count} reactions for remote post`)
        options.onReactionsUpdate?.(result)
        options.onRefresh?.(p.id)
      } else {
        debug.error('Failed to fetch remote reactions:', await response.text())
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
    const postApId = p.ap_id
    if (!postApId) return

    isFetchingReplies.value = true

    try {
      const apiUrl = await getFederationApiUrl()
      const response = await fetch(`${apiUrl}/fetch-replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_ap_id: postApId,
          post_id: p.id,
        }),
      })

      if (response.ok) {
        const result = await response.json()
        debug.log(`📬 Fetched ${result.count} replies for remote post`)
        options.onRefresh?.(p.id)
      } else {
        debug.error('Failed to fetch remote replies:', await response.text())
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
