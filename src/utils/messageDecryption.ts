/**
 * Message Decryption Middleware
 * 
 * Decrypts encrypted messages using Megolm-style room-based encryption.
 * Each channel/conversation has a session key shared with all members.
 * Keys are backed up to server (encrypted with user's recovery key).
 */

import type { Message, MessagePart } from '@/types'

// Track decryption failures for debugging
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
  // Load Megolm encryption service
  let encryptionService: any = null
  
  try {
    const module = await import('@/services/encryption/MegolmMessageEncryptionService')
    encryptionService = module.megolmMessageEncryptionService
  } catch (error) {
    console.warn('⚠️ Megolm encryption service not available:', error)
    lastDecryptionError = 'Encryption service not available'
    // Preserve original content - UI shows glyphs based on encrypted && !decrypted
    return messages
  }
  
  if (!encryptionService || !encryptionService.isInitialized()) {
    console.log('ℹ️ Encryption not initialized - encrypted messages will show as glyphs')
    lastDecryptionError = 'Encryption service not initialized'
    // Preserve original content - UI shows glyphs based on encrypted && !decrypted
    return messages
  }
  
  // Check if encryption is unlocked (user has entered recovery key)
  if (!encryptionService.isUnlocked()) {
    console.log('🔐 Encryption locked - enter recovery key to decrypt messages')
    lastDecryptionError = 'Enter recovery key to unlock encryption'
    // Preserve original content - UI shows glyphs based on encrypted && !decrypted
    return messages
  }

  // Get current user's profile ID from the encryption service (already resolved during init)
  // This avoids duplicate database queries - the service stores the profile ID, not auth user ID
  const currentUserId = encryptionService.getCurrentUserId()
  
  if (!currentUserId) {
    console.log('ℹ️ No user ID in encryption service - encrypted messages will show as glyphs')
    lastDecryptionError = 'User ID not available in encryption service'
    // Preserve original content - UI shows glyphs based on encrypted && !decrypted
    return messages
  }

  // Separate encrypted and non-encrypted messages
  const encryptedMessages = messages.filter(m => m.encrypted && m.encryption_metadata)
  const nonEncryptedMessages = messages.filter(m => !m.encrypted || !m.encryption_metadata)

  if (encryptedMessages.length === 0) {
    return messages // Fast path: nothing to decrypt
  }

  // Process encrypted messages in parallel
  const decryptedResults = await Promise.all(
    encryptedMessages.map(async (message) => {
      try {
        const decryptedContent = await encryptionService.decryptMessage(message)
        lastDecryptionError = null
        
        return {
          ...message,
          content: decryptedContent,
          encrypted: false,
          decrypted: true
        }
      } catch (error: any) {
        const errorMessage = error?.message || String(error)
        
        // Set last error for UI display
        if (errorMessage.includes('No inbound session') || errorMessage.includes('No outbound session')) {
          lastDecryptionError = 'Session key not available'
        } else if (errorMessage.includes('recovery key')) {
          lastDecryptionError = 'Enter recovery key to decrypt'
        } else {
          lastDecryptionError = `Decryption error`
        }
        
        // PRESERVE original content - UI will show glyphs based on encrypted && !decrypted
        // This allows retry without hitting the database
        return {
          ...message,
          encrypted: true,
          decrypted: false
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

