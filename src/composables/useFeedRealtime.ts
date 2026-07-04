/**
 * useFeedRealtime
 *
 * View-bound realtime subscription for any timeline-like surface.
 *
 * Architecture:
 *   - 'home' is served by the per-user `user:{profile_id}` channel
 *     (see `broadcast_home_feed_entry` trigger + UserEventChannel handler
 *     in `useActivityPub.setupRealtimeSubscriptions`). The composable is a
 *     no-op for that kind.
 *   - All other kinds map to a single ephemeral broadcast topic that the
 *     DB trigger `broadcast_post_event` publishes to on every post
 *     create / update / delete. Subscriptions are torn down on kind
 *     change or component unmount so cost is O(active viewers) per post.
 *
 * Receive routing:
 *   - By default, events route into the central `useActivityPub` store
 *     handlers (`handleRealtimePostCreate/Update/Delete`) which update
 *     `homeFeed` / `publicFeed` / `localFeed` - the right default for views
 *     that consume those store feeds directly.
 *   - Views that maintain their OWN posts array (UserProfileView,
 *     HashtagView) pass an `options` object with custom handlers so they
 *     can mutate their local state. The store handlers are NOT called
 *     in that case (the view owns its data).
 *
 * Adding a new feed kind is one line in `topicFor` + extending `FeedKind`.
 * No new transport, no new dispatch shape.
 */

import { watch, onUnmounted, type Ref } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { useActivityPubStore } from '@/stores/useActivityPub'

export type FeedKind =
  | 'home'
  | 'public'
  | 'local'
  | `user:${string}`
  | `hashtag:${string}`

/**
 * Normalised event shape forwarded to view handlers. Matches the column
 * subset the DB trigger emits and the store handlers consume.
 */
export interface FeedPostEvent {
  id: string
  author_id: string
  visibility: string
  is_local: boolean
  ap_type?: string
  is_deleted?: boolean
}

export interface FeedRealtimeHandlers {
  onCreate?: (post: FeedPostEvent) => void | Promise<void>
  onUpdate?: (post: FeedPostEvent) => void
  onDelete?: (post: FeedPostEvent) => void
}

/**
 * Map a feed kind to its broadcast topic. Returns `null` for kinds that
 * are already covered by another subscription (currently only 'home',
 * served by the per-user `user:{id}` channel).
 */
function topicFor(kind: FeedKind): string | null {
  if (kind === 'home') return null
  if (kind === 'public') return 'feed:public'
  if (kind === 'local') return 'feed:local'
  if (kind.startsWith('user:') || kind.startsWith('hashtag:')) {
    return `feed:${kind}`
  }
  return null
}

export function useFeedRealtime(
  feedKind: Ref<FeedKind>,
  handlers: FeedRealtimeHandlers = {}
) {
  const activityPubStore = useActivityPubStore()
  let unsubscribe: (() => void) | null = null

  const dispatch = (data: any) => {
    if (!data?.type || !data?.post_id) return

    const post: FeedPostEvent = {
      id: data.post_id,
      author_id: data.author_id,
      visibility: data.visibility,
      is_local: data.is_local,
      ap_type: data.ap_type,
      is_deleted: data.is_deleted,
    }

    // If the caller passed custom handlers, route to those exclusively -
    // they own their local state. Otherwise fall back to the store
    // handlers (default for views that consume the store feeds).
    const useCustom = !!(handlers.onCreate || handlers.onUpdate || handlers.onDelete)

    switch (data.type) {
      case 'post:new':
        if (useCustom) {
          if (handlers.onCreate) void handlers.onCreate(post)
        } else {
          void activityPubStore.handleRealtimePostCreate(post)
        }
        break
      case 'post:updated':
        if (useCustom) {
          handlers.onUpdate?.(post)
        } else {
          activityPubStore.handleRealtimePostUpdate(post)
        }
        break
      case 'post:deleted':
        if (useCustom) {
          handlers.onDelete?.(post)
        } else {
          activityPubStore.handleRealtimePostDelete(post)
        }
        break
      default:
        debug.log(`useFeedRealtime: unknown feed_event type "${data.type}"`)
    }
  }

  const subscribe = (kind: FeedKind) => {
    unsubscribe?.()
    unsubscribe = null

    const topic = topicFor(kind)
    if (!topic) return

    const channel = supabase
      .channel(topic, { config: { private: true } })
      .on('broadcast', { event: 'feed_event' }, (raw: any) => {
        const data = raw?.payload?.payload ?? raw?.payload ?? raw
        dispatch(data)
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
