<template>
  <div class="explore-content">
    <!-- Explore Controls -->
    <div class="explore-controls">
      <div class="filter-group">
        <select v-model="selectedContentType" class="filter-select">
          <option value="all">All Content</option>
          <option value="posts">Posts Only</option>
          <option value="media">With Media</option>
          <option value="users">Users</option>
        </select>
        
        <select v-if="currentExploreTab === 'federated'" v-model="selectedInstance" class="filter-select">
          <option value="all">All Instances</option>
          <option v-for="instance in knownInstances" :key="instance.domain" :value="instance.domain">
            {{ instance.domain }}
          </option>
        </select>
      </div>

      <button @click="refreshContent" :disabled="isLoading" class="refresh-btn">
        <Icon :name="isLoading ? 'loader' : 'refresh'" :class="{ spinning: isLoading }" />
        Refresh
      </button>
    </div>

    <!-- Content Area -->
    <div class="explore-content-area">
      <!-- Trending Content -->
      <div v-if="currentExploreTab === 'trending'" class="trending-content">
        <div class="trending-sections">
          <!-- Trending Hashtags -->
          <div class="trending-section">
            <h3 class="section-title">
              <Icon name="hash" />
              Trending Hashtags
            </h3>
            <div class="trending-hashtags">
              <div
                v-for="hashtag in trendingHashtags"
                :key="hashtag.tag"
                class="hashtag-item"
              >
                <div class="hashtag-info">
                  <span class="hashtag-name">#{{ hashtag.tag }}</span>
                  <span class="hashtag-count">{{ hashtag.posts }} posts</span>
                  <div class="hashtag-trend">
                    <Icon 
                      :name="hashtag.trend === 'up' ? 'trending-up' : hashtag.trend === 'down' ? 'trending-down' : 'minus'" 
                      :class="`trend-${hashtag.trend}`"
                    />
                    <span>{{ hashtag.change }}%</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Trending Posts -->
          <div class="trending-section">
            <h3 class="section-title">
              <Icon name="fire" />
              Trending Posts
            </h3>
            <div class="posts-list">
              <MonyPost
                v-for="post in trendingPosts"
                :key="post.id"
                :post="post"
                @reply="$emit('reply-to-post', $event)"
                @favorite="$emit('favorite-post', $event)"
                @reblog="$emit('reblog-post', $event)"
                @bookmark="$emit('bookmark-post', $event)"
                @delete="$emit('delete-post', $event)"
                @user-click="$emit('show-user-profile', $event)"
              />
            </div>
          </div>

          <!-- Suggested Users -->
          <div class="trending-section">
            <h3 class="section-title">
              <Icon name="user-plus" />
              Suggested Users
            </h3>
            <div class="suggested-users">
              <div
                v-for="user in suggestedUsers"
                :key="user.id"
                class="user-suggestion"
              >
                <img
                  :src="user.avatar_url || '/default_avatar.png'"
                  :alt="user.display_name"
                  class="user-avatar"
                />
                <div class="user-info">
                  <div class="user-name">{{ user.display_name }}</div>
                  <div class="user-handle">{{ user.handle }}</div>
                  <div class="user-stats">
                    {{ user.followers_count }} followers
                  </div>
                </div>
                <button
                  @click="$emit('follow-user', user.id)"
                  class="follow-btn"
                >
                  Follow
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Instance Browser -->
      <div v-else-if="currentExploreTab === 'instances'" class="instance-browser">
        <div class="instance-controls">
          <input
            v-model="instanceSearchQuery"
            placeholder="Search instances..."
            class="search-input"
          />
          <select v-model="instanceFilter" class="filter-select">
            <option value="all">All Instances</option>
            <option value="trusted">Trusted</option>
            <option value="blocked">Blocked</option>
          </select>
        </div>

        <div class="instances-grid">
          <div
            v-for="instance in filteredInstances"
            :key="instance.domain"
            class="instance-card"
            @click="selectedInstance = instance; showInstanceModal = true"
          >
            <div class="instance-header">
              <div class="instance-info">
                <h4 class="instance-domain">{{ instance.domain }}</h4>
                <span class="instance-software">{{ instance.software_name }}</span>
              </div>
              <div class="instance-status">
                <div :class="`status-indicator ${instance.status}`"></div>
              </div>
            </div>
            
            <div class="instance-stats">
              <div class="stat">
                <Icon name="users" />
                <span>{{ formatNumber(instance.user_count) }} users</span>
              </div>
              <div class="stat">
                <Icon name="message-circle" />
                <span>{{ formatNumber(instance.post_count) }} posts</span>
              </div>
              <div class="stat">
                <Icon name="clock" />
                <span>{{ formatLastSeen(instance.last_seen_at) }}</span>
              </div>
            </div>

            <p class="instance-description">
              {{ instance.description || 'No description available' }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Instance Detail Modal -->
    <InstanceDetailModal
      v-if="showInstanceModal && selectedInstance"
      :instance="selectedInstance"
      @close="showInstanceModal = false; selectedInstance = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useActivityPubStore } from '@/stores/useActivityPub';
import MonyPost from './MonyPost.vue';
import InstanceDetailModal from './InstanceDetailModal.vue';
import Icon from '@/components/common/Icon.vue';
import type { TimelinePost, FederatedUser } from '@/types';

// Props
interface Props {
  currentExploreTab?: 'trending' | 'instances';
}

const props = withDefaults(defineProps<Props>(), {
  currentExploreTab: 'trending'
});

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
}>();

const activityPubStore = useActivityPubStore();

// State
const selectedContentType = ref('all');
const selectedInstance = ref('all');
const instanceSearchQuery = ref('');
const instanceFilter = ref('all');
const isLoading = ref(false);
const showInstanceModal = ref(false);

