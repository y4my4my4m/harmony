/**
 * Device pairing over device_approval_requests. Protocol and threat model: devicePairing.ts.
 *
 * New device: startNewDevice (shows a code) or answerApproverCode (scanned one), then
 * waitForKeys and completeNewDevice. Signed-in device: inspectScannedCode then approveLink,
 * or startApproverCode, findAnswer and approveLink.
 */

import { userEventChannel } from '@/services/UserEventChannel'
import { debug } from '@/utils/debug'
import {
  deviceIdentityService,
  isRequestExpired,
  type DeviceApprovalRequest,
} from './DeviceIdentityService'
import {
  ApproverCodeSession,
  CLOCK_SKEW_MS,
  NewDevicePairingSession,
  PairingError,
  accountTag,
  base64ToBytes,
  deriveApprovalToken,
  encodePairingCode,
  equalBytes,
  isCodeExpired,
  sealBundle,
  verifyScannedRequest,
  type ApproverCode,
  type NewDeviceCode,
  type PairingKeys,
} from './devicePairing'

export interface NewDevicePairing {
  requestId: string
  expiresAt: number
  /** Code to show; null when answering an approver's code. */
  qrText: string | null
  session: NewDevicePairingSession
}

export interface PendingLink {
  request: DeviceApprovalRequest
  recipientPublicRaw: Uint8Array
  secret: Uint8Array
}

const POLL_MS = 3000

class DevicePairingService {
  // New device.

  async startNewDevice(profileId: string): Promise<NewDevicePairing> {
    await this.registerThisDevice(profileId)
    const session = await NewDevicePairingSession.create()
    const { id, expiresAt } = await deviceIdentityService.createPairingRequest({
      ecdhPublicKey: session.publicKeyBase64,
      tokenHash: await session.tokenHash(),
    })
    return {
      requestId: id,
      expiresAt,
      qrText: encodePairingCode(await session.code(id, expiresAt)),
      session,
    }
  }

  async answerApproverCode(profileId: string, code: ApproverCode): Promise<NewDevicePairing> {
    if (isCodeExpired(code.expiresAt)) {
      throw new PairingError('expired', 'That code expired. Show a new one on your other device.')
    }
    if (!equalBytes(code.accountTag, await accountTag(profileId))) {
      throw new PairingError('wrong_account', 'That code belongs to a different account.')
    }
    await this.registerThisDevice(profileId)
    const session = await NewDevicePairingSession.create(code.secret)
    const { id, expiresAt } = await deviceIdentityService.createPairingRequest({
      ecdhPublicKey: session.publicKeyBase64,
      tokenHash: await session.tokenHash(),
      proof: await session.proof(),
    })
    return { requestId: id, expiresAt, qrText: null, session }
  }

  private async registerThisDevice(profileId: string): Promise<void> {
    const row = await deviceIdentityService.ensureRegistered(profileId, 'untrusted', { raiseApproval: false })
    if (!row) throw new Error('Could not register this device')
  }

  /** Resolves with the keys once approved and opened; rejects on denial, expiry or abort. */
  waitForKeys(pairing: NewDevicePairing, signal: AbortSignal): Promise<PairingKeys> {
    return new Promise<PairingKeys>((resolve, reject) => {
      let done = false
      let busy = false
      let rerun = false
      const offs: Array<() => void> = []
      const timer = setInterval(() => void check(), POLL_MS)

      const finish = (settle: () => void) => {
        if (done) return
        done = true
        clearInterval(timer)
        offs.forEach(off => off())
        signal.removeEventListener('abort', onAbort)
        settle()
      }
      const onAbort = () => finish(() => reject(new DOMException('Pairing cancelled', 'AbortError')))

      const check = async (): Promise<void> => {
        if (done) return
        if (busy) {
          rerun = true
          return
        }
        busy = true
        try {
          const row = await deviceIdentityService.getApprovalRequest(pairing.requestId)
          if (done || !row) return
          if (row.status === 'approved') {
            if (!row.encrypted_sync_bundle) {
              throw new PairingError('bundle_invalid', 'The other device approved this one without sending keys.')
            }
            const keys = await pairing.session.open(row.id, row.encrypted_sync_bundle)
            finish(() => resolve(keys))
          } else if (row.status === 'denied') {
            throw new PairingError('denied', 'Your other device declined this sign-in.')
          } else if (row.status === 'expired' || isRequestExpired(row)) {
            throw new PairingError('expired', 'The code expired.')
          }
        } catch (err) {
          if (err instanceof PairingError) finish(() => reject(err))
          else debug.warn('Pairing status check failed:', err)
        } finally {
          busy = false
          if (rerun && !done) {
            rerun = false
            void check()
          }
        }
      }

      signal.addEventListener('abort', onAbort)
      if (signal.aborted) {
        onAbort()
        return
      }
      const forThis = (payload: Record<string, unknown>) => payload?.id === pairing.requestId
      offs.push(
        userEventChannel.on('device:approved', p => { if (forThis(p)) void check() }),
        userEventChannel.on('device:denied', p => { if (forThis(p)) void check() }),
        userEventChannel.on('device:approval_expired', p => { if (forThis(p)) void check() }),
      )
      void check()
    })
  }

