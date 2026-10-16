/**
 * conversation_encryption_settings.encryption_enabled per DM conversation, shared by the send
 * path, the chat header and the conversation header.
 *
 * Unlike a channel, a conversation has no database refusal of plaintext and no event for a
 * participant's toggle, so an answer is trusted for FRESH_MS after its read. The composer
 * refreshes an entry past half that age while the user types; a send that finds it stale reads
 * again before the insert. This client's own toggle ('dm-encryption-toggled') writes the entry.
 *
 * A failed read answers with the previous entry, else "not encrypted" as the uncached read
 * did, and is not kept.
 */
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

/** How long a read answers for a send, ms. */
export const CONVERSATION_ENCRYPTION_FRESH_MS = 60_000

interface Entry {
  enabled: boolean
  at: number
}

const entries = new Map<string, Entry>()
const reads = new Map<string, Promise<boolean>>()

/** A read still running when its entry is dropped does not write it back. */
function read(conversationId: string): Promise<boolean> {
  const running = reads.get(conversationId)
  if (running) return running
  const request = (async () => {
    const { data, error } = await supabase
      .from('conversation_encryption_settings')
      .select('encryption_enabled')
      .eq('conversation_id', conversationId)
      .maybeSingle()
    if (error) throw error
    return data?.encryption_enabled === true
  })()
  const settled: Promise<boolean> = request.then(
    (enabled) => {
      if (reads.get(conversationId) === settled) {
        reads.delete(conversationId)
        entries.set(conversationId, { enabled, at: Date.now() })
      }
      return enabled
    },
    (error: unknown) => {
      if (reads.get(conversationId) === settled) reads.delete(conversationId)
      debug.warn('Reading conversation encryption failed:', error)
      return entries.get(conversationId)?.enabled ?? false
    },
  )
  reads.set(conversationId, settled)
  return settled
}

/** Asks the database; a read already running for the conversation is shared. */
export function fetchConversationEncryption(conversationId: string): Promise<boolean> {
  return read(conversationId)
}

/** From an entry younger than CONVERSATION_ENCRYPTION_FRESH_MS, else read. */
export async function conversationEncryptionEnabled(conversationId: string): Promise<boolean> {
  const entry = entries.get(conversationId)
  if (entry && Date.now() - entry.at < CONVERSATION_ENCRYPTION_FRESH_MS && !reads.has(conversationId)) {
    return entry.enabled
  }
  return read(conversationId)
}

/** Starts a read when the entry is absent or past half its freshness. */
export function refreshConversationEncryption(conversationId: string | null | undefined): void {
  if (!conversationId || reads.has(conversationId)) return
  const entry = entries.get(conversationId)
  if (entry && Date.now() - entry.at < CONVERSATION_ENCRYPTION_FRESH_MS / 2) return
  void read(conversationId)
}

export function recordConversationEncryption(conversationId: string, enabled: boolean): void {
  reads.delete(conversationId)
  entries.set(conversationId, { enabled, at: Date.now() })
}

/** Drops the conversation's entry, or every entry without an id; sign-out. */
export function forgetConversationEncryption(conversationId?: string | null): void {
  if (!conversationId) {
    entries.clear()
    reads.clear()
    return
  }
  entries.delete(conversationId)
  reads.delete(conversationId)
}

if (typeof window !== 'undefined') {
  window.addEventListener('dm-encryption-toggled', (event: Event) => {
    const detail = (event as CustomEvent).detail as { conversationId?: unknown; enabled?: unknown } | null
    if (typeof detail?.conversationId !== 'string') return
    if (typeof detail.enabled === 'boolean') recordConversationEncryption(detail.conversationId, detail.enabled)
    else forgetConversationEncryption(detail.conversationId)
  })
}
