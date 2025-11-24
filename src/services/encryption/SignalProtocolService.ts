/**
 * Signal Protocol Service
 * 
 * Wrapper around @signalapp/libsignal-client for end-to-end encryption.
 * Provides high-level API for:
 * - Key generation (identity, signed prekeys, one-time prekeys)
 * - Session establishment and management
 * - Message encryption/decryption
 * - Key rotation
 */

import {
  PrivateKey,
  PublicKey,
  IdentityKeyPair,
  PreKeyBundle,
  PreKeyRecord,
  SignedPreKeyRecord,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
  processPreKeyBundle,
  SenderKeyDistributionMessage
} from '@signalapp/libsignal-client'

import type { EncryptionKeyStore } from './EncryptionKeyStore'

export interface KeyPair {
  publicKey: string // Base64 encoded
  privateKey: string // Base64 encoded
}

export interface PreKey {
  id: number
  keyPair: KeyPair
}

export interface SignedPreKey extends PreKey {
  signature: string // Base64 encoded
  timestamp: number
}

export interface PreKeyBundleData {
  identityKey: string // Base64 encoded public key
  registrationId: number
  deviceId: number
  signedPreKey: {
    id: number
    publicKey: string
    signature: string
  }
  oneTimePreKey?: {
    id: number
    publicKey: string
  }
}

export interface EncryptedMessage {
  type: 'prekey' | 'message'
  body: string // Base64 encoded ciphertext
  registrationId: number
}

/**
 * Signal Protocol Service
 * Handles all cryptographic operations for E2EE
 */
export class SignalProtocolService {
  private static instance: SignalProtocolService
  private keyStore: EncryptionKeyStore | null = null
  private initialized = false

  private constructor() {}

  static getInstance(): SignalProtocolService {
    if (!SignalProtocolService.instance) {
      SignalProtocolService.instance = new SignalProtocolService()
    }
    return SignalProtocolService.instance
  }

  /**
   * Initialize the service with a key store
   */
  async initialize(keyStore: EncryptionKeyStore): Promise<void> {
    this.keyStore = keyStore
    this.initialized = true
    console.log('✅ SignalProtocolService initialized')
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.keyStore !== null
  }

  private ensureInitialized(): void {
    if (!this.isInitialized()) {
      throw new Error('SignalProtocolService not initialized. Call initialize() first.')
    }
  }

  // =====================================================
  // KEY GENERATION
  // =====================================================

  /**
   * Generate a new identity key pair
   */
  async generateIdentityKeyPair(): Promise<KeyPair> {
    const privateKey = PrivateKey.generate()
    const publicKey = privateKey.getPublicKey()

    return {
      privateKey: this.encodeToBase64(privateKey.serialize()),
      publicKey: this.encodeToBase64(publicKey.serialize())
    }
  }

  /**
   * Generate a signed prekey
   */
  async generateSignedPreKey(
    identityKeyPair: KeyPair,
    signedPreKeyId: number
  ): Promise<SignedPreKey> {
    const identityPrivateKey = PrivateKey.deserialize(
      this.decodeFromBase64(identityKeyPair.privateKey)
    )

    const keyPair = await this.generateKeyPair()
    const publicKeyBytes = this.decodeFromBase64(keyPair.publicKey)
    const signature = identityPrivateKey.sign(publicKeyBytes)

    return {
      id: signedPreKeyId,
      keyPair,
      signature: this.encodeToBase64(signature),
      timestamp: Date.now()
    }
  }

  /**
   * Generate multiple one-time prekeys
   */
  async generatePreKeys(startId: number, count: number): Promise<PreKey[]> {
    const preKeys: PreKey[] = []

    for (let i = 0; i < count; i++) {
      const keyPair = await this.generateKeyPair()
      preKeys.push({
        id: startId + i,
        keyPair
      })
    }

    return preKeys
  }

  /**
   * Generate a registration ID (unique identifier for this device)
   */
  generateRegistrationId(): number {
    return Math.floor(Math.random() * 16380) + 1
  }

  /**
   * Helper: Generate an EC key pair
   */
  private async generateKeyPair(): Promise<KeyPair> {
    const privateKey = PrivateKey.generate()
    const publicKey = privateKey.getPublicKey()

    return {
      privateKey: this.encodeToBase64(privateKey.serialize()),
      publicKey: this.encodeToBase64(publicKey.serialize())
    }
  }

  // =====================================================
  // SESSION MANAGEMENT
  // =====================================================