  /** Unlocks this device with the keys, then clears them from the request. */
  async completeNewDevice(authUserId: string, pairing: NewDevicePairing, keys: PairingKeys): Promise<void> {
    const { megolmMessageEncryptionService } = await import('./MegolmMessageEncryptionService')
    if (!megolmMessageEncryptionService.getCurrentUserId()) {
      await megolmMessageEncryptionService.initialize(authUserId)
    }
    try {
      if (keys.userId !== megolmMessageEncryptionService.getCurrentUserId()) {
        throw new PairingError('wrong_account', 'These keys belong to a different account.')
      }
      await megolmMessageEncryptionService.initializeWithPairedKeys(keys)
    } finally {
      await deviceIdentityService.consumeSyncBundle(pairing.requestId)
    }
  }

  // Signed-in device.

  /** Reads the request a scanned new-device code names and checks it against the code. */
  async inspectScannedCode(code: NewDeviceCode): Promise<PendingLink> {
    const row = await deviceIdentityService.getApprovalRequest(code.requestId)
    const recipientPublicRaw = await verifyScannedRequest(code, row, {
      ownDeviceId: deviceIdentityService.getDeviceId(),
    })
    return { request: row!, recipientPublicRaw, secret: code.secret }
  }

  startApproverCode(profileId: string): Promise<ApproverCodeSession> {
    return ApproverCodeSession.create(profileId)
  }

  /**
   * The pending request that answered the code `session` shows, or null. Throws when more
   * than one request answered it.
   */
  async findAnswer(profileId: string, session: ApproverCodeSession): Promise<PendingLink | null> {
    const rows = await deviceIdentityService.listPendingPairingRequests(profileId)
    let found: PendingLink | null = null
    for (const row of rows) {
      if (!row.pairing_proof || !row.requesting_ecdh_public_key) continue
      if (Date.parse(row.created_at) < session.createdAt - CLOCK_SKEW_MS) continue
      if (await session.match(row)) {
        found = {
          request: row,
          recipientPublicRaw: base64ToBytes(row.requesting_ecdh_public_key),
          secret: session.secret,
        }
      }
    }
    return found
  }

  /** Seals this device's keys to the linked device and approves its request. */
  async approveLink(link: PendingLink): Promise<void> {
    const { megolmMessageEncryptionService } = await import('./MegolmMessageEncryptionService')
    const userId = megolmMessageEncryptionService.getCurrentUserId()
    if (!userId) throw new PairingError('keys_unavailable', 'Unlock encryption on this device first.')
    const material = await megolmMessageEncryptionService.exportPairingKeys()

    // The linked device restores history from the key backup; bring it up to date.
    try {
      const { megolmKeyBackupService } = await import('./MegolmKeyBackupService')
      await megolmKeyBackupService.createBackup()
    } catch (err) {
      debug.warn('Key backup before pairing failed:', err)
    }

    const bundle = await sealBundle({
      secret: link.secret,
      requestId: link.request.id,
      recipientPublicRaw: link.recipientPublicRaw,
      keys: { ...material, userId, approverDeviceId: deviceIdentityService.getDeviceId() },
    })
    const approved = await deviceIdentityService.approveDevice(link.request.id, {
      encryptedSyncBundle: bundle,
      token: await deriveApprovalToken(link.secret),
    })
    if (!approved) {
      const row = await deviceIdentityService.getApprovalRequest(link.request.id).catch(() => null)
      if (!row || row.status === 'expired' || isRequestExpired(row)) {
        throw new PairingError('expired', 'The code expired. Ask the new device for a new one.')
      }
      throw new PairingError('not_pending', 'This sign-in was already answered.')
    }
  }
}

export const devicePairingService = new DevicePairingService()
