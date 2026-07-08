<template>
  <!-- =====================================================================
       Roles - two-pane layout matching ChannelEditModal:
         - Left rail: list of roles (drag-reorderable), with color dot,
           member count, and a "dirty" indicator when there are unsaved
           changes for that role.
         - Right pane: tabbed editor (Display / Permissions / Members) for
           the selected role.
       This intentionally drops the old slide-over editor - at this width
       both panes fit comfortably and you can hop between roles without
       losing the rail.
       ===================================================================== -->
  <div class="role-management">
    <!-- Header (full width) -->
    <header class="management-header">
      <div class="header-text">
        <h2>Roles</h2>
        <p>Create and manage roles for your server. Drag to reorder priority.</p>
      </div>
      <button class="create-role-btn" @click="createRole">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
        </svg>
        Create Role
      </button>
    </header>

    <div class="role-layout">
      <!-- ===== Left rail: role list ===== -->
      <aside class="role-rail">
        <div class="rail-section-label">
          {{ roles.length }} {{ roles.length === 1 ? 'role' : 'roles' }}
        </div>

        <div v-if="loading" class="rail-loading">
          <div class="spinner small"></div>
        </div>

        <draggable
          v-else
          v-model="roles"
          item-key="id"
          handle=".drag-handle"
          @end="handleReorder"
          class="rail-list"
        >
          <template #item="{ element: role }">
            <button
              type="button"
              class="role-pill"
              :class="{ active: selectedRole?.id === role.id }"
              @click="selectRole(role)"
            >
              <span class="drag-handle" v-if="!role.is_default" title="Drag to reorder">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="
                    M9 3a2 2 0 1 0 .001 0zm6 0a2 2 0 1 0 .001 0z
                    M9 10a2 2 0 1 0 .001 0zm6 0a2 2 0 1 0 .001 0z
                    M9 17a2 2 0 1 0 .001 0zm6 0a2 2 0 1 0 .001 0z
                  "/>
                </svg>
              </span>
              <span class="drag-handle-spacer" v-else></span>
              <span class="role-color" :style="{ background: role.color || '#99AAB5' }"></span>
              <span class="role-pill-name">{{ role.name }}</span>
              <span v-if="role.is_admin" class="role-badge admin">Admin</span>
              <span v-else-if="role.is_default" class="role-badge default">Default</span>
              <span v-if="isThisRoleDirty(role.id)" class="role-pill-dot" title="Unsaved changes"></span>
              <span class="role-pill-count">{{ getRoleDisplayCount(role) }}</span>
            </button>
          </template>
        </draggable>
      </aside>

      <!-- ===== Right pane: editor ===== -->
      <section class="role-editor">
        <!-- Empty state when no role selected -->
        <div v-if="!selectedRole" class="editor-empty">
          <p>Select a role on the left to edit it, or create a new one.</p>
        </div>

        <template v-else>
          <!-- Editor header -->
          <header class="editor-head">
            <div class="editor-title">
              <span class="role-color" :style="{ background: selectedRole.color || '#99AAB5' }"></span>
              <h3>{{ selectedRole.name }}</h3>
              <span v-if="selectedRole.is_admin" class="role-badge admin">Admin</span>
              <span v-else-if="selectedRole.is_default" class="role-badge default">Default</span>
            </div>
            <div class="editor-tabs">
              <button
                v-for="tab in editorTabs"
                :key="tab.id"
                type="button"
                class="tab-btn"
                :class="{ active: activeTab === tab.id }"
                @click="activeTab = tab.id"
              >
                {{ tab.label }}
              </button>
            </div>
          </header>

          <div class="editor-content">
          <!-- Display Tab -->
          <div v-if="activeTab === 'display'" class="tab-content">
            <div class="form-group">
              <label>Role Name</label>
              <input
                v-model="editForm.name"
                type="text"
                class="form-input"
                :disabled="selectedRole.is_default"
                placeholder="Role name"
                maxlength="100"
              />
              <p v-if="selectedRole.is_default" class="form-help">
                The @everyone role's name cannot be changed.
              </p>
            </div>

            <div class="form-group">
              <label>Role Color</label>
              <ColorPicker
                :color="editForm.color || '#99AAB5'"
                @update:color="editForm.color = $event"
                @change="editForm.color = $event"
              />
            </div>

            <div class="form-group toggle-row">
              <div class="toggle-info">
                <span class="toggle-title">Display role members separately</span>
                <p class="form-help">Members with this role will be shown in their own group in the member list.</p>
              </div>
              <ToggleSwitch v-model="editForm.hoist" />
            </div>

            <div class="form-group toggle-row">
              <div class="toggle-info">
                <span class="toggle-title">Allow anyone to @mention this role</span>
                <p class="form-help">When off, only members with <em>Mention @everyone</em> can ping it.</p>
              </div>
              <ToggleSwitch v-model="editForm.mentionable" />
            </div>
          </div>

          <!-- Permissions Tab -->
          <div v-if="activeTab === 'permissions'" class="tab-content">
            <p class="perm-intro">
              Server-wide permissions for this role. Per-channel overrides
              (Allow / Deny / Inherit) are configured in each channel's
              <strong>Permissions</strong> tab.
            </p>
            <div
              v-for="section in permissionSections"
              :key="section.id"
              class="perm-group"
              :class="{ 'perm-group-dangerous': section.id === 'dangerous' }"
            >
              <div class="perm-group-head">
                <span class="perm-group-label">{{ section.title }}</span>
                <span v-if="section.id === 'dangerous'" class="perm-group-warn">
                  Grants every other permission and bypasses all channel overrides.
                </span>
              </div>
              <div
                v-for="perm in section.permissions"
                :key="perm.key"
                class="perm-row"
              >
                <div class="perm-row-text">
                  <span class="perm-row-label">{{ perm.label }}</span>
                  <span class="perm-row-desc">{{ perm.description }}</span>
                </div>
                <ToggleSwitch
                  :model-value="hasPermission(perm.key)"
                  :disabled="selectedRole.is_admin && perm.key === 'ADMINISTRATOR'"
                  @update:model-value="togglePermission(perm.key)"
                />
              </div>
            </div>
          </div>

          <!-- Members Tab -->
          <div v-if="activeTab === 'members'" class="tab-content">
            <!-- @everyone is everyone; no member roster -->
            <div v-if="selectedRole.is_default" class="members-everyone-note">
              <p>
                The <strong>@everyone</strong> role applies to every member of
                this server automatically. There's no roster to manage.
              </p>
            </div>

            <template v-else>
              <!-- Add Members -->
              <div class="members-block">
                <div class="members-block-head">
                  <span class="members-block-label">Add Members</span>
                </div>
                <input
                  v-model="addMemberSearch"
                  type="text"
                  class="form-input"
                  placeholder="Search server members..."
                  @input="handleAddMemberSearch"
                />
                <div v-if="addMemberSearch && searchingMembers" class="loading-members">
                  <div class="spinner small"></div>
                </div>
                <div v-else-if="addMemberSearch && availableMembers.length > 0" class="member-result-list">
                  <button
                    v-for="member in availableMembers"
                    :key="member.id"
                    type="button"
                    class="member-row member-row-add"
                    @click="addMemberToRole(member.id)"
                  >
                    <Avatar :src="member.avatar_url" :alt="member.display_name || member.username" size="xs" />
                    <span class="member-name">{{ member.display_name || member.username }}</span>
                    <span class="member-action-icon" title="Add to role">+</span>
                  </button>
                </div>
                <div v-else-if="addMemberSearch && !searchingMembers" class="no-members">
                  No matching members.
                </div>
              </div>

              <!-- Current Members -->
              <div class="members-block">
                <div class="members-block-head">
                  <span class="members-block-label">
                    Current Members
                    <span class="member-count-pill">{{ roleMembers.length }}</span>
                  </span>
                </div>
                <input
                  v-if="roleMembers.length > 5"
                  v-model="memberSearch"
                  type="text"
                  class="form-input"
                  placeholder="Filter..."
                />

                <div v-if="loadingMembers" class="loading-members">
                  <div class="spinner small"></div>
                </div>
                <div v-else-if="filteredMembers.length === 0" class="no-members">
                  {{ memberSearch ? 'No members match that filter.' : 'No members have this role yet.' }}
                </div>
                <div v-else class="member-result-list">
                  <div
                    v-for="member in filteredMembers"
                    :key="member.id"
                    class="member-row"
                  >
                    <Avatar :src="member.avatar_url" :alt="member.display_name || member.username" size="xs" />
                    <span class="member-name">
                      {{ member.display_name || member.username }}
                      <span v-if="member.isBridged" class="bridged-member-badge" title="Discord bridge member">Discord</span>
                      <span v-if="isServerOwner(member.id)" class="owner-badge">Owner</span>
                    </span>
                    <button
                      v-if="canRemoveMember(member)"
                      type="button"
                      class="member-action-icon danger"
                      @click="removeMember(member)"
                      title="Remove from role"
                    >
                      &minus;
                    </button>
                    <span
                      v-else-if="selectedRole?.is_admin && isServerOwner(member.id)"
                      class="protected-badge"
                      title="Server owner cannot be removed from the Admin role."
                    >
                      Protected
                    </span>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- Editor footer -->
        <footer class="editor-footer">
          <button
            v-if="!selectedRole.is_default && !selectedRole.is_admin"
            type="button"
            class="delete-btn"
            @click="deleteRole"
          >
            Delete Role
          </button>
          <div class="footer-spacer"></div>
          <button
            type="button"
            class="cancel-btn"
            :disabled="!hasChanges"
            @click="resetForm"
          >
            Reset
          </button>
          <button
            type="button"
            class="save-btn"
            @click="saveRole"
            :disabled="saving || !hasChanges"
          >
            {{ saving ? 'Saving...' : 'Save Changes' }}
          </button>
        </footer>
        </template>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import draggable from 'vuedraggable'
