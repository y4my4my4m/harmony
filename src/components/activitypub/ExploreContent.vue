<template>
  <div class="explore-content">
    <!-- Explore Controls -->
    <div class="explore-controls">
      <div class="filter-group">
        <select v-model="selectedContentType" class="filter-select">
          <option value="all">{{ $t('activitypub.allContent') }}</option>
          <option value="posts">{{ $t('activitypub.postsOnly') }}</option>
          <option value="media">{{ $t('activitypub.withMedia') }}</option>
          <option value="users">{{ $t('activitypub.users') }}</option>
        </select>
        
        <select v-if="currentView === 'instances'" v-model="selectedInstance" class="filter-select">
          <option value="all">{{ $t('activitypub.allInstances') }}</option>
          <option v-for="instance in knownInstances" :key="instance.domain" :value="instance.domain">
            {{ instance.domain }}
          </option>
        </select>
        
        <select v-model="selectedTimeRange" class="filter-select">
          <option value="1h">{{ $t('activitypub.lastHour') }}</option>
          <option value="6h">{{ $t('activitypub.last6Hours') }}</option>
          <option value="24h">{{ $t('activitypub.last24Hours') }}</option>
          <option value="7d">{{ $t('activitypub.lastWeek') }}</option>
          <option value="30d">{{ $t('activitypub.lastMonth') }}</option>
        </select>
        
        <button @click="refreshContent" class="refresh-btn" :disabled="isLoading">
          <Icon name="refresh" :class="{ spinning: isLoading }" />
          {{ $t('activitypub.refresh') }}
        </button>
      </div>

      <!-- Instance Search (only visible on instances tab) -->
      <div v-if="currentView === 'instances'" class="search-group">
        <input 
          v-model="instanceSearchTerm" 
          @input="searchInstances(instanceSearchTerm)"
          type="text" 
          :placeholder="$t('activitypub.searchInstances')" 
          class="search-input"
        />
        <Icon name="search" class="search-icon" />
      </div>
    </div>

    <!-- Content Display -->
    <div class="explore-content-area">
      <!-- Loading State -->
      <div v-if="isLoading" class="loading-state">
        <Icon name="loader" class="spinning" />
        <p>{{ $t('activitypub.loadingExploreContent') }}</p>
      </div>

      <!-- Trending Content -->
      <div v-else-if="currentView === 'trending'" class="trending-content">
        <!-- Trending Hashtags -->
        <div class="section trending-hashtags">
          <h3 class="section-title">
            <Icon name="hash" />
            {{ $t('activitypub.trendingHashtags') }}
          </h3>
          <div v-if="trendingHashtags.length > 0" class="hashtag-grid">
            <div 
              v-for="hashtag in trendingHashtags" 
              :key="hashtag.tag"
              @click="loadHashtagPosts(hashtag.tag)"
              class="hashtag-item"
            >
              <div class="hashtag-info">
                <span class="hashtag-name">#{{ hashtag.tag }}</span>
                <span class="hashtag-count">{{ formatNumber(hashtag.daily_uses) }} {{ $t('activitypub.postsCount') }}</span>
              </div>
              <div class="hashtag-trend">
                <Icon :name="getTrendIcon(hashtag.trend)" :class="`trend-${hashtag.trend}`" />
                <span class="trend-change">{{ hashtag.change_percent > 0 ? '+' : '' }}{{ hashtag.change_percent }}%</span>
              </div>
            </div>
          </div>
          <div v-else class="empty-state">
            <Icon name="hash" />
            <p>{{ $t('activitypub.noTrendingHashtags') }}</p>
          </div>
        </div>

        <!-- Trending Posts -->
        <div class="section trending-posts">
          <h3 class="section-title">
            <Icon name="trending-up" />
            {{ $t('activitypub.trendingPosts') }}
          </h3>
          <div v-if="trendingPosts.length > 0" data-timeline class="posts-list">
            <MonyPost
              v-for="trendingPost in trendingPosts"
              :key="trendingPost.post?.id || trendingPost.id"
              :post="trendingPost.post || trendingPost"
              @reply="$emit('reply-to-post', $event)"
              @favorite="$emit('favorite-post', $event)"
              @reblog="$emit('reblog-post', $event)"
              @bookmark="$emit('bookmark-post', $event)"
              @delete="$emit('delete-post', $event)"
              @show-user-profile="$emit('show-user-profile', $event)"
              @show-conversation="$emit('show-conversation', $event)"
            />
          </div>
          <div v-else class="empty-state">
            <Icon name="trending-up" />
            <p>{{ $t('activitypub.noTrendingPosts') }}</p>
          </div>
        </div>

        <!-- Suggested Users -->
        <div class="section suggested-users">
          <h3 class="section-title">
            <Icon name="user-plus" />
            {{ $t('activitypub.suggestedUsers') }}
          </h3>
          <div v-if="suggestedUsers.length > 0" class="users-grid">
            <ProfileCard 
              v-for="user in suggestedUsers"
              :key="user.user?.id || user.id"
              :user="user.user || user"
              :show-more-actions="true"
              :is-compact="true"
              @click="$emit('show-user-profile', user.user || user)"
            />
          </div>
          <div v-else class="empty-state">
            <Icon name="users" />
            <p>{{ $t('activitypub.noSuggestedUsers') }}</p>
          </div>
        </div>
      </div>

      <!-- Instance Browser -->
      <div v-else-if="currentView === 'instances'" class="instances-content">
        <div class="section instances-browser">
          <h3 class="section-title">
            <Icon name="server" />
            {{ $t('activitypub.federatedInstances') }}
          </h3>
          <div v-if="filteredInstances.length > 0" class="instances-grid">
            <div 
              v-for="instance in filteredInstances" 
              :key="instance.domain"
              @click="showInstanceDetails(instance)"
              class="instance-card"
            >
              <div class="instance-header">
                <div class="instance-info">
                  <h4 class="instance-domain">{{ instance.domain }}</h4>
                  <p class="instance-software">{{ instance.software || 'Unknown' }} {{ instance.version || '' }}</p>
                </div>
                <div :class="getInstanceStatusClass(instance)">
                  {{ getInstanceStatusText(instance) }}
                </div>
              </div>
              
              <p class="instance-description">
                {{ instance.description || $t('activitypub.noDescriptionAvailable') }}
              </p>
              
              <div class="instance-stats">
                <div class="stat">
                  <Icon name="users" />
                  <span>{{ formatNumber(instance.user_count || 0) }} {{ $t('activitypub.usersCount') }}</span>
                </div>
                <div class="stat">
                  <Icon name="message-circle" />
                  <span>{{ formatNumber(instance.status_count || 0) }} {{ $t('activitypub.postsCount') }}</span>
                </div>
                <div class="stat">
                  <Icon name="globe" />
                  <span>{{ formatNumber(instance.connection_count || 0) }} {{ $t('activitypub.connectionsCount') }}</span>
                </div>
              </div>
              
              <div class="instance-footer">
                <span class="last-seen">{{ $t('activitypub.lastSeen') }} {{ getTimeAgo(instance.last_seen_at) }}</span>
                <div class="instance-actions">
                  <button @click.stop="visitInstance(instance)" class="action-btn">
                    <Icon name="external-link" />
                    {{ $t('activitypub.visit') }}
                  </button>
                  <button @click.stop="viewInstancePosts(instance)" class="action-btn">
                    <Icon name="eye" />
                    {{ $t('activitypub.viewPosts') }}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="empty-state">
            <Icon name="server" />
            <p>{{ $t('activitypub.noInstancesFound') }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Load More Button -->
    <div v-if="hasMoreContent && !isLoading" class="load-more-section">
      <button @click="loadMore" :disabled="isLoadingMore" class="load-more-btn">
        <Icon v-if="isLoadingMore" name="loader" class="spinning" />
        <Icon v-else name="chevron-down" />
        {{ isLoadingMore ? $t('activitypub.loading') : $t('activitypub.loadMore') }}
      </button>
    </div>

    <!-- Instance Detail Modal -->
    <InstanceDetailModal
      v-if="showInstanceModal"
      :instance="selectedInstanceDetails"
      @close="showInstanceModal = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { activityPubService } from '@/services/activityPubService';
import { trendingService } from '@/services/TrendingService';
import { adminService } from '@/services/AdminService';
import MonyPost from './MonyPost.vue';
import InstanceDetailModal from './InstanceDetailModal.vue';
import Icon from '@/components/common/Icon.vue';
import type { TimelinePost, FederatedUser } from '@/types';
import Avatar from '../common/Avatar.vue';
import ProfileCard from '@/components/common/ProfileCard.vue';

// Router
const router = useRouter();

const { t } = useI18n();

// Props
interface Props {
  currentView: 'trending' | 'instances';
}

const props = defineProps<Props>();

// Define emits
defineEmits<{
  'switch-feed': [feedType: string];
  'refresh-timeline': [];
  'show-user-profile': [user: FederatedUser];
  'follow-user': [userId: string];
  'unfollow-user': [userId: string];
  'reply-to-post': [post: TimelinePost];
  'favorite-post': [postId: string];
  'reblog-post': [postId: string];
  'bookmark-post': [postId: string];
  'delete-post': [postId: string];
  'show-conversation': [post: TimelinePost];
}>();

const activityPubStore = useActivityPubStore();

// Loading states
const isLoading = ref(false);
const isLoadingMore = ref(false);

// Filter states
const selectedContentType = ref('all');
const selectedInstance = ref('all');
const selectedTimeRange = ref('24h');
const instanceSearchTerm = ref('');

// Data states
const trendingHashtags = ref<any[]>([]);
const trendingPosts = ref<any[]>([]);
const suggestedUsers = ref<any[]>([]);
const knownInstances = ref<any[]>([]);
const selectedInstanceDetails = ref<any | null>(null);
const showInstanceModal = ref(false);

// Pagination
const hasMoreContent = ref(false);
const currentCursor = ref<string | null>(null);

// Computed properties
const filteredInstances = computed(() => {
  if (!knownInstances.value) return [];
  
  let filtered = knownInstances.value;
  
  if (selectedContentType.value !== 'all') {
    // Apply content type filtering if needed
  }
  
  return filtered;
});

const currentTabData = computed(() => {
  switch (props.currentView) {
    case 'trending':
      return {
        posts: trendingPosts.value,
        hashtags: trendingHashtags.value,
        users: suggestedUsers.value
      };
    case 'instances':
      return {
        instances: filteredInstances.value
      };
    default:
      return {};
  }
});

// Methods
const getTimeRangeDays = (): number => {
  switch (selectedTimeRange.value) {
    case '1h': return 1;
    case '6h': return 1;
    case '24h': return 1;
    case '7d': return 7;
    case '30d': return 30;
    default: return 1;
  }
};

const loadTrendingContent = async () => {
  try {
    isLoading.value = true;
    const days = getTimeRangeDays();
    
    const [hashtags, posts, users] = await Promise.all([
      trendingService.getTrendingHashtags({ limit: 20, days }),
      trendingService.getTrendingPosts({ 
        limit: 20, 
        timeframe: 'daily',
        includeLocal: true,
        includeFederated: true 
      }),
      trendingService.getTrendingUsers({ limit: 6 })
    ]);

    trendingHashtags.value = hashtags;
    trendingPosts.value = posts;
    suggestedUsers.value = users;
  } catch (error) {
    debug.error('Failed to load trending content:', error);
  } finally {
    isLoading.value = false;
  }
};

const loadInstances = async () => {
  try {
    isLoading.value = true;
    
    const instances = await activityPubService.getDiscoverableInstances({
      limit: 50,
      filter: 'active'
    });
    
    knownInstances.value = instances;
  } catch (error) {
    debug.error('Failed to load instances:', error);
    // Fallback to AdminService
    try {
      const adminInstances = await adminService.getFederatedInstances({
        limit: 50,
        filter: 'all'
      });
      knownInstances.value = adminInstances.instances || [];
    } catch (adminError) {
      debug.error('Failed to load instances from admin service:', adminError);
    }
  } finally {
    isLoading.value = false;
  }
};

const loadHashtagPosts = (hashtag: string) => {
  // Navigate to hashtag view
  router.push({ name: 'HashtagView', params: { tag: hashtag } });
};

const showInstanceDetails = async (instance: any) => {
  try {
    selectedInstanceDetails.value = instance;
    
    // Load additional instance stats
    const stats = await activityPubService.getInstanceStats(instance.domain);
    if (stats) {
      selectedInstanceDetails.value = { ...instance, ...stats };
    }
    
    showInstanceModal.value = true;
  } catch (error) {
    debug.error('Failed to load instance details:', error);
    selectedInstanceDetails.value = instance;
    showInstanceModal.value = true;
  }
};

const visitInstance = (instance: any) => {
  window.open(`https://${instance.domain}`, '_blank');
};

const viewInstancePosts = (instance: any) => {
  window.open(`https://${instance.domain}/public`, '_blank');
};

const searchInstances = async (searchTerm: string) => {
  if (!searchTerm.trim()) {
    await loadInstances();
    return;
  }
  
  try {
    const instances = await activityPubService.getDiscoverableInstances({
      limit: 20,
      filter: 'active',
      search: searchTerm.trim()
    });
    
    knownInstances.value = instances;
  } catch (error) {
    debug.error('Failed to search instances:', error);
  }
};

const getInstanceStatus = (instance: any): 'online' | 'slow' | 'offline' | 'unknown' => {
  // If instance has explicit status, use it
  if (instance.status && ['online', 'slow', 'offline'].includes(instance.status)) {
    return instance.status;
  }
  
  // Otherwise, determine status based on last_seen_at
  if (!instance.last_seen_at) return 'unknown';
  
  const now = new Date();
  const lastSeen = new Date(instance.last_seen_at);
  const hoursSinceLastSeen = (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60);
  
  if (hoursSinceLastSeen < 1) return 'online';
  if (hoursSinceLastSeen < 24) return 'slow';
  return 'offline';
};

const getInstanceStatusClass = (instance: any) => {
  const status = getInstanceStatus(instance);
  return {
    'instance-status': true,
    [`status-${status}`]: true
  };
};

const getInstanceStatusText = (instance: any) => {
  const { t } = useI18n();
  const status = getInstanceStatus(instance);
  switch (status) {
    case 'online':
      return t('activitypub.online');
    case 'slow':
      return t('activitypub.slow');
    case 'offline':
      return t('activitypub.offline');
    default:
      return t('activitypub.unknown');
  }
};

const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

const getTimeAgo = (dateString: string): string => {
  const { t } = useI18n();
  const now = new Date();
  const date = new Date(dateString);
  const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60));
  
  if (diffInHours < 1) return t('activitypub.justNow');
  if (diffInHours < 24) return t('activitypub.hoursAgo', { hours: diffInHours });
  
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 30) return t('activitypub.daysAgo', { days: diffInDays });
  
  const diffInMonths = Math.floor(diffInDays / 30);
  return t('activitypub.monthsAgo', { months: diffInMonths });
};

