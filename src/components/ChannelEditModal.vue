<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click="closeModal">
      <div class="modal-container" @click.stop>
        <div class="modal-header">
          <h2 class="modal-title">Edit Channel</h2>
          <button class="modal-close" @click="closeModal">
            <svg width="24" height="24" viewBox="0 0 24 24">
              <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
            </svg>
          </button>
        </div>

        <!-- Tabs -->
        <div class="modal-tabs">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="modal-tab"
            :class="{ active: activeTab === tab.id }"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>

        <div class="modal-body">
          <!-- General tab -->
          <template v-if="activeTab === 'general'">
            <div class="form-group">
              <label for="channel-name">Channel Name</label>
              <input
                id="channel-name"
                v-model="editedName"
                type="text"
                class="form-input"
                placeholder="Enter channel name"
                maxlength="100"
                @keydown.enter="saveChanges"
                @keydown.escape="closeModal"
                ref="nameInput"
              />
              <div class="character-count">{{ editedName.length }}/100</div>
            </div>

            <div class="form-group">
              <label for="channel-description">Description</label>
              <textarea
                id="channel-description"
                v-model="editedDescription"
                class="form-textarea"
                placeholder="What's this channel about?"
                maxlength="1024"
                rows="3"
              />
              <div class="character-count">{{ (editedDescription || '').length }}/1024</div>
            </div>

            <div class="form-group">
              <label>Channel Type</label>
              <div class="channel-type-display">
                <div class="channel-type-icon">
                  <HashTagIcon v-if="channel?.type === 0" />
                  <SpeakerIcon v-else />
                </div>
                <span>{{ channel?.type === 0 ? 'Text Channel' : 'Voice Channel' }}</span>
              </div>
              <div class="form-hint">Channel type cannot be changed after creation</div>
            </div>
          </template>

          <!-- Permissions tab -->
          <template v-else-if="activeTab === 'permissions'">
            <div class="perm-layout">
              <!-- Role rail (left) - Discord-style role list -->
              <aside class="perm-role-rail">
                <div class="perm-rail-label">Roles</div>
                <button
                  v-for="role in serverRoles"
                  :key="role.id"
                  type="button"
                  class="perm-role-pill"
                  :class="{ active: selectedRoleId === role.id, dirty: isRoleDirty(role.id) }"
                  @click="selectedRoleId = role.id"
                >
                  <span class="role-color-dot" :style="{ background: role.color || '#99aab5' }"></span>
                  <span class="role-pill-name">{{ role.name }}</span>
                  <span v-if="isRoleDirty(role.id)" class="role-pill-dot" title="Unsaved changes"></span>
                </button>
                <div v-if="!rolesLoading && serverRoles.length === 0" class="perm-empty-mini">
                  No roles
                </div>
              </aside>

              <!-- Permission editor (right) -->
              <section class="perm-editor">
                <div v-if="rolesLoading" class="perm-loading">Loading roles...</div>
                <template v-else-if="selectedRole">
                  <header class="perm-editor-head">
                    <div class="perm-editor-title">
                      <span class="role-color-dot" :style="{ background: selectedRole.color || '#99aab5' }"></span>
                      <h4>{{ selectedRole.name }}</h4>
                    </div>
                    <p class="perm-editor-sub">
                      <strong>Allow</strong> grants, <strong>Deny</strong> revokes, <strong>Inherit</strong> uses the server-wide setting.
                      <button v-if="isRoleDirty(selectedRole.id)" type="button" class="perm-reset-link" @click="resetRole(selectedRole.id)">
                        Reset changes
                      </button>
                    </p>
                  </header>

                  <div
                    v-for="group in PERMISSION_GROUPS"
                    :key="group.id"
                    class="perm-group"
                  >
                    <div class="perm-group-label">{{ group.label }}</div>
                    <div
                      v-for="perm in group.permissions"
                      :key="perm.key"
                      class="perm-row"
                    >
                      <div class="perm-row-text">
                        <span class="perm-row-label">{{ perm.label }}</span>
                        <span class="perm-row-desc">{{ perm.description }}</span>
                      </div>
                      <div class="perm-tristate" role="radiogroup" :aria-label="perm.label">
                        <button
                          v-for="state in TRISTATE_OPTIONS"
                          :key="state.value"
                          type="button"
                          class="perm-tristate-btn"
                          :class="[
                            `state-${state.value}`,
                            { active: getPermState(selectedRole.id, perm.key) === state.value },
                          ]"
                          :title="state.label"
                          @click="setPermState(selectedRole.id, perm.key, state.value)"
                        >
                          {{ state.icon }}
                        </button>
                      </div>
                    </div>
                  </div>
                </template>
                <div v-else class="perm-empty">Select a role on the left to edit its channel overrides.</div>
              </section>
            </div>
          </template>
        </div>

        <div class="modal-footer">
          <button class="btn btn-secondary" @click="closeModal">
            Cancel
          </button>
          <button
            v-if="activeTab === 'general'"
            class="btn btn-primary"
            @click="saveChanges"
            :disabled="!isValidName || isLoading"
          >
            <span v-if="isLoading" class="loading-spinner"></span>
            {{ isLoading ? 'Saving...' : 'Save Changes' }}
          </button>
          <button
            v-else
            class="btn btn-primary"
            @click="savePermissions"
            :disabled="!permissionsDirty || savingPermissions"
          >
            <span v-if="savingPermissions" class="loading-spinner"></span>
            {{ savingPermissions ? 'Saving...' : 'Save Permissions' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { useServerChannelStore } from '@/stores/useServerChannel'
import HashTagIcon from '@/components/icons/HashTag.vue'
import SpeakerIcon from '@/components/icons/Speaker.vue'
import {
  roleService,
  Permission,
  bitmaskToPermissions,
  type ServerRole,
} from '@/services/RoleService'
import type { Channel } from '@/types'

type TriState = 'allow' | 'inherit' | 'deny'

const TRISTATE_OPTIONS: Array<{ value: TriState; label: string; icon: string }> = [
  { value: 'deny', label: 'Deny', icon: '✕' },
  { value: 'inherit', label: 'Inherit from server', icon: '／' },
  { value: 'allow', label: 'Allow', icon: '✓' },
]

// Permissions are grouped Discord-style so the modal doesn't read as one
// flat wall of toggles. Editing OTHER people's messages is intentionally
// not exposed here - it's owner/admin-only and lives outside the
// channel-override surface. MANAGE_MESSAGES is delete+pin only.
const PERMISSION_GROUPS: Array<{
  id: string
  label: string
  permissions: Array<{ key: Permission; label: string; description: string }>
}> = [
  {
    id: 'general',
    label: 'General',
    permissions: [
      { key: Permission.VIEW_CHANNEL,    label: 'View Channel',    description: 'See this channel in the sidebar and read messages.' },
      { key: Permission.MANAGE_CHANNELS, label: 'Manage Channel',  description: 'Rename, edit, or delete this channel.' },
    ],
  },
  {
    id: 'messages',
    label: 'Messages',
    permissions: [
      { key: Permission.SEND_MESSAGES,         label: 'Send Messages',         description: 'Post messages in this channel.' },
      { key: Permission.EMBED_LINKS,           label: 'Embed Links',           description: 'Send embeds and link previews.' },
      { key: Permission.ATTACH_FILES,          label: 'Attach Files',          description: 'Upload files in this channel.' },
      { key: Permission.ADD_REACTIONS,         label: 'Add Reactions',         description: 'React to messages with emoji.' },
      { key: Permission.USE_EXTERNAL_EMOJIS,   label: 'Use External Emojis',   description: 'Send emojis from other servers.' },
      { key: Permission.MENTION_EVERYONE,      label: 'Mention @everyone',     description: 'Use @everyone and @here.' },
      { key: Permission.MANAGE_MESSAGES,       label: 'Manage Messages',       description: 'Delete and pin other members\' messages. Does NOT allow editing.' },
      { key: Permission.READ_MESSAGE_HISTORY,  label: 'Read Message History',  description: 'See messages posted before they joined.' },
    ],
  },
  {
    id: 'threads',
    label: 'Threads',
    permissions: [
      { key: Permission.CREATE_PUBLIC_THREADS,  label: 'Create Public Threads',  description: 'Start public threads from messages.' },
      { key: Permission.CREATE_PRIVATE_THREADS, label: 'Create Private Threads', description: 'Start invite-only threads.' },
      { key: Permission.SEND_MESSAGES_IN_THREADS, label: 'Send in Threads',      description: 'Post messages inside threads.' },
    ],
  },
]

// Flat list (used by load/save). Order doesn't matter for storage.
const editablePermissions = PERMISSION_GROUPS.flatMap(g => g.permissions)

interface Props {
  show: boolean
  channel: Channel | null
}

interface Emits {
  (e: 'close'): void
  (e: 'updated', channel: Channel): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const serverChannelStore = useServerChannelStore()

const editedName = ref('')
const editedDescription = ref('')
const isLoading = ref(false)
const nameInput = ref<HTMLInputElement>()

const isValidName = computed(() => {
  return editedName.value.trim().length > 0 && editedName.value.trim().length <= 100
})

const closeModal = () => {
  emit('close')
}

const saveChanges = async () => {
  if (!props.channel || !isValidName.value || isLoading.value) return
  
  const trimmedName = editedName.value.trim()
  const trimmedDescription = editedDescription.value?.trim() || null
  
  // Check if anything actually changed
  if (trimmedName === props.channel.name && trimmedDescription === props.channel.description) {
    closeModal()
    return
  }
  
  isLoading.value = true
  
  try {
    await serverChannelStore.updateChannel({
      id: props.channel.id,
      name: trimmedName,
      description: trimmedDescription ?? undefined
    })
    
    // Emit updated event with the updated channel data
    const updatedChannel = { 
      ...props.channel, 
      name: trimmedName, 
      description: trimmedDescription 
    } as any
    emit('updated', updatedChannel)
    closeModal()
  } catch (error: any) {
    debug.error('Failed to update channel:', error)
    const toast = useToast()
    toast.error(error?.message || 'Failed to update channel. Please try again.')
  } finally {
    isLoading.value = false
  }
}

// Watch for channel changes to reset form
watch(() => props.channel, (newChannel) => {
  if (newChannel) {
    editedName.value = newChannel.name || ''
    editedDescription.value = newChannel.description || ''
  }
}, { immediate: true })

// Focus input when modal opens
watch(() => props.show, (isVisible) => {
  if (isVisible) {
    nextTick(() => {
      nameInput.value?.focus()
      nameInput.value?.select()
    })
  }
})

// =========================================================================
// Tabs + Permissions tab state
// =========================================================================

const tabs = [
  { id: 'general' as const, label: 'General' },
  { id: 'permissions' as const, label: 'Permissions' },
]
const activeTab = ref<'general' | 'permissions'>('general')

const serverRoles = ref<ServerRole[]>([])
const rolesLoading = ref(false)
const savingPermissions = ref(false)

/**
 * Per-role tri-state map for this channel's overrides.
 * Structure: { [roleId]: { [Permission]: 'allow' | 'deny' | 'inherit' } }
 *
 * 'inherit' = no row in channel_permission_overrides (or the bit is 0 in both
 * allow_permissions and deny_permissions).
 * 'allow'   = bit set in allow_permissions.
 * 'deny'    = bit set in deny_permissions.
 *
 * We keep two copies (initial + working) to detect dirty state and only persist
 * roles whose permissions actually changed.
 */
const initialPermState = ref<Record<string, Partial<Record<Permission, TriState>>>>({})
const workingPermState = ref<Record<string, Partial<Record<Permission, TriState>>>>({})
const selectedRoleId = ref<string | null>(null)

const selectedRole = computed(() =>
  serverRoles.value.find(r => r.id === selectedRoleId.value) || null,
)

function isRoleDirty(roleId: string): boolean {
  const a = initialPermState.value[roleId] ?? {}
  const b = workingPermState.value[roleId] ?? {}
  return JSON.stringify(a) !== JSON.stringify(b)
}

function resetRole(roleId: string) {
  workingPermState.value[roleId] = JSON.parse(
    JSON.stringify(initialPermState.value[roleId] ?? {}),
  )
}

const permissionsDirty = computed(() => {
  return JSON.stringify(initialPermState.value) !== JSON.stringify(workingPermState.value)
})

function getPermState(roleId: string, perm: Permission): TriState {
  return workingPermState.value[roleId]?.[perm] ?? 'inherit'
}

function setPermState(roleId: string, perm: Permission, state: TriState) {
  if (!workingPermState.value[roleId]) workingPermState.value[roleId] = {}
  workingPermState.value[roleId][perm] = state
}

async function loadPermissions() {
  if (!props.channel?.server_id) return
  rolesLoading.value = true
  try {
    const [roles, overrides] = await Promise.all([
      roleService.getRolesForServer(props.channel.server_id),
      roleService.getChannelOverrides(props.channel.id),
    ])
    // Sort by position descending (highest-role-first), matching the role manager.
    serverRoles.value = [...roles].sort((a, b) => b.position - a.position)

    const state: typeof initialPermState.value = {}
    for (const role of serverRoles.value) {
      state[role.id] = {}
    }
    for (const ov of overrides) {
      if (ov.target_type !== 'role' || !ov.role_id) continue
      const allowMap = bitmaskToPermissions(BigInt(ov.allow_permissions ?? 0))
      const denyMap = bitmaskToPermissions(BigInt(ov.deny_permissions ?? 0))
      if (!state[ov.role_id]) state[ov.role_id] = {}
      for (const perm of editablePermissions) {
        if (allowMap[perm.key]) state[ov.role_id][perm.key] = 'allow'
        else if (denyMap[perm.key]) state[ov.role_id][perm.key] = 'deny'
      }
    }

    initialPermState.value = JSON.parse(JSON.stringify(state))
    workingPermState.value = JSON.parse(JSON.stringify(state))
    // Auto-select @everyone (or the first role) so the editor pane isn't blank.
    if (!selectedRoleId.value || !serverRoles.value.some(r => r.id === selectedRoleId.value)) {
      const everyone = serverRoles.value.find(r => r.is_default) || serverRoles.value[0]
      selectedRoleId.value = everyone?.id ?? null
    }
  } catch (err) {
    debug.error('Failed to load channel permissions:', err)
    const t = useToast()
    t.error('Failed to load channel permissions')
  } finally {
    rolesLoading.value = false
  }
}

async function savePermissions() {
  if (!props.channel || savingPermissions.value || !permissionsDirty.value) return
  savingPermissions.value = true
  const t = useToast()
  try {
    for (const role of serverRoles.value) {
      const before = initialPermState.value[role.id] ?? {}
      const after = workingPermState.value[role.id] ?? {}
      // Skip roles whose state didn't change.
      if (JSON.stringify(before) === JSON.stringify(after)) continue

      const allow: Partial<Record<Permission, boolean>> = {}
      const deny: Partial<Record<Permission, boolean>> = {}
      for (const perm of editablePermissions) {
        const s = after[perm.key] ?? 'inherit'
        if (s === 'allow') allow[perm.key] = true
        else if (s === 'deny') deny[perm.key] = true
      }

      const ok = await roleService.setChannelOverride(
        props.channel.id,
        'role',
        role.id,
        allow,
        deny,
      )
      if (!ok) throw new Error(`Failed to save override for ${role.name}`)
    }

    initialPermState.value = JSON.parse(JSON.stringify(workingPermState.value))
    t.success('Channel permissions saved')
  } catch (err: any) {
    debug.error('Failed to save channel permissions:', err)
    t.error(err?.message || 'Failed to save channel permissions')
  } finally {
    savingPermissions.value = false
  }
}

// Load permissions when the Permissions tab is first opened (lazy)
watch([() => props.show, activeTab, () => props.channel?.id], ([visible, tab]) => {
  if (visible && tab === 'permissions' && serverRoles.value.length === 0) {
    void loadPermissions()
  }
})

// Reset to General tab when modal closes
watch(() => props.show, (visible) => {
  if (!visible) {
    activeTab.value = 'general'
    serverRoles.value = []
    initialPermState.value = {}
    workingPermState.value = {}
    selectedRoleId.value = null
  }
})
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.15s ease-out;
}

.modal-container {
  background: var(--background-secondary);
  border-radius: 10px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  width: 100%;
  max-width: 480px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slideUp 0.15s ease-out;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.modal-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.modal-close:hover {
  background: var(--background-quinary);
  color: var(--text-secondary);
}

.modal-body {
  padding: 24px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.form-input {
  width: 100%;
  background: var(--background-quinary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  padding: 12px;
  color: var(--text-secondary);
  font-size: 1rem;
  transition: border-color 0.15s ease;
}

.form-input:focus {
  outline: none;
  border-color: #0EA5E9;
}

.form-textarea {
  width: 100%;
  background: var(--background-quinary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  padding: 12px;
  color: var(--text-secondary);
  font-size: 1rem;
  resize: vertical;
  min-height: 80px;
  font-family: inherit;
  transition: border-color 0.15s ease;
}

.form-textarea:focus {
  outline: none;
  border-color: #0EA5E9;
}

.character-count {
  font-size: 0.75rem;
  color: var(--text-muted);
  text-align: right;
  margin-top: 4px;
}

.channel-type-display {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: var(--background-tertiary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  color: var(--text-secondary);
}

.channel-type-icon {
  display: flex;
  align-items: center;
  color: var(--text-muted);
}

.form-hint {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 4px;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--border-color);
  background: var(--background-secondary);
  flex-shrink: 0;
}

.btn {
  padding: 10px 20px;
  border: none;
  border-radius: 4px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--background-quinary);
  color: var(--text-secondary);
}

.btn-primary {
  background: var(--harmony-primary);
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  background: #0284C7;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid transparent;
  border-top: 2px solid currentColor;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .modal-container {
    margin: 20px;
    max-width: none;
  }
  
  .modal-header {
    padding: 16px 20px;
  }
  
  .modal-body {
    padding: 20px;
  }
  
  .modal-footer {
    padding: 12px 20px;
    flex-direction: column-reverse;
  }
  
  .btn {
    width: 100%;
    justify-content: center;
  }
}

/* =========================================================================
   Tabs
   ======================================================================= */
.modal-tabs {
  display: flex;
  gap: 4px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.modal-tab {
  background: none;
  border: none;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}

.modal-tab:hover {
  color: var(--text-primary);
}

.modal-tab.active {
  color: var(--harmony-primary, #0EA5E9);
  border-bottom-color: var(--harmony-primary, #0EA5E9);
}

/* Wider modal so the rail + editor layout breathes */
.modal-container {
  max-width: 760px;
}

/* =========================================================================
   Permissions tab - Discord-style rail + editor layout
   ======================================================================= */
.perm-layout {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 20px;
  min-height: 360px;
}

.perm-role-rail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 4px;
  border-right: 1px solid var(--border-color);
}

.perm-rail-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 0 8px 8px;
}

.perm-role-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s, color 0.12s;
}

.perm-role-pill:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-primary);
}

.perm-role-pill.active {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.perm-role-pill .role-pill-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.role-pill-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--harmony-primary, #0EA5E9);
  flex-shrink: 0;
}

.perm-empty-mini {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.perm-editor {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.perm-editor-head {
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 12px;
}

.perm-editor-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.perm-editor-title h4 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.perm-editor-sub {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.perm-reset-link {
  background: none;
  border: none;
  padding: 0;
  font-size: 12px;
  color: var(--harmony-primary, #0EA5E9);
  cursor: pointer;
  text-decoration: underline;
}

.perm-group {
  display: flex;
  flex-direction: column;
}

.perm-group-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  margin: 8px 0 4px;
}

.perm-loading,
.perm-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
}

.role-color-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

.perm-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-top: 1px solid var(--border-color);
}

.perm-group .perm-row:first-of-type {
  border-top: none;
}

.perm-row-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.perm-row-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.perm-row-desc {
  font-size: 11px;
  color: var(--text-secondary);
}

/* Tri-state allow/inherit/deny toggle - Discord-style three-button group */
.perm-tristate {
  display: inline-flex;
  background: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}

.perm-tristate-btn {
  width: 36px;
  height: 28px;
  background: transparent;
  border: none;
  color: var(--text-tertiary, var(--text-secondary));
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
  transition: background 0.15s, color 0.15s;
}

.perm-tristate-btn:hover {
  background: rgba(255, 255, 255, 0.05);
}

.perm-tristate-btn.active.state-allow {
  background: rgba(59, 165, 92, 0.18);
  color: #3ba55c;
}

.perm-tristate-btn.active.state-deny {
  background: rgba(237, 66, 69, 0.18);
  color: #ed4245;
}

.perm-tristate-btn.active.state-inherit {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}
</style>
