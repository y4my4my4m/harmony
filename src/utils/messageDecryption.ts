/**
 * Message Decryption Middleware
 * 
 * Decrypts encrypted messages using Megolm-style room-based encryption.
 * Each channel/conversation has a session key shared with all members.
 * Keys are backed up to server (encrypted with user's recovery key).
 */

import type { Message, MessagePart } from '@/types'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'

let lastDecryptionError: string | null = null

/**
 * Get the last decryption error (for debugging/UI display)
 */
export function getLastDecryptionError(): string | null {
  return lastDecryptionError
}

/**
 * Process messages and attempt to decrypt encrypted ones
 */
export async function processMessageDecryption(messages: Message[]): Promise<Message[]> {
  // FIRST: bail before touching the encryption stack at all. Previously the
  // encrypted-page check sat BELOW the lazy service initialization, so even a
  // fully plaintext channel load awaited encryption boot (auto-unlock, key
  // sweeps, device registration...) before painting - the main "first load
  // takes forever" contributor on unencrypted servers.
  if (!messages.some(m => m.encrypted && m.encryption_metadata)) {
    return messages
  }

  let encryptionService: any = null

  try {
    const module = await import('@/services/encryption/MegolmMessageEncryptionService')
    encryptionService = module.megolmMessageEncryptionService
  } catch (error) {
    debug.warn('⚠️ Megolm encryption service not available:', error)
    lastDecryptionError = 'Encryption service not available'
    // Preserve original content - UI shows glyphs based on encrypted && !decrypted
    return messages
  }
  
  if (!encryptionService) {
    debug.log('ℹ️ Encryption service not available - encrypted messages will show as glyphs')
    lastDecryptionError = 'Encryption service not available'
    return messages
  }

  // Lazy-initialize if needed (matches CoreMessageService behavior)
  if (!encryptionService.isInitialized()) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.user?.id) {
        debug.log('🔐 Lazy-initializing encryption for decryption...')
        await encryptionService.initialize(session.user.id)
      }
    } catch (error) {
      debug.warn('⚠️ Failed to lazy-initialize encryption for decryption:', error)
    }
  }

  if (!encryptionService.isInitialized()) {
    debug.log('ℹ️ Encryption not initialized - encrypted messages will show as glyphs')
    lastDecryptionError = 'Encryption service not initialized'
    return messages
  }
  
  if (!encryptionService.isUnlocked()) {
    debug.log('🔐 Encryption locked - enter recovery key to decrypt messages')
    lastDecryptionError = 'Enter recovery key to unlock encryption'
    // Preserve original content - UI shows glyphs based on encrypted && !decrypted
    return messages
  }

  // Get current user's profile ID from the encryption service (already resolved during init)
  // This avoids duplicate database queries - the service stores the profile ID, not auth user ID
  const currentUserId = encryptionService.getCurrentUserId()
  
  if (!currentUserId) {
    debug.log('ℹ️ No user ID in encryption service - encrypted messages will show as glyphs')
    lastDecryptionError = 'User ID not available in encryption service'
    // Preserve original content - UI shows glyphs based on encrypted && !decrypted
    return messages
  }

  // Separate encrypted and non-encrypted messages
  const encryptedMessages = messages.filter(m => m.encrypted && m.encryption_metadata)
  // eslint-disable-next-line unused-imports/no-unused-vars
  const nonEncryptedMessages = messages.filter(m => !m.encrypted || !m.encryption_metadata)

  if (encryptedMessages.length === 0) {
    return messages // Fast path: nothing to decrypt
  }

  // Batch-prime the signing key cache for every sender on this page in ONE
  // query, so per-message signature verification doesn't fan out to one
  // user_key_pairs lookup per sender. Best-effort: verification has its own
  // per-sender fallback with the same caching.
  try {
    const senderIds = [...new Set(
      encryptedMessages
        .map(m => (m.encryption_metadata as any)?.sender_user_id)
        .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
    )]
    if (senderIds.length > 0 && typeof encryptionService.prefetchSigningKeys === 'function') {
      await encryptionService.prefetchSigningKeys(senderIds)
    }
  } catch (error) {
    debug.warn('⚠️ Signing key prefetch failed (non-fatal):', error)
  }

  // "Identity epoch": messages encrypted before our current identity was created
  // are sealed to a key that no longer exists. A missing session key for them is
  // permanent (no point asking the sender / retrying), so we flag them distinctly.
  let identityEpochMs: number | null = null
  try {
    identityEpochMs = await encryptionService.getIdentityCreatedAt?.()
  } catch { /* unknown epoch → treat all failures as retryable */ }

  const decryptedResults = await Promise.all(
    encryptedMessages.map(async (message) => {
      try {
        const decrypted = await encryptionService.decryptMessage(message)
        lastDecryptionError = null

        // decryptMessage returns { content, senderVerified } for v2-aware
        // callers and (historically) a bare MessagePart[] for the rest.
        // Handle both shapes so existing in-flight messages still decode.
        const content: MessagePart[] = Array.isArray(decrypted) ? decrypted : decrypted.content
        const senderVerified: boolean | undefined = Array.isArray(decrypted)
          ? undefined
          : Boolean(decrypted.senderVerified)

        return {
          ...message,
          content,
          encrypted: false,
          decrypted: true,
          sender_verified: senderVerified,
        }
      } catch (error: any) {
        const errorMessage = error?.message || String(error)

        if (errorMessage.includes('Sender signature invalid')) {
          // Forgery detected - make this visible. Don't fall back to a soft
          // "session key" message which would hide the attack signal.
          lastDecryptionError = 'Sender signature mismatch (possible tampering)'
        } else if (errorMessage.includes('No inbound session') || errorMessage.includes('No outbound session')) {
          lastDecryptionError = 'Session key not available'
        } else if (errorMessage.includes('recovery key')) {
          lastDecryptionError = 'Enter recovery key to decrypt'
        } else {
          lastDecryptionError = `Decryption error`
        }

        // A missing session key is *permanent* when the message predates our
        // current identity: the private key that could unwrap its share is gone.
        // Flag those so the UI stops offering a (futile) retry/key-request.
        const missingKey =
          errorMessage.includes('No inbound session') ||
          errorMessage.includes('No outbound session') ||
          errorMessage.includes('session key')
        const sentAtMs = message.created_at ? new Date(message.created_at).getTime() : NaN
        const unrecoverable =
          missingKey &&
          identityEpochMs != null &&
          Number.isFinite(sentAtMs) &&
          sentAtMs < identityEpochMs

        // PRESERVE original content - UI will show glyphs based on encrypted && !decrypted
        return {
          ...message,
          encrypted: true,
          decrypted: false,
          sender_verified: false,
          decryption_unrecoverable: unrecoverable,
        }
      }
    })
  )

  // Rebuild the message list preserving original order
  const decryptedMap = new Map(decryptedResults.map(m => [m.id, m]))
  return messages.map(msg => decryptedMap.get(msg.id) || msg)
}

// Note: Glyph generation moved to UnifiedMessageContent.vue
// The UI now handles showing glyphs when encrypted && !decrypted
// Original encrypted content is preserved for retry without DB reload

