/**
 * Envelope adapter for message realtime.
 *
 * Messages arrive over two transports during the Broadcast rollout:
 * postgres_changes delivers `{ new, old }`, and `broadcast_message_event()`
 * mirrors that shape with an added `op`. Both feed the same store handlers, so
 * the only difference is unwrapping.
 *
 * Deduplication is the handlers' job: they key on message id, so a message
 * delivered over both transports is applied once.
 */

export interface MessageEventHandlers {
  onInsert: (payload: { new: any }) => void | Promise<void>
  onUpdate: (payload: { new: any; old: any }) => void | Promise<void>
  onDelete: (payload: { old: any }) => void | Promise<void>
}

export interface BroadcastMessageEvent {
  op?: 'INSERT' | 'UPDATE' | 'DELETE' | string
  new?: any
  old?: any
}

/** Routes a broadcast_message_event payload to the matching CDC handler. */
export function routeMessageEvent(
  payload: BroadcastMessageEvent | null | undefined,
  handlers: MessageEventHandlers,
): void {
  const op = payload?.op
  if (!op) return

  if (op === 'INSERT') {
    if (payload?.new) void handlers.onInsert({ new: payload.new })
    return
  }
  if (op === 'UPDATE') {
    if (payload?.new) void handlers.onUpdate({ new: payload.new, old: payload.old ?? null })
    return
  }
  if (op === 'DELETE') {
    if (payload?.old) void handlers.onDelete({ old: payload.old })
  }
}
