/**
 * Message Encryption Service
 * 
 * High-level service for encrypting and decrypting messages.
 * Integrates with SignalProtocolService and EncryptionKeyStore.
 * Handles:
 * - Transparent message encryption/decryption
 * - Key exchange and session management
 * - Group message encryption
 * - Server encryption policy enforcement
 */

import { signalProtocolService } from './SignalProtocolService';
import { EncryptionKeyStore } from './EncryptionKeyStore';
import { supabase } from '@/supabase';
import type { MessagePart } from '@/types';
import { debug } from '@/utils/debug'

export interface EncryptionStatus {
  enabled: boolean
  hasKeys: boolean
  needsSetup: boolean
  mode: 'disabled' | 'optional' | 'required' | 'required_local_only'
}

export interface EncryptedMessageData {
  encrypted: true
  content: MessagePart[] // Encrypted content (base64 ciphertext in text field)
  encryption_metadata: {
    algorithm: 'signal_protocol_v1_hybrid' // Hybrid: AES-GCM + Signal Protocol
    encrypted_for: string[] // User IDs this message is encrypted for
    sender_key_id: string
    timestamp: number
    encrypted_keys: Record<string, string> // Map of user_id -> encrypted symmetric key
    iv: string // Initialization vector for AES-GCM
  }
}

/**
 * Message Encryption Service
 */
export class MessageEncryptionService {
  private static instance: MessageEncryptionService
  private keyStore: EncryptionKeyStore | null = null
  private currentUserId: string | null = null
  private initialized = false

  private constructor() {}

  static getInstance(): MessageEncryptionService {
    if (!MessageEncryptionService.instance) {
      MessageEncryptionService.instance = new MessageEncryptionService()
    }
    return MessageEncryptionService.instance
  }

  // =====================================================
  // INITIALIZATION
  // =====================================================

  /**
   * Initialize the service for a user
   * @param userId - The auth user ID (from session.user.id)
   * @param password - Optional password for encryption key
   */
  async initialize(userId: string, password?: string): Promise<void> {
    // Get profile ID from database (encryption keys are stored by profile_id)
    // This is important because encrypted_keys in messages use profile_id, not auth_user_id
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', userId)
        .single()
      
      if (profile?.id) {
        this.currentUserId = profile.id
        debug.log(`🔐 Using profile ID for encryption: ${this.currentUserId} (auth: ${userId})`)
      } else {
        // Fallback to auth user ID if no profile found
        this.currentUserId = userId
        debug.warn(`⚠️ No profile found for auth user ${userId}, using auth ID as fallback`)
      }
    } catch (error) {
      debug.warn('⚠️ Failed to get profile ID, using auth user ID:', error)
      this.currentUserId = userId
    }

    // Create key store (uses auth user ID for key storage)
    this.keyStore = new EncryptionKeyStore(userId)
    await this.keyStore.initialize()

    // Try to restore encryption key from session first
    const restored = await this.keyStore.tryRestoreSessionKey()
    
    if (restored) {
      debug.log('✅ Encryption key restored from session')
    } else if (password) {
      // Set encryption key if password provided
      await this.keyStore.setEncryptionKey(password)
    } else {
      debug.log('ℹ️ Encryption service initialized without key - operations requiring encryption will need password')
    }

    // Initialize Signal Protocol Service
    await signalProtocolService.initialize(this.keyStore)

    this.initialized = true
    debug.log('✅ MessageEncryptionService initialized for user (profile ID):', this.currentUserId)
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Get the current user's profile ID (used for encryption key lookups)
   */
  getCurrentUserId(): string | null {
    return this.currentUserId
  }

  /**
   * Check if user has encryption keys set up
   */
  async hasEncryptionKeys(): Promise<boolean> {
    if (!this.currentUserId) return false

    try {
      const { data } = await supabase
        .rpc('user_has_encryption', { p_user_id: this.currentUserId })

      return data === true
    } catch (error) {
      debug.error('❌ Error checking encryption keys:', error)
      return false
    }
  }

