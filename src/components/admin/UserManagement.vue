<template>
  <div>
<div class="admin-module users-module">
  <div class="module-header">
    <Icon name="users" :size="20" />
    <h2>User Management</h2>
    <div class="search-bar">
      <Icon name="search" :size="16" />
      <input v-model="userSearch" placeholder="Search users..." class="cyber-input" />
    </div>
  </div>
  <div class="users-content">
    <div class="user-filters">
      <button 
        v-for="filter in userFilters" 
        :key="filter.key"
        @click="activeUserFilter = filter.key"
        :class="['filter-btn', { active: activeUserFilter === filter.key }]"
      >
        {{ filter.label }} ({{ filter.count }})
      </button>
    </div>
    <div class="users-list">
      <div 
        v-for="user in filteredUsers" 
        :key="user.id" 
        class="user-item"
        :class="{ 'user-suspended': user.is_suspended }"
      >
        <Avatar 
          :src="user.avatar_url" 
          :alt="user.display_name || user.username"
          size="md"
        />
        <div class="user-info">
          <div class="user-name">
            <DisplayName :user-id="user.id" :fallback="user.display_name || user.username" />
            <span v-if="user.is_suspended" class="badge suspended">Suspended</span>
            <span v-if="user.is_admin" class="badge admin">Admin</span>
            <span v-if="user.is_moderator && !user.is_admin" class="badge moderator">Mod</span>
            <span v-if="user.force_sensitive" class="badge sensitive" title="All media from this user is force-marked sensitive">F-Sensitive</span>
            <span v-if="user.is_silenced" class="badge silenced" title="This user is silenced (hidden from public timelines)">Silenced</span>
          </div>
          <div class="user-meta">
            {{ user.handle }}
            <span class="user-joined">Joined {{ formatDate(user.created_at) }}</span>
            <span v-if="user.is_suspended && user.suspension_reason" class="suspension-reason">
              - {{ user.suspension_reason }}
            </span>
          </div>
        </div>
        <div class="user-stats">
          <button @click="navigateToUserPosts(user)" class="user-stat clickable">
            {{ user.postCount }} posts
          </button>
          <button 
            v-if="user.is_local" 
            @click="navigateToUserServers(user)" 
            class="user-stat clickable"
          >
            {{ user.serverCount }} servers
          </button>
          <span v-else class="user-stat">federated</span>
        </div>
        <div class="user-actions">
          <button
            v-if="!user.is_admin"
            @click="toggleModerator(user)"
            class="mod-btn"
            :class="user.is_moderator ? 'demote-btn' : 'promote-btn'"
            :title="user.is_moderator ? 'Remove Moderator' : 'Make Moderator'"
          >
            <Icon :name="user.is_moderator ? 'shield-off' : 'shield'" :size="16" />
          </button>
          <button
            @click="moderateUser(user, user.force_sensitive ? 'unforce_sensitive' : 'force_sensitive')"
            class="mod-btn"
            :class="user.force_sensitive ? 'unsuspend-btn' : 'warning-btn'"
            :title="user.force_sensitive ? 'Remove force-sensitive' : 'Force all media as sensitive'"
          >
            <Icon :name="user.force_sensitive ? 'eye' : 'eye-off'" :size="16" />
          </button>
          <button
            @click="moderateUser(user, user.is_silenced ? 'unsilence' : 'silence')"
            class="mod-btn"
            :class="user.is_silenced ? 'unsuspend-btn' : 'warning-btn'"
            :title="user.is_silenced ? 'Remove silence' : 'Silence (hide from public timelines)'"
          >
            <Icon :name="user.is_silenced ? 'volume-2' : 'volume-x'" :size="16" />
          </button>
          <button 
            v-if="user.is_suspended"
            @click="moderateUser(user, 'unsuspend')" 
            class="mod-btn unsuspend-btn"
            title="Unsuspend user"
          >
            <Icon name="check" :size="16" />
          </button>
          <button 
            v-else
            @click="moderateUser(user, 'suspend')" 
            class="mod-btn suspend-btn"
            title="Suspend user"
          >
            <Icon name="suspend" :size="16" />
          </button>
          <button 
            @click="moderateUser(user, 'delete')" 
            class="mod-btn delete-btn"
            title="Delete user"
          >
            <Icon name="delete" :size="16" />
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- User Pagination -->
  <div v-if="userPagination.total > userPagination.limit" class="pagination">
    <button
      @click="loadPreviousUsers"
      :disabled="userPagination.offset === 0"
      class="pagination-btn"
    >Previous</button>
    <span class="pagination-info">
      {{ userPagination.offset + 1 }}-{{ Math.min(userPagination.offset + userPagination.limit, userPagination.total) }}
      of {{ userPagination.total }}
    </span>
    <button
      @click="loadNextUsers"
      :disabled="userPagination.offset + userPagination.limit >= userPagination.total"
      class="pagination-btn"
    >Next</button>
  </div>
