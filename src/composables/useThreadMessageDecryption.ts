import { onScopeDispose, type Ref } from 'vue'
import type { Message } from '@/types'
import { threadService } from '@/services/ThreadService'

interface ShownThread {
  id: string
  channel_id?: string
  parent_message?: Message | null
}

/** Ciphertext no key has opened yet. */
const sealed = (m: Message | null | undefined): m is Message =>
  !!m && !!m.encrypted && !m.decrypted && !!m.encryption_metadata

/**
 * Decryption for a thread view's own list, which the channel store's lifecycle does not reach.
 * History, older pages, the parent and the sender's own replies come readable from ThreadService.
 * Here: realtime rows are decrypted before they land, as the channel store does, and rows still
 * sealed are decrypted again when a key for the parent channel arrives (megolm-key-received).
 */
export function useThreadMessageDecryption(
  messages: Ref<Message[]>,
  thread: () => ShownThread | null | undefined,
) {
  let disposed = false
  /** Newest realtime UPDATE per message id, numbered across the view; older answers are dropped. */
  const updates = new Map<string, number>()
  let updateCount = 0

  /** A realtime row, readable; null when the view moved to another thread meanwhile. */
  const readableArrival = async (row: Message): Promise<Message | null> => {
    const id = thread()?.id
    const [readable] = await threadService.readableMessages([row])
    return disposed || thread()?.id !== id ? null : readable
  }

  /**
   * The content fields of a realtime UPDATE, readable. Null when the view moved to another
   * thread or a newer UPDATE of the row arrived meanwhile.
   */
  const readableUpdate = async (payloadNew: any): Promise<Partial<Message> | null> => {
    const id = thread()?.id
    const seq = ++updateCount
    updates.set(payloadNew.id, seq)
    const row = {
      id: payloadNew.id,
      channel_id: payloadNew.channel_id,
      created_at: payloadNew.created_at,
      is_pinned: payloadNew.is_pinned,
      content: payloadNew.content,
      encrypted: payloadNew.encrypted || false,
      encryption_metadata: payloadNew.encryption_metadata || null,
    } as Message
    const [readable] = await threadService.readableMessages([row])
    if (updates.get(payloadNew.id) !== seq) return null
    updates.delete(payloadNew.id)
    if (disposed || thread()?.id !== id) return null
    return {
      content: readable.content,
      encrypted: readable.encrypted,
      decrypted: readable.decrypted ?? false,
      sender_verified: readable.sender_verified,
      decryption_unrecoverable: readable.decryption_unrecoverable,
      decryption_error: readable.decryption_error,
      decryption_replayed: readable.decryption_replayed,
      encryption_metadata: row.encryption_metadata,
    }
  }

  const retry = async () => {
    const shown = thread()
    if (!shown?.id) return
    const rows = messages.value.filter(sealed)
    const parent = sealed(shown.parent_message) ? shown.parent_message : null
    if (!rows.length && !parent) return

    const results = await threadService.readableMessages(parent ? [...rows, parent] : rows)
    if (disposed || thread()?.id !== shown.id) return
    results.forEach((result, index) => {
      const original = index < rows.length ? rows[index] : parent!
      // Unchanged failures are left in place; a failure that became unrecoverable or changed kind is shown so.
      if (
        !result.decrypted
        && result.decryption_unrecoverable === original.decryption_unrecoverable
        && result.decryption_error === original.decryption_error
      ) return
      if (original === parent) {
        if (shown.parent_message === parent) shown.parent_message = result
        return
      }
      // A send, edit, delete or refresh may have replaced the row while keys were loading.
      const at = messages.value.indexOf(original)
      if (at === -1) return
      messages.value[at] = result
      threadService.updateMessageInCache(shown.id, result.id, result)
    })
  }

  let running: Promise<void> | null = null
  let again = false
  const onKey = (event: Event) => {
    const room = (event as CustomEvent).detail?.roomId
    const channelId = thread()?.channel_id
    if (room && room !== '*' && channelId && room !== channelId) return
    // Keys arriving during a pass get one more pass after it.
    if (running) {
      again = true
      return
    }
    running = (async () => {
      do {
        again = false
        await retry()
      } while (again && !disposed)
    })()
      .catch(() => {})
      .finally(() => {
        running = null
      })
  }

  window.addEventListener('megolm-key-received', onKey)
  onScopeDispose(() => {
    disposed = true
    window.removeEventListener('megolm-key-received', onKey)
  })

  return { readableArrival, readableUpdate }
}
