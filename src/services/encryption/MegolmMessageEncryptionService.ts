/**
 * Megolm Message Encryption Service
 * 
 * High-level service for encrypting and decrypting messages using Megolm-style
 * room-based encryption. This is a refactored approach that:
 * 
 * 1. Uses per-room session keys (not per-message key exchange)
 * 2. Supports recovery key backup for cross-device/cache recovery
 * 3. Is more efficient for group messaging
 * 
 * This service replaces the Signal Protocol-based MessageEncryptionService
 * for the new encryption architecture.
 */

import { supabase } from '@/supabase'
import { megolmService, type MegolmEncryptedMessage } from './MegolmService'
import { recoveryKeyService } from './RecoveryKeyService'
import { megolmKeyBackupService } from './MegolmKeyBackupService'
import { secureSessionKeyStore, identityKeyStore, signingKeyStore, pinnedKeyStore } from './SecureSessionKeyStore'
import {
  hashCiphertextB64,
  generateSigningKeyPair,
  exportPublicSigningKey,
  exportPrivateSigningKey,
  importPublicSigningKey,
  importPrivateSigningKey,
  signMessage,
  verifyMessageSignature,
  buildAadBytesV3,
  type SignedMessageFields,
  type AadFieldsV3,
} from './MessageSigner'
import { deviceIdentityService } from './DeviceIdentityService'
import { roomEpochService } from './RoomEpochService'
import type { MessagePart } from '@/types'
import { debug } from '@/utils/debug'

export interface MegolmEncryptionStatus {
  enabled: boolean
  hasRecoveryKey: boolean
  hasBackup: boolean
  needsSetup: boolean
  mode: 'disabled' | 'optional' | 'required'
}

/**
 * Metadata for an encrypted message.
 *
 * `algorithm`:
 *   - 'megolm_v1' - legacy ciphertext, no per-message sender signature.
 *     Decryption succeeds but the message is flagged `sender_verified: false`.
 *   - 'megolm_v2_signed' - current scheme. The `signature` field is an
 *     ECDSA P-256 SHA-256 signature over a canonical encoding of
 *     (algorithm, room_id, session_id, message_index, sender_user_id,
 *      SHA-256(ciphertext_bytes), timestamp). Verification failure rejects
 *     the message.
 */
export interface MegolmEncryptedMessageData {
  encrypted: true
  content: MessagePart[] // Encrypted content (base64 ciphertext in text field)
  encryption_metadata: {
    algorithm: 'megolm_v1' | 'megolm_v2_signed' | 'megolm_v3'
    session_id: string
    message_index: number
    sender_user_id: string
    timestamp: number
    /** base64(ECDSA P-256 SHA-256 signature). Only present for v2/v3. */
    signature?: string
    /**
     * Fingerprint (SHA-256 first 16 chars hex of SPKI) of the signing public
     * key used. Lets clients distinguish key rotations and warn on changes.
     * Optional in v2; we set it when we know it.
     */
    signing_key_fingerprint?: string
    /** v3: membership epoch the message belongs to. */
    epoch_id?: number
    /** v3: id of the sending device (verified against user_devices). */
    sender_device_id?: string
    /** v3: content type bound into the AES-GCM AAD. */
    content_type?: string
  }
}

/**
 * Cache lookup result for a sender's signing public key.
 */
interface CachedSigningKey {
  publicKey: CryptoKey
  fingerprint: string
  cachedAt: number
}

/**
 * Megolm Message Encryption Service
 * Handles message encryption using room-based Megolm sessions
 */
export class MegolmMessageEncryptionService {
  private static instance: MegolmMessageEncryptionService
  private currentUserId: string | null = null
  private initialized = false

  // Cached signing public keys, keyed by sender user id. SPKI fetches are
  // batched in the same query as ECDH keys; this cache absorbs verification
  // for the hot decrypt path. Time-bounded so device rotations propagate.
  // null = negative entry: sender has no signing key on file. Cached with the
  // same TTL - without it, every message from a legacy (unsigned) sender
  // re-fires the user_key_pairs query on the decrypt hot path (observed as
  // 180+ identical requests on a cold channel load).
  private signingKeyCache = new Map<string, { entry: CachedSigningKey | null; cachedAt: number }>()
  private signingKeyFetches = new Map<string, Promise<CachedSigningKey | null>>()
  private static readonly SIGNING_KEY_CACHE_TTL_MS = 5 * 60_000

  // Session ids we've already triggered a key-backup for this run. Sending under
  // a brand-new outbound session refreshes the backup once so the sender can
  // read their own messages on a future device (see encryptMessage).
  private backedUpSessionIds = new Set<string>()

  // Cached "identity epoch" (created_at of the active key pair). See
  // getIdentityCreatedAt(). Cleared on reset/cleanup.
  private identityCreatedAtMs: number | null = null

  private constructor() {}

  static getInstance(): MegolmMessageEncryptionService {
    if (!MegolmMessageEncryptionService.instance) {
      MegolmMessageEncryptionService.instance = new MegolmMessageEncryptionService()
    }
    return MegolmMessageEncryptionService.instance
  }

  /**
   * Initialize the service for a user
   */
  async initialize(authUserId: string): Promise<void> {
    // Get profile ID from database
    // Never fall back to the auth UUID: it poisons the per-user session DB
    // name, backup blob userId, and share rows. Fail and retry next init.
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', authUserId)
      .single()

    if (profileError || !profile?.id) {
      debug.error('Cannot resolve profile id for encryption init:', profileError)
      throw new Error('Could not resolve your profile for encryption - please retry')
    }
    this.currentUserId = profile.id

    if (this.currentUserId) {
      await megolmKeyBackupService.initialize(this.currentUserId)
      
      megolmKeyBackupService.onKeyReceived((roomId, sessionId) => {
        debug.log(`Key received for room ${roomId.substring(0, 8)}..., session ${sessionId.substring(0, 8)}...`)
        window.dispatchEvent(new CustomEvent('megolm-key-received', { 
          detail: { roomId, sessionId } 
        }))
      })
    }

    this.initialized = true
    debug.log('MegolmMessageEncryptionService initialized')

    // Try to auto-unlock from session storage (persists across page refresh)
    await this.tryAutoUnlock()
  }