</div>


<!-- User Servers Modal -->
<Teleport to="body">
  <div v-if="showServersModal" class="modal-overlay" @click.self="closeServersModal">
    <div class="modal-content servers-modal">
      <div class="modal-header">
        <h3>
          <Icon name="server" :size="20" />
          Servers for <DisplayName v-if="selectedUserForServers?.id" :user-id="selectedUserForServers.id" :fallback="selectedUserForServers?.display_name || selectedUserForServers?.username" /><template v-else>{{ selectedUserForServers?.display_name || selectedUserForServers?.username }}</template>
        </h3>
        <button @click="closeServersModal" class="close-btn">
          <Icon name="close" :size="20" />
        </button>
      </div>
      <div class="modal-body">
        <div v-if="loadingServers" class="loading-state">
          <LoadingSpinner :size="20" />
          <span>Loading servers...</span>
        </div>
        <div v-else-if="userServers.length === 0" class="empty-state">
          <Icon name="server" :size="32" />
          <p>This user is not a member of any servers.</p>
        </div>
        <div v-else class="servers-list">
          <div 
            v-for="server in userServers" 
            :key="server.id" 
            class="server-item"
          >
            <div class="server-icon">
              <img 
                v-if="server.icon_url" 
                :src="getServerIconUrl(server.icon_url)" 
                :alt="server.name"
              />
              <div v-else class="server-icon-placeholder">
                {{ server.name.charAt(0).toUpperCase() }}
              </div>
            </div>
            <div class="server-info">
              <div class="server-name">
                {{ server.name }}
                <span v-if="server.is_owner" class="badge owner">Owner</span>
              </div>
              <div class="server-meta">
                <span class="member-count">
                  <Icon name="users" :size="12" />
                  {{ server.member_count }} members
                </span>
                <span class="join-date">
                  Joined {{ formatDate(server.joined_at) }}
                </span>
              </div>
            </div>
            <div class="server-actions">
              <button 
                @click="navigateToServer(server.id)" 
                class="action-btn-sm"
                title="View server"
              >
                <Icon name="arrow-right" :size="14" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import { adminService, type AdminUser } from '@/services/AdminService'
import { userDataService } from '@/services/userDataService'
import { getServerIconUrl } from '@/utils/serverUtils'
import { formatDate } from './adminFormat'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

const authStore = useAuthStore()
const router = useRouter()
const toast = useToast()
const { confirm } = useConfirmDialog()

const userSearch = ref('')
const activeUserFilter = ref('all')
const showServersModal = ref(false)
const selectedUserForServers = ref<AdminUser | null>(null)
const userServers = ref<{
  id: string;
  name: string;
  icon_url: string | null;
  member_count: number;
  owner_id: string;
  is_owner: boolean;
  joined_at: string;
}[]>([])
const loadingServers = ref(false)
const users = ref<AdminUser[]>([])
const userCounts = ref({ total: 0, local: 0, federated: 0, suspended: 0 })
const userFilters = computed(() => [
  { key: 'all', label: 'All Users', count: userCounts.value.total },
  { key: 'local', label: 'Local', count: userCounts.value.local },
  { key: 'federated', label: 'Federated', count: userCounts.value.federated },
  { key: 'suspended', label: 'Suspended', count: userCounts.value.suspended }
])

