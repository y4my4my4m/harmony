<template>
  <div>
<div class="admin-module users-module">
  <div class="module-header">
    <Icon name="users" :size="20" />
    <h2>{{ t('admin.users.title') }}</h2>
    <div class="search-bar">
      <Icon name="search" :size="16" />
      <input v-model="userSearch" :placeholder="t('admin.users.searchPlaceholder')" :aria-label="t('admin.users.searchLabel')" class="cyber-input" />
    </div>
  </div>
  <div class="users-content">
    <div class="user-filters">
      <button 
        v-for="filter in userFilters" 
        :key="filter.key"
        @click="activeUserFilter = filter.key"
        :class="['filter-btn', { active: activeUserFilter === filter.key }]"
        :data-testid="`user-filter-${filter.key}`"
      >
        {{ t('admin.users.filterCount', { label: t(filter.label), count: `${filter.approximate ? '≈' : ''}${filter.count}` }) }}
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
            <span v-if="user.is_suspended" class="badge suspended">{{ t('hostStaff.suspendedBadge') }}</span>
            <span v-if="user.is_admin" class="badge admin">{{ t('admin.users.badgeAdmin') }}</span>
            <span v-if="user.is_moderator && !user.is_admin" class="badge moderator">{{ t('admin.users.badgeMod') }}</span>
            <span v-if="user.force_sensitive" class="badge sensitive" :title="t('admin.users.forceSensitiveTitle')">{{ t('admin.users.badgeForceSensitive') }}</span>
            <span v-if="user.is_silenced" class="badge silenced" :title="t('admin.users.silencedTitle')">{{ t('admin.users.badgeSilenced') }}</span>
          </div>
          <div class="user-meta">
            {{ user.handle }}
            <CopyIdButton :id="user.id" kind="user" :target="user.handle" />
            <span class="user-joined">{{ t('admin.users.joined', { date: formatDate(user.created_at) }) }}</span>
            <span v-if="user.is_suspended && user.suspension_reason" class="suspension-reason">
              - {{ user.suspension_reason }}
            </span>
          </div>
        </div>
        <div class="user-stats">
          <button @click="navigateToUserPosts(user)" class="user-stat clickable">
            {{ t('admin.users.postCount', { count: user.postCount }, user.postCount) }}
          </button>
          <button 
            v-if="user.is_local" 
            @click="navigateToUserServers(user)" 
            class="user-stat clickable"
          >
            {{ t('admin.users.serverCount', { count: user.serverCount }, user.serverCount) }}
          </button>
          <span v-else class="user-stat">{{ t('admin.users.federatedStat') }}</span>
        </div>
        <div v-if="user.is_local" class="user-actions">
          <button
            type="button"
            class="mod-btn"
            :title="t('uploadLimits.user.open', { name: user.display_name || user.username })"
            :aria-label="t('uploadLimits.user.open', { name: user.display_name || user.username })"
            data-testid="user-upload-limit"
            @click="openUploadLimit(user)"
          >
            <Icon name="upload" :size="16" />
          </button>
          <button
            v-if="isAdmin && limitExemptSupported"
            type="button"
            class="mod-btn"
            :class="{ 'limit-exempt-on': exemptIds.has(user.id) }"
            :title="t(exemptIds.has(user.id) ? 'admin.limitExempt.remove' : 'admin.limitExempt.add', { name: user.display_name || user.username })"
            :aria-label="t(exemptIds.has(user.id) ? 'admin.limitExempt.remove' : 'admin.limitExempt.add', { name: user.display_name || user.username })"
            :aria-pressed="exemptIds.has(user.id)"
            data-testid="user-limit-exempt"
            @click="toggleLimitExempt(user)"
          >
            <Icon name="zap" :size="16" />
          </button>
        </div>
        <div v-if="canModerate(user)" class="user-actions">
          <button
            v-if="isAdmin && !user.is_admin && user.is_local"
            @click="toggleModerator(user)"
            class="mod-btn"
            :class="user.is_moderator ? 'demote-btn' : 'promote-btn'"
            :title="user.is_moderator ? t('admin.users.removeModerator') : t('admin.users.makeModerator')"
            :aria-label="user.is_moderator ? t('admin.users.removeModerator') : t('admin.users.makeModerator')"
          >
            <Icon :name="user.is_moderator ? 'shield-off' : 'shield'" :size="16" />
          </button>
          <button
            @click="moderateUser(user, user.force_sensitive ? 'unforce_sensitive' : 'force_sensitive')"
            class="mod-btn"
            :class="user.force_sensitive ? 'unsuspend-btn' : 'warning-btn'"
            :title="user.force_sensitive ? t('admin.users.removeForceSensitive') : t('admin.users.forceSensitive')"
            :aria-label="user.force_sensitive ? t('admin.users.removeForceSensitive') : t('admin.users.forceSensitive')"
          >
            <Icon :name="user.force_sensitive ? 'eye' : 'eye-off'" :size="16" />
          </button>
          <button
            @click="moderateUser(user, user.is_silenced ? 'unsilence' : 'silence')"
            class="mod-btn"
            :class="user.is_silenced ? 'unsuspend-btn' : 'warning-btn'"
            :title="user.is_silenced ? t('admin.users.removeSilence') : t('admin.users.silence')"
            :aria-label="user.is_silenced ? t('admin.users.removeSilence') : t('admin.users.silence')"
          >
            <Icon :name="user.is_silenced ? 'volume-2' : 'volume-x'" :size="16" />
          </button>
          <button 
            v-if="user.is_suspended"
            @click="moderateUser(user, 'unsuspend')" 
            class="mod-btn unsuspend-btn"
            :title="t('admin.users.unsuspendUser')"
            :aria-label="t('admin.users.unsuspendUser')"
          >
            <Icon name="check" :size="16" />
          </button>
          <button 
            v-else
            @click="moderateUser(user, 'suspend')" 
            class="mod-btn suspend-btn"
            :title="t('admin.users.suspendUser')"
            :aria-label="t('admin.users.suspendUser')"
          >
            <Icon name="suspend" :size="16" />
          </button>
          <button 
            v-if="isAdmin"
            @click="moderateUser(user, 'delete')" 
            class="mod-btn delete-btn"
            :title="t('admin.users.deleteUser')"
            :aria-label="t('admin.users.deleteUser')"
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
    >{{ t('admin.instanceEmojis.previous') }}</button>
    <span class="pagination-info">
      {{ t('admin.instanceEmojis.range', { from: userPagination.offset + 1, to: Math.min(userPagination.offset + userPagination.limit, userPagination.total), total: userPagination.total }) }}
    </span>
    <button
      @click="loadNextUsers"
      :disabled="userPagination.offset + userPagination.limit >= userPagination.total"
      class="pagination-btn"
    >{{ t('admin.instanceEmojis.next') }}</button>
  </div>
