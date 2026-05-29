<template>
  <Teleport to="body">
    <transition name="device-approval-fade">
      <div v-if="current" class="device-approval-card" role="dialog" aria-live="polite">
        <div class="dap-icon">
          <Icon name="smartphone" :size="22" />
        </div>
        <div class="dap-body">
          <strong class="dap-title">New login{{ current.requesting_label ? ` on ${current.requesting_label}` : '' }}</strong>
          <p class="dap-text">
            Someone just signed in to your account. If this was you, approve it to unlock your
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
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useDeviceApprovals } from '@/composables/useDeviceApprovals'
import type { DeviceApprovalRequest } from '@/services/encryption/DeviceIdentityService'
import { debug } from '@/utils/debug'

const { pendingApprovals, start, approve, deny } = useDeviceApprovals()
const busy = ref(false)

// Show one prompt at a time (the most recent); the rest queue behind it.
const current = computed<DeviceApprovalRequest | null>(() => pendingApprovals.value[0] || null)

async function onApprove() {
  if (!current.value || busy.value) return
  busy.value = true
  try {
    await approve(current.value)
  } catch (err) {
    debug.warn('⚠️ Approve device failed:', err)
  } finally {
    busy.value = false
  }
}

async function onDeny() {
  if (!current.value || busy.value) return
  busy.value = true
  try {
    await deny(current.value)
  } catch (err) {
    debug.warn('⚠️ Deny device failed:', err)
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
    debug.warn('⚠️ Device-approval prompt init failed:', err)
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
  background: var(--bg-primary, #1a1a2e);
  border: 1px solid var(--warning, #f1c40f);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}

.dap-icon {
  flex-shrink: 0;
  color: var(--warning, #f1c40f);
}

.dap-body {
  flex: 1;
  min-width: 0;
}

.dap-title {
  display: block;
  color: var(--text-primary, #fff);
  font-size: 15px;
  margin-bottom: 4px;
}

.dap-text {
  color: var(--text-secondary, #aaa);
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
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: background 0.15s;
}

.dap-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dap-btn-approve {
  background: var(--success, #27ae60);
  color: #fff;
}

.dap-btn-approve:hover:not(:disabled) {
  background: #219150;
}

.dap-btn-deny {
  background: var(--bg-secondary, #2a2a3e);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #444);
}

.dap-btn-deny:hover:not(:disabled) {
  background: var(--bg-tertiary, #3a3a4e);
}

.dap-more {
  margin: 10px 0 0 0;
  font-size: 12px;
  color: var(--text-secondary, #888);
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