import { supabase } from '@/supabase'
import { roleService } from '@/services/RoleService'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Avatar from '@/components/common/Avatar.vue'
import ColorPicker from '@/components/common/ColorPicker.vue'
import type { ServerRole } from '@/services/RoleService'
import {
  fetchBridgedServerUsers,
  type BridgedChannelUser,
} from '@/services/bridgedChannelUsersService'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useToast } from 'vue-toastification'

interface RoleMemberRow {
  id: string
  username: string
  display_name: string
  avatar_url: string
  isBridged?: boolean
}

interface Props {
  serverId: string
}

const props = defineProps<Props>()
const toast = useToast()
const { confirm } = useConfirmDialog()

const loading = ref(false)
const saving = ref(false)
const roles = ref<ServerRole[]>([])
const selectedRole = ref<ServerRole | null>(null)
const activeTab = ref('display')
const memberSearch = ref('')
const roleMembers = ref<RoleMemberRow[]>([])
const loadingMembers = ref(false)
const serverOwnerId = ref<string | null>(null)
const serverBridgedUsers = ref<BridgedChannelUser[]>([])

const addMemberSearch = ref('')
const searchingMembers = ref(false)
const availableMembers = ref<any[]>([])
const allServerMembers = ref<any[]>([])
let searchTimeout: ReturnType<typeof setTimeout> | null = null

