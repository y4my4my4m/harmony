<template>
  <div class="adaptive-channel-sidebar" :class="{ 'social-mode': mode === 'activitypub' }">
    <!-- Chat Mode: Traditional Discord-like Channel Sidebar -->
    <div v-if="mode === 'chat'" class="channel-sidebar">
      <!-- Server Header -->
      <div class="server-header">
        <div class="server-info">
          <h2 class="server-name">{{ currentServer?.name || 'Direct Messages' }}</h2>
          <div class="server-meta">
            <span class="member-count">{{ totalMembers }} members</span>
            <span class="online-count">{{ onlineMembers }} online</span>
          </div>
        </div>
        <button 
          @click="$emit('switch-mode', 'activitypub')"
          class="mode-toggle-btn"
          title="Switch to Social"
        >
          <Icon name="globe" />
        </button>
      </div>

      <!-- Channel List -->
      <div class="channel-list">
        <div v-for="category in categories" :key="category.id" class="category-section">
          <div class="category-header">
            <h3 class="category-title">{{ category.name }}</h3>
            <button class="category-toggle" @click="toggleCategory(category.id)">
              <Icon name="chevron-down" :class="{ rotated: !category.expanded }" />
            </button>
          </div>
          <div v-if="category.expanded" class="category-channels">
            <div 
              v-for="channel in categoryChannels[category.id] || []"
              :key="channel.id"
              class="channel-item"
              :class="{ active: currentChannelId === channel.id }"
              @click="$emit('channel-selected', channel.id)"
            >
              <Icon :name="channel.type === 0 ? 'hash' : 'volume-2'" />
              <span class="channel-name">{{ channel.name }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ActivityPub Mode: Social/Federated Sidebar -->
    <div v-else-if="mode === 'activitypub'" class="social-sidebar">
      <!-- Header -->
      <div class="social-header">
        <div class="social-title">
          <Icon name="globe" class="social-icon" />
          <h2>Social</h2>
        </div>
        <button 
          @click="$emit('switch-mode', 'chat')"
          class="mode-toggle-btn"
          title="Switch to Chat"
        >
          <Icon name="message-circle" />
        </button>
      </div>

      <div class="social-sidebar-content">
        <!-- User Profile Card -->
        <div class="user-profile-card">
          <div class="profile-avatar">
            <Avatar
              :src="currentUser?.avatar_url"
              :alt="currentUser?.display_name || currentUser?.username"
              size="md"
              :interactive="true"
              @click="$emit('profile-click')"
            />
          </div>
          <div class="user-info">
            <h3 class="user-name">{{ currentUser?.display_name || currentUser?.username }}</h3>
            <p class="user-handle">{{ currentUserHandle }}</p>
          </div>
        </div>

        <!-- Navigation Links -->
        <nav class="social-nav">
          <div class="nav-section">
            <h4 class="nav-section-title">Navigation</h4>
            <router-link 
              v-for="navItem in navigationItems"
              :key="navItem.id"
              :to="navItem.path"
              :class="['nav-item', { active: $route.path === navItem.path }]"
            >
              <Icon :name="navItem.icon" />
              <span>{{ navItem.label }}</span>
            </router-link>
          </div>
        </nav>

        <!-- Enhanced Quick Stats with Realtime Updates -->
        <div class="quick-stats">
          <div class="stats-header">
            <h4 class="stats-title">Your Activity</h4>
            <button class="stats-refresh" @click="refreshStats" :disabled="isRefreshing">
              <Icon name="refresh-cw" :class="{ spinning: isRefreshing }" />
            </button>
          </div>
          <div class="stats-grid">
            <div class="stat-item following" @click="navigateToFollowing">
              <div class="stat-value">{{ activityPubStore.formattedFollowingCount }}</div>
              <div class="stat-label">Following</div>
              <div class="stat-change" v-if="followingChange !== 0">
                <Icon :name="followingChange > 0 ? 'arrow-up' : 'arrow-down'" />
                <span>{{ Math.abs(followingChange) }}</span>
              </div>
            </div>
            <div class="stat-item followers" @click="navigateToFollowers">
              <div class="stat-value">{{ activityPubStore.formattedFollowersCount }}</div>
              <div class="stat-label">Followers</div>
              <div class="stat-change" v-if="followersChange !== 0">
                <Icon :name="followersChange > 0 ? 'arrow-up' : 'arrow-down'" />
                <span>{{ Math.abs(followersChange) }}</span>
              </div>
            </div>
            <div class="stat-item posts" @click="navigateToProfile">
              <div class="stat-value">{{ postsCount }}</div>
              <div class="stat-label">Posts</div>
            </div>
          </div>
        </div>

        <!-- Instance Info -->
        <div class="instance-info">
          <div class="instance-header">
            <h4 class="instance-title">Instance</h4>
            <div class="instance-status online">
              <div class="status-dot"></div>
              <span>Online</span>
            </div>
          </div>
          <div class="instance-details">
            <div class="instance-domain">{{ instanceDomain }}</div>
            <div class="instance-stats">
              <div class="instance-stat">
                <span class="stat-value">{{ instanceUserCount }}</span>
                <span class="stat-label">users</span>
              </div>
              <div class="instance-stat">
                <span class="stat-value">{{ instancePostCount }}</span>
                <span class="stat-label">posts</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Quick Actions -->
        <div class="quick-actions">
          <button class="action-btn compose" @click="$emit('compose-post')">
            <Icon name="edit" />
            <span>New Post</span>
          </button>
          <button class="action-btn discover" @click="navigateToPublic">
            <Icon name="compass" />
            <span>Discover</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useActivityPubStore } from '@/stores/activitypub';
