/**
 * Secure Session Key Store
 *
 * Stores non-extractable CryptoKey objects in IndexedDB for persistent
 * encryption sessions across browser restarts.
 *
 * Security properties:
 * - Keys are stored as non-extractable CryptoKey objects
 * - JavaScript cannot read the raw key material (only use for encrypt/decrypt)
 * - XSS can use keys while the page is open, but cannot exfiltrate them
 * - Keys persist until explicitly cleared (logout/lock)
 * - Same-origin scoped (standard IndexedDB policy)
 */

import { debug } from '@/utils/debug'

const DB_NAME = 'harmony_session_keys'
const DB_VERSION = 1
const STORE_NAME = 'keys'

export interface StoredSessionKeys {
  encryptionKey: CryptoKey
  backupKey: CryptoKey
  signingKey: CryptoKey
}

class SecureSessionKeyStore {
  private db: IDBDatabase | null = null

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => {
        debug.warn('⚠️ SecureSessionKeyStore: Failed to open IndexedDB:', request.error)
        reject(request.error)
      }

      request.onsuccess = () => {
        this.db = request.result
        this.db.onclose = () => { this.db = null }
        resolve(this.db)
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'userId' })
        }
      }
    })
  }

  /**
   * Store non-extractable CryptoKeys for a user.
   * If the source keys are extractable, they are re-imported as non-extractable.
   */
  async store(userId: string, keys: StoredSessionKeys): Promise<void> {
    const db = await this.open()

    const safeKeys = {
      encryptionKey: await this.ensureNonExtractable(keys.encryptionKey),
      backupKey: await this.ensureNonExtractable(keys.backupKey),
      signingKey: await this.ensureNonExtractable(keys.signingKey),
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      store.put({ userId, ...safeKeys, storedAt: Date.now() })
      tx.oncomplete = () => {
        debug.log('🔐 Session keys stored securely in IndexedDB (non-extractable)')
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    })
  }

  /**
   * Load stored CryptoKeys for a user.
   * Returns null if no keys are stored.
   */
  async load(userId: string): Promise<StoredSessionKeys | null> {
    const db = await this.open()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(userId)

      request.onsuccess = () => {
        const result = request.result
        if (!result) {
          resolve(null)
          return
        }

        if (!result.encryptionKey || !result.backupKey || !result.signingKey) {
          debug.warn('⚠️ Stored session keys are incomplete - clearing')
          this.clear(userId).catch(() => {})
          resolve(null)
          return
        }

        resolve({
          encryptionKey: result.encryptionKey,
          backupKey: result.backupKey,
          signingKey: result.signingKey,
        })
      }
      request.onerror = () => reject(request.error)
    })
  }

  /**
   * Clear stored keys for a user (on logout or explicit lock).
   */
  async clear(userId: string): Promise<void> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        store.delete(userId)
        tx.oncomplete = () => {
          debug.log('🔒 Session keys cleared from IndexedDB')
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      debug.warn('⚠️ Failed to clear session keys from IndexedDB')
    }
  }

  /**
   * Clear all stored keys (nuclear option for logout).
   */
  async clearAll(): Promise<void> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        store.clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      debug.warn('⚠️ Failed to clear all session keys from IndexedDB')
    }
  }

  /**
   * Re-import a CryptoKey as non-extractable if it isn't already.
   * This prevents the key material from being read via exportKey().
   */
  private async ensureNonExtractable(key: CryptoKey): Promise<CryptoKey> {
    if (!key.extractable) return key

    const raw = await crypto.subtle.exportKey('raw', key)
    return crypto.subtle.importKey(
      'raw',
      raw,
      key.algorithm,
      false, // non-extractable
      key.usages
    )
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

export const secureSessionKeyStore = new SecureSessionKeyStore()

// =====================================================
// Identity Key Store
// Stores ECDH private keys as non-extractable CryptoKey
// objects in IndexedDB for session key exchange.
// =====================================================

const IDENTITY_DB_NAME = 'harmony_identity_keys'
const IDENTITY_DB_VERSION = 1
const IDENTITY_STORE_NAME = 'identity'

class IdentityKeyStore {
  private db: IDBDatabase | null = null

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(IDENTITY_DB_NAME, IDENTITY_DB_VERSION)

      request.onerror = () => {
        debug.warn('⚠️ IdentityKeyStore: Failed to open IndexedDB:', request.error)
        reject(request.error)
      }

      request.onsuccess = () => {
        this.db = request.result
        this.db.onclose = () => { this.db = null }
        resolve(this.db)
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(IDENTITY_STORE_NAME)) {
          db.createObjectStore(IDENTITY_STORE_NAME, { keyPath: 'userId' })
        }
      }
    })
  }

  async store(userId: string, privateKey: CryptoKey): Promise<void> {
    const db = await this.open()

    // Re-import as non-extractable if needed
    let safeKey = privateKey
    if (privateKey.extractable) {
      const raw = await crypto.subtle.exportKey('pkcs8', privateKey)
      safeKey = await crypto.subtle.importKey(
        'pkcs8',
        raw,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
      )
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE_NAME, 'readwrite')
      const store = tx.objectStore(IDENTITY_STORE_NAME)
      store.put({ userId, privateKey: safeKey, storedAt: Date.now() })
      tx.oncomplete = () => {
        debug.log('🔐 Identity key stored securely in IndexedDB (non-extractable)')
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    })
  }

  async load(userId: string): Promise<CryptoKey | null> {
    try {
      const db = await this.open()

      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDENTITY_STORE_NAME, 'readonly')
        const store = tx.objectStore(IDENTITY_STORE_NAME)
        const request = store.get(userId)

        request.onsuccess = () => {
          const result = request.result
          if (!result?.privateKey) {
            resolve(null)
            return
          }
          resolve(result.privateKey)
        }
        request.onerror = () => reject(request.error)
      })
    } catch {
      return null
    }
  }

  async clear(userId: string): Promise<void> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDENTITY_STORE_NAME, 'readwrite')
        const store = tx.objectStore(IDENTITY_STORE_NAME)
        store.delete(userId)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      debug.warn('⚠️ Failed to clear identity key from IndexedDB')
    }
  }

  async clearAll(): Promise<void> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(IDENTITY_STORE_NAME, 'readwrite')
        const store = tx.objectStore(IDENTITY_STORE_NAME)
        store.clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      debug.warn('⚠️ Failed to clear all identity keys from IndexedDB')
    }
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