  // =====================================================
  // KEY SETUP
  // =====================================================

  /**
   * Generate initial encryption keys for a new user
   */
  async setupEncryption(password: string): Promise<void> {
    if (!this.currentUserId) {
      throw new Error('User ID not set')
    }

    debug.log('🔐 Setting up encryption for user...')

    // Generate identity key pair
    const identityKeyPair = await signalProtocolService.generateIdentityKeyPair()
    const registrationId = await signalProtocolService.generateRegistrationId()

    // Save to database
    const { error } = await supabase
      .rpc('initialize_user_encryption', {
        p_user_id: this.currentUserId,
        p_identity_public_key: identityKeyPair.publicKey,
        p_identity_private_key_encrypted: identityKeyPair.privateKey,
        p_device_id: 'default'
      })

    if (error) {
      debug.error('❌ Failed to initialize encryption:', error)
      throw new Error(`Failed to initialize encryption: ${error.message}`)
    }

    // Save to local store
    if (!this.keyStore) {
      throw new Error('Key store not initialized')
    }

    await this.keyStore.setEncryptionKey(password)

    // Convert base64 keys to ArrayBuffer for storage
    const keyPair = {
      pubKey: this.base64ToArrayBuffer(identityKeyPair.publicKey),
      privKey: this.base64ToArrayBuffer(identityKeyPair.privateKey)
    }
    await this.keyStore.saveIdentityKeyPair(keyPair, registrationId)

    // Generate prekeys
    await this.generatePrekeys()

    debug.log('✅ Encryption setup complete')
  }

  /**
   * Generate prekeys and upload to server
   */
  async generatePrekeys(): Promise<void> {
    if (!this.currentUserId || !this.keyStore) {
      throw new Error('Not initialized')
    }

    debug.log('🔑 Generating prekeys...')

    // Delete existing prekeys first to avoid conflicts
    await supabase
      .from('prekeys')
      .delete()
      .eq('user_id', this.currentUserId)
      .eq('device_id', 'default')

    // LOAD existing identity key from store instead of generating new one!
    // Using a different identity key than what's in user_key_pairs will cause signature verification failures
    const identityKeyPair = await this.keyStore.getIdentityKeyPair()
    if (!identityKeyPair) {
      throw new Error('Identity key not found in store - cannot generate prekeys')
    }

    // Generate signed prekey using the existing identity key
    const signedPreKey = await signalProtocolService.generateSignedPreKey(
      { 
        publicKey: this.arrayBufferToBase64(identityKeyPair.pubKey),
        privateKey: this.arrayBufferToBase64(identityKeyPair.privKey)
      },
      1
    )

    // Store signed prekey locally in IndexedDB for decryption
    await this.keyStore.storeSignedPreKey(
      signedPreKey.id,
      {
        pubKey: this.base64ToArrayBuffer(signedPreKey.keyPair.publicKey),
        privKey: this.base64ToArrayBuffer(signedPreKey.keyPair.privateKey)
      }
    )

    // Generate one-time prekeys (100 keys) - start from 2 to avoid clobbering signed prekey id
    const preKeys = await signalProtocolService.generatePreKeys(2, 100)

    // Store prekeys locally in IndexedDB for decryption
    for (const preKey of preKeys) {
      await this.keyStore.storePreKey(
        preKey.id,
        {
          pubKey: this.base64ToArrayBuffer(preKey.keyPair.publicKey),
          privKey: this.base64ToArrayBuffer(preKey.keyPair.privateKey)
        }
      )
    }

    // Save signed prekey to database with upsert
    // IMPORTANT: Must explicitly set is_one_time: false to prevent it being returned as a one-time prekey!
    const { error: signedKeyError } = await supabase.from('prekeys').upsert({
      user_id: this.currentUserId,
      device_id: 'default',
      prekey_id: signedPreKey.id,
      public_key: signedPreKey.keyPair.publicKey,
      is_signed: true,
      is_one_time: false,  // Explicitly false - signed prekeys are NOT one-time prekeys
      signature: signedPreKey.signature
    }, { onConflict: 'user_id, device_id, prekey_id' })

    if (signedKeyError) {
      debug.error('❌ Failed to save signed prekey:', signedKeyError)
      throw new Error(`Failed to save signed prekey: ${signedKeyError.message}`)
    }

    // Save one-time prekeys to database (batch upsert)
    const prekeyData = preKeys.map(pk => ({
      user_id: this.currentUserId,
      device_id: 'default',
      prekey_id: pk.id,
      public_key: pk.keyPair.publicKey,
      is_signed: false,
      is_one_time: true
    }))

    // Insert in batches of 50
    for (let i = 0; i < prekeyData.length; i += 50) {
      const batch = prekeyData.slice(i, i + 50)
      await supabase.from('prekeys').upsert(batch, { onConflict: 'user_id, device_id, prekey_id' })
    }

    debug.log('✅ Generated and uploaded prekeys')
  }

