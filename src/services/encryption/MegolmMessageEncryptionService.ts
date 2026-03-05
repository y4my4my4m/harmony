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
import { secureSessionKeyStore } from './SecureSessionKeyStore'
import type { MessagePart } from '@/types'
import { debug } from '@/utils/debug'

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
        debug.log(`🔐 MegolmMessageEncryptionService: Using profile ID ${this.currentUserId}`)
      } else {
        this.currentUserId = authUserId
        debug.warn(`⚠️ No profile found for auth user ${authUserId}`)
      }
    } catch (error) {
      debug.warn('⚠️ Failed to get profile ID:', error)
      this.currentUserId = authUserId
    }

    // Initialize backup service (includes realtime key request subscriptions)
    if (this.currentUserId) {
      await megolmKeyBackupService.initialize(this.currentUserId)
      
      // Register callback for when keys are received via realtime
      megolmKeyBackupService.onKeyReceived((roomId, sessionId) => {
        debug.log(`🔑 Key received for room ${roomId.substring(0, 8)}..., session ${sessionId.substring(0, 8)}...`)
        // Emit event for UI to retry decryption
        window.dispatchEvent(new CustomEvent('megolm-key-received', { 
          detail: { roomId, sessionId } 
        }))
      })
    }

    this.initialized = true
    debug.log('✅ MegolmMessageEncryptionService initialized')

    // Try to auto-unlock from session storage (persists across page refresh)
    await this.tryAutoUnlock()
  }

  /**
   * Try to auto-unlock encryption from stored session
   */
  private async tryAutoUnlock(): Promise<boolean> {
    if (!this.currentUserId) return false

    try {
      // Try IndexedDB first (non-extractable CryptoKeys — preferred)
      const storedKeys = await secureSessionKeyStore.load(this.currentUserId)
      if (storedKeys) {
        debug.log('🔐 Found stored CryptoKeys in IndexedDB — auto-unlocking...')

        // Set derived keys directly (no mnemonic needed)
        recoveryKeyService.setDerivedKeys(storedKeys)

        // Initialize Megolm service with the encryption key
        await megolmService.initialize(this.currentUserId, storedKeys.encryptionKey)
        await this.ensureIdentityKeyPair()

        try {
          const result = await megolmKeyBackupService.restoreFromBackup()
          if (result.outboundCount + result.inboundCount > 0) {
            debug.log(`📥 Restored ${result.outboundCount + result.inboundCount} sessions from backup`)
          }
        } catch { /* ignore */ }

        try {
          await megolmKeyBackupService.processPendingRequestsToMe()
        } catch { /* ignore */ }

        debug.log('✅ Auto-unlocked encryption from IndexedDB keys')
        return true
      }

      // Legacy fallback: migrate from localStorage/sessionStorage mnemonic
      let storedData = localStorage.getItem(`megolm_session_${this.currentUserId}`)
        || sessionStorage.getItem(`megolm_session_${this.currentUserId}`)

      if (!storedData) {
        debug.log('🔐 No stored session — encryption locked')
        return false
      }

      const words = JSON.parse(atob(storedData)) as string[]
      if (!Array.isArray(words) || words.length < 12) {
        debug.warn('⚠️ Invalid stored legacy session data')
        this.clearLegacyStorage()
        return false
      }

      debug.log('🔐 Found legacy mnemonic — migrating to IndexedDB...')
      const derivedKeys = await recoveryKeyService.deriveKeysFromMnemonic(words)
      await megolmService.initialize(this.currentUserId, derivedKeys.encryptionKey)
      await this.ensureIdentityKeyPair()

      // Migrate: store non-extractable keys in IndexedDB, then purge mnemonic
      await secureSessionKeyStore.store(this.currentUserId, derivedKeys)
      this.clearLegacyStorage()

      try {
        const result = await megolmKeyBackupService.restoreFromBackup()
        if (result.outboundCount + result.inboundCount > 0) {
          debug.log(`📥 Restored ${result.outboundCount + result.inboundCount} sessions from backup`)
        }
      } catch { /* ignore */ }

      try {
        await megolmKeyBackupService.processPendingRequestsToMe()
      } catch { /* ignore */ }

      debug.log('✅ Auto-unlocked and migrated to secure IndexedDB storage')
      return true
    } catch (error) {
      debug.warn('⚠️ Failed to auto-unlock:', error)
      return false
    }
  }

  /**
   * Store derived keys securely in IndexedDB as non-extractable CryptoKey objects.
   * The raw mnemonic is never persisted.
   */
  private async storeSessionKeys(keys: { encryptionKey: CryptoKey; backupKey: CryptoKey; signingKey: CryptoKey }): Promise<void> {
    if (!this.currentUserId) return
    await secureSessionKeyStore.store(this.currentUserId, keys)
  }

  /** Remove legacy mnemonic from localStorage/sessionStorage */
  private clearLegacyStorage(): void {
    if (!this.currentUserId) return
    localStorage.removeItem(`megolm_session_${this.currentUserId}`)
    sessionStorage.removeItem(`megolm_session_${this.currentUserId}`)
  }

  /**
   * Clear stored session (lock encryption)
   */
  async lockEncryption(): Promise<void> {
    if (this.currentUserId) {
      await secureSessionKeyStore.clear(this.currentUserId).catch(() => {})
      this.clearLegacyStorage()
    }
    megolmService.close()
    recoveryKeyService.clear()
    debug.log('🔒 Encryption locked')
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
      debug.log(`📥 Restored ${result.outboundCount + result.inboundCount} sessions from backup`)
    } catch (error) {
      debug.log('ℹ️ No backup to restore or restore failed:', error)
    }

    // Claim any pending session shares
    try {
      const claimedCount = await this.claimPendingSessionShares()
      if (claimedCount > 0) {
        debug.log(`📥 Claimed ${claimedCount} pending session shares`)
      }
    } catch (error) {
      debug.warn('⚠️ Failed to claim pending session shares:', error)
    }

    // Process any pending key requests to us (from while we were offline)
    try {
      const fulfilledCount = await megolmKeyBackupService.processPendingRequestsToMe()
      if (fulfilledCount > 0) {
        debug.log(`📤 Fulfilled ${fulfilledCount} pending key requests`)
      }
    } catch (error) {
      debug.warn('⚠️ Failed to process pending key requests:', error)
    }

    // Store non-extractable CryptoKeys in IndexedDB (mnemonic is NOT persisted)
    await this.storeSessionKeys(derivedKeys)
    this.clearLegacyStorage()

    debug.log('✅ Encryption initialized with recovery key')
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

    debug.log('✅ New encryption setup complete')
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

    debug.log('🔐 Completing encryption setup...')

    // Derive keys from mnemonic
    const derivedKeys = await recoveryKeyService.deriveKeysFromMnemonic(words)

    // Initialize Megolm service
    await megolmService.initialize(this.currentUserId, derivedKeys.encryptionKey)
    debug.log('✅ Megolm service initialized')

    // Generate identity key pair for session key exchange
    await this.ensureIdentityKeyPair()
    debug.log('✅ Identity key pair ready')

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
      debug.error('Failed to register recovery key:', error)
      throw new Error('Failed to register recovery key metadata')
    }
    debug.log('✅ Recovery key metadata registered')

    // Create initial backup
    try {
      await megolmKeyBackupService.createBackup()
      debug.log('✅ Initial backup created')
    } catch (backupError) {
      debug.warn('⚠️ Failed to create initial backup:', backupError)
    }

    // Store non-extractable CryptoKeys in IndexedDB (mnemonic is NOT persisted)
    await this.storeSessionKeys(derivedKeys)
    this.clearLegacyStorage()

    debug.log('🔐 Encryption setup complete!')
    debug.log(`   isUnlocked: ${this.isUnlocked()}`)
    debug.log(`   hasRecoveryKey: ${await this.hasRecoveryKey()}`)
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
      debug.log('✅ Identity key pair already exists')
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
      debug.error('❌ Failed to store identity key:', error)
      throw new Error('Failed to create identity key pair')
    }

    // Also store locally for quick access
    localStorage.setItem(`megolm_identity_private_${this.currentUserId}`, privateKeyBase64)

    debug.log('✅ Identity key pair created')
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

    // Serialize content
    const plaintextContent = JSON.stringify(content)

    // Encrypt with Megolm (fast - uses in-memory session key)
    const encryptedMessage = await megolmService.encryptMessage(roomId, plaintextContent)

    // Share session with recipients in the background (non-blocking)
    // This allows the message to be sent immediately while keys are shared
    this.ensureSessionShared(roomId, encryptedMessage.sessionId, recipientIds)
      .catch(err => debug.warn('⚠️ Background session sharing failed:', err))

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
      debug.warn('⚠️ Legacy Signal Protocol message - cannot decrypt')
      throw new Error('Legacy encrypted message - keys no longer available')
    }

    throw new Error(`Unsupported encryption algorithm: ${metadata.algorithm}`)
  }

  /**
   * Decrypt a Megolm-encrypted message
   * OPTIMIZED: Fast path when we have the session key in memory
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

    // FAST PATH: Try to decrypt immediately (works if we have the key in memory)
    try {
      const decryptedJson = await megolmService.decryptMessage(roomId, senderId, encryptedMessage)
      const decryptedContent: MessagePart[] = JSON.parse(decryptedJson)
      return decryptedContent
    } catch (error: any) {
      // SLOW PATH: Key not in memory, try to get it from server
      if (error.message.includes('No inbound session') || error.message.includes('No outbound session')) {
        debug.log(`ℹ️ Missing session ${sessionId.substring(0, 8)}... for room ${roomId.substring(0, 8)}..., fetching...`)
        
        // Try to claim pending session shares from server
        const claimed = await this.claimPendingSessionShares()
        
        if (claimed > 0) {
          // Retry decryption after claiming shares
          try {
            const decryptedJson = await megolmService.decryptMessage(roomId, senderId, encryptedMessage)
            const decryptedContent: MessagePart[] = JSON.parse(decryptedJson)
            return decryptedContent
          } catch {
            // Still failed - request key from sender
          }
        }
        
        // No shares available - request the key from the sender
        // The sender will receive this via realtime and auto-fulfill if they have the key
        debug.log(`📤 Requesting session key from sender ${senderId.substring(0, 8)}...`)
        megolmKeyBackupService.createKeyRequest(roomId, sessionId, senderId)
          .catch(err => debug.warn('⚠️ Key request failed:', err))
        throw new Error('Session key not available - key request sent to sender')
      }
      throw error
    }
  }


  // =====================================================
  // SESSION SHARING
  // =====================================================

  /**
   * Ensure our session is shared with all recipients
   * OPTIMIZED: Batch DB queries and parallelize operations
   */
  private async ensureSessionShared(
    roomId: string,
    sessionId: string,
    recipientIds: string[]
  ): Promise<void> {
    if (!this.currentUserId) return

    // Get users who need the session (fast in-memory check)
    const usersNeedingSession = megolmService.getUsersNeedingSession(roomId, recipientIds)

    if (usersNeedingSession.length === 0) {
      return // All users already have the session
    }

    // Get session key data
    const sessionData = megolmService.getSessionKeyForSharing(roomId)
    if (!sessionData) {
      debug.error('❌ Failed to get session data for sharing')
      return
    }

    // BATCH: Fetch ALL public keys in ONE query
    const { data: publicKeys, error: keyError } = await supabase
      .from('user_key_pairs')
      .select('user_id, identity_public_key')
      .in('user_id', usersNeedingSession)
      .eq('is_active', true)

    if (keyError) {
      debug.error('❌ Error fetching public keys:', keyError)
      return
    }

    // Create lookup map for fast access
    const keyMap = new Map<string, string>()
    for (const row of publicKeys || []) {
      if (row.identity_public_key) {
        keyMap.set(row.user_id, row.identity_public_key)
      }
    }

    const usersWithKeys = keyMap.size
    const usersWithoutKeys = usersNeedingSession.length - usersWithKeys

    if (usersWithKeys === 0) {
      if (usersWithoutKeys > 0) {
        debug.log(`ℹ️ ${usersWithoutKeys} users haven't set up encryption yet`)
      }
      return
    }

    debug.log(`📤 Sharing session with ${usersWithKeys} users...`)

    // PARALLEL: Encrypt and store shares concurrently
    const sharePromises = Array.from(keyMap.entries()).map(async ([userId, publicKey]) => {
      try {
        // Encrypt session key for this user
        const encryptedSessionKey = await this.encryptSessionKeyForUser(
          sessionData.sessionKey,
          publicKey
        )

        // Store the share
        const { error: shareError } = await supabase
          .from('megolm_session_shares')
          .upsert({
            room_id: roomId,
            session_id: sessionId,
            sender_user_id: this.currentUserId,
            recipient_user_id: userId,
            encrypted_session_key: encryptedSessionKey,
            first_known_index: 0
          }, {
            onConflict: 'room_id,session_id,recipient_user_id'
          })

        if (shareError) {
          debug.error(`❌ Failed to store session share for ${userId.substring(0, 8)}:`, shareError)
          return false
        }

        // Mark as shared in local state (sync)
        megolmService.markSessionSharedWith(roomId, userId)
        return true
      } catch (error) {
        debug.error(`❌ Failed to share session with ${userId.substring(0, 8)}:`, error)
        return false
      }
    })

    const results = await Promise.all(sharePromises)
    const successCount = results.filter(Boolean).length
    debug.log(`✅ Session shared with ${successCount}/${usersWithKeys} users`)
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
      debug.warn('⚠️ No encryption key available, using simple encoding for private key')
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
   * OPTIMIZED: Single RPC call + parallel processing
   */
  async claimPendingSessionShares(): Promise<number> {
    if (!this.currentUserId) return 0

    const { data: shares, error } = await supabase
      .rpc('get_unclaimed_session_shares', { p_user_id: this.currentUserId })

    if (error || !shares || shares.length === 0) {
      return 0
    }

    debug.log(`📥 Found ${shares.length} unclaimed session shares`)

    // Process shares in parallel
    const results = await Promise.all(shares.map(async (share: any) => {
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

        // Mark as claimed (fire and forget)
        supabase.rpc('claim_session_share', {
          p_share_id: share.share_id,
          p_user_id: this.currentUserId
        }).then(() => {}, () => {})

        return true
      } catch {
        return false
      }
    }))

    const claimedCount = results.filter(Boolean).length
    if (claimedCount > 0) {
      debug.log(`✅ Claimed ${claimedCount} session shares`)
    }
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
   * Note: No logging here as this is called frequently during message loading/rendering
   */
  isUnlocked(): boolean {
    return megolmService.isInitialized()
  }

  /**
   * Check if user has recovery key set up
   */
  async hasRecoveryKey(): Promise<boolean> {
    if (!this.currentUserId) {
      debug.log('🔐 hasRecoveryKey: No user ID')
      return false
    }

    // Use maybeSingle() to avoid error when no rows exist
    const { data, error } = await supabase
      .from('recovery_key_metadata')
      .select('id')
      .eq('user_id', this.currentUserId)
      .maybeSingle()

    if (error) {
      debug.warn('⚠️ hasRecoveryKey check failed:', error)
      return false
    }

    const hasKey = !!data
    debug.log(`🔐 hasRecoveryKey: ${hasKey}`)
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

    // Clear stored keys
    await secureSessionKeyStore.clear(this.currentUserId).catch(() => {})
    this.clearLegacyStorage()

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

    debug.log('✅ Encryption reset complete')
  }

  /**
   * Cleanup on logout
   */
  async cleanup(): Promise<void> {
    if (this.currentUserId) {
      await secureSessionKeyStore.clear(this.currentUserId).catch(() => {})
      this.clearLegacyStorage()
    }
    megolmService.close()
    recoveryKeyService.clear()
    this.currentUserId = null
    this.initialized = false
  }
}

// Export singleton
export const megolmMessageEncryptionService = MegolmMessageEncryptionService.getInstance()

