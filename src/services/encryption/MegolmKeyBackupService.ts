/**
 * Server-side encrypted backup of Megolm session keys, plus realtime key
 * request/fulfillment for cross-device key sharing.
 *
 * Backup: session keys are encrypted with the user's recovery key before
 * upload, so the server holds only opaque blobs. One row per user in
 * `megolm_key_backups`, rewritten as sessions are created. Restore on a new
 * device requires the recovery phrase.
 *
 * Key requests: a client that cannot decrypt a message inserts a request row;
 * the sender receives it over realtime, fulfills it if it holds the session
 * key, and the requester imports the fulfilled key from a realtime event.
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

export type KeyReceivedCallback = (roomId: string, sessionId: string) => void

export interface MegolmBackupData {
  version: number
  userId: string
  timestamp: number
  sessions: {
    outbound: MegolmOutboundSession[]
    inbound: MegolmInboundSession[]
  }
}

export interface BackupMetadata {
  id: string
  user_id: string
  version: number
  session_count: number
  last_updated: string
  backup_hash: string
}

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
    
    debug.log('MegolmKeyBackupService initialized with realtime key request support')
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

    debug.log('Encryption key request handlers registered via user:{id} broadcast')
  }

  /** Auto-fulfills an incoming key request when the session key is held locally. */
  private async handleIncomingKeyRequest(request: KeyRequest): Promise<void> {
    debug.log(`Received key request from ${request.requester_user_id.substring(0, 8)}... for session ${request.session_id.substring(0, 8)}...`)

    if (!megolmService.isInitialized()) {
      debug.log('Megolm not initialized, cannot fulfill request')
      return
    }

    try {
      // Session key sources, in priority order:
      //   1. getSessionKeyForSharing: the local outbound session for this room,
      //      or a local inbound copy of a prior outbound. The original sender
      //      holds the key in `outbound`, never `inbound`, so an inbound-only
      //      lookup cannot answer a request for a locally sent message.
      //   2. findInboundSessionBySessionId: any inbound session held from
      //      another sender (group-room key relay).
      // Both return the base session key; the ratchet derives every index, so
      // first_known_index 0 decrypts the whole session.
      const sharable = megolmService.getSessionKeyForSharing(request.room_id, request.session_id)
      const inbound = sharable
        ? null
        : megolmService.findInboundSessionBySessionId(request.room_id, request.session_id)
      const sessionKey = sharable?.sessionKey ?? inbound?.sessionKey

      if (!sessionKey) {
        debug.log(`ℹDon't have session ${request.session_id.substring(0, 8)}...`)
        return
      }

      // Authorization gate. Holding the key is not sufficient:
      //   1. The request must be signed by the requester's published signing
      //      key, proving it came from the claimed requester and not a DB
      //      writer forging one for an attacker device.
      //   2. The requester must be a current member of the room
      //      (server-authoritative); removed members replaying an old request
      //      are rejected here.
      const authorized = await this.isKeyRequestAuthorized(request)
      if (!authorized) {
        debug.warn(
          `🚫 Refusing key request ${request.id.substring(0, 8)} from ${request.requester_user_id.substring(0, 8)} - failed authorization`,
        )
        return
      }

      debug.log(`Found session and request authorized, fulfilling...`)

      const { data: requesterKey } = await supabase
        .from('user_key_pairs')
        .select('identity_public_key')
        .eq('user_id', request.requester_user_id)
        .eq('is_active', true)
        .maybeSingle()

      if (!requesterKey?.identity_public_key) {
        debug.log(`Requester has no public key, cannot fulfill`)
        return
      }

      const encryptedKey = await this.encryptSessionKeyForUser(
        sessionKey,
        requesterKey.identity_public_key
      )

      const { error } = await supabase
        .from('megolm_key_requests')
        .update({
          status: 'fulfilled',
          encrypted_key: encryptedKey,
          fulfilled_at: new Date().toISOString()
        })
        .eq('id', request.id)

      if (error) {
        debug.error('Failed to fulfill request:', error)
        return
      }

      debug.log(`Fulfilled key request ${request.id.substring(0, 8)}...`)

      // Durable repair of the offline path. The fulfillment above reaches only
      // the requesting device. Writing a fresh megolm_session_shares row sealed
      // to the requester's current identity key lets their other devices and
      // future claims recover this session from the DB with no sender online.
      // Authorization (signature + server-side room membership) passed above.
      // Best-effort: the realtime fulfillment stands regardless.
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
        debug.warn('Session-share repair after fulfillment failed (non-fatal):', repairErr)
      }
    } catch (error) {
      debug.error('Error handling key request:', error)
    }
  }

  /**
   * Decide whether a key request may be fulfilled.
   *
   * Two independent checks, both required:
   *   1. Signature: the request carries a valid signature from the requester's
   *      published signing key over (room_id, session_id, requester_user_id).
   *      Unsigned requests are rejected (no honest current client sends them).
   *   2. Membership: the requester is a current member of the room per the
   *      server (is_room_member RPC). Membership is server-authoritative; this
   *      is where a removed member, or one who was never in the room, is denied
   *      old keys.
   */
  private async isKeyRequestAuthorized(request: KeyRequest): Promise<boolean> {
    // (1) Signature check.
    if (!request.request_signature) {
      debug.warn('Key request has no signature - rejecting')
      return false
    }
    try {
      const spki = await this.getRequesterSigningKey(request.requester_user_id)
      if (!spki) {
        debug.warn('Requester has no published signing key - cannot verify request')
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
        debug.warn('Key request signature invalid - rejecting')
        return false
      }
    } catch (err) {
      debug.warn('Key request signature verification threw - rejecting:', err)
      return false
    }

    // (2) Membership check (server-authoritative).
    try {
      const { data: isMember, error } = await supabase.rpc('is_room_member', {
        p_room_id: request.room_id,
        p_user_id: request.requester_user_id,
      })
      if (error) {
        debug.warn('is_room_member RPC failed - rejecting request:', error)
        return false
      }
      if (!isMember) {
        debug.warn('Requester is not a current member of the room - rejecting')
        return false
      }
    } catch (err) {
      debug.warn('Membership check threw - rejecting:', err)
      return false
    }

    return true
  }

  // Requester signing keys, TTL-cached. Without it a batch of key requests from
  // one user costs a user_key_pairs query per request. Negative results are
  // cached too, for requesters with no published key.
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
   * Short fingerprint of the local active signing public key, used to annotate
   * outgoing key requests. Returns undefined on any failure.
   */
  // The fingerprint changes only on key rotation. Uncached, key request
  // creation re-queries user_key_pairs each time - dozens of identical
  // self-lookups during one DM load.
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
    // Dedup concurrent lookups: one decrypt burst can create several key
    // requests before the first fingerprint query resolves and caches.
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
      // Negatives are cached; a user with no signing key would otherwise
      // re-query on every request creation.
      this.myFingerprintCache = { userId: this.userId, value, cachedAt: Date.now() }
      return value
    } catch {
      return undefined
    }
  }

  /**
   * Import a key for a locally issued request that was fulfilled.
   *
   * Returns true only when the key was imported and the row flipped to
   * 'received'. The offline sweep uses this to quarantine rows that fail
   * permanently (sealed to a previous identity key) rather than retry them on
   * every unlock.
   *
   * `prefetchedSenderKey` lets the batch sweep pass the fulfiller's public key
   * in - one query for all rows instead of one per row.
   */
  private async handleFulfilledRequest(
    request: KeyRequest,
    prefetchedSenderKey?: string | null,
    // The offline sweep batches status updates itself and passes true to skip
    // the per-row flip below; one PATCH per row costs ~14s of serial requests
    // on a large backlog.
    deferStatusFlip = false,
  ): Promise<boolean> {
    debug.log(`Key request fulfilled! Session ${request.session_id.substring(0, 8)}...`)

    if (!request.encrypted_key) {
      debug.log('Fulfilled request has no encrypted key')
      return false
    }

    try {
      // Fulfiller's public key, for ECDH decryption.
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
        debug.warn(`No public key for sender ${request.sender_user_id.substring(0, 8)}, cannot decrypt`)
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

      debug.log(`Imported session ${request.session_id.substring(0, 8)}... from fulfilled request`)

      this.pendingRequests.delete(request.session_id)

      // Mark the request consumed. The fulfilled key arrives on an ephemeral
      // realtime broadcast; a client offline when it fires recovers the row via
      // processMyFulfilledRequests() on the next unlock. The flip to 'received'
      // stops that catch-up from re-importing the same key. Best-effort: a
      // failed update costs one redundant future import.
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
      debug.error('Error importing fulfilled key:', error)
      // Re-arm the dedup so a follow-up decrypt attempt issues a fresh request
      // instead of blocking behind this failed import.
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
   * ECDH-wrap a session key for one recipient. Output is
   * `v2:` + base64(12-byte IV || AES-GCM ciphertext).
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
   * Inverse of encryptSessionKeyForUser. The `v2:` prefix is optional; payloads
   * without it are treated as bare base64.
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

  /** Callbacks fire on key import; UI components use them to retry decryption. */
  onKeyReceived(callback: KeyReceivedCallback): () => void {
    this.keyReceivedCallbacks.add(callback)
    return () => this.keyReceivedCallbacks.delete(callback)
  }

  cleanup(): void {
    for (const unsub of this.broadcastUnsubs) unsub()
    this.broadcastUnsubs = []
    this.keyReceivedCallbacks.clear()
    this.pendingRequests.clear()
  }

  // BACKUP OPERATIONS

  /** Upserts the encrypted backup row for the current user. */
  async createBackup(): Promise<void> {
    if (!this.userId) {
      throw new Error('Not initialized')
    }

    if (!recoveryKeyService.isLoaded()) {
      throw new Error('Recovery key not loaded - cannot create backup')
    }

    const sessions = await megolmService.exportAllSessions()

    // Merge with the existing server backup rather than overwrite. A freshly
    // wiped or new device holds few sessions; upserting its export would
    // destroy the only remaining copy of the user's history keys on the first
    // auto-backup. Union by (roomId, sessionId), preferring the in-memory copy
    // for its fresher ratchet bookkeeping.
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
          // The server backup does not decrypt under the current recovery key
          // (older key generation). A larger backup is never replaced by a
          // smaller one: undecryptable today does not mean unrecoverable, and
          // an intentional reset clears it explicitly via deleteBackup().
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
      debug.warn('Backup merge check failed, writing local sessions only:', mergeErr)
    }

    const backupData: MegolmBackupData = {
      version: 1,
      userId: this.userId,
      timestamp: Date.now(),
      sessions
    }

    const backupJson = JSON.stringify(backupData)
    const encryptedBackup = await recoveryKeyService.encryptForBackup(backupJson)

    const hash = await this.calculateHash(backupJson)

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
      debug.error('Failed to create backup:', error)
      throw new Error(`Failed to create backup: ${error.message}`)
    }

    debug.log(`Backup created with ${sessions.outbound.length} outbound, ${sessions.inbound.length} inbound sessions`)
  }

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

    // maybeSingle: 0 rows is not an error here.
    const { data: backup, error } = await supabase
      .from('megolm_key_backups')
      .select('encrypted_data, backup_hash, version')
      .eq('user_id', this.userId)
      .maybeSingle()

    if (error) {
      throw new Error(`Failed to fetch backup: ${error.message}`)
    }

    if (!backup) {
      debug.log('ℹNo backup found for user')
      return { outboundCount: 0, inboundCount: 0 }
    }

    let backupJson: string
    try {
      backupJson = await recoveryKeyService.decryptFromBackup(backup.encrypted_data)
    } catch (error) {
      throw new Error('Failed to decrypt backup - invalid recovery key?')
    }

    const hash = await this.calculateHash(backupJson)
    if (hash !== backup.backup_hash) {
      debug.warn('Backup hash mismatch - data may be corrupted')
      // Restore proceeds; partial recovery beats none.
    }

    const backupData: MegolmBackupData = JSON.parse(backupJson)

    if (backupData.version !== 1) {
      throw new Error(`Unsupported backup version: ${backupData.version}`)
    }

    if (backupData.userId !== this.userId) {
      throw new Error('Backup belongs to a different user')
    }

    await megolmService.importAllSessions(backupData.sessions)

    debug.log(`Restored ${backupData.sessions.outbound.length} outbound, ${backupData.sessions.inbound.length} inbound sessions`)

    return {
      outboundCount: backupData.sessions.outbound.length,
      inboundCount: backupData.sessions.inbound.length
    }
  }

  async hasBackup(): Promise<boolean> {
    if (!this.userId) return false

    const { data } = await supabase
      .from('megolm_key_backups')
      .select('id')
      .eq('user_id', this.userId)
      .maybeSingle()

    return !!data
  }

  /** Metadata only; the encrypted blob is not fetched or decrypted. */
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

  async deleteBackup(): Promise<void> {
    if (!this.userId) return

    const { error } = await supabase
      .from('megolm_key_backups')
      .delete()
      .eq('user_id', this.userId)

    if (error) {
      debug.error('Failed to delete backup:', error)
      throw new Error(`Failed to delete backup: ${error.message}`)
    }

    debug.log('Backup deleted')
  }

  // AUTO-BACKUP

  setAutoBackup(enabled: boolean): void {
    this.autoBackupEnabled = enabled
  }

  /**
   * Trigger a backup when auto-backup is enabled.
   *
   * Debounced: callers fire this per new session, so a burst of new rooms or
   * rapid sends would re-upload the whole backup repeatedly. Triggers coalesce
   * into one trailing backup AUTO_BACKUP_DEBOUNCE_MS after the last. The backup
   * is a full snapshot, so dropped triggers lose nothing.
   */
  async triggerAutoBackup(): Promise<void> {
    if (!this.autoBackupEnabled) return
    if (this.autoBackupTimer) return // a backup is already scheduled

    this.autoBackupTimer = setTimeout(() => {
      this.autoBackupTimer = null
      this.createBackup().catch(error => {
        debug.warn('Auto-backup failed:', error)
        // Never throws: auto-backup failure must not block operations.
      })
    }, this.AUTO_BACKUP_DEBOUNCE_MS)
  }

  // CROSS-DEVICE KEY SHARING (with Realtime)

  /**
   * Request a session key from the sender. The sender receives the row over
   * realtime and auto-fulfills if it holds the key.
   *
   * @param roomId room / channel / conversation id
   * @param sessionId Megolm session id needed
   * @param senderUserId user who sent the original message and holds the key
   */
  async createKeyRequest(roomId: string, sessionId: string, senderUserId?: string): Promise<string> {
    if (!this.userId) {
      throw new Error('Not initialized')
    }

    // Dedup with expiry: an unanswered request (sender offline, failed
    // fulfillment, failed import) must not block re-requests forever.
    const existing = this.pendingRequests.get(sessionId)
    if (existing) {
      if (Date.now() - existing.createdAt < this.KEY_REQUEST_RETRY_MS) {
        debug.log(`ℹAlready have pending request for session ${sessionId.substring(0, 8)}...`)
        return existing.requestId
      }
      this.pendingRequests.delete(sessionId)
    }

    const requestId = crypto.randomUUID()

    // Reserve the dedup slot synchronously, before the insert. Parallel decrypt
    // failures for the same session - one page holds many messages of one
    // session - otherwise race past the check above and each insert a request
    // row. Rolled back on insert failure below.
    this.pendingRequests.set(sessionId, { requestId, createdAt: Date.now() })

    // Sign the request so the fulfiller can verify its origin before wrapping
    // the session key. Best-effort: with no signing key the request goes out
    // unsigned, and the fulfiller's policy decides whether to honor it.
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
        debug.warn('No signing key available to sign key request - sending unsigned')
      }
    } catch (err) {
      debug.warn('Failed to sign key request (sending unsigned):', err)
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

    debug.log(`Created key request ${requestId.substring(0, 8)}... for session ${sessionId.substring(0, 8)}... from ${senderUserId?.substring(0, 8) || 'unknown'}`)
    return requestId
  }

  /** Pending key requests issued by this user. */
  async getMyPendingRequests(): Promise<KeyRequest[]> {
    if (!this.userId) return []

    const { data, error } = await supabase
      .from('megolm_key_requests')
      .select('*')
      .eq('requester_user_id', this.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) {
      debug.error('Failed to fetch my pending requests:', error)
      return []
    }

    return (data || []) as KeyRequest[]
  }

  /** Pending key requests addressed to this user as sender. */
  async getRequestsToMe(): Promise<KeyRequest[]> {
    if (!this.userId) return []

    const { data, error } = await supabase
      .from('megolm_key_requests')
      .select('*')
      .eq('sender_user_id', this.userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) {
      debug.error('Failed to fetch requests to me:', error)
      return []
    }

    return (data || []) as KeyRequest[]
  }

  /**
   * Fulfill pending requests addressed to this user where the key is held.
   * Called on initialization to catch up on requests raised while offline.
   */
  async processPendingRequestsToMe(): Promise<number> {
    const requests = await this.getRequestsToMe()
    let fulfilledCount = 0

    for (const request of requests) {
      try {
        await this.handleIncomingKeyRequest(request)
        fulfilledCount++
      } catch (error) {
        debug.warn(`Failed to process request ${request.id}:`, error)
      }
    }

    if (fulfilledCount > 0) {
      debug.log(`Processed ${fulfilledCount} pending key requests`)
    }

    return fulfilledCount
  }

  /**
   * Requester-side offline catch-up: import keys for locally issued requests
   * fulfilled while this client was disconnected.
   *
   * Fulfillment is delivered on an ephemeral `encryption:key_fulfilled`
   * broadcast. A requester not connected when it fires loses the payload,
   * leaving a `status='fulfilled'` row with a populated `encrypted_key` that
   * nothing consumes. This sweeps and imports those rows on unlock;
   * handleFulfilledRequest then flips each to 'received' so later unlocks skip
   * them.
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

    // Batch-fetch every fulfiller's public key in one query. Per-row fetching
    // inside handleFulfilledRequest costs one identical user_key_pairs query
    // per stale row from the same fulfiller - 170 observed on one unlock.
    const senderIds = [...new Set(data.map(r => r.sender_user_id).filter(Boolean))]
    const senderKeyMap = new Map<string, string>()
    if (senderIds.length > 0) {
      const { data: keys, error: keysError } = await supabase
        .from('user_key_pairs')
        .select('user_id, identity_public_key')
        .in('user_id', senderIds)
        .eq('is_active', true)
      if (keysError) {
        debug.warn('Batch fulfiller-key fetch failed, aborting sweep (will retry next unlock):', keysError)
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

    // One update per outcome instead of one PATCH per row; a large backlog
    // produced 60+ serial PATCHes on unlock.
    if (importedIds.length > 0) {
      await supabase
        .from('megolm_key_requests')
        .update({ status: 'received' })
        .in('id', importedIds)
        .eq('requester_user_id', this.userId)
        .then(() => {}, () => {})
    }

    // Quarantine failures. The identity key is available here, so a failed
    // import is deterministic - typically the key was sealed to a previous
    // identity before a key reset - and would fail on every future unlock,
    // re-sweeping the same rows at each session start. Marking them expired
    // ends that; if the session is needed again the on-demand key-request flow
    // issues a fresh request, and the fulfillment-side share repair makes the
    // new seal durable.
    if (failedIds.length > 0) {
      await supabase
        .from('megolm_key_requests')
        .update({ status: 'expired' })
        .in('id', failedIds)
        .eq('requester_user_id', this.userId)
        .then(() => {}, () => {})
      debug.warn(`Quarantined ${failedIds.length} undecryptable fulfilled key requests (marked expired)`)
    }

    if (importedIds.length > 0) {
      debug.log(`Imported ${importedIds.length} fulfilled key requests (offline catch-up)`)
    }

    return importedIds.length
  }

  async cancelKeyRequest(requestId: string): Promise<void> {
    const { error } = await supabase
      .from('megolm_key_requests')
      .update({ status: 'cancelled' })
      .eq('id', requestId)
      .eq('requester_user_id', this.userId)

    if (error) {
      debug.error('Failed to cancel request:', error)
    }

    for (const [sessionId, entry] of this.pendingRequests) {
      if (entry.requestId === requestId) {
        this.pendingRequests.delete(sessionId)
        break
      }
    }
  }

  /** Missing or unreadable rows report as 'expired'. */
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

    debug.log(`Fulfilled key request ${requestId}`)
  }

  // UTILITY METHODS

  /** SHA-256 of the UTF-8 bytes, lowercase hex. */
  private async calculateHash(data: string): Promise<string> {
    const encoder = new TextEncoder()
    const dataBytes = encoder.encode(data)
    const hash = await crypto.subtle.digest('SHA-256', dataBytes)
    const hashArray = Array.from(new Uint8Array(hash))
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  }

  /** Recovery-key-encrypted blob tagged `harmony-megolm-backup`, version 1. */
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

    const json = JSON.stringify(exportData)
    return await recoveryKeyService.encryptForBackup(json)
  }

  async importFromFile(encryptedData: string): Promise<{
    outboundCount: number
    inboundCount: number
  }> {
    if (!recoveryKeyService.isLoaded()) {
      throw new Error('Recovery key not loaded')
    }

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

export const megolmKeyBackupService = MegolmKeyBackupService.getInstance()

