<template>
  <div class="device-manager">
    <div class="dm-link-row">
      <button class="btn btn-sm btn-primary" data-testid="link-device-button" @click="linkMode = 'scan'">
        <Icon name="qr-code" :size="16" />
        {{ $t('encryption.devices.linkDevice') }}
      </button>
      <span class="dm-link-hint">{{ $t('encryption.devices.linkHint') }}</span>
    </div>

    <!-- Pending approvals (also surfaced globally; shown here for completeness) -->
    <div v-if="pendingApprovals.length" class="dm-pending">
      <div v-for="req in pendingApprovals" :key="req.id" class="dm-pending-row">
        <Icon name="alert-triangle" :size="18" class="dm-pending-icon" />
        <div class="dm-pending-info">
          <strong>{{ req.requesting_label ? $t('encryption.approval.newLoginOn', { device: req.requesting_label }) : $t('encryption.approval.newLogin') }}</strong>
          <span v-if="isPairingRequest(req)">{{ $t('encryption.devices.pendingPairing') }}</span>
          <span v-else>{{ $t('encryption.devices.pendingPlain') }}</span>
        </div>
        <div class="dm-pending-actions">
          <button
            v-if="isPairingRequest(req)"
            class="btn btn-sm btn-primary"
            :disabled="busyId === req.id"
            @click="linkMode = 'scan'"
          >{{ $t('encryption.devices.scanCode') }}</button>
          <button v-else class="btn btn-sm btn-primary" :disabled="busyId === req.id" @click="onApprove(req)">{{ $t('encryption.approval.thatWasMe') }}</button>
          <button class="btn btn-sm btn-secondary" :disabled="busyId === req.id" @click="onDeny(req)">{{ $t('encryption.devices.deny') }}</button>
        </div>
      </div>
    </div>

    <div v-if="loading" class="dm-loading">{{ $t('security.sessions.loading') }}</div>

    <EmptyState
      v-else-if="devices.length === 0"
      size="sm"
      icon="devices"
      :title="$t('empty.devices.title')"
      :description="$t('empty.devices.description')"
    />

    <ul v-else class="dm-list">
      <li v-for="d in activeDevices" :key="d.id" class="dm-item" :class="{ revoked: !!d.revoked_at }">
        <Icon :name="platformIcon(d.platform)" :size="20" class="dm-item-icon" />
        <div class="dm-item-info">
          <div class="dm-item-label">
            <span v-if="editingId !== d.id">{{ d.label || $t('security.sessions.unknownDevice') }}</span>
            <input
              v-else
              v-model="editLabel"
              class="dm-rename-input"
              @keyup.enter="saveRename(d)"
              @keyup.esc="editingId = null"
            />
            <span v-if="d.device_id === thisDeviceId" class="dm-this">{{ $t('security.sessions.thisDevice') }}</span>
            <span class="dm-trust" :class="`trust-${d.revoked_at ? 'revoked' : d.trust_state}`">
              {{ trustLabel(d) }}
            </span>
          </div>
          <div class="dm-item-meta">
            {{ deviceMeta(d) }}
          </div>
        </div>
        <div class="dm-item-actions">
          <template v-if="editingId === d.id">
            <button class="btn btn-sm btn-primary" @click="saveRename(d)">{{ $t('common.save') }}</button>
            <button class="btn btn-sm btn-secondary" @click="editingId = null">{{ $t('common.cancel') }}</button>
          </template>
          <template v-else-if="!d.revoked_at">
            <button class="btn btn-sm btn-secondary" @click="startRename(d)">{{ $t('encryption.devices.rename') }}</button>
            <button
              v-if="d.device_id !== thisDeviceId"
              class="btn btn-sm btn-danger"
              @click="onRevoke(d)"
            >{{ $t('security.sessions.signOut') }}</button>
          </template>
        </div>
      </li>
    </ul>

    <!-- Signed-out / inactive devices: collapsed by default so the list doesn't
         become a graveyard (every incognito login mints a fresh device). -->
    <div v-if="!loading && inactiveDevices.length" class="dm-inactive">
      <button class="dm-toggle" @click="showInactive = !showInactive">
        <Icon :name="showInactive ? 'chevron-down' : 'chevron-right'" :size="16" />
        {{ $t(showInactive ? 'encryption.devices.hideInactive' : 'encryption.devices.showInactive', { count: inactiveDevices.length }, inactiveDevices.length) }}
      </button>

      <ul v-if="showInactive" class="dm-list dm-list-inactive">
        <li v-for="d in inactiveDevices" :key="d.id" class="dm-item revoked">
          <Icon :name="platformIcon(d.platform)" :size="20" class="dm-item-icon" />
          <div class="dm-item-info">
            <div class="dm-item-label">
              <span>{{ d.label || $t('security.sessions.unknownDevice') }}</span>
              <span class="dm-trust trust-revoked">{{ $t('encryption.devices.signedOut') }}</span>
            </div>
            <div class="dm-item-meta">
              {{ deviceMeta(d) }}
            </div>
          </div>
          <div class="dm-item-actions">
            <button class="btn btn-sm btn-secondary" :disabled="busyId === d.id" @click="onDelete(d)">{{ $t('common.remove') }}</button>
          </div>
        </li>
      </ul>
    </div>

    <DeviceLinkModal v-if="linkMode" :mode="linkMode" @close="onLinkClosed" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, defineAsyncComponent, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useDeviceApprovals } from '@/composables/useDeviceApprovals'