  /**
   * Try to auto-unlock encryption from stored session
   */
  private async tryAutoUnlock(): Promise<boolean> {
    if (!this.currentUserId) return false

    try {
      // Try IndexedDB first (non-extractable CryptoKeys - preferred)
      const storedKeys = await secureSessionKeyStore.load(this.currentUserId)
      if (storedKeys) {
        debug.log('Found stored CryptoKeys in IndexedDB - auto-unlocking...')

        recoveryKeyService.setDerivedKeys(storedKeys)

        await megolmService.initialize(this.currentUserId, storedKeys.encryptionKey)
        await this.ensureIdentityKeyPair()
        // Ensure the per-user signing key exists. Legacy users (created
        // before the signing-key migration) get one minted lazily here so
        // their next message is fully signed.
        await this.ensureSigningKeyPair().catch(err =>
          debug.warn('Failed to ensure signing key on auto-unlock:', err),
        )
        await deviceIdentityService.ensureRegistered(this.currentUserId).catch(err =>
          debug.warn('Failed to register device on auto-unlock:', err),
        )

        try {
          const result = await megolmKeyBackupService.restoreFromBackup()
          if (result.outboundCount + result.inboundCount > 0) {
            debug.log(`Restored ${result.outboundCount + result.inboundCount} sessions from backup`)
          }
        } catch { /* ignore */ }

        // Offline catch-up sweeps run in the BACKGROUND. They were awaited
        // here, which put them (and their per-row work) on the critical path
        // of initialize() - and processMessageDecryption awaits initialize(),
        // so the first message load of the session stalled behind them
        // (observed: ~170 stale fulfilled key-request rows = ~30s cold load).
        // Late-arriving keys fire keyReceivedCallbacks / megolm-key-received,
        // which re-decrypt anything already painted.
        void megolmKeyBackupService.processPendingRequestsToMe().catch(() => {})
        void megolmKeyBackupService.processMyFulfilledRequests().catch(() => {})

        // Parity with initializeWithRecoveryKey: sweep shares delivered while
        // this device was offline so first render doesn't fall into the
        // per-message slow path.
        try {
          const claimedCount = await this.claimPendingSessionShares()
          if (claimedCount > 0) {
            debug.log(`Claimed ${claimedCount} pending session shares on auto-unlock`)
          }
        } catch { /* ignore */ }

        debug.log('Auto-unlocked encryption from IndexedDB keys')

        // Tell the UI encryption is now usable. Components that mounted
        // BEFORE this point (e.g. a direct page load straight into a DM)
        // checked isUnlocked() too early and cached `false` - without this
        // event their click-to-decrypt affordances never enable. Parity with
        // initializeWithRecoveryKey, which already fires the same event.
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
          window.dispatchEvent(new CustomEvent('megolm-key-received', { detail: { roomId: '*', sessionId: '*' } }))
        }
        return true
      }

      // No stored keys - encryption is locked
      this.clearLegacyStorage()
      debug.log('No stored session - encryption locked')
      return false
    } catch (error) {
      debug.warn('Failed to auto-unlock:', error)
      return false
    }
  }

  /**
   * Store derived keys securely in IndexedDB as non-extractable CryptoKey objects.
   * The raw mnemonic is never persisted.
   */
  private async storeSessionKeys(keys: { encryptionKey: CryptoKey; backupKey: CryptoKey; signingKey: CryptoKey }): Promise<void> {
    if (!this.currentUserId) return
    await secureSessionKeyStore.store(this.currentUserId, keys)
  }

  /** Remove legacy mnemonic from localStorage/sessionStorage */
  private clearLegacyStorage(): void {
    if (!this.currentUserId) return
    localStorage.removeItem(`megolm_session_${this.currentUserId}`)
    sessionStorage.removeItem(`megolm_session_${this.currentUserId}`)
  }

  /**
   * Clear stored session (lock encryption)
   */
  async lockEncryption(): Promise<void> {
    if (this.currentUserId) {
      await secureSessionKeyStore.clear(this.currentUserId).catch(() => {})
      await identityKeyStore.clear(this.currentUserId).catch(() => {})
      await signingKeyStore.clear(this.currentUserId).catch(() => {})
      this.clearLegacyStorage()
    }
    megolmService.close()
    recoveryKeyService.clear()
    this.signingKeyCache.clear()
    debug.log('Encryption locked')
  }

  /**
   * Initialize encryption with recovery key
   * This is called when user enters their recovery phrase
   */
  async initializeWithRecoveryKey(words: string[]): Promise<void> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    // Derive keys from mnemonic
    const derivedKeys = await recoveryKeyService.deriveKeysFromMnemonic(words)

    await megolmService.initialize(this.currentUserId, derivedKeys.encryptionKey)

    // Ensure identity key pair (ECDH) and signing key pair (ECDSA) both exist
    await this.ensureIdentityKeyPair()
    await this.ensureSigningKeyPair()
    // Recovery-key unlock implies L2 (history-unlock capable) trust for this device.
    await deviceIdentityService.ensureRegistered(this.currentUserId, 'recovery').catch(err =>
      debug.warn('Failed to register device after recovery unlock:', err),
    )

    // Try to restore from backup
    try {
      const result = await megolmKeyBackupService.restoreFromBackup()
      debug.log(`Restored ${result.outboundCount + result.inboundCount} sessions from backup`)
    } catch (error) {
      debug.error('Backup restore failed during recovery unlock:', error)
    }

    // Claim any pending session shares
    try {
      const claimedCount = await this.claimPendingSessionShares()
      if (claimedCount > 0) {
        debug.log(`Claimed ${claimedCount} pending session shares`)
      }
    } catch (error) {
      debug.warn('Failed to claim pending session shares:', error)
    }

    // Offline catch-up sweeps (fulfilling requests addressed to us; importing
    // keys fulfilled FOR us while offline - the key_fulfilled broadcast is
    // ephemeral) run in the BACKGROUND so the unlock UI isn't blocked on
    // per-row work. Each imported key fires keyReceivedCallbacks, and the
    // megolm-key-received event below re-decrypts what's already on screen.
    void megolmKeyBackupService.processPendingRequestsToMe()
      .then(fulfilledCount => {
        if (fulfilledCount > 0) debug.log(`Fulfilled ${fulfilledCount} pending key requests`)
      })
      .catch(error => debug.warn('Failed to process pending key requests:', error))
    void megolmKeyBackupService.processMyFulfilledRequests()
      .catch(error => debug.warn('Failed to import fulfilled key requests:', error))

    await this.storeSessionKeys(derivedKeys)
    this.clearLegacyStorage()

    // Now that keys are unlocked and shares/backups are restored, tell the UI
    // to re-decrypt anything already on screen. Without this, messages that
    // rendered as glyphs while locked stay as glyphs until a manual reload.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('megolm-key-received', { detail: { roomId: '*', sessionId: '*' } }))
    }

    debug.log('Encryption initialized with recovery key')
  }

  /**
   * Setup new encryption with a fresh recovery key
   * Returns the generated recovery words
   */
  async setupNewEncryption(): Promise<string[]> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    const words = await recoveryKeyService.generateMnemonic(12)
    
    // Complete setup with the generated words
    await this.completeSetupWithWords(words)

    debug.log('New encryption setup complete')
    return words
  }

  /**
   * Complete encryption setup with provided recovery words
   * Used when wizard generates words first, then user confirms
   */
  async completeSetupWithWords(words: string[]): Promise<void> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    debug.log('Completing encryption setup...')

    // Derive keys from mnemonic
    const derivedKeys = await recoveryKeyService.deriveKeysFromMnemonic(words)

    await megolmService.initialize(this.currentUserId, derivedKeys.encryptionKey)
    debug.log('Megolm service initialized')

    // Generate identity key pair for session key exchange. forceNew: this is a
    // fresh setup, so replace any stale row rather than trying (and failing) to
    // restore an old identity wrapped under a different recovery key.
    await this.ensureIdentityKeyPair(true)
    debug.log('Identity key pair ready')

    await this.ensureSigningKeyPair()
    debug.log('Signing key pair ready')

    // Register this device. Completing setup means the recovery phrase exists
    // on this device -> L2 (history-unlock capable).
    await deviceIdentityService.ensureRegistered(this.currentUserId, 'recovery').catch(err =>
      debug.warn('Failed to register device during setup:', err),
    )

    await megolmKeyBackupService.initialize(this.currentUserId)

    const verificationCode = await recoveryKeyService.generateVerificationCode()

    // Store recovery key metadata (NOT the key itself!)
    const { error } = await supabase.rpc('register_recovery_key', {
      p_user_id: this.currentUserId,
      p_verification_code: verificationCode,
      p_word_count: 12
    })
    
    if (error) {
      debug.error('Failed to register recovery key:', error)
      throw new Error('Failed to register recovery key metadata')
    }
    debug.log('Recovery key metadata registered')

    try {
      await megolmKeyBackupService.createBackup()
      debug.log('Initial backup created')
    } catch (backupError) {
      debug.warn('Failed to create initial backup:', backupError)
    }

    await this.storeSessionKeys(derivedKeys)
    this.clearLegacyStorage()

    debug.log('Encryption setup complete!')
    debug.log(`   isUnlocked: ${this.isUnlocked()}`)
    debug.log(`   hasRecoveryKey: ${await this.hasRecoveryKey()}`)
  }

  /**
   * Ensure user has an identity key pair for session key exchange.
   * Also ensures the private key CryptoKey is cached in IndexedDB for ECDH.
   *
   * @param forceNew - Used by fresh setup. Replaces any existing identity row
   *   with a brand-new key pair instead of trying to restore it. This unblocks
   *   "Reset Encryption -> set up again" even if a stale, undecryptable row
   *   survived (e.g. on a deploy without the reset RPC): we overwrite it in
   *   place rather than throwing "could not unlock".
   */
  private async ensureIdentityKeyPair(forceNew = false): Promise<void> {
    if (!this.currentUserId) return

    const cachedKey = await identityKeyStore.load(this.currentUserId)

    // Fetch own keypair via SECURITY DEFINER RPC. After the
    // 20260520 user_key_pairs RLS tightening, the encrypted_private columns
    // are no longer SELECTable through PostgREST (column-level GRANTs).
    const { data: keyPairRows, error: keyPairError } = await supabase.rpc('get_my_key_pair')

    // CRITICAL: if the lookup itself failed (RPC missing, network, RLS), we must
    // NOT fall through to "generate a new key". Doing so mints a *second*
    // identity key whose public half others never received - every session
    // share addressed to our real key becomes undecryptable, and our own shares
    // are signed by a key peers can't match. Fail loudly so unlock is honest.
    if (keyPairError) {
      throw new Error(
        `Could not load your encryption identity (${keyPairError.message}). ` +
        `Encryption was not unlocked - please retry.`,
      )
    }

    const existingKey = (Array.isArray(keyPairRows) ? keyPairRows[0] : null) as
      | { id?: string; identity_public_key: string; identity_private_key_encrypted: string }
      | null

    if (existingKey && !forceNew) {
      if (cachedKey) {
        // Verify the cached private still pairs with the PUBLISHED public key
        // before trusting it. A key reset from another tab/device replaces the
        // user_key_pairs row; peers wrap to the NEW public while this browser
        // unwraps with the OLD private, so every fulfilled key request fails with
        // an opaque GCM error. On mismatch (or a legacy record with no recorded
        // public half), fall through and re-restore from the authoritative DB row
        // (what peers encrypt to).
        const cachedPublic = await identityKeyStore.loadPublicKey(this.currentUserId)
        if (cachedPublic && cachedPublic === existingKey.identity_public_key) {
          return
        }
        if (cachedPublic) {
          debug.warn(
            '⚠️ Local identity key does NOT match the published public key ' +
            '(key reset from another device?) - re-restoring from DB so ECDH pairs again',
          )
        } else {
          debug.log('Cached identity key has no recorded public half - re-restoring from DB to guarantee pairing')
        }
      }

      // Key pair in DB but not (verifiably) in IndexedDB - decrypt from DB
      // using the recovery key.
      // Let failures PROPAGATE: silently continuing left us with no identity key
      // in IndexedDB, so every later ECDH (claiming shares, sharing our session)
      // threw "Identity private key not found" and all messages showed as glyphs
      // in BOTH directions. A clear error is far better than silent breakage.
      if (existingKey.identity_private_key_encrypted) {
        let privateKeyBase64: string
        try {
          privateKeyBase64 = await this.decryptPrivateKeyFromStorage(
            existingKey.identity_private_key_encrypted,
          )
        } catch (e) {
          debug.error('Failed to decrypt stored identity key:', e)
          throw new Error(
            'Could not unlock your encryption identity with this recovery key. ' +
            'Double-check the recovery phrase, or reset encryption from Privacy settings.',
          )
        }
        const privateKeyBytes = Uint8Array.from(atob(privateKeyBase64), c => c.charCodeAt(0))
        const privateKey = await crypto.subtle.importKey(
          'pkcs8', privateKeyBytes,
          { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
        )
        await identityKeyStore.store(this.currentUserId, privateKey, existingKey.identity_public_key)
        debug.log('Restored identity key from DB to IndexedDB (pairing verified against published public key)')
        return
      }

      // Row exists but carries no encrypted private key - we can't derive it and
      // regenerating would change our public identity, breaking peers' shares to
      // us. Refuse loudly instead of leaving a half-broken state.
      throw new Error(
        'Your stored encryption identity is incomplete (no private key on record). ' +
        'Reset encryption from Privacy settings to regenerate it.',
      )
    }

    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    )

    const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey)
    const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyRaw)))

    const privateKeyRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
    const privateKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(privateKeyRaw)))

    const encryptedPrivateKey = await this.encryptPrivateKeyForStorage(privateKeyBase64)

    // If a stale row survived a reset (e.g. the reset RPC wasn't available),
    // overwrite it in place so setup doesn't collide with UNIQUE(user_id,
    // device_id) and doesn't leave the old, undecryptable key around. The
    // signing columns are nulled so ensureSigningKeyPair() re-mints them under
    // the new recovery key.
    let writeError: { message: string } | null = null
    if (forceNew && existingKey?.id) {
      const { error } = await supabase
        .from('user_key_pairs')
        .update({
          identity_public_key: publicKeyBase64,
          identity_private_key_encrypted: encryptedPrivateKey,
          identity_signing_public_key: null,
          identity_signing_private_key_encrypted: null,
          is_active: true,
        })
        .eq('id', existingKey.id)
      writeError = error
    } else {
      const { error } = await supabase
        .from('user_key_pairs')
        .insert({
          user_id: this.currentUserId,
          identity_public_key: publicKeyBase64,
          identity_private_key_encrypted: encryptedPrivateKey,
          device_id: 1,
          is_active: true
        })
      writeError = error
    }

    if (writeError) {
      debug.error('Failed to store identity key:', writeError)
      throw new Error('Failed to create identity key pair')
    }

    // Store non-extractable CryptoKey in IndexedDB, with the matching public
    // half so future unlocks can verify the pairing against user_key_pairs.
    const nonExtractablePrivateKey = await crypto.subtle.importKey(
      'pkcs8', privateKeyRaw,
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
    )
    await identityKeyStore.store(this.currentUserId, nonExtractablePrivateKey, publicKeyBase64)

    debug.log('Identity key pair created')
  }

  /**
   * Ensure the per-user ECDSA P-256 signing key exists.
   *
   * Three cases:
   *   1. Already in IndexedDB → done.
   *   2. Already in DB but not in IndexedDB → decrypt the wrapped private
   *      key with the recovery-derived encryption key and cache it.
   *   3. Not in either → generate a new keypair, store the public SPKI on
   *      the row and the AES-GCM-wrapped private PKCS#8 alongside it, then
   *      cache the non-extractable private in IndexedDB.
   *
   * Case (3) covers legacy users who set up encryption before this
   * migration; their next message becomes signed automatically.
   */
  private async ensureSigningKeyPair(): Promise<void> {
    if (!this.currentUserId) return

    // Already cached locally?
    const cached = await signingKeyStore.load(this.currentUserId)

    // Same constraint as above - encrypted private signing column is not
    // SELECTable post-20260520 RLS tightening; use the owner-scoped RPC.
    const { data: keyPairRows, error: keyPairError } = await supabase.rpc('get_my_key_pair')
    if (keyPairError) {
      throw new Error(
        `Could not load your signing identity (${keyPairError.message}). ` +
        `Signing key was not changed - please retry.`,
      )
    }
    const existingRow = (Array.isArray(keyPairRows) ? keyPairRows[0] : null) as
      | { id: string; identity_signing_public_key: string | null; identity_signing_private_key_encrypted: string | null }
      | null

    if (existingRow?.identity_signing_public_key && existingRow?.identity_signing_private_key_encrypted) {
      if (cached) return

      // DB has the keypair; restore the cache copy.
      try {
        const privPkcs8B64 = await this.decryptPrivateKeyFromStorage(
          existingRow.identity_signing_private_key_encrypted,
        )
        const nonExtractable = await importPrivateSigningKey(privPkcs8B64, false)
        await signingKeyStore.store(this.currentUserId, nonExtractable)
        debug.log('Restored signing key from DB to IndexedDB')
      } catch (err) {
        debug.warn('Failed to restore signing key from DB:', err)
      }
      return
    }

    // Need to generate a new keypair. Requires the recovery encryption key
    // (to wrap the private for storage), which is only available when
    // encryption is unlocked.
    if (!recoveryKeyService.getEncryptionKey()) {
      debug.log('ℹSigning key generation deferred - recovery encryption key not available')
      return
    }

    const keyPair = await generateSigningKeyPair()
    const publicSpkiB64 = await exportPublicSigningKey(keyPair.publicKey)
    const privatePkcs8B64 = await exportPrivateSigningKey(keyPair.privateKey)
    const encryptedPrivate = await this.encryptPrivateKeyForStorage(privatePkcs8B64)

    if (existingRow?.id) {
      const { error } = await supabase
        .from('user_key_pairs')
        .update({
          identity_signing_public_key: publicSpkiB64,
          identity_signing_private_key_encrypted: encryptedPrivate,
        })
        .eq('id', existingRow.id)
      if (error) {
        debug.error('Failed to attach signing key to existing row:', error)
        throw new Error('Failed to persist signing key')
      }
    } else {
      // No row at all (no ECDH key yet either) - this path is mostly defensive;
      // ensureIdentityKeyPair() should have created the row already.
      const { error } = await supabase
        .from('user_key_pairs')
        .insert({
          user_id: this.currentUserId,
          identity_signing_public_key: publicSpkiB64,
          identity_signing_private_key_encrypted: encryptedPrivate,
          device_id: 1,
          is_active: true,
        })
      if (error) {
        debug.error('Failed to insert signing-only row:', error)
        throw new Error('Failed to persist signing key')
      }
    }

    // Cache a non-extractable copy for fast signing.
    const nonExtractable = await importPrivateSigningKey(privatePkcs8B64, false)
    await signingKeyStore.store(this.currentUserId, nonExtractable)

    debug.log('Signing key pair created and published')
  }

  /**
   * Compute a short fingerprint (first 16 hex chars of SHA-256 over SPKI)
   * for a signing public key. Used purely for logging / UI display so
   * users can spot a sender's signing key changing.
   */
  private async signingKeyFingerprint(spkiBase64: string): Promise<string> {
    let bytes: Uint8Array
    try {
      bytes = Uint8Array.from(atob(spkiBase64), c => c.charCodeAt(0))
    } catch {
      return ''
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
    return hex.slice(0, 16)
  }

  /**
   * Load the current user's signing private key from IndexedDB.
   * Returns null if missing - callers must decide whether to skip signing
   * (legacy fallback) or refuse to send (we choose: skip and log).
   */
  private async getMySigningPrivateKey(): Promise<CryptoKey | null> {
    if (!this.currentUserId) return null
    return signingKeyStore.load(this.currentUserId)
  }

  /**
   * Fetch a sender's signing public key, with TTL cache.
   * Used during message verification on the decrypt hot path.
   */
  /**
   * Batch-prime the signing key cache for a set of senders in ONE query.
   * Called before a page of messages is verified, so per-message
   * getSenderSigningPublicKey calls hit the cache instead of each firing
   * their own user_key_pairs lookup (cold cache: N unique senders would
   * otherwise mean N queries). Negative results are cached too. Best-effort:
   * on failure the per-sender path below still works as fallback.
   */
  async prefetchSigningKeys(userIds: string[]): Promise<void> {
    const now = Date.now()
    const missing = [...new Set(userIds)].filter(id => {
      const cached = this.signingKeyCache.get(id)
      return !(cached && now - cached.cachedAt < MegolmMessageEncryptionService.SIGNING_KEY_CACHE_TTL_MS)
    })
    if (missing.length === 0) return

    const { data, error } = await supabase
      .from('user_key_pairs')
      .select('user_id, identity_signing_public_key')
      .in('user_id', missing)
      .eq('is_active', true)

    if (error) {
      debug.warn('Batch signing-key prefetch failed (per-sender fallback will retry):', error)
      return
    }

    const spkiByUser = new Map<string, string | null>()
    for (const row of data || []) {
      spkiByUser.set(row.user_id, (row as any).identity_signing_public_key || null)
    }

    await Promise.all(missing.map(async (userId) => {
      const spki = spkiByUser.get(userId)
      if (!spki) {
        // No row or no signing key: cache the negative result.
        this.signingKeyCache.set(userId, { entry: null, cachedAt: Date.now() })
        return
      }
      try {
        const publicKey = await importPublicSigningKey(spki)
        const fingerprint = await this.signingKeyFingerprint(spki)
        const entry: CachedSigningKey = { publicKey, fingerprint, cachedAt: Date.now() }
        this.signingKeyCache.set(userId, { entry, cachedAt: entry.cachedAt })
        this.checkAndPinSigningKey(userId, fingerprint).catch(() => {})
      } catch {
        // per-user prefetch is best-effort
      }
    }))

    debug.log(`Prefetched signing keys for ${missing.length} senders in one query`)
  }

  private async getSenderSigningPublicKey(senderUserId: string): Promise<CachedSigningKey | null> {
    const cached = this.signingKeyCache.get(senderUserId)
    if (cached && Date.now() - cached.cachedAt < MegolmMessageEncryptionService.SIGNING_KEY_CACHE_TTL_MS) {
      return cached.entry
    }

    // Dedup concurrent lookups: a cold channel load decrypts a whole page of
    // messages in parallel, and without this every one of them missed the
    // cache and fired its own user_key_pairs query.
    const inFlight = this.signingKeyFetches.get(senderUserId)
    if (inFlight) return inFlight

    const fetchPromise = (async (): Promise<CachedSigningKey | null> => {
      const { data, error } = await supabase
        .from('user_key_pairs')
        .select('identity_signing_public_key')
        .eq('user_id', senderUserId)
        .eq('is_active', true)
        .maybeSingle()

      if (error) {
        // Transient failure: don't cache, next call may succeed.
        debug.warn(`Failed to fetch signing key for ${senderUserId.substring(0, 8)}:`, error)
        return null
      }
      const spki = data?.identity_signing_public_key as string | undefined
      if (!spki) {
        // Sender has no signing key (legacy/unsigned). Cache the negative
        // result so per-message verification doesn't re-query for the TTL.
        this.signingKeyCache.set(senderUserId, { entry: null, cachedAt: Date.now() })
        return null
      }

      try {
        const publicKey = await importPublicSigningKey(spki)
        const fingerprint = await this.signingKeyFingerprint(spki)
        const entry: CachedSigningKey = { publicKey, fingerprint, cachedAt: Date.now() }
        this.signingKeyCache.set(senderUserId, { entry, cachedAt: entry.cachedAt })
        // TOFU: pin on first sight, gently notify (non-blocking) on change.
        // Fire-and-forget so verification stays fast.
        this.checkAndPinSigningKey(senderUserId, fingerprint).catch(() => {})
        return entry
      } catch (err) {
        debug.warn(`Failed to import signing key for ${senderUserId.substring(0, 8)}:`, err)
        return null
      }
    })()

    this.signingKeyFetches.set(senderUserId, fetchPromise)
    try {
      return await fetchPromise
    } finally {
      this.signingKeyFetches.delete(senderUserId)
    }
  }

  /**
   * Trust-on-first-use bookkeeping for a sender's signing key.
   *
   * - First time we see a sender: pin their fingerprint silently.
   * - Fingerprint unchanged: nothing to do.
   * - Fingerprint changed: this is the deliberately gentle, anti-Matrix path.
   *   We do NOT block decryption or force a verification ceremony. We accept
   *   the new key (verification already uses it), update the pin, and emit a
   *   non-blocking `harmony-identity-changed` CustomEvent so the UI can show a
   *   small, dismissible "X's security identity changed" notice. Most users
   *   never see it; when they do, it's informational.
   *
   * We never warn for the current user's own key (device enrollment is normal).
   */
  private async checkAndPinSigningKey(userId: string, fingerprint: string): Promise<void> {
    if (!fingerprint) return
    const existing = await pinnedKeyStore.get(userId)
    const now = Date.now()

    if (!existing) {
      await pinnedKeyStore.put({ userId, fingerprint, pinnedAt: now, updatedAt: now })
      return
    }

    if (existing.fingerprint === fingerprint) return

    // Changed. Update the pin and emit a soft notice (unless it's our own key).
    await pinnedKeyStore.put({
      userId,
      fingerprint,
      pinnedAt: existing.pinnedAt,
      updatedAt: now,
    })

    if (userId === this.currentUserId) return

    debug.warn(
      `🔔 Signing identity changed for ${userId.substring(0, 8)} ` +
      `(${existing.fingerprint} -> ${fingerprint})`,
    )
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('harmony-identity-changed', {
          detail: {
            userId,
            previousFingerprint: existing.fingerprint,
            newFingerprint: fingerprint,
            changedAt: now,
          },
        }))
      }
    } catch { /* non-fatal */ }
  }

  /**
   * Encrypt a message for a room (channel or conversation).
   *
   * Session-share race fix: if there are recipients who do NOT yet have the
   * outbound session key, we await the share before returning the ciphertext.
   * This guarantees the first encrypted message in a session can actually be
   * decrypted by recipients instead of showing as "encrypted glyphs" until a
   * background share lands. When everyone already has the key (steady-state
   * sends in an established room), sharing is a no-op and we don't block.
   */
  async encryptMessage(
    content: MessagePart[],
    roomId: string,
    recipientIds: string[]
  ): Promise<MegolmEncryptedMessageData> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    if (!megolmService.isInitialized()) {
      throw new Error('Encryption not unlocked - enter your recovery key first')
    }

    const timestamp = Date.now()
    const contentType = 'application/json'

    // Prefer the device-aware v3 format: signed by THIS device's key, bound to
    // the current membership epoch, with AES-GCM AAD over the message metadata.
    // Fall back to v2 (user-level signing key, no epoch/AAD) when no device
    // signing key is available (e.g. tests or pre-device-enrollment clients).
    await deviceIdentityService.ensureRegistered(this.currentUserId).catch(err =>
      debug.warn('Failed to ensure device registration before encrypt:', err),
    )
    const deviceSigningKey = await deviceIdentityService.getMyDeviceSigningKey().catch(() => null)

    const plaintextContent = JSON.stringify(content)

    let encryptedMessage: MegolmEncryptedMessage
    let algorithm: 'megolm_v2_signed' | 'megolm_v3'
    let epochId: number | undefined
    let senderDeviceId: string | undefined
    let signingKey: CryptoKey

    if (deviceSigningKey) {
      algorithm = 'megolm_v3'
      senderDeviceId = deviceIdentityService.getDeviceId()
      // Resolve the outbound session (and its epoch) BEFORE building AAD so the
      // authenticated metadata matches the session that actually encrypts.
      const queriedEpoch = await roomEpochService.getEpoch(roomId)
      const outbound = await megolmService.getOrCreateOutboundSession(roomId, queriedEpoch)
      epochId = outbound.epoch ?? queriedEpoch
      const aadBytes = buildAadBytesV3({
        algorithm,
        content_type: contentType,
        epoch_id: epochId,
        room_id: roomId,
        sender_user_id: this.currentUserId,
      })
      encryptedMessage = await megolmService.encryptMessage(roomId, plaintextContent, {
        epoch: epochId,
        additionalData: aadBytes,
      })
      const finalEpoch = encryptedMessage.epoch ?? epochId
      if (finalEpoch !== epochId) {
        throw new Error('Megolm v3 epoch/AAD mismatch - refusing to send')
      }
      signingKey = deviceSigningKey
    } else {
      // Legacy v2 path: user-level signing key, lazily enrolled, no AAD/epoch.
      algorithm = 'megolm_v2_signed'
      encryptedMessage = await megolmService.encryptMessage(roomId, plaintextContent)
      let userSigningKey = await this.getMySigningPrivateKey().catch(() => null)
      if (!userSigningKey) {
        debug.warn('No signing key on this device - attempting lazy enrollment before send')
        try {
          await this.ensureSigningKeyPair()
        } catch (err) {
          debug.error('Signing key enrollment failed:', err)
        }
        userSigningKey = await this.getMySigningPrivateKey().catch(() => null)
      }
      if (!userSigningKey) {
        throw new Error(
          'Cannot send a signed encrypted message: no signing key available. ' +
          'Unlock encryption with your recovery key so a signing key can be created.',
        )
      }
      signingKey = userSigningKey
    }

    // After encryption: session id is final (may have just been created/rotated).
    const usersNeedingSession = megolmService.getUsersNeedingSession(
      roomId,
      recipientIds,
      encryptedMessage.sessionId,
    )

    if (usersNeedingSession.length > 0) {
      // Block on session sharing so recipients have the key when the message
      // arrives. We still tolerate partial failure (the share helper logs
      // per-recipient errors), but at least the local round-trip is honored.
      try {
        await this.ensureSessionShared(roomId, encryptedMessage.sessionId, recipientIds)
      } catch (err) {
        debug.warn('Foreground session sharing failed (continuing):', err)
      }
    } else {
      // Steady state: background-share as a defensive backstop in case the
      // recipient list changed under us (e.g., a new member joined and the
      // in-memory `sharedWith` list is stale).
      this.ensureSessionShared(roomId, encryptedMessage.sessionId, recipientIds)
        .catch(err => debug.warn('Background session sharing failed:', err))
    }

    // Refresh the encrypted key backup on first send under a given session.
    // CRITICAL for reading our OWN messages on a fresh device: recipients recover
    // via server-side megolm_session_shares, but the SENDER is intentionally
    // excluded from those shares and relies solely on the backup — so every
    // outbound session must be backed up or it's unrecoverable on a new login.
    // triggerAutoBackup is debounced, so bursts coalesce.
    if (!this.backedUpSessionIds.has(encryptedMessage.sessionId)) {
      this.backedUpSessionIds.add(encryptedMessage.sessionId)
      megolmKeyBackupService.triggerAutoBackup().catch(() => {})
    }

    const encryptedContent: MessagePart[] = [{
      type: 'text',
      text: encryptedMessage.ciphertext
    }]

    const ciphertextHash = await hashCiphertextB64(encryptedMessage.ciphertext)
    const tbsFields: SignedMessageFields = {
      algorithm,
      room_id: roomId,
      session_id: encryptedMessage.sessionId,
      message_index: encryptedMessage.messageIndex,
      sender_user_id: this.currentUserId,
      ciphertext_hash_b64: ciphertextHash,
      timestamp,
      // v3-only fields (undefined for v2 -> identical v2 TBS).
      epoch_id: algorithm === 'megolm_v3' ? epochId : undefined,
      sender_device_id: algorithm === 'megolm_v3' ? senderDeviceId : undefined,
    }
    const signature = await signMessage(tbsFields, signingKey)

    // Best-effort fingerprint for UI/debug. If lookup fails we just omit it.
    let fingerprint: string | undefined
    try {
      if (algorithm === 'megolm_v3' && senderDeviceId) {
        const spki = await deviceIdentityService.getDeviceSigningPublicKey(this.currentUserId, senderDeviceId)
        if (spki) fingerprint = await this.signingKeyFingerprint(spki)
      } else {
        const { data: myKey } = await supabase
          .from('user_key_pairs')
          .select('identity_signing_public_key')
          .eq('user_id', this.currentUserId)
          .eq('is_active', true)
          .maybeSingle()
        const myPk = (myKey as any)?.identity_signing_public_key as string | undefined
        if (myPk) fingerprint = await this.signingKeyFingerprint(myPk)
      }
    } catch { /* non-fatal */ }

    return {
      encrypted: true,
      content: encryptedContent,
      encryption_metadata: {
        algorithm,
        session_id: encryptedMessage.sessionId,
        message_index: encryptedMessage.messageIndex,
        sender_user_id: this.currentUserId,
        timestamp,
        signature,
        signing_key_fingerprint: fingerprint,
        epoch_id: algorithm === 'megolm_v3' ? epochId : undefined,
        sender_device_id: algorithm === 'megolm_v3' ? senderDeviceId : undefined,
        content_type: algorithm === 'megolm_v3' ? contentType : undefined,
      },
    }
  }

  /**
   * Decrypt a message AND verify the sender signature (Megolm v2).
   *
   * Return value:
   *   - `content`         - decrypted MessagePart[]
   *   - `senderVerified`  - true ONLY when the signature was present AND
   *                         verified against the claimed sender's signing
   *                         public key. False for legacy v1 messages or
   *                         when the sender has no signing key on file.
   *
   * Behavior on signature mismatch (v2 only):
   *   - Throws `Sender signature invalid ...`. The message is NOT decrypted.
   *     This is the core "reattribution attack" defense - without it, a
   *     malicious DB writer could swap sender_user_id and have clients
   *     happily display Bob's content as if from Alice.
   *
   * Legacy `megolm_v1` (unsigned) messages are rejected outright.
   */
  async decryptMessage(
    message: {
      content: MessagePart[]
      channel_id?: string // For channel messages
      conversation_id?: string // For DMs
      encryption_metadata?: {
        algorithm?: string
        session_id?: string
        message_index?: number
        sender_user_id?: string
        timestamp?: number
        signature?: string
        signing_key_fingerprint?: string
        // v3 fields
        epoch_id?: number
        sender_device_id?: string
        content_type?: string
        // Legacy Signal Protocol fields
        encrypted_keys?: Record<string, string>
        sender_key_id?: string
        iv?: string
      }
    }
  ): Promise<{ content: MessagePart[]; senderVerified: boolean }> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    const metadata = message.encryption_metadata
    if (!metadata) {
      throw new Error('No encryption metadata')
    }

    const roomId = message.channel_id || message.conversation_id || ''

    if (metadata.algorithm === 'megolm_v3') {
      // v3: device-signed, epoch-bound, AAD-protected. Verify the device
      // signature BEFORE decrypting, then decrypt with the reconstructed AAD
      // (GCM authentication fails if any AAD-bound field was tampered).
      const senderVerified = await this.verifyV3Signature(message)
      if (!senderVerified) {
        throw new Error('Sender signature invalid - refusing to display tampered message')
      }
      const aadBytes = this.buildAadForMessage(message, roomId)
      const content = await this.decryptMegolmMessage(message, roomId, aadBytes)
      return { content, senderVerified: true }
    }

    if (metadata.algorithm === 'megolm_v2_signed') {
      // Verify the per-message signature BEFORE decryption:
      //   - It's pointless to spend CPU decrypting a message we'll reject.
      //   - More importantly, it prevents an attacker from using bogus
      //     signed-metadata to push the client into the key-request /
      //     session-share fallback path (network noise + log spam).
      const senderVerified = await this.verifyV2Signature(message)
      if (!senderVerified) {
        throw new Error('Sender signature invalid - refusing to display tampered message')
      }
      const content = await this.decryptMegolmMessage(message, roomId)
      return { content, senderVerified: true }
    }

    if (metadata.algorithm === 'megolm_v1') {
      // v1 was unsigned (no per-message sender binding). Support has been
      // dropped entirely: an unsigned message can be forged/reattributed, so we
      // refuse to display it rather than render unverifiable content.
      throw new Error('Unsupported legacy message (megolm_v1) - sender cannot be verified')
    }

    if (metadata.algorithm === 'signal_protocol_v1_hybrid') {
      // Legacy Signal Protocol message - can't decrypt without old keys
      debug.warn('Legacy Signal Protocol message - cannot decrypt')
      throw new Error('Legacy encrypted message - keys no longer available')
    }

    throw new Error(`Unsupported encryption algorithm: ${metadata.algorithm}`)
  }

  /**
   * Verify the per-message ECDSA signature for a Megolm v2 message.
   *
   * Returns:
   *   - true  → signature verified against the published signing key of
   *             `sender_user_id`. Safe to display.
   *   - false → signature missing, malformed, mismatched, or the sender
   *             has no signing key on file. Caller MUST treat as forgery.
   */
  private async verifyV2Signature(
    message: {
      content: MessagePart[]
      channel_id?: string
      conversation_id?: string
      encryption_metadata?: {
        algorithm?: string
        session_id?: string
        message_index?: number
        sender_user_id?: string
        timestamp?: number
        signature?: string
      }
    },
  ): Promise<boolean> {
    const meta = message.encryption_metadata
    if (!meta) return false
    const sessionId = meta.session_id
    const messageIndex = typeof meta.message_index === 'number'
      ? meta.message_index
      : Number(meta.message_index)
    const senderUserId = meta.sender_user_id
    const timestamp = typeof meta.timestamp === 'number'
      ? meta.timestamp
      : Number(meta.timestamp)
    const signature = meta.signature
    const roomId = message.channel_id || message.conversation_id || ''

    if (
      !signature ||
      !sessionId ||
      !Number.isFinite(messageIndex) ||
      !senderUserId ||
      !Number.isFinite(timestamp) ||
      !roomId
    ) {
      debug.warn('v2 message missing required fields for verification - rejecting')
      return false
    }

    const ciphertext = message.content[0]?.type === 'text' ? message.content[0].text : ''
    if (!ciphertext) return false

    const senderKey = await this.getSenderSigningPublicKey(senderUserId)
    if (!senderKey) {
      debug.warn(`No signing key on file for ${senderUserId.substring(0, 8)} - cannot verify`)
      return false
    }

    const ciphertextHash = await hashCiphertextB64(ciphertext)
    const tbsFields: SignedMessageFields = {
      algorithm: 'megolm_v2_signed',
      room_id: roomId,
      session_id: sessionId,
      message_index: messageIndex,
      sender_user_id: senderUserId,
      ciphertext_hash_b64: ciphertextHash,
      timestamp,
    }

    return verifyMessageSignature(tbsFields, signature, senderKey.publicKey)
  }

  /**
   * Reconstruct the AES-GCM AAD for a v3 message from its metadata + room.
   * Must exactly match what the sender bound at encrypt time, or GCM auth fails.
   */
  private buildAadForMessage(
    message: { encryption_metadata?: { sender_user_id?: string; epoch_id?: number; content_type?: string } },
    roomId: string,
  ): Uint8Array {
    const meta = message.encryption_metadata || {}
    const aadFields: AadFieldsV3 = {
      algorithm: 'megolm_v3',
      content_type: meta.content_type || 'application/json',
      epoch_id: typeof meta.epoch_id === 'number'
        ? meta.epoch_id
        : (Number.isFinite(Number(meta.epoch_id)) ? Number(meta.epoch_id) : 1),
      room_id: roomId,
      sender_user_id: meta.sender_user_id || '',
    }
    return buildAadBytesV3(aadFields)
  }

  /**
   * Verify a v3 message's signature against the SENDING DEVICE's signing key
   * (looked up by (sender_user_id, sender_device_id) in user_devices, which
   * also enforces revocation - a revoked device's messages fail to verify).
   */
  private async verifyV3Signature(
    message: {
      content: MessagePart[]
      channel_id?: string
      conversation_id?: string
      encryption_metadata?: {
        session_id?: string
        message_index?: number
        sender_user_id?: string
        timestamp?: number
        signature?: string
        epoch_id?: number
        sender_device_id?: string
      }
    },
  ): Promise<boolean> {
    const meta = message.encryption_metadata
    if (!meta) return false
    const sessionId = meta.session_id
    const messageIndex = typeof meta.message_index === 'number'
      ? meta.message_index
      : Number(meta.message_index)
    const senderUserId = meta.sender_user_id
    const timestamp = typeof meta.timestamp === 'number'
      ? meta.timestamp
      : Number(meta.timestamp)
    const signature = meta.signature
    const epochId = typeof meta.epoch_id === 'number'
      ? meta.epoch_id
      : Number(meta.epoch_id)
    const senderDeviceId = meta.sender_device_id
    const roomId = message.channel_id || message.conversation_id || ''

    if (
      !signature ||
      !sessionId ||
      !Number.isFinite(messageIndex) ||
      !senderUserId ||
      !Number.isFinite(timestamp) ||
      !roomId ||
      !Number.isFinite(epochId) ||
      !senderDeviceId
    ) {
      debug.warn('v3 message missing required fields for verification - rejecting')
      return false
    }

    const ciphertext = message.content[0]?.type === 'text' ? message.content[0].text : ''
    if (!ciphertext) return false

    const spki = await deviceIdentityService.getDeviceSigningPublicKey(senderUserId, senderDeviceId)
    if (!spki) {
      debug.warn(
        `⚠️ No active signing key for device ${senderDeviceId.substring(0, 8)} of ${senderUserId.substring(0, 8)} ` +
        `(unknown or revoked) - rejecting`,
      )
      return false
    }

    let publicKey: CryptoKey
    let fingerprint = ''
    try {
      publicKey = await importPublicSigningKey(spki)
      fingerprint = await this.signingKeyFingerprint(spki)
    } catch (err) {
      debug.warn('Failed to import v3 device signing key:', err)
      return false
    }

    const ciphertextHash = await hashCiphertextB64(ciphertext)
    const tbsFields: SignedMessageFields = {
      algorithm: 'megolm_v3',
      room_id: roomId,
      session_id: sessionId,
      message_index: messageIndex,
      sender_user_id: senderUserId,
      ciphertext_hash_b64: ciphertextHash,
      timestamp,
      epoch_id: epochId,
      sender_device_id: senderDeviceId,
    }

    const ok = await verifyMessageSignature(tbsFields, signature, publicKey)
    if (ok && fingerprint) {
      // TOFU pin is per-(user, device) for v3. Reuse the per-user pin store with
      // a composite key so a device key rotation surfaces the same gentle notice.
      this.checkAndPinSigningKey(`${senderUserId}:${senderDeviceId}`, fingerprint).catch(() => {})
    }
    return ok
  }

  /**
   * Decrypt a Megolm-encrypted message
   * OPTIMIZED: Fast path when we have the session key in memory
   */
  private async decryptMegolmMessage(
    message: {
      content: MessagePart[]
      encryption_metadata?: {
        session_id?: string
        message_index?: number
        sender_user_id?: string
      }
    },
    roomId: string,
    additionalData?: Uint8Array
  ): Promise<MessagePart[]> {
    if (!megolmService.isInitialized()) {
      throw new Error('Encryption not unlocked - enter your recovery key first')
    }

    const metadata = message.encryption_metadata!
    const sessionId = metadata.session_id
    const messageIndex = metadata.message_index
    const senderId = metadata.sender_user_id

    if (!sessionId || messageIndex === undefined || !senderId) {
      throw new Error('Missing Megolm encryption metadata')
    }

    const ciphertext = message.content[0]?.type === 'text' ? message.content[0].text : ''
    if (!ciphertext) {
      throw new Error('No encrypted content found')
    }

    const encryptedMessage: MegolmEncryptedMessage = {
      sessionId,
      messageIndex,
      ciphertext
    }

    // FAST PATH: Try to decrypt immediately (works if we have the key in memory)
    try {
      const decryptedJson = await megolmService.decryptMessage(roomId, senderId, encryptedMessage, additionalData)
      const decryptedContent: MessagePart[] = JSON.parse(decryptedJson)
      return decryptedContent
    } catch (error: any) {
      // SLOW PATH: Key not in memory, try to get it from server
      const errMsg = error?.message || String(error)
      if (errMsg.includes('No inbound session') || errMsg.includes('No outbound session')) {
        debug.log(`ℹMissing session ${sessionId.substring(0, 8)}... for room ${roomId.substring(0, 8)}..., fetching...`)

        // Recovery is deduped PER SESSION: a page decrypt runs messages in
        // parallel, and every message of a missing session used to run its
        // own claim RPC + share re-fetch + key request - K undecryptable
        // messages meant K full recovery passes blocking first paint. All
        // messages of one session now await one shared attempt.
        const recovered = await this.recoverMissingSession(roomId, senderId, sessionId)

        if (recovered) {
          // Retry decryption after importing shares
          try {
            const decryptedJson = await megolmService.decryptMessage(roomId, senderId, encryptedMessage, additionalData)
            const decryptedContent: MessagePart[] = JSON.parse(decryptedJson)
            return decryptedContent
          } catch {
            // Still failed - request key from sender
          }
        }

        // No shares available - request the key from the sender.
        // (createKeyRequest dedups per session, so parallel failures here
        // produce ONE request row.)
        debug.log(`Requesting session key from sender ${senderId.substring(0, 8)}...`)
        megolmKeyBackupService.createKeyRequest(roomId, sessionId, senderId)
          .catch(err => debug.warn('Key request failed:', err))
        throw new Error('Session key not available - key request sent to sender')
      }
      throw error
    }
  }

  // In-flight recovery attempts keyed by roomId:sessionId. Entries are kept
  // for a short TTL after settling so a burst (page decrypt) shares one
  // attempt, while a user-triggered retry a moment later can try again.
  private sessionRecoveryAttempts = new Map<string, Promise<boolean>>()

  /**
   * One shared attempt to recover a missing inbound session from the server:
   * claim unclaimed shares, then re-import our own (possibly already-claimed)
   * share row for this exact session. Returns whether anything was imported.
   */
  private recoverMissingSession(roomId: string, senderId: string, sessionId: string): Promise<boolean> {
    const key = `${roomId}:${sessionId}`
    const existing = this.sessionRecoveryAttempts.get(key)
    if (existing) return existing

    const attempt = (async (): Promise<boolean> => {
      // 1) Claim any pending (unclaimed) session shares from server
      const claimed = await this.claimPendingSessionShares()

      // 2) If nothing unclaimed matched, re-fetch OUR share row for this exact
      //    session even if it was already claimed. A claimed-but-lost share is
      //    the common "keeps failing" case: this device (or a wiped browser
      //    profile) no longer holds the key locally, but the wrapped key still
      //    sits in megolm_session_shares. Without this, the only recovery was
      //    a key request that needs the sender online.
      let reimported = false
      if (!megolmService.hasInboundSession(roomId, senderId, sessionId)) {
        reimported = await this.reimportShareForSession(roomId, sessionId)
      }
      return claimed > 0 || reimported
    })()

    this.sessionRecoveryAttempts.set(key, attempt)
    void attempt.finally(() => {
      setTimeout(() => this.sessionRecoveryAttempts.delete(key), 30_000)
    })
    return attempt
  }

  /**
   * Re-import our own share row(s) for one exact (room, session), REGARDLESS of
   * is_claimed. Recovers sessions whose share was claimed by a previous
   * install/tab whose IndexedDB is gone. RLS scopes the SELECT to rows where we
   * are the recipient, so this leaks nothing.
   */
  private async reimportShareForSession(roomId: string, sessionId: string): Promise<boolean> {
    if (!this.currentUserId) return false

    const { data: shares, error } = await supabase
      .from('megolm_session_shares')
      .select('room_id, session_id, sender_user_id, encrypted_session_key, first_known_index')
      .eq('recipient_user_id', this.currentUserId)
      .eq('room_id', roomId)
      .eq('session_id', sessionId)

    if (error || !shares || shares.length === 0) return false

    const senderIds = [...new Set(shares.map(s => s.sender_user_id).filter(Boolean))]
    if (senderIds.length === 0) return false
    const { data: senderKeys } = await supabase
      .from('user_key_pairs')
      .select('user_id, identity_public_key')
      .in('user_id', senderIds)
      .eq('is_active', true)

    const senderKeyMap = new Map<string, string>()
    for (const k of senderKeys || []) {
      if (k.identity_public_key) senderKeyMap.set(k.user_id, k.identity_public_key)
    }

    let imported = false
    for (const share of shares) {
      const senderPublicKey = senderKeyMap.get(share.sender_user_id)
      if (!senderPublicKey) continue
      try {
        const sessionKey = await this.decryptSessionKeyFromSender(
          share.encrypted_session_key,
          senderPublicKey,
          {
            roomId: share.room_id,
            sessionId: share.session_id,
            senderUserId: share.sender_user_id,
            recipientUserId: this.currentUserId,
          },
        )
        await megolmService.importInboundSession(
          share.room_id,
          share.sender_user_id,
          share.session_id,
          sessionKey,
          share.first_known_index ?? 0,
        )
        imported = true
      } catch (err) {
        debug.warn(`Failed to re-import claimed share for session ${sessionId.substring(0, 8)}:`, err)
      }
    }
    if (imported) {
      debug.log(`Re-imported claimed share for session ${sessionId.substring(0, 8)}...`)
      megolmKeyBackupService.triggerAutoBackup().catch(() => {})
    }
    return imported
  }

  /**
   * Ensure our session is shared with all recipients
   * OPTIMIZED: Batch DB queries and parallelize operations
   */
  private async ensureSessionShared(
    roomId: string,
    sessionId: string,
    recipientIds: string[]
  ): Promise<void> {
    if (!this.currentUserId) return

    const usersNeedingSession = megolmService.getUsersNeedingSession(roomId, recipientIds, sessionId)

    if (usersNeedingSession.length === 0) {
      return // All users already have the session
    }

    const sessionData = megolmService.getSessionKeyForSharing(roomId, sessionId)
    if (!sessionData || sessionData.sessionId !== sessionId) {
      debug.error('Refusing to share mismatched session key')
      return
    }

    // BATCH: Fetch ALL public keys in ONE query
    const { data: publicKeys, error: keyError } = await supabase
      .from('user_key_pairs')
      .select('user_id, identity_public_key')
      .in('user_id', usersNeedingSession)
      .eq('is_active', true)

    if (keyError) {
      debug.error('Error fetching public keys:', keyError)
      return
    }

    const keyMap = new Map<string, string>()
    for (const row of publicKeys || []) {
      if (row.identity_public_key) {
        keyMap.set(row.user_id, row.identity_public_key)
      }
    }

    const usersWithKeys = keyMap.size
    const usersWithoutKeys = usersNeedingSession.length - usersWithKeys

    if (usersWithKeys === 0) {
      if (usersWithoutKeys > 0) {
        debug.log(`ℹ${usersWithoutKeys} users haven't set up encryption yet`)
      }
      return
    }

    debug.log(`Sharing session with ${usersWithKeys} users...`)

    // PARALLEL: encrypt the session key for every recipient (cheap, CPU-bound).
    // The N ECDH wraps are unavoidable for group E2EE - each recipient gets the
    // key sealed to their own identity key so the server can never read it.
    const encryptResults = await Promise.all(
      Array.from(keyMap.entries()).map(async ([userId, publicKey]) => {
        try {
          const encryptedSessionKey = await this.encryptSessionKeyForUser(
            sessionData.sessionKey,
            publicKey,
            {
              roomId,
              sessionId,
              recipientUserId: userId,
            },
          )
          return { userId, encryptedSessionKey }
        } catch (error) {
          debug.error(`Failed to encrypt session share for ${userId.substring(0, 8)}:`, error)
          return null
        }
      })
    )

    const rows = encryptResults
      .filter((r): r is { userId: string; encryptedSessionKey: string } => r !== null)
      .map(({ userId, encryptedSessionKey }) => ({
        room_id: roomId,
        session_id: sessionId,
        sender_user_id: this.currentUserId!,
        recipient_user_id: userId,
        encrypted_session_key: encryptedSessionKey,
        first_known_index: 0,
        // Re-sharing must re-arm the claim: a stale is_claimed=true from a
        // previous install would hide the fresh key from
        // get_unclaimed_session_shares() forever.
        is_claimed: false,
        claimed_at: null as string | null,
      }))

    if (rows.length === 0) {
      debug.error('No session shares could be encrypted')
      return
    }

    // BATCH: write ALL shares in ONE upsert. Previously this fanned out to one
    // HTTP request per recipient (1000 recipients -> 1000 round-trips); a single
    // array upsert collapses that to one request.
    const { error: shareError } = await supabase
      .from('megolm_session_shares')
      .upsert(rows, { onConflict: 'room_id,session_id,recipient_user_id' })

    if (shareError) {
      debug.error('Failed to store session shares (batch):', shareError)
      return
    }

    // Only mark as shared once the write succeeded, so a failed batch is retried.
    for (const { recipient_user_id } of rows) {
      megolmService.markSessionSharedWith(roomId, recipient_user_id, sessionId)
    }
    debug.log(`Session shared with ${rows.length}/${usersWithKeys} users`)
  }

  /**
   * Durably repair the offline share path for ONE recipient of ONE session.
   *
   * Called after a realtime key request is fulfilled. The realtime fulfillment
   * only rescues the requesting device right now; this writes a fresh
   * megolm_session_shares row sealed to the recipient's CURRENT identity key,
   * so their other devices (and any future claim) recover the session from the
   * DB without us being online again. This closes the gap where a recipient
   * who reset their keys was permanently stuck on the online-only key-request
   * fallback: the old share row is sealed to their dead key, and `sharedWith`
   * bookkeeping stops ensureSessionShared from ever re-sharing.
   *
   * Security: identical sealing to the normal share path - ECDH(our identity
   * private, recipient identity public) -> AES-GCM with AAD binding
   * (room, session, sender, recipient), so the server never sees the key and
   * the row can't be replayed into another context. Callers MUST have already
   * authorized the recipient (signature + server-side room membership - see
   * isKeyRequestAuthorized); this method does not re-check.
   *
   * Best-effort by design: when we're a relay (not the original sender), RLS
   * lets us INSERT a new share but not overwrite the original sender's
   * existing row - the upsert fails and we return false, which is fine
   * because the realtime fulfillment already delivered the key.
   */
  async repairSessionShareForUser(
    roomId: string,
    sessionId: string,
    recipientUserId: string,
    sessionKey: string,
    firstKnownIndex = 0,
  ): Promise<boolean> {
    if (!this.currentUserId) return false

    try {
      // Deliberately uncached fetch of the recipient's CURRENT active key:
      // repair exists precisely because the recipient may have rotated keys,
      // so a stale cached key would re-create the broken state.
      const { data, error } = await supabase
        .from('user_key_pairs')
        .select('identity_public_key')
        .eq('user_id', recipientUserId)
        .eq('is_active', true)
        .maybeSingle()

      if (error || !data?.identity_public_key) {
        debug.log(`ℹShare repair skipped - no active identity key for ${recipientUserId.substring(0, 8)}`)
        return false
      }

      const encryptedSessionKey = await this.encryptSessionKeyForUser(
        sessionKey,
        data.identity_public_key,
        { roomId, sessionId, recipientUserId },
      )

      const { error: upsertError } = await supabase
        .from('megolm_session_shares')
        .upsert({
          room_id: roomId,
          session_id: sessionId,
          sender_user_id: this.currentUserId,
          recipient_user_id: recipientUserId,
          encrypted_session_key: encryptedSessionKey,
          first_known_index: firstKnownIndex,
          // Re-arm the claim so get_unclaimed_session_shares() surfaces it.
          is_claimed: false,
          claimed_at: null as string | null,
        }, { onConflict: 'room_id,session_id,recipient_user_id' })

      if (upsertError) {
        debug.log(`ℹShare repair upsert rejected (relay case or RLS) - non-fatal:`, upsertError.message)
        return false
      }

      await megolmService.markSessionSharedWith(roomId, recipientUserId, sessionId)
      debug.log(`Repaired session share for ${recipientUserId.substring(0, 8)} (session ${sessionId.substring(0, 8)})`)
      return true
    } catch (err) {
      debug.warn('Session share repair failed (non-fatal):', err)
      return false
    }
  }

  /**
   * Get the current user's identity private key from IndexedDB.
   */
  private async getMyPrivateKey(): Promise<CryptoKey> {
    if (!this.currentUserId) throw new Error('Not initialized')

    const key = await identityKeyStore.load(this.currentUserId)
    if (key) return key

    throw new Error('Identity private key not found in IndexedDB - run encryption setup')
  }

  /**
   * Import a base64-encoded ECDH public key as a CryptoKey.
   */
  private async importPublicKey(publicKeyBase64: string): Promise<CryptoKey> {
    let publicKeyBytes: Uint8Array
    try {
      publicKeyBytes = Uint8Array.from(atob(publicKeyBase64), c => c.charCodeAt(0))
    } catch {
      throw new Error('Invalid base64 public key data')
    }
    return crypto.subtle.importKey(
      'raw', publicKeyBytes,
      { name: 'ECDH', namedCurve: 'P-256' }, false, []
    )
  }

  /**
   * Derive a shared AES-GCM key from ECDH key agreement.
   */
  private async deriveSharedKey(
    privateKey: CryptoKey,
    publicKey: CryptoKey,
    usage: KeyUsage[]
  ): Promise<CryptoKey> {
    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: publicKey },
      privateKey,
      256
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
   * Encrypt session key for a recipient using ECDH key agreement (P-256 + HKDF + AES-GCM).
   * When share metadata is supplied, output is prefixed with 'v3:' and binds the
   * ciphertext to (room, session, sender, recipient). Legacy 'v2:' shares omit AAD.
   */
  private async encryptSessionKeyForUser(
    sessionKey: string,
    recipientPublicKey: string,
    shareMeta?: {
      roomId: string
      sessionId: string
      recipientUserId: string
    },
  ): Promise<string> {
    const myPrivateKey = await this.getMyPrivateKey()
    const recipientKey = await this.importPublicKey(recipientPublicKey)
    const aesKey = await this.deriveSharedKey(myPrivateKey, recipientKey, ['encrypt'])

    const encoder = new TextEncoder()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const gcmParams: AesGcmParams = { name: 'AES-GCM', iv }
    if (shareMeta && this.currentUserId) {
      gcmParams.additionalData = this.buildSessionShareAad({
        roomId: shareMeta.roomId,
        sessionId: shareMeta.sessionId,
        senderUserId: this.currentUserId,
        recipientUserId: shareMeta.recipientUserId,
      })
    }

    const encrypted = await crypto.subtle.encrypt(
      gcmParams,
      aesKey,
      encoder.encode(sessionKey),
    )

    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)

    const prefix = shareMeta ? 'v3:' : 'v2:'
    return prefix + btoa(String.fromCharCode(...combined))
  }

  private buildSessionShareAad(fields: {
    roomId: string
    sessionId: string
    senderUserId: string
    recipientUserId: string
  }): Uint8Array {
    const ordered: Record<string, string> = {
      recipient_user_id: fields.recipientUserId,
      room_id: fields.roomId,
      sender_user_id: fields.senderUserId,
      session_id: fields.sessionId,
      version: 'v2',
    }
    const sortedKeys = Object.keys(ordered).sort()
    const sorted: Record<string, string> = {}
    for (const k of sortedKeys) sorted[k] = ordered[k]
    return new TextEncoder().encode(JSON.stringify(sorted))
  }

  /**
   * Decrypt private key from database storage using recovery-derived encryption key.
   */
  private async decryptPrivateKeyFromStorage(encryptedData: string): Promise<string> {
    const encryptionKey = recoveryKeyService.getEncryptionKey()
    if (!encryptionKey) {
      throw new Error('Recovery key not available - cannot decrypt identity key from DB')
    }

    let combined: Uint8Array
    try {
      combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0))
    } catch {
      throw new Error('Invalid base64 encrypted key data')
    }
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      ciphertext
    )
    return new TextDecoder().decode(decrypted)
  }

  /**
   * Encrypt private key for database storage.
   * Uses the recovery key derived encryption key.
   */
  private async encryptPrivateKeyForStorage(privateKeyBase64: string): Promise<string> {
    const encryptionKey = recoveryKeyService.getEncryptionKey()

    if (!encryptionKey) {
      throw new Error('Recovery key not available - cannot encrypt identity key for storage')
    }

    const encoder = new TextEncoder()
    const iv = crypto.getRandomValues(new Uint8Array(12))

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      encoder.encode(privateKeyBase64)
    )

    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)

    return btoa(String.fromCharCode(...combined))
  }

  /**
   * Claim pending session shares (from other users)
   * OPTIMIZED: Single RPC call + batch public-key fetch + parallel processing
   */
  // Concurrent claim sweeps share one RPC: several missing sessions in one
  // page decrypt each trigger recovery, and each recovery starts with a
  // claim - without dedup that's N identical get_unclaimed_session_shares
  // calls racing each other.
  private claimSharesInFlight: Promise<number> | null = null

  async claimPendingSessionShares(): Promise<number> {
    if (!this.currentUserId) return 0
    if (this.claimSharesInFlight) return this.claimSharesInFlight

    const promise = this._claimPendingSessionShares()
    this.claimSharesInFlight = promise
    void promise.finally(() => {
      if (this.claimSharesInFlight === promise) this.claimSharesInFlight = null
    })
    return promise
  }

  private async _claimPendingSessionShares(): Promise<number> {
    if (!this.currentUserId) return 0

    const { data: shares, error } = await supabase
      .rpc('get_unclaimed_session_shares', { p_user_id: this.currentUserId })

    if (error || !shares || shares.length === 0) {
      return 0
    }

    debug.log(`Found ${shares.length} unclaimed session shares`)

    // Batch-fetch sender public keys for ECDH decryption
    const senderIds = [...new Set(shares.map((s: any) => s.sender_user_id))]
    const { data: senderKeys, error: senderKeysError } = await supabase
      .from('user_key_pairs')
      .select('user_id, identity_public_key')
      .in('user_id', senderIds)
      .eq('is_active', true)

    if (senderKeysError) {
      debug.warn('Failed to fetch sender public keys for session shares:', senderKeysError)
      return 0
    }

    const senderKeyMap = new Map<string, string>()
    for (const k of senderKeys || []) {
      if (k.identity_public_key) senderKeyMap.set(k.user_id, k.identity_public_key)
    }

    const results = await Promise.all(shares.map(async (share: any) => {
      try {
        const senderPublicKey = senderKeyMap.get(share.sender_user_id)
        if (!senderPublicKey) {
          debug.warn(`No public key for sender ${share.sender_user_id.substring(0, 8)}, skipping share`)
          return false
        }
        const sessionKey = await this.decryptSessionKeyFromSender(
          share.encrypted_session_key,
          senderPublicKey,
          {
            roomId: share.room_id,
            sessionId: share.session_id,
            senderUserId: share.sender_user_id,
            recipientUserId: this.currentUserId!,
          },
        )

        await megolmService.importInboundSession(
          share.room_id,
          share.sender_user_id,
          share.session_id,
          sessionKey,
          share.first_known_index
        )

        supabase.rpc('claim_session_share', {
          p_share_id: share.share_id,
          p_user_id: this.currentUserId
        }).then(() => {}, () => {})

        return true
      } catch {
        return false
      }
    }))

    const claimedCount = results.filter(Boolean).length
    if (claimedCount > 0) {
      debug.log(`Claimed ${claimedCount} session shares`)
    }
    return claimedCount
  }

  /**
   * Decrypt a session key using ECDH with the sender's public key.
   * v3 shares require matching share metadata for AES-GCM AAD verification.
   */
  private async decryptSessionKeyFromSender(
    encryptedSessionKey: string,
    senderPublicKey: string,
    shareMeta?: {
      roomId: string
      sessionId: string
      senderUserId: string
      recipientUserId: string
    },
  ): Promise<string> {
    let payload: string
    let useAad = false
    if (encryptedSessionKey.startsWith('v3:')) {
      payload = encryptedSessionKey.slice(3)
      useAad = true
    } else if (encryptedSessionKey.startsWith('v2:')) {
      payload = encryptedSessionKey.slice(3)
    } else {
      payload = encryptedSessionKey
    }

    const myPrivateKey = await this.getMyPrivateKey()
    const senderKey = await this.importPublicKey(senderPublicKey)
    const aesKey = await this.deriveSharedKey(myPrivateKey, senderKey, ['decrypt'])

    let combined: Uint8Array
    try {
      combined = Uint8Array.from(atob(payload), c => c.charCodeAt(0))
    } catch {
      throw new Error('Invalid base64 encrypted session key')
    }
    const iv = combined.slice(0, 12)
    const ciphertext = combined.slice(12)

    const gcmParams: AesGcmParams = { name: 'AES-GCM', iv }
    if (useAad) {
      if (!shareMeta) {
        throw new Error('v3 session share requires metadata for AAD verification')
      }
      gcmParams.additionalData = this.buildSessionShareAad(shareMeta)
    }

    const decrypted = await crypto.subtle.decrypt(
      gcmParams, aesKey, ciphertext,
    )
    return new TextDecoder().decode(decrypted)
  }

  /**
   * Get encryption status
   */
  async getEncryptionStatus(): Promise<MegolmEncryptionStatus> {
    if (!this.currentUserId) {
      return {
        enabled: false,
        hasRecoveryKey: false,
        hasBackup: false,
        needsSetup: true,
        mode: 'optional'
      }
    }

    // Check if user has recovery key set up (use maybeSingle to avoid error on 0 rows)
    const { data: recoveryMetadata } = await supabase
      .from('recovery_key_metadata')
      .select('id, has_server_backup')
      .eq('user_id', this.currentUserId)
      .maybeSingle()

    const hasRecoveryKey = !!recoveryMetadata
    const hasBackup = recoveryMetadata?.has_server_backup || false

    return {
      enabled: megolmService.isInitialized(),
      hasRecoveryKey,
      hasBackup,
      needsSetup: !hasRecoveryKey,
      mode: 'optional' // TODO: Check server/conversation settings
    }
  }

  /**
   * Check if encryption is unlocked (user has entered recovery key this session)
   * Note: No logging here as this is called frequently during message loading/rendering
   */
  isUnlocked(): boolean {
    return megolmService.isInitialized()
  }

  /**
   * Structured self-test of the whole encryption stack, for the settings UI.
   * ok: true = pass, false = fail, null = not applicable / unknown.
   */
  async runDiagnostics(): Promise<Array<{ label: string; ok: boolean | null; detail: string }>> {
    const results: Array<{ label: string; ok: boolean | null; detail: string }> = []
    const add = (label: string, ok: boolean | null, detail: string) => results.push({ label, ok, detail })

    add('Encryption unlocked', this.isUnlocked(), this.isUnlocked() ? 'Keys are loaded in this session' : 'Enter your recovery phrase to unlock')

    if (!this.currentUserId) {
      add('Profile', false, 'Encryption service has no resolved profile id')
      return results
    }

    // Identity pairing: local private key must match the published public key.
    try {
      const { data } = await supabase.rpc('get_my_key_pair')
      const row = (Array.isArray(data) ? data[0] : null) as { identity_public_key?: string; identity_signing_public_key?: string } | null
      if (!row?.identity_public_key) {
        add('Identity key', false, 'No published identity key - run encryption setup')
      } else {
        const localPrivate = await identityKeyStore.load(this.currentUserId)
        const localPublic = await identityKeyStore.loadPublicKey(this.currentUserId)
        if (!localPrivate) {
          add('Identity key', false, 'Published key exists but no local private key - unlock with your recovery phrase')
        } else if (localPublic && localPublic === row.identity_public_key) {
          add('Identity key', true, 'Local private key matches the published public key')
        } else {
          add('Identity key', localPublic ? false : null, localPublic
            ? 'Local key does NOT match the published key - re-unlock to repair'
            : 'Pairing unverified (legacy record) - re-unlock to verify')
        }
      }
      add('Signing key', !!row?.identity_signing_public_key, row?.identity_signing_public_key
        ? 'Message signing key published'
        : 'No signing key - minted automatically on next unlock')
    } catch (e: any) {
      add('Identity key', false, `Lookup failed: ${e?.message || e}`)
    }

    // Backup: exists + decryptable with the CURRENT phrase-derived key.
    try {
      const { data: backupRow } = await supabase
        .from('megolm_key_backups')
        .select('encrypted_data, session_count, last_updated')
        .eq('user_id', this.currentUserId)
        .maybeSingle()
      if (!backupRow) {
        add('Key backup', null, 'No server backup yet - created automatically as you use encryption')
      } else if (!recoveryKeyService.isLoaded()) {
        add('Key backup', null, `Backup exists (${backupRow.session_count} sessions) - unlock to verify it`)
      } else {
        try {
          const json = await recoveryKeyService.decryptFromBackup(backupRow.encrypted_data)
          const parsed = JSON.parse(json)
          const count = (parsed?.sessions?.outbound?.length || 0) + (parsed?.sessions?.inbound?.length || 0)
          add('Key backup', true, `Backup decrypts with your current phrase (${count} sessions)`)
        } catch {
          add('Key backup', false, 'Backup exists but does NOT decrypt with your current recovery phrase (created under an older phrase)')
        }
      }
    } catch (e: any) {
      add('Key backup', false, `Backup check failed: ${e?.message || e}`)
    }

    // Device trust
    try {
      const device = await deviceIdentityService.getMyDeviceRow(this.currentUserId)
      if (!device) add('Device trust', null, 'This device is not registered yet')
      else if (device.revoked_at) add('Device trust', false, 'This device was revoked')
      else add('Device trust', ['verified', 'recovery'].includes(device.trust_state), `Trust level: ${device.trust_state}`)
    } catch { add('Device trust', null, 'Could not read device state') }

    return results
  }

  async hasRecoveryKey(): Promise<boolean> {
    if (!this.currentUserId) {
      debug.log('hasRecoveryKey: No user ID')
      return false
    }

    // Use maybeSingle() to avoid error when no rows exist
    const { data, error } = await supabase
      .from('recovery_key_metadata')
      .select('id')
      .eq('user_id', this.currentUserId)
      .maybeSingle()

    if (error) {
      debug.warn('hasRecoveryKey check failed:', error)
      return false
    }

    const hasKey = !!data
    debug.log(`hasRecoveryKey: ${hasKey}`)
    return hasKey
  }

  async backupSessions(): Promise<void> {
    await megolmKeyBackupService.createBackup()
  }

  getCurrentUserId(): string | null {
    return this.currentUserId
  }

  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Timestamp (ms) the current encryption identity was created, a.k.a. the
   * "identity epoch". Messages encrypted before this point were sealed to a
   * previous identity whose private key no longer exists, so a missing session
   * key for them is *permanent*, not a transient "ask the sender" situation.
   * The UI uses this to distinguish unrecoverable messages from retryable ones.
   * Cached; cleared on reset/cleanup.
   */
  async getIdentityCreatedAt(): Promise<number | null> {
    if (this.identityCreatedAtMs !== null) return this.identityCreatedAtMs
    // Dedup concurrent callers: every page decrypt asks for the identity
    // epoch, and several pages can be in flight during boot - without this
    // each fired its own get_my_key_pair RPC before the first cached.
    if (this.identityCreatedAtFetch) return this.identityCreatedAtFetch
    this.identityCreatedAtFetch = this._getIdentityCreatedAt()
    try {
      return await this.identityCreatedAtFetch
    } finally {
      this.identityCreatedAtFetch = null
    }
  }

  private identityCreatedAtFetch: Promise<number | null> | null = null

  private async _getIdentityCreatedAt(): Promise<number | null> {
    try {
      const { data } = await supabase.rpc('get_my_key_pair')
      const row = (Array.isArray(data) ? data[0] : null) as { created_at?: string } | null
      if (row?.created_at) {
        this.identityCreatedAtMs = new Date(row.created_at).getTime()
        return this.identityCreatedAtMs
      }
    } catch {
      /* best-effort; treat as unknown */
    }
    return null
  }

  /**
   * Reset encryption (delete all data)
   */
  async resetEncryption(): Promise<void> {
    if (!this.currentUserId) return

    // Clear stored keys (identity + signing + session). Signing was previously
    // left behind, which could leave a stale cached signing key after reset.
    await secureSessionKeyStore.clear(this.currentUserId).catch(() => {})
    await identityKeyStore.clear(this.currentUserId).catch(() => {})
    await signingKeyStore.clear(this.currentUserId).catch(() => {})
    this.signingKeyCache.clear()
    this.backedUpSessionIds.clear()
    this.identityCreatedAtMs = null
    this.clearLegacyStorage()

    await megolmKeyBackupService.deleteBackup().catch(() => {})

    // Wipe ALL server-side identity in one atomic, RLS-bypassing call. This is
    // the critical fix: the old piecemeal deletes never removed the
    // user_key_pairs row (no DELETE policy exists), so a later setup tripped
    // over the stale row and failed to unlock. The RPC removes the key pair
    // plus dependent state for the caller only.
    const { error: resetError } = await supabase.rpc('reset_my_encryption_identity')
    if (resetError) {
      // Fall back to best-effort direct deletes (works for tables that do have
      // self-delete policies) so older deploys without the RPC still clear what
      // they can. user_key_pairs itself will remain until the migration is run.
      debug.warn('reset_my_encryption_identity RPC unavailable, falling back:', resetError)
      await supabase.from('recovery_key_metadata').delete().eq('user_id', this.currentUserId)
      await supabase
        .from('megolm_session_shares')
        .delete()
        .or(`sender_user_id.eq.${this.currentUserId},recipient_user_id.eq.${this.currentUserId}`)
    }

    megolmService.close()

    recoveryKeyService.clear()

    debug.log('Encryption reset complete')
  }

  /**
   * Cleanup on logout
   */
  async cleanup(): Promise<void> {
    if (this.currentUserId) {
      await secureSessionKeyStore.clear(this.currentUserId).catch(() => {})
      await identityKeyStore.clear(this.currentUserId).catch(() => {})
      await signingKeyStore.clear(this.currentUserId).catch(() => {})
      this.clearLegacyStorage()
    }
    megolmService.close()
    recoveryKeyService.clear()
    this.signingKeyCache.clear()
    this.backedUpSessionIds.clear()
    this.identityCreatedAtMs = null
    this.currentUserId = null
    this.initialized = false
  }
}

export const megolmMessageEncryptionService = MegolmMessageEncryptionService.getInstance()

