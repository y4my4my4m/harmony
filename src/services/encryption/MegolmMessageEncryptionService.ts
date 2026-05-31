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

/**
 * v1 deprecation cutoff. Honest clients stopped emitting unsigned `megolm_v1`
 * on the send path (see encryptMessage). Any `megolm_v1` message whose
 * timestamp is at/after this instant therefore did NOT come from a current
 * client and is treated as suspicious (still decrypted so users can read, but
 * never reported as sender-verified and logged loudly). Messages before the
 * cutoff are legitimate legacy history and decrypt quietly.
 *
 * 2026-05-29T00:00:00Z - the day v1 send was removed.
 */
const MEGOLM_V1_DEPRECATION_CUTOFF_MS = Date.UTC(2026, 4, 29)

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
  private signingKeyCache = new Map<string, CachedSigningKey>()
  private static readonly SIGNING_KEY_CACHE_TTL_MS = 5 * 60_000

  private constructor() {}

  static getInstance(): MegolmMessageEncryptionService {
    if (!MegolmMessageEncryptionService.instance) {
      MegolmMessageEncryptionService.instance = new MegolmMessageEncryptionService()
    }
    return MegolmMessageEncryptionService.instance
  }

  // =====================================================
  // INITIALIZATION
  // =====================================================

  /**
   * Initialize the service for a user
   */
  async initialize(authUserId: string): Promise<void> {
    // Get profile ID from database
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .eq('auth_user_id', authUserId)
        .single()
      
      if (profile?.id) {
        this.currentUserId = profile.id
        debug.log(`🔐 MegolmMessageEncryptionService: Using profile ID ${this.currentUserId}`)
      } else {
        this.currentUserId = authUserId
        debug.warn(`⚠️ No profile found for auth user ${authUserId}`)
      }
    } catch (error) {
      debug.warn('⚠️ Failed to get profile ID:', error)
      this.currentUserId = authUserId
    }

    // Initialize backup service (includes realtime key request subscriptions)
    if (this.currentUserId) {
      await megolmKeyBackupService.initialize(this.currentUserId)
      
      // Register callback for when keys are received via realtime
      megolmKeyBackupService.onKeyReceived((roomId, sessionId) => {
        debug.log(`🔑 Key received for room ${roomId.substring(0, 8)}..., session ${sessionId.substring(0, 8)}...`)
        // Emit event for UI to retry decryption
        window.dispatchEvent(new CustomEvent('megolm-key-received', { 
          detail: { roomId, sessionId } 
        }))
      })
    }

    this.initialized = true
    debug.log('✅ MegolmMessageEncryptionService initialized')

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
        debug.log('🔐 Found stored CryptoKeys in IndexedDB - auto-unlocking...')

        // Set derived keys directly (no mnemonic needed)
        recoveryKeyService.setDerivedKeys(storedKeys)

        // Initialize Megolm service with the encryption key
        await megolmService.initialize(this.currentUserId, storedKeys.encryptionKey)
        await this.ensureIdentityKeyPair()
        // Ensure the per-user signing key exists. Legacy users (created
        // before the signing-key migration) get one minted lazily here so
        // their next message is fully signed.
        await this.ensureSigningKeyPair().catch(err =>
          debug.warn('⚠️ Failed to ensure signing key on auto-unlock:', err),
        )
        // Register this device (per-device signing identity, trust state).
        await deviceIdentityService.ensureRegistered(this.currentUserId).catch(err =>
          debug.warn('⚠️ Failed to register device on auto-unlock:', err),
        )

        try {
          const result = await megolmKeyBackupService.restoreFromBackup()
          if (result.outboundCount + result.inboundCount > 0) {
            debug.log(`📥 Restored ${result.outboundCount + result.inboundCount} sessions from backup`)
          }
        } catch { /* ignore */ }

        try {
          await megolmKeyBackupService.processPendingRequestsToMe()
        } catch { /* ignore */ }

        debug.log('✅ Auto-unlocked encryption from IndexedDB keys')
        return true
      }

      // No stored keys - encryption is locked
      this.clearLegacyStorage()
      debug.log('🔐 No stored session - encryption locked')
      return false
    } catch (error) {
      debug.warn('⚠️ Failed to auto-unlock:', error)
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
    debug.log('🔒 Encryption locked')
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

    // Initialize Megolm service with encryption key
    await megolmService.initialize(this.currentUserId, derivedKeys.encryptionKey)

    // Ensure identity key pair (ECDH) and signing key pair (ECDSA) both exist
    await this.ensureIdentityKeyPair()
    await this.ensureSigningKeyPair()
    // Recovery-key unlock implies L2 (history-unlock capable) trust for this device.
    await deviceIdentityService.ensureRegistered(this.currentUserId, 'recovery').catch(err =>
      debug.warn('⚠️ Failed to register device after recovery unlock:', err),
    )

    // Try to restore from backup
    try {
      const result = await megolmKeyBackupService.restoreFromBackup()
      debug.log(`📥 Restored ${result.outboundCount + result.inboundCount} sessions from backup`)
    } catch (error) {
      debug.log('ℹ️ No backup to restore or restore failed:', error)
    }

    // Claim any pending session shares
    try {
      const claimedCount = await this.claimPendingSessionShares()
      if (claimedCount > 0) {
        debug.log(`📥 Claimed ${claimedCount} pending session shares`)
      }
    } catch (error) {
      debug.warn('⚠️ Failed to claim pending session shares:', error)
    }

    // Process any pending key requests to us (from while we were offline)
    try {
      const fulfilledCount = await megolmKeyBackupService.processPendingRequestsToMe()
      if (fulfilledCount > 0) {
        debug.log(`📤 Fulfilled ${fulfilledCount} pending key requests`)
      }
    } catch (error) {
      debug.warn('⚠️ Failed to process pending key requests:', error)
    }

    // Store non-extractable CryptoKeys in IndexedDB (mnemonic is NOT persisted)
    await this.storeSessionKeys(derivedKeys)
    this.clearLegacyStorage()

    // Now that keys are unlocked and shares/backups are restored, tell the UI
    // to re-decrypt anything already on screen. Without this, messages that
    // rendered as glyphs while locked stay as glyphs until a manual reload.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('megolm-key-received', { detail: { roomId: '*', sessionId: '*' } }))
    }

    debug.log('✅ Encryption initialized with recovery key')
  }

  /**
   * Setup new encryption with a fresh recovery key
   * Returns the generated recovery words
   */
  async setupNewEncryption(): Promise<string[]> {
    if (!this.currentUserId) {
      throw new Error('Not initialized')
    }

    // Generate new recovery mnemonic (real BIP39 SHA-256 checksum)
    const words = await recoveryKeyService.generateMnemonic(12)
    
    // Complete setup with the generated words
    await this.completeSetupWithWords(words)

    debug.log('✅ New encryption setup complete')
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

    debug.log('🔐 Completing encryption setup...')

    // Derive keys from mnemonic
    const derivedKeys = await recoveryKeyService.deriveKeysFromMnemonic(words)

    // Initialize Megolm service
    await megolmService.initialize(this.currentUserId, derivedKeys.encryptionKey)
    debug.log('✅ Megolm service initialized')

    // Generate identity key pair for session key exchange. forceNew: this is a
    // fresh setup, so replace any stale row rather than trying (and failing) to
    // restore an old identity wrapped under a different recovery key.
    await this.ensureIdentityKeyPair(true)
    debug.log('✅ Identity key pair ready')

    // Generate signing key pair for per-message sender binding
    await this.ensureSigningKeyPair()
    debug.log('✅ Signing key pair ready')

    // Register this device. Completing setup means the recovery phrase exists
    // on this device -> L2 (history-unlock capable).
    await deviceIdentityService.ensureRegistered(this.currentUserId, 'recovery').catch(err =>
      debug.warn('⚠️ Failed to register device during setup:', err),
    )

    // Initialize backup service
    await megolmKeyBackupService.initialize(this.currentUserId)

    // Generate verification code
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
    debug.log('✅ Recovery key metadata registered')

    // Create initial backup
    try {
      await megolmKeyBackupService.createBackup()
      debug.log('✅ Initial backup created')
    } catch (backupError) {
      debug.warn('⚠️ Failed to create initial backup:', backupError)
    }

    // Store non-extractable CryptoKeys in IndexedDB (mnemonic is NOT persisted)
    await this.storeSessionKeys(derivedKeys)
    this.clearLegacyStorage()

    debug.log('🔐 Encryption setup complete!')
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
      if (cachedKey) return

      // Key pair in DB but not in IndexedDB - decrypt from DB using recovery key.
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
          debug.error('❌ Failed to decrypt stored identity key:', e)
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
        await identityKeyStore.store(this.currentUserId, privateKey)
        debug.log('✅ Restored identity key from DB to IndexedDB')
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

    // Generate a new ECDH key pair
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
      debug.error('❌ Failed to store identity key:', writeError)
      throw new Error('Failed to create identity key pair')
    }

    // Store non-extractable CryptoKey in IndexedDB
    const nonExtractablePrivateKey = await crypto.subtle.importKey(
      'pkcs8', privateKeyRaw,
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']
    )
    await identityKeyStore.store(this.currentUserId, nonExtractablePrivateKey)

    debug.log('✅ Identity key pair created')
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
    const { data: keyPairRows } = await supabase.rpc('get_my_key_pair')
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
        debug.log('✅ Restored signing key from DB to IndexedDB')
      } catch (err) {
        debug.warn('⚠️ Failed to restore signing key from DB:', err)
      }
      return
    }

    // Need to generate a new keypair. Requires the recovery encryption key
    // (to wrap the private for storage), which is only available when
    // encryption is unlocked.
    if (!recoveryKeyService.getEncryptionKey()) {
      debug.log('ℹ️ Signing key generation deferred - recovery encryption key not available')
      return
    }

    const keyPair = await generateSigningKeyPair()
    const publicSpkiB64 = await exportPublicSigningKey(keyPair.publicKey)
    const privatePkcs8B64 = await exportPrivateSigningKey(keyPair.privateKey)
    const encryptedPrivate = await this.encryptPrivateKeyForStorage(privatePkcs8B64)

    if (existingRow?.id) {
      // Add the signing keypair to the existing row (preserves ECDH key).
      const { error } = await supabase
        .from('user_key_pairs')
        .update({
          identity_signing_public_key: publicSpkiB64,
          identity_signing_private_key_encrypted: encryptedPrivate,
        })
        .eq('id', existingRow.id)
      if (error) {
        debug.error('❌ Failed to attach signing key to existing row:', error)
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
        debug.error('❌ Failed to insert signing-only row:', error)
        throw new Error('Failed to persist signing key')
      }
    }

    // Cache a non-extractable copy for fast signing.
    const nonExtractable = await importPrivateSigningKey(privatePkcs8B64, false)
    await signingKeyStore.store(this.currentUserId, nonExtractable)

    debug.log('✅ Signing key pair created and published')
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
  private async getSenderSigningPublicKey(senderUserId: string): Promise<CachedSigningKey | null> {
    const cached = this.signingKeyCache.get(senderUserId)
    if (cached && Date.now() - cached.cachedAt < MegolmMessageEncryptionService.SIGNING_KEY_CACHE_TTL_MS) {
      return cached
    }

    const { data, error } = await supabase
      .from('user_key_pairs')
      .select('identity_signing_public_key')
      .eq('user_id', senderUserId)
      .eq('is_active', true)
      .maybeSingle()

    if (error) {
      debug.warn(`⚠️ Failed to fetch signing key for ${senderUserId.substring(0, 8)}:`, error)
      return null
    }
    const spki = data?.identity_signing_public_key as string | undefined
    if (!spki) return null

    try {
      const publicKey = await importPublicSigningKey(spki)
      const fingerprint = await this.signingKeyFingerprint(spki)
      const entry: CachedSigningKey = { publicKey, fingerprint, cachedAt: Date.now() }
      this.signingKeyCache.set(senderUserId, entry)
      // TOFU: pin on first sight, gently notify (non-blocking) on change.
      // Fire-and-forget so verification stays fast.
      this.checkAndPinSigningKey(senderUserId, fingerprint).catch(() => {})
      return entry
    } catch (err) {
      debug.warn(`⚠️ Failed to import signing key for ${senderUserId.substring(0, 8)}:`, err)
      return null
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

  // =====================================================
  // ENCRYPTION / DECRYPTION
  // =====================================================

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
    const deviceSigningKey = await deviceIdentityService.getMyDeviceSigningKey().catch(() => null)

    // Determine if we need to share the session before sending. Cheap
    // in-memory check; falls through to "no work" when the room is steady.
    const usersNeedingSession = megolmService.getUsersNeedingSession(roomId, recipientIds)
    const plaintextContent = JSON.stringify(content)

    let encryptedMessage: MegolmEncryptedMessage
    let algorithm: 'megolm_v2_signed' | 'megolm_v3'
    let epochId: number | undefined
    let senderDeviceId: string | undefined
    let signingKey: CryptoKey

    if (deviceSigningKey) {
      algorithm = 'megolm_v3'
      senderDeviceId = deviceIdentityService.getDeviceId()
      epochId = await roomEpochService.getEpoch(roomId)
      const aadFields: AadFieldsV3 = {
        algorithm,
        content_type: contentType,
        epoch_id: epochId,
        room_id: roomId,
        sender_user_id: this.currentUserId,
      }
      const aadBytes = buildAadBytesV3(aadFields)
      encryptedMessage = await megolmService.encryptMessage(roomId, plaintextContent, {
        epoch: epochId,
        additionalData: aadBytes,
      })
      // The session may have rotated to a newer epoch inside encryptMessage.
      epochId = encryptedMessage.epoch ?? epochId
      signingKey = deviceSigningKey
    } else {
      // Legacy v2 path: user-level signing key, lazily enrolled, no AAD/epoch.
      algorithm = 'megolm_v2_signed'
      encryptedMessage = await megolmService.encryptMessage(roomId, plaintextContent)
      let userSigningKey = await this.getMySigningPrivateKey().catch(() => null)
      if (!userSigningKey) {
        debug.warn('⚠️ No signing key on this device - attempting lazy enrollment before send')
        try {
          await this.ensureSigningKeyPair()
        } catch (err) {
          debug.error('❌ Signing key enrollment failed:', err)
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

    if (usersNeedingSession.length > 0) {
      // Block on session sharing so recipients have the key when the message
      // arrives. We still tolerate partial failure (the share helper logs
      // per-recipient errors), but at least the local round-trip is honored.
      try {
        await this.ensureSessionShared(roomId, encryptedMessage.sessionId, recipientIds)
      } catch (err) {
        debug.warn('⚠️ Foreground session sharing failed (continuing):', err)
      }
    } else {
      // Steady state: background-share as a defensive backstop in case the
      // recipient list changed under us (e.g., a new member joined and the
      // in-memory `sharedWith` list is stale).
      this.ensureSessionShared(roomId, encryptedMessage.sessionId, recipientIds)
        .catch(err => debug.warn('⚠️ Background session sharing failed:', err))
    }

    // Store encrypted message in content as base64 text
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
   * For backwards compatibility this method also accepts a 'megolm_v1'
   * algorithm tag (no signature), decrypts normally, and reports
   * `senderVerified: false`.
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

    // Get room ID from message context
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

    if (metadata.algorithm === 'megolm_v2_signed' || metadata.algorithm === 'megolm_v1') {
      // Verification step runs BEFORE decryption:
      //   - It's pointless to spend CPU decrypting a message we'll reject.
      //   - More importantly, it prevents an attacker from using bogus
      //     signed-metadata to push the client into the key-request /
      //     session-share fallback path (network noise + log spam).
      if (metadata.algorithm === 'megolm_v2_signed') {
        const senderVerified = await this.verifyV2Signature(message)
        if (!senderVerified) {
          throw new Error('Sender signature invalid - refusing to display tampered message')
        }
      } else {
        // v1: nothing to verify. Distinguish legitimate legacy history from
        // a post-cutoff v1 (which no honest client emits anymore, so it is
        // suspicious - likely a downgrade attempt or tampered metadata).
        const senderShort = (metadata.sender_user_id || '').substring(0, 8)
        if (typeof metadata.timestamp === 'number' && metadata.timestamp >= MEGOLM_V1_DEPRECATION_CUTOFF_MS) {
          debug.warn(
            `🚨 Suspicious unsigned megolm_v1 message from ${senderShort} dated after the v1 deprecation cutoff - ` +
            `no current client emits v1. Decrypting for readability but flagging UNVERIFIED.`,
          )
        } else {
          debug.warn(
            `⚠️ Unsigned legacy megolm_v1 message from ${senderShort} - sender unverified`,
          )
        }
      }

      const content = await this.decryptMegolmMessage(message, roomId)
      return { content, senderVerified: metadata.algorithm === 'megolm_v2_signed' }
    }

    if (metadata.algorithm === 'signal_protocol_v1_hybrid') {
      // Legacy Signal Protocol message - can't decrypt without old keys
      debug.warn('⚠️ Legacy Signal Protocol message - cannot decrypt')
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
    const {
      session_id: sessionId,
      message_index: messageIndex,
      sender_user_id: senderUserId,
      timestamp,
      signature,
    } = meta
    const roomId = message.channel_id || message.conversation_id || ''

    if (
      !signature ||
      !sessionId ||
      messageIndex === undefined ||
      !senderUserId ||
      !timestamp ||
      !roomId
    ) {
      debug.warn('⚠️ v2 message missing required fields for verification - rejecting')
      return false
    }

    const ciphertext = message.content[0]?.type === 'text' ? message.content[0].text : ''
    if (!ciphertext) return false

    const senderKey = await this.getSenderSigningPublicKey(senderUserId)
    if (!senderKey) {
      debug.warn(`⚠️ No signing key on file for ${senderUserId.substring(0, 8)} - cannot verify`)
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
      epoch_id: typeof meta.epoch_id === 'number' ? meta.epoch_id : 1,
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
    const {
      session_id: sessionId,
      message_index: messageIndex,
      sender_user_id: senderUserId,
      timestamp,
      signature,
      epoch_id: epochId,
      sender_device_id: senderDeviceId,
    } = meta
    const roomId = message.channel_id || message.conversation_id || ''

    if (
      !signature ||
      !sessionId ||
      messageIndex === undefined ||
      !senderUserId ||
      !timestamp ||
      !roomId ||
      typeof epochId !== 'number' ||
      !senderDeviceId
    ) {
      debug.warn('⚠️ v3 message missing required fields for verification - rejecting')
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
      debug.warn('⚠️ Failed to import v3 device signing key:', err)
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

    // Get the encrypted ciphertext
    const ciphertext = message.content[0]?.type === 'text' ? message.content[0].text : ''
    if (!ciphertext) {
      throw new Error('No encrypted content found')
    }

    // Build the encrypted message object
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
      if (error.message.includes('No inbound session') || error.message.includes('No outbound session')) {
        debug.log(`ℹ️ Missing session ${sessionId.substring(0, 8)}... for room ${roomId.substring(0, 8)}..., fetching...`)
        
        // Try to claim pending session shares from server
        const claimed = await this.claimPendingSessionShares()
        
        if (claimed > 0) {
          // Retry decryption after claiming shares
          try {
            const decryptedJson = await megolmService.decryptMessage(roomId, senderId, encryptedMessage, additionalData)
            const decryptedContent: MessagePart[] = JSON.parse(decryptedJson)
            return decryptedContent
          } catch {
            // Still failed - request key from sender
          }
        }
        
        // No shares available - request the key from the sender
        // The sender will receive this via realtime and auto-fulfill if they have the key
        debug.log(`📤 Requesting session key from sender ${senderId.substring(0, 8)}...`)
        megolmKeyBackupService.createKeyRequest(roomId, sessionId, senderId)
          .catch(err => debug.warn('⚠️ Key request failed:', err))
        throw new Error('Session key not available - key request sent to sender')
      }
      throw error
    }
  }


  // =====================================================
  // SESSION SHARING
  // =====================================================

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

    // Get users who need the session (fast in-memory check)
    const usersNeedingSession = megolmService.getUsersNeedingSession(roomId, recipientIds)

    if (usersNeedingSession.length === 0) {
      return // All users already have the session
    }

    // Get session key data
    const sessionData = megolmService.getSessionKeyForSharing(roomId)
    if (!sessionData) {
      debug.error('❌ Failed to get session data for sharing')
      return
    }

    // BATCH: Fetch ALL public keys in ONE query
    const { data: publicKeys, error: keyError } = await supabase
      .from('user_key_pairs')
      .select('user_id, identity_public_key')
      .in('user_id', usersNeedingSession)
      .eq('is_active', true)

    if (keyError) {
      debug.error('❌ Error fetching public keys:', keyError)
      return
    }

    // Create lookup map for fast access
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
        debug.log(`ℹ️ ${usersWithoutKeys} users haven't set up encryption yet`)
      }
      return
    }

    debug.log(`📤 Sharing session with ${usersWithKeys} users...`)

    // PARALLEL: encrypt the session key for every recipient (cheap, CPU-bound).
    // The N ECDH wraps are unavoidable for group E2EE — each recipient gets the
    // key sealed to their own identity key so the server can never read it.
    const encryptResults = await Promise.all(
      Array.from(keyMap.entries()).map(async ([userId, publicKey]) => {
        try {
          const encryptedSessionKey = await this.encryptSessionKeyForUser(
            sessionData.sessionKey,
            publicKey
          )
          return { userId, encryptedSessionKey }
        } catch (error) {
          debug.error(`❌ Failed to encrypt session share for ${userId.substring(0, 8)}:`, error)
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
      }))

    if (rows.length === 0) {
      debug.error('❌ No session shares could be encrypted')
      return
    }

    // BATCH: write ALL shares in ONE upsert. Previously this fanned out to one
    // HTTP request per recipient (1000 recipients -> 1000 round-trips); a single
    // array upsert collapses that to one request.
    const { error: shareError } = await supabase
      .from('megolm_session_shares')
      .upsert(rows, { onConflict: 'room_id,session_id,recipient_user_id' })

    if (shareError) {
      debug.error('❌ Failed to store session shares (batch):', shareError)
      return
    }

    // Only mark as shared once the write succeeded, so a failed batch is retried.
    for (const { recipient_user_id } of rows) {
      megolmService.markSessionSharedWith(roomId, recipient_user_id)
    }
    debug.log(`✅ Session shared with ${rows.length}/${usersWithKeys} users`)
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
   * Output is prefixed with 'v2:' as a format version marker.
   */
  private async encryptSessionKeyForUser(
    sessionKey: string,
    recipientPublicKey: string
  ): Promise<string> {
    const myPrivateKey = await this.getMyPrivateKey()
    const recipientKey = await this.importPublicKey(recipientPublicKey)
    const aesKey = await this.deriveSharedKey(myPrivateKey, recipientKey, ['encrypt'])

    const encoder = new TextEncoder()
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      encoder.encode(sessionKey)
    )

    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv)
    combined.set(new Uint8Array(encrypted), iv.length)

    return 'v2:' + btoa(String.fromCharCode(...combined))
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
  async claimPendingSessionShares(): Promise<number> {
    if (!this.currentUserId) return 0

    const { data: shares, error } = await supabase
      .rpc('get_unclaimed_session_shares', { p_user_id: this.currentUserId })

    if (error || !shares || shares.length === 0) {
      return 0
    }

    debug.log(`📥 Found ${shares.length} unclaimed session shares`)

    // Batch-fetch sender public keys for ECDH decryption
    const senderIds = [...new Set(shares.map((s: any) => s.sender_user_id))]
    const { data: senderKeys } = await supabase
      .from('user_key_pairs')
      .select('user_id, identity_public_key')
      .in('user_id', senderIds)
      .eq('is_active', true)

    const senderKeyMap = new Map<string, string>()
    for (const k of senderKeys || []) {
      if (k.identity_public_key) senderKeyMap.set(k.user_id, k.identity_public_key)
    }

    const results = await Promise.all(shares.map(async (share: any) => {
      try {
        const senderPublicKey = senderKeyMap.get(share.sender_user_id)
        if (!senderPublicKey) {
          debug.warn(`⚠️ No public key for sender ${share.sender_user_id.substring(0, 8)}, skipping share`)
          return false
        }
        const sessionKey = await this.decryptSessionKeyFromSender(
          share.encrypted_session_key,
          senderPublicKey
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
      debug.log(`✅ Claimed ${claimedCount} session shares`)
    }
    return claimedCount
  }

  /**
   * Decrypt a session key using ECDH with the sender's public key.
   */
  private async decryptSessionKeyFromSender(
    encryptedSessionKey: string,
    senderPublicKey: string
  ): Promise<string> {
    const payload = encryptedSessionKey.startsWith('v2:')
      ? encryptedSessionKey.slice(3)
      : encryptedSessionKey

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

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, aesKey, ciphertext
    )
    return new TextDecoder().decode(decrypted)
  }

  // =====================================================
  // STATUS & UTILITIES
  // =====================================================

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
   * Check if user has recovery key set up
   */
  async hasRecoveryKey(): Promise<boolean> {
    if (!this.currentUserId) {
      debug.log('🔐 hasRecoveryKey: No user ID')
      return false
    }

    // Use maybeSingle() to avoid error when no rows exist
    const { data, error } = await supabase
      .from('recovery_key_metadata')
      .select('id')
      .eq('user_id', this.currentUserId)
      .maybeSingle()

    if (error) {
      debug.warn('⚠️ hasRecoveryKey check failed:', error)
      return false
    }

    const hasKey = !!data
    debug.log(`🔐 hasRecoveryKey: ${hasKey}`)
    return hasKey
  }

  /**
   * Trigger backup of current sessions
   */
  async backupSessions(): Promise<void> {
    await megolmKeyBackupService.createBackup()
  }

  /**
   * Get the current user ID
   */
  getCurrentUserId(): string | null {
    return this.currentUserId
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized
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
    this.clearLegacyStorage()

    // Delete the local backup record.
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
      debug.warn('⚠️ reset_my_encryption_identity RPC unavailable, falling back:', resetError)
      await supabase.from('recovery_key_metadata').delete().eq('user_id', this.currentUserId)
      await supabase
        .from('megolm_session_shares')
        .delete()
        .or(`sender_user_id.eq.${this.currentUserId},recipient_user_id.eq.${this.currentUserId}`)
    }

    // Close Megolm service
    megolmService.close()

    // Clear recovery key service
    recoveryKeyService.clear()

    debug.log('✅ Encryption reset complete')
  }

  /**
   * Cleanup on logout
   */
  async cleanup(): Promise<void> {
    if (this.currentUserId) {
      await secureSessionKeyStore.clear(this.currentUserId).catch(() => {})
      await identityKeyStore.clear(this.currentUserId).catch(() => {})
      this.clearLegacyStorage()
    }
    megolmService.close()
    recoveryKeyService.clear()
    this.currentUserId = null
    this.initialized = false
  }
}

// Export singleton
export const megolmMessageEncryptionService = MegolmMessageEncryptionService.getInstance()

