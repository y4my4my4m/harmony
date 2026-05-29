import { ref } from 'vue'
import type { Message, UnreadCount } from '@/types'

/**
 * useReadDivider
 *
 * Drives the Discord-style "New messages" divider for a single message list
 * (a channel or a DM conversation). The divider is intentionally *frozen* at
 * open time so it never moves or disappears while the user is reading:
 *
 *   1. `captureBoundary()` is called the instant a context is opened, BEFORE
 *      that context gets marked read. It snapshots the read boundary
 *      (`last_read_message_id` / `last_read_at`) from the in-memory unread row.
 *   2. Once the context's messages are present, `resolveDivider()` pins the
 *      divider above the first *unread* message that wasn't authored by the
 *      current user.
 *   3. The divider is retired (via `clear()`) the moment the user demonstrably
 *      catches up - they send a message in the context, or they scroll to the
 *      bottom and have seen the new messages. It is also re-captured + re-
 *      resolved on every re-open. Because the boundary is recomputed from the
 *      authoritative unread row every time, it can never get "stuck": if the
 *      row says nothing is unread, no divider is shown.
 *
 * There is no user-removable state and nothing persisted, so the divider
 * cannot end up orphaned.
 */
export function useReadDivider() {
  /** Id of the message the divider should render directly above (or null). */
  const dividerBeforeMessageId = ref<string | null>(null)

  /** Frozen read boundary captured at open, before the context is marked read. */
  let boundary: { lastReadAt: string | null; lastReadId: string | null } | null = null

  const toMillis = (value: Date | string | undefined | null): number => {
    if (!value) return NaN
    return value instanceof Date ? value.getTime() : new Date(value).getTime()
  }

  /**
   * Snapshot the read boundary for the context being opened. Pass the in-memory
   * unread row (or null). No divider is shown when there are no unread messages.
   * Must run BEFORE the open marks the context read so we read the pre-open value.
   */
  function captureBoundary(unread: UnreadCount | null): void {
    dividerBeforeMessageId.value = null
    if (unread && unread.unread_messages > 0) {
      boundary = {
        lastReadAt: unread.last_read_at ?? null,
        lastReadId: unread.last_read_message_id ?? null,
      }
    } else {
      boundary = null
    }
  }

  /**
   * With the context's messages loaded (ascending by `created_at`), resolve the
   * first unread message not authored by the current user and pin the divider
   * above it. Returns that message id, or null when there's nothing to mark.
   */
  function resolveDivider(messages: Message[], currentUserId?: string | null): string | null {
    if (!boundary || messages.length === 0) {
      dividerBeforeMessageId.value = null
      return null
    }

    // Find where the read boundary sits in the loaded set. Prefer the exact
    // message id (precise); fall back to the timestamp when that message isn't
    // loaded (e.g. it scrolled out of the fetched window).
    let startIdx = -1
    if (boundary.lastReadId) {
      const idx = messages.findIndex(m => m.id === boundary!.lastReadId)
      if (idx >= 0) startIdx = idx + 1
    }
    if (startIdx < 0 && boundary.lastReadAt) {
      const t = toMillis(boundary.lastReadAt)
      if (!Number.isNaN(t)) {
        startIdx = messages.findIndex(m => toMillis(m.created_at) > t)
      }
    }
    if (startIdx < 0) {
      dividerBeforeMessageId.value = null
      return null
    }

    // First unread message authored by someone else (own messages never count
    // toward your own unread, so the divider should skip them).
    for (let i = startIdx; i < messages.length; i++) {
      if (messages[i].user_id !== currentUserId) {
        dividerBeforeMessageId.value = messages[i].id
        return messages[i].id
      }
    }
    dividerBeforeMessageId.value = null
    return null
  }

  function clear(): void {
    boundary = null
    dividerBeforeMessageId.value = null
  }

  return { dividerBeforeMessageId, captureBoundary, resolveDivider, clear }
}
