<template>
  <div class="bans-settings">
    <div class="settings-header">
      <h2 class="settings-title">Server Bans</h2>
      <p class="settings-description">
        View and manage banned users. Users with the Ban Members permission can unban users from this list.
      </p>
    </div>

    <div v-if="isLoading" class="loading-state">
      <div class="loading-spinner"></div>
      <span>Loading bans...</span>
    </div>

    <div v-else-if="error" class="error-state">
      <p>{{ error }}</p>
      <button class="btn-retry" @click="loadBans">Retry</button>
    </div>

    <div v-else-if="bans.length === 0" class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" class="empty-icon">
        <path fill="currentColor" d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4M12,6A6,6 0 0,1 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6M12,8A4,4 0 0,0 8,12A4,4 0 0,0 12,16A4,4 0 0,0 16,12A4,4 0 0,0 12,8Z"/>
      </svg>
      <h3>No Banned Users</h3>
      <p>There are no banned users in this server.</p>
    </div>

    <div v-else class="bans-list">
      <div v-for="ban in bans" :key="ban.id" class="ban-item">
        <div class="ban-user">
          <img :src="ban.avatar_url || '/default_avatar.webp'" :alt="ban.username" class="ban-avatar" />
          <div class="ban-info">
            <span class="ban-display-name">{{ ban.display_name || ban.username }}</span>
            <span class="ban-username">@{{ ban.username }}</span>
          </div>
        </div>
        <div class="ban-details">
          <span v-if="ban.reason" class="ban-reason" :title="ban.reason">{{ ban.reason }}</span>
          <span class="ban-meta">
            Banned by {{ ban.banned_by_username || 'Unknown' }} on {{ formatDate(ban.created_at) }}
          </span>
        </div>
        <button class="btn-unban" @click="handleUnban(ban)" :disabled="unbanningId === ban.user_id">
          <span v-if="unbanningId === ban.user_id" class="loading-spinner small"></span>
          <span v-else>Revoke Ban</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useToast } from 'vue-toastification'
import { moderationService, type ServerBan } from '@/services/ModerationService'

const props = defineProps<{ serverId: string }>()

const toast = useToast()
const bans = ref<ServerBan[]>([])
const isLoading = ref(false)
const error = ref('')
const unbanningId = ref<string | null>(null)

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

async function loadBans() {
  isLoading.value = true
  error.value = ''
  try {
    bans.value = await moderationService.getServerBans(props.serverId)
  } catch (err: any) {
    error.value = err.message || 'Failed to load bans'
  } finally {
    isLoading.value = false
  }
}

async function handleUnban(ban: ServerBan) {
  unbanningId.value = ban.user_id
  try {
    const result = await moderationService.unbanMember(props.serverId, ban.user_id)
    if (result.success) {
      bans.value = bans.value.filter(b => b.user_id !== ban.user_id)
      toast.success(`${ban.display_name || ban.username} has been unbanned`)
    } else {
      toast.error(result.error || 'Failed to unban user')
    }
  } finally {
    unbanningId.value = null
  }
}

onMounted(loadBans)
</script>

<style scoped>
.bans-settings {
  padding: 0;
}

.settings-header {
  margin-bottom: 24px;
}

.settings-title {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary, #f2f3f5);
  margin: 0 0 4px;
}

.settings-description {
  color: var(--text-muted, #949ba4);
  font-size: 0.85rem;
  margin: 0;
}

.loading-state,
.empty-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
  color: var(--text-muted, #949ba4);
  text-align: center;
  gap: 8px;
}

.empty-icon {
  opacity: 0.4;
  margin-bottom: 8px;
}

.empty-state h3 {
  margin: 0;
  color: var(--text-primary, #f2f3f5);
  font-size: 1.1rem;
}

.empty-state p,
.error-state p {
  margin: 0;
  font-size: 0.9rem;
}

.btn-retry {
  margin-top: 8px;
  padding: 6px 16px;
  background: var(--accent-color, #0EA5E9);
  color: var(--text-primary);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.85rem;
}

.bans-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ban-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-tertiary, #1e1f22);
  border-radius: 6px;
}

.ban-user {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 180px;
}

.ban-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.ban-info {
  display: flex;
  flex-direction: column;
}

.ban-display-name {
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--text-primary, #f2f3f5);
}

.ban-username {
  font-size: 0.78rem;
  color: var(--text-muted, #949ba4);
}

.ban-details {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ban-reason {
  font-size: 0.85rem;
  color: var(--text-secondary, #b5bac1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ban-meta {
  font-size: 0.75rem;
  color: var(--text-muted, #949ba4);
}

.btn-unban {
  padding: 6px 14px;
  background: transparent;
  border: 1px solid var(--border-color, #3f4147);
  border-radius: 4px;
  color: var(--text-secondary, #b5bac1);
  font-size: 0.8rem;
  cursor: pointer;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 4px;
}
.btn-unban:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.05);
  border-color: var(--text-muted, #949ba4);
}
.btn-unban:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--text-primary, #f2f3f5);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.loading-spinner.small {
  width: 14px;
  height: 14px;
  border-width: 2px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .ban-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .ban-user {
    min-width: unset;
  }
  .btn-unban {
    align-self: flex-end;
  }
}
</style>