import { useAuthStore } from '@/stores/auth';
import type { Server, Channel, Category, User } from '@/types';
import Avatar from '@/components/common/Avatar.vue';
import Icon from '@/components/common/Icon.vue';

// Props
interface Props {
  mode: 'chat' | 'activitypub';
  currentServer?: Server;
  channels: Channel[];
  currentChannelId?: string;
  categories: Category[];
  categoryChannels: Record<string, Channel[]>;
  isDM?: boolean;
  followingCount?: number;
  followersCount?: number;
  instanceDomain?: string;
  instanceUserCount?: number;
  instancePostCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
  mode: 'chat',
  channels: () => [],
  categories: () => [],
  categoryChannels: () => ({}),
  isDM: false,
  followingCount: 0,
  followersCount: 0,
  instanceDomain: 'har.mony.lol',
  instanceUserCount: 0,
  instancePostCount: 0
});

// Emits
const emit = defineEmits<{
  'channel-selected': [channelId: string];
  'create-channel': [];
  'conversation-selected': [conversationId: string];
  'switch-mode': [mode: 'chat' | 'activitypub'];
  'profile-click': [];
  'compose-post': [];
}>();

// Stores and router
const activityPubStore = useActivityPubStore();
const authStore = useAuthStore();
const router = useRouter();
const route = useRoute();

// State
const isRefreshing = ref(false);
const followingChange = ref(0);
const followersChange = ref(0);
const previousFollowingCount = ref(0);
const previousFollowersCount = ref(0);

// Computed properties
const currentUser = computed(() => authStore.user);

const currentUserHandle = computed(() => {
  if (!currentUser.value) return '@unknown';
  return currentUser.value.domain && currentUser.value.domain !== 'har.mony.lol' 
    ? `@${currentUser.value.username}@${currentUser.value.domain}`
    : `@${currentUser.value.username}`;
});

const totalMembers = computed(() => {
  // Calculate total members from server or conversation
  return props.currentServer?.memberCount || 0;
});

const onlineMembers = computed(() => {
  // Calculate online members from server or conversation
  return props.currentServer?.onlineMembers || 0;
});

const postsCount = computed(() => {
  return activityPubStore.homeFeed.posts.filter(post => 
    post.author_id === currentUser.value?.id
  ).length;
});

