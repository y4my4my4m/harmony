/**
 * Encryption Key Store (Browser-Compatible)
 * 
 * IndexedDB-based storage adapter for Signal Protocol.
 * Implements the storage interfaces required by @privacyresearch/libsignal-protocol-typescript.
 * 
 * Stores:
 * - Identity keys
 * - Session state
 * - Pre-keys
 * - Signed pre-keys
 * 
 * All sensitive keys are encrypted with a key derived from the user's password.
 */

import { debug } from '@/utils/debug'
import type {
  StorageType,
  KeyPairType,
  Direction,
  SessionRecordType
} from '@privacyresearch/libsignal-protocol-typescript'

// IndexedDB database name
const DB_NAME = 'harmony_e2ee_keystore'
const DB_VERSION = 1

// Object store names
const STORES = {
  IDENTITY: 'identity',
  SESSIONS: 'sessions',
  PREKEYS: 'prekeys',
  SIGNED_PREKEYS: 'signedPrekeys',
  METADATA: 'metadata'
}

interface StoredIdentity {
  keyPair: string // Base64 encoded encrypted data
  registrationId: number
  timestamp: number
}

/**
 * Encryption Key Store
 * Implements Signal Protocol storage interfaces using IndexedDB
 */
export class EncryptionKeyStore implements StorageType {
  private db: IDBDatabase | null = null
  private userId: string
  private encryptionKey: CryptoKey | null = null
  private identityKeyPair: KeyPairType | null = null
  private registrationId: number | null = null

  constructor(userId: string) {
    this.userId = userId
  }

  // =====================================================
  // INITIALIZATION
  // =====================================================

