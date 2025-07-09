<template>
  <div class="followers-view">
    <!-- Header -->
    <div class="view-header">
      <div class="header-content">
        <h1 class="page-title">
          <Icon name="users" />
          {{ viewTitle }}
        </h1>
        <p class="page-subtitle">{{ viewSubtitle }}</p>
      </div>
      
      <!-- View Toggle -->
      <div class="view-toggle">
        <button 
          @click="currentView = 'followers'"
          :class="['toggle-btn', { active: currentView === 'followers' }]"
        >
          <Icon name="users" />
          Followers
          <span class="count">{{ followersCount }}</span>
        </button>
        <button 
          @click="currentView = 'following'"
          :class="['toggle-btn', { active: currentView === 'following' }]"
        >
          <Icon name="user-check" />
          Following
          <span class="count">{{ followingCount }}</span>
        </button>
      </div>
    </div>

    <!-- Content -->
    <div class="followers-content">
      <!-- Loading State -->
      <div v-if="isLoading && users.length === 0" class="loading-state">
        <div class="loading-spinner"></div>
        <p>Loading {{ currentView }}...</p>
      </div>

      <!-- Empty State -->
      <div v-else-if="users.length === 0" class="empty-state">
        <div class="empty-icon">
          <Icon :name="currentView === 'followers' ? 'users' : 'user-check'" :size="64" />
        </div>
        <h3>{{ emptyStateTitle }}</h3>
        <p>{{ emptyStateMessage }}</p>
        <router-link 
          v-if="currentView === 'following'"
          to="/social/public" 
          class="discover-btn"
        >
          <Icon name="globe" />
          Discover Users
        </router-link>
      </div>

      <!-- Users List -->
      <div v-else class="users-list">
        <div class="users-container">
          <div 
            v-for="user in users" 
            :key="user.id"
            class="user-item"
          >
            <UserCard
              :user="user"
              :show-follow-btn="user.id !== currentUserId"
              :show-more-actions="true"
              @follow="handleFollow"
              @unfollow="handleUnfollow"
              @user-click="handleUserClick"
            />
          </div>
        </div>

        <!-- Load More -->
        <div v-if="hasMore" class="load-more-section">
          <button 
            @click="loadMore"
            :disabled="isLoading"
            class="load-more-btn"
          >
            <Icon v-if="isLoading" name="loader" class="spinning" />
            <span>{{ isLoading ? 'Loading...' : 'Load More' }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useAuthStore } from '@/stores/auth';
import { useToast } from 'vue-toastification';
import { activityPubService } from '@/services/activityPubService';
import type { FederatedUser } from '@/types';

// Components
import UserCard from '@/components/activitypub/UserCard.vue';
import Icon from '@/components/common/Icon.vue';

// Stores and composables
const activityPubStore = useActivityPubStore();
const authStore = useAuthStore();
const router = useRouter();
const route = useRoute();
const toast = useToast();

// Props
interface Props {
  userId?: string;
  view?: 'followers' | 'following';
}

const props = withDefaults(defineProps<Props>(), {
  userId: undefined,
  view: 'followers'
});

// State
const currentView = ref<'followers' | 'following'>(props.view);
const users = ref<FederatedUser[]>([]);
const isLoading = ref(false);
const hasMore = ref(true);
const followersCount = ref(0);
const followingCount = ref(0);
const cursor = ref<string | null>(null);

// Computed
const currentUserId = computed(() => authStore.session?.user?.id);

const targetUserId = computed(() => {
  return props.userId || currentUserId.value;
});

const viewTitle = computed(() => {
  return currentView.value === 'followers' ? 'Followers' : 'Following';
});

const viewSubtitle = computed(() => {
  const count = currentView.value === 'followers' ? followersCount.value : followingCount.value;
  return currentView.value === 'followers' 
    ? `${count} ${count === 1 ? 'person follows' : 'people follow'} you`
    : `${count} ${count === 1 ? 'person' : 'people'} you follow`;
});

const emptyStateTitle = computed(() => {
  return currentView.value === 'followers' ? 'No followers yet' : 'Not following anyone yet';
});

const emptyStateMessage = computed(() => {
  return currentView.value === 'followers' 
    ? 'When people follow you, they\'ll appear here.'
    : 'When you follow people, they\'ll appear here.';
});

