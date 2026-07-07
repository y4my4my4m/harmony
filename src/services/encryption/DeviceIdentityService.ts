/**
 * DeviceIdentityService
 *
 * Per-device encryption identity for the account-friendly, device-aware E2EE
 * model. The product goal (Discord-simple UX) is that this is INVISIBLE most of
 * the time: a device registers itself silently on unlock, and users only ever
 * see "approve this login" and "unlock message history".
 *
 * What a device owns:
 *  - A stable device id (persisted in localStorage per browser profile/install).
 *  - Its own ECDSA P-256 signing keypair. The private key lives only in this
 *    device's IndexedDB (non-extractable via deviceKeyStore); the public key is
 *    published to `user_devices`. v3 messages are signed with this key, so
 *    revoking a device (user_devices.revoked_at) cryptographically cuts off its
 *    ability to produce verifiable messages.
 *  - A trust_state mapping to the internal L0-L3 levels (untrusted / account /
 *    recovery / verified). Users never see the numbers.
 *
 * Session-key ECDH exchange currently remains at the user-identity level (so the
 * existing recovery-key backup/restore semantics are preserved); device rows
 * still record `device_ecdh_public_key` so a later per-device ECDH fan-out can
 * be enabled without a schema change.
 */

import { supabase } from '@/supabase'
import { deviceKeyStore } from './SecureSessionKeyStore'
import {
  generateSigningKeyPair,
  exportPublicSigningKey,
  exportPrivateSigningKey,
  importPrivateSigningKey,
  importPublicSigningKey,
  signMessage,
  verifyMessageSignature,
} from './MessageSigner'
import { debug } from '@/utils/debug'
import { isTauriRuntime } from '@/services/instanceConfig'

const DEVICE_ID_STORAGE_KEY = 'harmony_device_id'

export type DeviceTrustState = 'untrusted' | 'account' | 'recovery' | 'verified' | 'revoked'

export interface UserDevice {
  id: string
  user_id: string
  device_id: string
  device_ecdh_public_key: string | null
  device_signing_public_key: string | null
  trust_state: DeviceTrustState
  platform: string | null
  label: string | null
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

export interface DeviceApprovalRequest {
  id: string
  user_id: string
  requesting_device_id: string
  requesting_label: string | null
  requesting_ecdh_public_key: string | null
  status: 'pending' | 'approved' | 'denied' | 'expired'
  approved_by_device_id: string | null
  encrypted_sync_bundle: string | null
  created_at: string
}

class DeviceIdentityService {
  private deviceId: string | null = null
  private userId: string | null = null
  // Short fingerprint cache for the active signing keys of other devices,
  // keyed by `${userId}:${deviceId}`.
  private signingKeyFingerprintCache = new Map<string, string>()

  /**
   * Stable per-device id. Generated once per browser profile / install and
   * persisted in localStorage. Falls back to an in-memory id if localStorage
   * is unavailable (e.g. strict private mode), which simply means the device
   * is treated as ephemeral.
   */
  getDeviceId(): string {
    if (this.deviceId) return this.deviceId
    try {
      let id = localStorage.getItem(DEVICE_ID_STORAGE_KEY)
      if (!id) {
        id = crypto.randomUUID()
        localStorage.setItem(DEVICE_ID_STORAGE_KEY, id)
      }
      this.deviceId = id
    } catch {
      this.deviceId = crypto.randomUUID()
    }
    return this.deviceId
  }

  /** Coarse platform label for display ("web" / "desktop" / "mobile"). */
  getPlatform(): string {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    const isMobileUA = /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
    if (isTauriRuntime()) return isMobileUA ? 'mobile' : 'desktop'
    return isMobileUA ? 'mobile' : 'web'
  }

