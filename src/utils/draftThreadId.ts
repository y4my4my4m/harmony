const PREFIX = 'draft:'

/** Thread id the composer gets for a thread started from `parentMessageId` before its row exists. */
export function draftThreadId(parentMessageId: string): string {
  return PREFIX + parentMessageId
}

export function isDraftThreadId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(PREFIX)
}
