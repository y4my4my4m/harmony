<template>
  <div class="bans-settings">
    <div class="settings-header">
      <h2 class="settings-title">Server bans</h2>
      <p class="settings-description">
        View and manage banned users. Users with the Ban Members permission can unban users from this list.
      </p>
    </div>

    <div v-if="isLoading" class="loading-state">
      <LoadingSpinner :size="20" />
      <span>Loading bans...</span>
    </div>

    <EmptyState
      v-else-if="error"
      tone="error"
      icon="alert-circle"
      :title="error"
      :action-label="$t('common.retry')"
      @action="loadBans"
    />

    <EmptyState
      v-else-if="bans.length === 0"
      icon="gavel"
      :title="$t('empty.bans.title')"
      :description="$t('empty.bans.description')"
    />

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
          <span v-else>Revoke ban</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import EmptyState from '@/components/common/EmptyState.vue'
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
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px;
}

.settings-description {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  margin: 0;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
  color: var(--text-muted);
  text-align: center;
  gap: 8px;
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
  background: var(--bg-tertiary);
  border-radius: var(--radius-base);
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
  font-weight: var(--font-weight-semibold);
  font-size: 0.9rem;
  color: var(--text-primary);
}

.ban-username {
  font-size: 0.78rem;
  color: var(--text-muted);
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
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ban-meta {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.btn-unban {
  padding: 6px 14px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 0.8rem;
  cursor: pointer;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 4px;
}
.btn-unban:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  border-color: var(--text-muted);
}
.btn-unban:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-hover);
  border-top-color: var(--text-primary);
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