  /** Best-effort human label, e.g. "Chrome on Windows". */
  buildLabel(): string {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    let browser = 'Browser'
    if (/Edg\//.test(ua)) browser = 'Edge'
    else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) browser = 'Chrome'
    else if (/Firefox\//.test(ua)) browser = 'Firefox'
    else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari'

    let os = 'device'
    if (/Windows/.test(ua)) os = 'Windows'
    else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS'
    else if (/Android/.test(ua)) os = 'Android'
    else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS'
    else if (/Linux/.test(ua)) os = 'Linux'

    if (this.getPlatform() === 'desktop') return `Harmony Desktop on ${os}`
    return `${browser} on ${os}`
  }

  /**
   * Register (or refresh) this device for the given user.
   *
   * Identity policy: `device_id` names a signing key, not just a browser
   * install. Same device_id + same signing key = same device. Same device_id +
   * different signing key = new cryptographic identity → rotate device_id, insert
   * a fresh row, and do not inherit verified trust. We never overwrite a
   * non-null server-published signing key in place (that would orphan older v3
   * messages signed under the previous key).
   *
   * @param trustState initial trust for a genuinely new device row only.
   */
  async ensureRegistered(userId: string, trustState: DeviceTrustState = 'account'): Promise<UserDevice | null> {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return navigator.locks.request(
        'harmony-device-registration',
        () => this.ensureRegisteredInner(userId, trustState),
      )
    }
    return this.ensureRegisteredInner(userId, trustState)
  }

  private async ensureRegisteredInner(
    userId: string,
    trustState: DeviceTrustState = 'account',
  ): Promise<UserDevice | null> {
    this.userId = userId
    let deviceId = this.getDeviceId()
    let isNewIdentity = false

    const existingLookup = await this.fetchDeviceRow(userId, deviceId)
    if (existingLookup.error) return null
    let existing = existingLookup.row

    // A revoked row is dead; do not refresh it in place.
    if (existing?.revoked_at || existing?.trust_state === 'revoked') {
      debug.warn('⚠️ Current device id is revoked; registering as a new device')
      deviceId = this.rotateDeviceId()
      existing = null
      isNewIdentity = true
    }

    const localPair = await deviceKeyStore.loadSigningKeyPair(deviceId)
    let signingPrivate = localPair?.privateKey ?? null
    let signingPublicSpki = localPair?.publicSpki ?? null

    if (signingPrivate && signingPublicSpki) {
      const localPairValid = await this.localSigningKeyMatchesPublished(
        signingPrivate,
        signingPublicSpki,
        deviceId,
      )
      if (!localPairValid) {
        debug.warn('⚠️ Local cached signing public key does not match private key')
        signingPublicSpki = null
      }
    }

    const serverPublished = existing?.device_signing_public_key ?? null

    if (serverPublished && !signingPrivate) {
      debug.warn(
        '⚠️ Server has a published signing key but local private key is missing; ' +
        'rotating device identity',
      )
      deviceId = this.rotateDeviceId()
      existing = null
      isNewIdentity = true
      signingPublicSpki = null
    } else if (serverPublished && signingPrivate) {
      const matchesServer = await this.localSigningKeyMatchesPublished(
        signingPrivate,
        serverPublished,
        deviceId,
      )
      if (matchesServer) {
        signingPublicSpki = serverPublished
        await deviceKeyStore.storeSigningKey(deviceId, signingPrivate, signingPublicSpki)
      } else {
        // Local key ≠ server key for this device_id → new identity, not in-place rotation.
        debug.warn(
          '⚠️ Local signing key does not match server-published key for this device id; ' +
          'rotating device identity',
        )
        deviceId = this.rotateDeviceId()
        existing = null
        isNewIdentity = true
        signingPrivate = null
        signingPublicSpki = null
      }
    }

    if (!signingPrivate) {
      const minted = await this.mintSigningKeypair(deviceId)
      signingPrivate = minted.privateKey
      signingPublicSpki = minted.publicSpki
    } else if (!signingPublicSpki) {
      // Private key with no SPKI and no authoritative server key: first publish for this id.
      debug.warn('⚠️ Device signing key missing public SPKI - minting a fresh keypair')
      const minted = await this.mintSigningKeypair(deviceId)
      signingPrivate = minted.privateKey
      signingPublicSpki = minted.publicSpki
    }

    if (existing && !existing.revoked_at && existing.trust_state !== 'revoked') {
      const row = await this.touchExistingDeviceRow(existing, signingPrivate, signingPublicSpki)
      // Recovery-phrase unlock is ROOT trust (stronger proof than another
      // device tapping approve). A device that registered earlier in the boot
      // as 'account'/'untrusted' and THEN completed recovery gets upgraded
      // here - otherwise it stays low-trust forever, can't act as an
      // approver, and keeps seeing its own "waiting for approval" card.
      if (
        trustState === 'recovery' &&
        row &&
        (row.trust_state === 'account' || row.trust_state === 'untrusted')
      ) {
        await this.setTrustState(deviceId, 'recovery').catch(err =>
          debug.warn('⚠️ Failed to elevate device trust after recovery unlock:', err),
        )
        row.trust_state = 'recovery'
      }
      return row
    }

    // Rotated identities start untrusted (L0): they can sign v3 messages once
    // published, but must not inherit verified/recovery capabilities.
    const initialTrust = isNewIdentity ? 'untrusted' : trustState
    return this.insertNewDeviceRow(userId, deviceId, signingPublicSpki, initialTrust)
  }