// Filtering/search happens server-side in adminService.getUsers so pagination
// totals match the filtered set; this list is served as-is.
const filteredUsers = computed(() => users.value)

let userSearchDebounce: ReturnType<typeof setTimeout> | null = null
watch(activeUserFilter, () => {
  userPagination.value.offset = 0
  loadUsers()
})
watch(userSearch, () => {
  if (userSearchDebounce) clearTimeout(userSearchDebounce)
  userSearchDebounce = setTimeout(() => {
    userPagination.value.offset = 0
    loadUsers()
  }, 300)
})
const userPagination = ref({ offset: 0, limit: 25, total: 0 })

const loadUserCounts = async () => {
  try {
    userCounts.value = await adminService.getUserCounts()
  } catch (error) {
    debug.error('Failed to load user counts:', error)
    userCounts.value = { total: 0, local: 0, federated: 0, suspended: 0 }
  }
}

const loadUsers = async () => {
  try {
    const result = await adminService.getUsers(
      userPagination.value.limit,
      userPagination.value.offset,
      {
        filter: activeUserFilter.value as 'all' | 'local' | 'federated' | 'suspended',
        search: userSearch.value,
      }
    )
    users.value = result.users
    userPagination.value.total = result.total
    // Prime user cache so DisplayName can resolve custom emojis in admin list
    if (result.users.length > 0) {
      userDataService.ensureUsersLoaded(result.users.map((u) => u.id)).catch(() => {})
    }
  } catch (error) {
    debug.error('Failed to load users:', error)
    users.value = []
  }
}

const loadNextUsers = () => {
  userPagination.value.offset += userPagination.value.limit
  loadUsers()
}

const loadPreviousUsers = () => {
  userPagination.value.offset = Math.max(0, userPagination.value.offset - userPagination.value.limit)
  loadUsers()
}


const toggleModerator = async (user: any) => {
  const newStatus = !user.is_moderator
  const label = newStatus ? 'promote to moderator' : 'remove moderator from'
  if (!(await confirm({ title: 'Moderator status', message: `Are you sure you want to ${label} ${user.username}?`, confirmButtonText: 'Confirm' }))) return

  try {
    await adminService.setModeratorStatus(user.id, newStatus)
    user.is_moderator = newStatus
    window.dispatchEvent(new CustomEvent('admin:activity-changed'))
  } catch (error) {
    debug.error('Failed to toggle moderator status:', error)
    toast.error('Failed to update moderator status.')
  }
}

// Patch the row in place instead of reloading the whole page of users; drop
// the row when it no longer matches the active server-side filter.
const patchUserRow = (userId: string, patch: Record<string, any> | null) => {
  if (patch === null) {
    users.value = users.value.filter((u: any) => u.id !== userId)
    userPagination.value.total = Math.max(0, userPagination.value.total - 1)
    return
  }
  const row: any = users.value.find((u: any) => u.id === userId)
  if (row) Object.assign(row, patch)
  const f = activeUserFilter.value
  if ((f === 'suspended' && patch.is_suspended === false)) {
    patchUserRow(userId, null)
  }
  loadUserCounts().catch(() => {})
}

