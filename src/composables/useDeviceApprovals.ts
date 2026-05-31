/**
 * useDeviceApprovals
 *
 * Drives the Discord-simple device-trust UX. It listens on the existing
 * per-user realtime channel (user:{profileId}, event user_event) for the three
 * device events broadcast by `broadcast_device_approval_event`:
 *
 *   - device:approval_request -> another device of THIS account just logged in.
 *       Surface a gentle, non-blocking "New login on X - was this you?" prompt
 *       on already-trusted devices. (Never a hard wall - it's skippable.)
 *   - device:approved          -> THIS (requesting) device was approved from
 *       another device; claim any pending key shares and reprocess messages.
 *   - device:denied            -> the request was denied; surface a security
 *       toast so the user knows the login was rejected.
 *
 * The component layer (DeviceApprovalPrompt.vue) renders `pendingApprovals` on
 * established devices and `ownPendingRequest` on the fresh login; this
 * composable owns the data + actions so it can be mounted once globally.
 */

import { ref, onMounted, onUnmounted } from 'vue'
import { userEventChannel } from '@/services/UserEventChannel'
import { deviceIdentityService, type DeviceApprovalRequest } from '@/services/encryption/DeviceIdentityService'
import { debug } from '@/utils/debug'

const pendingApprovals = ref<DeviceApprovalRequest[]>([])
const ownPendingRequest = ref<DeviceApprovalRequest | null>(null)
const ownPendingDismissed = ref(false)
let initialized = false
let currentUserId: string | null = null

async function upsertApproval(req: DeviceApprovalRequest) {
  // This device raised the request → waiting UI, not approver UI.
  if (req.requesting_device_id === deviceIdentityService.getDeviceId()) {
    ownPendingRequest.value = req
    ownPendingDismissed.value = false
    return
  }
  if (!currentUserId) return
  if (!(await deviceIdentityService.canActAsApprover(currentUserId, req))) return

  const idx = pendingApprovals.value.findIndex(r => r.id === req.id)
  if (idx >= 0) pendingApprovals.value[idx] = req
  else pendingApprovals.value.unshift(req)
}

function removeApproval(id: string) {
  pendingApprovals.value = pendingApprovals.value.filter(r => r.id !== id)
  if (ownPendingRequest.value?.id === id) ownPendingRequest.value = null
}

async function refreshOwnPending(userId: string) {
  try {
    ownPendingRequest.value = await deviceIdentityService.getOwnPendingApproval(userId)
  } catch {
    ownPendingRequest.value = null
  }
}

async function onApprovedForThisDevice(payload: Record<string, any>) {
  // Only react if WE are the device that was approved.
  if (payload.requesting_device_id !== deviceIdentityService.getDeviceId()) {
    // A different device of ours was approved; just clear any local prompt.
    removeApproval(payload.id)
    return
  }
  ownPendingRequest.value = null
  ownPendingDismissed.value = false
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    // Approval elevates this device to a key-sync-capable state. Claim any
    // shares waiting for us and reprocess visible encrypted messages.
    await megolmMessageEncryptionService.claimPendingSessionShares().catch(() => 0)
    window.dispatchEvent(new CustomEvent('megolm-key-received', { detail: { roomId: '*', sessionId: '*' } }))
  } catch (err) {
    debug.warn('⚠️ Post-approval key sync failed:', err)
  }
  try {
    const { useNotificationStore } = await import('@/stores/useNotification')
    useNotificationStore().showToast(
      'server_update',
      'Device approved',
      'This device was approved from another device. Your encrypted message history is unlocking.',
      6000,
    )
  } catch { /* non-fatal */ }
}

async function onDeniedForThisDevice(payload: Record<string, any>) {
  removeApproval(payload.id)
  if (payload.requesting_device_id !== deviceIdentityService.getDeviceId()) return
  ownPendingRequest.value = null
  try {
    const { useNotificationStore } = await import('@/stores/useNotification')
    useNotificationStore().showToast(
      'server_update',
      'Login not approved',
      'This device was not approved. You can still read new messages, but encrypted history stays locked.',
      7000,
    )
  } catch { /* non-fatal */ }
}