  private async fetchDeviceRow(
    userId: string,
    deviceId: string,
  ): Promise<{ row: UserDevice | null; error: boolean }> {
    const { data, error } = await supabase
      .from('user_devices')
      .select('*')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .maybeSingle()
    if (error) {
      debug.warn('⚠️ Failed to load existing device row:', error)
      return { row: null, error: true }
    }
    return { row: (data || null) as UserDevice | null, error: false }
  }

  /** Mint a new local device id. The previous id's row and messages stay valid. */
  private rotateDeviceId(): string {
    const newId = crypto.randomUUID()
    try {
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, newId)
    } catch { /* ephemeral session */ }
    this.deviceId = newId
    debug.warn(`🔄 Rotated local device id → ${newId.substring(0, 8)}`)
    return newId
  }

  private async mintSigningKeypair(
    deviceId: string,
  ): Promise<{ privateKey: CryptoKey; publicSpki: string }> {
    const kp = await generateSigningKeyPair()
    const publicSpki = await exportPublicSigningKey(kp.publicKey)
    const pkcs8 = await exportPrivateSigningKey(kp.privateKey)
    const privateKey = await importPrivateSigningKey(pkcs8, false)
    await deviceKeyStore.storeSigningKey(deviceId, privateKey, publicSpki)
    return { privateKey, publicSpki }
  }

  /**
   * Refresh an active device row. Only fills a NULL server signing key; never
   * overwrites a published key (key history is not tracked per device_id).
   */
  private async touchExistingDeviceRow(
    existing: UserDevice,
    signingPrivate: CryptoKey,
    signingPublicSpki: string,
  ): Promise<UserDevice | null> {
    const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString() }

    if (!existing.device_signing_public_key && signingPublicSpki) {
      const canPublish = await this.localSigningKeyMatchesPublished(
        signingPrivate,
        signingPublicSpki,
        existing.device_id,
      )
      if (canPublish) {
        patch.device_signing_public_key = signingPublicSpki
      }
    }