export const identityKeyStore = new IdentityKeyStore()

// =====================================================
// Signing Key Store
// Stores ECDSA P-256 private signing keys as non-extractable
// CryptoKey objects in IndexedDB. Used for per-message sender
// signatures (Megolm v2 sender binding).
//
// Kept in its own IndexedDB database so a future device-rotation
// flow can clear it independently of the ECDH identity key.
// =====================================================

const SIGNING_DB_NAME = 'harmony_signing_keys'
const SIGNING_DB_VERSION = 1
const SIGNING_STORE_NAME = 'signing'

class SigningKeyStore {
  private db: IDBDatabase | null = null

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(SIGNING_DB_NAME, SIGNING_DB_VERSION)

      request.onerror = () => {
        debug.warn('⚠️ SigningKeyStore: Failed to open IndexedDB:', request.error)
        reject(request.error)
      }

      request.onsuccess = () => {
        this.db = request.result
        this.db.onclose = () => { this.db = null }
        resolve(this.db)
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(SIGNING_STORE_NAME)) {
          db.createObjectStore(SIGNING_STORE_NAME, { keyPath: 'userId' })
        }
      }
    })
  }

  async store(userId: string, privateKey: CryptoKey): Promise<void> {
    const db = await this.open()

    // Re-import as non-extractable if the caller handed us an extractable key.
    let safeKey = privateKey
    if (privateKey.extractable) {
      const raw = await crypto.subtle.exportKey('pkcs8', privateKey)
      safeKey = await crypto.subtle.importKey(
        'pkcs8',
        raw,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign']
      )
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(SIGNING_STORE_NAME, 'readwrite')
      const store = tx.objectStore(SIGNING_STORE_NAME)
      store.put({ userId, privateKey: safeKey, storedAt: Date.now() })
      tx.oncomplete = () => {
        debug.log('🔐 Signing key stored securely in IndexedDB (non-extractable)')
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    })
  }

  async load(userId: string): Promise<CryptoKey | null> {
    try {
      const db = await this.open()

      return new Promise((resolve, reject) => {
        const tx = db.transaction(SIGNING_STORE_NAME, 'readonly')
        const store = tx.objectStore(SIGNING_STORE_NAME)
        const request = store.get(userId)

        request.onsuccess = () => {
          const result = request.result
          if (!result?.privateKey) {
            resolve(null)
            return
          }
          resolve(result.privateKey)
        }
        request.onerror = () => reject(request.error)
      })
    } catch {
      return null
    }
  }

  async clear(userId: string): Promise<void> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(SIGNING_STORE_NAME, 'readwrite')
        const store = tx.objectStore(SIGNING_STORE_NAME)
        store.delete(userId)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      debug.warn('⚠️ Failed to clear signing key from IndexedDB')
    }
  }

  async clearAll(): Promise<void> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(SIGNING_STORE_NAME, 'readwrite')
        const store = tx.objectStore(SIGNING_STORE_NAME)
        store.clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      debug.warn('⚠️ Failed to clear all signing keys from IndexedDB')
    }
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

export const signingKeyStore = new SigningKeyStore()

// =====================================================
// Pinned Key Store (TOFU)
//
// Trust-on-first-use record of each sender's signing-key fingerprint. This is
// NOT secret material - it stores short fingerprints so the client can notice
// when a contact's signing identity changes and surface a gentle, non-blocking
// notice (deliberately NOT a Matrix-style mandatory verification wall).
//
// Keyed by userId today; the record carries an optional deviceId so the Phase 3
// per-device identity model can pin per (userId, deviceId) without a schema
// migration (we bump DB_VERSION and switch the keyPath then).
// =====================================================

