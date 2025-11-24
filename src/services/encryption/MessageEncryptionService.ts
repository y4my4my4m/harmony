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
  content: MessagePart[] // Encrypted content
  encryption_metadata: {
    algorithm: 'signal_protocol_v1'
    encrypted_for: string[] // User IDs this message is encrypted for
    sender_key_id: string
    timestamp: number
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

    const identityKeyPair = await signalProtocolService.generateIdentityKeyPair()

    // Generate signed prekey
    const signedPreKey = await signalProtocolService.generateSignedPreKey(
      identityKeyPair,
      1
    )

    // Generate one-time prekeys (100 keys)
    const preKeys = await signalProtocolService.generatePreKeys(1, 100)

    // Save signed prekey to database
    await supabase.from('prekeys').insert({
      user_id: this.currentUserId,
      device_id: 'default',
      prekey_id: signedPreKey.id,
      public_key: signedPreKey.keyPair.publicKey,
      is_signed: true,
      signature: signedPreKey.signature
    })

    // Save one-time prekeys to database (batch insert)
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
      await supabase.from('prekeys').insert(batch)
    }

    console.log('✅ Generated and uploaded prekeys')
  }

  // =====================================================
  // ENCRYPTION / DECRYPTION
  // =====================================================

  /**
   * Encrypt message content for recipients
   * Encrypts text and URLs within MessageParts while preserving structure
   */
  async encryptMessage(
    content: MessagePart[],
    recipientIds: string[]
  ): Promise<EncryptedMessageData> {
    if (!this.currentUserId || !this.keyStore) {
      throw new Error('Not initialized')
    }

    console.log(`🔐 Encrypting message for ${recipientIds.length} recipients`)

    // Process each message part
    const encryptedContent: MessagePart[] = []

    for (const part of content) {
      if (part.type === 'text' && part.text) {
        // Encrypt text content for each recipient
        const encryptedForRecipients: Record<string, string> = {}

        for (const recipientId of recipientIds) {
          const recipientAddress = `${recipientId}:1`

          // Check if we have a session with this recipient
          const hasSession = await signalProtocolService.hasSession(recipientAddress)
          if (!hasSession) {
            await this.establishSession(recipientId)
          }

          // Encrypt the text
          const encryptedMsg = await signalProtocolService.encryptMessage(
            recipientAddress,
            part.text
          )

          encryptedForRecipients[recipientId] = JSON.stringify(encryptedMsg)
        }

        // Keep the structure but mark as encrypted_text with payloads
        encryptedContent.push({
          type: 'encrypted_text',
          encrypted_payloads: encryptedForRecipients
        })
      } else if (part.type === 'url' && part.url) {
        // Encrypt URLs for each recipient
        const encryptedForRecipients: Record<string, string> = {}

        for (const recipientId of recipientIds) {
          const recipientAddress = `${recipientId}:1`

          const hasSession = await signalProtocolService.hasSession(recipientAddress)
          if (!hasSession) {
            await this.establishSession(recipientId)
          }

          const encryptedMsg = await signalProtocolService.encryptMessage(
            recipientAddress,
            part.url
          )

          encryptedForRecipients[recipientId] = JSON.stringify(encryptedMsg)
        }

        encryptedContent.push({
          type: 'encrypted_url',
          encrypted_payloads: encryptedForRecipients
        })
      } else {
        // Non-sensitive parts (emoji, mention, system) - keep as-is
        encryptedContent.push(part)
      }
    }

    return {
      encrypted: true,
      content: encryptedContent,
      encryption_metadata: {
        algorithm: 'signal_protocol_v1',
        encrypted_for: recipientIds,
        sender_key_id: this.currentUserId,
        timestamp: Date.now()
      }
    }
  }

  /**
   * Decrypt message content
   */
  async decryptMessage(
    encryptedContent: MessagePart[],
    senderId: string
  ): Promise<MessagePart[]> {
    if (!this.currentUserId || !this.keyStore) {
      throw new Error('Not initialized')
    }

    console.log(`🔓 Decrypting message from ${senderId}`)

    // Extract encrypted payload for current user
    const encryptedPart = encryptedContent[0]
    if (!encryptedPart || encryptedPart.type !== 'encrypted') {
      throw new Error('Invalid encrypted message format')
    }

    const encryptedPayload = encryptedPart.encrypted_payloads?.[this.currentUserId]
    if (!encryptedPayload) {
      throw new Error('No encrypted payload found for current user')
    }

    // Parse the encrypted message
    const encryptedMsg = JSON.parse(encryptedPayload)
    const senderAddress = `${senderId}:1`

    // Decrypt the message
    const plaintext = await signalProtocolService.decryptMessage(
      senderAddress,
      encryptedMsg
    )

    // Parse decrypted content back to MessagePart[]
    const content: MessagePart[] = JSON.parse(plaintext)

    console.log('✅ Message decrypted successfully')
    return content
  }

  /**
   * Encrypt a group message using Sender Keys
   */
  async encryptGroupMessage(
    content: MessagePart[],
    groupId: string,
    recipientIds: string[]
  ): Promise<EncryptedMessageData> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    console.log(`🔐 Encrypting group message for group ${groupId}`)

    const plaintext = JSON.stringify(content)

    // Encrypt using sender keys (more efficient for groups)
    const encryptedBody = await signalProtocolService.encryptGroupMessage(
      groupId,
      this.currentUserId,
      plaintext
    )

    const encryptedContent: MessagePart[] = [{
      type: 'encrypted_group',
      group_id: groupId,
      encrypted_body: encryptedBody
    }]

    return {
      encrypted: true,
      content: encryptedContent,
      encryption_metadata: {
        algorithm: 'signal_protocol_v1',
        encrypted_for: recipientIds,
        sender_key_id: this.currentUserId,
        timestamp: Date.now()
      }
    }
  }

  /**
   * Decrypt a group message
   */
  async decryptGroupMessage(
    encryptedContent: MessagePart[],
    senderId: string,
    groupId: string
  ): Promise<MessagePart[]> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    console.log(`🔓 Decrypting group message from ${senderId}`)

    const encryptedPart = encryptedContent[0]
    if (!encryptedPart || encryptedPart.type !== 'encrypted_group') {
      throw new Error('Invalid encrypted group message format')
    }

    const encryptedBody = encryptedPart.encrypted_body
    if (!encryptedBody) {
      throw new Error('No encrypted body found')
    }

    const senderAddress = `${senderId}:1`

    // Decrypt the message
    const plaintext = await signalProtocolService.decryptGroupMessage(
      senderAddress,
      groupId,
      encryptedBody
    )

    const content: MessagePart[] = JSON.parse(plaintext)

    console.log('✅ Group message decrypted successfully')
    return content
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

    // Process the prekey bundle to establish session
    await signalProtocolService.processPreKeyBundle(
      `${recipientId}:1`,
      {
        identityKey: bundle.identity_key,
        registrationId: bundle.registration_id || 1,
        deviceId: 1,
        signedPreKey: bundle.signed_prekey,
        oneTimePreKey: bundle.one_time_prekey
      }
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
  isEncryptedContent(content: MessagePart[]): boolean {
    return content.length > 0 && 
           (content[0].type === 'encrypted' || content[0].type === 'encrypted_group')
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

