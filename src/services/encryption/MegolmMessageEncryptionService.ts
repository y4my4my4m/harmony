/**
 * Megolm Message Encryption Service
 * 
 * High-level service for encrypting and decrypting messages using Megolm-style
 * room-based encryption. This is a refactored approach that:
 * 
 * 1. Uses per-room session keys (not per-message key exchange)
 * 2. Supports recovery key backup for cross-device/cache recovery
 * 3. Is more efficient for group messaging
 * 
 * This service replaces the Signal Protocol-based MessageEncryptionService
 * for the new encryption architecture.
 */

import { supabase } from '@/supabase'
import { megolmService, type MegolmEncryptedMessage } from './MegolmService'
import { recoveryKeyService } from './RecoveryKeyService'
import { megolmKeyBackupService } from './MegolmKeyBackupService'
import type { MessagePart } from '@/types'

export interface MegolmEncryptionStatus {
  enabled: boolean
  hasRecoveryKey: boolean
  hasBackup: boolean
  needsSetup: boolean
  mode: 'disabled' | 'optional' | 'required'
}

export interface MegolmEncryptedMessageData {
  encrypted: true
  content: MessagePart[] // Encrypted content (base64 ciphertext in text field)
  encryption_metadata: {
    algorithm: 'megolm_v1'
    session_id: string
    message_index: number
    sender_user_id: string
    timestamp: number
  }
}

/**
 * Megolm Message Encryption Service
 * Handles message encryption using room-based Megolm sessions
 */
export class MegolmMessageEncryptionService {
  private static instance: MegolmMessageEncryptionService
  private currentUserId: string | null = null
  private initialized = false

  private constructor() {}

  static getInstance(): MegolmMessageEncryptionService {
    if (!MegolmMessageEncryptionService.instance) {
      MegolmMessageEncryptionService.instance = new MegolmMessageEncryptionService()
    }
    return MegolmMessageEncryptionService.instance
  }

  // =====================================================
  // INITIALIZATION
  // =====================================================

  /**
   * Initialize the service for a user
   */
  async initialize(authUserId: string): Promise<void> {
    // Get profile ID from database
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', authUserId)
        .single()
      
      if (profile?.id) {
        this.currentUserId = profile.id
        console.log(`🔐 MegolmMessageEncryptionService: Using profile ID ${this.currentUserId}`)
      } else {
        this.currentUserId = authUserId
        console.warn(`⚠️ No profile found for auth user ${authUserId}`)
      }
    } catch (error) {
      console.warn('⚠️ Failed to get profile ID:', error)
      this.currentUserId = authUserId
    }

    // Initialize backup service
    await megolmKeyBackupService.initialize(this.currentUserId)