const moderateUser = async (user: any, action: string) => {
  try {
    if (action === 'suspend') {
      const reason = prompt('Suspension reason:')
      if (!reason) return
      await adminService.moderateUser(user.id, 'suspend', reason, authStore.session?.user?.id || '')
      patchUserRow(user.id, { is_suspended: true, suspension_reason: reason })
      window.dispatchEvent(new CustomEvent('admin:activity-changed'))
      toast.success(`User ${user.username} has been suspended.`)
    } else if (action === 'unsuspend') {
      if (!(await confirm({ title: 'Unsuspend user', message: `Are you sure you want to unsuspend user ${user.username}?`, confirmButtonText: 'Unsuspend' }))) return
      await adminService.moderateUser(user.id, 'unsuspend', 'Admin unsuspend', authStore.session?.user?.id || '')
      patchUserRow(user.id, { is_suspended: false, suspension_reason: null })
      window.dispatchEvent(new CustomEvent('admin:activity-changed'))
      toast.success(`User ${user.username} has been unsuspended.`)
    } else if (action === 'delete') {
      if (!(await confirm({ title: 'Delete user', message: `Are you sure you want to delete user ${user.username}? This cannot be undone.`, confirmButtonText: 'Delete', dangerAction: true }))) return
      await adminService.moderateUser(user.id, 'delete', 'Admin deletion', authStore.session?.user?.id || '')
      patchUserRow(user.id, null)
      window.dispatchEvent(new CustomEvent('admin:activity-changed'))
      toast.success(`User ${user.username} has been deleted.`)
    } else if (action === 'force_sensitive') {
      const reason = prompt('Reason for marking all media as sensitive:')
      if (!reason) return
      await adminService.moderateUser(user.id, 'force_sensitive', reason, authStore.session?.user?.id || '')
      patchUserRow(user.id, { force_sensitive: true })
      toast.success(`All future media from ${user.username} will be marked sensitive.`)
    } else if (action === 'unforce_sensitive') {
      if (!(await confirm({ title: 'Remove force-sensitive', message: `Remove force-sensitive from ${user.username}?`, confirmButtonText: 'Remove' }))) return
      await adminService.moderateUser(user.id, 'unforce_sensitive', '', authStore.session?.user?.id || '')
      patchUserRow(user.id, { force_sensitive: false })
      toast.success(`Force-sensitive removed from ${user.username}.`)
    } else if (action === 'silence') {
      const reason = prompt('Reason for silencing (hidden from public timelines):')
      if (!reason) return
      await adminService.moderateUser(user.id, 'silence', reason, authStore.session?.user?.id || '')
      patchUserRow(user.id, { is_silenced: true, silenced_reason: reason })
      toast.success(`User ${user.username} has been silenced.`)
    } else if (action === 'unsilence') {
      if (!(await confirm({ title: 'Remove silence', message: `Remove silence from ${user.username}?`, confirmButtonText: 'Remove' }))) return
      await adminService.moderateUser(user.id, 'unsilence', '', authStore.session?.user?.id || '')
      patchUserRow(user.id, { is_silenced: false, silenced_reason: null })
      toast.success(`User ${user.username} has been unsilenced.`)
    }
  } catch (error: any) {
    debug.error('Failed to moderate user:', error)
    toast.error(`Failed to ${action} user: ${error.message || 'Unknown error'}`)
  }
}

const navigateToUserPosts = (user: any) => {
  const handle = (user.domain && user.domain !== import.meta.env.VITE_DOMAIN as string)
    ? `${user.username}@${user.domain}`
    : user.username
  router.push({ name: 'UserProfile', params: { handle } })
}

const navigateToUserServers = async (user: AdminUser) => {
  // Open modal and load user's servers
  selectedUserForServers.value = user
  showServersModal.value = true
  loadingServers.value = true
  
  try {
    userServers.value = await adminService.getUserServers(user.id)
  } catch (error) {
    debug.error('Failed to load user servers:', error)
    userServers.value = []
  } finally {
    loadingServers.value = false
  }
}

const closeServersModal = () => {
  showServersModal.value = false
  selectedUserForServers.value = null
  userServers.value = []
}

const navigateToServer = (serverId: string) => {
  closeServersModal()
  router.push(`/chat/${serverId}`)
}


const onUsersChanged = () => { void loadUsers(); void loadUserCounts() }
onMounted(() => {
  void loadUsers()
  void loadUserCounts()
  window.addEventListener('admin:users-changed', onUsersChanged)
})
onUnmounted(() => window.removeEventListener('admin:users-changed', onUsersChanged))
</script>

<style scoped>




/* Users Module */
.users-content {
  padding: 24px;
}





.user-filters {
  display: flex;
  gap: 8px;
  margin-bottom: 24px;
}





.filter-btn {
  padding: 8px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}





.filter-btn:hover, .filter-btn.active {
  background: var(--accent-color);
  border-color: var(--accent-color);
  color: var(--text-primary);
}