// Tab configuration
const tabs = [
  { id: 'federated', label: 'Federated', icon: 'globe' },
  { id: 'local', label: 'Local', icon: 'users' },
  { id: 'trending', label: 'Trending', icon: 'trending-up' },
  { id: 'instances', label: 'Instances', icon: 'server' }
];

// Mock data (replace with real data from stores/APIs)
const federatedPosts = ref<TimelinePost[]>([]);
const localPosts = ref<TimelinePost[]>([]);
const trendingPosts = ref<TimelinePost[]>([]);
const knownInstances = ref([
  { domain: 'mastodon.social', user_count: 850000, post_count: 125000000 },
  { domain: 'hachyderm.io', user_count: 12000, post_count: 2500000 },
  { domain: 'fosstodon.org', user_count: 25000, post_count: 5200000 }
]);

const trendingHashtags = ref([
  { tag: 'harmony', posts: 1234, trend: 'up', change: 15 },
  { tag: 'social', posts: 567, trend: 'up', change: 8 },
  { tag: 'federation', posts: 234, trend: 'down', change: -3 },
  { tag: 'privacy', posts: 189, trend: 'up', change: 12 },
  { tag: 'opensource', posts: 156, trend: 'neutral', change: 0 }
]);

const suggestedUsers = ref<FederatedUser[]>([
  {
    id: 'user1',
    username: 'alice',
    domain: 'mastodon.social',
    handle: '@alice@mastodon.social',
    display_name: 'Alice Johnson',
    avatar_url: '/default_avatar.png',
    bio: 'ActivityPub enthusiast',
    is_local: false,
    verified: false,
    followers_count: 142,
    following_count: 89,
    posts_count: 234,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
]);

const instanceData = ref([
  {
    domain: 'mastodon.social',
    software_name: 'Mastodon',
    user_count: 850000,
    post_count: 125000000,
    status: 'connected',
    last_seen_at: new Date().toISOString(),
    description: 'The original server operated by the Mastodon gGmbH non-profit'
  },
  {
    domain: 'hachyderm.io',
    software_name: 'Mastodon',
    user_count: 12000,
    post_count: 2500000,
    status: 'connected',
    last_seen_at: new Date(Date.now() - 3600000).toISOString(),
    description: 'Community for professionals in technology'
  },
  {
    domain: 'fosstodon.org',
    software_name: 'Mastodon',
    user_count: 25000,
    post_count: 5200000,
    status: 'connected',
    last_seen_at: new Date(Date.now() - 1800000).toISOString(),
    description: 'Dedicated to Free and Open Source Software'
  }
]);

// Computed properties
const filteredFederatedPosts = computed(() => {
  let posts = federatedPosts.value;
  
  if (selectedContentType.value === 'media') {
    posts = posts.filter(p => p.media_attachments && p.media_attachments.length > 0);
  } else if (selectedContentType.value === 'posts') {
    posts = posts.filter(p => !p.media_attachments || p.media_attachments.length === 0);
  }
  
  if (selectedInstance.value !== 'all') {
    posts = posts.filter(p => p.author.domain === selectedInstance.value);
  }
  
  return posts;
});

const filteredLocalPosts = computed(() => {
  let posts = localPosts.value;
  
  if (selectedContentType.value === 'media') {
    posts = posts.filter(p => p.media_attachments && p.media_attachments.length > 0);
  } else if (selectedContentType.value === 'posts') {
    posts = posts.filter(p => !p.media_attachments || p.media_attachments.length === 0);
  }
  
  return posts;
});

const filteredInstances = computed(() => {
  let instances = instanceData.value;
  
  if (instanceSearchQuery.value) {
    const query = instanceSearchQuery.value.toLowerCase();
    instances = instances.filter(i => 
      i.domain.toLowerCase().includes(query) ||
      i.description.toLowerCase().includes(query)
    );
  }
  
  if (instanceFilter.value !== 'all') {
    // Filter by status when we have proper instance status
    instances = instances.filter(i => i.status === instanceFilter.value);
  }
  
  return instances;
});

// Methods
const refreshContent = async () => {
  isLoading.value = true;
  try {
    // Load content based on active tab
    if (props.currentExploreTab === 'federated') {
      // Load federated timeline
      await activityPubStore.loadPublicFeed();
      federatedPosts.value = activityPubStore.publicFeed.posts;
    } else if (props.currentExploreTab === 'local') {
      // Load local timeline
      await activityPubStore.loadLocalFeed();
      localPosts.value = activityPubStore.localFeed.posts;
    }
    // Trending and instances would load their respective data
  } catch (error) {
    console.error('Failed to refresh content:', error);
  } finally {
    isLoading.value = false;
  }
};

const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

const formatLastSeen = (dateString: string): string => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
};

// Lifecycle
onMounted(() => {
  refreshContent();
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
  color: var(--brand-primary);
  border-bottom-color: var(--brand-primary);
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
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--brand-primary);
  border: none;
  border-radius: 6px;
  color: white;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease;
}

.refresh-btn:hover:not(:disabled) {
  background: var(--brand-primary-hover, #4752c4);
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

.posts-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 600px;
  margin: 0 auto;
}

.federated-post {
  position: relative;
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
  border-top: 3px solid var(--brand-primary);
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
  color: var(--brand-primary);
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
  background: var(--brand-primary);
  border: none;
  border-radius: 16px;
  color: white;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease;
  flex-shrink: 0;
}

.follow-btn:hover {
  background: var(--brand-primary-hover, #4752c4);
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
  border-color: var(--brand-primary);
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
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-indicator.connected { background: #10b981; }
.status-indicator.disconnected { background: #ef4444; }
.status-indicator.limited { background: #f59e0b; }

.instance-stats {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
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
}
</style> 