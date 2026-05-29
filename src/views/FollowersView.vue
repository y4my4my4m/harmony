<template>
  <div class="followers-view" ref="scrollContainerRef">
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
          {{ $t('activitypub.followers') }}
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

      <!-- Users List (virtualized) -->
      <div v-else class="users-list">
        <div class="users-container" :style="{ height: `${usersTotalSize}px`, position: 'relative' }">
          <div
            v-for="virtualRow in usersVirtualRows"
            :key="users[virtualRow.index].id"
            :data-index="virtualRow.index"
            :ref="usersMeasureElement"
            class="virtual-user-row"
            :style="{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`
            }"
          >
            <div class="user-item">
              <UserCard
                :user="users[virtualRow.index]"
                :show-follow-btn="users[virtualRow.index].id !== currentUserId"
                :show-more-actions="true"
                @follow="handleFollow"
                @unfollow="handleUnfollow"
                @user-click="handleUserClick"
              />
            </div>
          </div>
        </div>

        <!-- Infinite scroll sentinel + fallback -->
        <div v-if="hasMore" ref="sentinelRef" class="load-more-section">
          <div v-if="isLoading" class="loading-more">
            <Icon name="loader" class="spinning" />
            <span>Loading...</span>
          </div>
          <button 
            v-else
            @click="loadMore"
            class="load-more-btn"
          >
            Load More
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useAuthStore } from '@/stores/auth';
import { useToast } from 'vue-toastification';
import { activityPubService } from '@/services/activityPubService';
import { supabase } from '@/supabase';
import type { FederatedUser } from '@/types';

useI18n();

// Components
import UserCard from '@/components/activitypub/UserCard.vue';
import Icon from '@/components/common/Icon.vue';

// Stores and composables
const activityPubStore = useActivityPubStore();
const authStore = useAuthStore();
const router = useRouter();
const toast = useToast();

// Props
interface Props {
  userId?: string;
  view?: 'followers' | 'following';
  userProfile?: any; // Optional: if provided, use its counts instead of querying
}

const props = withDefaults(defineProps<Props>(), {
  userId: undefined,
  view: 'followers',
  userProfile: undefined
});

// State
const currentView = ref<'followers' | 'following'>(props.view);
const users = ref<FederatedUser[]>([]);
const isLoading = ref(false);
const hasMore = ref(true);
const followersCount = ref(0);
const followingCount = ref(0);
const scrollContainerRef = ref<HTMLDivElement | null>(null);
const sentinelRef = ref<HTMLDivElement | null>(null);

// Virtual scrolling
const usersVirtualizer = useVirtualizer<HTMLDivElement, Element>(
  computed(() => ({
    count: users.value.length,
    getScrollElement: () => scrollContainerRef.value,
    estimateSize: () => 100,
    overscan: 5,
  })) as any
);

const usersVirtualRows = computed(() => usersVirtualizer.value.getVirtualItems());
const usersTotalSize = computed(() => usersVirtualizer.value.getTotalSize());

const usersMeasureElement = (el: any) => {
  if (!el || !(el instanceof HTMLElement)) return;
  usersVirtualizer.value.measureElement(el);
};

// Infinite scroll
let scrollObserver: IntersectionObserver | null = null;

const setupScrollObserver = () => {
  if (scrollObserver) scrollObserver.disconnect();
  if (!sentinelRef.value) return;
  scrollObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting && hasMore.value && !isLoading.value) {
        loadMore();
      }
    },
    { root: scrollContainerRef.value as unknown as Element | null, rootMargin: '200px' }
  );
  scrollObserver.observe(sentinelRef.value as unknown as Element);
};

watch([hasMore, sentinelRef], () => setupScrollObserver());

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
  const { t } = useI18n();
  return currentView.value === 'followers' ? t('activitypub.noFollowingYet') : t('activitypub.notFollowingAnyoneYet');
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
    const PAGE_SIZE = 20;
    const options = {
      limit: PAGE_SIZE,
      offset: refresh ? 0 : users.value.length,
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
    
    hasMore.value = result.length === PAGE_SIZE;
  } catch (error) {
    debug.error(`Failed to load ${currentView.value}:`, error);
    toast.error(`Failed to load ${currentView.value}`);
  } finally {
    isLoading.value = false;
  }
};

const loadCounts = async () => {
  if (!targetUserId.value) return;
  
  try {
    // If user profile data was passed as prop, use it (avoid extra query)
    if (props.userProfile && props.userProfile.followers_count !== undefined) {
      followersCount.value = props.userProfile.followers_count || 0;
      followingCount.value = props.userProfile.following_count || 0;
      return;
    }
    
    // Otherwise, lightweight query for just counts (fast indexed lookup)
    const { data: userProfile, error } = await supabase
      .from('profiles')
      .select('followers_count, following_count')
      .eq('id', targetUserId.value)
      .single();
    
    if (error) {
      debug.error('Failed to load counts:', error);
      return;
    }
    
    followersCount.value = userProfile.followers_count || 0;
    followingCount.value = userProfile.following_count || 0;
  } catch (error) {
    debug.error('Failed to load counts:', error);
  }
};

const loadMore = () => {
  if (hasMore.value && !isLoading.value) {
    loadUsers(false);
  }
};

// Event handlers
const handleFollow = (_userId: string) => {
  // User was followed - just update count
  // The UserCard already handled the actual follow via toggleFollow
  followingCount.value++;
};

const handleUnfollow = (userId: string) => {
  // User was unfollowed - just update count and UI
  // The UserCard already handled the actual unfollow via toggleFollow
  followingCount.value--;
  
  // Remove from following list if currently viewing following
  if (currentView.value === 'following') {
    users.value = users.value.filter(u => u.id !== userId);
  }
};

const handleUserClick = (user: FederatedUser) => {
  let handle = user.handle
  if (!handle) {
    handle = user.is_local === false && user.domain
      ? `${user.username}@${user.domain}`
      : user.username
  }
  handle = handle.replace(/^@/, '')
  router.push({ name: 'UserProfile', params: { handle } });
};

// Watchers
watch(currentView, () => {
  users.value = [];
  hasMore.value = true;
  loadUsers(true);
});

watch(() => props.userId, () => {
  users.value = [];
  hasMore.value = true;
  loadCounts();
  loadUsers(true);
});

watch(() => props.view, (newView) => {
  currentView.value = newView;
});

// Lifecycle
onMounted(async () => {
  // Ensure activityPubStore is initialized with followed users
  if (activityPubStore.followedUsers.size === 0 && authStore.session?.user) {
    await activityPubStore.loadFollowedUsers();
  }
  
  loadCounts();
  loadUsers(true);
  setupScrollObserver();
});

onUnmounted(() => {
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
});
</script>

<style scoped>
.followers-view {
  max-width: 600px;
  margin: 0 auto;
  padding: 20px;
  height: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
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
  background: var(--harmony-primary);
  color: var(--text-primary);
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
  color: var(--text-primary);
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
  border-top: 2px solid var(--harmony-primary);
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
  background: var(--harmony-primary);
  color: var(--text-primary);
  text-decoration: none;
  border-radius: 8px;
  font-weight: 600;
  transition: all 0.2s ease;
}

.discover-btn:hover {
  background: var(--harmony-primary-hover);
  transform: translateY(-1px);
}

.users-container {
  width: 100%;
}

.virtual-user-row {
  padding: 8px 0;
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

.loading-more {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 0.875rem;
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