// Form state
const editForm = ref({
  name: '',
  color: '#99AAB5',
  hoist: false,
  mentionable: false,
  permissions: [] as string[],
})

// Tabs
const editorTabs = [
  { id: 'display', label: 'Display' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'members', label: 'Members' },
]

// Color presets ()
const colorPresets = [
  '#1ABC9C', '#2ECC71', '#3498DB', '#9B59B6', '#E91E63',
  '#F1C40F', '#E67E22', '#E74C3C', '#95A5A6', '#607D8B',
  '#11806A', '#1F8B4C', '#206694', '#71368A', '#AD1457',
  '#C27C0E', '#A84300', '#992D22', '#979C9F', '#546E7A',
]

// Permission sections - matches Harmony's actual features
const permissionSections = [
  {
    id: 'general',
    title: 'General Permissions',
    permissions: [
      { key: 'VIEW_CHANNEL', label: 'View Channels', description: 'Allows members to view channels by default' },
      { key: 'MANAGE_CHANNELS', label: 'Manage Channels', description: 'Create, edit, and delete channels' },
      { key: 'MANAGE_ROLES', label: 'Manage Roles', description: 'Create, edit, and delete roles below this role' },
      { key: 'MANAGE_SERVER', label: 'Manage Server', description: 'Edit server settings and delete the server' },
      { key: 'CREATE_INVITE', label: 'Create Invite', description: 'Create invites to this server' },
      { key: 'VIEW_AUDIT_LOG', label: 'View Audit Log', description: 'View the server audit log' },
      { key: 'MANAGE_EMOJIS', label: 'Manage Emojis', description: 'Add, edit, and remove custom emojis' },
      { key: 'MANAGE_WEBHOOKS', label: 'Manage Webhooks', description: 'Create, edit, and delete webhooks' },
    ],
  },
  {
    id: 'membership',
    title: 'Membership Permissions',
    permissions: [
      { key: 'KICK_MEMBERS', label: 'Kick Members', description: 'Remove members from the server' },
      { key: 'BAN_MEMBERS', label: 'Ban Members', description: 'Permanently ban members from the server' },
      { key: 'TIMEOUT_MEMBERS', label: 'Timeout Members', description: 'Temporarily mute members' },
    ],
  },
  {
    id: 'text',
    title: 'Text Permissions',
    permissions: [
      { key: 'SEND_MESSAGES', label: 'Send Messages', description: 'Send messages in text channels' },
      { key: 'EMBED_LINKS', label: 'Embed Links', description: 'Links will show a preview' },
      { key: 'ATTACH_FILES', label: 'Attach Files', description: 'Upload images and files' },
      { key: 'ADD_REACTIONS', label: 'Add Reactions', description: 'React to messages with emoji' },
      { key: 'MENTION_EVERYONE', label: 'Mention @everyone', description: 'Mention @everyone and all roles' },
      { key: 'MANAGE_MESSAGES', label: 'Manage Messages', description: 'Delete and pin messages from others' },
      { key: 'READ_MESSAGE_HISTORY', label: 'Read Message History', description: 'View message history' },
      { key: 'USE_EXTERNAL_EMOJIS', label: 'Use External Emojis', description: 'Use emojis from other servers' },
      { key: 'PIN_MESSAGES', label: 'Pin Messages', description: 'Pin messages in channels' },
    ],
  },
  {
    id: 'threads',
    title: 'Thread Permissions',
    permissions: [
      { key: 'CREATE_PUBLIC_THREADS', label: 'Create Public Threads', description: 'Create threads visible to everyone' },
      { key: 'CREATE_PRIVATE_THREADS', label: 'Create Private Threads', description: 'Create invite-only threads' },
      { key: 'SEND_MESSAGES_IN_THREADS', label: 'Send Messages in Threads', description: 'Reply in threads' },
    ],
  },
  {
    id: 'voice',
    title: 'Voice Permissions',
    permissions: [
      { key: 'CONNECT', label: 'Connect', description: 'Join voice channels' },
      { key: 'SPEAK', label: 'Speak', description: 'Talk in voice channels' },
      { key: 'STREAM', label: 'Video', description: 'Share video or screen' },
      { key: 'MUTE_MEMBERS', label: 'Mute Members', description: 'Server mute members in voice' },
      { key: 'DEAFEN_MEMBERS', label: 'Deafen Members', description: 'Server deafen members in voice' },
      { key: 'MOVE_MEMBERS', label: 'Move Members', description: 'Move members between voice channels' },
    ],
  },
]