</div>


<!-- User Servers Modal -->
<Teleport to="body">
  <div v-if="showServersModal" class="modal-overlay" @click.self="closeServersModal">
    <div class="modal-content servers-modal">
      <div class="modal-header">
        <h3>
          <Icon name="server" :size="20" />
          <i18n-t keypath="admin.users.serversFor" tag="span">
            <template #name><DisplayName v-if="selectedUserForServers?.id" :user-id="selectedUserForServers.id" :fallback="selectedUserForServers?.display_name || selectedUserForServers?.username" /><template v-else>{{ selectedUserForServers?.display_name || selectedUserForServers?.username }}</template></template>
          </i18n-t>
        </h3>
        <button @click="closeServersModal" class="close-btn" :aria-label="t('common.close')">
          <Icon name="close" :size="20" />
        </button>
      </div>
      <div class="modal-body">
        <div v-if="loadingServers" class="loading-state">
          <LoadingSpinner :size="20" />
          <span>{{ t('admin.users.loadingServers') }}</span>
        </div>
        <EmptyState
          v-else-if="userServers.length === 0"
          size="sm"
          icon="server"
          :title="t('empty.admin.userServers.title')"
        />
        <div v-else class="servers-list">
          <div 
            v-for="server in userServers" 
            :key="server.id" 
            class="server-item"
          >
            <div class="server-icon">
              <img 
                v-if="server.icon_url || server.name"
                :src="getServerIconUrl(server.icon_url, 96, server.name)" 
                :alt="server.name"
              />
              <div v-else class="server-icon-placeholder">
                {{ server.name.charAt(0).toUpperCase() }}
              </div>
            </div>
            <div class="server-info">
              <div class="server-name">
                {{ server.name }}
                <span v-if="server.is_owner" class="badge owner">{{ t('hostStaff.ownerBadge') }}</span>
                <CopyIdButton :id="server.id" kind="server" :target="server.name" />
              </div>
              <div class="server-meta">
                <span class="member-count">
                  <Icon name="users" :size="12" />
                  {{ t('server.membersCount', { count: server.member_count }, server.member_count) }}
                </span>
                <span class="join-date">
                  {{ t('admin.users.joined', { date: formatDate(server.joined_at) }) }}
                </span>
              </div>
            </div>
            <div class="server-actions">
              <button 
                @click="navigateToServer(server.id)" 
                class="action-btn-sm"
                :title="t('admin.users.viewServer')"
                :aria-label="t('admin.users.viewServer')"
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
  <UploadLimitDialog
    :show="uploadLimitUser !== null"
    :profile-id="uploadLimitUser?.id ?? null"
    :name="uploadLimitUser?.display_name || uploadLimitUser?.username || ''"
    @close="uploadLimitUser = null"
  />
  </div>
