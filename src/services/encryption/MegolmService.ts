/**
 * Megolm Service
 *
 * Implements Megolm-style group encryption for Harmony.
 *
 * LICENSING / PROVENANCE
 * ----------------------
 * Independent implementation inspired by Matrix.org's Megolm
 * design (specification: https://gitlab.matrix.org/matrix-org/olm/-/blob/master/docs/megolm.md).
 * This is NOT a port of libolm/vodozemac/matrix-js-sdk - no Matrix code or
 * libraries are bundled. Crypto primitives come from the browser's WebCrypto
 * API (AES-GCM + HKDF). Licensed under AGPL-3.0 with the rest of Harmony.
 *
 * Wire format and ratchet construction are Harmony-specific (HKDF info string
 * `megolm_ratchet_${messageIndex}`) and intentionally NOT wire-compatible with
 * Matrix's Megolm. Cross-Matrix interop would require a separate adapter.
 *
 * DESIGN
 * ------
 * Unlike Signal's per-message key exchange, Megolm uses:
 * - One session key per room/conversation that rotates periodically
 * - Efficient for group messaging (one encryption, many recipients)
 * - Keys are backed up to server (encrypted with recovery key)
 *
 * Key Concepts:
 * - Outbound Session: Your sending key for a room (you rotate it)
 * - Inbound Session: Others' keys you've received (they rotate them)
 * - Session ID: Unique identifier for each session
 * - Message Index: Ratchets forward so each message gets a distinct derived key.
 *
 * SECRECY PROPERTIES (read this before claiming "forward secrecy")
 * ----------------------------------------------------------------
 * Each message is encrypted under a key derived from the session key and the
 * message index, so no two messages share a key. This is NOT strong forward
 * secrecy: the per-message keys are derived deterministically from the
 * long-lived session key (HKDF, no ratchet state erasure), so anyone who
 * learns a session key can derive the keys for EVERY message in that session -
 * past and future - until the session rotates. Session rotation (every 100
 * messages or 7 days) is what bounds the blast radius of a leaked session key.
 * Describe this as "per-message keys + session rotation", never as Signal-style
 * forward secrecy.
 */

import { debug } from '@/utils/debug'

// Megolm session types
export interface MegolmOutboundSession {
  sessionId: string
  roomId: string // Can be channel_id or conversation_id
  sessionKey: string // Base64 encoded session key
  messageIndex: number // Current message index (ratchets forward)
  createdAt: number
  rotateAt: number // When to create a new session
  sharedWith: string[] // User IDs we've shared this session with
  // Membership epoch this session belongs to (Phase 3b). A session is rotated
  // when the room's epoch advances (member join/leave), so a removed member's
  // old session cannot decrypt newer-epoch messages. Defaults to 1 for
  // sessions created before epochs existed.
  epoch?: number
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
  epoch?: number // Membership epoch of the session used (Phase 3b)
}

/** Optional per-message crypto options (Phase 3c v3). */
export interface MegolmEncryptOptions {
  // Current room epoch; rotates the session if it advanced.
  epoch?: number
  // AES-GCM Additional Authenticated Data binding message metadata to the
  // ciphertext (algorithm, room_id, sender, session, index, epoch, ...).
  additionalData?: Uint8Array
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
  ROOM_KEYS: 'room_keys', // Canonical roomId -> current outbound sessionId
}

interface RoomKeyRecord {
  roomId: string
  sessionId: string
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

  // Serialize per-room encrypts so concurrent sends cannot reuse messageIndex.
  private roomEncryptLocks = new Map<string, Promise<void>>()

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
    
    debug.log(`🔐 MegolmService.initialize: userId=${userId}, hasEncryptionKey=${!!encryptionKey}`)

    await this.openDatabase()
    debug.log(`🔐 MegolmService: Database opened: ${!!this.db}`)
    
    await this.loadSessionsFromDB()

    // Migration: ensure all outbound sessions also have inbound copies
    // This handles existing users who have outbound sessions but no inbound copies
    await this.migrateOutboundToInbound()

