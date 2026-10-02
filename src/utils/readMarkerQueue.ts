/**
 * Debounced read markers for the message list (MessageDisplay).
 *
 * Messages scrolled into view queue a read; only the newest per channel or
 * conversation is sent, `delayMs` after the last one queued. A read carries
 * its own target, so a queued read for one channel is sent as-is after the
 * view moves to another; queueing for a different target sends the pending
 * read first.
 */

export interface QueuedRead {
  messageId: string
  /** Message creation time, ms since epoch. */
  createdAt: number
  channelId: string | null
  conversationId: string | null
}

export interface ReadMarkerQueue {
  queue(read: QueuedRead): void
  /** Sends the pending read now. */
  flush(): Promise<void>
}

export function createReadMarkerQueue(
  send: (read: QueuedRead) => Promise<void>,
  delayMs = 500,
): ReadMarkerQueue {
  let pending: QueuedRead | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const read = pending
    pending = null
    return read ? send(read) : Promise.resolve()
  }

  const queue = (read: QueuedRead): void => {
    if (pending && (pending.channelId !== read.channelId || pending.conversationId !== read.conversationId)) {
      void flush()
    }
    if (!pending || read.createdAt > pending.createdAt) pending = read
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void flush() }, delayMs)
  }

  return { queue, flush }
}
