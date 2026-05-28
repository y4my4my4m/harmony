<template>
  <div class="invite-management">
    <div class="management-header">
      <h2 class="management-title">Invite Management</h2>
      <p class="management-description">
        View and manage all active invites for this server
      </p>
      <div class="header-actions">
        <button @click="refreshInvites" class="refresh-button" :disabled="isLoading">
          <svg viewBox="0 0 24 24" class="refresh-icon" :class="{ spinning: isLoading }">
            <path d="M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z" fill="currentColor"/>
          </svg>
          Refresh
        </button>
        <button @click="$emit('create-invite')" class="create-button">
          <svg viewBox="0 0 24 24" class="plus-icon">
            <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
          </svg>
          Create Invite
        </button>
      </div>
    </div>

    <!-- Filters -->
    <div class="filters-section">
      <div class="filter-group">
        <label class="filter-label">Status</label>
        <select v-model="statusFilter" class="filter-select" @change="applyFilters">
          <option value="all">All Invites</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="used-up">Used Up</option>
          <option value="revoked">Revoked</option>
        </select>
      </div>
      
      <div class="filter-group">
        <label class="filter-label">Created By</label>
        <select v-model="creatorFilter" class="filter-select" @change="applyFilters">
          <option value="all">All Members</option>
          <option v-for="creator in uniqueCreators" :key="creator.id" :value="creator.id">
            {{ creator.display_name }}
          </option>
        </select>
      </div>

      <div class="filter-group">
        <label class="filter-label">Search</label>
        <div class="search-input-container">
          <svg viewBox="0 0 24 24" class="search-icon">
            <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
          </svg>
          <input 
            v-model="searchQuery" 
            type="text" 
            placeholder="Search invite codes..."
            class="search-input"
            @input="applyFilters"
          />
        </div>
      </div>
    </div>

    <!-- Stats -->
    <div class="stats-section">
      <div class="stat-card">
        <div class="stat-value">{{ stats.total }}</div>
        <div class="stat-label">Total Invites</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.active }}</div>
        <div class="stat-label">Active</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.expired }}</div>
        <div class="stat-label">Expired</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">{{ stats.totalUses }}</div>
        <div class="stat-label">Total Uses</div>
      </div>
    </div>

    <!-- Invites Table -->
    <div class="invites-table-container">
      <div v-if="isLoading" class="loading-state">
        <div class="loading-spinner"></div>
        <p>Loading invites...</p>
      </div>

      <div v-else-if="filteredInvites.length === 0" class="empty-state">
        <svg viewBox="0 0 24 24" class="empty-icon">
          <path d="M18,16.08C17.24,16.08 16.56,16.38 16.04,16.85L8.91,12.7C8.96,12.47 9,12.24 9,12C9,11.76 8.96,11.53 8.91,11.3L15.96,7.19C16.5,7.69 17.21,8 18,8A3,3 0 0,0 21,5A3,3 0 0,0 18,2A3,3 0 0,0 15,5C15,5.24 15.04,5.47 15.09,5.7L8.04,9.81C7.5,9.31 6.79,9 6,9A3,3 0 0,0 3,12A3,3 0 0,0 6,15C6.79,15 7.5,14.69 8.04,14.19L15.16,18.34C15.11,18.55 15.08,18.77 15.08,19C15.08,20.61 16.39,21.91 18,21.91C19.61,21.91 20.92,20.6 20.92,19A2.84,2.84 0 0,0 18,16.08Z" fill="currentColor"/>
        </svg>
        <h3>No invites found</h3>
        <p>{{ getEmptyStateMessage() }}</p>
      </div>

      <div v-else class="invites-table">
        <div class="table-header">
          <div class="header-cell code">Invite Code</div>
          <div class="header-cell creator">Created By</div>
          <div class="header-cell status">Status</div>
          <div class="header-cell usage">Usage</div>
          <div class="header-cell expires">Expires</div>
          <div class="header-cell created">Created</div>
          <div class="header-cell actions">Actions</div>
        </div>

        <div class="table-body">
          <div 
            v-for="invite in paginatedInvites" 
            :key="invite.id"
            class="table-row"
            :class="{ 
              'expired': isInviteExpired(invite),
              'used-up': isInviteUsedUp(invite),
              'revoked': invite.used && !isInviteUsedUp(invite)
            }"
          >
            <div class="cell code">
              <div class="invite-code-display">
                <code class="invite-code">{{ invite.code }}</code>
                <button 
                  @click="copyInviteCode(invite.code)" 
                  class="copy-code-btn"
                  title="Copy invite URL"
                >
                  <svg viewBox="0 0 24 24" class="copy-icon">
                    <path d="M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z" fill="currentColor"/>
                  </svg>
                </button>
              </div>
              <div v-if="invite.temporary" class="temp-indicator">TEMP</div>
            </div>

            <div class="cell creator">
              <div class="creator-info">
                <img 
                  :src="getCreatorAvatar(invite.created_by)" 
                  :alt="getCreatorName(invite.created_by)"
                  class="creator-avatar"
                />
                <span class="creator-name">{{ getCreatorName(invite.created_by) }}</span>
              </div>
            </div>

            <div class="cell status">
              <span class="status-badge" :class="getInviteStatusClass(invite)">
                {{ getInviteStatus(invite) }}
              </span>
            </div>

            <div class="cell usage">
              <div class="usage-info">
                <span class="usage-count">{{ invite.uses || 0 }}</span>
                <span class="usage-separator">/</span>
                <span class="usage-max">{{ invite.max_uses || '∞' }}</span>
              </div>
              <div class="usage-bar">
                <div 
                  class="usage-fill" 
                  :style="{ width: getUsagePercentage(invite) + '%' }"
                ></div>
              </div>
            </div>

            <div class="cell expires">
              <span v-if="invite.expires_at" class="expires-time">
                {{ formatTimeRemaining(invite.expires_at) }}
              </span>
              <span v-else class="never-expires">Never</span>
            </div>

            <div class="cell created">
              <span class="created-time" :title="formatFullDate(invite.created_at)">
                {{ formatRelativeTime(invite.created_at) }}
              </span>
            </div>

            <div class="cell actions">
              <div class="action-buttons">
                <button 
                  @click="copyInviteUrl(invite.code)" 
                  class="action-btn copy"
                  title="Copy invite URL"
                  :disabled="isInviteExpired(invite) || invite.used"
                >
                  <svg viewBox="0 0 24 24" class="action-icon">
                    <path d="M18,16.08C17.24,16.08 16.56,16.38 16.04,16.85L8.91,12.7C8.96,12.47 9,12.24 9,12C9,11.76 8.96,11.53 8.91,11.3L15.96,7.19C16.5,7.69 17.21,8 18,8A3,3 0 0,0 21,5A3,3 0 0,0 18,2A3,3 0 0,0 15,5C15,5.24 15.04,5.47 15.09,5.7L8.04,9.81C7.5,9.31 6.79,9 6,9A3,3 0 0,0 3,12A3,3 0 0,0 6,15C6.79,15 7.5,14.69 8.04,14.19L15.16,18.34C15.11,18.55 15.08,18.77 15.08,19C15.08,20.61 16.39,21.91 18,21.91C19.61,21.91 20.92,20.6 20.92,19A2.84,2.84 0 0,0 18,16.08Z" fill="currentColor"/>
                  </svg>
                </button>
                <button 
                  @click="revokeInviteConfirm(invite)" 
                  class="action-btn revoke"
                  title="Revoke invite"
                  :disabled="invite.used || isInviteExpired(invite)"
                >
                  <svg viewBox="0 0 24 24" class="action-icon">
                    <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="pagination">
        <button 
          @click="currentPage = Math.max(1, currentPage - 1)"
          :disabled="currentPage === 1"
          class="pagination-btn"
        >
          <svg viewBox="0 0 24 24" class="pagination-icon">
            <path d="M20,11V13H8L13.5,18.5L12.08,19.92L4.16,12L12.08,4.08L13.5,5.5L8,11H20Z" fill="currentColor"/>
          </svg>
          Previous
        </button>
        
        <div class="pagination-info">
          Page {{ currentPage }} of {{ totalPages }} ({{ filteredInvites.length }} invites)
        </div>
        
        <button 
          @click="currentPage = Math.min(totalPages, currentPage + 1)"
          :disabled="currentPage === totalPages"
          class="pagination-btn"
        >
          Next
          <svg viewBox="0 0 24 24" class="pagination-icon">
            <path d="M4,11V13H16L10.5,18.5L11.92,19.92L19.84,12L11.92,4.08L10.5,5.5L16,11H4Z" fill="currentColor"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- Confirmation Modal -->
    <BaseModal 
      :show="showRevokeConfirm" 
      @close="showRevokeConfirm = false"
      title="Revoke Invite"
      subtitle="Are you sure you want to revoke this invite?"
    >
      <div v-if="selectedInvite" class="revoke-confirm-content">
        <p>
          This will permanently disable the invite link. Anyone trying to use it will receive an error.
        </p>
        <div class="invite-details">
          <div class="detail-row">
            <span class="detail-label">Invite Code:</span>
            <code class="detail-value">{{ selectedInvite.code }}</code>
          </div>
          <div class="detail-row">
            <span class="detail-label">Created by:</span>
            <span class="detail-value">{{ getCreatorName(selectedInvite.created_by) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Uses:</span>
            <span class="detail-value">{{ selectedInvite.uses || 0 }}/{{ selectedInvite.max_uses || '∞' }}</span>
          </div>
        </div>
      </div>

      <template #footer>
        <div class="modal-footer-content">
          <button @click="showRevokeConfirm = false" class="footer-button secondary">
            Cancel
          </button>
          <button @click="confirmRevokeInvite" class="footer-button danger" :disabled="isRevoking">
            <svg v-if="isRevoking" viewBox="0 0 24 24" class="footer-btn-icon spinning">
              <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z" fill="currentColor"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" class="footer-btn-icon">
              <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
            </svg>
            {{ isRevoking ? 'Revoking...' : 'Revoke Invite' }}
          </button>
        </div>
      </template>
    </BaseModal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import { formatDistanceToNow, format } from 'date-fns'
import { getInviteHistory, revokeInvite, type Invite } from '@/services/inviteService'
import { useAuthStore } from '@/stores/auth'
import BaseModal from '@/components/common/BaseModal.vue'

interface Props {
  serverId: string
}

const props = defineProps<Props>()
// eslint-disable-next-line unused-imports/no-unused-vars
const emit = defineEmits<{
  'create-invite': []
}>()

const toast = useToast()
const authStore = useAuthStore()

// Reactive state
const allInvites = ref<Invite[]>([])
const isLoading = ref(true)
const statusFilter = ref('all')
const creatorFilter = ref('all')
const searchQuery = ref('')
const currentPage = ref(1)
const itemsPerPage = 10
const showRevokeConfirm = ref(false)
const selectedInvite = ref<Invite | null>(null)
const isRevoking = ref(false)

// Mock user data (in real app, this would come from your user store)
const users = ref<Record<string, { display_name: string; avatar_url: string }>>({})

// Computed
const filteredInvites = computed(() => {
  let filtered = [...allInvites.value]
  
  // Status filter
  if (statusFilter.value !== 'all') {
    filtered = filtered.filter(invite => {
      switch (statusFilter.value) {
        case 'active':
          return !isInviteExpired(invite) && !invite.used && !isInviteUsedUp(invite)
        case 'expired':
          return isInviteExpired(invite)
        case 'used-up':
          return isInviteUsedUp(invite)
        case 'revoked':
          return invite.used && !isInviteUsedUp(invite)
        default:
          return true
      }
    })
  }
  
  // Creator filter
  if (creatorFilter.value !== 'all') {
    filtered = filtered.filter(invite => invite.created_by === creatorFilter.value)
  }
  
  // Search filter
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    filtered = filtered.filter(invite => 
      invite.code.toLowerCase().includes(query)
    )
  }
  
  return filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
})

const paginatedInvites = computed(() => {
  const start = (currentPage.value - 1) * itemsPerPage
  const end = start + itemsPerPage
  return filteredInvites.value.slice(start, end)
})

const totalPages = computed(() => {
  return Math.ceil(filteredInvites.value.length / itemsPerPage)
})

const uniqueCreators = computed(() => {
  const creators = new Map()
  allInvites.value.forEach(invite => {
    if (!creators.has(invite.created_by)) {
      creators.set(invite.created_by, {
        id: invite.created_by,
        display_name: getCreatorName(invite.created_by)
      })
    }
  })
  return Array.from(creators.values())
})

const stats = computed(() => {
  const total = allInvites.value.length
  const active = allInvites.value.filter(invite => 
    !isInviteExpired(invite) && !invite.used && !isInviteUsedUp(invite)
  ).length
  const expired = allInvites.value.filter(invite => isInviteExpired(invite)).length
  const totalUses = allInvites.value.reduce((sum, invite) => sum + (invite.uses || 0), 0)
  
  return { total, active, expired, totalUses }
})

// Methods
const loadInvites = async () => {
  if (!authStore.session?.user?.id) return
  
  try {
    isLoading.value = true
    // Load all invites for this server (admin view)
    const invites = await getInviteHistory(authStore.session.user.id, props.serverId)
    allInvites.value = invites
    
    // Load user information for creators
    await loadUserData(invites)
  } catch (error) {
    debug.error('Error loading invites:', error)
    toast.error('Failed to load invites')
  } finally {
    isLoading.value = false
  }
}

const loadUserData = async (invites: Invite[]) => {
  // In a real app, you'd fetch user data from your API
  const userIds = [...new Set(invites.map(invite => invite.created_by))]
  const userData: Record<string, { display_name: string; avatar_url: string }> = {}
  
  // Mock user data
  userIds.forEach(userId => {
    userData[userId] = {
      display_name: `User ${userId.slice(0, 8)}`,
      avatar_url: '/default_avatar.webp'
    }
  })
  
  users.value = userData
}

const refreshInvites = () => {
  loadInvites()
  toast.success('Invites refreshed')
}

const applyFilters = () => {
  currentPage.value = 1 // Reset to first page when filtering
}

const isInviteExpired = (invite: Invite): boolean => {
  if (!invite.expires_at) return false
  return new Date(invite.expires_at) <= new Date()
}

const isInviteUsedUp = (invite: Invite): boolean => {
  if (!invite.max_uses) return false
  return (invite.uses || 0) >= invite.max_uses
}

const getInviteStatus = (invite: Invite): string => {
  if (invite.used && !isInviteUsedUp(invite)) return 'Revoked'
  if (isInviteExpired(invite)) return 'Expired'
  if (isInviteUsedUp(invite)) return 'Used Up'
  return 'Active'
}

const getInviteStatusClass = (invite: Invite): string => {
  const status = getInviteStatus(invite)
  return status.toLowerCase().replace(' ', '-')
}

const getUsagePercentage = (invite: Invite): number => {
  if (!invite.max_uses) return 0
  return Math.min(100, ((invite.uses || 0) / invite.max_uses) * 100)
}

const getCreatorName = (userId: string): string => {
  return users.value[userId]?.display_name || 'Unknown User'
}

const getCreatorAvatar = (userId: string): string => {
  return users.value[userId]?.avatar_url || '/default_avatar.webp'
}

const formatTimeRemaining = (expiresAt: string): string => {
  const now = new Date()
  const expires = new Date(expiresAt)
  const diff = expires.getTime() - now.getTime()
  
  if (diff <= 0) return 'Expired'
  
  return formatDistanceToNow(expires, { addSuffix: true })
}

const formatRelativeTime = (dateString: string): string => {
  return formatDistanceToNow(new Date(dateString), { addSuffix: true })
}

const formatFullDate = (dateString: string): string => {
  return format(new Date(dateString), 'PPpp')
}

const copyInviteCode = async (code: string) => {
  try {
    await navigator.clipboard.writeText(code)
    toast.success('Invite code copied!')
  } catch (error) {
    toast.error('Failed to copy invite code')
  }
}

const copyInviteUrl = async (code: string) => {
  try {
    const baseUrl = import.meta.env.VITE_APP_URL || window.location.origin
    const url = `${baseUrl}/invite/${code}`
    await navigator.clipboard.writeText(url)
    toast.success('Invite URL copied!')
  } catch (error) {
    toast.error('Failed to copy invite URL')
  }
}

const revokeInviteConfirm = (invite: Invite) => {
  selectedInvite.value = invite
  showRevokeConfirm.value = true
}

const confirmRevokeInvite = async () => {
  if (!selectedInvite.value || !authStore.session?.user?.id) return
  
  try {
    isRevoking.value = true
    const success = await revokeInvite(selectedInvite.value.id, authStore.session.user.id)
    
    if (success) {
      await loadInvites()
      toast.success('Invite revoked successfully')
      showRevokeConfirm.value = false
      selectedInvite.value = null
    } else {
      toast.error('Failed to revoke invite')
    }
  } catch (error) {
    debug.error('Error revoking invite:', error)
    toast.error('Failed to revoke invite')
  } finally {
    isRevoking.value = false
  }
}

const getEmptyStateMessage = (): string => {
  if (statusFilter.value !== 'all' || creatorFilter.value !== 'all' || searchQuery.value) {
    return 'Try adjusting your filters to see more results.'
  }
  return 'No invites have been created for this server yet.'
}

// Lifecycle
onMounted(() => {
  loadInvites()
})
</script>

<style scoped>
/* Similar styling to InviteSettings but focused on table/management layout */
.invite-management {
  display: flex;
  flex-direction: column;
  gap: 24px;
  max-width: 1200px;
}

.management-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.management-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.management-description {
  font-size: 16px;
  color: #b5bac1;
  margin: 0;
}

.header-actions {
  display: flex;
  gap: 12px;
  flex-shrink: 0;
}

.refresh-button,
.create-button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.refresh-button {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #b5bac1;
}

.refresh-button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

.create-button {
  background: linear-gradient(135deg, #0EA5E9, #0284C7);
  color: var(--text-primary);
}

.create-button:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(14, 165, 233, 0.3);
}

.refresh-icon,
.plus-icon {
  width: 16px;
  height: 16px;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.filters-section {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  padding: 20px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 12px;
}

.filter-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.filter-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.filter-select {
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
}

.search-input-container {
  position: relative;
}

.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 10px 12px 10px 36px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.stats-section {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 16px;
}

.stat-card {
  padding: 20px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 12px;
  text-align: center;
}

.stat-value {
  font-size: 32px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.stat-label {
  font-size: 14px;
  color: #b5bac1;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  font-weight: 600;
}

.invites-table-container {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.04);
  border-radius: 12px;
  overflow: hidden;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top-color: #0EA5E9;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

.empty-icon {
  width: 48px;
  height: 48px;
  color: var(--text-muted);
  margin-bottom: 16px;
}

.invites-table {
  display: flex;
  flex-direction: column;
}

.table-header {
  display: grid;
  grid-template-columns: 2fr 1.5fr 1fr 1fr 1fr 1fr 1fr;
  gap: 16px;
  padding: 16px 20px;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 12px;
  font-weight: 700;
  color: #b5bac1;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.table-body {
  display: flex;
  flex-direction: column;
}

.table-row {
  display: grid;
  grid-template-columns: 2fr 1.5fr 1fr 1fr 1fr 1fr 1fr;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  transition: background 0.2s ease;
}

.table-row:hover {
  background: rgba(255, 255, 255, 0.02);
}

.table-row.expired {
  opacity: 0.6;
}

.table-row.used-up {
  opacity: 0.7;
  background: rgba(255, 165, 0, 0.05);
}

.table-row.revoked {
  opacity: 0.6;
  background: rgba(237, 66, 69, 0.05);
}

.cell {
  display: flex;
  align-items: center;
  font-size: 14px;
}

.invite-code-display {
  display: flex;
  align-items: center;
  gap: 8px;
}

.invite-code {
  font-family: 'Fira Code', monospace;
  font-size: 13px;
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.1);
  padding: 4px 8px;
  border-radius: 4px;
}

.copy-code-btn {
  width: 24px;
  height: 24px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s ease;
}

.copy-code-btn:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.1);
}

