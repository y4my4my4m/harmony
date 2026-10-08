/**
 * Marks servers read. mark_server_as_read clears the read markers and the
 * server's notifications in the database; the local unread rows and loaded
 * notifications follow on success.
 */

import { markServerRead } from '@/services/readState'
import { clearServerUnread } from '@/composables/useUnreadCounts'
import { useNotificationStore } from '@/stores/useNotification'
import { debug } from '@/utils/debug'

/** Resolves to the ids that were marked; failures are logged and left unread. */
export async function markServersRead(serverIds: readonly string[]): Promise<string[]> {
  if (serverIds.length === 0) return []
  const results = await Promise.allSettled(serverIds.map(id => markServerRead(id)))
  const done: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') done.push(serverIds[i])
    else debug.error('Failed to mark server read:', serverIds[i], r.reason)
  })
  if (done.length === 0) return done

  clearServerUnread(done)

  const ids = new Set(done)
  const notifications = useNotificationStore()
  let changed = false
  for (const n of notifications.notifications) {
    if (n.is_read) continue
    const d: any = n.data || {}
    const sid = d.server_id ?? d.location?.server_id
    if (sid && ids.has(sid)) {
      n.is_read = true
      changed = true
    }
  }
  if (changed) notifications.updateUnreadCount()
  return done
}
