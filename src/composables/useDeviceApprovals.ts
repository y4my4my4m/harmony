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
 * The component layer (DeviceApprovalPrompt.vue) renders `pendingApprovals`;
 * this composable owns the data + actions so it can be mounted once globally.
 */

import { ref, onMounted, onUnmounted } from 'vue'
import { userEventChannel } from '@/services/UserEventChannel'
import { deviceIdentityService, type DeviceApprovalRequest } from '@/services/encryption/DeviceIdentityService'
import { debug } from '@/utils/debug'

const pendingApprovals = ref<DeviceApprovalRequest[]>([])
let initialized = false
let currentUserId: string | null = null

function upsertApproval(req: DeviceApprovalRequest) {
  // Never show this device its own request.
  if (req.requesting_device_id === deviceIdentityService.getDeviceId()) return
  const idx = pendingApprovals.value.findIndex(r => r.id === req.id)
  if (idx >= 0) pendingApprovals.value[idx] = req
  else pendingApprovals.value.unshift(req)
}

function removeApproval(id: string) {
  pendingApprovals.value = pendingApprovals.value.filter(r => r.id !== id)
}

async function onApprovedForThisDevice(payload: Record<string, any>) {
  // Only react if WE are the device that was approved.
  if (payload.requesting_device_id !== deviceIdentityService.getDeviceId()) {
    // A different device of ours was approved; just clear any local prompt.
    removeApproval(payload.id)
    return
  }
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
    if (initialized) return
    initialized = true
    ownsSubscriptions = true

    // Seed with any already-pending requests (e.g. raised while we were offline).
    try {
      const existing = await deviceIdentityService.listPendingApprovals(userId)
      existing.forEach(upsertApproval)
    } catch { /* non-fatal */ }

    offFns.push(
      userEventChannel.on('device:approval_request', (p) => upsertApproval(p as unknown as DeviceApprovalRequest)),
      userEventChannel.on('device:approved', (p) => { onApprovedForThisDevice(p) }),
      userEventChannel.on('device:denied', (p) => { onDeniedForThisDevice(p) }),
    )
  }

  async function approve(req: DeviceApprovalRequest) {
    try {
      // Mark the requesting device trusted, then resolve the request. (A future
      // per-device ECDH fan-out can attach an encrypted_sync_bundle here.)
      await deviceIdentityService.setTrustState(req.requesting_device_id, 'verified')
      await deviceIdentityService.approveDevice(req.id)
    } finally {
      removeApproval(req.id)
    }
  }

  async function deny(req: DeviceApprovalRequest) {
    try {
      await deviceIdentityService.denyDevice(req.id)
      // Defense-in-depth: a denied login should not keep a usable device row.
      await deviceIdentityService.revokeDevice(req.requesting_device_id).catch(() => {})
    } finally {
      removeApproval(req.id)
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

  return { pendingApprovals, start, approve, deny }
}
