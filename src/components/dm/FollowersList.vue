<!--
  FollowersList.vue - Professional followers list component for DM home view
  Displays users the current user follows in a clean, modern interface
  
  Features:
  - Professional grid layout with user cards
  - Online status indicators
  - Smooth hover effects
  - Click to start DM conversation
  - Loading states and empty states
  - Responsive design
-->
<template>
  <div class="followers-list">
    <!-- Header -->
    <div class="followers-header">
      <div class="header-content">
        <h3 class="section-title">{{ $t('activitypub.following') }}</h3>
        <p class="section-subtitle">{{ $t('dm.startConversation') }}</p>
      </div>
    </div>

    <!-- Loading State -->
    <div v-if="isLoading" class="loading-state">
      <div class="loading-grid">
        <div 
          v-for="i in 12" 
          :key="i" 
          class="user-card skeleton"
        >
          <div class="skeleton-avatar"></div>
          <div class="skeleton-content">
            <div class="skeleton-line skeleton-name"></div>
            <div class="skeleton-line skeleton-handle"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty State -->
    <div v-else-if="followingUsers.length === 0" class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" class="icon">
          <path d="M16,4C18.21,4 20,5.79 20,8C20,10.21 18.21,12 16,12C13.79,12 12,10.21 12,8C12,5.79 13.79,4 16,4M16,14C20.42,14 24,15.79 24,18V20H8V18C8,15.79 11.58,14 16,14M6,6V9H0V11H6V14H8V11H14V9H8V6H6Z" fill="currentColor"/>
        </svg>
      </div>
      <h4 class="empty-title">{{ $t('activitypub.noFollowingYet') }}</h4>
      <p class="empty-description">
        {{ $t('activitypub.followUsersToSee') }}
      </p>
      <router-link to="/social/trending" class="explore-btn">
        <svg viewBox="0 0 24 24" class="btn-icon">
          <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
        </svg>
        {{ $t('activitypub.discoverPeople') }}
      </router-link>
    </div>

    <!-- Users Grid -->
    <div v-else class="users-grid">
        <div 
          v-for="user in followingUsers" 
          :key="user.id"
          class="user-card"
          @click="startConversation(user)"
        >
        <!-- Avatar with Status -->
        <div class="user-avatar-container">
          <Avatar 
            :src="user.avatar_url" 
            :status="getUserOnlineStatus(user.id) ? 'online' : 'offline'"
            :alt="user.display_name || user.username"
          />
        </div>

        <!-- User Info -->
        <div class="user-info">
          <h4 class="user-name">
            {{ user.display_name || user.username }}
          </h4>
          <p class="user-handle" :style="{ color: user.color || '#888' }">
            {{ formatUserHandle(user) }}
          </p>
        </div>

        <!-- Hover Action -->
        <div class="user-actions">
          <div class="action-hint">
            <svg viewBox="0 0 24 24" class="action-icon">
              <path d="M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2M6,9V7H18V9H6M14,11V13H6V11H14M18,15H6V17H18V15Z" fill="currentColor"/>
            </svg>
            <span>Send Message</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Load More Button -->
    <div v-if="hasMore && !isLoading" class="load-more-section">
      <button 
        class="load-more-btn"
        @click="loadMore"
        :disabled="isLoadingMore"
      >
        <span v-if="!isLoadingMore">Load More</span>
        <span v-else class="loading-text">
          <svg viewBox="0 0 24 24" class="loading-icon">
            <path d="M12,4V2A10,10 0 0,0 2,12H4A8,8 0 0,1 12,4Z" fill="currentColor"/>
          </svg>
          Loading...
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { useDMStore } from '@/stores/useDM'
import { useAuthStore } from '@/stores/auth'
import { useUserData } from '@/composables/useUserData'
import { services } from '@/services'
import type { Profile } from '@/types'
import Avatar from '../common/Avatar.vue'

// Emits
const emit = defineEmits<{
  conversationStarted: [conversationId: string]
}>()


// Stores & Composables
const dmStore = useDMStore()
const authStore = useAuthStore()
const { getCurrentUser, isUserOnline } = useUserData()
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
  // Get current user profile ID cleanly
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
    // Check if conversation already exists
    const existingConversation = dmStore.conversations.find(conv => 
      conv.other_user?.id === user.id
    )

    if (existingConversation) {
      // Navigate to existing conversation
      router.push(`/dm/${existingConversation.id}`)
      emit('conversationStarted', existingConversation.id)
      return
    }

    // Create new conversation
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