// DB stores as { 'VIEW_CHANNEL': true, 'SEND_MESSAGES': true }
// Frontend expects ['VIEW_CHANNEL', 'SEND_MESSAGES']
const ensurePermissionsArray = (perms: unknown): string[] => {
  if (Array.isArray(perms)) {
    return [...perms]
  } else if (typeof perms === 'object' && perms !== null) {
    const obj = perms as Record<string, unknown>
    return Object.entries(obj)
      .filter(([_, value]) => value === true)
      .map(([key]) => key)
  } else if (typeof perms === 'string') {
    try {
      const parsed = JSON.parse(perms)
      if (Array.isArray(parsed)) {
        return parsed
      } else if (typeof parsed === 'object') {
        return Object.entries(parsed)
          .filter(([_, value]) => value === true)
          .map(([key]) => key)
      }
      return []
    } catch {
      return []
    }
  }
  return []
}

const permissionsArrayToObject = (perms: string[]): Record<string, boolean> => {
  const obj: Record<string, boolean> = {}
  for (const perm of perms) {
    obj[perm] = true
  }
  return obj
}

const hasChanges = computed(() => {
  if (!selectedRole.value) return false
  return isThisRoleDirty(selectedRole.value.id)
})

/**
 * Per-role dirty check used both by the editor footer ("Save Changes"
 * enabled?) and by the role rail ("show unsaved dot?"). We compare against
 * the canonical role record in `roles.value`, NOT the in-form snapshot,
 * because a role can be inspected without being selected and we still want
 * the dot to disappear after save / reset.
 */