    const { data: updated, error } = await supabase
      .from('user_devices')
      .update(patch)
      .eq('id', existing.id)
      .select('*')
      .maybeSingle()
    if (error) {
      debug.warn('⚠️ Failed to refresh device row:', error)
      return existing
    }
    return (updated || existing) as UserDevice
  }

  private async insertNewDeviceRow(
    userId: string,
    deviceId: string,
    signingPublicSpki: string,
    trustState: DeviceTrustState,
  ): Promise<UserDevice | null> {
    const row: Record<string, unknown> = {
      user_id: userId,
      device_id: deviceId,
      device_signing_public_key: signingPublicSpki,
      trust_state: trustState,
      platform: this.getPlatform(),
      label: this.buildLabel(),
      last_seen_at: new Date().toISOString(),
    }
    const { data: inserted, error } = await supabase
      .from('user_devices')
      .insert(row)
      .select('*')
      .maybeSingle()

    if (error) {
      debug.warn('⚠️ Failed to register device:', error)
      return null
    }
    debug.log(`📱 Registered device ${deviceId.substring(0, 8)} (${row.label})`)

    try {
      const others = (await this.listActiveDevices(userId)).filter(d => d.device_id !== deviceId)
      if (others.length > 0) {
        await this.requestApproval(userId)
      }
    } catch (err) {
      debug.warn('⚠️ Failed to raise new-login approval request:', err)
    }

    return inserted as UserDevice
  }

  /** Load this device's signing private key (for signing v3 messages). */
  async getMyDeviceSigningKey(): Promise<CryptoKey | null> {
    return deviceKeyStore.loadSigningKey(this.getDeviceId())
  }

  /** Check that a published SPKI matches the local non-extractable signing key. */
  private async localSigningKeyMatchesPublished(
    privateKey: CryptoKey,
    publishedSpki: string,
    deviceId = this.getDeviceId(),
  ): Promise<boolean> {
    try {
      const publicKey = await importPublicSigningKey(publishedSpki)
      const probe = {
        algorithm: 'megolm_v3',
        room_id: 'device-key-probe',
        session_id: 'probe',
        message_index: 0,
        sender_user_id: this.userId || 'probe',
        ciphertext_hash_b64: 'cHJvYmU=',
        timestamp: 0,
        epoch_id: 1,
        sender_device_id: deviceId,
      }
      const signature = await signMessage(probe, privateKey)
      return verifyMessageSignature(probe, signature, publicKey)
    } catch {
      return false
    }
  }

  /** All non-revoked devices for a user. */
  async listActiveDevices(userId: string): Promise<UserDevice[]> {
    const { data, error } = await supabase
      .from('user_devices')
      .select('*')
      .eq('user_id', userId)
      .is('revoked_at', null)
      .order('created_at', { ascending: true })
    if (error) {
      debug.warn('⚠️ Failed to list devices:', error)
      return []
    }
    return (data || []) as UserDevice[]
  }

  /** All devices (including revoked) for the device-management UI. */
  async listAllDevices(userId: string): Promise<UserDevice[]> {
    const { data, error } = await supabase
      .from('user_devices')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
    if (error) return []
    return (data || []) as UserDevice[]
  }

  /**
   * Fetch the active (non-revoked) signing public key for a specific
   * (userId, deviceId), used to verify v3 messages. Returns null if the device
   * is unknown or revoked - the caller treats that as a verification failure.
   */
  // TTL cache for device signing keys. This sits on the per-message v3
  // verification hot path - without it a cold channel load fires one RPC per
  // message. Negative results (unknown/revoked device) are cached too, so a
  // page of messages from an unknown device doesn't re-query N times; the
  // flip side is that a freshly revoked device stays verifiable for up to
  // the TTL on clients that already have its key cached.
  private deviceSigningKeyCache = new Map<string, { spki: string | null; cachedAt: number }>()
  private deviceSigningKeyFetches = new Map<string, Promise<string | null>>()
  private static readonly DEVICE_KEY_CACHE_TTL_MS = 5 * 60_000

  async getDeviceSigningPublicKey(userId: string, deviceId: string): Promise<string | null> {
    const cacheKey = `${userId}:${deviceId}`
    const cached = this.deviceSigningKeyCache.get(cacheKey)
    if (cached && Date.now() - cached.cachedAt < DeviceIdentityService.DEVICE_KEY_CACHE_TTL_MS) {
      return cached.spki
    }

    // Dedup concurrent lookups (a page decrypt verifies many messages at once).
    const inFlight = this.deviceSigningKeyFetches.get(cacheKey)
    if (inFlight) return inFlight

    const fetchPromise = (async (): Promise<string | null> => {
      // user_devices SELECT is owner-only at the RLS layer, so cross-user lookups
      // (verifying another sender's v3 messages) go through a SECURITY DEFINER RPC
      // that returns ONLY the public signing key + revoked flag - never the rest of
      // the device row (label / platform / last_seen / trust_state).
      const { data, error } = await supabase.rpc('get_device_signing_key', {
        p_user_id: userId,
        p_device_id: deviceId,
      })
      if (error) return null // transient failure: don't cache
      const row = (Array.isArray(data) ? data[0] : data) as
        | { device_signing_public_key: string | null; revoked_at: string | null }
        | undefined
      const spki = (!row || row.revoked_at) ? null : (row.device_signing_public_key || null)
      this.deviceSigningKeyCache.set(cacheKey, { spki, cachedAt: Date.now() })
      return spki
    })()

    this.deviceSigningKeyFetches.set(cacheKey, fetchPromise)
    try {
      return await fetchPromise
    } finally {
      this.deviceSigningKeyFetches.delete(cacheKey)
    }
  }

  /**
   * Resolve the caller's profile id. Prefers the id set during ensureRegistered,
   * but falls back to the auth context. This matters because device management
   * (rename / sign out) is reachable while encryption is LOCKED - in which case
   * ensureRegistered never ran and `this.userId` is null. Previously these
   * methods early-returned on null, so the buttons silently did nothing.
   */
  private async resolveUserId(): Promise<string | null> {
    if (this.userId) return this.userId
    try {
      const { authContextService } = await import('@/services/AuthContextService')
      const ctx = await authContextService.getCurrentContext()
      if (ctx.isAuthenticated && ctx.profileId) return ctx.profileId
    } catch { /* fall through */ }
    return null
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const userId = await this.resolveUserId()
    if (!userId) {
      debug.warn('⚠️ revokeDevice: no profile id available')
      return
    }
    const { error } = await supabase
      .from('user_devices')
      .update({ trust_state: 'revoked', revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('device_id', deviceId)
    if (error) {
      debug.error('❌ Failed to revoke device:', error)
      throw new Error(error.message || 'Failed to sign out device')
    }
  }

  async renameDevice(deviceId: string, label: string): Promise<void> {
    const userId = await this.resolveUserId()
    if (!userId) {
      debug.warn('⚠️ renameDevice: no profile id available')
      return
    }
    const { error } = await supabase
      .from('user_devices')
      .update({ label })
      .eq('user_id', userId)
      .eq('device_id', deviceId)
    if (error) {
      debug.error('❌ Failed to rename device:', error)
      throw new Error(error.message || 'Failed to rename device')
    }
  }

  async setTrustState(deviceId: string, trustState: DeviceTrustState): Promise<void> {
    const userId = await this.resolveUserId()
    if (!userId) return
    await supabase
      .from('user_devices')
      .update({ trust_state: trustState })
      .eq('user_id', userId)
      .eq('device_id', deviceId)
  }

  /** Permanently remove a device row (used to clear the list of dead entries). */
  async deleteDevice(deviceId: string): Promise<void> {
    const userId = await this.resolveUserId()
    if (!userId) return
    // Never delete the device we're currently using.
    if (deviceId === this.getDeviceId()) return
    const { error } = await supabase
      .from('user_devices')
      .delete()
      .eq('user_id', userId)
      .eq('device_id', deviceId)
    if (error) {
      debug.error('❌ Failed to delete device:', error)
      throw new Error(error.message || 'Failed to remove device')
    }
  }

  /**
   * Garbage-collect dead device rows so the list doesn't grow without bound
   * (every incognito login mints a fresh device id). Removes the caller's own
   * rows that are either revoked a while ago or have gone silent for a long
   * time. Conservative thresholds; never touches the current device. Returns
   * how many rows were removed.
   */
  async pruneStaleDevices(
    userId: string,
    opts: { revokedOlderThanDays?: number; idleOlderThanDays?: number } = {},
  ): Promise<number> {
    const revokedDays = opts.revokedOlderThanDays ?? 30
    const idleDays = opts.idleOlderThanDays ?? 90
    const now = Date.now()
    const thisDevice = this.getDeviceId()

    let devices: UserDevice[]
    try {
      devices = await this.listAllDevices(userId)
    } catch {
      return 0
    }

    const toDelete = devices.filter(d => {
      if (d.device_id === thisDevice) return false
      const revokedStale =
        !!d.revoked_at && now - new Date(d.revoked_at).getTime() > revokedDays * 86400_000
      const lastSeen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : new Date(d.created_at).getTime()
      const idleStale = now - lastSeen > idleDays * 86400_000
      return revokedStale || idleStale
    })

    let removed = 0
    for (const d of toDelete) {
      try {
        await this.deleteDevice(d.device_id)
        removed++
      } catch { /* best-effort */ }
    }
    if (removed > 0) debug.log(`🧹 Pruned ${removed} stale device row(s)`)
    return removed
  }

  // ---------------------------------------------------------------------------
  // Device approval ("new login - was this you?")
  // ---------------------------------------------------------------------------

  /** Ask existing trusted devices to approve this one. */
  async requestApproval(userId: string, ecdhPublicKey?: string): Promise<string | null> {
    const { data, error } = await supabase
      .from('device_approval_requests')
      .insert({
        user_id: userId,
        requesting_device_id: this.getDeviceId(),
        requesting_label: this.buildLabel(),
        requesting_ecdh_public_key: ecdhPublicKey || null,
        status: 'pending',
      })
      .select('id')
      .maybeSingle()
    if (error) {
      debug.warn('⚠️ Failed to create device approval request:', error)
      return null
    }
    return (data as any)?.id ?? null
  }

  /** Pending approval requests for the current user's account (other devices). */
  async listPendingApprovals(userId: string): Promise<DeviceApprovalRequest[]> {
    const { data, error } = await supabase
      .from('device_approval_requests')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .neq('requesting_device_id', this.getDeviceId())
      .order('created_at', { ascending: false })
    if (error) return []
    const rows = (data || []) as DeviceApprovalRequest[]
    const filtered: DeviceApprovalRequest[] = []
    for (const req of rows) {
      if (await this.canActAsApprover(userId, req)) filtered.push(req)
    }
    return filtered
  }

  /** Pending approval raised BY this device (the new login waiting for approval). */
  async getOwnPendingApproval(userId: string): Promise<DeviceApprovalRequest | null> {
    const { data, error } = await supabase
      .from('device_approval_requests')
      .select('*')
      .eq('user_id', userId)
      .eq('requesting_device_id', this.getDeviceId())
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) return null
    return (data || null) as DeviceApprovalRequest | null
  }

  /** This device's row in user_devices, if registered. */
  async getMyDeviceRow(userId: string): Promise<UserDevice | null> {
    const { data, error } = await supabase
      .from('user_devices')
      .select('*')
      .eq('user_id', userId)
      .eq('device_id', this.getDeviceId())
      .maybeSingle()
    if (error || !data) return null
    return data as UserDevice
  }

  /**
   * Whether THIS device should see the "approve/deny" prompt for `req`.
   *
   * Fresh logins (incognito, new install) must NOT act as approvers - they would
   * otherwise see stale pending requests from previous sessions and get the
   * confusing "someone signed in" card about themselves. Only an established
   * session (predates the request, or explicitly recovery/verified trust) may
   * approve another login.
   */
  async canActAsApprover(userId: string, req: DeviceApprovalRequest): Promise<boolean> {
    if (req.requesting_device_id === this.getDeviceId()) return false

    const myDevice = await this.getMyDeviceRow(userId)
    if (!myDevice || myDevice.revoked_at) return false

    if (myDevice.trust_state === 'verified' || myDevice.trust_state === 'recovery') {
      return true
    }

    const myCreated = new Date(myDevice.created_at).getTime()
    const reqCreated = new Date(req.created_at).getTime()
    // Established session: registered well before this login request.
    return myCreated <= reqCreated - 5000
  }

  /** Sign out THIS device row (for "this wasn't me" on a fresh login). */
  async revokeCurrentDevice(): Promise<void> {
    const userId = await this.resolveUserId()
    if (!userId) return
    const deviceId = this.getDeviceId()
    const { error } = await supabase
      .from('user_devices')
      .update({ trust_state: 'revoked', revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('device_id', deviceId)
    if (error) {
      debug.error('❌ Failed to revoke current device:', error)
      throw new Error(error.message || 'Failed to secure account')
    }
  }

  /**
   * Approve another device via the server-enforced RPC. The RPC verifies THIS
   * device is an established approver (predates the request or already trusted),
   * so a freshly-logged-in attacker device can't approve itself. It also elevates
   * the requesting device to 'verified'. `encryptedSyncBundle` is the optional
   * key-sync payload the requesting device picks up to unlock history (L3).
   */
  async approveDevice(requestId: string, encryptedSyncBundle?: string): Promise<void> {
    const { error } = await supabase.rpc('approve_device_request', {
      p_request_id: requestId,
      p_approver_device_id: this.getDeviceId(),
      p_encrypted_sync_bundle: encryptedSyncBundle || null,
    })
    if (error) throw new Error(error.message || 'Failed to approve device')
  }

  /** Deny/secure a pending login. The RPC also revokes the requesting device. */
  async denyDevice(requestId: string): Promise<void> {
    const { error } = await supabase.rpc('deny_device_request', {
      p_request_id: requestId,
    })
    if (error) throw new Error(error.message || 'Failed to deny device')
  }
}

export const deviceIdentityService = new DeviceIdentityService()