export function useDeviceApprovals() {
  const offFns: Array<() => void> = []
  // Whether THIS composable instance owns the live channel subscriptions, so we
  // only reset the module-global `initialized` flag when the owner unmounts.
  let ownsSubscriptions = false

  async function start(userId: string) {
    currentUserId = userId
    if (initialized) {
      await refreshOwnPending(userId)
      return
    }
    initialized = true
    ownsSubscriptions = true

    // Seed with any already-pending requests (e.g. raised while we were offline).
    try {
      const existing = await deviceIdentityService.listPendingApprovals(userId)
      pendingApprovals.value = existing
      await refreshOwnPending(userId)
    } catch { /* non-fatal */ }

    offFns.push(
      userEventChannel.on('device:approval_request', (p) => {
        upsertApproval(p as unknown as DeviceApprovalRequest).catch(() => {})
      }),
      userEventChannel.on('device:approved', (p) => { onApprovedForThisDevice(p) }),
      userEventChannel.on('device:denied', (p) => { onDeniedForThisDevice(p) }),
    )
  }

  async function approve(req: DeviceApprovalRequest) {
    try {
      // Server-enforced: the RPC verifies this device may approve, resolves the
      // request, and elevates the requesting device to 'verified'. (A future
      // per-device ECDH fan-out can attach an encrypted_sync_bundle here.)
      await deviceIdentityService.approveDevice(req.id)
      try {
        const { useNotificationStore } = await import('@/stores/useNotification')
        useNotificationStore().showToast(
          'server_update',
          'Login approved',
          `${req.requesting_label || 'The new device'} can now unlock your encrypted history.`,
          5000,
        )
      } catch { /* non-fatal */ }
    } finally {
      removeApproval(req.id)
    }
  }

  async function deny(req: DeviceApprovalRequest) {
    try {
      // The RPC marks the request denied AND revokes the requesting device row.
      await deviceIdentityService.denyDevice(req.id)
      try {
        const { useNotificationStore } = await import('@/stores/useNotification')
        useNotificationStore().showToast(
          'server_update',
          'Login blocked',
          `${req.requesting_label || 'That device'} was signed out for your security.`,
          6000,
        )
      } catch { /* non-fatal */ }
    } finally {
      removeApproval(req.id)
    }
  }

  /** Dismiss the "waiting for approval" card on this device (non-destructive). */
  function dismissOwnPending() {
    ownPendingDismissed.value = true
  }

  /** "This wasn't me" on a fresh login: revoke this device and sign out. */
  async function secureThisLogin() {
    try {
      if (ownPendingRequest.value) {
        await deviceIdentityService.denyDevice(ownPendingRequest.value.id).catch(() => {})
      }
      await deviceIdentityService.revokeCurrentDevice()
      ownPendingRequest.value = null
      ownPendingDismissed.value = false
      const { useAuthStore } = await import('@/stores/auth')
      await useAuthStore().logout()
      try {
        const { useNotificationStore } = await import('@/stores/useNotification')
        useNotificationStore().showToast(
          'server_update',
          'Signed out',
          'This login was ended for your security.',
          5000,
        )
      } catch { /* non-fatal */ }
    } catch (err) {
      debug.error('❌ secureThisLogin failed:', err)
      throw err
    }
  }

  onMounted(() => {
    if (currentUserId) start(currentUserId).catch(() => {})
  })

  onUnmounted(() => {
    offFns.forEach(fn => fn())
    offFns.length = 0
    if (ownsSubscriptions) {
      // Let a future mount re-subscribe (e.g. after navigating away and back).
      initialized = false
      ownsSubscriptions = false
    }
  })

  return {
    pendingApprovals,
    ownPendingRequest,
    ownPendingDismissed,
    start,
    approve,
    deny,
    dismissOwnPending,
    secureThisLogin,
  }
}
