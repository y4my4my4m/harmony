/**
 * Message inserts that get no answer.
 *
 * An insert unanswered after SEND_STALL_MS fails its row, which then offers Retry and Delete.
 * The request is not cancelled: the server may still store the message. Rows are keyed by
 * their temp- id, which the store's Retry and the outbox's re-send keep.
 *
 * Once an insert of a row has stalled, the first message stored for the row is the row's
 * message. Any other message stored for it is unwanted and is deleted by the caller: the
 * stalled insert landing after a Retry stored the message, or landing after the row was
 * deleted. A re-send of such a row first looks the message up by its client_nonce, which
 * finds an insert that was stored while its answer was lost.
 */
import { SEND_TURN_HOLD_MS } from '@/stores/shared/sendOrder'

/** Longest an insert or a lookup goes unanswered before its row fails, ms; a send turn's hold. */
export const SEND_STALL_MS = SEND_TURN_HOLD_MS

export class SendStalledError extends Error {
  readonly code = 'SEND_STALLED'

  constructor() {
    super('The send got no answer')
    this.name = 'SendStalledError'
  }
}

export function isSendStalled(error: unknown): error is SendStalledError {
  return error instanceof SendStalledError
}

/** The lookup before a re-send failed; whether the row's message is stored is unknown. */
export class SendLookupFailedError extends Error {
  readonly code = 'SEND_LOOKUP_FAILED'

  constructor(readonly lookupError: unknown) {
    super(`Looking up the sent message failed: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`)
    this.name = 'SendLookupFailedError'
  }
}

/** The row's message may be stored: the row fails, offers Retry and Delete, and is not sent again on its own. */
export function isSendUnresolved(error: unknown): error is SendStalledError | SendLookupFailedError {
  return error instanceof SendStalledError || error instanceof SendLookupFailedError
}

interface StalledRow {
  /** Id of the first message stored for the row. */
  storedId: string | null
  /** The row was deleted while no message of it was stored. */
  discarded: boolean
}

const stalled = new Map<string, StalledRow>()
const storedListeners = new Set<(rowId: string) => void>()

export interface StalledSendHandlers<T extends { id: string }> {
  /** The row's message, stored after its insert stalled and the row failed. */
  landed: (message: T) => void
  /** A message stored for the row that the row does not keep. */
  unwanted: (message: T) => void
}

/** True for the row's message; false for a second one, or one stored after the row was deleted. */
function keep(rowId: string, messageId: string): boolean {
  const row = stalled.get(rowId)
  if (!row) return true
  if (row.discarded) return false
  if (row.storedId === null) row.storedId = messageId
  return row.storedId === messageId
}

/**
 * Settles as `insert` does, or rejects with SendStalledError after `ms`. The insert runs on
 * past the deadline; the message it stores then goes to `handlers.landed`, or to
 * `handlers.unwanted` when the row already has its message or was deleted. An answer in time
 * that the row does not keep goes to `handlers.unwanted` as well, and is still returned.
 */
export function insertWithDeadline<T extends { id: string }>(
  rowId: string,
  insert: Promise<T>,
  handlers: StalledSendHandlers<T>,
  ms: number = SEND_STALL_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let late = false
    const timer = setTimeout(() => {
      late = true
      if (!stalled.has(rowId)) stalled.set(rowId, { storedId: null, discarded: false })
      reject(new SendStalledError())
    }, ms)
    insert.then(
      (message) => {
        const kept = keep(rowId, message.id)
        if (!late) {
          clearTimeout(timer)
          if (!kept) handlers.unwanted(message)
          resolve(message)
          return
        }
        if (!kept) {
          handlers.unwanted(message)
          return
        }
        handlers.landed(message)
        for (const listener of storedListeners) listener(rowId)
      },
      (error: unknown) => {
        if (late) return
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * The message stored for a row whose earlier insert stalled, looked up before the row is sent
 * again; null when the row never stalled or nothing is stored. Rejects with SendStalledError
 * when the lookup itself gets no answer, and with SendLookupFailedError when it fails.
 */
export async function findStalledRowMessage<T extends { id: string }>(
  rowId: string,
  lookup: () => Promise<T | null>,
  ms: number = SEND_STALL_MS,
): Promise<T | null> {
  if (!stalled.has(rowId)) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SendStalledError()), ms)
  })
  try {
    const found = await Promise.race([lookup(), deadline])
    if (found) keep(rowId, found.id)
    return found
  } catch (error) {
    if (isSendStalled(error)) throw error
    throw new SendLookupFailedError(error)
  } finally {
    clearTimeout(timer)
  }
}

/** Sends a row: the message stored for it meanwhile when an earlier insert stalled, else what `insert` stores. */
export async function resendRow<T extends { id: string }>(
  rowId: string,
  lookup: () => Promise<T | null>,
  insert: () => Promise<T>,
): Promise<T> {
  return (await findStalledRowMessage(rowId, lookup)) ?? insert()
}

/** The user deleted the failed row: a message of it stored later is unwanted. */
export function discardStalledRow(rowId: string): void {
  const row = stalled.get(rowId)
  if (row && row.storedId === null) row.discarded = true
}

/** Calls `listener` with the row id whenever a stalled insert lands as its row's message. */
export function onStalledRowStored(listener: (rowId: string) => void): () => void {
  storedListeners.add(listener)
  return () => storedListeners.delete(listener)
}

/** Test hook: forgets every row. */
export function resetStalledSends(): void {
  stalled.clear()
  storedListeners.clear()
}
