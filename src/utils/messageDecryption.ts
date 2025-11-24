/**
 * Message Decryption Middleware
 * 
 * Automatically attempts to decrypt encrypted messages when loading them.
 * Decrypts text and URLs within MessageParts while preserving structure.
 */

import type { Message, MessagePart } from '@/types'

/**
 * Process messages and attempt to decrypt encrypted parts
 */
export async function processMessageDecryption(messages: Message[]): Promise<Message[]> {
  // Lazy load encryption service
  let encryptionService: any = null
  try {
    const module = await import('@/services/encryption/MessageEncryptionService')
    encryptionService = module.messageEncryptionService
  } catch (error) {
    console.warn('⚠️ Encryption service not available')
    return messages
  }

  if (!encryptionService || !encryptionService.isInitialized()) {
    console.log('ℹ️ Encryption not initialized - encrypted messages will show encrypted view')
    return messages
  }

  const currentUserId = encryptionService.currentUserId

  // Process each message
  const processedMessages = await Promise.all(
    messages.map(async (message) => {
      // Check if message is encrypted
      if (!message.encrypted || !message.content) {
        return message
      }

      try {
        // Process each part
        const decryptedContent: MessagePart[] = []

        for (const part of message.content as MessagePart[]) {
          if (part.type === 'encrypted_text' && part.encrypted_payloads) {
            // Try to decrypt text
            const payload = part.encrypted_payloads[currentUserId]
            if (payload) {
              try {
                const encryptedMsg = JSON.parse(payload)
                const { signalProtocolService } = await import('@/services/encryption/SignalProtocolService')
                const senderAddress = `${message.user_id}:1`
                const decryptedText = await signalProtocolService.decryptMessage(senderAddress, encryptedMsg)
                
                // Replace with decrypted text part
                decryptedContent.push({
                  type: 'text',
                  text: decryptedText
                })
              } catch (error) {
                console.log(`🔐 Cannot decrypt text part - showing encrypted view`)
                // Keep encrypted view
                decryptedContent.push(part)
              }
            } else {
              // No payload for current user - show encrypted view
              decryptedContent.push(part)
            }
          } else if (part.type === 'encrypted_url' && part.encrypted_payloads) {
            // Try to decrypt URL
            const payload = part.encrypted_payloads[currentUserId]
            if (payload) {
              try {
                const encryptedMsg = JSON.parse(payload)
                const { signalProtocolService } = await import('@/services/encryption/SignalProtocolService')
                const senderAddress = `${message.user_id}:1`
                const decryptedUrl = await signalProtocolService.decryptMessage(senderAddress, encryptedMsg)
                
                // Replace with decrypted URL part
                decryptedContent.push({
                  type: 'url',
                  url: decryptedUrl
                })
              } catch (error) {
                console.log(`🔐 Cannot decrypt URL part - showing encrypted view`)
                // Keep encrypted view
                decryptedContent.push(part)
              }
            } else {
              // No payload for current user - show encrypted view
              decryptedContent.push(part)
            }
          } else {
            // Non-encrypted part (emoji, mention, etc) - keep as-is
            decryptedContent.push(part)
          }
        }
        
        console.log(`🔓 Message ${message.id} decrypted successfully`)
        
        return {
          ...message,
          content: decryptedContent
        }
      } catch (error) {
        console.log(`🔐 Cannot decrypt message ${message.id}:`, error)
        return message
      }
    })
  )

  return processedMessages
}

