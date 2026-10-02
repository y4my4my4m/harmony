<template>
  <div class="followers-list">
    <!-- Header -->
    <div class="followers-header">
      <h3 class="section-title">{{ $t('activitypub.following') }}</h3>
      <p class="section-subtitle">{{ $t('dm.startConversation') }}</p>
    </div>

    <!-- Loading State -->
    <div v-if="isLoading" class="loading-state">
      <div class="loading-grid">
        <div v-for="i in 6" :key="i" class="user-card skeleton">
          <div class="skeleton-avatar"></div>
          <div class="skeleton-content">
            <div class="skeleton-line skeleton-name"></div>
            <div class="skeleton-line skeleton-handle"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <EmptyState
      v-else-if="followingUsers.length === 0"
      icon="user-plus"
      :title="$t('activitypub.noFollowingYet')"
      :description="$t('dm.followingEmptyHint')"
    >
      <template #actions>
        <router-link to="/social/trending" class="list-empty__button">
          {{ $t('activitypub.discoverPeople') }}
        </router-link>
      </template>
    </EmptyState>

    <!-- Users List -->
    <div v-else class="users-list">
      <div 
        v-for="user in followingUsers" 
        :key="user.id"
        class="user-card"
        @click="startConversation(user)"
      >
        <div class="user-avatar-container">
          <Avatar 
            :src="user.avatar_url" 
            :status="getUserOnlineStatus(user.id) ? 'online' : 'offline'"
            :alt="user.display_name || user.username"
            size="sm"
          />
        </div>

        <div class="user-info">
          <span class="user-name">
            <DisplayName :user-id="user.id" :fallback="user.display_name || user.username" :truncate="true" />
          </span>
          <span class="user-handle">{{ formatUserHandle(user) }}</span>
        </div>

        <button class="message-btn" @click.stop="startConversation(user)" :title="$t('dm.sendMessage') || 'Message'">
          <svg viewBox="0 0 24 24" class="message-icon">
            <path d="M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2Z" fill="currentColor"/>
          </svg>
        </button>
      </div>

      <!-- Load More -->
      <div v-if="hasMore" class="load-more-section">
        <button 
          class="load-more-btn"
          @click="loadMore"
          :disabled="isLoadingMore"
        >
          <span v-if="isLoadingMore" class="loading-spinner-sm"></span>
          <span>{{ isLoadingMore ? 'Loading...' : 'Load more' }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { useDMStore } from '@/stores/useDM'
import { useAuthStore } from '@/stores/auth'
import { useUserData } from '@/composables/useUserData'
import { services } from '@/services'
import type { Profile } from '@/types'
import Avatar from '../common/Avatar.vue'
import DisplayName from '../DisplayName.vue'
import EmptyState from '../common/EmptyState.vue'

// Emits
const emit = defineEmits<{
  conversationStarted: [conversationId: string]
}>()


// Stores & Composables
const dmStore = useDMStore()
const authStore = useAuthStore()
const { getCurrentUser, isUserOnline, updateFriendsPresence } = useUserData()
const router = useRouter()
const toast = useToast()

// State
const followingUsers = ref<Profile[]>([])
const isLoading = ref(false)
const isLoadingMore = ref(false)
const hasMore = ref(true)
const currentOffset = ref(0)
const limit = 20

// Methods
const loadFollowingUsers = async (offset = 0, showLoading = true) => {
  const currentUser = getCurrentUser.value
  const userId = currentUser?.id
  if (!userId) return

  try {
    if (showLoading) isLoading.value = true
    if (offset > 0) isLoadingMore.value = true

    const response = await services.interactions.getFollowing(userId, {
      limit,
      offset
    })

    if (offset === 0) {
      followingUsers.value = response.following
    } else {
      followingUsers.value = [...followingUsers.value, ...response.following]
    }

    hasMore.value = response.hasMore
    currentOffset.value = offset + limit

    // Presence of followed profiles is read for this list only (get_presence).
    void updateFriendsPresence(followingUsers.value.map(u => u.id)).catch(err => {
      debug.warn('Failed to load presence for following users:', err)
    })

  } catch (error) {
    debug.error('Failed to load following users:', error)
    toast.error('Failed to load following users')
  } finally {
    isLoading.value = false
    isLoadingMore.value = false
  }
}

const loadMore = () => {
  if (!isLoadingMore.value && hasMore.value) {
    loadFollowingUsers(currentOffset.value, false)
  }
}

const startConversation = async (user: Profile) => {
  const currentUserId = authStore.session?.user?.id
  if (!currentUserId) return

  try {
    const existingConversation = dmStore.conversations.find(conv => 
      conv.other_user?.id === user.id
    )

    if (existingConversation) {
      // Navigate to existing conversation
      router.push(`/dm/${existingConversation.id}`)
      emit('conversationStarted', existingConversation.id)
      return
    }

    const conversationId = await dmStore.createOrGetConversation(currentUserId, user.id)
    if (conversationId) {
      router.push(`/dm/${conversationId}`)
      emit('conversationStarted', conversationId)
    }
  } catch (error) {
    debug.error('Failed to start conversation:', error)
    toast.error('Failed to start conversation')
  }
}

const formatUserHandle = (user: Profile): string => {
  if (user.domain && !user.is_local) {
    return `@${user.username}@${user.domain}`
  }
  return `@${user.username}`
}

const getUserOnlineStatus = (userId: string): boolean => {
  return isUserOnline(userId).value
}

onMounted(() => {
  loadFollowingUsers()
})

onUnmounted(() => {
  void updateFriendsPresence([]).catch(() => {})
})
</script>

<style scoped>
.followers-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--background-primary);
  overflow-y: auto;
}

.followers-header {
  padding: 16px 20px 12px;
  background: var(--background-primary);
  position: sticky;
  top: 0;
  z-index: 10;
}

.section-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 2px;
}

.section-subtitle {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}

/* Loading State */
.loading-state {
  padding: 8px 20px;
}

.loading-grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.skeleton {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
}

.skeleton-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--background-tertiary);
  flex-shrink: 0;
  animation: pulse 1.5s ease-in-out infinite;
}

.skeleton-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.skeleton-line {
  height: 10px;
  border-radius: 5px;
  background: var(--background-tertiary);
  animation: pulse 1.5s ease-in-out infinite;
}

.skeleton-name { width: 45%; }
.skeleton-handle { width: 65%; }

/* Users List */
.users-list {
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.user-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.user-card:hover {
  background: var(--background-modifier-hover, var(--background-secondary));
}

.user-card:active {
  background: var(--background-modifier-active, var(--background-tertiary));
}

.user-avatar-container {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
}

.user-avatar-container :deep(.avatar-container) {
  width: 40px;
  height: 40px;
}

.user-avatar-container :deep(.avatar-image) {
  width: 100%;
  height: 100%;
  max-width: 40px;
  max-height: 40px;
}

.user-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.user-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user-handle {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.message-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s ease;
}

.user-card:hover .message-btn {
  opacity: 1;
}

.message-btn:hover {
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.message-icon {
  width: 16px;
  height: 16px;
}

/* Load More */
.load-more-section {
  padding: 12px 12px 16px;
  display: flex;
  justify-content: center;
}

.load-more-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 20px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s ease;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--background-secondary);
  color: var(--text-primary);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading-spinner-sm {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-color);
  border-top-color: var(--text-primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .followers-header {
    padding: 12px 16px 8px;
  }
  .users-list {
    padding: 4px;
  }
  .user-card {
    padding: 8px;
  }
}
</style>
