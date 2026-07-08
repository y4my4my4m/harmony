/**
 * Megolm Key Backup Service
 * 
 * Handles server-side encrypted backup of Megolm session keys AND
 * realtime key request/fulfillment for cross-device key sharing.
 * 
 * Security Model:
 * - All session keys are encrypted with user's recovery key before upload
 * - Server only stores encrypted blobs - cannot decrypt without recovery key
 * - User can restore all keys on new device using recovery phrase
 * 
 * Backup Storage:
 * - Stored in database table `megolm_key_backups`
 * - Each user has one backup that gets updated as sessions are created
 * - Backup is automatically updated when new sessions are created
 * 
 * Realtime Key Requests (NEW):
 * - When a user can't decrypt a message, they create a key request
 * - The sender receives this request via realtime subscription
 * - Sender automatically fulfills the request if they have the session key
 * - Requester receives the fulfilled key via realtime and imports it
 */

import { supabase } from '@/supabase'
import { recoveryKeyService } from './RecoveryKeyService'
import { megolmService, type MegolmOutboundSession, type MegolmInboundSession } from './MegolmService'
import { identityKeyStore, signingKeyStore } from './SecureSessionKeyStore'
import {
  signKeyRequest,
  verifyKeyRequestSignature,
  importPublicSigningKey,
  type KeyRequestFields,
} from './MessageSigner'
import { userEventChannel } from '@/services/UserEventChannel'
import { debug } from '@/utils/debug'

// Key request from the database
export interface KeyRequest {
  id: string
  requester_user_id: string
  sender_user_id: string
  room_id: string
  session_id: string
  status: 'pending' | 'fulfilled' | 'expired' | 'cancelled'
  encrypted_key?: string
  created_at: string
  fulfilled_at?: string
  // Requester's signature over (room_id, session_id, requester_user_id),
  // verified by the fulfiller before handing over the session key.
  request_signature?: string
  request_signing_fingerprint?: string
}

// Callback for when a key is received
export type KeyReceivedCallback = (roomId: string, sessionId: string) => void

// Backup data structure
export interface MegolmBackupData {
  version: number
  userId: string
  timestamp: number
  sessions: {
    outbound: MegolmOutboundSession[]
    inbound: MegolmInboundSession[]
  }
}

// Backup metadata stored on server
export interface BackupMetadata {
  id: string
  user_id: string
  version: number
  session_count: number
  last_updated: string
  backup_hash: string
}

/**
 * Megolm Key Backup Service
 * Handles encrypted backup and restore of session keys
 * AND realtime key request/fulfillment
 */
export class MegolmKeyBackupService {
  private static instance: MegolmKeyBackupService
  private userId: string | null = null
  private autoBackupEnabled = true
  private autoBackupTimer: ReturnType<typeof setTimeout> | null = null
  private readonly AUTO_BACKUP_DEBOUNCE_MS = 4000

  private broadcastUnsubs: Array<() => void> = []

  private keyReceivedCallbacks: Set<KeyReceivedCallback> = new Set()

  // sessionId → { requestId, createdAt }. Entries expire (KEY_REQUEST_RETRY_MS)
  // so an unanswered/failed request can be re-issued without a full reload.
  private pendingRequests: Map<string, { requestId: string; createdAt: number }> = new Map()
  private readonly KEY_REQUEST_RETRY_MS = 2 * 60_000

  private constructor() {}

  static getInstance(): MegolmKeyBackupService {
    if (!MegolmKeyBackupService.instance) {
      MegolmKeyBackupService.instance = new MegolmKeyBackupService()
    }
    return MegolmKeyBackupService.instance
  }

  // INITIALIZATION

  async initialize(userId: string): Promise<void> {
    if (this.userId && this.userId !== userId) {
      this.cleanup()
    }

    this.userId = userId
    
    await this.setupRealtimeSubscriptions()
    
    debug.log('✅ MegolmKeyBackupService initialized with realtime key request support')
  }

  /**
   * Set up broadcast handlers for key request flow via user:{id} channel.
   */
  private async setupRealtimeSubscriptions(): Promise<void> {
    if (!this.userId) return

    for (const unsub of this.broadcastUnsubs) unsub()
    this.broadcastUnsubs = []

    userEventChannel.connect(this.userId)

    this.broadcastUnsubs.push(
      userEventChannel.on('encryption:key_request', (data) => {
        this.handleIncomingKeyRequest(data as unknown as KeyRequest)
      })
    )

    this.broadcastUnsubs.push(
      userEventChannel.on('encryption:key_fulfilled', (data) => {
        this.handleFulfilledRequest(data as unknown as KeyRequest)
      })
    )

    debug.log('🔔 Encryption key request handlers registered via user:{id} broadcast')
  }