// Initialize
onMounted(() => {
  loadFollowingUsers()
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
  padding: 24px 24px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-primary);
  position: sticky;
  top: 0;
  z-index: 10;
}

.header-content {
  max-width: 1200px;
  margin: 0 auto;
}

.section-title {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.section-subtitle {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

/* Loading State */
.loading-state {
  padding: 24px;
}

.loading-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  max-width: 1200px;
  margin: 0 auto;
}

.skeleton {
  padding: 20px;
  border-radius: 12px;
  background: var(--background-secondary);
}

.skeleton-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--background-tertiary);
  margin-bottom: 16px;
  animation: pulse 1.5s ease-in-out infinite;
}

.skeleton-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skeleton-line {
  height: 12px;
  border-radius: 6px;
  background: var(--background-tertiary);
  animation: pulse 1.5s ease-in-out infinite;
}

.skeleton-name {
  width: 60%;
}

.skeleton-handle {
  width: 80%;
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px 24px;
  text-align: center;
  color: var(--text-secondary);
}

.empty-icon {
  margin-bottom: 24px;
  opacity: 0.6;
}

.empty-icon .icon {
  width: 64px;
  height: 64px;
}

.empty-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px;
}

.empty-description {
  font-size: 14px;
  max-width: 400px;
  margin: 0 0 32px;
  line-height: 1.5;
}

.explore-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  background: var(--accent-primary);
  color: white;
  border-radius: 8px;
  text-decoration: none;
  font-weight: 500;
  transition: all 0.2s ease;
}

.explore-btn:hover {
  background: var(--accent-primary-hover);
  transform: translateY(-1px);
}

.btn-icon {
  width: 18px;
  height: 18px;
}

/* Users Grid */
.users-grid {
  display:flex;
  flex-direction: row;
  flex-wrap: wrap;
  /* display: grid; */
  /* grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); */
  gap: 16px;
  padding: 24px;
  width: 100%;
  /* max-width: 1200px; */
  margin: 0 auto;
}

.user-card {
  width: 100%;
  display: flex;
  flex-direction: row;
  gap: 16px;
  position: relative;
  padding: 20px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.3s ease;
  overflow: hidden;
}

.user-card:hover {
  transform: translateY(-2px);
  border-color: var(--accent-primary);
  box-shadow: 0 8px 25px rgba(0,0,0,0.1);
}

.user-card.online {
  border-color: var(--status-online);
}

.user-card.online:hover {
  border-color: var(--accent-primary);
}

.user-avatar-container {
  position: relative;
  display: inline-block;
  margin-bottom: 16px;
}

.user-info {
  flex: 1;
}

.user-name {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 6px;
  line-height: 1.3;
}

.user-handle {
  font-size: 13px;
  margin: 0 0 8px;
  font-family: 'JetBrains Mono', monospace;
}

/* Hover Actions */
.user-actions {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.8);
  opacity: 0;
  transition: opacity 0.3s ease;
}

.user-card:hover .user-actions {
  opacity: 1;
}

.action-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: white;
  text-align: center;
}

.action-icon {
  width: 24px;
  height: 24px;
}

.action-hint span {
  font-size: 14px;
  font-weight: 500;
}

/* Load More */
.load-more-section {
  padding: 24px;
  display: flex;
  justify-content: center;
}

.load-more-btn {
  padding: 12px 24px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  cursor: pointer;
  font-weight: 500;
  transition: all 0.2s ease;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--background-tertiary);
  border-color: var(--accent-primary);
}

.load-more-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.loading-text {
  display: flex;
  align-items: center;
  gap: 8px;
}

.loading-icon {
  width: 16px;
  height: 16px;
  animation: spin 1s linear infinite;
}

/* Animations */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Responsive Design */
@media (max-width: 768px) {
  .followers-header {
    padding: 16px;
  }
  
  .section-title {
    font-size: 20px;
  }
  
  .users-grid {
    grid-template-columns: 1fr;
    padding: 16px;
    gap: 12px;
  }
  
  .user-card {
    padding: 16px;
  }
}

@media (max-width: 640px) {
  .users-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  
  .user-card {
    padding: 12px;
  }
  
  .user-name {
    font-size: 14px;
  }
  
  .user-handle {
    font-size: 12px;
  }
}
</style>
