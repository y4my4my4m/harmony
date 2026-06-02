<template>
  <div class="device-manager">
    <!-- Pending approvals (also surfaced globally; shown here for completeness) -->
    <div v-if="pendingApprovals.length" class="dm-pending">
      <div v-for="req in pendingApprovals" :key="req.id" class="dm-pending-row">
        <Icon name="alert-triangle" :size="18" class="dm-pending-icon" />
        <div class="dm-pending-info">
          <strong>New login{{ req.requesting_label ? ` on ${req.requesting_label}` : '' }}</strong>
          <span>Approve to let this device unlock your encrypted history.</span>
        </div>
        <div class="dm-pending-actions">
          <button class="btn btn-sm btn-primary" :disabled="busyId === req.id" @click="onApprove(req)">Approve</button>
          <button class="btn btn-sm btn-secondary" :disabled="busyId === req.id" @click="onDeny(req)">Deny</button>
        </div>
      </div>
    </div>

    <div v-if="loading" class="dm-loading">Loading devices…</div>

    <div v-else-if="devices.length === 0" class="dm-empty">
      No devices registered yet. They appear here once you unlock encryption.
    </div>

    <ul v-else class="dm-list">
      <li v-for="d in activeDevices" :key="d.id" class="dm-item" :class="{ revoked: !!d.revoked_at }">
        <Icon :name="platformIcon(d.platform)" :size="20" class="dm-item-icon" />
        <div class="dm-item-info">
          <div class="dm-item-label">
            <span v-if="editingId !== d.id">{{ d.label || 'Unknown device' }}</span>
            <input
              v-else
              v-model="editLabel"
              class="dm-rename-input"
              @keyup.enter="saveRename(d)"
              @keyup.esc="editingId = null"
            />
            <span v-if="d.device_id === thisDeviceId" class="dm-this">This device</span>
            <span class="dm-trust" :class="`trust-${d.revoked_at ? 'revoked' : d.trust_state}`">
              {{ trustLabel(d) }}
            </span>
          </div>
          <div class="dm-item-meta">
            {{ d.platform || 'device' }} · last active {{ formatTime(d.last_seen_at) }}
          </div>
        </div>
        <div class="dm-item-actions">
          <template v-if="editingId === d.id">
            <button class="btn btn-sm btn-primary" @click="saveRename(d)">Save</button>
            <button class="btn btn-sm btn-secondary" @click="editingId = null">Cancel</button>
          </template>
          <template v-else-if="!d.revoked_at">
            <button class="btn btn-sm btn-secondary" @click="startRename(d)">Rename</button>
            <button
              v-if="d.device_id !== thisDeviceId"
              class="btn btn-sm btn-danger"
              @click="onRevoke(d)"
            >Sign out</button>
          </template>
        </div>
      </li>
    </ul>

    <!-- Signed-out / inactive devices: collapsed by default so the list doesn't
         become a graveyard (every incognito login mints a fresh device). -->
    <div v-if="!loading && inactiveDevices.length" class="dm-inactive">
      <button class="dm-toggle" @click="showInactive = !showInactive">
        <Icon :name="showInactive ? 'chevron-down' : 'chevron-right'" :size="16" />
        {{ showInactive ? 'Hide' : 'Show' }} {{ inactiveDevices.length }} signed-out device{{ inactiveDevices.length === 1 ? '' : 's' }}
      </button>

      <ul v-if="showInactive" class="dm-list dm-list-inactive">
        <li v-for="d in inactiveDevices" :key="d.id" class="dm-item revoked">
          <Icon :name="platformIcon(d.platform)" :size="20" class="dm-item-icon" />
          <div class="dm-item-info">
            <div class="dm-item-label">
              <span>{{ d.label || 'Unknown device' }}</span>
              <span class="dm-trust trust-revoked">Signed out</span>
            </div>
            <div class="dm-item-meta">
              {{ d.platform || 'device' }} · last active {{ formatTime(d.last_seen_at) }}
            </div>
          </div>
          <div class="dm-item-actions">
            <button class="btn btn-sm btn-secondary" :disabled="busyId === d.id" @click="onDelete(d)">Remove</button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useDeviceApprovals } from '@/composables/useDeviceApprovals'
import { deviceIdentityService, type UserDevice, type DeviceApprovalRequest } from '@/services/encryption/DeviceIdentityService'
import { debug } from '@/utils/debug'

const { pendingApprovals, start, approve, deny } = useDeviceApprovals()

const devices = ref<UserDevice[]>([])
const loading = ref(true)
const thisDeviceId = deviceIdentityService.getDeviceId()
const editingId = ref<string | null>(null)
const editLabel = ref('')
const busyId = ref<string | null>(null)
const showInactive = ref(false)
let userId: string | null = null

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
  if (d.revoked_at) return 'Signed out'
  switch (d.trust_state) {
    case 'verified': return 'Verified'
    case 'recovery': return 'History unlocked'
    case 'account': return 'New messages only'
    case 'untrusted': return 'Limited'
    default: return d.trust_state
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return 'unknown'
  const date = new Date(iso)
  const diff = Date.now() - date.getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return date.toLocaleDateString()
}

async function loadDevices() {
  if (!userId) return
  loading.value = true
  try {
    devices.value = await deviceIdentityService.listAllDevices(userId)
  } catch (err) {
    debug.warn('⚠️ Failed to load devices:', err)
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
    debug.error('❌ Rename device failed:', err)
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
    debug.error('❌ Sign out device failed:', err)
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
    debug.error('❌ Remove device failed:', err)
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
    debug.warn('⚠️ DeviceManager init failed:', err)
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
.dm-empty {
  color: var(--text-secondary, #888);
  font-size: 13px;
  padding: 8px 0;
}

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
  color: var(--primary, #0EA5E9);
  background: rgba(14, 165, 233, 0.12);
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
.dm-trust.trust-recovery { color: #0EA5E9; background: rgba(14, 165, 233, 0.12); }
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

.btn-primary { background: var(--primary, #0EA5E9); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--primary-hover, #0284C7); }

.btn-secondary {
  background: var(--bg-tertiary, #3a3a4e);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #444);
}

.btn-danger { background: var(--danger, #e74c3c); color: #fff; }
.btn-danger:hover:not(:disabled) { background: #c0392b; }
</style>
