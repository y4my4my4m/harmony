/**
 * useFeedRealtime
 *
 * View-bound realtime subscription for the public / local timeline tabs.
 *
 * Architecture:
 *   - 'home' is already covered by the per-user `user:{profile_id}` channel
 *     (see `broadcast_home_feed_entry` trigger + UserEventChannel handler in
 *     `useActivityPub.setupRealtimeSubscriptions`). This composable is a
 *     no-op for that kind.
 *   - 'public' / 'local' subscribe to ephemeral broadcast topics
 *     (`feed:public`, `feed:local`) which the DB trigger `broadcast_post_event`
 *     publishes to on every new public post (and additionally `feed:local`
 *     when the post is local). Subscriptions are torn down on tab switch /
 *     component unmount so cost is O(active viewers), not O(connected users).
 *
 * The receive handler is the SAME `handleRealtimePostCreate` used by the
 * home/user path — it already dedupes via `_inFlightPostIds` + per-feed
 * `existsIn{Public,Local,Home}` checks, so the same post arriving via both
 * the author's user channel AND `feed:public` is safe.
 *
 * Adding a new feed kind (e.g. hashtag, profile timeline) requires only:
 *   1. extending the `FeedKind` union;
 *   2. adding a case to `topicFor()`;
 *   3. having the DB trigger publish to that topic.
 * No new channel infrastructure, no new handler.
 */

import { watch, onUnmounted, type Ref } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { useActivityPubStore } from '@/stores/useActivityPub'

export type FeedKind = 'home' | 'public' | 'local'

/**
 * Map a feed kind to its broadcast topic. Returns `null` for kinds that
 * are already covered by another subscription (currently only 'home',
 * served by the per-user `user:{id}` channel).
 */
function topicFor(kind: FeedKind): string | null {
  switch (kind) {
    case 'home':
      return null
    case 'public':
      return 'feed:public'
    case 'local':
      return 'feed:local'
    default:
      return null
  }
}

export function useFeedRealtime(feedKind: Ref<FeedKind>) {
  const activityPubStore = useActivityPubStore()
  let unsubscribe: (() => void) | null = null

  const subscribe = (kind: FeedKind) => {
    unsubscribe?.()
    unsubscribe = null

    const topic = topicFor(kind)
    if (!topic) return

    const channel = supabase
      .channel(topic, { config: { private: true } })
      .on('broadcast', { event: 'feed_event' }, (raw: any) => {
        // Supabase Realtime nests the user payload one level deep.
        const data = raw?.payload?.payload ?? raw?.payload ?? raw
        if (!data || data.type !== 'post:new' || !data.post_id) return

        void activityPubStore.handleRealtimePostCreate({
          id: data.post_id,
          author_id: data.author_id,
          visibility: data.visibility,
          is_local: data.is_local,
          ap_type: data.ap_type,
        })
      })
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') {
          debug.log(`✅ FeedRealtime subscribed: ${topic}`)
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          debug.warn(`⚠️ FeedRealtime ${status}: ${topic}`)
        }
      })

    unsubscribe = () => {
      supabase.removeChannel(channel)
    }
  }

  watch(feedKind, (kind) => subscribe(kind), { immediate: true })

  onUnmounted(() => {
    unsubscribe?.()
    unsubscribe = null
  })
}

export const __test__ = { topicFor }
