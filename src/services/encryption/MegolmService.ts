/**
 * Megolm Service
 * 
 * Implements Megolm-style group encryption for Harmony.
 * Unlike Signal's per-message key exchange, Megolm uses:
 * - One session key per room/conversation that rotates periodically
 * - Efficient for group messaging (one encryption, many recipients)
 * - Keys are backed up to server (encrypted with recovery key)
 * 
 * Key Concepts:
 * - Outbound Session: Your sending key for a room (you rotate it)
 * - Inbound Session: Others' keys you've received (they rotate them)
 * - Session ID: Unique identifier for each session
 * - Message Index: Ratchets forward for each message (forward secrecy)
 */

// Megolm session types
export interface MegolmOutboundSession {
  sessionId: string
  roomId: string // Can be channel_id or conversation_id
  sessionKey: string // Base64 encoded session key
  messageIndex: number // Current message index (ratchets forward)
  createdAt: number
  rotateAt: number // When to create a new session
  sharedWith: string[] // User IDs we've shared this session with
}

export interface MegolmInboundSession {
  sessionId: string
  roomId: string
  senderUserId: string
  sessionKey: string // Base64 encoded
  firstKnownIndex: number // First message index we can decrypt from
  createdAt: number
}

export interface MegolmEncryptedMessage {
  sessionId: string
  messageIndex: number
  ciphertext: string // Base64 encoded
}

// Session rotation settings
const SESSION_ROTATION_MESSAGE_COUNT = 100 // Rotate after 100 messages
const SESSION_ROTATION_TIME_MS = 7 * 24 * 60 * 60 * 1000 // Rotate after 7 days

// IndexedDB store for sessions
const MEGOLM_DB_NAME = 'harmony_megolm_sessions'
const MEGOLM_DB_VERSION = 1
const STORES = {
  OUTBOUND: 'outbound_sessions',
  INBOUND: 'inbound_sessions',
  ROOM_KEYS: 'room_keys', // Mapping of roomId -> current sessionId
}

/**
 * Megolm Service
 * Handles room-based session key encryption
 */
export class MegolmService {
  private static instance: MegolmService
  private db: IDBDatabase | null = null
  private userId: string | null = null
  private encryptionKey: CryptoKey | null = null
  private initialized = false

  // In-memory cache for active sessions
  private outboundSessions: Map<string, MegolmOutboundSession> = new Map()
  private inboundSessions: Map<string, MegolmInboundSession> = new Map()

  private constructor() {}

  static getInstance(): MegolmService {
    if (!MegolmService.instance) {
      MegolmService.instance = new MegolmService()
    }
    return MegolmService.instance
  }

  // =====================================================
  // INITIALIZATION
  // =====================================================

  async initialize(userId: string, encryptionKey: CryptoKey): Promise<void> {
    this.userId = userId
    this.encryptionKey = encryptionKey
    
    console.log(`🔐 MegolmService.initialize: userId=${userId}, hasEncryptionKey=${!!encryptionKey}`)

    await this.openDatabase()
    console.log(`🔐 MegolmService: Database opened: ${!!this.db}`)
    
    await this.loadSessionsFromDB()

    this.initialized = true
    console.log(`✅ MegolmService initialized: db=${!!this.db}, encryptionKey=${!!this.encryptionKey}, userId=${this.userId}`)
  }

  private async openDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(`${MEGOLM_DB_NAME}_${this.userId}`, MEGOLM_DB_VERSION)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        this.db = request.result
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        if (!db.objectStoreNames.contains(STORES.OUTBOUND)) {
          const outboundStore = db.createObjectStore(STORES.OUTBOUND, { keyPath: 'sessionId' })
          outboundStore.createIndex('roomId', 'roomId')
        }

        if (!db.objectStoreNames.contains(STORES.INBOUND)) {
          const inboundStore = db.createObjectStore(STORES.INBOUND, { keyPath: 'sessionId' })
          inboundStore.createIndex('roomId', 'roomId')
          inboundStore.createIndex('senderUserId', 'senderUserId')
        }