  /**
   * Handle an incoming key request from another user
   * Auto-fulfill if we have the session key
   */
  private async handleIncomingKeyRequest(request: KeyRequest): Promise<void> {
    debug.log(`📩 Received key request from ${request.requester_user_id.substring(0, 8)}... for session ${request.session_id.substring(0, 8)}...`)

    if (!megolmService.isInitialized()) {
      debug.log('⏸️ Megolm not initialized, cannot fulfill request')
      return
    }

    try {
      // Resolve the session key to hand over, two sources in priority order:
      //   1. getSessionKeyForSharing: our OWN outbound (or inbound copy of a prior
      //      outbound). Critical case the inbound-only lookup missed — the sender
      //      holds the key in `outbound`, never `inbound`, so requests for messages
      //      WE sent were answered "don't have session" and left pending forever.
      //   2. findInboundSessionBySessionId: an inbound session from another sender.
      // Both return the base key; ratchet derives every index, so first_known_index
      // of 0 lets the requester decrypt the whole session.
      const sharable = megolmService.getSessionKeyForSharing(request.room_id, request.session_id)
      const inbound = sharable
        ? null
        : megolmService.findInboundSessionBySessionId(request.room_id, request.session_id)
      const sessionKey = sharable?.sessionKey ?? inbound?.sessionKey

      if (!sessionKey) {
        debug.log(`ℹ️ Don't have session ${request.session_id.substring(0, 8)}...`)
        return
      }

      // AUTHORIZATION GATE - do NOT auto-fulfill just because we hold the key.
      //   1. The request must be signed by the requester's published signing
      //      key (proves the request truly came from the claimed requester,
      //      not a DB writer forging one for an attacker device).
      //   2. The requester must be a CURRENT member of the room
      //      (server-authoritative; removed members are rejected here even if
      //      they replay an old request).
      const authorized = await this.isKeyRequestAuthorized(request)
      if (!authorized) {
        debug.warn(
          `🚫 Refusing key request ${request.id.substring(0, 8)} from ${request.requester_user_id.substring(0, 8)} - failed authorization`,
        )
        return
      }

      debug.log(`✅ Found session and request authorized, fulfilling...`)

      const { data: requesterKey } = await supabase
        .from('user_key_pairs')
        .select('identity_public_key')
        .eq('user_id', request.requester_user_id)
        .eq('is_active', true)
        .maybeSingle()

      if (!requesterKey?.identity_public_key) {
        debug.log(`⚠️ Requester has no public key, cannot fulfill`)
        return
      }

      // Encrypt the session key for the requester
      const encryptedKey = await this.encryptSessionKeyForUser(
        sessionKey,
        requesterKey.identity_public_key
      )

      // Fulfill the request
      const { error } = await supabase
        .from('megolm_key_requests')
        .update({
          status: 'fulfilled',
          encrypted_key: encryptedKey,
          fulfilled_at: new Date().toISOString()
        })
        .eq('id', request.id)

      if (error) {
        debug.error('❌ Failed to fulfill request:', error)
        return
      }

      debug.log(`✅ Fulfilled key request ${request.id.substring(0, 8)}...`)

      // Durable repair of the offline path: the fulfillment above only helps
      // the requesting device right now. Also write a fresh
      // megolm_session_shares row sealed to the requester's CURRENT identity
      // key, so their other devices / future claims recover this session from
      // the DB without us being online again (fixes the "key reset -> stuck
      // on online-only key requests" state). Authorization already passed
      // above (signature + server-side room membership). Best-effort: the
      // realtime fulfillment succeeded regardless.
      // Dynamic import: MegolmMessageEncryptionService imports this service
      // statically, so the reverse edge must be lazy to avoid a cycle.
      try {
        const { megolmMessageEncryptionService } = await import('./MegolmMessageEncryptionService')
        await megolmMessageEncryptionService.repairSessionShareForUser(
          request.room_id,
          request.session_id,
          request.requester_user_id,
          sessionKey,
        )
      } catch (repairErr) {
        debug.warn('⚠️ Session-share repair after fulfillment failed (non-fatal):', repairErr)
      }
    } catch (error) {
      debug.error('❌ Error handling key request:', error)
    }
  }

  /**
   * Decide whether a key request may be fulfilled.
   *
   * Two independent checks, both required:
   *   1. Signature: the request carries a valid signature from the requester's
   *      published signing key over (room_id, session_id, requester_user_id).
   *      Unsigned requests are rejected (no honest current client sends them).
   *   2. Membership: the requester is a current member of the room, as judged
   *      by the server (is_room_member RPC). Membership is inherently
   *      server-authoritative in a Discord-style app; this is where a removed
   *      member - or someone who was never in the room - is denied old keys.
   */
  private async isKeyRequestAuthorized(request: KeyRequest): Promise<boolean> {
    // (1) Signature check.
    if (!request.request_signature) {
      debug.warn('🚫 Key request has no signature - rejecting')
      return false
    }
    try {
      const spki = await this.getRequesterSigningKey(request.requester_user_id)
      if (!spki) {
        debug.warn('🚫 Requester has no published signing key - cannot verify request')
        return false
      }
      const publicKey = await importPublicSigningKey(spki)
      const fields: KeyRequestFields = {
        room_id: request.room_id,
        session_id: request.session_id,
        requester_user_id: request.requester_user_id,
      }
      const sigValid = await verifyKeyRequestSignature(fields, request.request_signature, publicKey)
      if (!sigValid) {
        debug.warn('🚫 Key request signature invalid - rejecting')
        return false
      }
    } catch (err) {
      debug.warn('🚫 Key request signature verification threw - rejecting:', err)
      return false
    }

    // (2) Membership check (server-authoritative).
    try {
      const { data: isMember, error } = await supabase.rpc('is_room_member', {
        p_room_id: request.room_id,
        p_user_id: request.requester_user_id,
      })
      if (error) {
        debug.warn('🚫 is_room_member RPC failed - rejecting request:', error)
        return false
      }
      if (!isMember) {
        debug.warn('🚫 Requester is not a current member of the room - rejecting')
        return false
      }
    } catch (err) {
      debug.warn('🚫 Membership check threw - rejecting:', err)
      return false
    }

    return true
  }