// Methods
const loadUsers = async (refresh = false) => {
  if (isLoading.value || !targetUserId.value) return;
  
  isLoading.value = true;
  try {
    const options = {
      limit: 20,
      cursor: refresh ? null : cursor.value
    };

    let result;
    if (currentView.value === 'followers') {
      result = await activityPubService.getFollowers(targetUserId.value, options);
    } else {
      result = await activityPubService.getFollowing(targetUserId.value, options);
    }
    
    if (refresh) {
      users.value = result;
    } else {
      users.value.push(...result);
    }
    
    hasMore.value = result.length === 20;
    cursor.value = result.length > 0 ? result[result.length - 1].id : null;
  } catch (error) {
    console.error(`Failed to load ${currentView.value}:`, error);
    toast.error(`Failed to load ${currentView.value}`);
  } finally {
    isLoading.value = false;
  }
};

const loadCounts = async () => {
  if (!targetUserId.value) return;
  
  try {
    // Load followers count
    const followers = await activityPubService.getFollowers(targetUserId.value, { limit: 1 });
    followersCount.value = followers.length;
    
    // Load following count
    const following = await activityPubService.getFollowing(targetUserId.value, { limit: 1 });
    followingCount.value = following.length;
  } catch (error) {
    console.error('Failed to load counts:', error);
  }
};

const loadMore = () => {
  if (hasMore.value && !isLoading.value) {
    loadUsers(false);
  }
};

// Event handlers
const handleFollow = async (userId: string) => {
  try {
    await activityPubStore.followUser(userId);
    followingCount.value++;
  } catch (error) {
    console.error('Failed to follow user:', error);
    toast.error('Failed to follow user');
  }
};

const handleUnfollow = async (userId: string) => {
  try {
    await activityPubStore.unfollowUser(userId);
    followingCount.value--;
    
    // Remove from following list if currently viewing following
    if (currentView.value === 'following') {
      users.value = users.value.filter(u => u.id !== userId);
    }
  } catch (error) {
    console.error('Failed to unfollow user:', error);
    toast.error('Failed to unfollow user');
  }
};

const handleUserClick = (user: FederatedUser) => {
  router.push(`/u/${user.handle.replace('@', '')}`);
};

// Watchers
watch(currentView, () => {
  users.value = [];
  cursor.value = null;
  hasMore.value = true;
  loadUsers(true);
});

watch(() => props.userId, () => {
  users.value = [];
  cursor.value = null;
  hasMore.value = true;
  loadCounts();
  loadUsers(true);
});

watch(() => props.view, (newView) => {
  currentView.value = newView;
});

// Lifecycle
onMounted(() => {
  loadCounts();
  loadUsers(true);
});
</script>

<style scoped>
.followers-view {
  max-width: 600px;
  margin: 0 auto;
  padding: 20px;
}

.view-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.header-content {
  flex: 1;
}

.page-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

.page-subtitle {
  color: var(--text-secondary);
  margin: 0;
  font-size: 16px;
}

.view-toggle {
  display: flex;
  gap: 8px;
  background: var(--background-secondary);
  border-radius: 8px;
  padding: 4px;
}

.toggle-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  font-weight: 500;
}

.toggle-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.toggle-btn.active {
  background: var(--brand-primary);
  color: white;
}

.count {
  background: var(--background-tertiary);
  color: var(--text-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
}

.toggle-btn.active .count {
  background: rgba(255, 255, 255, 0.2);
  color: white;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  text-align: center;
  color: var(--text-secondary);
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 2px solid var(--border-color);
  border-top: 2px solid var(--brand-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

.empty-icon {
  color: var(--text-tertiary);
  margin-bottom: 16px;
}

.empty-state h3 {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

.empty-state p {
  font-size: 16px;
  margin: 0 0 24px 0;
  max-width: 400px;
  line-height: 1.5;
}

.discover-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: var(--brand-primary);
  color: white;
  text-decoration: none;
  border-radius: 8px;
  font-weight: 600;
  transition: all 0.2s ease;
}

.discover-btn:hover {
  background: var(--brand-primary-hover);
  transform: translateY(-1px);
}

.users-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.user-item {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px;
  transition: all 0.2s ease;
}

.user-item:hover {
  background: var(--background-hover);
  border-color: var(--border-hover);
}

.load-more-section {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.load-more-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.load-more-btn:hover:not(:disabled) {
  background: var(--background-hover);
  border-color: var(--border-hover);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .followers-view {
    padding: 16px;
  }
  
  .view-header {
    flex-direction: column;
    gap: 16px;
    align-items: flex-start;
  }
  
  .view-toggle {
    width: 100%;
    justify-content: center;
  }
  
  .toggle-btn {
    flex: 1;
    justify-content: center;
  }
}
</style> 