function isThisRoleDirty(roleId: string): boolean {
  if (!selectedRole.value || selectedRole.value.id !== roleId) return false
  const role = roles.value.find(r => r.id === roleId)
  if (!role) return false
  const currentPerms = ensurePermissionsArray(role.permissions)
  return (
    editForm.value.name !== role.name ||
    editForm.value.color !== (role.color || '#99AAB5') ||
    editForm.value.hoist !== role.hoist ||
    editForm.value.mentionable !== role.mentionable ||
    JSON.stringify([...editForm.value.permissions].sort()) !==
      JSON.stringify([...currentPerms].sort())
  )
}

const filteredMembers = computed(() => {
  if (!memberSearch.value) return roleMembers.value
  const search = memberSearch.value.toLowerCase()
  return roleMembers.value.filter(m => 
    (m.display_name || '').toLowerCase().includes(search) ||
    (m.username || '').toLowerCase().includes(search)
  )
})

const loadRoles = async () => {
  if (!props.serverId) return
  loading.value = true
  try {
    const data = await roleService.getServerRoles(props.serverId, true)
    roles.value = data.sort((a, b) => b.position - a.position)
    // Auto-select the highest-position role (or @everyone) so the editor
    // pane has content immediately. Don't override an existing selection
    // if the same role still exists (e.g. user just saved).
    if (selectedRole.value) {
      const stillThere = roles.value.find(r => r.id === selectedRole.value!.id)
      if (stillThere) {
        return
      }
    }
    const initial = roles.value.find(r => !r.is_default) || roles.value[0]
    if (initial) {
      void selectRole(initial)
    }
  } catch (error) {
    console.error('Failed to load roles:', error)
  } finally {
    loading.value = false
  }
}

const createRole = async () => {
  try {
    const newRole = await roleService.createRole(props.serverId, {
      name: 'New Role',
      color: colorPresets[Math.floor(Math.random() * colorPresets.length)],
    })
    if (newRole) {
      roles.value = [newRole, ...roles.value]
      selectRole(newRole)
    }
  } catch (error) {
    console.error('Failed to create role:', error)
  }
}

const selectRole = async (role: ServerRole) => {
  selectedRole.value = role
  activeTab.value = 'display'
  resetForm()
  
  addMemberSearch.value = ''
  availableMembers.value = []
  
  loadingMembers.value = true
  try {
    await Promise.all([
      loadServerMembers(),
      loadServerBridgedUsers({ force: true }),
    ])
    const members = await roleService.getRoleMembers(role.id)
    roleMembers.value = mergeRoleMembers(members, role.id)
  } catch (error) {
    console.error('Failed to load role members:', error)
    roleMembers.value = []
  } finally {
    loadingMembers.value = false
  }
}

function bridgedUsersForRole(roleId: string): RoleMemberRow[] {
  return serverBridgedUsers.value
    .filter(u => u.harmonyRoleIds?.includes(roleId))
    .map(u => ({
      id: `discord:${u.id}`,
      username: u.username,
      display_name: u.displayName,
      avatar_url: u.avatarUrl,
      isBridged: true,
    }))
}

function normalizeHarmonyRoleMembers(
  members: Array<{ id: string; username: string; display_name?: string; avatar_url?: string }>,
): RoleMemberRow[] {
  return members.map(m => ({
    id: m.id,
    username: m.username,
    display_name: m.display_name ?? m.username,
    avatar_url: m.avatar_url ?? '',
  }))
}

function mergeRoleMembers(
  harmonyMembers: Array<{ id: string; username: string; display_name?: string; avatar_url?: string }>,
  roleId: string,
): RoleMemberRow[] {
  return [...normalizeHarmonyRoleMembers(harmonyMembers), ...bridgedUsersForRole(roleId)].sort((a, b) =>
    (a.display_name || a.username).localeCompare(b.display_name || b.username),
  )
}

function getRoleDisplayCount(role: ServerRole): number {
  const base = role.member_count || 0
  const bridged = bridgedUsersForRole(role.id).length
  return base + bridged
}

async function loadServerBridgedUsers(options: { force?: boolean } = {}) {
  try {
    const result = await fetchBridgedServerUsers(props.serverId, options)
    serverBridgedUsers.value = result.users
  } catch (error) {
    console.error('Failed to load bridged server users:', error)
    serverBridgedUsers.value = []
  }
}

const resetForm = () => {
  if (!selectedRole.value) return
  
  editForm.value = {
    name: selectedRole.value.name,
    color: selectedRole.value.color || '#99AAB5',
    hoist: selectedRole.value.hoist || false,
    mentionable: selectedRole.value.mentionable || false,
    permissions: ensurePermissionsArray(selectedRole.value.permissions),
  }
}

