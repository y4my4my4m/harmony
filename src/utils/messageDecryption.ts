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
    return messages.map(msg => {
      if (msg.encrypted) {
        return {
          ...msg,
          content: [{ type: 'text' as const, text: generateObfuscatedPlaceholder(100) }]
        }
      }
      return msg
    })
  }
  
  if (!encryptionService || !encryptionService.isInitialized()) {
    console.log('ℹ️ Encryption not initialized - encrypted messages will show as glyphs')
    lastDecryptionError = 'Encryption service not initialized'
    return messages.map(msg => {
      if (msg.encrypted) {
        return {
          ...msg,
          content: [{ type: 'text' as const, text: generateObfuscatedPlaceholder(100) }]
        }
      }
      return msg
    })
  }
  
  // Check if encryption is unlocked (user has entered recovery key)
  if (!encryptionService.isUnlocked()) {
    console.log('🔐 Encryption locked - enter recovery key to decrypt messages')
    lastDecryptionError = 'Enter recovery key to unlock encryption'
    return messages.map(msg => {
      if (msg.encrypted) {
        return {
          ...msg,
          content: [{ type: 'text' as const, text: generateObfuscatedPlaceholder(100) }]
        }
      }
      return msg
    })
  }

  // Get current user's profile ID from the encryption service (already resolved during init)
  // This avoids duplicate database queries - the service stores the profile ID, not auth user ID
  const currentUserId = encryptionService.getCurrentUserId()
  
  if (!currentUserId) {
    console.log('ℹ️ No user ID in encryption service - encrypted messages will show as glyphs')
    lastDecryptionError = 'User ID not available in encryption service'
    // Replace all encrypted messages with glyphs
    return messages.map(msg => {
      if (msg.encrypted) {
        return {
          ...msg,
          content: [{ type: 'text' as const, text: generateObfuscatedPlaceholder(100) }]
        }
      }
      return msg
    })
  }

  // Count encrypted messages for logging
  const encryptedCount = messages.filter(m => m.encrypted).length
  if (encryptedCount > 0) {
    console.log(`🔑 Processing ${encryptedCount}/${messages.length} encrypted messages for decryption (user: ${currentUserId})`)
  }

  // Process each message
  const processedMessages = await Promise.all(
    messages.map(async (message) => {
      // Check if message is encrypted
      if (!message.encrypted || !message.encryption_metadata) {
        return message
      }

      const algorithm = message.encryption_metadata.algorithm || 'unknown'
      
      // Debug logging
      console.log(`🔐 Processing encrypted message ${message.id}:`)
      console.log(`  - Algorithm: ${algorithm}`)
      console.log(`  - Sender: ${message.encryption_metadata.sender_user_id || message.encryption_metadata.sender_key_id}`)
      
      if (algorithm === 'megolm_v1') {
        // Megolm: per-room session key encryption
        console.log(`  - Session ID: ${message.encryption_metadata.session_id}`)
        console.log(`  - Message Index: ${message.encryption_metadata.message_index}`)
      } else {
        // Legacy Signal Protocol
        const encryptedFor = message.encryption_metadata.encrypted_for || []
        console.log(`  - Encrypted for ${encryptedFor.length} users`)
      }

      try {
        console.log(`🔓 Attempting to decrypt message ${message.id}`)
        const decryptedContent = await encryptionService.decryptMessage(message)
        console.log(`✅ Successfully decrypted message ${message.id}`)
        lastDecryptionError = null
        
        return {
          ...message,
          content: decryptedContent,
          encrypted: false,
          decrypted: true
        }
      } catch (error: any) {
        const errorMessage = error?.message || String(error)
        console.error(`❌ Cannot decrypt message ${message.id}:`, errorMessage)
        
        // Megolm-specific errors
        if (errorMessage.includes('No inbound session')) {
          console.error('   ⚠️ Missing session key - need to sync keys from sender')
          lastDecryptionError = 'Session key not available - sync keys'
        } else if (errorMessage.includes('recovery key')) {
          console.error('   ⚠️ Enter recovery key to unlock encryption')
          lastDecryptionError = 'Enter recovery key to decrypt'
        } else if (errorMessage.includes('Message index')) {
          console.error('   ⚠️ Message from before session was established')
          lastDecryptionError = 'Message predates session'
        } else {
          lastDecryptionError = `Decryption error: ${errorMessage.substring(0, 50)}`
        }
        
        // Show placeholder
        const obfuscatedText = generateObfuscatedPlaceholder(100)
        return {
          ...message,
          content: [{ type: 'text' as const, text: obfuscatedText }],
          encrypted: true
        }
      }
    })
  )

  return processedMessages
}

/**
 * Generate cool obfuscated placeholder text for encrypted messages
 */
function generateObfuscatedPlaceholder(length: number): string {
  const chars = '█▓▒░▄▀■□▪▫●○◘◙▬¤§¶ƒαßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■'
  const displayLength = Math.min(Math.max(length / 4, 12), 64)
  let result = ''
  for (let i = 0; i < displayLength; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