  /**
   * Process a prekey bundle and establish a session
   * This is called by the sender to initiate encryption with a recipient
   */
  async processPreKeyBundle(
    recipientAddress: string,
    bundle: PreKeyBundleData
  ): Promise<void> {
    this.ensureInitialized()

    const [recipientId, deviceId] = this.parseAddress(recipientAddress)
    const address = SignalProtocolAddress.new(recipientId, deviceId)

    // Convert base64 strings to Signal Protocol objects
    const identityKey = PublicKey.deserialize(
      this.decodeFromBase64(bundle.identityKey)
    )

    const signedPreKeyPublic = PublicKey.deserialize(
      this.decodeFromBase64(bundle.signedPreKey.publicKey)
    )

    const signedPreKeySignature = this.decodeFromBase64(bundle.signedPreKey.signature)

    let oneTimePreKeyPublic: PublicKey | null = null
    if (bundle.oneTimePreKey) {
      oneTimePreKeyPublic = PublicKey.deserialize(
        this.decodeFromBase64(bundle.oneTimePreKey.publicKey)
      )
    }

    // Create PreKeyBundle
    const preKeyBundle = PreKeyBundle.new(
      bundle.registrationId,
      bundle.deviceId,
      bundle.oneTimePreKey?.id ?? null,
      oneTimePreKeyPublic,
      bundle.signedPreKey.id,
      signedPreKeyPublic,
      signedPreKeySignature,
      identityKey
    )

    // Process the bundle and create session
    await processPreKeyBundle(
      preKeyBundle,
      address,
      this.keyStore!.getSessionStore(),
      this.keyStore!.getIdentityKeyStore()
    )

    console.log(`✅ Session established with ${recipientAddress}`)
  }

  /**
   * Check if we have a session with an address
   */
  async hasSession(remoteAddress: string): Promise<boolean> {
    this.ensureInitialized()

    const [recipientId, deviceId] = this.parseAddress(remoteAddress)
    const address = SignalProtocolAddress.new(recipientId, deviceId)

    return await this.keyStore!.getSessionStore().hasSession(address)
  }

  // =====================================================
  // ENCRYPTION / DECRYPTION
  // =====================================================

  /**
   * Encrypt a message for a recipient
   */
  async encryptMessage(
    recipientAddress: string,
    plaintext: string
  ): Promise<EncryptedMessage> {
    this.ensureInitialized()

    const [recipientId, deviceId] = this.parseAddress(recipientAddress)
    const address = SignalProtocolAddress.new(recipientId, deviceId)

    // Create session cipher
    const cipher = new SessionCipher(
      address,
      this.keyStore!.getSessionStore(),
      this.keyStore!.getIdentityKeyStore()
    )

    // Encrypt the message
    const plaintextBuffer = Buffer.from(plaintext, 'utf-8')
    const ciphertext = await cipher.encrypt(plaintextBuffer)

    // Determine message type
    const messageType = ciphertext.type() === 3 ? 'prekey' : 'message'

    return {
      type: messageType,
      body: this.encodeToBase64(ciphertext.serialize()),
      registrationId: await this.keyStore!.getLocalRegistrationId()
    }
  }

  /**
   * Decrypt a message from a sender
   */
  async decryptMessage(
    senderAddress: string,
    encryptedMessage: EncryptedMessage
  ): Promise<string> {
    this.ensureInitialized()

    const [senderId, deviceId] = this.parseAddress(senderAddress)
    const address = SignalProtocolAddress.new(senderId, deviceId)

    // Create session cipher
    const cipher = new SessionCipher(
      address,
      this.keyStore!.getSessionStore(),
      this.keyStore!.getIdentityKeyStore()
    )

    let plaintextBuffer: Buffer

    // Decrypt based on message type
    if (encryptedMessage.type === 'prekey') {
      // PreKey message (first message in a conversation)
      const { PreKeySignalMessage } = await import('@signalapp/libsignal-client')
      const ciphertext = PreKeySignalMessage.deserialize(
        this.decodeFromBase64(encryptedMessage.body)
      )
      plaintextBuffer = await cipher.decryptPreKeySignalMessage(ciphertext)
    } else {
      // Regular message
      const { SignalMessage } = await import('@signalapp/libsignal-client')
      const ciphertext = SignalMessage.deserialize(
        this.decodeFromBase64(encryptedMessage.body)
      )
      plaintextBuffer = await cipher.decryptSignalMessage(ciphertext)
    }

    return plaintextBuffer.toString('utf-8')
  }

  // =====================================================
  // GROUP ENCRYPTION (Sender Key)
  // =====================================================

  /**
   * Create a sender key distribution message for group encryption
   * This allows efficient group message encryption (encrypt once, send to all)
   */
  async createSenderKeyDistributionMessage(
    groupId: string,
    senderId: string
  ): Promise<string> {
    this.ensureInitialized()

    const distributionId = this.generateDistributionId()
    const senderAddress = SignalProtocolAddress.new(senderId, 1)

    const distributionMessage = await SenderKeyDistributionMessage.create(
      senderAddress,
      distributionId,
      this.keyStore!.getSenderKeyStore()
    )

    return this.encodeToBase64(distributionMessage.serialize())
  }

