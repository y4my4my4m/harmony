<template>
  <Teleport to="body">
    <!-- Established device: approve/deny someone else's login -->
    <transition name="device-approval-fade">
      <div v-if="currentApprover" class="device-approval-card" role="dialog" aria-live="polite">
        <div class="dap-icon">
          <Icon name="smartphone" :size="22" />
        </div>
        <div class="dap-body">
          <strong class="dap-title">New login{{ currentApprover.requesting_label ? ` on ${currentApprover.requesting_label}` : '' }}</strong>
          <p class="dap-text">
            A new device signed in to your account. If this was you, approve it to unlock
            encrypted message history on that device.
          </p>
          <div class="dap-actions">
            <button class="dap-btn dap-btn-approve" :disabled="busy" @click="onApprove">
              Yes, it's me
            </button>
            <button class="dap-btn dap-btn-deny" :disabled="busy" @click="onDeny">
              No, secure my account
            </button>
          </div>
          <p v-if="pendingApprovals.length > 1" class="dap-more">
            +{{ pendingApprovals.length - 1 }} more login{{ pendingApprovals.length - 1 > 1 ? 's' : '' }} waiting
          </p>
        </div>
      </div>
    </transition>

    <!-- Fresh login: waiting for approval on another device -->
    <transition name="device-approval-fade">
      <div
        v-if="showOwnPending"
        class="device-approval-card device-approval-card-waiting"
        role="dialog"
        aria-live="polite"
      >
        <div class="dap-icon">
          <Icon name="clock" :size="22" />
        </div>
        <div class="dap-body">
          <strong class="dap-title">Approve this login on another device</strong>
          <p class="dap-text">
            Open Harmony on a device where you're already signed in and tap
            <strong>Yes, it's me</strong> to unlock your encrypted message history here.
            New messages still work in the meantime.
          </p>
          <div class="dap-actions">
            <button class="dap-btn dap-btn-approve" :disabled="busy" @click="onDismissWaiting">
              Got it
            </button>
            <button class="dap-btn dap-btn-deny" :disabled="busy" @click="onSecureThisLogin">
              This wasn't me
            </button>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useDeviceApprovals } from '@/composables/useDeviceApprovals'
import type { DeviceApprovalRequest } from '@/services/encryption/DeviceIdentityService'
import { debug } from '@/utils/debug'

const {
  pendingApprovals,
  ownPendingRequest,
  ownPendingDismissed,
  start,
  approve,
  deny,
  dismissOwnPending,
  secureThisLogin,
} = useDeviceApprovals()
const busy = ref(false)

const currentApprover = computed<DeviceApprovalRequest | null>(
  () => pendingApprovals.value[0] || null,
)

const showOwnPending = computed(
  () => !!ownPendingRequest.value && !ownPendingDismissed.value && !currentApprover.value,
)

async function onApprove() {
  if (!currentApprover.value || busy.value) return
  busy.value = true
  try {
    await approve(currentApprover.value)
  } catch (err) {
    debug.warn('Approve device failed:', err)
    try {
      const { useNotificationStore } = await import('@/stores/useNotification')
      useNotificationStore().showToast(
        'server_update',
        'Could not approve login',
        err instanceof Error ? err.message : 'Please try again.',
        6000,
      )
    } catch { /* non-fatal */ }
  } finally {
    busy.value = false
  }
}

async function onDeny() {
  if (!currentApprover.value || busy.value) return
  busy.value = true
  try {
    await deny(currentApprover.value)
  } catch (err) {
    debug.warn('Deny device failed:', err)
    try {
      const { useNotificationStore } = await import('@/stores/useNotification')
      useNotificationStore().showToast(
        'server_update',
        'Could not secure account',
        err instanceof Error ? err.message : 'Please try again from Settings → Privacy.',
        7000,
      )
    } catch { /* non-fatal */ }
  } finally {
    busy.value = false
  }
}

function onDismissWaiting() {
  dismissOwnPending()
}

async function onSecureThisLogin() {
  if (busy.value) return
  busy.value = true
  try {
    await secureThisLogin()
  } catch (err) {
    debug.warn('Secure this login failed:', err)
    try {
      const { useNotificationStore } = await import('@/stores/useNotification')
      useNotificationStore().showToast(
        'server_update',
        'Could not sign out',
        err instanceof Error ? err.message : 'Please sign out manually from the user menu.',
        7000,
      )
    } catch { /* non-fatal */ }
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    const { authContextService } = await import('@/services/AuthContextService')
    const ctx = await authContextService.getCurrentContext()
    if (ctx.isAuthenticated && ctx.profileId) {
      await start(ctx.profileId)
    }
  } catch (err) {
    debug.warn('Device-approval prompt init failed:', err)
  }
})
</script>

<style scoped>
.device-approval-card {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 1100;
  display: flex;
  gap: 14px;
  width: 360px;
  max-width: calc(100vw - 40px);
  padding: 16px;
  background: var(--background-floating);
  border: 1px solid var(--warning);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
}

.device-approval-card-waiting {
  border-color: var(--harmony-primary);
}

.dap-icon {
  flex-shrink: 0;
  color: var(--warning);
}

.device-approval-card-waiting .dap-icon {
  color: var(--harmony-primary);
}

.dap-body {
  flex: 1;
  min-width: 0;
}

.dap-title {
  display: block;
  color: var(--text-primary);
  font-size: 15px;
  margin-bottom: 4px;
}

.dap-text {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.45;
  margin: 0 0 12px 0;
}

.dap-actions {
  display: flex;
  gap: 8px;
}

.dap-btn {
  flex: 1;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  border: none;
  transition: background 0.15s;
}

.dap-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dap-btn-approve {
  background: var(--success);
  color: var(--text-on-primary);
}

.dap-btn-approve:hover:not(:disabled) {
  background: var(--success-hover);
}

.dap-btn-deny {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.dap-btn-deny:hover:not(:disabled) {
  background: var(--bg-tertiary);
}

.dap-more {
  margin: 10px 0 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.device-approval-fade-enter-active,
.device-approval-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.device-approval-fade-enter-from,
.device-approval-fade-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