const hasPermission = (key: string) => {
  return editForm.value.permissions.includes(key)
}

const togglePermission = (key: string) => {
  const index = editForm.value.permissions.indexOf(key)
  if (index >= 0) {
    editForm.value.permissions.splice(index, 1)
  } else {
    editForm.value.permissions.push(key)
  }
}

const saveRole = async () => {
  if (!selectedRole.value || !hasChanges.value) return
  
  saving.value = true
  try {
    const updated = await roleService.updateRole(selectedRole.value.id, {
      name: editForm.value.name,
      color: editForm.value.color,
      hoist: editForm.value.hoist,
      mentionable: editForm.value.mentionable,
      permissions: permissionsArrayToObject(editForm.value.permissions),
    })
    
    if (updated) {
      const index = roles.value.findIndex(r => r.id === updated.id)
      if (index >= 0) {
        roles.value[index] = updated
      }
      selectedRole.value = updated
      resetForm()
    }
  } catch (error) {
    console.error('Failed to save role:', error)
  } finally {
    saving.value = false
  }
}

const isProtectedRole = computed(() => {
  return selectedRole.value?.is_default || selectedRole.value?.is_admin
})

const deleteRole = async () => {
  if (!selectedRole.value || isProtectedRole.value) return
  
  if (!(await confirm({ title: 'Delete role', message: `Are you sure you want to delete the "${selectedRole.value.name}" role?`, confirmButtonText: 'Delete', dangerAction: true }))) {
    return
  }
  
  try {
    const deletedId = selectedRole.value.id
    await roleService.deleteRole(deletedId)
    roles.value = roles.value.filter(r => r.id !== deletedId)
    // Land on the next-best role instead of an empty pane.
    const next = roles.value.find(r => !r.is_default) || roles.value[0] || null
    if (next) {
      void selectRole(next)
    } else {
      selectedRole.value = null
    }
  } catch (error: any) {
    console.error('Failed to delete role:', error)
    toast.error(error.message || 'Failed to delete role')
  }
}

const removeMember = async (member: RoleMemberRow) => {
  if (!selectedRole.value || member.isBridged) return
  
  try {
    const success = await roleService.removeRole(member.id, selectedRole.value.id)
    if (success) {
      roleMembers.value = roleMembers.value.filter(m => m.id !== member.id)
    }
  } catch (error: any) {
    console.error('Failed to remove member from role:', error)
    if (error.message?.includes('server owner')) {
      toast.error('Cannot remove Admin role from the server owner')
    } else {
      toast.error(error.message || 'Failed to remove member from role')
    }
  }
}

const loadServerMembers = async () => {
  try {
    const { data, error } = await supabase
      .from('user_servers')
      .select(`
        user_id,
        profiles:user_id (
          id,
          username,
          display_name,
          avatar_url
        )
      `)
      .eq('server_id', props.serverId)
    
    if (error) throw error
    
    allServerMembers.value = (data || []).map((us: any) => ({
      id: us.user_id,
      username: us.profiles?.username || 'Unknown',
      display_name: us.profiles?.display_name,
      avatar_url: us.profiles?.avatar_url,
    }))
  } catch (error) {
    console.error('Failed to load server members:', error)
    allServerMembers.value = []
  }
}

const handleAddMemberSearch = () => {
  if (searchTimeout) {
    clearTimeout(searchTimeout)
  }
  
  searchTimeout = setTimeout(() => {
    searchAvailableMembers()
  }, 200)
}

// Search for members that can be added (not already in role)
const searchAvailableMembers = () => {
  const query = addMemberSearch.value.toLowerCase().trim()
  if (!query) {
    availableMembers.value = []
    return
  }
  
  searchingMembers.value = true
  
  const roleMemberIds = new Set(roleMembers.value.map(m => m.id))
  
  availableMembers.value = allServerMembers.value.filter(member => {
    // Exclude members who already have this role
    if (roleMemberIds.has(member.id)) return false
    
    // Match by username or display name
    const username = (member.username || '').toLowerCase()
    const displayName = (member.display_name || '').toLowerCase()
    
    return username.includes(query) || displayName.includes(query)
  }).slice(0, 10) // Limit to 10 results
  
  searchingMembers.value = false
}