  /**
   * Process a sender key distribution message
   */
  async processSenderKeyDistributionMessage(
    senderAddress: string,
    groupId: string,
    distributionMessage: string
  ): Promise<void> {
    this.ensureInitialized()

    const [senderId, deviceId] = this.parseAddress(senderAddress)
    const address = SignalProtocolAddress.new(senderId, deviceId)
    const distributionId = this.generateDistributionId()

    const message = SenderKeyDistributionMessage.deserialize(
      this.decodeFromBase64(distributionMessage)
    )

    await this.keyStore!.getSenderKeyStore().storeSenderKey(
      address,
      distributionId,
      message
    )
  }

  /**
   * Encrypt a message for a group using sender keys
   */
  async encryptGroupMessage(
    groupId: string,
    senderId: string,
    plaintext: string
  ): Promise<string> {
    this.ensureInitialized()

    const { GroupCipher } = await import('@signalapp/libsignal-client')
    const distributionId = this.generateDistributionId()
    const senderAddress = SignalProtocolAddress.new(senderId, 1)

    const cipher = new GroupCipher(
      senderAddress,
      distributionId,
      this.keyStore!.getSenderKeyStore()
    )

    const plaintextBuffer = Buffer.from(plaintext, 'utf-8')
    const ciphertext = await cipher.encrypt(plaintextBuffer)

    return this.encodeToBase64(ciphertext)
  }

  /**
   * Decrypt a group message using sender keys
   */
  async decryptGroupMessage(
    senderAddress: string,
    groupId: string,
    ciphertext: string
  ): Promise<string> {
    this.ensureInitialized()

    const { GroupCipher } = await import('@signalapp/libsignal-client')
    const [senderId, deviceId] = this.parseAddress(senderAddress)
    const address = SignalProtocolAddress.new(senderId, deviceId)
    const distributionId = this.generateDistributionId()

    const cipher = new GroupCipher(
      address,
      distributionId,
      this.keyStore!.getSenderKeyStore()
    )

    const plaintextBuffer = await cipher.decrypt(
      this.decodeFromBase64(ciphertext)
    )

    return plaintextBuffer.toString('utf-8')
  }

  // =====================================================
  // UTILITIES
  // =====================================================

  /**
   * Parse address string into ID and device ID
   * Format: "userId:deviceId" or just "userId" (defaults to device 1)
   */
  private parseAddress(address: string): [string, number] {
    const parts = address.split(':')
    const userId = parts[0]
    const deviceId = parts[1] ? parseInt(parts[1], 10) : 1
    return [userId, deviceId]
  }

  /**
   * Generate a distribution ID for sender keys
   */
  private generateDistributionId(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(16))
  }

  /**
   * Encode bytes to base64 string
   */
  encodeToBase64(data: Uint8Array | Buffer): string {
    if (data instanceof Uint8Array) {
      return Buffer.from(data).toString('base64')
    }
    return data.toString('base64')
  }

  /**
   * Decode base64 string to bytes
   */
  decodeFromBase64(base64: string): Buffer {
    return Buffer.from(base64, 'base64')
  }

  /**
   * Verify a signature
   */
  async verifySignature(
    publicKey: string,
    message: string,
    signature: string
  ): Promise<boolean> {
    try {
      const pubKey = PublicKey.deserialize(this.decodeFromBase64(publicKey))
      const messageBytes = this.decodeFromBase64(message)
      const signatureBytes = this.decodeFromBase64(signature)

      return pubKey.verify(messageBytes, signatureBytes)
    } catch (error) {
      console.error('❌ Signature verification failed:', error)
      return false
    }
  }

  /**
   * Sign data with a private key
   */
  async signData(privateKey: string, data: string): Promise<string> {
    const privKey = PrivateKey.deserialize(this.decodeFromBase64(privateKey))
    const dataBytes = this.decodeFromBase64(data)
    const signature = privKey.sign(dataBytes)

    return this.encodeToBase64(signature)
  }

  // =====================================================
  // KEY ROTATION
  // =====================================================

  /**
   * Check if keys need rotation based on age or usage
   */
  shouldRotateKeys(keyAge: number, messageCount: number): boolean {
    const MAX_KEY_AGE_DAYS = 90
    const MAX_MESSAGE_COUNT = 1000

    const keyAgeDays = keyAge / (1000 * 60 * 60 * 24)

    return keyAgeDays >= MAX_KEY_AGE_DAYS || messageCount >= MAX_MESSAGE_COUNT
  }

  /**
   * Delete a session with a remote address
   */
  async deleteSession(remoteAddress: string): Promise<void> {
    this.ensureInitialized()

    const [recipientId, deviceId] = this.parseAddress(remoteAddress)
    const address = SignalProtocolAddress.new(recipientId, deviceId)

    await this.keyStore!.getSessionStore().deleteSession(address)
    console.log(`🗑️ Session deleted with ${remoteAddress}`)
  }

  /**
   * Delete all sessions
   */
  async deleteAllSessions(): Promise<void> {
    this.ensureInitialized()

    await this.keyStore!.getSessionStore().deleteAllSessions()
    console.log('🗑️ All sessions deleted')
  }
}

// Export singleton instance
export const signalProtocolService = SignalProtocolService.getInstance()