  // Requester signing keys, TTL-cached: fulfilling a batch of key requests
  // from the same user verified each one with its own user_key_pairs query.
  // Negative results cached too (requester without a published key would
  // otherwise re-query per request).
  private requesterKeyCache = new Map<string, { spki: string | null; cachedAt: number }>()
  private requesterKeyFetches = new Map<string, Promise<string | null>>()
  private static readonly REQUESTER_KEY_TTL_MS = 5 * 60_000

  private async getRequesterSigningKey(requesterUserId: string): Promise<string | null> {
    const cached = this.requesterKeyCache.get(requesterUserId)
    if (cached && Date.now() - cached.cachedAt < MegolmKeyBackupService.REQUESTER_KEY_TTL_MS) {
      return cached.spki
    }
    const inFlight = this.requesterKeyFetches.get(requesterUserId)
    if (inFlight) return inFlight

    const fetchPromise = (async (): Promise<string | null> => {
      const { data, error } = await supabase
        .from('user_key_pairs')
        .select('identity_signing_public_key')
        .eq('user_id', requesterUserId)
        .eq('is_active', true)
        .maybeSingle()
      if (error) return null // transient: don't cache
      const spki = ((data as any)?.identity_signing_public_key as string | undefined) ?? null
      this.requesterKeyCache.set(requesterUserId, { spki, cachedAt: Date.now() })
      return spki
    })()

    this.requesterKeyFetches.set(requesterUserId, fetchPromise)
    try {
      return await fetchPromise
    } finally {
      this.requesterKeyFetches.delete(requesterUserId)
    }
  }

  /**
   * Best-effort short fingerprint of our own active signing public key, used to
   * annotate outgoing key requests. Returns undefined on any failure.
   */
  // Own signing fingerprint changes only on key rotation; cache it so every
  // key request creation doesn't re-query user_key_pairs (observed: dozens of
  // identical self-lookups during one DM load).
  private myFingerprintCache: { userId: string; value: string | undefined; cachedAt: number } | null = null
  private static readonly MY_FINGERPRINT_TTL_MS = 5 * 60_000

  private myFingerprintFetch: Promise<string | undefined> | null = null

  private async getMySigningFingerprint(): Promise<string | undefined> {
    if (!this.userId) return undefined
    const cached = this.myFingerprintCache
    if (
      cached &&
      cached.userId === this.userId &&
      Date.now() - cached.cachedAt < MegolmKeyBackupService.MY_FINGERPRINT_TTL_MS
    ) {
      return cached.value
    }
    // Dedup concurrent lookups (several key requests can be created in one
    // decrypt burst before the first fingerprint query resolves and caches).
    if (this.myFingerprintFetch) return this.myFingerprintFetch
    this.myFingerprintFetch = this._getMySigningFingerprint()
    try {
      return await this.myFingerprintFetch
    } finally {
      this.myFingerprintFetch = null
    }
  }

  private async _getMySigningFingerprint(): Promise<string | undefined> {
    if (!this.userId) return undefined
    try {
      const { data } = await supabase
        .from('user_key_pairs')
        .select('identity_signing_public_key')
        .eq('user_id', this.userId)
        .eq('is_active', true)
        .maybeSingle()
      const spki = (data as any)?.identity_signing_public_key as string | undefined
      let value: string | undefined
      if (spki) {
        const bytes = Uint8Array.from(atob(spki), c => c.charCodeAt(0))
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        value = Array.from(new Uint8Array(digest))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
          .slice(0, 16)
      }
      // Cache negatives too - a user with no signing key would otherwise
      // re-query on every request creation.
      this.myFingerprintCache = { userId: this.userId, value, cachedAt: Date.now() }
      return value
    } catch {
      return undefined
    }
  }