  // =====================================================
  // ENCRYPTION / DECRYPTION (HYBRID)
  // =====================================================

  /**
   * Encrypt message content using hybrid encryption
   * 1. Generate random AES-256-GCM key
   * 2. Encrypt message with AES key → store in content
   * 3. Encrypt AES key for each recipient with Signal → store in metadata
   */
  async encryptMessage(
    content: MessagePart[],
    recipientIds: string[]
  ): Promise<EncryptedMessageData> {
    if (!this.currentUserId || !this.keyStore) {
      throw new Error('Not initialized')
    }

    // Check if we have recipients other than self
    const hasOtherRecipients = recipientIds.some(id => id !== this.currentUserId)
    
    // If encrypting for others, we need the encryption key to access our identity key
    if (hasOtherRecipients && !this.keyStore.hasEncryptionKeyLoaded()) {
      debug.error('❌ Cannot encrypt for other users without encryption password')
      throw new Error('Encryption password required. Please unlock encryption in Settings > Encryption to send encrypted messages to others.')
    }

    debug.log(`🔐 Encrypting message (hybrid) for ${recipientIds.length} recipients`)

    // Step 1: Generate random 256-bit symmetric key for AES-GCM
    const symmetricKey = crypto.getRandomValues(new Uint8Array(32))
    const iv = crypto.getRandomValues(new Uint8Array(12)) // 96-bit IV for GCM
    
    // Step 2: Encrypt the message content with AES-GCM
    const plaintextContent = JSON.stringify(content)
    const encoder = new TextEncoder()
    const plaintextBuffer = encoder.encode(plaintextContent)
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      symmetricKey,
      { name: 'AES-GCM' },
      false,
      ['encrypt']
    )
    
