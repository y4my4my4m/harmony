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

import type {
  StorageType,
  KeyPairType,
  Direction,
  SessionRecordType
} from '@privacyresearch/libsignal-protocol-typescript'

import { debug } from '@/utils/debug'

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
      true, // Make it extractable so we can store it
      ['encrypt', 'decrypt']
    )

    // Store the derived key in sessionStorage for this session
    // This allows encryption without re-entering password
    try {
      const exported = await crypto.subtle.exportKey('raw', this.encryptionKey)
      const keyArray = Array.from(new Uint8Array(exported))
      const keyBase64 = btoa(String.fromCharCode(...keyArray))
      sessionStorage.setItem(`e2ee_key_${this.userId}`, keyBase64)
      debug.log('✅ Encryption key derived and cached for session')
    } catch (error) {
      debug.warn('⚠️ Could not cache encryption key:', error)
    }
  }

  /**
   * Try to restore encryption key from sessionStorage
   */
  async tryRestoreSessionKey(): Promise<boolean> {
    try {
      const keyBase64 = sessionStorage.getItem(`e2ee_key_${this.userId}`)
      if (!keyBase64) {
        return false
      }

      // Convert base64 back to ArrayBuffer
      const keyString = atob(keyBase64)
      const keyArray = new Uint8Array(keyString.length)
      for (let i = 0; i < keyString.length; i++) {
        keyArray[i] = keyString.charCodeAt(i)
      }

      // Import the key
      this.encryptionKey = await crypto.subtle.importKey(
        'raw',
        keyArray.buffer,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt']
      )

      debug.log('✅ Encryption key restored from session')
      return true
    } catch (error) {
      debug.error('❌ Failed to restore session key:', error)
      return false
    }
  }

  /**
   * Clear the cached encryption key
   */
  clearSessionKey(): void {
    sessionStorage.removeItem(`e2ee_key_${this.userId}`)
    this.encryptionKey = null
  }

  /**
   * Check if the encryption key is currently loaded
   * This is needed to know if we can decrypt prekeys from IndexedDB
   */
  hasEncryptionKeyLoaded(): boolean {
    return this.encryptionKey !== null
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
    _identifier: string,
    _identityKey: ArrayBuffer,
    _direction: Direction
  ): Promise<boolean> {
    // For now, trust all identities
    // In production, implement proper trust verification
    return true
  }

  async saveIdentity(
    encodedAddress: string,
    publicKey: ArrayBuffer,
    _nonblockingApproval?: boolean
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
    debug.log(`🔑 loadPreKey: Loading prekey ID ${keyId}`)
    const stored = await this.getFromStore<any>(STORES.PREKEYS, Number(keyId))
    if (!stored) {
      debug.error(`❌ loadPreKey: Prekey ID ${keyId} NOT FOUND in IndexedDB`)
      // List all available prekey IDs for debugging
      const allPrekeys = await this.getAllFromStore(STORES.PREKEYS)
      debug.log(`   Available prekey IDs in IndexedDB:`, allPrekeys.map((p: any) => p.id))
      return undefined
    }

    debug.log(`✅ loadPreKey: Found prekey ID ${keyId} in IndexedDB`)
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
    debug.log(`🔑 loadSignedPreKey: Loading signed prekey ID ${keyId}`)
    const stored = await this.getFromStore<any>(STORES.SIGNED_PREKEYS, Number(keyId))
    if (!stored) {
      debug.error(`❌ loadSignedPreKey: Signed prekey ID ${keyId} NOT FOUND in IndexedDB`)
      // List all available signed prekey IDs for debugging
      const allSignedPrekeys = await this.getAllFromStore(STORES.SIGNED_PREKEYS)
      debug.log(`   Available signed prekey IDs in IndexedDB:`, allSignedPrekeys.map((p: any) => p.id))
      return undefined
    }

    debug.log(`✅ loadSignedPreKey: Found signed prekey ID ${keyId} in IndexedDB`)
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

  /**
   * Clear ALL data from IndexedDB (for encryption reset)
   * This is destructive and cannot be undone!
   */
  async clearAllData(): Promise<void> {
    if (!this.db) {
      debug.log('⚠️ No database to clear')
      return
    }

    debug.log('⚠️ Clearing all encryption data from IndexedDB...')

    const storeNames = [
      STORES.IDENTITY,
      STORES.PREKEYS,
      STORES.SIGNED_PREKEYS,
      STORES.SESSIONS,
      (STORES as any).SENDER_KEYS
    ].filter(Boolean) as string[]

    for (const storeName of storeNames) {
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = this.db!.transaction(storeName, 'readwrite')
          const store = transaction.objectStore(storeName)
          const request = store.clear()
          request.onsuccess = () => {
            debug.log(`  ✅ Cleared store: ${storeName}`)
            resolve()
          }
          request.onerror = () => reject(request.error)
        })
      } catch (error) {
        debug.error(`  ❌ Failed to clear store ${storeName}:`, error)
      }
    }

    // Also clear session storage key
    this.clearSessionKey()

    debug.log('✅ All IndexedDB encryption data cleared')
  }

  // =====================================================
  // BACKUP & RECOVERY METHODS
  // =====================================================

  /**
   * Export all encryption keys as an encrypted backup
   * Returns a base64-encoded encrypted blob that can be saved
   */
  async exportBackup(backupPassword: string): Promise<string> {
    if (!this.db) throw new Error('Database not initialized')
    if (!this.encryptionKey) throw new Error('Encryption key not set - unlock first')

    // Collect all data from stores
    const backup: Record<string, any> = {
      version: 1,
      userId: this.userId,
      timestamp: Date.now(),
      stores: {}
    }

    // Export identity
    const identity = await this.getFromStore<StoredIdentity>(STORES.IDENTITY, this.userId)
    if (identity) {
      backup.stores.identity = identity
    }

    // Export all prekeys
    backup.stores.prekeys = await this.getAllFromStore(STORES.PREKEYS)
    
    // Export all signed prekeys
    backup.stores.signedPrekeys = await this.getAllFromStore(STORES.SIGNED_PREKEYS)
    
    // Export sessions
    backup.stores.sessions = await this.getAllFromStore(STORES.SESSIONS)
    
    // Export metadata
    backup.stores.metadata = await this.getAllFromStore(STORES.METADATA)

    // Serialize and encrypt with backup password
    const backupJson = JSON.stringify(backup)
    const encrypted = await this.encryptWithPassword(backupJson, backupPassword)
    
    debug.log('✅ Backup exported successfully')
    return encrypted
  }

  /**
   * Import and restore from an encrypted backup
   */
  async importBackup(encryptedBackup: string, backupPassword: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized')

    // Decrypt the backup
    let backupJson: string
    try {
      backupJson = await this.decryptWithPassword(encryptedBackup, backupPassword)
    } catch (error) {
      throw new Error('Invalid backup password or corrupted backup')
    }

    const backup = JSON.parse(backupJson)
    
    if (backup.version !== 1) {
      throw new Error('Unsupported backup version')
    }

    if (backup.userId !== this.userId) {
      throw new Error('Backup belongs to a different user')
    }

    // Clear existing data
    await this.clearAllStores()

    // Restore identity
    if (backup.stores.identity) {
      await this.putInStore(STORES.IDENTITY, backup.stores.identity)
    }

    // Restore prekeys
    if (backup.stores.prekeys) {
      for (const prekey of backup.stores.prekeys) {
        await this.putInStore(STORES.PREKEYS, prekey)
      }
    }

    // Restore signed prekeys
    if (backup.stores.signedPrekeys) {
      for (const signedPrekey of backup.stores.signedPrekeys) {
        await this.putInStore(STORES.SIGNED_PREKEYS, signedPrekey)
      }
    }

    // Restore sessions
    if (backup.stores.sessions) {
      for (const session of backup.stores.sessions) {
        await this.putInStore(STORES.SESSIONS, session)
      }
    }

    // Restore metadata
    if (backup.stores.metadata) {
      for (const meta of backup.stores.metadata) {
        await this.putInStore(STORES.METADATA, meta)
      }
    }

    debug.log('✅ Backup imported successfully')
  }

  /**
   * Encrypt data with a password (for backup)
   */
  private async encryptWithPassword(data: string, password: string): Promise<string> {
    const encoder = new TextEncoder()
    const passwordData = encoder.encode(password)
    
    // Generate a random salt
    const salt = crypto.getRandomValues(new Uint8Array(16))
    
    // Derive key from password
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordData,
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    )

    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    )

    const dataBytes = encoder.encode(data)
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      dataBytes
    )

    // Combine salt + iv + encrypted data
    const combined = new Uint8Array(salt.length + iv.length + encrypted.byteLength)
    combined.set(salt)
    combined.set(iv, salt.length)
    combined.set(new Uint8Array(encrypted), salt.length + iv.length)

    return this.arrayBufferToBase64(combined)
  }

  /**
   * Decrypt data with a password (for backup)
   */
  private async decryptWithPassword(encryptedData: string, password: string): Promise<string> {
    const encoder = new TextEncoder()
    const passwordData = encoder.encode(password)
    
    const combined = this.base64ToArrayBuffer(encryptedData)
    const combinedArray = new Uint8Array(combined)
    
    // Extract salt, iv, and encrypted data
    const salt = combinedArray.slice(0, 16)
    const iv = combinedArray.slice(16, 28)
    const data = combinedArray.slice(28)

    // Derive key from password
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      passwordData,
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    )

    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    )

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    )

    const decoder = new TextDecoder()
    return decoder.decode(decrypted)
  }

  /**
   * Get all items from a store
   */
  private async getAllFromStore(storeName: string): Promise<any[]> {
    if (!this.db) throw new Error('Database not initialized')

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const request = store.getAll()

      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
  }

  /**
   * Clear all stores (for import)
   */
  private async clearAllStores(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized')

    const storeNames = [STORES.IDENTITY, STORES.SESSIONS, STORES.PREKEYS, STORES.SIGNED_PREKEYS, STORES.METADATA]
    
    for (const storeName of storeNames) {
      await new Promise<void>((resolve, reject) => {
        const transaction = this.db!.transaction(storeName, 'readwrite')
        const store = transaction.objectStore(storeName)
        const request = store.clear()

        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
    }
  }

  /**
   * Check if we have any stored keys
   */
  async hasStoredKeys(): Promise<boolean> {
    const identity = await this.getFromStore<StoredIdentity>(STORES.IDENTITY, this.userId)
    return !!identity
  }

  // =====================================================
  // UTILITY METHODS
  // =====================================================

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
      debug.log('✅ EncryptionKeyStore database closed')
    }
  }

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

