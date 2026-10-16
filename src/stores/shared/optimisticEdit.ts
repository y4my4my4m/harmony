/**
 * A saved edit shows at once, as in Discord: every copy of the message takes the new content,
 * a fresh updated_at (the "edited" mark) and `edit_pending`. The stored row's fields replace
 * them when the server answers; a refusal restores what the server last confirmed and
 * rethrows, so the caller can give the text back to the user.
 *
 * Edits of one message are saved one at a time, in the order they were made (sendOrder.ts), so
 * the server ends with the newest. The answer to an edit older than the newest local one
 * leaves the screen alone.
 *
 * An encrypted row comes back as ciphertext; its copies keep the plaintext the user wrote,
 * marked decrypted, as a sent message does.
 */
import type { Message, MessagePart } from '@/types'
import { inSendOrder } from '@/stores/shared/sendOrder'

type Shown = Pick<Message, 'content' | 'updated_at' | 'encrypted' | 'encryption_metadata' | 'decrypted' | 'metadata'>

/** Newest local edit number per message. */
const latest = new Map<string, number>()
/** What the server holds while edits of the message are in flight. */
const confirmed = new Map<string, Shown>()

const shownFields = (m: Message): Shown => ({
  content: m.content,
  updated_at: m.updated_at,
  encrypted: m.encrypted,
  encryption_metadata: m.encryption_metadata,
  decrypted: m.decrypted,
  metadata: m.metadata,
})

export interface OptimisticEditParams {
  /** A current copy of the message. */
  message: Message
  content: MessagePart[]
  /** Writes fields into every copy of the message. */
  patch: (fields: Partial<Message>) => void
  /** The request; resolves to the stored row. */
  save: () => Promise<Message>
}

/** Resolves to the stored row, or null when a newer local edit superseded this one. */
export async function saveEditOptimistically({ message, content, patch, save }: OptimisticEditParams): Promise<Message | null> {
  const id = message.id
  const seq = (latest.get(id) ?? 0) + 1
  latest.set(id, seq)
  if (!confirmed.has(id)) confirmed.set(id, shownFields(message))
  patch({ content, updated_at: new Date(), edit_pending: true })

  try {
    const stored = await inSendOrder(`edit:${id}`, save)
    const ownCiphertext = !!stored.encrypted
    const fields: Shown = {
      content: ownCiphertext ? content : stored.content,
      updated_at: stored.updated_at ? new Date(stored.updated_at) : new Date(),
      encrypted: stored.encrypted ?? false,
      encryption_metadata: stored.encryption_metadata,
      decrypted: ownCiphertext ? true : stored.decrypted,
      metadata: stored.metadata ?? message.metadata,
    }
    if (latest.get(id) === seq) {
      confirmed.delete(id)
      patch({ ...fields, edit_pending: false })
    } else {
      confirmed.set(id, fields)
    }
    return latest.get(id) === seq ? stored : null
  } catch (error) {
    if (latest.get(id) === seq) {
      const previous = confirmed.get(id)
      confirmed.delete(id)
      if (previous) patch({ ...previous, edit_pending: false })
    }
    throw error
  }
}

/**
 * A realtime row for a message whose local edit is still being saved keeps the edit on screen;
 * the edit's own answer settles the fields.
 */
export function keepPendingEdit(local: Message | undefined, incoming: Message): Message {
  if (!local?.edit_pending) return incoming
  return { ...incoming, ...shownFields(local), metadata: incoming.metadata, edit_pending: true }
}

/** Test hook. */
export function resetOptimisticEdits(): void {
  latest.clear()
  confirmed.clear()
}