const navigationItems = computed(() => [
  {
    id: 'home',
    path: '/social',
    icon: 'home',
    label: 'Home'
  },
  {
    id: 'public',
    path: '/social/public',
    icon: 'globe',
    label: 'Public'
  },
  {
    id: 'local',
    path: '/social/local',
    icon: 'map-pin',
    label: 'Local'
  },
  {
    id: 'profile',
    path: `/u/${currentUserHandle.value.replace('@', '')}`,
    icon: 'user',
    label: 'Profile'
  }
]);

// Methods
const toggleCategory = (categoryId: string) => {
  // Find and toggle category
  const category = props.categories.find(c => c.id === categoryId);
  if (category) {
    category.expanded = !category.expanded;
  }
};

const refreshStats = async () => {
  if (isRefreshing.value) return;
  
  isRefreshing.value = true;
  try {
    await activityPubStore.loadFollowCounts();
  } catch (error) {
    console.error('Failed to refresh stats:', error);
  } finally {
    isRefreshing.value = false;
  }
};

const navigateToFollowing = () => {
  router.push('/social/following');
};

const navigateToFollowers = () => {
  router.push('/social/followers');
};

const navigateToProfile = () => {
  router.push(`/u/${currentUserHandle.value.replace('@', '')}`);
};

const navigateToPublic = () => {
  router.push('/social/public');
};

// Watch for changes in follow counts to show delta indicators
watch(() => activityPubStore.followingCount, (newCount) => {
  if (previousFollowingCount.value !== 0) {
    followingChange.value = newCount - previousFollowingCount.value;
    if (followingChange.value !== 0) {
      // Clear the change indicator after 3 seconds
      setTimeout(() => {
        followingChange.value = 0;
      }, 3000);
    }
  }
  previousFollowingCount.value = newCount;
});

watch(() => activityPubStore.followersCount, (newCount) => {
  if (previousFollowersCount.value !== 0) {
    followersChange.value = newCount - previousFollowersCount.value;
    if (followersChange.value !== 0) {
      // Clear the change indicator after 3 seconds
      setTimeout(() => {
        followersChange.value = 0;
      }, 3000);
    }
  }
  previousFollowersCount.value = newCount;
});

// Lifecycle
onMounted(() => {
  // Initialize previous counts
  previousFollowingCount.value = activityPubStore.followingCount;
  previousFollowersCount.value = activityPubStore.followersCount;
  
  // Initialize ActivityPub store if in social mode
  if (props.mode === 'activitypub') {
    activityPubStore.initialize();
  }
});

onUnmounted(() => {
  // Cleanup if needed
});
</script>

<style scoped>
.adaptive-channel-sidebar {
  height: 100%;
  background: var(--h-sidebar, #2b2d31);
  display: flex;
  flex-direction: column;
  width: 240px;
  transition: all 0.3s ease;
}

.social-mode {
  background: linear-gradient(135deg, var(--h-sidebar), rgba(88, 101, 242, 0.05));
}

/* Chat Mode Styles */
.channel-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.server-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(0, 0, 0, 0.1);
}

.server-info {
  flex: 1;
}

.server-name {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 4px 0;
}

.server-meta {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #b9bbbe;
}

.mode-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 6px;
  color: #b9bbbe;
  cursor: pointer;
  transition: all 0.2s ease;
}

.mode-toggle-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  color: #ffffff;
}

.channel-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.category-section {
  margin-bottom: 8px;
}

.category-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.2s ease;
}

.category-header:hover {
  background: rgba(255, 255, 255, 0.05);
}

.category-title {
  font-size: 12px;
  font-weight: 600;
  color: #b9bbbe;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0;
}

.category-toggle {
  background: none;
  border: none;
  color: #b9bbbe;
  cursor: pointer;
  transition: transform 0.2s ease;
}

.category-toggle .rotated {
  transform: rotate(-90deg);
}

.category-channels {
  margin-left: 12px;
}