import {
  deviceIdentityService,
  isPairingRequest,
  type UserDevice,
  type DeviceApprovalRequest,
} from '@/services/encryption/DeviceIdentityService'
import { debug } from '@/utils/debug'

const DeviceLinkModal = defineAsyncComponent(() => import('./DeviceLinkModal.vue'))

const { pendingApprovals, start, approve, deny } = useDeviceApprovals()

const { t, locale } = useI18n()

const devices = ref<UserDevice[]>([])
const loading = ref(true)
const thisDeviceId = deviceIdentityService.getDeviceId()
const editingId = ref<string | null>(null)
const editLabel = ref('')
const busyId = ref<string | null>(null)
const showInactive = ref(false)
const linkMode = ref<'scan' | 'show' | null>(null)
let userId: string | null = null

function onLinkClosed() {
  linkMode.value = null
  void loadDevices()
}

const INACTIVE_IDLE_MS = 30 * 86400_000

// A device is "inactive" (collapsed) when signed out, or silent for a long
// time. The current device is always active.
function isInactive(d: UserDevice): boolean {
  if (d.device_id === thisDeviceId) return false
  if (d.revoked_at) return true
  const lastSeen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : new Date(d.created_at).getTime()
  return Date.now() - lastSeen > INACTIVE_IDLE_MS
}

const activeDevices = computed(() => devices.value.filter(d => !isInactive(d)))
const inactiveDevices = computed(() => devices.value.filter(isInactive))

function platformIcon(platform: string | null): string {
  if (platform === 'desktop') return 'monitor'
  if (platform === 'mobile') return 'smartphone'
  return 'globe'
}

function trustLabel(d: UserDevice): string {
  if (d.revoked_at) return t('encryption.devices.signedOut')
  switch (d.trust_state) {
    case 'verified': return t('encryption.devices.trust.verified')
    case 'recovery': return t('encryption.devices.trust.recovery')
    case 'account': return t('encryption.devices.trust.account')
    case 'untrusted': return t('encryption.devices.trust.untrusted')
    default: return d.trust_state
  }
}

function platformLabel(platform: string | null): string {
  switch (platform) {
    case 'web': return t('encryption.devices.platform.web')
    case 'desktop': return t('encryption.devices.platform.desktop')
    case 'mobile': return t('encryption.devices.platform.mobile')
    case null:
    case '': return t('encryption.devices.platform.other')
    default: return platform
  }
}

function deviceMeta(d: UserDevice): string {
  return t('encryption.devices.lastActive', { platform: platformLabel(d.platform), time: formatTime(d.last_seen_at) })
}

function formatTime(iso: string | null): string {
  if (!iso) return t('security.sessions.unknown')
  const date = new Date(iso)
  const diff = Date.now() - date.getTime()
  if (diff < 60000) return t('time.justNow')
  if (diff < 3600000) return t('encryption.devices.minutesAgo', { count: Math.floor(diff / 60000) })
  if (diff < 86400000) return t('encryption.devices.hoursAgo', { count: Math.floor(diff / 3600000) })
  return date.toLocaleDateString(locale.value)
}

async function loadDevices() {
  if (!userId) return
  loading.value = true
  try {
    devices.value = await deviceIdentityService.listAllDevices(userId)
  } catch (err) {
    debug.warn('Failed to load devices:', err)
  } finally {
    loading.value = false
  }
}

function startRename(d: UserDevice) {
  editingId.value = d.id
  editLabel.value = d.label || ''
}

async function saveRename(d: UserDevice) {
  const label = editLabel.value.trim()
  editingId.value = null
  if (!label || label === d.label) return
  busyId.value = d.id
  try {
    await deviceIdentityService.renameDevice(d.device_id, label)
    await loadDevices()
  } catch (err) {
    debug.error('Rename device failed:', err)
  } finally {
    busyId.value = null
  }
}

