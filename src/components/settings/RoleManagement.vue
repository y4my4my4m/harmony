<template>
  <div class="role-management">
    <div class="role-management-main">
      <!-- Header -->
      <div class="management-header">
        <div class="header-text">
          <h2>Roles</h2>
          <p>Create and manage roles for your server. Roles can be used to manage permissions and organize members.</p>
        </div>
        <button class="create-role-btn" @click="createRole">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
          </svg>
          Create Role
        </button>
      </div>

      <!-- Role List -->
      <div class="role-list" v-if="!loading">
      <div class="role-section">
        <div class="section-header">
          <span>{{ roles.length }} roles</span>
        </div>
        
        <draggable
          v-model="roles"
          item-key="id"
          handle=".drag-handle"
          @end="handleReorder"
          class="roles-container"
        >
          <template #item="{ element: role }">
            <div 
              class="role-item"
              :class="{ active: selectedRole?.id === role.id }"
              @click="selectRole(role)"
            >
              <div class="drag-handle" v-if="!role.is_default">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9 20c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-16c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM9 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6 4c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM9 14c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>
                </svg>
              </div>
              <div class="role-color" :style="{ background: role.color || '#99AAB5' }"></div>
              <span class="role-name">
                {{ role.name }}
                <span v-if="role.is_admin" class="admin-badge">Admin</span>
                <span v-if="role.is_default" class="default-badge">Default</span>
              </span>
              <span class="member-count">{{ role.member_count || 0 }} members</span>
            </div>
          </template>
        </draggable>
      </div>
    </div>

      <div v-else class="loading-state">
        <div class="spinner"></div>
        <p>Loading roles...</p>
      </div>
    </div>

    <!-- Role Editor Panel -->
    <Transition name="slide">
      <div v-if="selectedRole" class="role-editor">
        <div class="editor-header">
          <button class="back-btn" @click="selectedRole = null">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <h3>Edit Role — {{ selectedRole.name }}</h3>
        </div>

        <div class="editor-tabs">
          <button 
            v-for="tab in editorTabs" 
            :key="tab.id"
            class="tab-btn"
            :class="{ active: activeTab === tab.id }"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>

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
              />
            </div>

            <div class="form-group">
              <label>Role Color</label>
              <div class="color-picker-row">
                <input 
                  v-model="editForm.color" 
                  type="color" 
                  class="color-input"
                />
                <input 
                  v-model="editForm.color" 
                  type="text" 
                  class="color-text"
                  placeholder="#99AAB5"
                />
              </div>
              <div class="color-presets">
                <button 
                  v-for="color in colorPresets" 
                  :key="color"
                  class="color-preset"
                  :style="{ background: color }"
                  @click="editForm.color = color"
                />
              </div>
            </div>

            <div class="form-group toggle-row">
              <div class="toggle-info">
                <span class="toggle-title">Display role members separately</span>
                <p class="form-help">Members with this role will be shown separately in the member list.</p>
              </div>
              <ToggleSwitch v-model="editForm.hoist" />
            </div>

            <div class="form-group toggle-row">
              <div class="toggle-info">
                <span class="toggle-title">Allow anyone to @mention this role</span>
              </div>
              <ToggleSwitch v-model="editForm.mentionable" />
            </div>
          </div>

          <!-- Permissions Tab -->
          <div v-if="activeTab === 'permissions'" class="tab-content">
            <div class="permissions-section" v-for="section in permissionSections" :key="section.id">
              <h4 class="section-title">{{ section.title }}</h4>
              <div class="permissions-list">
                <div 
                  v-for="perm in section.permissions" 
                  :key="perm.key"
                  class="permission-item"
                >
                  <div class="permission-info">
                    <span class="permission-name">{{ perm.label }}</span>
                    <span class="permission-desc">{{ perm.description }}</span>
                  </div>
                  <ToggleSwitch 
                    :model-value="hasPermission(perm.key)"
                    @update:model-value="togglePermission(perm.key)"
                  />
                </div>
              </div>
            </div>
          </div>

          <!-- Members Tab -->
          <div v-if="activeTab === 'members'" class="tab-content">
            <!-- Add Members Section -->
            <div v-if="!selectedRole?.is_default" class="add-members-section">
              <h4 class="section-label">Add Members</h4>
              <div class="add-member-search">
                <input 
                  v-model="addMemberSearch" 
                  type="text" 
                  class="search-input"
                  placeholder="Search server members to add..."
                  @input="handleAddMemberSearch"
                />
              </div>
              <div v-if="addMemberSearch && searchingMembers" class="loading-members">
                <div class="spinner small"></div>
              </div>
              <div v-else-if="addMemberSearch && availableMembers.length > 0" class="available-members-list">
                <div 
                  v-for="member in availableMembers" 
                  :key="member.id"
                  class="member-item available"
                  @click="addMemberToRole(member.id)"
                >
                  <img :src="member.avatar_url || '/default-avatar.png'" class="member-avatar" />
                  <span class="member-name">{{ member.display_name || member.username }}</span>
                  <button class="add-member-btn" title="Add to role">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
                    </svg>
                  </button>
                </div>
              </div>
              <div v-else-if="addMemberSearch && !searchingMembers && availableMembers.length === 0" class="no-members">
                No members found to add
              </div>
            </div>

            <!-- Current Members Section -->
            <div class="current-members-section">
              <h4 class="section-label">
                Members with this role 
                <span class="member-count-badge">{{ roleMembers.length }}</span>
              </h4>
              <div class="members-header">
                <input 
                  v-model="memberSearch" 
                  type="text" 
                  class="search-input"
                  placeholder="Filter current members..."
                />
              </div>
              
              <div class="members-list">
                <div v-if="loadingMembers" class="loading-members">
                  <div class="spinner small"></div>
                </div>
                <div 
                  v-else
                  v-for="member in filteredMembers" 
                  :key="member.id"
                  class="member-item"
                >
                  <img :src="member.avatar_url || '/default-avatar.png'" class="member-avatar" />
                  <span class="member-name">
                    {{ member.display_name || member.username }}
                    <span v-if="isServerOwner(member.id)" class="owner-badge">Owner</span>
                  </span>
                  <button 
                    v-if="canRemoveMember(member.id)"
                    class="remove-member-btn"
                    @click="removeMember(member.id)"
                    title="Remove from role"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 13H5v-2h14v2z"/>
                    </svg>
                  </button>
                  <span 
                    v-else-if="selectedRole?.is_admin && isServerOwner(member.id)"
                    class="protected-badge"
                    title="Server owner cannot be removed from Admin role"
                  >
                    Protected
                  </span>
                </div>
                <div v-if="!loadingMembers && filteredMembers.length === 0" class="no-members">
                  {{ memberSearch ? 'No members found' : 'No members with this role' }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Editor Actions -->
        <div class="editor-actions">
          <button 
            v-if="!selectedRole.is_default"
            class="delete-btn"
            @click="deleteRole"
          >
            Delete Role
          </button>
          <div class="spacer"></div>
          <button class="cancel-btn" @click="resetForm">Reset</button>
          <button 
            class="save-btn"
            @click="saveRole"
            :disabled="saving || !hasChanges"
          >
            {{ saving ? 'Saving...' : 'Save Changes' }}
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import draggable from 'vuedraggable'
import { supabase } from '@/supabase'
import { roleService } from '@/services/RoleService'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import type { ServerRole, Permission } from '@/types'

interface Props {
  serverId: string
}

const props = defineProps<Props>()

// State
const loading = ref(false)
const saving = ref(false)
const roles = ref<ServerRole[]>([])
const selectedRole = ref<ServerRole | null>(null)
const activeTab = ref('display')
const memberSearch = ref('')
const roleMembers = ref<any[]>([])
const loadingMembers = ref(false)
const serverOwnerId = ref<string | null>(null)

// Add member state
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

// Color presets (Discord-style)
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

// Helper to safely convert permissions to array
// DB stores as { 'VIEW_CHANNEL': true, 'SEND_MESSAGES': true }
// Frontend expects ['VIEW_CHANNEL', 'SEND_MESSAGES']
const ensurePermissionsArray = (perms: unknown): string[] => {
  if (Array.isArray(perms)) {
    return [...perms]
  } else if (typeof perms === 'object' && perms !== null) {
    // Handle JSONB object format: { 'PERMISSION_NAME': true }
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

// Helper to convert permissions array to JSONB object format for database
const permissionsArrayToObject = (perms: string[]): Record<string, boolean> => {
  const obj: Record<string, boolean> = {}
  for (const perm of perms) {
    obj[perm] = true
  }
  return obj
}

// Computed
const hasChanges = computed(() => {
  if (!selectedRole.value) return false
  const currentPerms = ensurePermissionsArray(selectedRole.value.permissions)
  return (
    editForm.value.name !== selectedRole.value.name ||
    editForm.value.color !== (selectedRole.value.color || '#99AAB5') ||
    editForm.value.hoist !== selectedRole.value.hoist ||
    editForm.value.mentionable !== selectedRole.value.mentionable ||
    JSON.stringify([...editForm.value.permissions].sort()) !== JSON.stringify([...currentPerms].sort())
  )
})

const filteredMembers = computed(() => {
  if (!memberSearch.value) return roleMembers.value
  const search = memberSearch.value.toLowerCase()
  return roleMembers.value.filter(m => 
    (m.display_name || '').toLowerCase().includes(search) ||
    (m.username || '').toLowerCase().includes(search)
  )
})

// Methods
const loadRoles = async () => {
  if (!props.serverId) return
  loading.value = true
  try {
    // Raw diagnostic query - bypass RoleService entirely
    const { data: rawData, error: rawError, status, statusText } = await supabase
      .from('server_roles')
      .select('id, name, server_id')
      .eq('server_id', props.serverId)

    console.log('[RoleManagement] RAW supabase response:', {
      serverId: props.serverId,
      status,
      statusText,
      error: rawError,
      rowCount: rawData?.length,
      data: rawData
    })

    const data = await roleService.getServerRoles(props.serverId, true)
    console.log('[RoleManagement] roleService returned:', data.length, 'roles')
    roles.value = data.sort((a, b) => b.position - a.position)
  } catch (error) {
    console.error('[RoleManagement] CAUGHT ERROR:', error)
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
  
  // Reset add member search
  addMemberSearch.value = ''
  availableMembers.value = []
  
  // Load members and server members in parallel
  loadingMembers.value = true
  try {
    const [members] = await Promise.all([
      roleService.getRoleMembers(role.id),
      loadServerMembers()
    ])
    roleMembers.value = members
  } catch (error) {
    console.error('Failed to load role members:', error)
    roleMembers.value = []
  } finally {
    loadingMembers.value = false
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
    // Convert permissions array to JSONB object format for database
    const updated = await roleService.updateRole(selectedRole.value.id, {
      name: editForm.value.name,
      color: editForm.value.color,
      hoist: editForm.value.hoist,
      mentionable: editForm.value.mentionable,
      permissions: permissionsArrayToObject(editForm.value.permissions),
    })
    
    if (updated) {
      // Update local state
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
  
  if (!confirm(`Are you sure you want to delete the "${selectedRole.value.name}" role?`)) {
    return
  }
  
  try {
    await roleService.deleteRole(selectedRole.value.id)
    roles.value = roles.value.filter(r => r.id !== selectedRole.value!.id)
    selectedRole.value = null
  } catch (error: any) {
    console.error('Failed to delete role:', error)
    alert(error.message || 'Failed to delete role')
  }
}

const removeMember = async (memberId: string) => {
  if (!selectedRole.value) return
  
  try {
    const success = await roleService.removeRole(memberId, selectedRole.value.id)
    if (success) {
      roleMembers.value = roleMembers.value.filter(m => m.id !== memberId)
    }
  } catch (error: any) {
    console.error('Failed to remove member from role:', error)
    // Show user-friendly error message
    if (error.message?.includes('server owner')) {
      alert('Cannot remove Admin role from the server owner')
    } else {
      alert(error.message || 'Failed to remove member from role')
    }
  }
}

// Load all server members for the add member search
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

// Handle search input for adding members
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
  
  // Filter server members who don't already have this role
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

// Add a member to the current role
const addMemberToRole = async (memberId: string) => {
  if (!selectedRole.value) return
  
  try {
    const success = await roleService.assignRole(memberId, selectedRole.value.id, props.serverId)
    if (success) {
      // Find the member in available members and add to role members
      const member = availableMembers.value.find(m => m.id === memberId)
      if (member) {
        roleMembers.value.push(member)
        // Remove from available members
        availableMembers.value = availableMembers.value.filter(m => m.id !== memberId)
      }
    }
  } catch (error: any) {
    console.error('Failed to add member to role:', error)
    alert(error.message || 'Failed to add member to role')
  }
}

const handleReorder = async () => {
  // Update positions based on new order
  const updates = roles.value.map((role, index) => ({
    id: role.id,
    position: roles.value.length - index,
  }))
  
  try {
    await roleService.reorderRoles(props.serverId, updates)
  } catch (error) {
    console.error('Failed to reorder roles:', error)
    // Reload roles on error
    loadRoles()
  }
}

// Watch for server changes
watch(() => props.serverId, () => {
  selectedRole.value = null
  loadRoles()
})

// Load server owner info
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

// Check if a member is the server owner
const isServerOwner = (memberId: string): boolean => {
  return serverOwnerId.value === memberId
}

// Check if remove button should be shown for a member
const canRemoveMember = (memberId: string): boolean => {
  // Can't remove from default role (this is already handled in template)
  if (selectedRole.value?.is_default) return false
  
  // Can't remove owner from admin role
  if (selectedRole.value?.is_admin && isServerOwner(memberId)) return false
  
  return true
}

onMounted(() => {
  loadRoles()
  loadServerOwner()
})
</script>

<style scoped>
.role-management {
  display: flex;
  min-height: 400px;
  height: auto;
  position: relative;
  overflow: visible;
}

.role-management-main {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.management-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 0 0 20px 0;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 16px;
}

.header-text h2 {
  margin: 0 0 4px 0;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.header-text p {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

.create-role-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--harmony-primary);
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}

.create-role-btn:hover {
  filter: brightness(1.1);
}

.role-list {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.section-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  padding: 8px 12px;
}

.roles-container {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.role-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--background-secondary);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}

.role-item:hover {
  background: var(--background-tertiary);
}

.role-item.active {
  background: var(--harmony-primary-alpha, rgba(88, 101, 242, 0.15));
}

.drag-handle {
  color: var(--text-muted);
  cursor: grab;
  padding: 4px;
}

.drag-handle:active {
  cursor: grabbing;
}

.role-color {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}

.role-name {
  flex: 1;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.default-badge,
.admin-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  font-weight: 600;
}

.default-badge {
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

.admin-badge {
  background: rgba(231, 76, 60, 0.2);
  color: #E74C3C;
  text-transform: uppercase;
  font-weight: 600;
}

.owner-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(241, 196, 15, 0.2);
  color: #F1C40F;
  text-transform: uppercase;
  font-weight: 600;
  margin-left: 6px;
}

.protected-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(149, 165, 166, 0.2);
  color: var(--text-secondary);
  text-transform: uppercase;
  font-weight: 600;
}

.member-count {
  font-size: 12px;
  color: var(--text-secondary);
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px;
  color: var(--text-secondary);
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top-color: var(--harmony-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 16px;
}

.spinner.small {
  width: 20px;
  height: 20px;
  border-width: 2px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Role Editor Panel */
.role-editor {
  position: absolute;
  top: 0;
  right: 0;
  width: 100%;
  max-width: 600px;
  height: 100%;
  background: var(--background-primary);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  z-index: 10;
}

.editor-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.back-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  display: flex;
  transition: all 0.2s;
}

.back-btn:hover {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.editor-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.editor-tabs {
  display: flex;
  gap: 4px;
  padding: 0 20px;
  border-bottom: 1px solid var(--border-color);
}

.tab-btn {
  padding: 12px 16px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  margin-bottom: -1px;
}

.tab-btn:hover {
  color: var(--text-primary);
}

.tab-btn.active {
  color: var(--harmony-primary);
  border-bottom-color: var(--harmony-primary);
}

.editor-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.tab-content {
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.form-group {
  margin-bottom: 24px;
}

.form-group label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin-bottom: 8px;
}

.form-group.toggle-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.form-group.toggle-row .toggle-info {
  flex: 1;
}

.form-group.toggle-row .toggle-title {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
  text-transform: none;
  letter-spacing: normal;
}

.form-group.toggle-row .form-help {
  margin-top: 0;
}

.form-input {
  width: 100%;
  padding: 12px;
  background: var(--background-tertiary);
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: box-shadow 0.2s;
}

.form-input:focus {
  box-shadow: 0 0 0 2px var(--harmony-primary);
}

.form-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.color-picker-row {
  display: flex;
  gap: 12px;
}

.color-input {
  width: 48px;
  height: 48px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
}

.color-text {
  flex: 1;
  padding: 12px;
  background: var(--background-tertiary);
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  font-family: monospace;
  outline: none;
}

.color-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.color-preset {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: transform 0.15s;
}

.color-preset:hover {
  transform: scale(1.1);
}

/* Switch */
.switch-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
}

.switch-label span:first-child {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
}

.switch-label.compact {
  padding: 0;
}

.switch-input {
  display: none;
}

.switch-slider {
  width: 40px;
  height: 24px;
  background: var(--background-tertiary);
  border-radius: 12px;
  position: relative;
  transition: background 0.2s;
  flex-shrink: 0;
}

.switch-slider::after {
  content: '';
  position: absolute;
  width: 18px;
  height: 18px;
  background: white;
  border-radius: 50%;
  top: 3px;
  left: 3px;
  transition: transform 0.2s;
}

.switch-input:checked + .switch-slider {
  background: var(--harmony-primary);
}

.switch-input:checked + .switch-slider::after {
  transform: translateX(16px);
}

.form-help {
  margin: 8px 0 0 0;
  font-size: 13px;
  color: var(--text-secondary);
}

/* Permissions */
.permissions-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin: 0 0 12px 0;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
}

.permissions-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.permission-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  background: var(--background-secondary);
  border-radius: 4px;
}

.permission-info {
  flex: 1;
}

.permission-name {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.permission-desc {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
}

/* Members */
.add-members-section {
  margin-bottom: 24px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border-color);
}

.current-members-section {
  /* Empty for now, placeholder for future styles */
}

.section-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin: 0 0 12px 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.member-count-badge {
  background: var(--background-tertiary);
  color: var(--text-primary);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
}

.add-member-search {
  margin-bottom: 8px;
}

.available-members-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
  margin-top: 8px;
}

.member-item.available {
  cursor: pointer;
  transition: background 0.15s;
}

.member-item.available:hover {
  background: var(--harmony-primary-alpha, rgba(88, 101, 242, 0.15));
}

.add-member-btn {
  background: none;
  border: none;
  color: var(--harmony-primary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  transition: all 0.2s;
}

.add-member-btn:hover {
  background: rgba(88, 101, 242, 0.2);
}

.members-header {
  margin-bottom: 16px;
}

.search-input {
  width: 100%;
  padding: 12px;
  background: var(--background-tertiary);
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.members-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.loading-members {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.member-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--background-secondary);
  border-radius: 4px;
}

.member-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}

.member-name {
  flex: 1;
  font-size: 14px;
  color: var(--text-primary);
}

.remove-member-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  transition: all 0.2s;
}

.remove-member-btn:hover {
  background: rgba(240, 71, 71, 0.1);
  color: #F04747;
}

.no-members {
  text-align: center;
  padding: 24px;
  color: var(--text-secondary);
  font-size: 14px;
}

/* Editor Actions */
.editor-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
  background: var(--background-secondary);
}

.spacer {
  flex: 1;
}

.delete-btn {
  background: transparent;
  border: none;
  color: #F04747;
  font-size: 14px;
  cursor: pointer;
  padding: 8px 12px;
  border-radius: 4px;
  transition: background 0.2s;
}

.delete-btn:hover {
  background: rgba(240, 71, 71, 0.1);
}

.cancel-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
  padding: 10px 16px;
}

.cancel-btn:hover {
  text-decoration: underline;
}

.save-btn {
  background: var(--harmony-primary);
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.save-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Slide transition */
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.3s ease;
}

.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
}
</style>