const PINNED_DB_NAME = 'harmony_pinned_keys'
const PINNED_DB_VERSION = 1
const PINNED_STORE_NAME = 'pinned'

export interface PinnedKeyRecord {
  userId: string
  deviceId?: string
  fingerprint: string
  pinnedAt: number
  updatedAt: number
}

class PinnedKeyStore {
  private db: IDBDatabase | null = null

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(PINNED_DB_NAME, PINNED_DB_VERSION)

      request.onerror = () => {
        debug.warn('⚠️ PinnedKeyStore: Failed to open IndexedDB:', request.error)
        reject(request.error)
      }

      request.onsuccess = () => {
        this.db = request.result
        this.db.onclose = () => { this.db = null }
        resolve(this.db)
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(PINNED_STORE_NAME)) {
          db.createObjectStore(PINNED_STORE_NAME, { keyPath: 'userId' })
        }
      }
    })
  }

  async get(userId: string): Promise<PinnedKeyRecord | null> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PINNED_STORE_NAME, 'readonly')
        const store = tx.objectStore(PINNED_STORE_NAME)
        const request = store.get(userId)
        request.onsuccess = () => resolve((request.result as PinnedKeyRecord) ?? null)
        request.onerror = () => reject(request.error)
      })
    } catch {
      return null
    }
  }

  async put(record: PinnedKeyRecord): Promise<void> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PINNED_STORE_NAME, 'readwrite')
        const store = tx.objectStore(PINNED_STORE_NAME)
        store.put(record)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      debug.warn('⚠️ Failed to write pinned key record')
    }
  }

  async clear(userId: string): Promise<void> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PINNED_STORE_NAME, 'readwrite')
        const store = tx.objectStore(PINNED_STORE_NAME)
        store.delete(userId)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      debug.warn('⚠️ Failed to clear pinned key record')
    }
  }

  async clearAll(): Promise<void> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PINNED_STORE_NAME, 'readwrite')
        const store = tx.objectStore(PINNED_STORE_NAME)
        store.clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      debug.warn('⚠️ Failed to clear all pinned key records')
    }
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

export const pinnedKeyStore = new PinnedKeyStore()

// =====================================================
// Device Key Store
//
// Per-device ECDSA signing private key (non-extractable), keyed by deviceId
// (NOT userId). This is the cryptographic core of the device-aware model: each
// browser profile / install signs its own v3 messages with a key that never
// leaves the device, so revoking a device (user_devices.revoked_at) actually
// cuts off that device's ability to produce verifiable messages.
//
// Kept separate from signingKeyStore (which holds the legacy user-level signing
// key) so the two can be cleared / rotated independently.
// =====================================================

const DEVICE_DB_NAME = 'harmony_device_keys'
const DEVICE_DB_VERSION = 1
const DEVICE_STORE_NAME = 'device'

class DeviceKeyStore {
  private db: IDBDatabase | null = null

  private async open(): Promise<IDBDatabase> {
    if (this.db) return this.db
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DEVICE_DB_NAME, DEVICE_DB_VERSION)
      request.onerror = () => {
        debug.warn('⚠️ DeviceKeyStore: Failed to open IndexedDB:', request.error)
        reject(request.error)
      }
      request.onsuccess = () => {
        this.db = request.result
        this.db.onclose = () => { this.db = null }
        resolve(this.db)
      }
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(DEVICE_STORE_NAME)) {
          db.createObjectStore(DEVICE_STORE_NAME, { keyPath: 'deviceId' })
        }
      }
    })
  }

  async storeSigningKey(deviceId: string, privateKey: CryptoKey): Promise<void> {
    const db = await this.open()
    let safeKey = privateKey
    if (privateKey.extractable) {
      const raw = await crypto.subtle.exportKey('pkcs8', privateKey)
      safeKey = await crypto.subtle.importKey('pkcs8', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DEVICE_STORE_NAME, 'readwrite')
      const store = tx.objectStore(DEVICE_STORE_NAME)
      store.put({ deviceId, signingPrivateKey: safeKey, storedAt: Date.now() })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async loadSigningKey(deviceId: string): Promise<CryptoKey | null> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DEVICE_STORE_NAME, 'readonly')
        const store = tx.objectStore(DEVICE_STORE_NAME)
        const request = store.get(deviceId)
        request.onsuccess = () => resolve(request.result?.signingPrivateKey ?? null)
        request.onerror = () => reject(request.error)
      })
    } catch {
      return null
    }
  }

  async clear(deviceId: string): Promise<void> {
    try {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const tx = db.transaction(DEVICE_STORE_NAME, 'readwrite')
        const store = tx.objectStore(DEVICE_STORE_NAME)
        store.delete(deviceId)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } catch {
      debug.warn('⚠️ Failed to clear device key')
    }
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

export const deviceKeyStore = new DeviceKeyStore()