const addMemberToRole = async (memberId: string) => {
  if (!selectedRole.value) return
  
  try {
    const success = await roleService.assignRole(memberId, selectedRole.value.id, props.serverId)
    if (success) {
      const member = availableMembers.value.find(m => m.id === memberId)
      if (member) {
        roleMembers.value.push(member)
        availableMembers.value = availableMembers.value.filter(m => m.id !== memberId)
      }
    }
  } catch (error: any) {
    console.error('Failed to add member to role:', error)
    toast.error(error.message || 'Failed to add member to role')
  }
}

const handleReorder = async () => {
  const updates = roles.value.map((role, index) => ({
    id: role.id,
    position: roles.value.length - index,
  }))
  
  try {
    await roleService.reorderRoles(props.serverId, updates)
  } catch (error) {
    console.error('Failed to reorder roles:', error)
    loadRoles()
  }
}

watch(() => props.serverId, () => {
  selectedRole.value = null
  loadRoles()
})

const loadServerOwner = async () => {
  try {
    const { data, error } = await supabase
      .from('servers')
      .select('owner')
      .eq('id', props.serverId)
      .single()
    
    if (!error && data) {
      serverOwnerId.value = data.owner
    }
  } catch (error) {
    console.error('Failed to load server owner:', error)
  }
}

const isServerOwner = (memberId: string): boolean => {
  return serverOwnerId.value === memberId
}

const canRemoveMember = (member: RoleMemberRow): boolean => {
  if (member.isBridged) return false
  if (selectedRole.value?.is_default) return false
  if (selectedRole.value?.is_admin && isServerOwner(member.id)) return false
  return true
}

onMounted(() => {
  loadRoles()
  loadServerOwner()
  void loadServerBridgedUsers()
})
</script>

<style scoped>
/* =========================================================================
   ROOT LAYOUT
   - Header on top (full width).
   - Below: 240px role rail | flex-grow editor.
   ======================================================================= */
.role-management {
  display: flex;
  flex-direction: column;
  min-height: 540px;
  height: 100%;
}

.management-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.header-text h2 {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.header-text p {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.create-role-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  background: var(--harmony-primary, #0EA5E9);
  color: var(--text-on-primary, #ffffff);
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s;
  flex-shrink: 0;
}

.create-role-btn:hover { filter: brightness(1.1); }

.role-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 20px;
  flex: 1;
  min-height: 0;
}

/* =========================================================================
   ROLE RAIL (left)
   ======================================================================= */
.role-rail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 8px;
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  min-height: 0;
}

.rail-section-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 0 8px 8px;
}

.rail-loading {
  display: flex;
  justify-content: center;
  padding: 24px 0;
}

.rail-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.role-pill {
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

.role-pill:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.role-pill.active {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.role-pill-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.role-pill-count {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
  padding-left: 4px;
}

.role-pill-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--harmony-primary, #0EA5E9);
  flex-shrink: 0;
}

.drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  color: var(--text-muted);
  cursor: grab;
  opacity: 0.5;
  transition: opacity 0.12s;
}

.drag-handle:active { cursor: grabbing; }
.role-pill:hover .drag-handle { opacity: 1; }

.drag-handle-spacer { width: 14px; flex-shrink: 0; }

.role-color {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* Badges shared with the editor header */
.role-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

.role-badge.admin {
  background: rgba(231, 76, 60, 0.18);
  color: #E74C3C;
}

.role-badge.default {
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.owner-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(241, 196, 15, 0.18);
  color: #F1C40F;
  text-transform: uppercase;
  font-weight: 600;
  margin-left: 6px;
}

.protected-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(149, 165, 166, 0.18);
  color: var(--text-secondary);
  text-transform: uppercase;
  font-weight: 600;
  flex-shrink: 0;
}

/* =========================================================================
   EDITOR (right)
   ======================================================================= */
.role-editor {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
}

.editor-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 32px;
  color: var(--text-secondary);
  font-size: 13px;
}