</template>

<script setup lang="ts">
import { hasCapability } from '@/services/instanceCapabilities'
import { profileHandleParam } from '@/utils/permalinks'
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { useAuthStore } from '@/stores/auth'
import { useProfileStore } from '@/stores/useProfile'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import CopyIdButton from './CopyIdButton.vue'
import { adminService, type AdminUser } from '@/services/AdminService'
import { userDataService } from '@/services/userDataService'
import { getServerIconUrl } from '@/utils/serverUtils'
import { formatDate } from './adminFormat'
import { applyUserChange, useInstanceStats, type UserFlags } from '@/composables/useInstanceStats'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useT } from '@/composables/useT'
import UploadLimitDialog from './UploadLimitDialog.vue'

const authStore = useAuthStore()
const profileStore = useProfileStore()
const isAdmin = computed(() => profileStore.profile?.is_admin === true)
// Nobody acts on their own account; moderators only on accounts that are not staff (moderate_user).
const canModerate = (user: any): boolean =>
  user.id !== profileStore.profile?.id && (isAdmin.value || (!user.is_admin && !user.is_moderator))
const router = useRouter()
const toast = useToast()
const { t } = useT()
const uploadLimitUser = ref<AdminUser | null>(null)
const openUploadLimit = (user: AdminUser) => { uploadLimitUser.value = user }

const limitExemptSupported = hasCapability('instance-limits')
const exemptIds = ref(new Set<string>())

watch(isAdmin, async (admin) => {
  if (!admin || !limitExemptSupported) return
  const { data, error } = await supabase.from('limit_exempt_accounts').select('profile_id')
  if (error) debug.error('Failed to load limit exemptions:', error)
  else exemptIds.value = new Set((data ?? []).map((row) => row.profile_id))
}, { immediate: true })

const toggleLimitExempt = async (user: AdminUser) => {
  const exempt = !exemptIds.value.has(user.id)
  const { error } = await supabase.rpc('admin_set_limit_exempt', { p_profile: user.id, p_exempt: exempt })
  if (error) {
    debug.error('Failed to change limit exemption:', error)
    toast.error(t('admin.limitExempt.failed'))
    return
  }
  const next = new Set(exemptIds.value)
  if (exempt) next.add(user.id)
  else next.delete(user.id)
  exemptIds.value = next
  toast.success(t(exempt ? 'admin.limitExempt.added' : 'admin.limitExempt.removed', { name: user.display_name || user.username }))
}
const { confirm, prompt } = useConfirmDialog()

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
// Filter counts come from the statistics snapshot; this tab's own changes move them at once.
const { stats, load: loadStats, adjust: adjustStats } = useInstanceStats()
const userFilters = computed(() => {
  const counts = stats.value?.users
  const approximate = (column: string) => stats.value?.approximate.includes(column) === true
  return [
    { key: 'all', label: 'admin.users.filters.all', count: counts?.total ?? 0, approximate: approximate('users_total') },
    { key: 'local', label: 'admin.users.filters.local', count: counts?.local ?? 0, approximate: approximate('users_local') },
    { key: 'federated', label: 'admin.users.filters.federated', count: counts?.federated ?? 0, approximate: approximate('users_federated') },
    { key: 'suspended', label: 'admin.users.filters.suspended', count: counts?.suspended ?? 0, approximate: approximate('users_suspended') },
  ]
})
const recordUserChange = (before: UserFlags, after: UserFlags) =>
  adjustStats((s) => applyUserChange(s.users, before, after))

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
  const message = newStatus
    ? t('admin.users.promoteConfirm', { name: user.username })
    : t('admin.users.demoteConfirm', { name: user.username })
  if (!(await confirm({ title: t('admin.users.moderatorStatus'), message, confirmButtonText: t('common.confirm') }))) return

  try {
    user.is_moderator = await adminService.setModeratorStatus(user.id, newStatus)
    toast.success(user.is_moderator ? t('admin.users.promoted', { name: user.username }) : t('admin.users.demoted', { name: user.username }))
    window.dispatchEvent(new CustomEvent('admin:activity-changed'))
  } catch (error) {
    debug.error('Failed to toggle moderator status:', error)
    toast.error(error instanceof Error ? error.message : t('admin.users.moderatorFailed'))
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
}

