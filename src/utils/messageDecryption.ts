/**
 * Message Decryption Middleware
 * 
 * Automatically attempts to decrypt encrypted messages using hybrid encryption.
 * Decrypts symmetric key from encryption_metadata, then decrypts content.
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
  // Lazy load encryption service
  let encryptionService: any = null
  try {
    const module = await import('@/services/encryption/MessageEncryptionService')
    encryptionService = module.messageEncryptionService
  } catch (error) {
    console.warn('⚠️ Encryption service not available:', error)
    lastDecryptionError = 'Encryption service not available'
    // Replace all encrypted messages with glyphs for users without encryption
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
    // Replace all encrypted messages with glyphs for users without encryption
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

      // Debug logging for encrypted messages
      const encryptedFor = message.encryption_metadata.encrypted_for || []
      const hasKeyInMetadata = message.encryption_metadata.encrypted_keys?.[currentUserId]
      
      console.log(`🔐 Processing encrypted message ${message.id}:`)
      console.log(`  - Sender: ${message.encryption_metadata.sender_key_id}`)
      console.log(`  - Encrypted for ${encryptedFor.length} users: [${encryptedFor.join(', ')}]`)
      console.log(`  - Current user ${currentUserId} ${hasKeyInMetadata ? 'HAS' : 'MISSING'} encrypted key`)

      // Check if we have an encrypted key for this user
      if (!hasKeyInMetadata) {
        console.log(`❌ No encrypted key for user ${currentUserId} in message ${message.id}`)
        console.log(`   This could mean:`)
        console.log(`   - The sender didn't encrypt for this user`)
        console.log(`   - User ID mismatch (profile ID vs auth ID)`)
        console.log(`   - Message was sent before user joined/enabled encryption`)
        
        lastDecryptionError = `No encrypted key for user in message`
        // Show cool placeholder characters
        const obfuscatedText = generateObfuscatedPlaceholder(100)
        return {
          ...message,
          content: [{ type: 'text' as const, text: obfuscatedText }]
        }
      }

      try {
        console.log(`🔓 Attempting to decrypt message ${message.id} for user ${currentUserId}`)
        const decryptedContent = await encryptionService.decryptMessage(message)
        console.log(`✅ Successfully decrypted message ${message.id}`)
        lastDecryptionError = null // Clear error on success
        
        return {
          ...message,
          content: decryptedContent,
          encrypted: false, // Remove encrypted flag
          decrypted: true // Add decrypted flag so we can show unlock indicator
        }
      } catch (error: any) {
        const errorMessage = error?.message || String(error)
        console.error(`❌ Cannot decrypt message ${message.id}:`, errorMessage)
        
        // Provide more specific error diagnostics
        if (errorMessage.includes('Encryption key not set')) {
          console.error('   ⚠️ Encryption password required - user needs to unlock encryption')
          lastDecryptionError = 'Encryption password required'
        } else if (errorMessage.includes('Session not found') || errorMessage.includes('unable to find session')) {
          console.error('   ⚠️ No Signal Protocol session with sender')
          console.error('   This can happen if encryption keys were regenerated or cleared')
          lastDecryptionError = 'Encryption session not found'
        } else if (errorMessage.includes('prekey')) {
          console.error('   ⚠️ Prekey issue - might need to regenerate encryption keys')
          lastDecryptionError = 'Prekey error'
        } else if (errorMessage.includes('Invalid encrypted data') || errorMessage.includes('atob') || errorMessage.includes('base64')) {
          console.error('   ⚠️ Message data is corrupted or was encrypted with deleted keys')
          console.error('   This message cannot be recovered - the original encryption keys are gone')
          lastDecryptionError = 'Message encrypted with deleted keys - unrecoverable'
        } else {
          lastDecryptionError = `Decryption error: ${errorMessage.substring(0, 50)}`
        }
        
        // Show cool placeholder characters on error
        const obfuscatedText = generateObfuscatedPlaceholder(100)
        return {
          ...message,
          content: [{ type: 'text' as const, text: obfuscatedText }],
          encrypted: true // Keep encrypted flag so glyphs and lock show
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