    const encryptedBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      plaintextBuffer
    )
    
    // Convert to base64 for storage
    const encryptedBase64 = this.arrayBufferToBase64(encryptedBuffer)
    const ivBase64 = this.arrayBufferToBase64(iv.buffer)
    
    // Step 3: Encrypt the symmetric key for each recipient using Signal Protocol
    const encryptedKeys: Record<string, string> = {}
    const symmetricKeyBase64 = this.arrayBufferToBase64(symmetricKey.buffer)
    
    for (const recipientId of recipientIds) {
      // Special case: For self-encryption, just store the key directly (no Signal Protocol needed)
      if (recipientId === this.currentUserId) {
        debug.log(`🔐 [${recipientId}] Using direct key storage (self)`)
        encryptedKeys[recipientId] = JSON.stringify({
          type: 'direct',
          key: symmetricKeyBase64
        })
        continue
      }
      
      try {
        debug.log(`🔐 [${recipientId}] Encrypting with Signal Protocol...`)
        const recipientAddress = `${recipientId}:1`
        const hasSession = await signalProtocolService.hasSession(recipientAddress)
        debug.log(`🔐 [${recipientId}] Has existing session: ${hasSession}`)
        
        if (!hasSession) {
          debug.log(`🔐 [${recipientId}] Establishing new session...`)
          await this.establishSession(recipientId)
          debug.log(`🔐 [${recipientId}] Session established successfully`)
        }

        const encryptedKey = await signalProtocolService.encryptMessage(
          recipientAddress,
          symmetricKeyBase64
        )
        debug.log(`🔐 [${recipientId}] Key encrypted successfully, type: ${encryptedKey.type}`)

        encryptedKeys[recipientId] = JSON.stringify(encryptedKey)
      } catch (error: any) {
        debug.error(`❌ [${recipientId}] Failed to encrypt for recipient:`, error.message)
        // Skip this recipient but continue with others
      }
    }

    // Store encrypted message in content as base64 text
    const encryptedContent: MessagePart[] = [{
      type: 'text',
      text: encryptedBase64
    }]

    return {
      encrypted: true,
      content: encryptedContent,
      encryption_metadata: {
        algorithm: 'signal_protocol_v1_hybrid',
        encrypted_for: recipientIds,
        sender_key_id: this.currentUserId,
        timestamp: Date.now(),
        encrypted_keys: encryptedKeys,
        iv: ivBase64
      }
    }
  }

  /**
   * Check if the encryption key (password-derived) is available for decryption
   * Without this key, prekeys can't be loaded from IndexedDB
   */
  hasEncryptionKeyLoaded(): boolean {
    if (!this.keyStore) return false
    return this.keyStore.hasEncryptionKeyLoaded()
  }

  /**
   * Unlock encryption by entering the password
   * This is needed to send/receive encrypted messages in a new session
   */
  async unlockEncryption(password: string): Promise<boolean> {
    if (!this.keyStore) {
      throw new Error('Encryption service not initialized')
    }

    try {
      await this.keyStore.setEncryptionKey(password)
      
      // Verify the key works by trying to load the identity key pair
      const identityKey = await this.keyStore.getIdentityKeyPair()
      if (!identityKey) {
        throw new Error('Invalid password - could not decrypt keys')
      }
      
      debug.log('✅ Encryption unlocked successfully')
      return true
    } catch (error: any) {
      debug.error('❌ Failed to unlock encryption:', error.message)
      // Clear the bad key
      this.keyStore.clearSessionKey()
      throw new Error('Invalid encryption password')
    }
  }

  /**
   * Check if encryption needs to be unlocked (has keys but no password loaded)
   */
  needsUnlock(): boolean {
    if (!this.keyStore) return false
    // Has stored keys but encryption key not loaded
    return !this.keyStore.hasEncryptionKeyLoaded()
  }

  /**
   * Decrypt message content using hybrid encryption
   * 1. Decrypt symmetric key using Signal Protocol
   * 2. Decrypt message content using AES-GCM
   */
  async decryptMessage(
    message: { 
      content: MessagePart[], 
      encryption_metadata?: { 
        encrypted_keys?: Record<string, string>,
        sender_key_id: string,
        iv?: string
      } 
    }
  ): Promise<MessagePart[]> {
    if (!this.currentUserId || !this.keyStore) {
      throw new Error('Not initialized')
    }

    const senderId = message.encryption_metadata?.sender_key_id
    if (!senderId) {
      throw new Error('No sender key ID in encryption metadata')
    }

    const encryptedKey = message.encryption_metadata?.encrypted_keys?.[this.currentUserId]
    const ivBase64 = message.encryption_metadata?.iv
    
    if (!encryptedKey || !ivBase64) {
      debug.log('🔐 No encrypted key or IV for current user')
      throw new Error('Missing encryption data')
    }

    debug.log(`🔓 Decrypting message (hybrid) from ${senderId}`)

    try {
      // Step 1: Decrypt the symmetric key
      const encryptedKeyData = JSON.parse(encryptedKey)
      const senderAddress = `${senderId}:1`

      debug.log(`  - Message type: ${encryptedKeyData.type}`)
      debug.log(`  - Decrypting symmetric key from address: ${senderAddress}`)
      
      let symmetricKeyBase64: string
      
      // Special case: Direct key storage for self-encrypted messages
      if (encryptedKeyData.type === 'direct') {
        debug.log('  - Using direct key (self-encrypted)')
        symmetricKeyBase64 = encryptedKeyData.key
      } else {
        // Regular Signal Protocol decryption for other users
        // IMPORTANT: This requires the user's encryption key to be loaded to access prekeys
        debug.log(`  - Using Signal Protocol decryption`)
        debug.log(`  - Encrypted key data:`, JSON.stringify(encryptedKeyData).substring(0, 100) + '...')
        debug.log(`  - Has encryption key loaded: ${this.keyStore?.hasEncryptionKeyLoaded()}`)
        
        try {
          symmetricKeyBase64 = await signalProtocolService.decryptMessage(senderAddress, encryptedKeyData)
          debug.log('  - Signal Protocol decryption successful')
        } catch (sessionError: any) {
          const errorMsg = sessionError.message || String(sessionError)
          debug.error('❌ Signal Protocol decryption error:', errorMsg)
          debug.error('  - Full error:', sessionError)
          
          // Provide more specific error messages
          if (errorMsg.includes('Encryption key not set')) {
            throw new Error('Encryption key not set - please unlock encryption with your password')
          }
          
          if (errorMsg.includes('unable to find session') || errorMsg.includes('Session not found')) {
            throw new Error('Session not found - encryption keys may need to be regenerated')
          }
          
          if (errorMsg.includes('prekey') || errorMsg.includes('PreKey')) {
            throw new Error('Prekey error - the sender may have used an outdated encryption key')
          }
          
          throw sessionError
        }
      }
      
      const symmetricKey = this.base64ToArrayBuffer(symmetricKeyBase64)
      
      // Step 2: Decrypt the message content using AES-GCM
      const encryptedBase64 = message.content[0]?.type === 'text' ? message.content[0].text : ''
      if (!encryptedBase64) {
        throw new Error('No encrypted content found')
      }
      
      const encryptedBuffer = this.base64ToArrayBuffer(encryptedBase64)
      const iv = this.base64ToArrayBuffer(ivBase64)
      
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        symmetricKey,
        { name: 'AES-GCM' },
        false,
        ['decrypt']
      )
      
      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        encryptedBuffer
      )
      
      const decoder = new TextDecoder()
      const decryptedJson = decoder.decode(decryptedBuffer)
      const decryptedContent: MessagePart[] = JSON.parse(decryptedJson)

      debug.log('✅ Message decrypted successfully (hybrid)')
      return decryptedContent
    } catch (error) {
      debug.error('❌ Decryption failed:', error)
      throw error
    }
  }

  /**
   * Encrypt a group message using hybrid encryption
   */
  async encryptGroupMessage(
    content: MessagePart[],
    groupId: string,
    recipientIds: string[]
  ): Promise<EncryptedMessageData> {
    // For now, just use regular hybrid encryption
    // Could optimize later with sender keys
    return this.encryptMessage(content, recipientIds)
  }

  /**
   * Decrypt a group message using hybrid encryption
   */
  async decryptGroupMessage(
    _encryptedContent: MessagePart[],
    _senderId: string,
    _groupId: string
  ): Promise<MessagePart[]> {
    // Not used - handled by regular decryptMessage
    throw new Error('Use decryptMessage instead')
  }

  // =====================================================
  // SESSION MANAGEMENT
  // =====================================================

  /**
   * Establish an encryption session with a recipient
   */
  private async establishSession(recipientId: string): Promise<void> {
    debug.log(`🤝 Establishing session with ${recipientId}`)

    // Fetch prekey bundle from server
    const { data: bundle, error } = await supabase
      .rpc('get_user_prekey_bundle', {
        p_user_id: recipientId,
        p_device_id: 'default'
      })

    if (error || !bundle) {
      throw new Error(`Failed to fetch prekey bundle: ${error?.message}`)
    }

    debug.log('📦 Prekey bundle from database:', bundle)

    if (!bundle.signed_prekey) {
      throw new Error(`Recipient ${recipientId} has invalid encryption keys (missing signed prekey)`)
    }

    // Transform database format to the format expected by the library
    const transformedBundle: any = {
      identityKey: bundle.identity_key,
      registrationId: bundle.registration_id || 1,
      deviceId: 1,
      signedPreKey: {
        id: bundle.signed_prekey.id,
        publicKey: bundle.signed_prekey.public_key,
        signature: bundle.signed_prekey.signature
      },
      oneTimePreKey: bundle.one_time_prekey ? {
        id: bundle.one_time_prekey.id,
        publicKey: bundle.one_time_prekey.public_key
      } : undefined
    }

    debug.log('🔄 Transformed bundle:', transformedBundle)

    // Process the prekey bundle to establish session
    await signalProtocolService.createSessionFromPreKeyBundle(
      `${recipientId}:1`,
      transformedBundle
    )

    debug.log(`✅ Session established with ${recipientId}`)
  }

  // =====================================================
  // POLICY CHECKING
  // =====================================================

  /**
   * Check if encryption is required for a server
   */
  async checkServerEncryptionPolicy(serverId: string): Promise<EncryptionStatus> {
    const { data: policy, error } = await supabase
      .rpc('check_encryption_policy', { p_server_id: serverId })

    if (error) {
      debug.error('❌ Error checking encryption policy:', error)
      return {
        enabled: false,
        hasKeys: false,
        needsSetup: true,
        mode: 'optional'
      }
    }

    const hasKeys = await this.hasEncryptionKeys()
    const mode = policy?.encryption_mode || 'optional'
    const isEncrypted = policy?.is_encrypted || false

    return {
      enabled: isEncrypted,
      hasKeys,
      needsSetup: isEncrypted && !hasKeys,
      mode
    }
  }

  /**
   * Check if conversation has encryption enabled
   */
  async checkConversationEncryption(conversationId: string): Promise<EncryptionStatus> {
    const { data: status, error } = await supabase
      .rpc('get_conversation_encryption_status', { p_conversation_id: conversationId })

    if (error) {
      debug.error('❌ Error checking conversation encryption:', error)
      return {
        enabled: false,
        hasKeys: false,
        needsSetup: true,
        mode: 'optional'
      }
    }

    const hasKeys = await this.hasEncryptionKeys()
    const encryptionEnabled = status?.encryption_enabled || false

    return {
      enabled: encryptionEnabled,
      hasKeys,
      needsSetup: encryptionEnabled && !hasKeys,
      mode: encryptionEnabled ? 'required' : 'optional'
    }
  }

  /**
   * Enable encryption for a conversation
   */
  async enableConversationEncryption(conversationId: string): Promise<void> {
    const { error } = await supabase
      .rpc('enable_conversation_encryption', { p_conversation_id: conversationId })

    if (error) {
      throw new Error(`Failed to enable encryption: ${error.message}`)
    }

    debug.log(`✅ Encryption enabled for conversation ${conversationId}`)
  }

  // =====================================================
  // UTILITIES
  // =====================================================

  /**
   * Check if content is encrypted
   */
  isEncryptedContent(message: { encrypted?: boolean }): boolean {
    return message.encrypted === true
  }

  /**
   * Get encryption status for UI display
   */
  async getEncryptionStatus(): Promise<{
    available: boolean
    hasKeys: boolean
    keyCount: number
  }> {
    if (!this.currentUserId) {
      return { available: false, hasKeys: false, keyCount: 0 }
    }

    const hasKeys = await this.hasEncryptionKeys()

    // Get unused prekey count
    let keyCount = 0
    if (hasKeys) {
      const { count } = await supabase
        .from('prekeys')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', this.currentUserId)
        .eq('is_used', false)
        .eq('is_one_time', true)

      keyCount = count || 0
    }

    return {
      available: this.initialized,
      hasKeys,
      keyCount
    }
  }

  /**
   * Rotate prekeys (periodic maintenance)
   */
  async rotatePrekeys(): Promise<void> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    const { data, error } = await supabase
      .rpc('rotate_prekeys', {
        p_user_id: this.currentUserId,
        p_device_id: 'default'
      })

    if (error) {
      throw new Error(`Failed to rotate prekeys: ${error.message}`)
    }

    debug.log('✅ Prekeys rotated:', data)

    // Check if we need to generate more prekeys
    const remaining = data?.remaining_unused_prekeys || 0
    if (remaining < 20) {
      debug.log('📊 Low prekey count, generating more...')
      await this.generatePrekeys()
    }
  }

  // =====================================================
  // HELPER METHODS
  // =====================================================

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    try {
      // Handle URL-safe base64 if present
      const normalizedBase64 = base64.replace(/-/g, '+').replace(/_/g, '/')
      const binary = atob(normalizedBase64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
      }
      return bytes.buffer
    } catch (error) {
      debug.error('❌ Invalid base64 string:', base64?.substring(0, 50) + '...')
      throw new Error('Invalid encrypted data format - message may be corrupted or from deleted keys')
    }
  }

  // =====================================================
  // BACKUP & RECOVERY
  // =====================================================

  /**
   * Export encryption keys as an encrypted backup file
   * @param backupPassword Password to encrypt the backup (can be different from main password)
   * @returns Base64 encoded encrypted backup data
   */
  async exportBackup(backupPassword: string): Promise<string> {
    if (!this.keyStore) {
      throw new Error('Encryption not initialized')
    }
    
    return await this.keyStore.exportBackup(backupPassword)
  }

  /**
   * Import and restore encryption keys from a backup
   * @param encryptedBackup The encrypted backup data
   * @param backupPassword The password used to encrypt the backup
   * @param mainPassword The main encryption password to re-derive the encryption key
   */
  async importBackup(encryptedBackup: string, backupPassword: string, mainPassword: string): Promise<void> {
    if (!this.keyStore) {
      throw new Error('Encryption not initialized')
    }

    // First, set the main encryption key
    await this.keyStore.setEncryptionKey(mainPassword)
    
    // Then import the backup
    await this.keyStore.importBackup(encryptedBackup, backupPassword)
    
    debug.log('✅ Backup imported and encryption restored')
  }

  /**
   * Check if user has stored encryption keys
   */
  async hasStoredKeys(): Promise<boolean> {
    if (!this.keyStore) {
      return false
    }
    return await this.keyStore.hasStoredKeys()
  }

  // =====================================================
  // RESET ENCRYPTION
  // =====================================================

  /**
   * Completely reset encryption for the current user
   * This deletes all keys from the database AND local IndexedDB
   * After this, the user can set up encryption fresh
   */
  async resetEncryption(): Promise<void> {
    if (!this.currentUserId) {
      throw new Error('Not initialized - cannot reset encryption')
    }

    debug.log('⚠️ Resetting encryption for user:', this.currentUserId)

    try {
      // 1. Delete keys from database using the reset function
      const { data, error } = await supabase
        .rpc('reset_user_encryption', {
          p_user_id: this.currentUserId,
          p_device_id: 'default'
        })

      if (error) {
        debug.error('❌ Failed to reset encryption in database:', error)
        throw new Error(`Database reset failed: ${error.message}`)
      }

      debug.log('✅ Database keys deleted:', data)

      // 2. Clear local IndexedDB
      if (this.keyStore) {
        await this.keyStore.clearAllData()
        this.keyStore.close()
        this.keyStore = null
      }

      // 3. Reset service state
      this.currentUserId = null
      this.initialized = false

      debug.log('✅ Encryption fully reset - user can now set up encryption again')
    } catch (error) {
      debug.error('❌ Failed to reset encryption:', error)
      throw error
    }
  }

  // =====================================================
  // CLEANUP
  // =====================================================

  /**
   * Close and cleanup (does NOT delete keys - just cleans up memory/connections)
   */
  async cleanup(): Promise<void> {
    if (this.keyStore) {
      this.keyStore.close()
      this.keyStore = null
    }

    this.currentUserId = null
    this.initialized = false

    debug.log('✅ MessageEncryptionService cleaned up')
  }
}

// Export singleton instance
export const messageEncryptionService = MessageEncryptionService.getInstance()