const moderateUser = async (user: any, action: string) => {
  const before: UserFlags = { is_local: user.is_local, is_suspended: user.is_suspended }
  try {
    if (action === 'suspend') {
      const reason = (await prompt({ title: t('admin.users.suspendUser'), message: t('admin.users.suspendConfirm', { name: user.username }), label: t('moderation.reason'), confirmButtonText: t('admin.users.suspend'), dangerAction: true }))?.trim()
      if (!reason) return
      await adminService.moderateUser(user.id, 'suspend', reason, authStore.session?.user?.id || '')
      recordUserChange(before, { ...before, is_suspended: true })
      patchUserRow(user.id, { is_suspended: true, suspension_reason: reason })
      window.dispatchEvent(new CustomEvent('admin:activity-changed'))
      toast.success(t('admin.users.suspended', { name: user.username }))
    } else if (action === 'unsuspend') {
      if (!(await confirm({ title: t('admin.users.unsuspendUser'), message: t('admin.users.unsuspendConfirm', { name: user.username }), confirmButtonText: t('admin.users.unsuspend') }))) return
      await adminService.moderateUser(user.id, 'unsuspend', 'Admin unsuspend', authStore.session?.user?.id || '')
      recordUserChange(before, { ...before, is_suspended: false })
      patchUserRow(user.id, { is_suspended: false, suspension_reason: null })
      window.dispatchEvent(new CustomEvent('admin:activity-changed'))
      toast.success(t('admin.users.unsuspended', { name: user.username }))
    } else if (action === 'delete') {
      if (!(await confirm({ title: t('admin.users.deleteUser'), message: t('admin.users.deleteConfirm', { name: user.username }), confirmButtonText: t('common.delete'), dangerAction: true }))) return
      await adminService.moderateUser(user.id, 'delete', 'Admin deletion', authStore.session?.user?.id || '')
      // AdminService's delete is a suspension; the profile row stays.
      recordUserChange(before, { ...before, is_suspended: true })
      patchUserRow(user.id, null)
      window.dispatchEvent(new CustomEvent('admin:activity-changed'))
      toast.success(t('admin.users.deleted', { name: user.username }))
    } else if (action === 'force_sensitive') {
      const reason = (await prompt({ title: t('admin.users.forceSensitiveTitleDialog'), message: t('admin.users.forceSensitiveConfirm', { name: user.username }), label: t('moderation.reason'), confirmButtonText: t('admin.reports.actions.markSensitive') }))?.trim()
      if (!reason) return
      await adminService.moderateUser(user.id, 'force_sensitive', reason, authStore.session?.user?.id || '')
      patchUserRow(user.id, { force_sensitive: true })
      toast.success(t('admin.users.forceSensitiveDone', { name: user.username }))
    } else if (action === 'unforce_sensitive') {
      if (!(await confirm({ title: t('admin.users.removeForceSensitive'), message: t('admin.users.removeForceSensitiveConfirm', { name: user.username }), confirmButtonText: t('common.remove') }))) return
      await adminService.moderateUser(user.id, 'unforce_sensitive', '', authStore.session?.user?.id || '')
      patchUserRow(user.id, { force_sensitive: false })
      toast.success(t('admin.users.removeForceSensitiveDone', { name: user.username }))
    } else if (action === 'silence') {
      const reason = (await prompt({ title: t('admin.users.silenceUser'), message: t('admin.users.silenceConfirm', { name: user.username }), label: t('moderation.reason'), confirmButtonText: t('admin.users.silenceButton') }))?.trim()
      if (!reason) return
      await adminService.moderateUser(user.id, 'silence', reason, authStore.session?.user?.id || '')
      patchUserRow(user.id, { is_silenced: true, silenced_reason: reason })
      toast.success(t('admin.users.silenced', { name: user.username }))
    } else if (action === 'unsilence') {
      if (!(await confirm({ title: t('admin.users.removeSilence'), message: t('admin.users.removeSilenceConfirm', { name: user.username }), confirmButtonText: t('common.remove') }))) return
      await adminService.moderateUser(user.id, 'unsilence', '', authStore.session?.user?.id || '')
      patchUserRow(user.id, { is_silenced: false, silenced_reason: null })
      toast.success(t('admin.users.unsilenced', { name: user.username }))
    }
  } catch (error: any) {
    debug.error('Failed to moderate user:', error)
    toast.error(t('admin.users.actionFailed', { name: user.username, error: error.message || t('admin.users.unknownError') }))
  }
}

