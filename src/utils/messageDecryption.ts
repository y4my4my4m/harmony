/**
 * Message Decryption Middleware
 * 
 * Automatically attempts to decrypt encrypted messages using hybrid encryption.
 * Decrypts symmetric key from encryption_metadata, then decrypts content.
 */

import type { Message, MessagePart } from '@/types'

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

  console.log(`🔑 Processing ${messages.length} messages for decryption (user: ${currentUserId})`)

  // Process each message
  const processedMessages = await Promise.all(
    messages.map(async (message) => {
      // Check if message is encrypted
      if (!message.encrypted || !message.encryption_metadata) {
        return message
      }

      console.log(`🔐 Found encrypted message ${message.id}:`)
      console.log(`  - Algorithm:`, message.encryption_metadata.algorithm)
      console.log(`  - Encrypted for:`, message.encryption_metadata.encrypted_for)
      console.log(`  - Has keys:`, Object.keys(message.encryption_metadata.encrypted_keys || {}))
      console.log(`  - Sender:`, message.encryption_metadata.sender_key_id)

      // Check if we have an encrypted key for this user
      const hasKey = message.encryption_metadata.encrypted_keys?.[currentUserId]
      if (!hasKey) {
        console.log(`❌ No encrypted key for user ${currentUserId} in message ${message.id}`)
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
        
        return {
          ...message,
          content: decryptedContent,
          encrypted: false, // Remove encrypted flag
          decrypted: true // Add decrypted flag so we can show unlock indicator
        }
      } catch (error) {
        console.error(`❌ Cannot decrypt message ${message.id}:`, error)
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

