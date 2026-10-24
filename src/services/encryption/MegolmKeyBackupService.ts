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
 * the sender, and members holding the session when the requester accepts
 * relayed keys, receive it over realtime or on their next unlock and answer
 * with the session key wrapped to the requester. The requester imports the
 * sender's key at once and a relayed key once it decrypts a ciphertext of the
 * session.
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
  sender_user_id: string | null
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
  // Any member of the room holding the session may answer, not only the sender.
  accepts_relay?: boolean
  // Wrapper of encrypted_key; absent or null means sender_user_id.
  fulfilled_by_user_id?: string | null
  // The message the requester could not read; its index is read from the
  // message row by the server.
  message_id?: string | null
  message_index?: number | null
  // What may be (pending) or was (fulfilled) handed over: the session key, or
  // the key of message_id alone. Absent from servers before 20261028200001.
  key_scope?: KeyScope | null
}

export type KeyScope = 'session' | 'message'

/**
 * A key received for a request, held until a ciphertext verifies it: a session
 * key from a member other than its sender, or the key of one message.
 */
export interface RelayedKey {
  requestId: string
  roomId: string
  senderUserId: string
  sessionId: string
  // The session key, or the key of messageId alone.
  sessionKey: string
  scope: KeyScope
  messageId: string | null
}

/** Context of the message whose decryption raised a key request. */
export interface KeyRequestMessage {
  id?: string
  pinned?: boolean
}

type FulfilledOutcome = 'imported' | 'relayed' | 'failed'

