/**
 * Reactive unread instance-announcement count.
 *
 * Shared across the Settings sidebar badge and the AnnouncementPopup
 * "View past announcements" link. The count is a module-level singleton so
 * multiple consumers see the same value, and refreshing it after a
 * mark-as-read (or after dismissing the popup) updates every consumer at
 * once.
 *
 * The composable is intentionally light:
 *   - `refresh()` re-queries the service (debounced via the in-flight flag).
 *   - `decrement(by)` lets callers optimistically subtract after they mark
 *     items as read locally, so the UI updates instantly without waiting on
 *     the round-trip.
 *   - `reset()` zeros the count (used when the popup's "mark all read"
 *     button fires, since we know the unread set is empty afterwards).
 *
 * No realtime subscription is wired up here - `instance_announcements` is
 * a low-volume admin surface and the existing popup-on-load + manual refresh
 * are enough. If we later want push-style updates we can plug them in here
 * without touching consumers.
 */

import { ref, readonly, onMounted, onBeforeUnmount } from 'vue'
import { announcementService } from '@/services/AnnouncementService'
import { debug } from '@/utils/debug'

const unreadCount = ref(0)
const hasLoaded = ref(false)
let inFlight = false

async function refresh(): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    unreadCount.value = await announcementService.getUnreadCount()
    hasLoaded.value = true
  } catch (err) {
    debug.warn('⚠️ useAnnouncementUnreadCount: refresh failed', err)
  } finally {
    inFlight = false
  }
}

function decrement(by = 1): void {
  unreadCount.value = Math.max(0, unreadCount.value - by)
}

function reset(): void {
  unreadCount.value = 0
  hasLoaded.value = true
}

/**
 * Use the reactive unread count in a component. Pass `autoRefresh: true` to
 * trigger a fetch on mount; otherwise the caller is responsible for calling
 * `refresh()` at the right time.
 */
export function useAnnouncementUnreadCount(options: { autoRefresh?: boolean } = {}) {
  const { autoRefresh = false } = options

  let mounted = false

  onMounted(() => {
    mounted = true
    if (autoRefresh) {
      void refresh()
    }
  })

  onBeforeUnmount(() => {
    mounted = false
  })

  return {
    unreadCount: readonly(unreadCount),
    hasLoaded: readonly(hasLoaded),
    refresh,
    decrement,
    reset,
    get isMounted() {
      return mounted
    },
  }
}