.search-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
}





.search-bar .cyber-input {
  padding-left: 36px;
  max-width: 200px;
}





.search-bar .icon {
  position: absolute;
  left: 12px;
  color: var(--text-secondary);
}





.users-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 600px;
  overflow-y: auto;
}





.user-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
  margin: 8px 0;
}





.user-item:hover {
  border-color: var(--accent-color);
}





.user-info {
  flex: 1;
}





.user-name {
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}





.user-meta {
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  gap: 12px;
  align-items: center;
}





.user-stats {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}





.user-stat {
  background: none;
  border: none;
  color: inherit;
  font-size: inherit;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: all 0.2s ease;
}





.user-stat.clickable:hover {
  background: rgba(0, 212, 255, 0.1);
  color: #00d4ff;
  transform: translateY(-1px);
}





.user-actions {
  display: flex;
  gap: 8px;
}





.mod-btn {
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}





.mod-btn:hover {
  border-color: var(--accent-color);
  color: var(--text-primary);
}





.suspend-btn:hover {
  border-color: #ffc107;
  color: #ffc107;
}





.delete-btn:hover {
  border-color: #ff453a;
  color: #ff453a;
}





.unsuspend-btn {
  border-color: rgba(0, 255, 136, 0.3);
  color: #00ff88;
}





.unsuspend-btn:hover {
  border-color: #00ff88;
  background: rgba(0, 255, 136, 0.1);
}





/* Suspended user styling */
.user-item.user-suspended {
  opacity: 0.25;
  background: rgba(255, 193, 7, 0.05);
  border-color: rgba(255, 193, 7, 0.3);
}





.user-name {
  display: flex;
  align-items: center;
  gap: 8px;
}





.user-name .badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
  text-transform: uppercase;
}





.promote-btn {
  color: #2ecc71 !important;
  &:hover { background: rgba(46, 204, 113, 0.2) !important; }
}





.demote-btn {
  color: #e67e22 !important;
  &:hover { background: rgba(230, 126, 34, 0.2) !important; }
}





.suspension-reason {
  font-style: italic;
  color: #ffc107;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}




.server-icon {
  width: 100%;
  height: 100%;
  border-radius: 8px;
  object-fit: cover;
}




.server-details .server-name { font-weight: 600; color: var(--text-primary); }




.server-details .server-meta { font-size: 13px; color: var(--text-secondary); }

@media (max-width: 768px) {



  .user-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }



  .user-actions {
    align-self: flex-end;
  }
}

@media (max-width: 480px) {


  /* Wide rows (instance lists, user rows) scroll instead of overflowing. */
  .users-list,
  .servers-list,
  .reports-list,
  .supporters-list,
  .discovery-content {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
}





/* Modal Styles */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}





.modal-content {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  max-width: 600px;
  width: 90%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}





.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
  background: linear-gradient(135deg, rgba(0, 212, 255, 0.05), rgba(0, 255, 136, 0.05));
}





.modal-header h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 18px;
  font-weight: 600;
}





.close-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s ease;
}





.close-btn:hover {
  background: var(--background-tertiary);
  color: var(--text-primary);
}





.modal-body {
  padding: 24px;
  overflow-y: auto;
  flex: 1;
}





.servers-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}





.server-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
}





.server-item:hover {
  border-color: var(--accent-color);
}





.server-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
}





.server-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}





.server-icon-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, rgba(0, 212, 255, 0.2), rgba(0, 255, 136, 0.2));
  color: var(--accent-color);
  font-size: 20px;
  font-weight: 700;
}





.server-info {
  flex: 1;
  min-width: 0;
}





.server-name {
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
}





.server-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-secondary);
}





.member-count {
  display: flex;
  align-items: center;
  gap: 4px;
}





.server-actions {
  flex-shrink: 0;
}





.mod-btn.warning-btn {
  background: rgba(250, 166, 26, 0.15);
  color: #faa61a;
}





.mod-btn.warning-btn:hover {
  background: rgba(250, 166, 26, 0.3);
}
</style>

<style scoped src="./adminShared.css"></style>