async function onRevoke(d: UserDevice) {
  busyId.value = d.id
  try {
    await deviceIdentityService.revokeDevice(d.device_id)
    await loadDevices()
  } catch (err) {
    debug.error('Sign out device failed:', err)
  } finally {
    busyId.value = null
  }
}

async function onDelete(d: UserDevice) {
  busyId.value = d.id
  try {
    await deviceIdentityService.deleteDevice(d.device_id)
    await loadDevices()
  } catch (err) {
    debug.error('Remove device failed:', err)
  } finally {
    busyId.value = null
  }
}

async function onApprove(req: DeviceApprovalRequest) {
  busyId.value = req.id
  try {
    await approve(req)
    await loadDevices()
  } finally {
    busyId.value = null
  }
}

async function onDeny(req: DeviceApprovalRequest) {
  busyId.value = req.id
  try {
    await deny(req)
    await loadDevices()
  } finally {
    busyId.value = null
  }
}

onMounted(async () => {
  try {
    const { authContextService } = await import('@/services/AuthContextService')
    const ctx = await authContextService.getCurrentContext()
    if (ctx.isAuthenticated && ctx.profileId) {
      userId = ctx.profileId
      await start(ctx.profileId)
      // Garbage-collect long-dead rows so the list stays manageable, then load.
      await deviceIdentityService.pruneStaleDevices(ctx.profileId).catch(() => 0)
      await loadDevices()
    } else {
      loading.value = false
    }
  } catch (err) {
    debug.warn('DeviceManager init failed:', err)
    loading.value = false
  }
})
</script>

<style scoped>
.device-manager {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dm-link-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.dm-link-hint {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.dm-pending {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dm-pending-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: rgba(241, 196, 15, 0.08);
  border: 1px solid rgba(241, 196, 15, 0.35);
  border-radius: 8px;
}

.dm-pending-icon {
  color: var(--warning, #f1c40f);
  flex-shrink: 0;
}

.dm-pending-info {
  flex: 1;
  min-width: 0;
}

.dm-pending-info strong {
  display: block;
  color: var(--text-primary, #fff);
  font-size: 14px;
}

.dm-pending-info span {
  color: var(--text-secondary, #aaa);
  font-size: 12px;
}

.dm-pending-actions {
  display: flex;
  gap: 8px;
}

.dm-loading,
.dm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dm-inactive {
  margin-top: 12px;
}

.dm-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  color: var(--text-secondary, #888);
  font-size: 13px;
  cursor: pointer;
  padding: 4px 0;
}

.dm-toggle:hover { color: var(--text-primary, #fff); }

.dm-list-inactive {
  margin-top: 8px;
}

.dm-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  background: var(--bg-secondary, #2a2a3e);
  border-radius: 8px;
}

.dm-item.revoked {
  opacity: 0.55;
}

.dm-item-icon {
  flex-shrink: 0;
  color: var(--text-secondary, #aaa);
}

.dm-item-info {
  flex: 1;
  min-width: 0;
}

.dm-item-label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary, #fff);
  font-weight: 500;
  font-size: 14px;
  flex-wrap: wrap;
}

.dm-this {
  font-size: 11px;
  font-weight: 600;
  color: var(--primary, var(--harmony-primary));
  background: color-mix(in srgb, var(--harmony-primary) 12%, transparent);
  padding: 2px 6px;
  border-radius: 4px;
}

.dm-trust {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-secondary, #aaa);
  background: var(--bg-tertiary, #3a3a4e);
}

.dm-trust.trust-verified { color: #27ae60; background: rgba(39, 174, 96, 0.12); }
.dm-trust.trust-recovery { color: var(--text-link); background: color-mix(in srgb, var(--harmony-primary) 12%, transparent); }
.dm-trust.trust-account { color: #f1c40f; background: rgba(241, 196, 15, 0.12); }
.dm-trust.trust-revoked,
.dm-trust.trust-untrusted { color: #e74c3c; background: rgba(231, 76, 60, 0.12); }

.dm-item-meta {
  font-size: 12px;
  color: var(--text-secondary, #888);
  margin-top: 2px;
}

.dm-item-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.dm-rename-input {
  background: var(--bg-tertiary, #3a3a4e);
  border: 1px solid var(--border-color, #444);
  border-radius: 6px;
  color: var(--text-primary, #fff);
  padding: 4px 8px;
  font-size: 14px;
}

.btn {
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: all 0.15s;
}

.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { padding: 6px 12px; }

.btn-primary { background: var(--harmony-primary-fill); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--harmony-primary-fill-hover); }

.btn-secondary {
  background: var(--bg-tertiary, #3a3a4e);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #444);
}

.btn-danger { background: var(--danger, #e74c3c); color: #fff; }
.btn-danger:hover:not(:disabled) { background: #c0392b; }
</style>