  /**
   * Handle a fulfilled key request (we requested a key and got it).
   *
   * Returns true only when the key was imported AND the row was flipped to
   * 'received' - the offline sweep uses this to quarantine rows that fail
   * permanently (e.g. sealed to a previous identity key) instead of retrying
   * them on every unlock forever.
   *
   * `prefetchedSenderKey` lets the batch sweep pass the fulfiller's public
   * key in (one query for all rows) instead of fetching per row.
   */
  private async handleFulfilledRequest(
    request: KeyRequest,
    prefetchedSenderKey?: string | null,
    // The offline sweep batches status updates itself (one PATCH per row was
    // 14s of serial requests for a large backlog) - it passes true to skip
    // the per-row flip below.
    deferStatusFlip = false,
  ): Promise<boolean> {
    debug.log(`📬 Key request fulfilled! Session ${request.session_id.substring(0, 8)}...`)

    if (!request.encrypted_key) {
      debug.log('⚠️ Fulfilled request has no encrypted key')
      return false
    }

    try {
      // Fulfiller's (sender's) public key for ECDH decryption
      let senderPublicKey = prefetchedSenderKey ?? null
      if (senderPublicKey === null && prefetchedSenderKey === undefined) {
        const { data: senderKey } = await supabase
          .from('user_key_pairs')
          .select('identity_public_key')
          .eq('user_id', request.sender_user_id)
          .eq('is_active', true)
          .maybeSingle()
        senderPublicKey = senderKey?.identity_public_key ?? null
      }

      if (!senderPublicKey) {
        debug.warn(`⚠️ No public key for sender ${request.sender_user_id.substring(0, 8)}, cannot decrypt`)
        return false
      }

      const sessionKey = await this.decryptSessionKeyFromSender(
        request.encrypted_key,
        senderPublicKey
      )

      await megolmService.importInboundSession(
        request.room_id,
        request.sender_user_id,
        request.session_id,
        sessionKey,
        0 // firstKnownIndex
      )

      debug.log(`✅ Imported session ${request.session_id.substring(0, 8)}... from fulfilled request`)

      this.pendingRequests.delete(request.session_id)

      // Mark the request consumed. The fulfilled key reaches us via an ephemeral
      // realtime broadcast; if we were offline when it fired we recover the row
      // via processMyFulfilledRequests() on the next unlock. Flipping it to
      // 'received' stops that catch-up from re-importing the same key forever.
      // Best-effort: a failed update only costs us a redundant future import.
      if (!deferStatusFlip && request.id && this.userId) {
        await supabase
          .from('megolm_key_requests')
          .update({ status: 'received' })
          .eq('id', request.id)
          .eq('requester_user_id', this.userId)
          .then(() => {}, () => {})
      }

      for (const callback of this.keyReceivedCallbacks) {
        try {
          callback(request.room_id, request.session_id)
        } catch (e) {
          debug.error('Error in key received callback:', e)
        }
      }

      this.triggerAutoBackup().catch(() => {})
      return true
    } catch (error) {
      debug.error('❌ Error importing fulfilled key:', error)
      // Re-arm the dedup so a follow-up decrypt attempt can issue a fresh
      // request instead of being stuck behind this failed import.
      this.pendingRequests.delete(request.session_id)
      return false
    }
  }

  // ECDH Key Exchange Helpers

  private async getMyPrivateKey(): Promise<CryptoKey> {
    if (!this.userId) throw new Error('Not initialized')
    const key = await identityKeyStore.load(this.userId)
    if (key) return key
    throw new Error('Identity private key not found - run encryption setup')
  }