.copy-icon {
  width: 14px;
  height: 14px;
}

.temp-indicator {
  font-size: 10px;
  font-weight: 700;
  background: #f0b232;
  color: #000000;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}

.creator-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.creator-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
}

.creator-name {
  color: var(--text-primary);
  font-weight: 500;
}

.status-badge {
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
}

.status-badge.active {
  background: rgba(87, 242, 135, 0.2);
  color: #57f287;
}

.status-badge.expired {
  background: rgba(237, 66, 69, 0.2);
  color: #ed4245;
}

.status-badge.used-up {
  background: rgba(255, 165, 0, 0.2);
  color: #ffa500;
}

.status-badge.revoked {
  background: rgba(114, 118, 125, 0.2);
  color: var(--text-muted);
}

.usage-info {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-bottom: 4px;
}

.usage-count {
  color: var(--text-primary);
  font-weight: 600;
}

.usage-separator {
  color: var(--text-muted);
}

.usage-max {
  color: #b5bac1;
}

.usage-bar {
  width: 60px;
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  overflow: hidden;
}

.usage-fill {
  height: 100%;
  background: linear-gradient(90deg, #57f287, #f0b232);
  transition: width 0.3s ease;
}

.expires-time,
.created-time {
  color: #b5bac1;
  font-size: 13px;
}

.never-expires {
  color: var(--text-muted);
  font-style: italic;
  font-size: 13px;
}

.action-buttons {
  display: flex;
  gap: 4px;
}

.action-btn {
  width: 28px;
  height: 28px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: #b5bac1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.action-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

.action-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.action-btn.copy:hover:not(:disabled) {
  border-color: #0EA5E9;
  color: #0EA5E9;
}

.action-btn.revoke:hover:not(:disabled) {
  border-color: #ed4245;
  color: #ed4245;
}

.action-icon {
  width: 14px;
  height: 14px;
}

.pagination {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  background: rgba(255, 255, 255, 0.02);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.pagination-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: #b5bac1;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s ease;
}

.pagination-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

.pagination-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.pagination-icon {
  width: 16px;
  height: 16px;
}

.pagination-info {
  font-size: 14px;
  color: #b5bac1;
}

.revoke-confirm-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.invite-details {
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  padding: 16px;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.detail-row:last-child {
  border-bottom: none;
}

.detail-label {
  font-size: 14px;
  color: #b5bac1;
  font-weight: 500;
}

.detail-value {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 600;
}

.modal-footer-content {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.footer-button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  flex: 1;
}

.footer-button.secondary {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #b5bac1;
}

.footer-button.secondary:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
}

.footer-button.danger {
  background: linear-gradient(135deg, #ed4245, #c23616);
  color: var(--text-primary);
}

.footer-button.danger:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(237, 66, 69, 0.3);
}

.footer-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.footer-btn-icon {
  width: 16px;
  height: 16px;
}

/* Mobile responsive */
@media (max-width: 1024px) {
  .table-header,
  .table-row {
    grid-template-columns: 1.5fr 1fr 0.8fr 0.8fr 1fr 0.5fr;
  }
  
  .cell.created {
    display: none;
  }
  
  .header-cell.created {
    display: none;
  }
}

@media (max-width: 768px) {
  .management-header {
    flex-direction: column;
    align-items: flex-start;
  }
  
  .filters-section {
    grid-template-columns: 1fr;
  }
  
  .stats-section {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .table-header,
  .table-row {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  
  .cell {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  
  .cell::before {
    content: attr(data-label);
    font-size: 12px;
    font-weight: 600;
    color: #b5bac1;
    text-transform: uppercase;
  }
}
</style>