const getTrendIcon = (trend: string) => {
  switch (trend) {
    case 'up': return 'trending-up';
    case 'down': return 'trending-down';
    default: return 'minus';
  }
};

const loadMore = async () => {
  if (isLoadingMore.value || !hasMoreContent.value) return;
  
  try {
    isLoadingMore.value = true;
    
    if (props.currentView === 'trending') {
      // Load more trending posts
      const morePosts = await activityPubService.getTrendingPosts({
        limit: 10,
        timeframe: 'daily'
      });
      
      trendingPosts.value.push(...morePosts);
    }
    // Add more loading logic for other tabs if needed
    
  } catch (error) {
    debug.error('Failed to load more content:', error);
  } finally {
    isLoadingMore.value = false;
  }
};

const refreshContent = async () => {
  currentCursor.value = null;
  
  if (props.currentView === 'trending') {
    await loadTrendingContent();
  } else if (props.currentView === 'instances') {
    await loadInstances();
  }
};

// Watch for tab changes
watch(() => props.currentView, async (newTab) => {
  if (newTab === 'trending') {
    await loadTrendingContent();
  } else if (newTab === 'instances') {
    await loadInstances();
  }
}, { immediate: true });

// Watch for filter changes
watch([selectedContentType, selectedInstance, selectedTimeRange], async () => {
  await refreshContent();
});
</script>

