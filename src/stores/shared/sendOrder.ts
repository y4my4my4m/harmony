/**
 * One insert at a time per target (channel, conversation, thread), in the order the sends were
 * made.
 *
 * messages.created_at is the server clock when the insert arrives, and requests from a member
 * far from the server overtake each other (0.2-1.7 s each), so concurrent inserts are stored, and
 * shown to everyone else, out of typed order. Each insert of a target starts once the previous
 * one settled, success or failure. Optimistic rows are added before the wait and keep showing at
 * once; different targets do not wait on each other.
 *
 * A turn is taken at Enter, before parsing, so a message whose mentions take a lookup still
 * leaves before the one typed after it.
 */

/** Longest a turn holds its target: unused after being taken, or with its insert in flight, ms. */
export const SEND_TURN_HOLD_MS = 15_000

export interface SendTurn {
  /** Runs `insert` once every earlier turn of the target settled. A second call takes a new turn. */
  run<T>(insert: () => Promise<T>): Promise<T>
  /** Gives the turn up without an insert; later turns stop waiting for it. A no-op once run. */
  release(): void
}

const tails = new Map<string, Promise<void>>()

export const sendKeyForChannel = (channelId: string) => `channel:${channelId}`
export const sendKeyForConversation = (conversationId: string) => `dm:${conversationId}`
export const sendKeyForThread = (threadId: string) => `thread:${threadId}`

export function takeSendTurn(key: string): SendTurn {
  const previous = tails.get(key) ?? Promise.resolve()
  let settle!: () => void
  const settled = new Promise<void>((resolve) => { settle = resolve })
  const tail = previous.then(() => settled)
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })

  let used = false
  // A turn whose message never reaches its insert (a lookup that hangs) stops holding the target.
  const idle = setTimeout(() => turn.release(), SEND_TURN_HOLD_MS)

  const turn: SendTurn = {
    run<T>(insert: () => Promise<T>): Promise<T> {
      if (used) return inSendOrder(key, insert)
      used = true
      clearTimeout(idle)
      return previous.then(() => {
        // A request that never answers stops holding the target; later inserts go on.
        const hung = setTimeout(settle, SEND_TURN_HOLD_MS)
        return insert().finally(() => {
          clearTimeout(hung)
          settle()
        })
      })
    },
    release(): void {
      if (used) return
      used = true
      clearTimeout(idle)
      settle()
    },
  }
  return turn
}

/** Runs `insert` in a turn taken now. */
export function inSendOrder<T>(key: string, insert: () => Promise<T>): Promise<T> {
  return takeSendTurn(key).run(insert)
}

/** Test hook: forgets every target's queue. */
export function resetSendOrder(): void {
  tails.clear()
}