// PostgREST: function absent from the schema cache (server before the migration).
const MISSING_FUNCTION = 'PGRST202'
// PostgREST: column absent from the schema cache.
const MISSING_COLUMN = 'PGRST204'

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

  // sessionId, or sessionId#messageId for a pinned message → { requestId,
  // createdAt }. Entries expire (KEY_REQUEST_RETRY_MS)
  // so an unanswered/failed request can be re-issued without a full reload.
  private pendingRequests: Map<string, { requestId: string; createdAt: number }> = new Map()
  private readonly KEY_REQUEST_RETRY_MS = 2 * 60_000
  // Relayed keys refused per session: how many, and when the last one was.
  private refusals: Map<string, { count: number; at: number }> = new Map()

  // `${roomId}:${senderUserId}:${sessionId}` → relayed keys awaiting a ciphertext.
  private relayedKeys = new Map<string, RelayedKey[]>()

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

  /**
   * Answers a key request when this device holds the key the server allows
   * for it. Returns whether this answer fulfilled it.
   */
  private async handleIncomingKeyRequest(request: KeyRequest): Promise<boolean> {
    debug.log(`Received key request from ${request.requester_user_id.substring(0, 8)}... for session ${request.session_id.substring(0, 8)}...`)

    if (!megolmService.isInitialized() || !this.userId) {
      debug.log('Megolm not initialized, cannot fulfill request')
      return false
    }

    try {
      const answer = await this.keyToAnswer(request)
      if (!answer) {
        debug.log(`ℹNo key to hand over for session ${request.session_id.substring(0, 8)}...`)
        return false
      }

      // Holding the key is not sufficient. The request must be signed by the
      // requester's published signing key, proving it came from the claimed
      // requester and not a DB writer forging one for an attacker device.
      // Room membership and history visibility are server-authoritative:
      // fulfill_megolm_key_request refuses a removed member's old request and
      // a key the room's history setting withholds.
      if (!(await this.isRequestSignatureValid(request))) {
        debug.warn(
          `🚫 Refusing key request ${request.id.substring(0, 8)} from ${request.requester_user_id.substring(0, 8)} - failed authorization`,
        )
        return false
      }

      const { data: requesterKey } = await supabase
        .from('user_key_pairs')
        .select('identity_public_key')
        .eq('user_id', request.requester_user_id)
        .eq('is_active', true)
        .maybeSingle()

      if (!requesterKey?.identity_public_key) {
        debug.log(`Requester has no public key, cannot fulfill`)
        return false
      }

      const encryptedKey = await this.encryptSessionKeyForUser(
        answer.key,
        requesterKey.identity_public_key
      )

      if (!(await this.fulfillRequest(request, encryptedKey, answer.scope))) return false

      debug.log(`Fulfilled key request ${request.id.substring(0, 8)}... (${answer.scope})`)

      // A share row carries a session key and names its wrapper as sender; the
      // recipient files the session under that id. Only the session's sender
      // writes one, and only for a session key.
      if (answer.scope !== 'session' || request.sender_user_id !== this.userId
        || request.requester_user_id === this.userId) return true

      // Durable repair of the offline path. The fulfillment above reaches only
      // the requesting device. Writing a fresh megolm_session_shares row sealed
      // to the requester's current identity key lets their other devices and
      // future claims recover this session from the DB with no sender online.
      // Best-effort: the fulfillment stands regardless.
      // Dynamic import: MegolmMessageEncryptionService imports this service
      // statically, so the reverse edge must be lazy to avoid a cycle.
      try {
        const { megolmMessageEncryptionService } = await import('./MegolmMessageEncryptionService')
        await megolmMessageEncryptionService.repairSessionShareForUser(
          request.room_id,
          request.session_id,
          request.requester_user_id,
          answer.key,
        )
      } catch (repairErr) {
        debug.warn('Session-share repair after fulfillment failed (non-fatal):', repairErr)
      }
      return true
    } catch (error) {
      debug.error('Error handling key request:', error)
      return false
    }
  }

  /** Requests from servers before 20261028200001 carry no key_scope. */
  private isLegacyRequest(request: KeyRequest): boolean {
    return !('key_scope' in request)
  }

  /**
   * The session key this device holds for a request: its own session when
   * addressed as the sender; otherwise, when the requester accepts relayed
   * keys, an inbound copy filed under the request's sender. Both are the base
   * session key; the ratchet derives every index.
   */
  private heldSessionKey(request: KeyRequest): string | null {
    if (request.sender_user_id === this.userId) {
      return megolmService.getSessionKeyForSharing(request.room_id, request.session_id)?.sessionKey || null
    }
    if (!request.accepts_relay || !request.sender_user_id || this.isLegacyRequest(request)) return null
    return megolmService.getInboundSession(request.room_id, request.sender_user_id, request.session_id)?.sessionKey || null
  }

  /** Whether this device could answer, before any network check. */
  private holdsKeyFor(request: KeyRequest): boolean {
    if (this.isLegacyRequest(request)) return this.heldSessionKey(request) !== null
    if (request.key_scope === 'session') return this.heldSessionKey(request) !== null
    if (request.key_scope !== 'message' || request.message_index == null || !request.sender_user_id) return false
    return this.heldSessionKey(request) !== null
      || !!megolmService.getMessageKey(request.room_id, request.sender_user_id, request.session_id, request.message_index)
  }

  /**
   * What this device hands over, within the scope the server allows
   * (request.key_scope; on servers before 20261028200001 the sender alone
   * answers, with the session key):
   *   session  the held session key.
   *   message  the key of request.message_id alone, derived from the held
   *            session key or held as a single message key, once the message
   *            row shows it pinned, in this session, from this sender, at
   *            request.message_index.
   */
  private async keyToAnswer(request: KeyRequest): Promise<{ scope: KeyScope; key: string } | null> {
    if (!this.holdsKeyFor(request)) return null
    const sessionKey = this.heldSessionKey(request)
    if (this.isLegacyRequest(request) || request.key_scope === 'session') {
      return sessionKey ? { scope: 'session', key: sessionKey } : null
    }

    const index = await this.pinnedMessageIndex(request)
    if (index === null || !request.sender_user_id) return null
    const key = sessionKey
      ? await megolmService.deriveMessageKey(sessionKey, index)
      : megolmService.getMessageKey(request.room_id, request.sender_user_id, request.session_id, index)
    return key ? { scope: 'message', key } : null
  }

  private async pinnedMessageIndex(request: KeyRequest): Promise<number | null> {
    if (!request.message_id || request.message_index == null) return null
    const { data, error } = await supabase
      .from('messages')
      .select('user_id, channel_id, conversation_id, is_pinned, is_deleted, encryption_metadata')
      .eq('id', request.message_id)
      .maybeSingle()
    if (error || !data) return null
    const meta = (data.encryption_metadata ?? {}) as { session_id?: string; message_index?: number | string }
    const index = Number(meta.message_index)
    const room = data.channel_id || data.conversation_id
    if (
      data.is_pinned !== true
      || data.is_deleted === true
      || data.user_id !== request.sender_user_id
      || room !== request.room_id
      || meta.session_id !== request.session_id
      || !Number.isInteger(index)
      || index !== request.message_index
    ) {
      debug.warn(`Key request ${request.id.substring(0, 8)} names a message that is not this session's pinned message`)
      return null
    }
    return index
  }

  /**
   * Answers through fulfill_megolm_key_request: the first answer wins and
   * names this user as the wrapper. Servers before 20261028100001 lack it;
   * there the sender alone answers with the session key, by a direct update,
   * once the requester passes is_room_member.
   */
  private async fulfillRequest(request: KeyRequest, encryptedKey: string, scope: KeyScope): Promise<boolean> {
    const { data, error } = await supabase.rpc('fulfill_megolm_key_request', {
      p_request_id: request.id,
      p_encrypted_key: encryptedKey,
      p_key_scope: scope,
    })
    if (!error) {
      if (data !== true) debug.log(`Key request ${request.id.substring(0, 8)} was already answered`)
      return data === true
    }
    if (error.code !== MISSING_FUNCTION) {
      debug.warn(`Key request ${request.id.substring(0, 8)} not fulfilled:`, error.message)
      return false
    }
    if (scope !== 'session' || request.sender_user_id !== this.userId || !(await this.isRequesterInRoom(request))) {
      return false
    }

    const { error: updateError } = await supabase
      .from('megolm_key_requests')
      .update({
        status: 'fulfilled',
        encrypted_key: encryptedKey,
        fulfilled_at: new Date().toISOString()
      })
      .eq('id', request.id)

    if (updateError) {
      debug.error('Failed to fulfill request:', updateError)
      return false
    }
    return true
  }

  /**
   * The request carries a valid signature from the requester's published
   * signing key over (room_id, session_id, requester_user_id). Unsigned
   * requests are rejected (no honest current client sends them).
   */
  private async isRequestSignatureValid(request: KeyRequest): Promise<boolean> {
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
      return true
    } catch (err) {
      debug.warn('Key request signature verification threw - rejecting:', err)
      return false
    }
  }

  /** The requester is a current member of the room per the server. */
  private async isRequesterInRoom(request: KeyRequest): Promise<boolean> {
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
      return true
    } catch (err) {
      debug.warn('Membership check threw - rejecting:', err)
      return false
    }
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
   * Take in the key of a locally issued request that was fulfilled.
   *
   *   'imported'  the sender's key, imported; or a relayed key for a session
   *               already held. The row flips to 'received'.
   *   'relayed'   a key from another member, held until a ciphertext of the
   *               session verifies it (see settleRelayedKey). The row stays
   *               'fulfilled'.
   *   'failed'    the key does not unwrap. The offline sweep quarantines such
   *               rows (sealed to a previous identity key) rather than retry
   *               them on every unlock.
   *
   * `prefetchedWrapperKey` lets the batch sweep pass the wrapper's public key
   * in - one query for all rows instead of one per row.
   */
  private async handleFulfilledRequest(
    request: KeyRequest,
    prefetchedWrapperKey?: string | null,
    // The offline sweep batches status updates itself and passes true to skip
    // the per-row flip below; one PATCH per row costs ~14s of serial requests
    // on a large backlog.
    deferStatusFlip = false,
  ): Promise<FulfilledOutcome> {
    debug.log(`Key request fulfilled! Session ${request.session_id.substring(0, 8)}...`)

    const senderUserId = request.sender_user_id
    const wrapperUserId = request.fulfilled_by_user_id || senderUserId
    if (!request.encrypted_key || !senderUserId || !wrapperUserId) {
      debug.log('Fulfilled request has no encrypted key or sender')
      return 'failed'
    }
    const scope: KeyScope = request.key_scope === 'message' ? 'message' : 'session'
    // A key from anyone but the sender, and the key of a single message, wait
    // for a ciphertext to verify them.
    const held = wrapperUserId !== senderUserId || scope === 'message'

    try {
      if (held && megolmService.hasInboundSession(request.room_id, senderUserId, request.session_id)) {
        await this.markReceived(request.id, deferStatusFlip)
        return 'imported'
      }

      // Wrapper's public key, for ECDH decryption.
      let wrapperPublicKey = prefetchedWrapperKey ?? null
      if (wrapperPublicKey === null && prefetchedWrapperKey === undefined) {
        const { data: wrapperKey } = await supabase
          .from('user_key_pairs')
          .select('identity_public_key')
          .eq('user_id', wrapperUserId)
          .eq('is_active', true)
          .maybeSingle()
        wrapperPublicKey = wrapperKey?.identity_public_key ?? null
      }

      if (!wrapperPublicKey) {
        debug.warn(`No public key for ${wrapperUserId.substring(0, 8)}, cannot decrypt`)
        return 'failed'
      }

      const sessionKey = await this.decryptSessionKeyFromSender(
        request.encrypted_key,
        wrapperPublicKey
      )

      this.forgetPendingRequest(request.id, scope === 'session' ? request.session_id : null)

      if (held) {
        this.holdRelayedKey({
          requestId: request.id,
          roomId: request.room_id,
          senderUserId,
          sessionId: request.session_id,
          sessionKey,
          scope,
          messageId: request.message_id ?? null,
        })
        debug.log(`Holding a ${scope} key of session ${request.session_id.substring(0, 8)}... from ${wrapperUserId.substring(0, 8)} until a ciphertext verifies it`)
        this.notifyKeyReceived(request.room_id, request.session_id)
        return 'relayed'
      }

      await megolmService.importInboundSession(
        request.room_id,
        senderUserId,
        request.session_id,
        sessionKey,
        0 // firstKnownIndex
      )

      debug.log(`Imported session ${request.session_id.substring(0, 8)}... from fulfilled request`)

      // Mark the request consumed. The fulfilled key arrives on an ephemeral
      // realtime broadcast; a client offline when it fires recovers the row via
      // processMyFulfilledRequests() on the next unlock. The flip to 'received'
      // stops that catch-up from re-importing the same key. Best-effort: a
      // failed update costs one redundant future import.
      await this.markReceived(request.id, deferStatusFlip)

      this.notifyKeyReceived(request.room_id, request.session_id)

      this.triggerAutoBackup().catch(() => {})
      return 'imported'
    } catch (error) {
      debug.error('Error importing fulfilled key:', error)
      // Re-arm the dedup so a follow-up decrypt attempt issues a fresh request
      // instead of blocking behind this failed import.
      this.forgetPendingRequest(request.id, scope === 'session' ? request.session_id : null)
      return 'failed'
    }
  }

  /** Drops the dedup entries of a request, and the session's entry when given. */
  private forgetPendingRequest(requestId: string | undefined, sessionId: string | null): void {
    for (const [key, entry] of this.pendingRequests) {
      if (entry.requestId === requestId) this.pendingRequests.delete(key)
    }
    if (sessionId) this.pendingRequests.delete(sessionId)
  }

  private async markReceived(requestId: string, deferStatusFlip: boolean): Promise<void> {
    if (deferStatusFlip || !requestId || !this.userId) return
    await supabase
      .from('megolm_key_requests')
      .update({ status: 'received' })
      .eq('id', requestId)
      .eq('requester_user_id', this.userId)
      .then(() => {}, () => {})
  }

  private notifyKeyReceived(roomId: string, sessionId: string): void {
    for (const callback of this.keyReceivedCallbacks) {
      try {
        callback(roomId, sessionId)
      } catch (e) {
        debug.error('Error in key received callback:', e)
      }
    }
  }

  private relayedKeyId(roomId: string, senderUserId: string, sessionId: string): string {
    return `${roomId}:${senderUserId}:${sessionId}`
  }

  private holdRelayedKey(key: RelayedKey): void {
    const id = this.relayedKeyId(key.roomId, key.senderUserId, key.sessionId)
    const held = (this.relayedKeys.get(id) ?? []).filter(k => k.requestId !== key.requestId)
    this.relayedKeys.set(id, [...held, key])
  }

  /** Held keys for one session awaiting verification, oldest first. */
  relayedKeysFor(roomId: string, senderUserId: string, sessionId: string): RelayedKey[] {
    return [...(this.relayedKeys.get(this.relayedKeyId(roomId, senderUserId, sessionId)) ?? [])]
  }

  /**
   * Settle a held key once the decrypt path has tried it on a signed
   * ciphertext: of its session, or of its message for a single message key.
   * Accepted (the caller imported it): its request is consumed and this
   * user's other pending requests for the session (session key) or the
   * message (message key) are cancelled. Refused: its request expires, so the
   * sweep stops offering it, and the next decrypt miss asks again.
   */
  async settleRelayedKey(key: RelayedKey, accepted: boolean): Promise<void> {
    const id = this.relayedKeyId(key.roomId, key.senderUserId, key.sessionId)
    const rest = (this.relayedKeys.get(id) ?? []).filter(k =>
      k.requestId !== key.requestId
      && !(accepted && (key.scope === 'session' || k.messageId === key.messageId)))
    if (rest.length === 0) this.relayedKeys.delete(id)
    else this.relayedKeys.set(id, rest)
    if (!this.userId) return

    if (!accepted) {
      debug.warn(`Held ${key.scope} key for session ${key.sessionId.substring(0, 8)} does not decrypt it - refused`)
      // The first refusal lets the next miss ask again at once, for another holder's key. A
      // further refusal within KEY_REQUEST_RETRY_MS re-arms the dedup slots, so the next request
      // waits that long: a member answering wrongly every time does not drive a request loop. A
      // pinned message's request is keyed by the message whatever its answer's scope.
      const now = Date.now()
      const prior = this.refusals.get(key.sessionId)
      const count = prior && now - prior.at < this.KEY_REQUEST_RETRY_MS ? prior.count + 1 : 1
      this.refusals.set(key.sessionId, { count, at: now })
      if (count > 1) {
        const rearmed = { requestId: key.requestId, createdAt: now }
        this.pendingRequests.set(key.sessionId, rearmed)
        if (key.messageId) this.pendingRequests.set(`${key.sessionId}#${key.messageId}`, rearmed)
      }
      await supabase
        .from('megolm_key_requests')
        .update({ status: 'expired' })
        .eq('id', key.requestId)
        .eq('requester_user_id', this.userId)
        .then(() => {}, () => {})
      return
    }

    this.refusals.delete(key.sessionId)
    await this.markReceived(key.requestId, false)
    let others = supabase
      .from('megolm_key_requests')
      .update({ status: 'cancelled' })
      .eq('requester_user_id', this.userId)
      .eq('room_id', key.roomId)
      .eq('session_id', key.sessionId)
      .eq('status', 'pending')
    if (key.scope === 'message' && key.messageId) others = others.eq('message_id', key.messageId)
    await others.then(() => {}, () => {})
    this.forgetPendingRequest(key.requestId, key.scope === 'session' ? key.sessionId : null)
    this.notifyKeyReceived(key.roomId, key.sessionId)
    this.triggerAutoBackup().catch(() => {})
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
    this.refusals.clear()
    this.relayedKeys.clear()
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
            // A session key outranks message keys alone: a copy holding only a pinned message's
            // key does not replace the backup's full one.
            const inboundAt = new Map(sessions.inbound.map((s, i) => [`${s.roomId}:${s.sessionId}`, i]))
            for (const s of prior.sessions.inbound || []) {
              const at = inboundAt.get(`${s.roomId}:${s.sessionId}`)
              if (at === undefined) {
                sessions.inbound.push(s)
              } else if (!sessions.inbound[at].sessionKey && s.sessionKey) {
                const messageKeys = { ...s.messageKeys, ...sessions.inbound[at].messageKeys }
                sessions.inbound[at] = Object.keys(messageKeys).length > 0 ? { ...s, messageKeys } : s
              }
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
   * Request a session key from the sender and the members holding it. They
   * receive the row over realtime or on their next unlock and answer if they
   * hold the key the room's history setting allows.
   *
   * A pinned message gets a request of its own: a room showing newcomers only
   * pinned messages answers with that message's key alone, and a request named
   * after an unpinned neighbour gets no answer there.
   *
   * @param roomId room / channel / conversation id
   * @param sessionId Megolm session id needed
   * @param senderUserId user who sent the original message and holds the key
   * @param message the message that could not be decrypted
   */
  async createKeyRequest(
    roomId: string,
    sessionId: string,
    senderUserId?: string,
    message: KeyRequestMessage = {},
  ): Promise<string> {
    if (!this.userId) {
      throw new Error('Not initialized')
    }

    const dedupKey = message.pinned && message.id ? `${sessionId}#${message.id}` : sessionId

    // Dedup with expiry: an unanswered request (sender offline, failed
    // fulfillment, failed import) must not block re-requests forever.
    const existing = this.pendingRequests.get(dedupKey)
    if (existing) {
      if (Date.now() - existing.createdAt < this.KEY_REQUEST_RETRY_MS) {
        debug.log(`ℹAlready have pending request for session ${sessionId.substring(0, 8)}...`)
        return existing.requestId
      }
      this.pendingRequests.delete(dedupKey)
    }

    const requestId = crypto.randomUUID()

    // Reserve the dedup slot synchronously, before the insert. Parallel decrypt
    // failures for the same session - one page holds many messages of one
    // session - otherwise race past the check above and each insert a request
    // row. Rolled back on insert failure below.
    this.pendingRequests.set(dedupKey, { requestId, createdAt: Date.now() })

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

    const row = {
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
    }
    // A relayed key is imported only after it decrypts a ciphertext of the
    // session (settleRelayedKey), so any member holding it may answer.
    // Servers before 20261028100001 lack the columns; there the sender alone
    // answers.
    let { error } = await supabase
      .from('megolm_key_requests')
      .insert({ ...row, accepts_relay: true, message_id: message.id ?? null })
    if (error?.code === MISSING_COLUMN) {
      ({ error } = await supabase.from('megolm_key_requests').insert(row))
    }

    if (error) {
      // Roll back the synchronous dedup reservation so a retry can re-issue.
      const reserved = this.pendingRequests.get(dedupKey)
      if (reserved?.requestId === requestId) {
        this.pendingRequests.delete(dedupKey)
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
   * Pending requests this user may answer: get_relayable_key_requests (those
   * addressed to them, and relay-accepting ones in rooms they share with the
   * requester), or those addressed to them on servers without it.
   */
  private async getRequestsToAnswer(): Promise<KeyRequest[]> {
    if (!this.userId) return []
    const { data, error } = await supabase.rpc('get_relayable_key_requests', { p_limit: 200 })
    if (!error) return (data || []) as KeyRequest[]
    if (error.code !== MISSING_FUNCTION) {
      debug.error('Failed to fetch requests to answer:', error)
      return []
    }
    return this.getRequestsToMe()
  }

  /**
   * Fulfill pending requests this user may answer where the key is held.
   * Called on unlock to catch up on requests raised while offline.
   */
  async processPendingRequestsToMe(): Promise<number> {
    const requests = (await this.getRequestsToAnswer())
      .filter(request => this.holdsKeyFor(request))
    let fulfilledCount = 0

    for (const request of requests) {
      try {
        if (await this.handleIncomingKeyRequest(request)) fulfilledCount++
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
   * them. A relayed row stays 'fulfilled' until a decrypt settles its key.
   * Returns the keys imported or held.
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

    // Batch-fetch every wrapper's public key in one query. Per-row fetching
    // inside handleFulfilledRequest costs one identical user_key_pairs query
    // per stale row from the same fulfiller - 170 observed on one unlock.
    const wrapperOf = (r: KeyRequest) => r.fulfilled_by_user_id || r.sender_user_id
    const wrapperIds = [...new Set((data as KeyRequest[]).map(wrapperOf).filter((id): id is string => !!id))]
    const wrapperKeyMap = new Map<string, string>()
    if (wrapperIds.length > 0) {
      const { data: keys, error: keysError } = await supabase
        .from('user_key_pairs')
        .select('user_id, identity_public_key')
        .in('user_id', wrapperIds)
        .eq('is_active', true)
      if (keysError) {
        debug.warn('Batch fulfiller-key fetch failed, aborting sweep (will retry next unlock):', keysError)
        return 0
      }
      for (const k of keys || []) {
        if (k.identity_public_key) wrapperKeyMap.set(k.user_id, k.identity_public_key)
      }
    }

    const importedIds: string[] = []
    const failedIds: string[] = []
    let relayedCount = 0
    for (const request of data as KeyRequest[]) {
      const wrapper = wrapperOf(request)
      const outcome = await this.handleFulfilledRequest(
        request,
        (wrapper && wrapperKeyMap.get(wrapper)) ?? null,
        true, // defer status flips - batched below
      )
      if (outcome === 'imported') importedIds.push(request.id)
      else if (outcome === 'relayed') relayedCount++
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

    return importedIds.length + relayedCount
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