<style scoped>
.explore-content {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
}

.explore-tabs {
  display: flex;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-secondary);
  padding: 0 16px;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-weight: 600;
  cursor: pointer;
  border-bottom: 3px solid transparent;
  transition: all 0.2s ease;
}

.tab-btn:hover {
  color: var(--text-primary);
  background: var(--background-hover);
}

.tab-btn.active {
  color: var(--harmony-primary);
  border-bottom-color: var(--harmony-primary);
}

.explore-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-secondary);
}

.filter-group {
  display: flex;
  gap: 12px;
}

.filter-select,
.search-input {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-primary);
  color: var(--text-primary);
  font-size: 14px;
}

.refresh-btn {
  background: var(--h-chat-light);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  color: white;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease;
}

.refresh-btn:hover:not(:disabled) {
  background: var(--harmony-primary-hover, #4752c4);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.explore-content-area {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.federated-post {
  position: relative;
}

.users-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
  align-items: start;
}

@media (max-width: 1200px) {
  .users-grid {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.75rem;
  }
}

@media (max-width: 900px) {
  .users-grid {
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.5rem;
  }
}

@media (max-width: 768px) {
  .users-grid {
    grid-template-columns: 1fr;
    gap: 0.75rem;
  }
}

.instance-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 16px;
  text-align: center;
  color: var(--text-secondary);
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top: 3px solid var(--harmony-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

.empty-state h3 {
  font-size: 20px;
  font-weight: 600;
  margin: 16px 0 8px;
  color: var(--text-primary);
}

.trending-sections {
  display: flex;
  flex-direction: column;
  gap: 32px;
  max-width: 800px;
  margin: 0 auto;
}

.trending-section {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 20px;
}

.trending-posts {
  margin-top: 16px;
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 700;
  margin: 0 0 16px;
  color: var(--text-primary);
}

.trending-hashtags {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hashtag-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--background-primary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.hashtag-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.hashtag-name {
  font-weight: 600;
  color: var(--harmony-primary);
  cursor: pointer;
  transition: color 0.2s ease;
}

.hashtag-name:hover {
  color: var(--harmony-primary-hover);
}

.hashtag-count {
  font-size: 14px;
  color: var(--text-secondary);
}

.hashtag-trend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  font-weight: 600;
}

.trend-up { color: #10b981; }
.trend-down { color: #ef4444; }
.trend-neutral { color: var(--text-secondary); }

.suggested-users {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.user-suggestion {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--background-primary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.user-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.user-info {
  flex: 1;
  min-width: 0;
}

.user-name {
  font-weight: 600;
  color: var(--text-primary);
}

.user-handle {
  font-size: 14px;
  color: var(--text-secondary);
}

.user-stats {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.follow-btn {
  padding: 6px 16px;
  background: var(--harmony-primary);
  border: none;
  border-radius: 16px;
  color: white;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease;
  flex-shrink: 0;
}

.follow-btn:hover {
  background: var(--harmony-primary-hover, #4752c4);
}

.instance-browser {
  max-width: 1000px;
  margin: 0 auto;
}

.instance-controls {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
}

.instances-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.instance-card {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.instance-card:hover {
  border-color: var(--harmony-primary);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.instance-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}

.instance-domain {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.instance-software {
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--background-tertiary);
  padding: 2px 6px;
  border-radius: 10px;
}

.instance-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
}

.instance-status.status-online {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.instance-status.status-online::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #10b981;
  animation: pulse 2s infinite;
}

.instance-status.status-slow {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.instance-status.status-slow::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f59e0b;
}

.instance-status.status-offline {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.instance-status.status-offline::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
}

.instance-status.status-unknown {
  background: rgba(156, 163, 175, 0.15);
  color: #9ca3af;
}

.instance-status.status-unknown::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #9ca3af;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.instance-stats {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
}

.instance-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.instance-actions .action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  background: var(--background-tertiary);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s ease;
}

.instance-actions .action-btn:hover {
  background: var(--background-quaternary);
}

.stat {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.instance-description {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.4;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Mobile responsive */
@media (max-width: 768px) {
  .explore-tabs {
    padding: 0 8px;
    overflow-x: auto;
  }
  
  .tab-btn {
    padding: 12px;
    white-space: nowrap;
  }
  
  .explore-controls {
    flex-direction: column;
    gap: 12px;
    align-items: stretch;
  }
  
  .filter-group {
    flex-wrap: wrap;
  }
  
  .instances-grid {
    grid-template-columns: 1fr;
  }
  
  .trending-sections {
    gap: 24px;
  }
  
  .instance-stats {
    flex-wrap: wrap;
    gap: 8px;
  }
  

  
  .tab-btn {
    padding: 0.75rem 1rem;
  }
}
</style> 