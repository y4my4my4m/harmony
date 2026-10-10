/**
 * useRemotePostSync - Background sync for remote post reactions/replies
 *
 * Manages fetching remote reactions/replies from origin instances.
 * Uses a module-level Set to deduplicate fetches across virtual scroller remounts.
 * Syncs reactions once per session on mount, through /fetch-reactions-batch; replies are
 * fetched on request only.
 */

import { ref, onMounted, type Ref } from 'vue'
import { debug } from '@/utils/debug'
import { activityPubService, type RemoteRepliesResult } from '@/services/activityPubService'
import { getOriginalApId, getOriginalPostId } from '@/utils/postReblog'
import { followRepliesFetch } from '@/utils/remoteReplies'
import type { TimelinePost } from '@/types'

export const fetchedReactionsThisSession = new Set<string>()

/** Mounts within this window share one request. */
const REACTION_BATCH_DELAY_MS = 300
/** MAX_BATCH of the federation backend's /fetch-reactions-batch. */
const REACTION_BATCH_SIZE = 30

type ReactionListener = (result: any) => void
const queuedReactionSyncs = new Map<string, { postId: string; listeners: ReactionListener[] }>()
let reactionFlushTimer: ReturnType<typeof setTimeout> | null = null

function queueReactionSync(apId: string, postId: string, listener: ReactionListener): void {
  const queued = queuedReactionSyncs.get(apId)
  if (queued) queued.listeners.push(listener)
  else queuedReactionSyncs.set(apId, { postId, listeners: [listener] })
  reactionFlushTimer ??= setTimeout(() => { void flushReactionSyncs() }, REACTION_BATCH_DELAY_MS)
}

/** Sends the queued reaction syncs, REACTION_BATCH_SIZE posts per request. */
export async function flushReactionSyncs(): Promise<void> {
  if (reactionFlushTimer) clearTimeout(reactionFlushTimer)
  reactionFlushTimer = null
  const entries = [...queuedReactionSyncs.entries()]
  queuedReactionSyncs.clear()
  for (let i = 0; i < entries.length; i += REACTION_BATCH_SIZE) {
    const chunk = entries.slice(i, i + REACTION_BATCH_SIZE)
    const results = await activityPubService.fetchRemoteReactionsBatch(
      chunk.map(([apId, queued]) => ({ post_ap_id: apId, post_id: queued.postId })),
    )
    if (!results) continue
    for (const [apId, queued] of chunk) {
      const result = results[apId]
      if (!result?.success) continue
      for (const listener of queued.listeners) {
        try {
          listener(result)
        } catch (error) {
          debug.error('Error applying remote reactions:', error)
        }
      }
    }
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

  /**
   * Crawls the post's replies and follows the crawl to its end. Null when the post is local
   * or a fetch is already running.
   */
  const fetchRemoteReplies = async (fetchOptions: { force?: boolean } = {}): Promise<RemoteRepliesResult | null> => {
    if (!getIsRemote() || isFetchingReplies.value) return null

    const p = getPost()
    const apId = getOriginalApId(p)
    if (!apId) return null

    isFetchingReplies.value = true
    try {
      const result = await followRepliesFetch(
        () => activityPubService.fetchRemoteReplies(apId, getOriginalPostId(p), fetchOptions),
        () => activityPubService.getRemoteRepliesStatus(apId),
      )
      if (result?.success) {
        debug.log(`Reply crawl of remote post: ${result.status}`)
        if (result.replies_count !== undefined || result.favorites_count !== undefined || result.reblogs_count !== undefined) {
          options.onReactionsUpdate?.(result)
        }
        options.onRefresh?.(p.id)
      }
      return result
    } finally {
      isFetchingReplies.value = false
    }
  }

  if (options.autoFetchReactions !== false) {
    onMounted(() => {
      const p = getPost()
      if (!getIsRemote() || fetchedReactionsThisSession.has(p.id)) return
      const apId = getOriginalApId(p)
      if (!apId) return
      fetchedReactionsThisSession.add(p.id)
      queueReactionSync(apId, getOriginalPostId(p), (result) => {
        options.onReactionsUpdate?.(result)
        options.onRefresh?.(p.id)
      })
    })
  }

  return {
    isFetchingReactions,
    isFetchingReplies,
    fetchRemoteReactions,
    fetchRemoteReplies,
  }
}
