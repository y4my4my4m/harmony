/**
 * Signal Protocol Service (Browser-Compatible)
 * 
 * Wrapper around @privacyresearch/libsignal-protocol-typescript for end-to-end encryption.
 * This library works in browsers unlike @signalapp/libsignal-client which requires Node.js native modules.
 * 
 * Provides high-level API for:
 * - Key generation (identity, signed prekeys, one-time prekeys)
 * - Session establishment and management
 * - Message encryption/decryption
 * - Key rotation
 */

import type { EncryptionKeyStore } from './EncryptionKeyStore'
import { debug } from '@/utils/debug'
import {
  KeyHelper,
  SignalProtocolAddress,
  SessionBuilder,
  SessionCipher
} from '@privacyresearch/libsignal-protocol-typescript'

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
    debug.log('✅ SignalProtocolService initialized (browser-compatible)')
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
    const keyPair = await KeyHelper.generateIdentityKeyPair()
    
    return {
      privateKey: this.encodeToBase64(keyPair.privKey),
      publicKey: this.encodeToBase64(keyPair.pubKey)
    }
  }

  /**
   * Generate a signed prekey
   */
  async generateSignedPreKey(
    identityKeyPair: KeyPair,
    signedPreKeyId: number
  ): Promise<SignedPreKey> {
    const identityPrivateKey = this.decodeFromBase64(identityKeyPair.privateKey)
    
    const signedPreKey = await KeyHelper.generateSignedPreKey(
      { pubKey: this.decodeFromBase64(identityKeyPair.publicKey), privKey: identityPrivateKey },
      signedPreKeyId
    )

    return {
      id: signedPreKey.keyId,
      keyPair: {
        publicKey: this.encodeToBase64(signedPreKey.keyPair.pubKey),
        privateKey: this.encodeToBase64(signedPreKey.keyPair.privKey)
      },
      signature: this.encodeToBase64(signedPreKey.signature),
      timestamp: Date.now()
    }
  }

  /**
   * Generate multiple one-time prekeys
   */
  async generatePreKeys(startId: number, count: number): Promise<PreKey[]> {
    const preKeys: PreKey[] = []

    for (let i = 0; i < count; i++) {
      const preKey = await KeyHelper.generatePreKey(startId + i)
      preKeys.push({
        id: preKey.keyId,
        keyPair: {
          publicKey: this.encodeToBase64(preKey.keyPair.pubKey),
          privateKey: this.encodeToBase64(preKey.keyPair.privKey)
        }
      })
    }

    return preKeys
  }

  /**
   * Generate a registration ID
   */
  async generateRegistrationId(): Promise<number> {
    return KeyHelper.generateRegistrationId()
  }

  // =====================================================
  // SESSION MANAGEMENT
  // =====================================================

  /**
   * Create a session from a prekey bundle
   */
  async createSessionFromPreKeyBundle(
    recipientAddress: string,
    bundle: PreKeyBundleData
  ): Promise<void> {
    this.ensureInitialized()

    const address = SignalProtocolAddress.fromString(recipientAddress)
    const sessionBuilder = new SessionBuilder(this.keyStore!, address)

    // Build the prekey bundle in the format expected by the library
    await sessionBuilder.processPreKey({
      registrationId: bundle.registrationId,
      identityKey: this.decodeFromBase64(bundle.identityKey),
      signedPreKey: {
        keyId: bundle.signedPreKey.id,
        publicKey: this.decodeFromBase64(bundle.signedPreKey.publicKey),
        signature: this.decodeFromBase64(bundle.signedPreKey.signature)
      },
      preKey: bundle.oneTimePreKey ? {
        keyId: bundle.oneTimePreKey.id,
        publicKey: this.decodeFromBase64(bundle.oneTimePreKey.publicKey)
      } : undefined
    })

    debug.log(`🔐 Session created with ${recipientAddress}`)
  }

  /**
   * Check if a session exists with a recipient
   */
  async hasSession(recipientAddress: string): Promise<boolean> {
    this.ensureInitialized()
    
    const address = SignalProtocolAddress.fromString(recipientAddress)
    const sessionRecord = await this.keyStore!.loadSession(address.toString())
    
    return sessionRecord !== undefined && sessionRecord !== null
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

    const address = SignalProtocolAddress.fromString(recipientAddress)
    const sessionCipher = new SessionCipher(this.keyStore!, address)

    const ciphertext = await sessionCipher.encrypt(this.stringToArrayBuffer(plaintext))

    return {
      type: ciphertext.type === 3 ? 'prekey' : 'message',
      body: this.encodeToBase64(ciphertext.body! as unknown as ArrayBuffer),
      registrationId: ciphertext.registrationId || 0
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

    const address = SignalProtocolAddress.fromString(senderAddress)
    const sessionCipher = new SessionCipher(this.keyStore!, address)

    const messageBody = this.decodeFromBase64(encryptedMessage.body)

    let plaintext: ArrayBuffer

    if (encryptedMessage.type === 'prekey') {
      // PreKeySignalMessage (type 3)
      plaintext = await sessionCipher.decryptPreKeyWhisperMessage(messageBody, 'binary')
    } else {
      // Regular SignalMessage (type 1)
      plaintext = await sessionCipher.decryptWhisperMessage(messageBody, 'binary')
    }

    return this.arrayBufferToString(plaintext)
  }

  // =====================================================
  // HELPER METHODS
  // =====================================================

  private encodeToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return btoa(binary)
  }

  private decodeFromBase64(base64: string): ArrayBuffer {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes.buffer
  }

  private stringToArrayBuffer(str: string): ArrayBuffer {
    const encoder = new TextEncoder()
    return encoder.encode(str).buffer
  }

  private arrayBufferToString(buffer: ArrayBuffer): string {
    const decoder = new TextDecoder()
    return decoder.decode(buffer)
  }
}

// Export singleton instance
export const signalProtocolService = SignalProtocolService.getInstance()