  private async importPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
    const bytes = Uint8Array.from(atob(publicKeyBase64), c => c.charCodeAt(0))
    return crypto.subtle.importKey(
      'raw', bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []
    )
  }

  private async deriveSharedKey(
    privateKey: CryptoKey,
    publicKey: CryptoKey,
    usage: KeyUsage[]
  ): Promise<CryptoKey> {
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: publicKey }, privateKey, 256
    )
    const hkdfKey = await crypto.subtle.importKey(
      'raw', sharedBits, 'HKDF', false, ['deriveKey']
    )
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('harmony-megolm-session-exchange'),
        info: new TextEncoder().encode('session-key-encryption'),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      usage
    )
  }

  /**
   * Encrypt a session key for a specific user using ECDH key agreement.
   */
  private async encryptSessionKeyForUser(sessionKey: string, recipientPublicKey: string): Promise<string> {
    const myPrivateKey = await this.getMyPrivateKey()
    const recipientKey = await this.importPublicKey(recipientPublicKey)
    const aesKey = await this.deriveSharedKey(myPrivateKey, recipientKey, ['encrypt'])

    const encoder = new TextEncoder()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, aesKey, encoder.encode(sessionKey)
    )

    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)

    return 'v2:' + btoa(String.fromCharCode(...combined))
  }

  /**
   * Decrypt a session key using ECDH with the sender's public key.
   */
  private async decryptSessionKeyFromSender(
    encryptedKey: string,
    senderPublicKey: string
  ): Promise<string> {
    const payload = encryptedKey.startsWith('v2:')
      ? encryptedKey.slice(3)
      : encryptedKey

    const myPrivateKey = await this.getMyPrivateKey()
    const senderKey = await this.importPublicKey(senderPublicKey)
    const aesKey = await this.deriveSharedKey(myPrivateKey, senderKey, ['decrypt'])

    const combined = Uint8Array.from(atob(payload), c => c.charCodeAt(0))
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, aesKey, ciphertext
    )
    return new TextDecoder().decode(decrypted)
  }

  /**
   * Register a callback for when keys are received
   * Used by UI components to retry decryption
   */
  onKeyReceived(callback: KeyReceivedCallback): () => void {
    this.keyReceivedCallbacks.add(callback)
    return () => this.keyReceivedCallbacks.delete(callback)
  }

  /**
   * Clean up subscriptions
   */
  cleanup(): void {
    for (const unsub of this.broadcastUnsubs) unsub()
    this.broadcastUnsubs = []
    this.keyReceivedCallbacks.clear()
    this.pendingRequests.clear()
  }

  // BACKUP OPERATIONS

  /**
   * Create or update the encrypted backup on server
   */
  async createBackup(): Promise<void> {
    if (!this.userId) {
      throw new Error('Not initialized')
    }

    if (!recoveryKeyService.isLoaded()) {
      throw new Error('Recovery key not loaded - cannot create backup')
    }

    // Export all sessions from MegolmService
    const sessions = await megolmService.exportAllSessions()

    // MERGE with the existing server backup instead of blind overwrite.
    // A freshly wiped/new device holds few or no sessions; upserting its tiny
    // export used to DESTROY the only remaining copy of the user's history
    // keys the moment auto-backup fired. Union by (roomId, sessionId),
    // preferring the in-memory copy (fresher ratchet bookkeeping).
    try {
      const { data: existing } = await supabase
        .from('megolm_key_backups')
        .select('encrypted_data, session_count')
        .eq('user_id', this.userId)
        .maybeSingle()

      if (existing?.encrypted_data) {
        try {
          const priorJson = await recoveryKeyService.decryptFromBackup(existing.encrypted_data)
          const prior = JSON.parse(priorJson) as MegolmBackupData
          if (prior?.userId === this.userId && prior?.sessions) {
            const haveOutbound = new Set(sessions.outbound.map(s => `${s.roomId}:${s.sessionId}`))
            for (const s of prior.sessions.outbound || []) {
              if (!haveOutbound.has(`${s.roomId}:${s.sessionId}`)) sessions.outbound.push(s)
            }
            const haveInbound = new Set(sessions.inbound.map(s => `${s.roomId}:${s.sessionId}`))
            for (const s of prior.sessions.inbound || []) {
              if (!haveInbound.has(`${s.roomId}:${s.sessionId}`)) sessions.inbound.push(s)
            }
          }
        } catch {
          // The server backup can't be decrypted with the CURRENT recovery
          // key (older key generation). Refuse to replace a LARGER backup
          // with a smaller one - even undecryptable today, it may become
          // recoverable (user finds the old phrase). An intentional reset
          // clears it explicitly via deleteBackup().
          const localCount = sessions.outbound.length + sessions.inbound.length
          if ((existing.session_count ?? 0) > localCount) {
            debug.warn(
              `⚠️ Skipping backup write: server backup has ${existing.session_count} sessions ` +
              `(undecryptable with current key) vs ${localCount} local - overwriting would destroy history keys`,
            )
            return
          }
        }
      }
    } catch (mergeErr) {
      debug.warn('⚠️ Backup merge check failed, writing local sessions only:', mergeErr)
    }

    const backupData: MegolmBackupData = {
      version: 1,
      userId: this.userId,
      timestamp: Date.now(),
      sessions
    }

    // Encrypt with recovery key
    const backupJson = JSON.stringify(backupData)
    const encryptedBackup = await recoveryKeyService.encryptForBackup(backupJson)

    const hash = await this.calculateHash(backupJson)

    // Upsert to database
    const { error } = await supabase
      .from('megolm_key_backups')
      .upsert({
        user_id: this.userId,
        encrypted_data: encryptedBackup,
        version: 1,
        session_count: sessions.outbound.length + sessions.inbound.length,
        backup_hash: hash,
        last_updated: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      })

    if (error) {
      debug.error('❌ Failed to create backup:', error)
      throw new Error(`Failed to create backup: ${error.message}`)
    }

    debug.log(`✅ Backup created with ${sessions.outbound.length} outbound, ${sessions.inbound.length} inbound sessions`)
  }

  /**
   * Restore sessions from encrypted backup
   */
  async restoreFromBackup(): Promise<{
    outboundCount: number
    inboundCount: number
  }> {
    if (!this.userId) {
      throw new Error('Not initialized')
    }

    if (!recoveryKeyService.isLoaded()) {
      throw new Error('Recovery key not loaded - cannot restore backup')
    }

    // Fetch backup from database (use maybeSingle to avoid error on 0 rows)
    const { data: backup, error } = await supabase
      .from('megolm_key_backups')
      .select('encrypted_data, backup_hash, version')
      .eq('user_id', this.userId)
      .maybeSingle()

    if (error) {
      throw new Error(`Failed to fetch backup: ${error.message}`)
    }

    if (!backup) {
      debug.log('ℹ️ No backup found for user')
      return { outboundCount: 0, inboundCount: 0 }
    }

    // Decrypt with recovery key
    let backupJson: string
    try {
      backupJson = await recoveryKeyService.decryptFromBackup(backup.encrypted_data)
    } catch (error) {
      throw new Error('Failed to decrypt backup - invalid recovery key?')
    }

    const hash = await this.calculateHash(backupJson)
    if (hash !== backup.backup_hash) {
      debug.warn('⚠️ Backup hash mismatch - data may be corrupted')
      // Continue anyway - user might want partial recovery
    }

    const backupData: MegolmBackupData = JSON.parse(backupJson)

    if (backupData.version !== 1) {
      throw new Error(`Unsupported backup version: ${backupData.version}`)
    }

    if (backupData.userId !== this.userId) {
      throw new Error('Backup belongs to a different user')
    }

    await megolmService.importAllSessions(backupData.sessions)

    debug.log(`✅ Restored ${backupData.sessions.outbound.length} outbound, ${backupData.sessions.inbound.length} inbound sessions`)

    return {
      outboundCount: backupData.sessions.outbound.length,
      inboundCount: backupData.sessions.inbound.length
    }
  }

  /**
   * Check if a backup exists for the user
   */
  async hasBackup(): Promise<boolean> {
    if (!this.userId) return false

    const { data } = await supabase
      .from('megolm_key_backups')
      .select('id')
      .eq('user_id', this.userId)
      .maybeSingle()

    return !!data
  }

  /**
   * Get backup metadata (without decrypting)
   */
  async getBackupMetadata(): Promise<BackupMetadata | null> {
    if (!this.userId) return null

    const { data } = await supabase
      .from('megolm_key_backups')
      .select('id, user_id, version, session_count, last_updated, backup_hash')
      .eq('user_id', this.userId)
      .maybeSingle()

    if (!data) {
      return null
    }

    return data as BackupMetadata
  }

  /**
   * Delete the backup
   */
  async deleteBackup(): Promise<void> {
    if (!this.userId) return

    const { error } = await supabase
      .from('megolm_key_backups')
      .delete()
      .eq('user_id', this.userId)

    if (error) {
      debug.error('❌ Failed to delete backup:', error)
      throw new Error(`Failed to delete backup: ${error.message}`)
    }

    debug.log('✅ Backup deleted')
  }

  // AUTO-BACKUP

  /**
   * Enable/disable automatic backup after session changes
   */
  setAutoBackup(enabled: boolean): void {
    this.autoBackupEnabled = enabled
  }

  /**
   * Trigger backup if auto-backup is enabled.
   *
   * Debounced: callers fire this per new session (and a burst of new rooms /
   * rapid sends could otherwise re-upload the whole backup many times in a
   * row). We coalesce into a single trailing backup a few seconds after the
   * last trigger. The backup is a full snapshot, so the latest run captures
   * everything regardless of how many triggers were dropped.
   */
  async triggerAutoBackup(): Promise<void> {
    if (!this.autoBackupEnabled) return
    if (this.autoBackupTimer) return // a backup is already scheduled

    this.autoBackupTimer = setTimeout(() => {
      this.autoBackupTimer = null
      this.createBackup().catch(error => {
        debug.warn('⚠️ Auto-backup failed:', error)
        // Don't throw - auto-backup failure shouldn't block operations
      })
    }, this.AUTO_BACKUP_DEBOUNCE_MS)
  }

  // CROSS-DEVICE KEY SHARING (with Realtime)

  /**
   * Request a session key from the sender
   * The sender will receive this via realtime and auto-fulfill if they have the key
   * 
   * @param roomId - The room/channel/conversation ID
   * @param sessionId - The Megolm session ID needed
   * @param senderUserId - The user who sent the original message (and has the key)
   */
  async createKeyRequest(roomId: string, sessionId: string, senderUserId?: string): Promise<string> {
    if (!this.userId) {
      throw new Error('Not initialized')
    }

    // Dedup with expiry: a request that got no answer (sender offline, failed
    // fulfillment, failed import) must not block re-requests forever.
    const existing = this.pendingRequests.get(sessionId)
    if (existing) {
      if (Date.now() - existing.createdAt < this.KEY_REQUEST_RETRY_MS) {
        debug.log(`ℹ️ Already have pending request for session ${sessionId.substring(0, 8)}...`)
        return existing.requestId
      }
      this.pendingRequests.delete(sessionId)
    }

    const requestId = crypto.randomUUID()

    // Reserve the dedup slot SYNCHRONOUSLY. It used to be set only after the
    // insert, so parallel decrypt failures for the same session (one page can
    // hold many messages of one session) raced past the check above and each
    // inserted its own request row. Rolled back on insert failure below.
    this.pendingRequests.set(sessionId, { requestId, createdAt: Date.now() })

    // Sign the request so the fulfiller can verify it actually came from us
    // before wrapping the session key. Best-effort: if we have no signing key
    // yet, we still send an unsigned request (the fulfiller decides whether to
    // honor unsigned requests under its policy).
    let requestSignature: string | undefined
    let signingFingerprint: string | undefined
    try {
      const signingKey = await signingKeyStore.load(this.userId)
      if (signingKey) {
        const fields: KeyRequestFields = {
          room_id: roomId,
          session_id: sessionId,
          requester_user_id: this.userId,
        }
        requestSignature = await signKeyRequest(fields, signingKey)
        signingFingerprint = await this.getMySigningFingerprint()
      } else {
        debug.warn('⚠️ No signing key available to sign key request - sending unsigned')
      }
    } catch (err) {
      debug.warn('⚠️ Failed to sign key request (sending unsigned):', err)
    }

    const { error } = await supabase
      .from('megolm_key_requests')
      .insert({
        id: requestId,
        user_id: this.userId, // Legacy field for backwards compatibility
        requester_user_id: this.userId,
        sender_user_id: senderUserId || null, // Who we're requesting the key from
        room_id: roomId,
        session_id: sessionId,
        status: 'pending',
        request_signature: requestSignature || null,
        request_signing_fingerprint: signingFingerprint || null,
        created_at: new Date().toISOString()
      })

    if (error) {
      // Roll back the synchronous dedup reservation so a retry can re-issue.
      const reserved = this.pendingRequests.get(sessionId)
      if (reserved?.requestId === requestId) {
        this.pendingRequests.delete(sessionId)
      }
      throw new Error(`Failed to create key request: ${error.message}`)
    }

    debug.log(`📤 Created key request ${requestId.substring(0, 8)}... for session ${sessionId.substring(0, 8)}... from ${senderUserId?.substring(0, 8) || 'unknown'}`)
    return requestId
  }

  /**
   * Check for pending key requests we've made
   */
  async getMyPendingRequests(): Promise<KeyRequest[]> {
    if (!this.userId) return []

    const { data, error } = await supabase
      .from('megolm_key_requests')
      .select('*')
      .eq('requester_user_id', this.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) {
      debug.error('❌ Failed to fetch my pending requests:', error)
      return []
    }

    return (data || []) as KeyRequest[]
  }

  /**
   * Check for requests others have made to me
   */
  async getRequestsToMe(): Promise<KeyRequest[]> {
    if (!this.userId) return []

    const { data, error } = await supabase
      .from('megolm_key_requests')
      .select('*')
      .eq('sender_user_id', this.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) {
      debug.error('❌ Failed to fetch requests to me:', error)
      return []
    }

    return (data || []) as KeyRequest[]
  }

  /**
   * Process any pending requests to me (fulfill if we have the keys)
   * Called on initialization to catch up on requests made while offline
   */
  async processPendingRequestsToMe(): Promise<number> {
    const requests = await this.getRequestsToMe()
    let fulfilledCount = 0

    for (const request of requests) {
      try {
        await this.handleIncomingKeyRequest(request)
        fulfilledCount++
      } catch (error) {
        debug.warn(`⚠️ Failed to process request ${request.id}:`, error)
      }
    }

    if (fulfilledCount > 0) {
      debug.log(`✅ Processed ${fulfilledCount} pending key requests`)
    }

    return fulfilledCount
  }

  /**
   * Offline catch-up for the REQUESTER side: import keys for requests WE made
   * that were fulfilled while we were offline.
   *
   * Fulfillment is delivered via an ephemeral `encryption:key_fulfilled`
   * broadcast; if the requesting client was not connected when it fired the
   * payload is lost, leaving a `status='fulfilled'` row with a populated
   * `encrypted_key` that nobody ever consumes. This sweeps those rows on unlock
   * and imports them, then handleFulfilledRequest flips each to 'received' so
   * subsequent unlocks don't redo the work.
   */
  async processMyFulfilledRequests(): Promise<number> {
    if (!this.userId) return 0

    const { data, error } = await supabase
      .from('megolm_key_requests')
      .select('*')
      .eq('requester_user_id', this.userId)
      .eq('status', 'fulfilled')
      .not('encrypted_key', 'is', null)

    if (error || !data || data.length === 0) {
      return 0
    }

    // Batch-fetch every fulfiller's public key in ONE query. Previously each
    // row fetched it individually inside handleFulfilledRequest - with N
    // stale rows from the same fulfiller that was N identical user_key_pairs
    // queries per unlock (observed: 170).
    const senderIds = [...new Set(data.map(r => r.sender_user_id).filter(Boolean))]
    const senderKeyMap = new Map<string, string>()
    if (senderIds.length > 0) {
      const { data: keys, error: keysError } = await supabase
        .from('user_key_pairs')
        .select('user_id, identity_public_key')
        .in('user_id', senderIds)
        .eq('is_active', true)
      if (keysError) {
        debug.warn('⚠️ Batch fulfiller-key fetch failed, aborting sweep (will retry next unlock):', keysError)
        return 0
      }
      for (const k of keys || []) {
        if (k.identity_public_key) senderKeyMap.set(k.user_id, k.identity_public_key)
      }
    }

    const importedIds: string[] = []
    const failedIds: string[] = []
    for (const request of data) {
      const ok = await this.handleFulfilledRequest(
        request as unknown as KeyRequest,
        senderKeyMap.get(request.sender_user_id) ?? null,
        true, // defer status flips - batched below
      )
      if (ok) importedIds.push(request.id)
      else failedIds.push(request.id)
    }

    // Batch the status flips: ONE update per outcome instead of one PATCH per
    // row (a large backlog produced 60+ serial PATCHes on unlock).
    if (importedIds.length > 0) {
      await supabase
        .from('megolm_key_requests')
        .update({ status: 'received' })
        .in('id', importedIds)
        .eq('requester_user_id', this.userId)
        .then(() => {}, () => {})
    }

    // Quarantine failures: at this point we're unlocked with our identity key
    // available, so a failed import is deterministic (typically the key was
    // sealed to a PREVIOUS identity after a key reset) and would fail again
    // on every future unlock - these rows were being re-swept forever,
    // hammering the DB on each session start. Mark them expired; if the
    // session is ever needed again, the on-demand key-request flow issues a
    // fresh request (and the fulfillment-side share repair makes the new
    // seal durable).
    if (failedIds.length > 0) {
      await supabase
        .from('megolm_key_requests')
        .update({ status: 'expired' })
        .in('id', failedIds)
        .eq('requester_user_id', this.userId)
        .then(() => {}, () => {})
      debug.warn(`🗑️ Quarantined ${failedIds.length} undecryptable fulfilled key requests (marked expired)`)
    }

    if (importedIds.length > 0) {
      debug.log(`📥 Imported ${importedIds.length} fulfilled key requests (offline catch-up)`)
    }

    return importedIds.length
  }

  /**
   * Cancel a pending key request
   */
  async cancelKeyRequest(requestId: string): Promise<void> {
    const { error } = await supabase
      .from('megolm_key_requests')
      .update({ status: 'cancelled' })
      .eq('id', requestId)
      .eq('requester_user_id', this.userId)

    if (error) {
      debug.error('❌ Failed to cancel request:', error)
    }

    for (const [sessionId, entry] of this.pendingRequests) {
      if (entry.requestId === requestId) {
        this.pendingRequests.delete(sessionId)
        break
      }
    }
  }

  /**
   * Check if a key request has been fulfilled
   */
  async checkKeyRequestStatus(requestId: string): Promise<{
    status: 'pending' | 'fulfilled' | 'expired' | 'cancelled'
    encryptedKey?: string
  }> {
    const { data, error } = await supabase
      .from('megolm_key_requests')
      .select('status, encrypted_key')
      .eq('id', requestId)
      .maybeSingle()

    if (error || !data) {
      return { status: 'expired' }
    }

    return {
      status: data.status as 'pending' | 'fulfilled' | 'expired' | 'cancelled',
      encryptedKey: data.encrypted_key
    }
  }

  /**
   * @deprecated Use getMyPendingRequests instead
   */
  async getPendingKeyRequests(): Promise<{
    id: string
    room_id: string
    session_id: string
    created_at: string
  }[]> {
    const requests = await this.getMyPendingRequests()
    return requests.map(r => ({
      id: r.id,
      room_id: r.room_id,
      session_id: r.session_id,
      created_at: r.created_at
    }))
  }

  /**
   * @deprecated Use handleIncomingKeyRequest (auto-called via realtime)
   */
  async fulfillKeyRequest(
    requestId: string,
    sessionKey: string,
    encryptedForRecipient: string
  ): Promise<void> {
    const { error } = await supabase
      .from('megolm_key_requests')
      .update({
        status: 'fulfilled',
        encrypted_key: encryptedForRecipient,
        fulfilled_at: new Date().toISOString()
      })
      .eq('id', requestId)

    if (error) {
      throw new Error(`Failed to fulfill key request: ${error.message}`)
    }

    debug.log(`✅ Fulfilled key request ${requestId}`)
  }

  // UTILITY METHODS

  /**
   * Calculate SHA-256 hash of data
   */
  private async calculateHash(data: string): Promise<string> {
    const encoder = new TextEncoder()
    const dataBytes = encoder.encode(data)
    const hash = await crypto.subtle.digest('SHA-256', dataBytes)
    const hashArray = Array.from(new Uint8Array(hash))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Export backup data for local file storage
   */
  async exportToFile(): Promise<string> {
    if (!this.userId || !recoveryKeyService.isLoaded()) {
      throw new Error('Not initialized or recovery key not loaded')
    }

    const sessions = await megolmService.exportAllSessions()

    const exportData = {
      type: 'harmony-megolm-backup',
      version: 1,
      userId: this.userId,
      timestamp: Date.now(),
      sessions
    }

    // Encrypt with recovery key
    const json = JSON.stringify(exportData)
    return await recoveryKeyService.encryptForBackup(json)
  }

  /**
   * Import backup from local file
   */
  async importFromFile(encryptedData: string): Promise<{
    outboundCount: number
    inboundCount: number
  }> {
    if (!recoveryKeyService.isLoaded()) {
      throw new Error('Recovery key not loaded')
    }

    // Decrypt
    const json = await recoveryKeyService.decryptFromBackup(encryptedData)
    const importData = JSON.parse(json)

    if (importData.type !== 'harmony-megolm-backup') {
      throw new Error('Invalid backup file format')
    }

    if (importData.version !== 1) {
      throw new Error(`Unsupported backup version: ${importData.version}`)
    }

    await megolmService.importAllSessions(importData.sessions)

    return {
      outboundCount: importData.sessions.outbound.length,
      inboundCount: importData.sessions.inbound.length
    }
  }
}

// Export singleton
export const megolmKeyBackupService = MegolmKeyBackupService.getInstance()