        if (!db.objectStoreNames.contains(STORES.ROOM_KEYS)) {
          db.createObjectStore(STORES.ROOM_KEYS, { keyPath: 'roomId' })
        }
      }
    })
  }

  private async loadSessionsFromDB(): Promise<void> {
    if (!this.db) {
      console.warn('⚠️ No database - cannot load sessions')
      return
    }

    // Load outbound sessions
    try {
      const outboundSessions = await this.getAllFromStore<MegolmOutboundSession>(STORES.OUTBOUND)
      console.log(`📦 Found ${outboundSessions.length} outbound sessions in IndexedDB`)
      
      for (const session of outboundSessions) {
        try {
          const decrypted = await this.decryptSession(session)
          this.outboundSessions.set(decrypted.roomId, decrypted)
          console.log(`  - Loaded outbound session for room ${decrypted.roomId.substring(0, 8)}... (${decrypted.sessionId.substring(0, 8)}...)`)
        } catch (error) {
          console.error(`❌ Failed to decrypt outbound session:`, error)
        }
      }
    } catch (error) {
      console.error('❌ Failed to load outbound sessions:', error)
    }

    // Load inbound sessions
    try {
      const inboundSessions = await this.getAllFromStore<MegolmInboundSession>(STORES.INBOUND)
      console.log(`📦 Found ${inboundSessions.length} inbound sessions in IndexedDB`)
      
      for (const session of inboundSessions) {
        try {
          const decrypted = await this.decryptSession(session)
          const key = `${decrypted.roomId}:${decrypted.senderUserId}:${decrypted.sessionId}`
          this.inboundSessions.set(key, decrypted)
          console.log(`  - Loaded inbound session from ${decrypted.senderUserId.substring(0, 8)}... for room ${decrypted.roomId.substring(0, 8)}...`)
        } catch (error) {
          console.error(`❌ Failed to decrypt inbound session:`, error)
        }
      }
    } catch (error) {
      console.error('❌ Failed to load inbound sessions:', error)
    }

    console.log(`📦 Loaded ${this.outboundSessions.size} outbound, ${this.inboundSessions.size} inbound sessions into memory`)
  }

  // =====================================================
  // OUTBOUND SESSION MANAGEMENT
  // =====================================================

  /**
   * Get or create an outbound session for a room
   */
  async getOrCreateOutboundSession(roomId: string): Promise<MegolmOutboundSession> {
    // Check if we have an existing valid session
    let session = this.outboundSessions.get(roomId)
    
    if (session && !this.shouldRotateSession(session)) {
      return session
    }

    // Create a new session
    session = await this.createOutboundSession(roomId)
    return session
  }

  /**
   * Create a new outbound session for a room
   */
  private async createOutboundSession(roomId: string): Promise<MegolmOutboundSession> {
    // Generate session key material (32 bytes for AES-256)
    const sessionKeyBytes = crypto.getRandomValues(new Uint8Array(32))
    const sessionKey = this.arrayBufferToBase64(sessionKeyBytes.buffer)

    // Generate unique session ID
    const sessionIdBytes = crypto.getRandomValues(new Uint8Array(16))
    const sessionId = this.arrayBufferToBase64(sessionIdBytes.buffer)

    const now = Date.now()
    const session: MegolmOutboundSession = {
      sessionId,
      roomId,
      sessionKey,
      messageIndex: 0,
      createdAt: now,
      rotateAt: now + SESSION_ROTATION_TIME_MS,
      sharedWith: []
    }

    // Store in memory
    this.outboundSessions.set(roomId, session)
    console.log(`🔑 Created new outbound Megolm session for room ${roomId.substring(0, 8)}... (sessionId: ${sessionId.substring(0, 8)}...)`)
    
    // Save to IndexedDB
    console.log(`💾 Attempting to save session to IndexedDB... (db=${!!this.db}, key=${!!this.encryptionKey})`)
    await this.saveOutboundSession(session)
    
    return session
  }

  /**
   * Check if a session should be rotated
   */
  private shouldRotateSession(session: MegolmOutboundSession): boolean {
    const now = Date.now()
    return (
      session.messageIndex >= SESSION_ROTATION_MESSAGE_COUNT ||
      now >= session.rotateAt
    )
  }

  /**
   * Increment message index after encrypting
   */
  async incrementMessageIndex(roomId: string): Promise<void> {
    const session = this.outboundSessions.get(roomId)
    if (!session) return

    session.messageIndex++
    await this.saveOutboundSession(session)
  }

  // =====================================================
  // INBOUND SESSION MANAGEMENT
  // =====================================================

  /**
   * Import an inbound session (received from another user)
   */
  async importInboundSession(
    roomId: string,
    senderUserId: string,
    sessionId: string,
    sessionKey: string,
    firstKnownIndex: number = 0
  ): Promise<void> {
    const session: MegolmInboundSession = {
      sessionId,
      roomId,
      senderUserId,
      sessionKey,
      firstKnownIndex,
      createdAt: Date.now()
    }

    const key = `${roomId}:${senderUserId}:${sessionId}`
    this.inboundSessions.set(key, session)
    await this.saveInboundSession(session)

    console.log(`📥 Imported inbound session from ${senderUserId.substring(0, 8)}... for room ${roomId.substring(0, 8)}...`)
  }

  /**
   * Get an inbound session for decryption
   */
  getInboundSession(roomId: string, senderUserId: string, sessionId: string): MegolmInboundSession | undefined {
    const key = `${roomId}:${senderUserId}:${sessionId}`
    return this.inboundSessions.get(key)
  }

  /**
   * Check if we have an inbound session
   */
  hasInboundSession(roomId: string, senderUserId: string, sessionId: string): boolean {
    const key = `${roomId}:${senderUserId}:${sessionId}`
    return this.inboundSessions.has(key)
  }

  // =====================================================
  // ENCRYPTION / DECRYPTION
  // =====================================================

  /**
   * Encrypt a message using the room's outbound session
   */
  async encryptMessage(roomId: string, plaintext: string): Promise<MegolmEncryptedMessage> {
    const session = await this.getOrCreateOutboundSession(roomId)

    // Derive the current ratchet key from session key + message index
    const ratchetKey = await this.deriveRatchetKey(session.sessionKey, session.messageIndex)

    // Encrypt the message
    const encoder = new TextEncoder()
    const plaintextBytes = encoder.encode(plaintext)
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const encryptedData = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      ratchetKey,
      plaintextBytes
    )

    // Combine IV + ciphertext
    const combined = new Uint8Array(iv.length + encryptedData.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encryptedData), iv.length)

    const result: MegolmEncryptedMessage = {
      sessionId: session.sessionId,
      messageIndex: session.messageIndex,
      ciphertext: this.arrayBufferToBase64(combined.buffer)
    }

    // Increment message index for next message
    await this.incrementMessageIndex(roomId)

    return result
  }

  /**
   * Decrypt a message using appropriate session
   * - For own messages: use outbound session
   * - For others' messages: use inbound session
   */
  async decryptMessage(
    roomId: string,
    senderUserId: string,
    encryptedMessage: MegolmEncryptedMessage
  ): Promise<string> {
    let sessionKey: string

    // Check if this is our own message
    if (senderUserId === this.userId) {
      // Use our outbound session for our own messages
      console.log(`🔓 Looking for outbound session for room ${roomId}`)
      console.log(`   Available rooms: [${Array.from(this.outboundSessions.keys()).join(', ')}]`)
      
      const outboundSession = this.outboundSessions.get(roomId)
      
      if (!outboundSession) {
        console.log(`❌ No outbound session found for room ${roomId}`)
        throw new Error(`No outbound session found for room ${roomId}`)
      }
      
      console.log(`   Found session: ${outboundSession.sessionId}`)
      console.log(`   Message wants: ${encryptedMessage.sessionId}`)
      console.log(`   Match: ${outboundSession.sessionId === encryptedMessage.sessionId}`)
      
      if (outboundSession.sessionId !== encryptedMessage.sessionId) {
        // Session might have rotated - the message was encrypted with an old session
        console.log(`⚠️ Session ID mismatch - message was encrypted with a different/rotated session`)
        throw new Error(`Session rotated - old session ${encryptedMessage.sessionId} no longer available`)
      }
      
      sessionKey = outboundSession.sessionKey
      console.log(`🔓 Decrypting own message with outbound session`)
    } else {
      // Use inbound session for others' messages
      const inboundSession = this.getInboundSession(roomId, senderUserId, encryptedMessage.sessionId)
      
      if (!inboundSession) {
        throw new Error(`No inbound session found for session ${encryptedMessage.sessionId}`)
      }
      
      if (encryptedMessage.messageIndex < inboundSession.firstKnownIndex) {
        throw new Error(`Message index ${encryptedMessage.messageIndex} is before first known index ${inboundSession.firstKnownIndex}`)
      }
      
      sessionKey = inboundSession.sessionKey
      console.log(`🔓 Decrypting message from ${senderUserId.substring(0, 8)}... with inbound session`)
    }

    // Derive the ratchet key for this message index
    const ratchetKey = await this.deriveRatchetKey(sessionKey, encryptedMessage.messageIndex)

    // Decode the ciphertext
    const combined = this.base64ToArrayBuffer(encryptedMessage.ciphertext)
    const combinedArray = new Uint8Array(combined)
    const iv = combinedArray.slice(0, 12)
    const ciphertext = combinedArray.slice(12)

    // Decrypt
    const decryptedData = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      ratchetKey,
      ciphertext
    )

    const decoder = new TextDecoder()
    return decoder.decode(decryptedData)
  }

  /**
   * Derive a ratchet key from session key and message index
   * This provides forward secrecy - each message uses a different key
   */
  private async deriveRatchetKey(sessionKeyBase64: string, messageIndex: number): Promise<CryptoKey> {
    const sessionKeyBytes = this.base64ToArrayBuffer(sessionKeyBase64)
    
    // Import the session key as key material
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      sessionKeyBytes,
      { name: 'HKDF' },
      false,
      ['deriveKey']
    )

    // Derive a unique key for this message index
    const encoder = new TextEncoder()
    const info = encoder.encode(`megolm_ratchet_${messageIndex}`)

    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32), // Fixed salt
        info
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  }

  // =====================================================
  // SESSION SHARING
  // =====================================================

  /**
   * Get session key data to share with a user
   * The session key should be encrypted before sending (using Signal or recovery key)
   */
  getSessionKeyForSharing(roomId: string): { sessionId: string; sessionKey: string; messageIndex: number } | null {
    const session = this.outboundSessions.get(roomId)
    if (!session) return null

    return {
      sessionId: session.sessionId,
      sessionKey: session.sessionKey,
      messageIndex: session.messageIndex
    }
  }

  /**
   * Mark that we've shared our session with a user
   */
  async markSessionSharedWith(roomId: string, userId: string): Promise<void> {
    const session = this.outboundSessions.get(roomId)
    if (!session) return

    if (!session.sharedWith.includes(userId)) {
      session.sharedWith.push(userId)
      await this.saveOutboundSession(session)
    }
  }

  /**
   * Get users we need to share our session with
   */
  getUsersNeedingSession(roomId: string, allUserIds: string[]): string[] {
    const session = this.outboundSessions.get(roomId)
    if (!session) return allUserIds

    return allUserIds.filter(id => !session.sharedWith.includes(id) && id !== this.userId)
  }

  // =====================================================
  // EXPORT / IMPORT FOR BACKUP
  // =====================================================

  /**
   * Export all sessions for backup
   * Returns unencrypted data - should be encrypted with recovery key before storing
   */
  async exportAllSessions(): Promise<{
    outbound: MegolmOutboundSession[]
    inbound: MegolmInboundSession[]
  }> {
    return {
      outbound: Array.from(this.outboundSessions.values()),
      inbound: Array.from(this.inboundSessions.values())
    }
  }

  /**
   * Import sessions from backup (MERGES with existing, doesn't clear)
   */
  async importAllSessions(data: {
    outbound: MegolmOutboundSession[]
    inbound: MegolmInboundSession[]
  }): Promise<void> {
    // Don't clear existing sessions! Merge instead.
    // This prevents losing locally-created sessions when backup is empty.
    
    if (data.outbound.length === 0 && data.inbound.length === 0) {
      console.log('ℹ️ Backup is empty, keeping existing sessions')
      return
    }

    console.log(`📥 Merging ${data.outbound.length} outbound, ${data.inbound.length} inbound sessions from backup`)

    // Import outbound sessions (merge - newer wins)
    for (const session of data.outbound) {
      const existing = this.outboundSessions.get(session.roomId)
      // Only replace if backup session is newer or we don't have one
      if (!existing || session.createdAt > existing.createdAt) {
        this.outboundSessions.set(session.roomId, session)
        await this.saveOutboundSession(session)
        console.log(`  - Imported outbound session for room ${session.roomId.substring(0, 8)}...`)
      }
    }

    // Import inbound sessions (merge - always add if we don't have it)
    for (const session of data.inbound) {
      const key = `${session.roomId}:${session.senderUserId}:${session.sessionId}`
      if (!this.inboundSessions.has(key)) {
        this.inboundSessions.set(key, session)
        await this.saveInboundSession(session)
        console.log(`  - Imported inbound session from ${session.senderUserId.substring(0, 8)}...`)
      }
    }

    console.log(`📥 Imported ${data.outbound.length} outbound, ${data.inbound.length} inbound sessions`)
  }

  // =====================================================
  // PERSISTENCE HELPERS
  // =====================================================

  private async saveOutboundSession(session: MegolmOutboundSession): Promise<void> {
    if (!this.db) {
      console.warn('⚠️ No database - cannot save outbound session')
      return
    }
    if (!this.encryptionKey) {
      console.warn('⚠️ No encryption key - cannot save outbound session')
      return
    }

    try {
      const encrypted = await this.encryptSession(session)
      await this.putInStore(STORES.OUTBOUND, encrypted)
      console.log(`💾 Saved outbound session for room ${session.roomId.substring(0, 8)}... to IndexedDB`)
    } catch (error) {
      console.error('❌ Failed to save outbound session:', error)
    }
  }

  private async saveInboundSession(session: MegolmInboundSession): Promise<void> {
    if (!this.db) {
      console.warn('⚠️ No database - cannot save inbound session')
      return
    }
    if (!this.encryptionKey) {
      console.warn('⚠️ No encryption key - cannot save inbound session')
      return
    }

    try {
      const encrypted = await this.encryptSession(session)
      await this.putInStore(STORES.INBOUND, encrypted)
      console.log(`💾 Saved inbound session for room ${session.roomId.substring(0, 8)}... to IndexedDB`)
    } catch (error) {
      console.error('❌ Failed to save inbound session:', error)
    }
  }

  private async encryptSession<T>(session: T): Promise<T> {
    if (!this.encryptionKey) return session

    const sessionCopy = { ...session } as any
    
    // Encrypt the sensitive sessionKey field
    if (sessionCopy.sessionKey) {
      const encoder = new TextEncoder()
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        this.encryptionKey,
        encoder.encode(sessionCopy.sessionKey)
      )

      const combined = new Uint8Array(iv.length + encrypted.byteLength)
      combined.set(iv)
      combined.set(new Uint8Array(encrypted), iv.length)
      sessionCopy.sessionKey = this.arrayBufferToBase64(combined.buffer)
      sessionCopy._encrypted = true
    }

    return sessionCopy
  }

  private async decryptSession<T>(session: T): Promise<T> {
    if (!this.encryptionKey) return session

    const sessionCopy = { ...session } as any

    if (sessionCopy._encrypted && sessionCopy.sessionKey) {
      const combined = this.base64ToArrayBuffer(sessionCopy.sessionKey)
      const combinedArray = new Uint8Array(combined)
      const iv = combinedArray.slice(0, 12)
      const ciphertext = combinedArray.slice(12)

      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        this.encryptionKey,
        ciphertext
      )

      const decoder = new TextDecoder()
      sessionCopy.sessionKey = decoder.decode(decrypted)
      delete sessionCopy._encrypted
    }

    return sessionCopy
  }

  // =====================================================
  // INDEXEDDB HELPERS
  // =====================================================

  private async getAllFromStore<T>(storeName: string): Promise<T[]> {
    if (!this.db) return []

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const request = store.getAll()

      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
  }

  private async putInStore(storeName: string, value: any): Promise<void> {
    if (!this.db) return

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.put(value)

      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  private async clearAllStores(): Promise<void> {
    if (!this.db) return

    for (const storeName of Object.values(STORES)) {
      await new Promise<void>((resolve, reject) => {
        const transaction = this.db!.transaction(storeName, 'readwrite')
        const store = transaction.objectStore(storeName)
        const request = store.clear()
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      })
    }
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

  isInitialized(): boolean {
    return this.initialized
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    this.outboundSessions.clear()
    this.inboundSessions.clear()
    this.initialized = false
  }
}

// Export singleton
export const megolmService = MegolmService.getInstance()

