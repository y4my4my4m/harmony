// The direct conversation an account last opened, per account and device. The Direct
// messages button returns to it, as Discord's Home button returns to the last private
// channel viewed; the newest incoming message does not move it.

const key = (profileId: string) => `harmony:last-dm:${profileId}`

export function rememberLastDm(profileId: string | null | undefined, conversationId: string): void {
  if (!profileId) return
  try { localStorage.setItem(key(profileId), conversationId) } catch { /* private mode */ }
}

export function lastDm(profileId: string | null | undefined): string | null {
  if (!profileId) return null
  try { return localStorage.getItem(key(profileId)) } catch { return null }
}

export function forgetLastDm(profileId: string | null | undefined): void {
  if (!profileId) return
  try { localStorage.removeItem(key(profileId)) } catch { /* private mode */ }
}

export interface DmButtonTarget {
  /** The current route is a DM route (the list or a conversation). */
  inDms: boolean
  /** Phone layout: the DM list is the DM page. */
  mobile: boolean
  last: string | null
  /** Conversation ids in the loaded list; null before the list loads. */
  known: string[] | null
}

/**
 * Where the Direct messages button goes. Already in DMs: the list. On a phone: the list.
 * Otherwise the last opened conversation, unless the loaded list no longer holds it (left
 * or hidden), then the list.
 */
export function dmButtonTarget(t: DmButtonTarget): { conversationId: string } | 'list' {
  if (t.inDms || t.mobile || !t.last) return 'list'
  if (t.known && !t.known.includes(t.last)) return 'list'
  return { conversationId: t.last }
}