  /**
   * Initialize the key store (open IndexedDB)
   */
  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        this.db = request.result
        debug.log('✅ IndexedDB opened')
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        // Create object stores if they don't exist
        if (!db.objectStoreNames.contains(STORES.IDENTITY)) {
          db.createObjectStore(STORES.IDENTITY, { keyPath: 'userId' })
        }
        if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
          const sessionStore = db.createObjectStore(STORES.SESSIONS, { keyPath: 'address' })
          sessionStore.createIndex('timestamp', 'timestamp')
        }
        if (!db.objectStoreNames.contains(STORES.PREKEYS)) {
          db.createObjectStore(STORES.PREKEYS, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(STORES.SIGNED_PREKEYS)) {
          db.createObjectStore(STORES.SIGNED_PREKEYS, { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains(STORES.METADATA)) {
          db.createObjectStore(STORES.METADATA, { keyPath: 'key' })
        }

        debug.log('✅ IndexedDB object stores created')
      }
    })
  }

  /**
   * Set the encryption key for encrypting stored data
   */
  async setEncryptionKey(password: string): Promise<void> {
    const encoder = new TextEncoder()
    const passwordData = encoder.encode(password)

    // Derive key from password
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordData,
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    )

    this.encryptionKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode(this.userId), // Use userId as salt
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )

    debug.log('✅ Encryption key derived from password')
  }

  // =====================================================
  // STORAGE INTERFACE IMPLEMENTATION
  // =====================================================

  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    if (this.identityKeyPair) {
      return this.identityKeyPair
    }

    const stored = await this.getFromStore<StoredIdentity>(STORES.IDENTITY, this.userId)
    if (!stored) return undefined

    const decrypted = await this.decrypt(stored.keyPair)
    const parsed = JSON.parse(decrypted)
    
    this.identityKeyPair = {
      pubKey: this.base64ToArrayBuffer(parsed.pubKey),
      privKey: this.base64ToArrayBuffer(parsed.privKey)
    }

    return this.identityKeyPair
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    if (this.registrationId !== null) {
      return this.registrationId
    }

    const stored = await this.getFromStore<StoredIdentity>(STORES.IDENTITY, this.userId)
    if (!stored) return undefined

    this.registrationId = stored.registrationId
    return this.registrationId
  }

  async isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    direction: Direction
  ): Promise<boolean> {
    // For now, trust all identities
    // In production, implement proper trust verification
    return true
  }

  async saveIdentity(
    encodedAddress: string,
    publicKey: ArrayBuffer,
    nonblockingApproval?: boolean
  ): Promise<boolean> {
    // Store the public key for this address
    await this.putInStore(STORES.METADATA, {
      key: `identity_${encodedAddress}`,
      value: this.arrayBufferToBase64(publicKey),
      timestamp: Date.now()
    })
    return true
  }

  async loadPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    const stored = await this.getFromStore<any>(STORES.PREKEYS, Number(keyId))
    if (!stored) return undefined

    const decrypted = await this.decrypt(stored.keyPair)
    const parsed = JSON.parse(decrypted)

    return {
      pubKey: this.base64ToArrayBuffer(parsed.pubKey),
      privKey: this.base64ToArrayBuffer(parsed.privKey)
    }
  }

  async storePreKey(keyId: number | string, keyPair: KeyPairType): Promise<void> {
    const serialized = JSON.stringify({
      pubKey: this.arrayBufferToBase64(keyPair.pubKey),
      privKey: this.arrayBufferToBase64(keyPair.privKey)
    })

    const encrypted = await this.encrypt(serialized)

    await this.putInStore(STORES.PREKEYS, {
      id: Number(keyId),
      keyPair: encrypted,
      timestamp: Date.now()
    })
  }

  async removePreKey(keyId: number | string): Promise<void> {
    await this.deleteFromStore(STORES.PREKEYS, Number(keyId))
  }

  async loadSession(encodedAddress: string): Promise<SessionRecordType | undefined> {
    const stored = await this.getFromStore<any>(STORES.SESSIONS, encodedAddress)
    if (!stored) return undefined

    const decrypted = await this.decrypt(stored.record)
    return decrypted as SessionRecordType
  }

  async storeSession(encodedAddress: string, record: SessionRecordType): Promise<void> {
    const encrypted = await this.encrypt(record)

    await this.putInStore(STORES.SESSIONS, {
      address: encodedAddress,
      record: encrypted,
      timestamp: Date.now()
    })
  }

  async loadSignedPreKey(keyId: number | string): Promise<KeyPairType | undefined> {
    const stored = await this.getFromStore<any>(STORES.SIGNED_PREKEYS, Number(keyId))
    if (!stored) return undefined

    const decrypted = await this.decrypt(stored.keyPair)
    const parsed = JSON.parse(decrypted)

    return {
      pubKey: this.base64ToArrayBuffer(parsed.pubKey),
      privKey: this.base64ToArrayBuffer(parsed.privKey)
    }
  }

  async storeSignedPreKey(keyId: number | string, keyPair: KeyPairType): Promise<void> {
    const serialized = JSON.stringify({
      pubKey: this.arrayBufferToBase64(keyPair.pubKey),
      privKey: this.arrayBufferToBase64(keyPair.privKey)
    })

    const encrypted = await this.encrypt(serialized)

    await this.putInStore(STORES.SIGNED_PREKEYS, {
      id: Number(keyId),
      keyPair: encrypted,
      timestamp: Date.now()
    })
  }

  async removeSignedPreKey(keyId: number | string): Promise<void> {
    await this.deleteFromStore(STORES.SIGNED_PREKEYS, Number(keyId))
  }

  // =====================================================
  // CUSTOM METHODS (NOT IN STORAGE INTERFACE)
  // =====================================================

  async saveIdentityKeyPair(keyPair: KeyPairType, registrationId: number): Promise<void> {
    const serialized = JSON.stringify({
      pubKey: this.arrayBufferToBase64(keyPair.pubKey),
      privKey: this.arrayBufferToBase64(keyPair.privKey)
    })

    const encrypted = await this.encrypt(serialized)

    await this.putInStore(STORES.IDENTITY, {
      userId: this.userId,
      keyPair: encrypted,
      registrationId,
      timestamp: Date.now()
    })

    this.identityKeyPair = keyPair
    this.registrationId = registrationId
  }

  // =====================================================
  // ENCRYPTION HELPERS
  // =====================================================

  private async encrypt(data: string): Promise<string> {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not set')
    }

    const encoder = new TextEncoder()
    const dataBytes = encoder.encode(data)
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.encryptionKey,
      dataBytes
    )

    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)

    return this.arrayBufferToBase64(combined)
  }

  private async decrypt(encryptedData: string): Promise<string> {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not set')
    }

    const combined = this.base64ToArrayBuffer(encryptedData)
    const iv = combined.slice(0, 12)
    const data = combined.slice(12)

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.encryptionKey,
      data
    )

    const decoder = new TextDecoder()
    return decoder.decode(decrypted)
  }

  // =====================================================
  // INDEXEDDB HELPERS
  // =====================================================

  private async getFromStore<T>(storeName: string, key: any): Promise<T | undefined> {
    if (!this.db) throw new Error('Database not initialized')

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const request = store.get(key)

      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  private async putInStore(storeName: string, value: any): Promise<void> {
    if (!this.db) throw new Error('Database not initialized')

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.put(value)

      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  private async deleteFromStore(storeName: string, key: any): Promise<void> {
    if (!this.db) throw new Error('Database not initialized')

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.delete(key)

      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  // =====================================================
  // UTILITY METHODS
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
}

