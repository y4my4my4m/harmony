<template>
  <Teleport to="body">
    <!-- Established device: approve/deny someone else's login -->
    <transition name="device-approval-fade">
      <div
        v-if="currentApprover"
        class="device-approval-card"
        role="dialog"
        aria-live="polite"
        data-testid="device-approval-card"
      >
        <div class="dap-icon">
          <Icon name="smartphone" :size="22" />
        </div>
        <div class="dap-body">
          <strong class="dap-title">{{ currentApprover.requesting_label ? $t('encryption.approval.newLoginOn', { device: currentApprover.requesting_label }) : $t('encryption.approval.newLogin') }}</strong>
          <template v-if="currentIsPairing">
            <p class="dap-text">{{ $t('encryption.approval.pairingText') }}</p>
            <div class="dap-actions">
              <button class="dap-btn dap-btn-approve" :disabled="busy" data-testid="approval-scan" @click="linkMode = 'scan'">
                {{ $t('encryption.approval.scanItsCode') }}
              </button>
              <button class="dap-btn dap-btn-deny" :disabled="busy" @click="onDeny">
                {{ $t('encryption.approval.notMe') }}
              </button>
            </div>
            <button class="dap-link" :disabled="busy" @click="linkMode = 'show'">
              {{ $t('encryption.approval.showInstead') }}
            </button>
          </template>
          <template v-else>
            <p class="dap-text">{{ $t('encryption.approval.plainText') }}</p>
            <div class="dap-actions">
              <button class="dap-btn dap-btn-approve" :disabled="busy" @click="onApprove">
                {{ $t('encryption.approval.thatWasMe') }}
              </button>
              <button class="dap-btn dap-btn-deny" :disabled="busy" @click="onDeny">
                {{ $t('encryption.approval.secureAccount') }}
              </button>
            </div>
          </template>
          <p v-if="pendingApprovals.length > 1" class="dap-more">
            {{ $t('encryption.approval.moreWaiting', { count: pendingApprovals.length - 1 }, pendingApprovals.length - 1) }}
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
          <strong class="dap-title">{{ $t('encryption.approval.waitingTitle') }}</strong>
          <i18n-t keypath="encryption.approval.waitingText" tag="p" class="dap-text">
            <template #button><strong>{{ $t('encryption.approval.thatWasMe') }}</strong></template>
          </i18n-t>
          <div class="dap-actions">
            <button class="dap-btn dap-btn-approve" :disabled="busy" @click="onDismissWaiting">
              {{ $t('auth.gotIt') }}
            </button>
            <button class="dap-btn dap-btn-deny" :disabled="busy" @click="onSecureThisLogin">
              {{ $t('encryption.approval.notMeThisLogin') }}
            </button>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
  <DeviceLinkModal v-if="linkMode" :mode="linkMode" @close="linkMode = null" />
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import { useDeviceApprovals } from '@/composables/useDeviceApprovals'
import { isPairingRequest, type DeviceApprovalRequest } from '@/services/encryption/DeviceIdentityService'
import { debug } from '@/utils/debug'

const DeviceLinkModal = defineAsyncComponent(() => import('./DeviceLinkModal.vue'))

const {
  pendingApprovals,
  ownPendingRequest,
  ownPendingDismissed,
  linkInProgress,
  start,
  approve,
  deny,
  dismissOwnPending,
  secureThisLogin,
} = useDeviceApprovals()
const { t } = useI18n()
const busy = ref(false)
const linkMode = ref<'scan' | 'show' | null>(null)

const currentApprover = computed<DeviceApprovalRequest | null>(
  () => (linkInProgress.value ? null : pendingApprovals.value[0] || null),
)
const currentIsPairing = computed(() => !!currentApprover.value && isPairingRequest(currentApprover.value))

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
        t('encryption.approval.approveFailed'),
        err instanceof Error ? err.message : t('encryption.approval.tryAgain'),
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
        t('encryption.approval.secureFailed'),
        err instanceof Error ? err.message : t('encryption.approval.secureFailedHintPath', { settings: t('settings.title'), privacy: t('settings.privacy') }),
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
        t('encryption.approval.signOutFailed'),
        err instanceof Error ? err.message : t('encryption.approval.signOutFailedHint'),
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
  max-width: calc(100 * var(--app-vw) - 40px);
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
  color: var(--text-link);
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

.dap-link {
  margin-top: 8px;
  padding: 0;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.dap-link:hover:not(:disabled) {
  color: var(--text-primary);
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
