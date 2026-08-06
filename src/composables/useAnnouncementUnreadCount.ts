/**
 * Reactive unread instance-announcement count.
 *
 * Module-level singleton: the Settings sidebar badge and the AnnouncementPopup
 * share one count, so a refresh after mark-as-read updates both.
 *
 * - `refresh()` re-queries the service; concurrent calls collapse via the
 *   in-flight flag.
 * - `decrement(by)` subtracts optimistically for callers that marked items
 *   read locally.
 * - `reset()` zeros the count after "mark all read".
 *
 * No realtime subscription: `instance_announcements` is low-volume, and
 * popup-on-load plus manual refresh cover it.
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
    debug.warn('useAnnouncementUnreadCount: refresh failed', err)
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
 * `autoRefresh` fetches on mount; otherwise the caller drives `refresh()`.
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
