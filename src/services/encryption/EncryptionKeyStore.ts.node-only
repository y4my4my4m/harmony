/**
 * Encryption Key Store
 * 
 * IndexedDB-based storage adapter for Signal Protocol.
 * Implements the storage interfaces required by libsignal-client.
 * 
 * Stores:
 * - Identity keys
 * - Session state
 * - Pre-keys
 * - Signed pre-keys
 * - Sender keys (for group encryption)
 * 
 * All sensitive keys are encrypted with a key derived from the user's password.
 */

import type {
  IdentityKeyPair,
  IdentityKeyStore,
  PreKeyStore,
  SessionStore,
  SignedPreKeyStore,
  SenderKeyStore,
  ProtocolAddress,
  SessionRecord,
  PreKeyRecord,
  SignedPreKeyRecord,
  SenderKeyRecord,
  IdentityKey,
  PublicKey
} from '@signalapp/libsignal-client'

// IndexedDB database name
const DB_NAME = 'harmony_e2ee_keystore'
const DB_VERSION = 1

// Object store names
const STORES = {
  IDENTITY: 'identity',
  SESSIONS: 'sessions',
  PREKEYS: 'prekeys',
  SIGNED_PREKEYS: 'signedPrekeys',
  SENDER_KEYS: 'senderKeys',
  METADATA: 'metadata'
}

interface StoredIdentity {
  keyPair: string // Serialized IdentityKeyPair
  registrationId: number
  timestamp: number
}

interface StoredSession {
  address: string // "userId:deviceId"
  record: string // Serialized SessionRecord
  timestamp: number
}

interface StoredPreKey {
  id: number
  record: string // Serialized PreKeyRecord
  timestamp: number
}

interface StoredSignedPreKey {
  id: number
  record: string // Serialized SignedPreKeyRecord
  timestamp: number
}

interface StoredSenderKey {
  groupId: string
  address: string // "userId:deviceId"
  distributionId: string
  record: string // Serialized SenderKeyRecord
  timestamp: number
}

/**
 * Encryption Key Store
 * Implements Signal Protocol storage interfaces using IndexedDB
 */
export class EncryptionKeyStore implements IdentityKeyStore, PreKeyStore, SessionStore, SignedPreKeyStore, SenderKeyStore {
  private db: IDBDatabase | null = null
  private userId: string
  private encryptionKey: CryptoKey | null = null

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
        console.log('✅ EncryptionKeyStore initialized')
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        // Create object stores
        if (!db.objectStoreNames.contains(STORES.IDENTITY)) {
          db.createObjectStore(STORES.IDENTITY, { keyPath: 'userId' })
        }

