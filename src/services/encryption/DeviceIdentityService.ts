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
} from './MessageSigner'
import { debug } from '@/utils/debug'

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
    if (typeof (globalThis as any).__TAURI__ !== 'undefined') return 'desktop'
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile'
    return 'web'
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
   * Register (or refresh) this device for the given user. Idempotent: it
   * generates a device signing keypair the first time, caches the private key
   * locally, and upserts the public key + metadata into user_devices.
   *
   * @param trustState initial trust level for a brand-new device row. Existing
   *        rows keep their trust state (we only touch last_seen / keys).
   */
  async ensureRegistered(userId: string, trustState: DeviceTrustState = 'account'): Promise<UserDevice | null> {
    this.userId = userId
    const deviceId = this.getDeviceId()

    // Ensure we have a device signing key locally.
    let signingPrivate = await deviceKeyStore.loadSigningKey(deviceId)
    let signingPublicSpki: string | null = null
    if (!signingPrivate) {
      const kp = await generateSigningKeyPair()
      signingPublicSpki = await exportPublicSigningKey(kp.publicKey)
      const pkcs8 = await exportPrivateSigningKey(kp.privateKey)
      signingPrivate = await importPrivateSigningKey(pkcs8, false)
      await deviceKeyStore.storeSigningKey(deviceId, signingPrivate)
    }

    // Look up an existing row.
    const { data: existing } = await supabase
      .from('user_devices')
      .select('*')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .maybeSingle()

    // If a row exists but we just (re)generated a signing key because the local
    // copy was missing, refresh the public key on the row so verification of
    // this device's future messages succeeds.
    if (existing) {
      const patch: Record<string, any> = { last_seen_at: new Date().toISOString() }
      if (signingPublicSpki && existing.device_signing_public_key !== signingPublicSpki) {
        patch.device_signing_public_key = signingPublicSpki
      }
      const { data: updated } = await supabase
        .from('user_devices')
        .update(patch)
        .eq('id', existing.id)
        .select('*')
        .maybeSingle()
      return (updated || existing) as UserDevice
    }

    // New device row. If we loaded an existing private key but had no row, we
    // still need its public key; derive it is not possible from a non-extractable
    // private, so only set it when we generated the key this run.
    const row: Record<string, any> = {
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

    // Brand-new device: if the account already has OTHER active devices, raise a
    // Discord-style "new login - was this you?" approval request so those devices
    // can prompt the user (and optionally push a history key-sync bundle). The
    // first-ever device for an account never prompts (nobody to ask).
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
  async getDeviceSigningPublicKey(userId: string, deviceId: string): Promise<string | null> {
    const { data, error } = await supabase
      .from('user_devices')
      .select('device_signing_public_key, revoked_at')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .maybeSingle()
    if (error || !data) return null
    if (data.revoked_at) return null
    return (data.device_signing_public_key as string) || null
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
    return (data || []) as DeviceApprovalRequest[]
  }

  /**
   * Approve another device. `encryptedSyncBundle` is the key-sync payload the
   * caller wrapped for the requesting device (opaque to this service); the
   * requesting device picks it up and unlocks history (L3).
   */
  async approveDevice(requestId: string, encryptedSyncBundle?: string): Promise<void> {
    await supabase
      .from('device_approval_requests')
      .update({
        status: 'approved',
        approved_by_device_id: this.getDeviceId(),
        encrypted_sync_bundle: encryptedSyncBundle || null,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', requestId)
  }

  async denyDevice(requestId: string): Promise<void> {
    await supabase
      .from('device_approval_requests')
      .update({ status: 'denied', resolved_at: new Date().toISOString() })
      .eq('id', requestId)
  }
}

export const deviceIdentityService = new DeviceIdentityService()
