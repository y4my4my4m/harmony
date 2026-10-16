/**
 * conversation_encryption_settings.encryption_enabled per DM conversation, shared by the send
 * path, the chat header and the conversation header.
 *
 * An entry stands until something says it changed: the conversation:encryption notice every
 * participant gets on their user channel, this client's own toggle ('dm-encryption-toggled'),
 * a user channel reconnect (notices may have been missed), a fresh read when a header opens the
 * conversation, and sign-out. A stale "not encrypted" costs one refused insert:
 * enforce_conversation_message_encryption() rejects plaintext with CONVERSATION_ENCRYPTED and the
 * sender reads again. A stale "encrypted" encrypts, or asks a locked sender, until the notice or
 * the next open.
 *
 * A failed read answers with the previous entry, else "not encrypted" as the uncached read
 * did, and is not kept.
 */
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

interface Entry {
  enabled: boolean
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
        entries.set(conversationId, { enabled })
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

/** From the entry, else read. A read already running answers instead. */
export async function conversationEncryptionEnabled(conversationId: string): Promise<boolean> {
  const running = reads.get(conversationId)
  if (running) return running
  const entry = entries.get(conversationId)
  return entry ? entry.enabled : read(conversationId)
}

/** The database refused plaintext: enforce_conversation_message_encryption() found the conversation encrypted. */
export function isConversationEncryptedRefusal(error: { message?: string } | null | undefined): boolean {
  return (error?.message || '').includes('CONVERSATION_ENCRYPTED')
}

export function recordConversationEncryption(conversationId: string, enabled: boolean): void {
  reads.delete(conversationId)
  entries.set(conversationId, { enabled })
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