.editor-head {
  padding: 16px 20px 0;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.editor-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.editor-title h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.editor-tabs {
  display: flex;
  gap: 4px;
}

.tab-btn {
  padding: 10px 14px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  margin-bottom: -1px;
  transition: color 0.12s, border-color 0.12s;
}

.tab-btn:hover { color: var(--text-primary); }
.tab-btn.active {
  color: var(--harmony-primary, #0EA5E9);
  border-bottom-color: var(--harmony-primary, #0EA5E9);
}

.editor-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  min-height: 0;
}

.tab-content {
  animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ===== Display tab form bits ===== */
.form-group {
  margin-bottom: 20px;
}
.form-group:last-child { margin-bottom: 0; }

.form-group label {
  display: block;
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 8px;
}

.form-group.toggle-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.toggle-info { flex: 1; min-width: 0; }

.toggle-title {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
  text-transform: none;
  letter-spacing: normal;
}

.form-help {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.form-input {
  width: 100%;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
}

.form-input:focus { border-color: var(--harmony-primary, #0EA5E9); }
.form-input:disabled { opacity: 0.5; cursor: not-allowed; }
.form-input::placeholder { color: var(--text-muted); }

.color-picker-row {
  display: flex;
  gap: 10px;
}

.color-input {
  width: 42px;
  height: 42px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  padding: 0;
  background: transparent;
}

.color-text {
  flex: 1;
  padding: 10px 12px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, monospace;
  outline: none;
  transition: border-color 0.15s;
}

.color-text:focus { border-color: var(--harmony-primary, #0EA5E9); }

.color-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.color-preset {
  width: 24px;
  height: 24px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 50%;
  cursor: pointer;
  padding: 0;
  transition: transform 0.12s;
}

.color-preset:hover { transform: scale(1.15); }

/* ===== Permissions tab ===== */
.perm-intro {
  margin: 0 0 16px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  padding: 10px 12px;
  background: var(--background-tertiary);
  border-radius: 6px;
}

.perm-group {
  margin-bottom: 24px;
}
.perm-group:last-child { margin-bottom: 0; }

.perm-group-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 4px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-color);
}

.perm-group-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.perm-group-warn {
  font-size: 11px;
  color: #F1C40F;
}

.perm-group-dangerous .perm-group-label {
  color: #E74C3C;
}

.perm-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 4px;
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
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
}

/* ===== Members tab ===== */
.members-everyone-note {
  padding: 16px;
  background: var(--background-tertiary);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.members-block {
  margin-bottom: 24px;
}
.members-block:last-child { margin-bottom: 0; }

.members-block-head {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}

.members-block-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.member-count-pill {
  margin-left: 6px;
  background: var(--background-tertiary);
  color: var(--text-primary);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
}

.bridged-member-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: #fff;
  background: #5865F2;
  vertical-align: middle;
}

.member-result-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  max-height: 320px;
  overflow-y: auto;
}

.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  transition: background 0.12s;
}

.member-row-add {
  cursor: pointer;
}

.member-row-add:hover {
  background: var(--background-tertiary);
}

.member-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.member-action-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(14, 165, 233, 0.15);
  color: var(--harmony-primary, #0EA5E9);
  border: none;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.12s;
}

.member-action-icon:hover { filter: brightness(1.2); }

.member-action-icon.danger {
  background: rgba(240, 71, 71, 0.15);
  color: #F04747;
}

.loading-members {
  display: flex;
  justify-content: center;
  padding: 16px;
}

.no-members {
  padding: 16px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
}

/* ===== Editor footer ===== */
.editor-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border-color);
  background: var(--background-secondary);
  flex-shrink: 0;
}

.footer-spacer { flex: 1; }

.delete-btn {
  background: transparent;
  border: none;
  color: #F04747;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 8px 12px;
  border-radius: 6px;
  transition: background 0.15s;
}

.delete-btn:hover { background: rgba(240, 71, 71, 0.1); }

.cancel-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  padding: 8px 12px;
  border-radius: 6px;
}

.cancel-btn:not(:disabled):hover {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
}

.cancel-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.save-btn {
  background: var(--harmony-primary, #0EA5E9);
  color: var(--text-on-primary, #ffffff);
  border: none;
  padding: 9px 18px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: filter 0.15s;
}

.save-btn:hover:not(:disabled) { filter: brightness(1.1); }
.save-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ===== Misc ===== */
.spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--border-color);
  border-top-color: var(--harmony-primary, #0EA5E9);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner.small {
  width: 18px;
  height: 18px;
  border-width: 2px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ===== Responsive: collapse to single column on narrow ===== */
@media (max-width: 720px) {
  .role-layout {
    grid-template-columns: 1fr;
  }
  .role-rail {
    border-right: none;
    border-bottom: 1px solid var(--border-color);
    padding-right: 0;
    padding-bottom: 8px;
    max-height: 220px;
  }
}
</style>