    this.initialized = true
    console.log('✅ MegolmMessageEncryptionService initialized')
  }

  /**
   * Initialize encryption with recovery key
   * This is called when user enters their recovery phrase
   */
  async initializeWithRecoveryKey(words: string[]): Promise<void> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    // Derive keys from mnemonic
    const derivedKeys = await recoveryKeyService.deriveKeysFromMnemonic(words)

    // Initialize Megolm service with encryption key
    await megolmService.initialize(this.currentUserId, derivedKeys.encryptionKey)

    // Try to restore from backup
    try {
      const result = await megolmKeyBackupService.restoreFromBackup()
      console.log(`📥 Restored ${result.outboundCount + result.inboundCount} sessions from backup`)
    } catch (error) {
      console.log('ℹ️ No backup to restore or restore failed:', error)
    }

    console.log('✅ Encryption initialized with recovery key')
  }

  /**
   * Setup new encryption with a fresh recovery key
   */
  async setupNewEncryption(): Promise<string[]> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    // Generate new recovery mnemonic
    const words = recoveryKeyService.generateMnemonic(12)

    // Derive keys from mnemonic
    const derivedKeys = await recoveryKeyService.deriveKeysFromMnemonic(words)

    // Initialize Megolm service
    await megolmService.initialize(this.currentUserId, derivedKeys.encryptionKey)

    // Generate verification code
    const verificationCode = await recoveryKeyService.generateVerificationCode()

    // Store recovery key metadata (NOT the key itself!)
    await supabase.rpc('register_recovery_key', {
      p_user_id: this.currentUserId,
      p_verification_code: verificationCode,
      p_word_count: 12
    })

    // Create initial backup
    await megolmKeyBackupService.createBackup()

    console.log('✅ New encryption setup complete')
    return words
  }

  // =====================================================
  // ENCRYPTION / DECRYPTION
  // =====================================================

  /**
   * Encrypt a message for a room (channel or conversation)
   */
  async encryptMessage(
    content: MessagePart[],
    roomId: string,
    recipientIds: string[]
  ): Promise<MegolmEncryptedMessageData> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    if (!megolmService.isInitialized()) {
      throw new Error('Encryption not unlocked - enter your recovery key first')
    }

    console.log(`🔐 Encrypting message for room ${roomId.substring(0, 8)}...`)

    // Serialize content
    const plaintextContent = JSON.stringify(content)

    // Encrypt with Megolm
    const encryptedMessage = await megolmService.encryptMessage(roomId, plaintextContent)

    // Share session with recipients who don't have it
    await this.ensureSessionShared(roomId, encryptedMessage.sessionId, recipientIds)

    // Store encrypted message in content as base64 text
    const encryptedContent: MessagePart[] = [{
      type: 'text',
      text: encryptedMessage.ciphertext
    }]

    return {
      encrypted: true,
      content: encryptedContent,
      encryption_metadata: {
        algorithm: 'megolm_v1',
        session_id: encryptedMessage.sessionId,
        message_index: encryptedMessage.messageIndex,
        sender_user_id: this.currentUserId,
        timestamp: Date.now()
      }
    }
  }

  /**
   * Decrypt a message
   */
  async decryptMessage(
    message: {
      content: MessagePart[]
      encryption_metadata?: {
        algorithm?: string
        session_id?: string
        message_index?: number
        sender_user_id?: string
        // Legacy Signal Protocol fields
        encrypted_keys?: Record<string, string>
        sender_key_id?: string
        iv?: string
      }
    }
  ): Promise<MessagePart[]> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    const metadata = message.encryption_metadata
    if (!metadata) {
      throw new Error('No encryption metadata')
    }

    // Check encryption algorithm
    if (metadata.algorithm === 'megolm_v1') {
      return this.decryptMegolmMessage(message)
    } else if (metadata.algorithm === 'signal_protocol_v1_hybrid') {
      // Legacy Signal Protocol message - need to handle differently
      console.log('⚠️ Legacy Signal Protocol message - attempting fallback decryption')
      return this.decryptLegacyMessage(message)
    }

    throw new Error(`Unsupported encryption algorithm: ${metadata.algorithm}`)
  }

  /**
   * Decrypt a Megolm-encrypted message
   */
  private async decryptMegolmMessage(
    message: {
      content: MessagePart[]
      encryption_metadata?: {
        session_id?: string
        message_index?: number
        sender_user_id?: string
      }
    }
  ): Promise<MessagePart[]> {
    if (!megolmService.isInitialized()) {
      throw new Error('Encryption not unlocked - enter your recovery key first')
    }

    const metadata = message.encryption_metadata!
    const sessionId = metadata.session_id
    const messageIndex = metadata.message_index
    const senderId = metadata.sender_user_id

    if (!sessionId || messageIndex === undefined || !senderId) {
      throw new Error('Missing Megolm encryption metadata')
    }

    // Get the encrypted ciphertext
    const ciphertext = message.content[0]?.type === 'text' ? message.content[0].text : ''
    if (!ciphertext) {
      throw new Error('No encrypted content found')
    }

    // Build the encrypted message object
    const encryptedMessage: MegolmEncryptedMessage = {
      sessionId,
      messageIndex,
      ciphertext
    }

    // Check if we have the session - if not, try to claim pending shares
    if (!megolmService.hasInboundSession('', senderId, sessionId)) {
      console.log(`ℹ️ Missing inbound session ${sessionId}, checking for shares...`)
      await this.claimPendingSessionShares()
    }

    // Find the room ID from message context (this might need to be passed in)
    // For now, we'll extract it from the decryption attempt
    // In practice, the room_id should be part of the message or context
    const roomId = '' // TODO: Get from context

    try {
      const decryptedJson = await megolmService.decryptMessage(roomId, senderId, encryptedMessage)
      const decryptedContent: MessagePart[] = JSON.parse(decryptedJson)
      
      console.log('✅ Message decrypted successfully (Megolm)')
      return decryptedContent
    } catch (error: any) {
      if (error.message.includes('No inbound session')) {
        // Request the session key from sender
        console.log('📤 Requesting session key from sender...')
        await megolmKeyBackupService.createKeyRequest(roomId, sessionId)
        throw new Error('Session key not available - key request sent')
      }
      throw error
    }
  }

  /**
   * Decrypt a legacy Signal Protocol message
   * This provides backward compatibility
   */
  private async decryptLegacyMessage(
    message: {
      content: MessagePart[]
      encryption_metadata?: any
    }
  ): Promise<MessagePart[]> {
    // Import the legacy service dynamically
    try {
      const { messageEncryptionService } = await import('./MessageEncryptionService')
      return await messageEncryptionService.decryptMessage(message)
    } catch (error) {
      console.error('❌ Failed to decrypt legacy message:', error)
      throw new Error('Cannot decrypt legacy message - old encryption keys may be required')
    }
  }

  // =====================================================
  // SESSION SHARING
  // =====================================================

  /**
   * Ensure our session is shared with all recipients
   */
  private async ensureSessionShared(
    roomId: string,
    sessionId: string,
    recipientIds: string[]
  ): Promise<void> {
    if (!this.currentUserId) return

    // Get users who need the session
    const usersNeedingSession = megolmService.getUsersNeedingSession(roomId, recipientIds)

    if (usersNeedingSession.length === 0) {
      return
    }

    console.log(`📤 Sharing session with ${usersNeedingSession.length} users...`)

    // Get session key data
    const sessionData = megolmService.getSessionKeyForSharing(roomId)
    if (!sessionData) {
      console.error('❌ Failed to get session data for sharing')
      return
    }

    // For each user, encrypt the session key with their identity key
    // In a full implementation, we'd use Signal Protocol for this
    // For now, we'll store it encrypted with a shared key derivation
    for (const userId of usersNeedingSession) {
      try {
        // Get recipient's public key
        const { data: recipientKey } = await supabase
          .from('user_key_pairs')
          .select('identity_public_key')
          .eq('user_id', userId)
          .eq('is_active', true)
          .single()

        if (!recipientKey?.identity_public_key) {
          console.warn(`⚠️ No public key for user ${userId}`)
          continue
        }

        // For now, we'll use a simple encryption approach
        // In production, this would use the recipient's public key
        const encryptedSessionKey = await this.encryptSessionKeyForUser(
          sessionData.sessionKey,
          recipientKey.identity_public_key
        )

        // Store the share
        await supabase
          .from('megolm_session_shares')
          .upsert({
            room_id: roomId,
            session_id: sessionId,
            sender_user_id: this.currentUserId,
            recipient_user_id: userId,
            encrypted_session_key: encryptedSessionKey,
            first_known_index: sessionData.messageIndex
          }, {
            onConflict: 'room_id,session_id,recipient_user_id'
          })

        // Mark as shared in local state
        await megolmService.markSessionSharedWith(roomId, userId)

      } catch (error) {
        console.error(`❌ Failed to share session with ${userId}:`, error)
      }
    }
  }

  /**
   * Encrypt session key for a specific user
   * In production, this would use asymmetric encryption with recipient's public key
   */
  private async encryptSessionKeyForUser(
    sessionKey: string,
    recipientPublicKey: string
  ): Promise<string> {
    // For now, use a simple HKDF-based key derivation
    // In production, implement proper ECIES or similar
    const encoder = new TextEncoder()
    
    const derivedKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(recipientPublicKey.substring(0, 32)),
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    )

    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      derivedKey,
      encoder.encode(sessionKey)
    )

    // Combine IV + ciphertext
    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)

    return btoa(String.fromCharCode(...combined))
  }

  /**
   * Claim pending session shares (from other users)
   */
  async claimPendingSessionShares(): Promise<number> {
    if (!this.currentUserId) return 0

    const { data: shares, error } = await supabase
      .rpc('get_unclaimed_session_shares', { p_user_id: this.currentUserId })

    if (error || !shares || shares.length === 0) {
      return 0
    }

    let claimedCount = 0

    for (const share of shares) {
      try {
        // Decrypt the session key
        const sessionKey = await this.decryptSessionKeyForMe(share.encrypted_session_key)

        // Import the session
        await megolmService.importInboundSession(
          share.room_id,
          share.sender_user_id,
          share.session_id,
          sessionKey,
          share.first_known_index
        )

        // Mark as claimed
        await supabase.rpc('claim_session_share', {
          p_share_id: share.share_id,
          p_user_id: this.currentUserId
        })

        claimedCount++
      } catch (error) {
        console.error(`❌ Failed to claim share ${share.share_id}:`, error)
      }
    }

    console.log(`📥 Claimed ${claimedCount} session shares`)
    return claimedCount
  }

  /**
   * Decrypt a session key that was encrypted for us
   */
  private async decryptSessionKeyForMe(encryptedSessionKey: string): Promise<string> {
    // Get our identity key to derive decryption key
    const { data: myKey } = await supabase
      .from('user_key_pairs')
      .select('identity_public_key')
      .eq('user_id', this.currentUserId)
      .eq('is_active', true)
      .single()

    if (!myKey?.identity_public_key) {
      throw new Error('Cannot find my identity key')
    }

    const encoder = new TextEncoder()
    const derivedKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(myKey.identity_public_key.substring(0, 32)),
      { name: 'AES-GCM' },
      false,
      ['decrypt']
    )

    // Decode and decrypt
    const combined = Uint8Array.from(atob(encryptedSessionKey), c => c.charCodeAt(0))
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      derivedKey,
      ciphertext
    )

    const decoder = new TextDecoder()
    return decoder.decode(decrypted)
  }

  // =====================================================
  // STATUS & UTILITIES
  // =====================================================

  /**
   * Get encryption status
   */
  async getEncryptionStatus(): Promise<MegolmEncryptionStatus> {
    if (!this.currentUserId) {
      return {
        enabled: false,
        hasRecoveryKey: false,
        hasBackup: false,
        needsSetup: true,
        mode: 'optional'
      }
    }

    // Check if user has recovery key set up
    const { data: recoveryMetadata } = await supabase
      .from('recovery_key_metadata')
      .select('id, has_server_backup')
      .eq('user_id', this.currentUserId)
      .single()

    const hasRecoveryKey = !!recoveryMetadata
    const hasBackup = recoveryMetadata?.has_server_backup || false

    return {
      enabled: megolmService.isInitialized(),
      hasRecoveryKey,
      hasBackup,
      needsSetup: !hasRecoveryKey,
      mode: 'optional' // TODO: Check server/conversation settings
    }
  }

  /**
   * Check if encryption is unlocked
   */
  isUnlocked(): boolean {
    return megolmService.isInitialized()
  }

  /**
   * Check if user has recovery key set up
   */
  async hasRecoveryKey(): Promise<boolean> {
    if (!this.currentUserId) return false

    const { data } = await supabase
      .from('recovery_key_metadata')
      .select('id')
      .eq('user_id', this.currentUserId)
      .single()

    return !!data
  }

  /**
   * Trigger backup of current sessions
   */
  async backupSessions(): Promise<void> {
    await megolmKeyBackupService.createBackup()
  }

  /**
   * Get the current user ID
   */
  getCurrentUserId(): string | null {
    return this.currentUserId
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Reset encryption (delete all data)
   */
  async resetEncryption(): Promise<void> {
    if (!this.currentUserId) return

    // Delete backup
    await megolmKeyBackupService.deleteBackup()

    // Delete recovery key metadata
    await supabase
      .from('recovery_key_metadata')
      .delete()
      .eq('user_id', this.currentUserId)

    // Delete session shares
    await supabase
      .from('megolm_session_shares')
      .delete()
      .or(`sender_user_id.eq.${this.currentUserId},recipient_user_id.eq.${this.currentUserId}`)

    // Close Megolm service
    megolmService.close()

    // Clear recovery key service
    recoveryKeyService.clear()

    console.log('✅ Encryption reset complete')
  }

  /**
   * Cleanup on logout
   */
  async cleanup(): Promise<void> {
    megolmService.close()
    recoveryKeyService.clear()
    this.currentUserId = null
    this.initialized = false
  }
}

// Export singleton
export const megolmMessageEncryptionService = MegolmMessageEncryptionService.getInstance()