.channel-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  color: #b9bbbe;
}

.channel-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #dcddde;
}

.channel-item.active {
  background: rgba(88, 101, 242, 0.2);
  color: #ffffff;
}

.channel-name {
  font-size: 14px;
  font-weight: 500;
}

/* Social Mode Styles */
.social-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.social-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(88, 101, 242, 0.1);
}

.social-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.social-icon {
  color: var(--h-brand);
}

.social-title h2 {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0;
}

.social-sidebar-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.user-profile-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.user-profile-card:hover {
  background: rgba(255, 255, 255, 0.08);
  transform: translateY(-1px);
}

.profile-avatar {
  flex-shrink: 0;
}

.user-info {
  flex: 1;
  min-width: 0;
}

.user-name {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 2px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.user-handle {
  font-size: 12px;
  color: #b9bbbe;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.social-nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.nav-section-title {
  font-size: 12px;
  font-weight: 600;
  color: #b9bbbe;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 0 0 8px 0;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  color: #b9bbbe;
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s ease;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #dcddde;
}

.nav-item.active {
  background: rgba(88, 101, 242, 0.2);
  color: #ffffff;
}

.quick-stats {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 16px;
}

.stats-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.stats-title {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  margin: 0;
}

.stats-refresh {
  background: none;
  border: none;
  color: #b9bbbe;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s ease;
}

.stats-refresh:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.stats-refresh:disabled {
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

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.stat-item {
  position: relative;
  padding: 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: center;
}

.stat-item:hover {
  background: rgba(255, 255, 255, 0.08);
  transform: translateY(-1px);
}

.stat-item.posts {
  grid-column: 1 / -1;
}

.stat-value {
  font-size: 18px;
  font-weight: 700;
  color: #ffffff;
  margin-bottom: 2px;
}

.stat-label {
  font-size: 12px;
  color: #b9bbbe;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stat-change {
  position: absolute;
  top: -6px;
  right: -6px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  background: rgba(67, 181, 129, 0.2);
  border: 1px solid rgba(67, 181, 129, 0.3);
  border-radius: 12px;
  font-size: 10px;
  font-weight: 600;
  color: #43b581;
}

.instance-info {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 16px;
}

.instance-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.instance-title {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  margin: 0;
}

.instance-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #43b581;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #43b581;
}

.instance-details {
  text-align: center;
}

.instance-domain {
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  margin-bottom: 8px;
}

.instance-stats {
  display: flex;
  justify-content: space-around;
  gap: 16px;
}

.instance-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.instance-stat .stat-value {
  font-size: 16px;
  font-weight: 700;
  color: #ffffff;
}

.instance-stat .stat-label {
  font-size: 11px;
  color: #b9bbbe;
}

.quick-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: rgba(88, 101, 242, 0.1);
  border: 1px solid rgba(88, 101, 242, 0.2);
  border-radius: 8px;
  color: #ffffff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-btn:hover {
  background: rgba(88, 101, 242, 0.2);
  border-color: rgba(88, 101, 242, 0.3);
  transform: translateY(-1px);
}

.action-btn.compose {
  background: rgba(67, 181, 129, 0.1);
  border-color: rgba(67, 181, 129, 0.2);
}

.action-btn.compose:hover {
  background: rgba(67, 181, 129, 0.2);
  border-color: rgba(67, 181, 129, 0.3);
}

/* Responsive Design */
@media (max-width: 768px) {
  .adaptive-channel-sidebar {
    width: 100%;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1000;
    background: var(--h-sidebar);
  }
  
  .stats-grid {
    grid-template-columns: 1fr;
  }
  
  .stat-item.posts {
    grid-column: 1;
  }
  
  .instance-stats {
    flex-direction: column;
    gap: 8px;
  }
}

/* Scroll styling */
.social-sidebar-content::-webkit-scrollbar {
  width: 6px;
}

.social-sidebar-content::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
}

.social-sidebar-content::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

.social-sidebar-content::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.3);
}
</style>