const navigateToUserPosts = (user: any) => {
  const handle = profileHandleParam(user)
  if (handle) router.push({ name: 'UserProfile', params: { handle } })
}

const navigateToUserServers = async (user: AdminUser) => {
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


// The event's UsersDelta moves the shared counts (useInstanceStats); the page reloads here.
const onUsersChanged = () => { void loadUsers() }
onMounted(() => {
  void loadUsers()
  void loadStats()
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
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}





.filter-btn:hover, .filter-btn.active {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
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
  border-radius: var(--radius-md);
  transition: all 0.2s ease;
  margin: 8px 0;
}





.user-item:hover {
  border-color: var(--harmony-primary);
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
  border-radius: var(--radius-sm);
  transition: all 0.2s ease;
}





.user-stat.clickable:hover {
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  color: var(--text-link);
}





.user-actions {
  display: flex;
  gap: 8px;
}





.mod-btn {
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  background: var(--background-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}





.mod-btn:hover {
  border-color: var(--harmony-primary);
  color: var(--text-primary);
}





.suspend-btn:hover {
  border-color: var(--warning);
  color: var(--warning);
}





.delete-btn:hover {
  border-color: var(--error);
  color: var(--text-danger);
}





.unsuspend-btn {
  border-color: color-mix(in srgb, var(--success) 30%, transparent);
  color: var(--text-success);
}





.unsuspend-btn:hover {
  border-color: var(--success);
  background: color-mix(in srgb, var(--success) 10%, transparent);
}





/* Suspended user styling */
.user-item.user-suspended {
  opacity: 0.25;
  background: color-mix(in srgb, var(--warning) 5%, transparent);
  border-color: color-mix(in srgb, var(--warning) 30%, transparent);
}





.user-name {
  display: flex;
  align-items: center;
  gap: 8px;
}





.user-name .badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  font-weight: 600;
  text-transform: uppercase;
}





.promote-btn {
  color: var(--text-success) !important;
  &:hover { background: color-mix(in srgb, var(--success) 20%, transparent) !important; }
}





.demote-btn {
  color: var(--warning) !important;
  &:hover { background: color-mix(in srgb, var(--warning) 20%, transparent) !important; }
}





.suspension-reason {
  font-style: italic;
  color: var(--warning);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}




.server-icon {
  width: 100%;
  height: 100%;
  border-radius: var(--radius-md);
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
  border-radius: var(--radius-lg);
  max-width: 600px;
  width: 90%;
  max-height: calc(80 * var(--app-vh));
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-large);
}





.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
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
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-md);
  transition: all 0.2s ease;
}





.server-item:hover {
  border-color: var(--harmony-primary);
}





.server-icon {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-lg);
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
  background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  color: var(--text-link);
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





.mod-btn.limit-exempt-on,
.mod-btn.limit-exempt-on:hover {
  background: var(--harmony-primary-fill);
  border-color: var(--harmony-primary-fill);
  color: var(--text-on-primary);
}

.mod-btn.warning-btn {
  background: color-mix(in srgb, var(--warning) 15%, transparent);
  color: var(--warning);
}





.mod-btn.warning-btn:hover {
  background: color-mix(in srgb, var(--warning) 30%, transparent);
}
</style>

<style scoped src="./adminShared.css"></style>