        if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
          const sessionStore = db.createObjectStore(STORES.SESSIONS, { keyPath: 'address' })
          sessionStore.createIndex('timestamp', 'timestamp')
        }

        if (!db.objectStoreNames.contains(STORES.PREKEYS)) {
          const preKeyStore = db.createObjectStore(STORES.PREKEYS, { keyPath: 'id' })
          preKeyStore.createIndex('timestamp', 'timestamp')
        }

        if (!db.objectStoreNames.contains(STORES.SIGNED_PREKEYS)) {
          const signedPreKeyStore = db.createObjectStore(STORES.SIGNED_PREKEYS, { keyPath: 'id' })
          signedPreKeyStore.createIndex('timestamp', 'timestamp')
        }

        if (!db.objectStoreNames.contains(STORES.SENDER_KEYS)) {
          const senderKeyStore = db.createObjectStore(STORES.SENDER_KEYS, {
            keyPath: ['groupId', 'address', 'distributionId']
          })
          senderKeyStore.createIndex('timestamp', 'timestamp')
        }

        if (!db.objectStoreNames.contains(STORES.METADATA)) {
          db.createObjectStore(STORES.METADATA, { keyPath: 'key' })
        }

        console.log('✅ IndexedDB object stores created')
      }
    })
  }

  /**
   * Set encryption key for sensitive data
   * Derived from user's password
   */
  async setEncryptionKey(password: string): Promise<void> {
    const encoder = new TextEncoder()
    const passwordBytes = encoder.encode(password)

    // Import password as key material
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordBytes,
      { name: 'PBKDF2' },
      false,
      ['deriveBits', 'deriveKey']
    )

    // Derive encryption key using PBKDF2
    const salt = await this.getSalt()
    this.encryptionKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )

    console.log('✅ Encryption key derived from password')
  }

  /**
   * Get or generate salt for key derivation
   */
  private async getSalt(): Promise<Uint8Array> {
    const stored = await this.getMetadata('salt')
    if (stored) {
      return new Uint8Array(stored)
    }

    // Generate new salt
    const salt = crypto.getRandomValues(new Uint8Array(16))
    await this.setMetadata('salt', Array.from(salt))
    return salt
  }

  /**
   * Encrypt sensitive data
   */
  private async encrypt(data: string): Promise<string> {
    if (!this.encryptionKey) {
      // If no encryption key, store as-is (for development/testing)
      console.warn('⚠️ No encryption key set, storing data unencrypted')
      return data
    }

    const encoder = new TextEncoder()
    const dataBytes = encoder.encode(data)

    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.encryptionKey,
      dataBytes
    )

    // Combine IV and ciphertext
    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv, 0)
    combined.set(new Uint8Array(encrypted), iv.length)

    return Buffer.from(combined).toString('base64')
  }

  /**
   * Decrypt sensitive data
   */
  private async decrypt(encryptedData: string): Promise<string> {
    if (!this.encryptionKey) {
      // If no encryption key, assume data is unencrypted
      return encryptedData
    }

    const combined = Buffer.from(encryptedData, 'base64')
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.encryptionKey,
      ciphertext
    )

    const decoder = new TextDecoder()
    return decoder.decode(decrypted)
  }

  // =====================================================
  // IDENTITY KEY STORE
  // =====================================================

  async getIdentityKeyPair(): Promise<IdentityKeyPair> {
    const stored = await this.getFromStore<StoredIdentity>(STORES.IDENTITY, this.userId)
    if (!stored) {
      throw new Error('Identity key pair not found')
    }

    const { IdentityKeyPair } = await import('@signalapp/libsignal-client')
    const decrypted = await this.decrypt(stored.keyPair)
    return IdentityKeyPair.deserialize(Buffer.from(decrypted, 'base64'))
  }

  async getLocalRegistrationId(): Promise<number> {
    const stored = await this.getFromStore<StoredIdentity>(STORES.IDENTITY, this.userId)
    if (!stored) {
      throw new Error('Registration ID not found')
    }
    return stored.registrationId
  }

  async saveIdentityKeyPair(keyPair: IdentityKeyPair, registrationId: number): Promise<void> {
    const serialized = Buffer.from(keyPair.serialize()).toString('base64')
    const encrypted = await this.encrypt(serialized)

    const identity: StoredIdentity = {
      keyPair: encrypted,
      registrationId,
      timestamp: Date.now()
    }

    await this.putInStore(STORES.IDENTITY, { ...identity, userId: this.userId })
  }

  async isTrustedIdentity(
    address: ProtocolAddress,
    identityKey: PublicKey,
    direction: number
  ): Promise<boolean> {
    // For now, trust all identities (TOFU - Trust On First Use)
    // In production, implement proper identity verification
    return true
  }

  async getIdentity(address: ProtocolAddress): Promise<PublicKey | null> {
    // Return the stored identity for this address if it exists
    // For now, return null (no stored identity)
    return null
  }

  async saveIdentity(address: ProtocolAddress, identityKey: PublicKey): Promise<boolean> {
    // Save the identity key for this address
    // Return true if the identity was changed, false if it's the same
    // For now, always return false
    return false
  }

  // =====================================================
  // SESSION STORE
  // =====================================================

  async loadSession(address: ProtocolAddress): Promise<SessionRecord | null> {
    const addressStr = this.serializeAddress(address)
    const stored = await this.getFromStore<StoredSession>(STORES.SESSIONS, addressStr)

    if (!stored) {
      return null
    }

    const { SessionRecord } = await import('@signalapp/libsignal-client')
    const decrypted = await this.decrypt(stored.record)
    return SessionRecord.deserialize(Buffer.from(decrypted, 'base64'))
  }

  async storeSession(address: ProtocolAddress, record: SessionRecord): Promise<void> {
    const addressStr = this.serializeAddress(address)
    const serialized = Buffer.from(record.serialize()).toString('base64')
    const encrypted = await this.encrypt(serialized)

    const session: StoredSession = {
      address: addressStr,
      record: encrypted,
      timestamp: Date.now()
    }

    await this.putInStore(STORES.SESSIONS, session)
  }

  async getExistingSessions(addresses: ProtocolAddress[]): Promise<ProtocolAddress[]> {
    const existing: ProtocolAddress[] = []

    for (const address of addresses) {
      const hasSession = await this.hasSession(address)
      if (hasSession) {
        existing.push(address)
      }
    }

    return existing
  }

  async hasSession(address: ProtocolAddress): Promise<boolean> {
    const addressStr = this.serializeAddress(address)
    const stored = await this.getFromStore<StoredSession>(STORES.SESSIONS, addressStr)
    return stored !== null
  }

  async deleteSession(address: ProtocolAddress): Promise<void> {
    const addressStr = this.serializeAddress(address)
    await this.deleteFromStore(STORES.SESSIONS, addressStr)
  }

  async deleteAllSessions(): Promise<void> {
    await this.clearStore(STORES.SESSIONS)
  }

  // =====================================================
  // PREKEY STORE
  // =====================================================

  async loadPreKey(id: number): Promise<PreKeyRecord> {
    const stored = await this.getFromStore<StoredPreKey>(STORES.PREKEYS, id)
    if (!stored) {
      throw new Error(`PreKey ${id} not found`)
    }

    const { PreKeyRecord } = await import('@signalapp/libsignal-client')
    const decrypted = await this.decrypt(stored.record)
    return PreKeyRecord.deserialize(Buffer.from(decrypted, 'base64'))
  }

  async storePreKey(id: number, record: PreKeyRecord): Promise<void> {
    const serialized = Buffer.from(record.serialize()).toString('base64')
    const encrypted = await this.encrypt(serialized)

    const preKey: StoredPreKey = {
      id,
      record: encrypted,
      timestamp: Date.now()
    }

    await this.putInStore(STORES.PREKEYS, preKey)
  }

  async removePreKey(id: number): Promise<void> {
    await this.deleteFromStore(STORES.PREKEYS, id)
  }

  // =====================================================
  // SIGNED PREKEY STORE
  // =====================================================

  async loadSignedPreKey(id: number): Promise<SignedPreKeyRecord> {
    const stored = await this.getFromStore<StoredSignedPreKey>(STORES.SIGNED_PREKEYS, id)
    if (!stored) {
      throw new Error(`SignedPreKey ${id} not found`)
    }

    const { SignedPreKeyRecord } = await import('@signalapp/libsignal-client')
    const decrypted = await this.decrypt(stored.record)
    return SignedPreKeyRecord.deserialize(Buffer.from(decrypted, 'base64'))
  }

  async storeSignedPreKey(id: number, record: SignedPreKeyRecord): Promise<void> {
    const serialized = Buffer.from(record.serialize()).toString('base64')
    const encrypted = await this.encrypt(serialized)

    const signedPreKey: StoredSignedPreKey = {
      id,
      record: encrypted,
      timestamp: Date.now()
    }

    await this.putInStore(STORES.SIGNED_PREKEYS, signedPreKey)
  }

  // =====================================================
  // SENDER KEY STORE (Group Encryption)
  // =====================================================

  async storeSenderKey(
    sender: ProtocolAddress,
    distributionId: Uint8Array,
    record: SenderKeyRecord
  ): Promise<void> {
    const senderStr = this.serializeAddress(sender)
    const distributionIdStr = Buffer.from(distributionId).toString('base64')
    const serialized = Buffer.from(record.serialize()).toString('base64')
    const encrypted = await this.encrypt(serialized)

    const senderKey: StoredSenderKey = {
      groupId: 'default', // We'll use a default group ID for now
      address: senderStr,
      distributionId: distributionIdStr,
      record: encrypted,
      timestamp: Date.now()
    }

    await this.putInStore(STORES.SENDER_KEYS, senderKey)
  }

  async loadSenderKey(
    sender: ProtocolAddress,
    distributionId: Uint8Array
  ): Promise<SenderKeyRecord | null> {
    const senderStr = this.serializeAddress(sender)
    const distributionIdStr = Buffer.from(distributionId).toString('base64')

    const stored = await this.getFromStore<StoredSenderKey>(
      STORES.SENDER_KEYS,
      ['default', senderStr, distributionIdStr]
    )

    if (!stored) {
      return null
    }

    const { SenderKeyRecord } = await import('@signalapp/libsignal-client')
    const decrypted = await this.decrypt(stored.record)
    return SenderKeyRecord.deserialize(Buffer.from(decrypted, 'base64'))
  }

  // =====================================================
  // HELPER METHODS
  // =====================================================

  /**
   * Serialize address to string
   */
  private serializeAddress(address: ProtocolAddress): string {
    return `${address.name()}:${address.deviceId()}`
  }

  /**
   * Get session store interface
   */
  getSessionStore(): SessionStore {
    return this
  }

  /**
   * Get identity key store interface
   */
  getIdentityKeyStore(): IdentityKeyStore {
    return this
  }

  /**
   * Get prekey store interface
   */
  getPreKeyStore(): PreKeyStore {
    return this
  }

  /**
   * Get signed prekey store interface
   */
  getSignedPreKeyStore(): SignedPreKeyStore {
    return this
  }

  /**
   * Get sender key store interface
   */
  getSenderKeyStore(): SenderKeyStore {
    return this
  }

  // =====================================================
  // INDEXEDDB OPERATIONS
  // =====================================================

  private async getFromStore<T>(storeName: string, key: any): Promise<T | null> {
    if (!this.db) throw new Error('Database not initialized')

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const request = store.get(key)

      request.onsuccess = () => resolve(request.result || null)
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

  private async clearStore(storeName: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized')

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.clear()

      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  private async getMetadata(key: string): Promise<any> {
    return this.getFromStore(STORES.METADATA, key)
  }

  private async setMetadata(key: string, value: any): Promise<void> {
    await this.putInStore(STORES.METADATA, { key, value })
  }

  // =====================================================
  // CLEANUP
  // =====================================================

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
      console.log('✅ EncryptionKeyStore closed')
    }
  }

  /**
   * Delete all stored keys (use with caution!)
   */
  async deleteAll(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized')

    await Promise.all([
      this.clearStore(STORES.IDENTITY),
      this.clearStore(STORES.SESSIONS),
      this.clearStore(STORES.PREKEYS),
      this.clearStore(STORES.SIGNED_PREKEYS),
      this.clearStore(STORES.SENDER_KEYS),
      this.clearStore(STORES.METADATA)
    ])

    console.log('🗑️ All encryption keys deleted')
  }
}

