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
   */
  async initialize(userId: string, password?: string): Promise<void> {
    this.currentUserId = userId

    // Create key store
    this.keyStore = new EncryptionKeyStore(userId)
    await this.keyStore.initialize()

    // Try to restore encryption key from session first
    const restored = await this.keyStore.tryRestoreSessionKey()
    
    if (restored) {
      console.log('✅ Encryption key restored from session')
    } else if (password) {
      // Set encryption key if password provided
      await this.keyStore.setEncryptionKey(password)
    } else {
      console.log('ℹ️ Encryption service initialized without key - operations requiring encryption will need password')
    }

    // Initialize Signal Protocol Service
    await signalProtocolService.initialize(this.keyStore)

    this.initialized = true
    console.log('✅ MessageEncryptionService initialized for user', userId)
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized
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
      console.error('❌ Error checking encryption keys:', error)
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

    console.log('🔐 Setting up encryption for user...')

    // Generate identity key pair
    const identityKeyPair = await signalProtocolService.generateIdentityKeyPair()
    const registrationId = await signalProtocolService.generateRegistrationId()

    // Save to database
    const { data, error } = await supabase
      .rpc('initialize_user_encryption', {
        p_user_id: this.currentUserId,
        p_identity_public_key: identityKeyPair.publicKey,
        p_identity_private_key_encrypted: identityKeyPair.privateKey,
        p_device_id: 'default'
      })

    if (error) {
      console.error('❌ Failed to initialize encryption:', error)
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

    console.log('✅ Encryption setup complete')
  }

  /**
   * Generate prekeys and upload to server
   */
  async generatePrekeys(): Promise<void> {
    if (!this.currentUserId || !this.keyStore) {
      throw new Error('Not initialized')
    }

    console.log('🔑 Generating prekeys...')

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
    const { error: signedKeyError } = await supabase.from('prekeys').upsert({
      user_id: this.currentUserId,
      device_id: 'default',
      prekey_id: signedPreKey.id,
      public_key: signedPreKey.keyPair.publicKey,
      is_signed: true,
      signature: signedPreKey.signature
    }, { onConflict: 'user_id, device_id, prekey_id' })

    if (signedKeyError) {
      console.error('❌ Failed to save signed prekey:', signedKeyError)
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

    console.log('✅ Generated and uploaded prekeys')
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

    console.log(`🔐 Encrypting message (hybrid) for ${recipientIds.length} recipients`)

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
        encryptedKeys[recipientId] = JSON.stringify({
          type: 'direct',
          key: symmetricKeyBase64
        })
        continue
      }
      
      const recipientAddress = `${recipientId}:1`
      const hasSession = await signalProtocolService.hasSession(recipientAddress)
      if (!hasSession) {
        await this.establishSession(recipientId)
      }

      const encryptedKey = await signalProtocolService.encryptMessage(
        recipientAddress,
        symmetricKeyBase64
      )

      encryptedKeys[recipientId] = JSON.stringify(encryptedKey)
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
      console.log('🔐 No encrypted key or IV for current user')
      throw new Error('Missing encryption data')
    }

    console.log(`🔓 Decrypting message (hybrid) from ${senderId}`)

    try {
      // Step 1: Decrypt the symmetric key
      const encryptedKeyData = JSON.parse(encryptedKey)
      const senderAddress = `${senderId}:1`

      console.log(`  - Message type: ${encryptedKeyData.type}`)
      console.log(`  - Decrypting symmetric key from address: ${senderAddress}`)
      
      let symmetricKeyBase64: string
      
      // Special case: Direct key storage for self-encrypted messages
      if (encryptedKeyData.type === 'direct') {
        console.log('  - Using direct key (self-encrypted)')
        symmetricKeyBase64 = encryptedKeyData.key
      } else {
        // Regular Signal Protocol decryption for other users
        try {
          symmetricKeyBase64 = await signalProtocolService.decryptMessage(senderAddress, encryptedKeyData)
        } catch (sessionError: any) {
          // If session doesn't exist, the session might have been cleared
          console.error('❌ Session error:', sessionError.message)
          
          if (sessionError.message?.includes('unable to find session')) {
            throw new Error('Session not found - encryption keys may have been cleared. Try re-initializing encryption.')
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

      console.log('✅ Message decrypted successfully (hybrid)')
      return decryptedContent
    } catch (error) {
      console.error('❌ Decryption failed:', error)
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
    encryptedContent: MessagePart[],
    senderId: string,
    groupId: string
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
    console.log(`🤝 Establishing session with ${recipientId}`)

    // Fetch prekey bundle from server
    const { data: bundle, error } = await supabase
      .rpc('get_user_prekey_bundle', {
        p_user_id: recipientId,
        p_device_id: 'default'
      })

    if (error || !bundle) {
      throw new Error(`Failed to fetch prekey bundle: ${error?.message}`)
    }

    console.log('📦 Prekey bundle from database:', bundle)

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

    console.log('🔄 Transformed bundle:', transformedBundle)

    // Process the prekey bundle to establish session
    await signalProtocolService.createSessionFromPreKeyBundle(
      `${recipientId}:1`,
      transformedBundle
    )

    console.log(`✅ Session established with ${recipientId}`)
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
      console.error('❌ Error checking encryption policy:', error)
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
      console.error('❌ Error checking conversation encryption:', error)
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

    console.log(`✅ Encryption enabled for conversation ${conversationId}`)
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

    console.log('✅ Prekeys rotated:', data)

    // Check if we need to generate more prekeys
    const remaining = data?.remaining_unused_prekeys || 0
    if (remaining < 20) {
      console.log('📊 Low prekey count, generating more...')
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
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
  }

  // =====================================================
  // CLEANUP
  // =====================================================

  /**
   * Close and cleanup
   */
  async cleanup(): Promise<void> {
    if (this.keyStore) {
      this.keyStore.close()
      this.keyStore = null
    }

    this.currentUserId = null
    this.initialized = false

    console.log('✅ MessageEncryptionService cleaned up')
  }
}

// Export singleton instance
export const messageEncryptionService = MessageEncryptionService.getInstance()