    this.initialized = true
    debug.log(`✅ MegolmService initialized: db=${!!this.db}, encryptionKey=${!!this.encryptionKey}, userId=${this.userId}`)
  }

  /**
   * Migration: Copy outbound sessions to inbound sessions
   * 
   * This ensures users who had sessions before this fix can still decrypt
   * their own old messages. In the Matrix/Element model, all sessions
   * (including your own) are stored as inbound for consistent lookup.
   */
  private async migrateOutboundToInbound(): Promise<void> {
    if (!this.userId) return

    let migratedCount = 0
    for (const [roomId, outbound] of this.outboundSessions) {
      const key = `${roomId}:${this.userId}:${outbound.sessionId}`
      
      // Only migrate if we don't already have this as inbound
      if (!this.inboundSessions.has(key)) {
        const inbound: MegolmInboundSession = {
          sessionId: outbound.sessionId,
          roomId: outbound.roomId,
          senderUserId: this.userId,
          sessionKey: outbound.sessionKey,
          firstKnownIndex: 0,
          createdAt: outbound.createdAt
        }
        
        this.inboundSessions.set(key, inbound)
        await this.saveInboundSession(inbound)
        migratedCount++
      }
    }

    if (migratedCount > 0) {
      debug.log(`🔄 Migrated ${migratedCount} outbound sessions to inbound (for self-decryption)`)
    }
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
      debug.warn('⚠️ No database - cannot load sessions')
      return
    }

    // Load outbound sessions via ROOM_KEYS (canonical current session per room).
    try {
      const allOutbound = await this.getAllFromStore<MegolmOutboundSession>(STORES.OUTBOUND)
      debug.log(`📦 Found ${allOutbound.length} outbound sessions in IndexedDB`)

      const bySessionId = new Map<string, MegolmOutboundSession>()
      for (const stored of allOutbound) {
        try {
          const decrypted = await this.decryptSession(stored)
          bySessionId.set(decrypted.sessionId, decrypted)
        } catch (error) {
          debug.error('❌ Failed to decrypt outbound session:', error)
        }
      }

      const roomKeys = await this.getAllFromStore<RoomKeyRecord>(STORES.ROOM_KEYS)
      const roomsWithKeys = new Set<string>()

      for (const rk of roomKeys) {
        const current = bySessionId.get(rk.sessionId)
        if (current) {
          this.outboundSessions.set(rk.roomId, current)
          roomsWithKeys.add(rk.roomId)
          debug.log(
            `  - Loaded current outbound for room ${rk.roomId.substring(0, 8)}... ` +
            `(${current.sessionId.substring(0, 8)}...)`,
          )
        }
      }

      // Legacy fallback: no ROOM_KEYS row → pick newest createdAt per room, then backfill.
      const newestByRoom = new Map<string, MegolmOutboundSession>()
      for (const session of bySessionId.values()) {
        const prev = newestByRoom.get(session.roomId)
        if (!prev || session.createdAt > prev.createdAt) {
          newestByRoom.set(session.roomId, session)
        }
      }
      for (const [roomId, session] of newestByRoom) {
        if (roomsWithKeys.has(roomId)) continue
        this.outboundSessions.set(roomId, session)
        try {
          await this.setCurrentRoomSession(roomId, session.sessionId)
          debug.log(
            `  - Backfilled ROOM_KEYS for room ${roomId.substring(0, 8)}... ` +
            `(${session.sessionId.substring(0, 8)}...)`,
          )
        } catch (error) {
          debug.warn('⚠️ Failed to backfill ROOM_KEYS:', error)
        }
      }
    } catch (error) {
      debug.error('❌ Failed to load outbound sessions:', error)
    }

    // Load inbound sessions
    try {
      const inboundSessions = await this.getAllFromStore<MegolmInboundSession>(STORES.INBOUND)
      debug.log(`📦 Found ${inboundSessions.length} inbound sessions in IndexedDB`)
      
      for (const session of inboundSessions) {
        try {
          const decrypted = await this.decryptSession(session)
          const key = `${decrypted.roomId}:${decrypted.senderUserId}:${decrypted.sessionId}`
          this.inboundSessions.set(key, decrypted)
          debug.log(`  - Loaded inbound session from ${decrypted.senderUserId.substring(0, 8)}... for room ${decrypted.roomId.substring(0, 8)}...`)
        } catch (error) {
          debug.error(`❌ Failed to decrypt inbound session:`, error)
        }
      }
    } catch (error) {
      debug.error('❌ Failed to load inbound sessions:', error)
    }

    debug.log(`📦 Loaded ${this.outboundSessions.size} outbound, ${this.inboundSessions.size} inbound sessions into memory`)
  }

  // =====================================================
  // OUTBOUND SESSION MANAGEMENT
  // =====================================================

  /**
   * Get or create an outbound session for a room.
   *
   * @param epoch the room's current membership epoch. When provided and greater
   *   than the existing session's epoch, the session is rotated so post-change
   *   messages use a fresh key (membership-epoch rotation, Phase 3b).
   */
  async getOrCreateOutboundSession(roomId: string, epoch?: number): Promise<MegolmOutboundSession> {
    // Check if we have an existing valid session
    let session = this.outboundSessions.get(roomId)

    const epochAdvanced =
      session != null &&
      typeof epoch === 'number' &&
      epoch > (session.epoch ?? 1)

    if (session && !this.shouldRotateSession(session) && !epochAdvanced) {
      return session
    }

    // Create a new session (tagged with the current epoch).
    session = await this.createOutboundSession(roomId, epoch)
    return session
  }

  /**
   * Create a new outbound session for a room
   * 
   * IMPORTANT: We also store a copy as an inbound session (from ourselves).
   * This is the Matrix/Element approach - it ensures we can always decrypt our
   * own messages even after session rotation, because we look up by sessionId.
   */
  private async createOutboundSession(roomId: string, epoch?: number): Promise<MegolmOutboundSession> {
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
      sharedWith: [],
      epoch: typeof epoch === 'number' ? epoch : 1
    }

    // Store in memory
    this.outboundSessions.set(roomId, session)
    debug.log(`🔑 Created new outbound Megolm session for room ${roomId.substring(0, 8)}... (sessionId: ${sessionId.substring(0, 8)}...)`)
    
    debug.log(`💾 Attempting to save session to IndexedDB... (db=${!!this.db}, key=${!!this.encryptionKey})`)
    await this.saveOutboundSessionStrict(session)
    await this.setCurrentRoomSession(roomId, sessionId)
    
    // Also store as inbound session (for decrypting our own messages later)
    // This is how Matrix/Element works - all sessions are stored as inbound for lookup by sessionId
    if (this.userId) {
      await this.importInboundSession(
        roomId,
        this.userId,
        sessionId,
        sessionKey,
        0 // firstKnownIndex
      )
      debug.log(`📥 Also stored as inbound session (for own message decryption)`)
    }
    
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
   * Advance the index on the exact outbound session that produced a ciphertext.
   * Refuses if the room's current outbound changed underneath us.
   */
  private async advanceOutboundSessionIndex(
    session: MegolmOutboundSession,
    expectedIndex: number,
  ): Promise<void> {
    const current = this.outboundSessions.get(session.roomId)
    if (!current || current.sessionId !== session.sessionId) {
      throw new Error('Megolm outbound session changed during encryption')
    }
    if (current.messageIndex !== expectedIndex) {
      throw new Error('Megolm message index changed during encryption')
    }
    current.messageIndex = expectedIndex + 1
    await this.saveOutboundSessionStrict(current)
  }

  private async loadCurrentOutboundSessionForRoom(roomId: string): Promise<MegolmOutboundSession | null> {
    const roomKey = await this.getFromStore<RoomKeyRecord>(STORES.ROOM_KEYS, roomId)
    if (!roomKey?.sessionId) return null

    const encrypted = await this.getFromStore<MegolmOutboundSession>(STORES.OUTBOUND, roomKey.sessionId)
    if (!encrypted) return null

    return this.decryptSession(encrypted)
  }

  private async refreshOutboundSessionFromPersistence(roomId: string): Promise<void> {
    const persisted = await this.loadCurrentOutboundSessionForRoom(roomId)
    if (persisted) {
      this.outboundSessions.set(roomId, persisted)
    }
  }

  private async setCurrentRoomSession(roomId: string, sessionId: string): Promise<void> {
    await this.putInStore(STORES.ROOM_KEYS, { roomId, sessionId })
  }

  private async withInMemoryRoomEncryptLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.roomEncryptLocks.get(roomId) ?? Promise.resolve()

    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })

    const tail = previous.then(() => current, () => current)
    this.roomEncryptLocks.set(roomId, tail)

    await previous.catch(() => {})

    try {
      return await fn()
    } finally {
      release()
      if (this.roomEncryptLocks.get(roomId) === tail) {
        this.roomEncryptLocks.delete(roomId)
      }
    }
  }

  private async withRoomEncryptLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const run = () => this.withInMemoryRoomEncryptLock(roomId, fn)
    const locks = typeof navigator !== 'undefined'
      ? (navigator as Navigator & { locks?: LockManager }).locks
      : undefined
    if (locks?.request) {
      return locks.request(`harmony-megolm-encrypt:${roomId}`, run)
    }
    return run()
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

    debug.log(`📥 Imported inbound session from ${senderUserId.substring(0, 8)}... for room ${roomId.substring(0, 8)}...`)
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

  /**
   * Find an inbound session by sessionId only (searches all senders)
   * Useful for fallback when we don't know the exact sender
   */
  findInboundSessionBySessionId(roomId: string, sessionId: string): MegolmInboundSession | undefined {
    // Look for any inbound session with matching roomId and sessionId
    for (const [_key, session] of this.inboundSessions) {
      if (session.roomId === roomId && session.sessionId === sessionId) {
        return session
      }
    }
    return undefined
  }

  /**
   * Get all inbound sessions for a room (for debugging/diagnostics)
   */
  getInboundSessionsForRoom(roomId: string): MegolmInboundSession[] {
    const sessions: MegolmInboundSession[] = []
    for (const [_, session] of this.inboundSessions) {
      if (session.roomId === roomId) {
        sessions.push(session)
      }
    }
    return sessions
  }

  // =====================================================
  // ENCRYPTION / DECRYPTION
  // =====================================================

  /**
   * Encrypt a message using the room's outbound session.
   *
   * @param opts.epoch          current room epoch (rotates the session if it advanced)
   * @param opts.additionalData AES-GCM AAD that binds message metadata to the
   *                            ciphertext (v3). The SAME bytes must be supplied
   *                            to decryptMessage or authentication fails.
   */
  async encryptMessage(
    roomId: string,
    plaintext: string,
    opts: MegolmEncryptOptions = {},
  ): Promise<MegolmEncryptedMessage> {
    return this.withRoomEncryptLock(roomId, () =>
      this.encryptMessageInner(roomId, plaintext, opts),
    )
  }

  private async encryptMessageInner(
    roomId: string,
    plaintext: string,
    opts: MegolmEncryptOptions = {},
  ): Promise<MegolmEncryptedMessage> {
    // Cross-tab: reload canonical outbound state written by whichever tab last held the lock.
    await this.refreshOutboundSessionFromPersistence(roomId)

    // v3 path: caller already resolved session + epoch and built AAD. Do not
    // call getOrCreateOutboundSession again (it could rotate or pick a different
    // epoch than the AAD encodes).
    let session: MegolmOutboundSession
    if (opts.additionalData) {
      const existing = this.outboundSessions.get(roomId)
      if (!existing) {
        throw new Error('Megolm outbound session missing for v3 encrypt')
      }
      if (opts.epoch !== undefined && (existing.epoch ?? 1) !== opts.epoch) {
        throw new Error('Megolm v3 AAD epoch does not match outbound session epoch')
      }
      if (this.shouldRotateSession(existing)) {
        throw new Error('Megolm outbound session must be rotated before v3 encrypt')
      }
      session = existing
    } else {
      session = await this.getOrCreateOutboundSession(roomId, opts.epoch)
    }

    const messageIndex = session.messageIndex
    const ratchetKey = await this.deriveRatchetKey(session.sessionKey, messageIndex)

    const encoder = new TextEncoder()
    const plaintextBytes = encoder.encode(plaintext)
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const gcmParams: AesGcmParams = { name: 'AES-GCM', iv }
    if (opts.additionalData) gcmParams.additionalData = opts.additionalData

    const encryptedData = await crypto.subtle.encrypt(
      gcmParams,
      ratchetKey,
      plaintextBytes,
    )

    const combined = new Uint8Array(iv.length + encryptedData.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encryptedData), iv.length)

    const result: MegolmEncryptedMessage = {
      sessionId: session.sessionId,
      messageIndex,
      ciphertext: this.arrayBufferToBase64(combined.buffer),
      epoch: session.epoch ?? 1,
    }

    await this.advanceOutboundSessionIndex(session, messageIndex)

    return result
  }

  /**
   * Decrypt a message using inbound session (Matrix/Element approach)
   * 
   * ALL messages (including our own) are decrypted using inbound sessions.
   * This works because when we create an outbound session, we also store it
   * as an inbound session from ourselves. This ensures we can decrypt old
   * messages even after session rotation.
   * 
   * Lookup is by sessionId, which is preserved forever.
   */
  async decryptMessage(
    roomId: string,
    senderUserId: string,
    encryptedMessage: MegolmEncryptedMessage,
    additionalData?: Uint8Array
  ): Promise<string> {
    // Always use inbound session lookup (this works for both own and others' messages)
    // Own messages work because createOutboundSession also saves as inbound
    debug.log(`🔓 Looking for inbound session ${encryptedMessage.sessionId.substring(0, 8)}... from ${senderUserId.substring(0, 8)}...`)
    
    let inboundSession = this.getInboundSession(roomId, senderUserId, encryptedMessage.sessionId)
    
    // Fallback: for own messages, also try the current outbound session if inbound not found
    // (handles edge case during migration when old outbound sessions weren't stored as inbound)
    if (!inboundSession && senderUserId === this.userId) {
      const outboundSession = this.outboundSessions.get(roomId)
      if (outboundSession && outboundSession.sessionId === encryptedMessage.sessionId) {
        debug.log(`🔓 Using current outbound session as fallback`)
        // Also save it as inbound for future lookups
        await this.importInboundSession(
          roomId,
          this.userId,
          outboundSession.sessionId,
          outboundSession.sessionKey,
          0
        )
        inboundSession = this.getInboundSession(roomId, senderUserId, encryptedMessage.sessionId)
      }
    }
    
    if (!inboundSession) {
      debug.log(`❌ No session found for ${encryptedMessage.sessionId}`)
      debug.log(`   Available inbound sessions: ${this.inboundSessions.size}`)
      // Log what sessions we have for this room
      const roomSessions = Array.from(this.inboundSessions.keys())
        .filter(k => k.startsWith(roomId))
      debug.log(`   Sessions for this room: [${roomSessions.map(k => k.split(':').pop()?.substring(0, 8)).join(', ')}]`)
      throw new Error(`No inbound session found for session ${encryptedMessage.sessionId}`)
    }
    
    if (encryptedMessage.messageIndex < inboundSession.firstKnownIndex) {
      throw new Error(`Message index ${encryptedMessage.messageIndex} is before first known index ${inboundSession.firstKnownIndex}`)
    }
    
    debug.log(`🔓 Decrypting with inbound session from ${senderUserId.substring(0, 8)}...`)

    // Derive the ratchet key for this message index
    const ratchetKey = await this.deriveRatchetKey(inboundSession.sessionKey, encryptedMessage.messageIndex)

    // Decode the ciphertext
    const combined = this.base64ToArrayBuffer(encryptedMessage.ciphertext)
    const combinedArray = new Uint8Array(combined)
    const iv = combinedArray.slice(0, 12)
    const ciphertext = combinedArray.slice(12)

    // Decrypt. When AAD was supplied at encrypt time (v3), the same bytes must
    // be provided here or GCM authentication fails (which is the point - it
    // binds the metadata to the ciphertext).
    const gcmParams: AesGcmParams = { name: 'AES-GCM', iv }
    if (additionalData) gcmParams.additionalData = additionalData

    const decryptedData = await crypto.subtle.decrypt(
      gcmParams,
      ratchetKey,
      ciphertext
    )

    const decoder = new TextDecoder()
    return decoder.decode(decryptedData)
  }

  /**
   * Derive a ratchet key from session key and message index.
   * Each message index yields a distinct AES-GCM key, so no two messages reuse
   * a key. Note this is deterministic from the session key (not a destructive
   * ratchet): compromise of the session key exposes every message in the
   * session until rotation. See the secrecy-properties note at the top of file.
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
   * Session key material for sharing. When `sessionId` is supplied the lookup is
   * exact: current outbound or our own inbound copy of a prior outbound session.
   * Never returns another sender's inbound session key.
   */
  getSessionKeyForSharing(
    roomId: string,
    sessionId?: string,
  ): { sessionId: string; sessionKey: string; messageIndex: number } | null {
    const outbound = this.outboundSessions.get(roomId)

    if (outbound && (!sessionId || outbound.sessionId === sessionId)) {
      return {
        sessionId: outbound.sessionId,
        sessionKey: outbound.sessionKey,
        messageIndex: outbound.messageIndex,
      }
    }

    if (!sessionId || !this.userId) return null

    const ownInbound = this.getInboundSession(roomId, this.userId, sessionId)
    if (ownInbound) {
      return {
        sessionId: ownInbound.sessionId,
        sessionKey: ownInbound.sessionKey,
        messageIndex: 0,
      }
    }

    return null
  }

  // Recipients already given a historical outbound session (room rotated since).
  private sessionSharedRecipients = new Map<string, string[]>()

  /**
   * Mark that we've shared a session with a user.
   * @param sessionId when set, tracks sharing for that exact session (not only the current outbound).
   */
  async markSessionSharedWith(roomId: string, userId: string, sessionId?: string): Promise<void> {
    const outbound = this.outboundSessions.get(roomId)
    const targetSessionId = sessionId ?? outbound?.sessionId
    if (!targetSessionId) return

    if (outbound?.sessionId === targetSessionId) {
      if (!outbound.sharedWith.includes(userId)) {
        outbound.sharedWith.push(userId)
        await this.saveOutboundSession(outbound)
      }
      return
    }

    const key = `${roomId}:${targetSessionId}`
    const list = this.sessionSharedRecipients.get(key) ?? []
    if (!list.includes(userId)) {
      list.push(userId)
      this.sessionSharedRecipients.set(key, list)
    }
  }

  /**
   * Get users we need to share a session with.
   * @param sessionId when set, checks share state for that exact session.
   */
  getUsersNeedingSession(roomId: string, allUserIds: string[], sessionId?: string): string[] {
    const outbound = this.outboundSessions.get(roomId)
    const targetSessionId = sessionId ?? outbound?.sessionId
    if (!targetSessionId) return allUserIds

    const sharedWith = outbound?.sessionId === targetSessionId
      ? outbound.sharedWith
      : (this.sessionSharedRecipients.get(`${roomId}:${targetSessionId}`) ?? [])

    return allUserIds.filter(id => !sharedWith.includes(id) && id !== this.userId)
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
   * 
   * Also creates inbound copies of outbound sessions (Matrix/Element approach)
   * to ensure self-decryption works for historical messages.
   */
  async importAllSessions(data: {
    outbound: MegolmOutboundSession[]
    inbound: MegolmInboundSession[]
  }): Promise<void> {
    // Don't clear existing sessions! Merge instead.
    // This prevents losing locally-created sessions when backup is empty.
    
    if (data.outbound.length === 0 && data.inbound.length === 0) {
      debug.log('ℹ️ Backup is empty, keeping existing sessions')
      return
    }

    debug.log(`📥 Merging ${data.outbound.length} outbound, ${data.inbound.length} inbound sessions from backup`)

    // Import outbound sessions (merge - newer wins)
    for (const session of data.outbound) {
      const existing = this.outboundSessions.get(session.roomId)
      // Only replace if backup session is newer or we don't have one
      if (!existing || session.createdAt > existing.createdAt) {
        this.outboundSessions.set(session.roomId, session)
        await this.saveOutboundSessionStrict(session)
        await this.setCurrentRoomSession(session.roomId, session.sessionId)
        debug.log(`  - Imported outbound session for room ${session.roomId.substring(0, 8)}...`)
      }
      
      // MIGRATION: Also create inbound copy for self-decryption
      // This handles backups created before the Matrix-style fix
      if (this.userId) {
        const inboundKey = `${session.roomId}:${this.userId}:${session.sessionId}`
        if (!this.inboundSessions.has(inboundKey)) {
          const inbound: MegolmInboundSession = {
            sessionId: session.sessionId,
            roomId: session.roomId,
            senderUserId: this.userId,
            sessionKey: session.sessionKey,
            firstKnownIndex: 0,
            createdAt: session.createdAt
          }
          this.inboundSessions.set(inboundKey, inbound)
          await this.saveInboundSession(inbound)
          debug.log(`  - Created inbound copy for self-decryption`)
        }
      }
    }

    // Import inbound sessions (merge - always add if we don't have it)
    for (const session of data.inbound) {
      const key = `${session.roomId}:${session.senderUserId}:${session.sessionId}`
      if (!this.inboundSessions.has(key)) {
        this.inboundSessions.set(key, session)
        await this.saveInboundSession(session)
        debug.log(`  - Imported inbound session from ${session.senderUserId.substring(0, 8)}...`)
      }
    }

    debug.log(`📥 Imported ${data.outbound.length} outbound, ${data.inbound.length} inbound sessions`)
  }

  // =====================================================
  // PERSISTENCE HELPERS
  // =====================================================

  /** Best-effort outbound save (e.g. sharedWith bookkeeping). */
  private async saveOutboundSession(session: MegolmOutboundSession): Promise<void> {
    if (!this.db) {
      debug.warn('⚠️ No database - cannot save outbound session')
      return
    }
    if (!this.encryptionKey) {
      debug.warn('⚠️ No encryption key - cannot save outbound session')
      return
    }

    try {
      const encrypted = await this.encryptSession(session)
      await this.putInStore(STORES.OUTBOUND, encrypted)
      debug.log(`💾 Saved outbound session for room ${session.roomId.substring(0, 8)}... to IndexedDB`)
    } catch (error) {
      debug.error('❌ Failed to save outbound session:', error)
    }
  }

  /** Fail-closed outbound save for session creation and message-index advancement. */
  private async saveOutboundSessionStrict(session: MegolmOutboundSession): Promise<void> {
    if (!this.db) {
      throw new Error('No database - cannot save outbound session')
    }
    if (!this.encryptionKey) {
      throw new Error('No encryption key - cannot save outbound session')
    }

    const encrypted = await this.encryptSession(session)
    await this.putInStore(STORES.OUTBOUND, encrypted)
    debug.log(`💾 Saved outbound session for room ${session.roomId.substring(0, 8)}... to IndexedDB`)
  }

  private async saveInboundSession(session: MegolmInboundSession): Promise<void> {
    if (!this.db) {
      debug.warn('⚠️ No database - cannot save inbound session')
      return
    }
    if (!this.encryptionKey) {
      debug.warn('⚠️ No encryption key - cannot save inbound session')
      return
    }

    try {
      const encrypted = await this.encryptSession(session)
      await this.putInStore(STORES.INBOUND, encrypted)
      debug.log(`💾 Saved inbound session for room ${session.roomId.substring(0, 8)}... to IndexedDB`)
    } catch (error) {
      debug.error('❌ Failed to save inbound session:', error)
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

  private async getFromStore<T>(storeName: string, key: string): Promise<T | null> {
    if (!this.db) return null

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const request = store.get(key)

      request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
      request.onerror = () => reject(request.error)
    })
  }

  private async putInStore(storeName: string, value: any): Promise<void> {
    if (!this.db) throw new Error(`No database - cannot write ${storeName}`)

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)

      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)

      store.put(value)
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
    this.roomEncryptLocks.clear()
    this.sessionSharedRecipients.clear()
    this.initialized = false
  }
}

// Export singleton
export const megolmService = MegolmService.getInstance()

