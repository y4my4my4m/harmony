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
    if (this.currentUserId) {
      await megolmKeyBackupService.initialize(this.currentUserId)
    }

    this.initialized = true
    console.log('✅ MegolmMessageEncryptionService initialized')

    // Try to auto-unlock from session storage (persists across page refresh)
    await this.tryAutoUnlock()
  }

  /**
   * Try to auto-unlock encryption from stored session
   */
  private async tryAutoUnlock(): Promise<boolean> {
    if (!this.currentUserId) return false

    try {
      const storedData = sessionStorage.getItem(`megolm_session_${this.currentUserId}`)
      if (!storedData) {
        console.log('🔐 No stored session - encryption locked')
        return false
      }

      // Decode the stored mnemonic
      const words = JSON.parse(atob(storedData)) as string[]
      
      if (!Array.isArray(words) || words.length < 12) {
        console.warn('⚠️ Invalid stored session data')
        sessionStorage.removeItem(`megolm_session_${this.currentUserId}`)
        return false
      }

      console.log('🔐 Found stored session - auto-unlocking...')
      
      // Derive keys from mnemonic
      const derivedKeys = await recoveryKeyService.deriveKeysFromMnemonic(words)

      // Initialize Megolm service with encryption key
      await megolmService.initialize(this.currentUserId, derivedKeys.encryptionKey)

      // Ensure identity key pair exists
      await this.ensureIdentityKeyPair()

      // Try to restore from backup
      try {
        const result = await megolmKeyBackupService.restoreFromBackup()
        if (result.outboundCount + result.inboundCount > 0) {
          console.log(`📥 Restored ${result.outboundCount + result.inboundCount} sessions from backup`)
        }
      } catch (error) {
        // Ignore backup restore errors during auto-unlock
      }

      console.log('✅ Auto-unlocked encryption from stored session')
      return true
    } catch (error) {
      console.warn('⚠️ Failed to auto-unlock:', error)
      sessionStorage.removeItem(`megolm_session_${this.currentUserId}`)
      return false
    }
  }

  /**
   * Store session for auto-unlock on page refresh
   */
  private storeSession(words: string[]): void {
    if (!this.currentUserId) return
    
    // Store encoded mnemonic in sessionStorage (survives page refresh, cleared on tab close)
    const encoded = btoa(JSON.stringify(words))
    sessionStorage.setItem(`megolm_session_${this.currentUserId}`, encoded)
    console.log('🔐 Session stored for auto-unlock')
  }

  /**
   * Clear stored session (lock encryption)
   */
  lockEncryption(): void {
    if (this.currentUserId) {
      sessionStorage.removeItem(`megolm_session_${this.currentUserId}`)
    }
    megolmService.close()
    recoveryKeyService.clear()
    console.log('🔒 Encryption locked')
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

    // Ensure identity key pair exists
    await this.ensureIdentityKeyPair()

    // Try to restore from backup
    try {
      const result = await megolmKeyBackupService.restoreFromBackup()
      console.log(`📥 Restored ${result.outboundCount + result.inboundCount} sessions from backup`)
    } catch (error) {
      console.log('ℹ️ No backup to restore or restore failed:', error)
    }

    // Claim any pending session shares
    try {
      const claimedCount = await this.claimPendingSessionShares()
      if (claimedCount > 0) {
        console.log(`📥 Claimed ${claimedCount} pending session shares`)
      }
    } catch (error) {
      console.warn('⚠️ Failed to claim pending session shares:', error)
    }

    // Store session for auto-unlock on page refresh
    this.storeSession(words)

    console.log('✅ Encryption initialized with recovery key')
  }

  /**
   * Setup new encryption with a fresh recovery key
   * Returns the generated recovery words
   */
  async setupNewEncryption(): Promise<string[]> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    // Generate new recovery mnemonic
    const words = recoveryKeyService.generateMnemonic(12)
    
    // Complete setup with the generated words
    await this.completeSetupWithWords(words)

    console.log('✅ New encryption setup complete')
    return words
  }

  /**
   * Complete encryption setup with provided recovery words
   * Used when wizard generates words first, then user confirms
   */
  async completeSetupWithWords(words: string[]): Promise<void> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    console.log('🔐 Completing encryption setup...')

    // Derive keys from mnemonic
    const derivedKeys = await recoveryKeyService.deriveKeysFromMnemonic(words)

    // Initialize Megolm service
    await megolmService.initialize(this.currentUserId, derivedKeys.encryptionKey)
    console.log('✅ Megolm service initialized')

    // Generate identity key pair for session key exchange
    await this.ensureIdentityKeyPair()
    console.log('✅ Identity key pair ready')

    // Initialize backup service
    await megolmKeyBackupService.initialize(this.currentUserId)

    // Generate verification code
    const verificationCode = await recoveryKeyService.generateVerificationCode()

    // Store recovery key metadata (NOT the key itself!)
    const { error } = await supabase.rpc('register_recovery_key', {
      p_user_id: this.currentUserId,
      p_verification_code: verificationCode,
      p_word_count: 12
    })
    
    if (error) {
      console.error('Failed to register recovery key:', error)
      throw new Error('Failed to register recovery key metadata')
    }
    console.log('✅ Recovery key metadata registered')

    // Create initial backup
    try {
      await megolmKeyBackupService.createBackup()
      console.log('✅ Initial backup created')
    } catch (backupError) {
      console.warn('⚠️ Failed to create initial backup:', backupError)
    }

    // Store session for auto-unlock on page refresh
    this.storeSession(words)

    console.log('🔐 Encryption setup complete!')
    console.log(`   isUnlocked: ${this.isUnlocked()}`)
    console.log(`   hasRecoveryKey: ${await this.hasRecoveryKey()}`)
  }

  /**
   * Ensure user has an identity key pair for session key exchange
   */
  private async ensureIdentityKeyPair(): Promise<void> {
    if (!this.currentUserId) return

    // Check if user already has an active key pair (use maybeSingle to avoid error)
    const { data: existingKey } = await supabase
      .from('user_key_pairs')
      .select('id')
      .eq('user_id', this.currentUserId)
      .eq('is_active', true)
      .maybeSingle()

    if (existingKey) {
      console.log('✅ Identity key pair already exists')
      return
    }

    // Generate a new ECDH key pair for session key exchange
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    )

    // Export public key as base64
    const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey)
    const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyRaw)))

    // Export and encrypt private key
    const privateKeyRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
    const privateKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(privateKeyRaw)))
    
    // Encrypt the private key with a simple encryption (recovery key based would be better)
    // For now, use a simple obfuscation that can be stored in DB
    const encryptedPrivateKey = await this.encryptPrivateKeyForStorage(privateKeyBase64)

    // Store both keys in the database
    const { error } = await supabase
      .from('user_key_pairs')
      .insert({
        user_id: this.currentUserId,
        identity_public_key: publicKeyBase64,
        identity_private_key_encrypted: encryptedPrivateKey,
        device_id: 1,
        is_active: true
      })

    if (error) {
      console.error('❌ Failed to store identity key:', error)
      throw new Error('Failed to create identity key pair')
    }

    // Also store locally for quick access
    localStorage.setItem(`megolm_identity_private_${this.currentUserId}`, privateKeyBase64)

    console.log('✅ Identity key pair created')
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
      channel_id?: string // For channel messages
      conversation_id?: string // For DMs
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

    // Get room ID from message context
    const roomId = message.channel_id || message.conversation_id || ''

    // Check encryption algorithm
    if (metadata.algorithm === 'megolm_v1') {
      return this.decryptMegolmMessage(message, roomId)
    } else if (metadata.algorithm === 'signal_protocol_v1_hybrid') {
      // Legacy Signal Protocol message - can't decrypt without old keys
      console.warn('⚠️ Legacy Signal Protocol message - cannot decrypt')
      throw new Error('Legacy encrypted message - keys no longer available')
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
    },
    roomId: string
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
    if (!megolmService.hasInboundSession(roomId, senderId, sessionId)) {
      console.log(`ℹ️ Missing inbound session ${sessionId} for room ${roomId.substring(0, 8)}..., checking for shares...`)
      await this.claimPendingSessionShares()
    }

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

    console.log(`🔐 ensureSessionShared: recipientIds = [${recipientIds.join(', ')}]`)
    console.log(`🔐 ensureSessionShared: currentUserId = ${this.currentUserId}`)

    // Get users who need the session
    const usersNeedingSession = megolmService.getUsersNeedingSession(roomId, recipientIds)

    console.log(`🔐 Users needing session: ${usersNeedingSession.length} (${usersNeedingSession.join(', ')})`)

    if (usersNeedingSession.length === 0) {
      console.log('ℹ️ All users already have the session')
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
          .maybeSingle()

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

        // Store the share - always share from index 0 so recipient can decrypt all messages
        const { error: shareError } = await supabase
          .from('megolm_session_shares')
          .upsert({
            room_id: roomId,
            session_id: sessionId,
            sender_user_id: this.currentUserId,
            recipient_user_id: userId,
            encrypted_session_key: encryptedSessionKey,
            first_known_index: 0 // Share from beginning so all messages can be decrypted
          }, {
            onConflict: 'room_id,session_id,recipient_user_id'
          })

        if (shareError) {
          console.error(`❌ Failed to store session share for ${userId}:`, shareError)
          continue
        }

        // Mark as shared in local state
        await megolmService.markSessionSharedWith(roomId, userId)
        console.log(`✅ Shared session with user ${userId.substring(0, 8)}...`)

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
   * Encrypt private key for database storage
   * Uses the recovery key derived encryption key
   */
  private async encryptPrivateKeyForStorage(privateKeyBase64: string): Promise<string> {
    // Get the encryption key from recovery key service
    const encryptionKey = recoveryKeyService.getEncryptionKey()
    
    if (!encryptionKey) {
      // If no encryption key, use a simple encoding (not ideal but works for compatibility)
      console.warn('⚠️ No encryption key available, using simple encoding for private key')
      return btoa(privateKeyBase64)
    }

    const encoder = new TextEncoder()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      encoder.encode(privateKeyBase64)
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
    if (!this.currentUserId) {
      console.log('🔐 claimPendingSessionShares: No user ID')
      return 0
    }

    console.log(`🔐 Checking for unclaimed session shares for user ${this.currentUserId}...`)

    const { data: shares, error } = await supabase
      .rpc('get_unclaimed_session_shares', { p_user_id: this.currentUserId })

    if (error) {
      console.error('❌ Error fetching session shares:', error)
      return 0
    }

    if (!shares || shares.length === 0) {
      console.log('ℹ️ No unclaimed session shares found')
      return 0
    }

    console.log(`📥 Found ${shares.length} unclaimed session shares`)

    let claimedCount = 0

    for (const share of shares) {
      try {
        console.log(`📥 Claiming session share from ${share.sender_user_id.substring(0, 8)}... for room ${share.room_id.substring(0, 8)}...`)
        
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
        console.log(`✅ Claimed session share for session ${share.session_id.substring(0, 8)}...`)
      } catch (error) {
        console.error(`❌ Failed to claim share ${share.share_id}:`, error)
      }
    }

    console.log(`📥 Claimed ${claimedCount}/${shares.length} session shares`)
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
      .maybeSingle()

    if (!myKey?.identity_public_key) {
      throw new Error('Cannot find my identity key - run encryption setup first')
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

    // Check if user has recovery key set up (use maybeSingle to avoid error on 0 rows)
    const { data: recoveryMetadata } = await supabase
      .from('recovery_key_metadata')
      .select('id, has_server_backup')
      .eq('user_id', this.currentUserId)
      .maybeSingle()

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
   * Check if encryption is unlocked (user has entered recovery key this session)
   */
  isUnlocked(): boolean {
    const unlocked = megolmService.isInitialized()
    console.log(`🔐 isUnlocked: ${unlocked}`)
    return unlocked
  }

  /**
   * Check if user has recovery key set up
   */
  async hasRecoveryKey(): Promise<boolean> {
    if (!this.currentUserId) {
      console.log('🔐 hasRecoveryKey: No user ID')
      return false
    }

    // Use maybeSingle() to avoid error when no rows exist
    const { data, error } = await supabase
      .from('recovery_key_metadata')
      .select('id')
      .eq('user_id', this.currentUserId)
      .maybeSingle()

    if (error) {
      console.warn('⚠️ hasRecoveryKey check failed:', error)
      return false
    }

    const hasKey = !!data
    console.log(`🔐 hasRecoveryKey: ${hasKey}`)
    return hasKey
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

    // Clear stored session
    sessionStorage.removeItem(`megolm_session_${this.currentUserId}`)

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
    // Clear stored session
    if (this.currentUserId) {
      sessionStorage.removeItem(`megolm_session_${this.currentUserId}`)
    }
    megolmService.close()
    recoveryKeyService.clear()
    this.currentUserId = null
    this.initialized = false
  }
}

// Export singleton
export const megolmMessageEncryptionService = MegolmMessageEncryptionService.getInstance()

