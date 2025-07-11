<template>
  <div class="adaptive-channel-sidebar">
    <!-- Chat Mode: Regular Channels -->
    <div v-if="mode === 'chat' && !isDM" class="chat-mode-container">
      
      <div class="chat-content">
        <!-- Debug info (remove in production) -->
        <div v-if="false" style="background: red; color: white; padding: 4px; font-size: 10px;">
          Server: {{ currentServer?.name || 'None' }} | 
          Channels: {{ channels?.length || 0 }} |
          Categories: {{ categories?.length || 0 }}
        </div>
        
        <ChannelSidebar
          v-if="currentServer"
          :currentServer="currentServer"
          :channels="channels"
          :currentChannelId="currentChannelId"
          :categories="categories"
          :categoryChannels="categoryChannels"
          @channelSelected="$emit('channel-selected', $event)"
          @createChannel="$emit('create-channel', $event)"
        />
      </div>
    </div>
    
    <!-- DM Mode: Conversations List -->
    <div v-else-if="mode === 'chat' && isDM" class="dm-mode-container">
      <div class="dm-header">
        <div class="dm-title">
          <Icon name="message-circle" />
          <h2>Direct Messages</h2>
        </div>
        <button 
          @click="$emit('switch-mode', 'activitypub')"
          class="mode-toggle-btn"
          title="Switch to Social"
        >
          <Icon name="globe" />
        </button>
      </div>
      
      <div class="dm-content">
        <DMSidebar
          @conversationSelected="$emit('conversation-selected', $event)"
        />
      </div>
    </div>

    <!-- ActivityPub Mode: Social/Federated Sidebar -->
    <div v-if="mode === 'activitypub'" class="social-sidebar">
      <!-- Header -->
      <div class="social-header">
        <div class="social-title">
          <Icon name="globe" />
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
          <Avatar
            :src="currentUser?.avatar_url"
            :alt="currentUser?.display_name || currentUser?.username"
            size="md"
            :interactive="true"
            @click="$emit('profile-click')"
          />
          <div class="user-info">
            <h3 class="user-name">{{ currentUser?.display_name || currentUser?.username }}</h3>
            <p class="user-handle">{{ currentUserHandle }}</p>
          </div>
        </div>

        <!-- Navigation Links -->
        <nav class="social-nav">
          <div class="nav-section">
            <h4 class="nav-section-title">Navigation</h4>
            <button 
              v-for="navItem in navigationItems"
              :key="navItem.id"
              :class="['nav-item', { active: isNavItemActive(navItem) }]"
              @click="navigateToRoute(navItem.path)"
            >
              <Icon :name="navItem.icon" />
              <span>{{ navItem.label }}</span>
            </button>
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
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useProfileStore } from '@/stores/useProfile';
import type { Server, Channel, Category, User } from '@/types';
import Avatar from '@/components/common/Avatar.vue';
import Icon from '@/components/common/Icon.vue';
import ChannelSidebar from '@/components/ChannelSidebar.vue';
import DMSidebar from '@/components/DMSidebar.vue';

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
  currentChannelId: '',
  categories: () => [],
  categoryChannels: () => ({}),
  isDM: false,
  followingCount: 0,
  followersCount: 0,
  instanceDomain: 'har.mony.lol',
  instanceUserCount: 0,
  instancePostCount: 0
});

const emit = defineEmits<{
  // Chat mode events
  'channel-selected': [channelId: string];
  'create-channel': [categoryId: string];
  'conversation-selected': [conversationId: string];
  
  // Mode switching
  'switch-mode': [mode: 'chat' | 'activitypub'];
  
  // Profile events
  'profile-click': [];
  'compose-post': [];
}>();

const route = useRoute();
const router = useRouter();
const activityPubStore = useActivityPubStore();
const profileStore = useProfileStore();

// State
const followingChange = ref(0);
const followersChange = ref(0);
const previousFollowingCount = ref(0);
const previousFollowersCount = ref(0);

// Computed properties
const currentUser = computed(() => profileStore.profile);

const currentUserHandle = computed(() => {
  if (!currentUser.value) return '';
  
  // Handle case where domain might not be set yet
  const domain = currentUser.value.domain || 'har.mony.lol';
  const username = currentUser.value.username;
  
  if (!username) return '';
  
  return domain === 'har.mony.lol' 
    ? `@${username}`
    : `@${username}@${domain}`;
});

const getUserProfilePath = () => {
  if (!currentUser.value?.username) return '/social/home';
  
  const domain = currentUser.value.domain || 'har.mony.lol';
  const username = currentUser.value.username;
  
  // Generate clean handle without @ symbol for URL
  const handle = domain === 'har.mony.lol' 
    ? username 
    : `${username}@${domain}`;
    
  return `/profile/${handle}`;
};

const getProfileUrl = (handle: string) => {
  return `/profile/${handle}`;
};


const postsCount = computed(() => {
  return activityPubStore.homeFeed.posts.filter(post => 
    post.author_id === currentUser.value?.id
  ).length;
});

const navigationItems = computed(() => [
  { id: 'explore', label: 'Explore', path: '/explore', icon: 'compass' },
  { id: 'feed', label: 'Feed', path: '/social/home', icon: 'mony-mascot' },
  { id: 'profile', label: 'Profile', path: getUserProfilePath(), icon: 'user' },
  { id: 'notifications', label: 'Notifications', path: '/social/notifications', icon: 'bell' },
  { id: 'bookmarks', label: 'Bookmarks', path: '/social/bookmarks', icon: 'bookmark' },
  { id: 'lists', label: 'Lists', path: '/social/lists', icon: 'list' },
  { id: 'settings', label: 'Settings', path: '/settings', icon: 'settings' }
]);

// Determine if a navigation item should be active
const isNavItemActive = (navItem: { id: string; path: string }) => {
  const currentPath = route.path;
  
  if (navItem.id === 'feed') {
    // Feed is active for home, local, and public timelines
    return currentPath === '/social/home' || 
           currentPath === '/social/local' || 
           currentPath === '/social/public';
  }
  
  if (navItem.id === 'explore') {
    // Explore is active for explore, trending, and instances
    return currentPath === '/explore' || 
           currentPath === '/social/trending' || 
           currentPath === '/social/instances';
  }
  
  // Default to exact path matching for other items
  return currentPath === navItem.path;
};

const refreshStats = () => {
  // TODO: Implement refresh stats
  //activityPubStore.refreshStats();
  return
};

const isRefreshing = computed(() => {
  // TODO: Implement refresh stats
  //return activityPubStore.isRefreshing;
  return false
});

const navigateToFollowing = () => {
  router.push('/social/following');
};

const navigateToFollowers = () => {
  router.push('/social/followers');
};

const navigateToProfile = () => {
  if (currentUserHandle.value) {
    const handle = currentUserHandle.value.replace('@', '');
    router.push({ 
      name: 'UserProfile', 
      params: { handle } 
    });
  }
};

const navigateToRoute = (path: string) => {
  router.push(path);
};

// Format numbers for display (e.g., 1000 -> 1K)
const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
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
  width: 295px;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--background-tertiary);
  border-top-left-radius: 10px;
  border-left: 1px solid var(--border-color);
  border-top: 1px solid var(--border-color);
}

/* Chat Mode Styles */
.chat-mode-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 2px solid var(--border-color);
  background: var(--background-secondary);
}

.chat-title {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.chat-title h2 {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-content {
  flex: 1;
  overflow: hidden;
}

/* DM Mode Styles */
.dm-mode-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.dm-header,
.social-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  height: 48px;
}

.dm-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dm-title h2 {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
  color: var(--text-primary);
}

.dm-content {
  flex: 1;
  overflow: hidden;
}

/* Social Mode Styles */
.social-sidebar {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 20px;
  overflow-y: auto;
  padding-bottom: 100px;
}

.social-sidebar-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 16px;
}

.social-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.social-title h2 {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
  color: var(--text-primary);
}

.mode-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.mode-toggle-btn:hover {
  background: var(--background-hover);
  color: var(--brand-primary);
}

.user-profile-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--background-primary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}



.user-info {
  flex: 1;
  min-width: 0;
}

.user-name {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 4px 0;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user-handle {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.social-nav {
  flex: 1;
}

.nav-section {
  margin-bottom: 20px;
}

.nav-section-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin: 0 0 8px 0;
  letter-spacing: 0.02em;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-radius: 6px;
  color: var(--text-secondary);
  text-decoration: none;
  transition: all 0.15s ease;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 2px;
  cursor: pointer;
  border: none;
  background: transparent;
  width: 100%;
  text-align: left;
}

.nav-item:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--background-modifier-selected);
  color: var(--brand-primary);
}

.quick-stats {
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  padding: 16px;
  background: var(--background-primary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}
.stats-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  width: 100%;
  padding: 16px;
}
.stats-refresh {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.15s ease;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  width: 100%;
  padding: 16px;
}

.stat-item {
  text-align: center;
}

.stat-value {
  display: block;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
}

.instance-info {
  display: flex;
  flex-direction: column;
  padding: 16px;
  background: var(--background-primary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.instance-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.instance-title {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
  color: var(--text-primary);
}

.instance-status {
  display: flex;
  align-items: center;
  gap: 8px;
}
.instance-status .status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-secondary);
}
.instance-status.online .status-dot {
  background: var(--success);
}
.instance-status.offline .status-dot {
  background: var(--error);
}
.instance-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.instance-domain {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.instance-stats {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 16px;
}
.instance-stat {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 16px;
  flex-direction: column;
}



.section-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin: 0 0 12px 0;
  letter-spacing: 0.02em;
}

.instance-details {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.instance-domain {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.instance-stats {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
}

.user-profile-section {
  border-top: 1px solid var(--border-color);
  background: var(--background-secondary);
}

/* Mobile responsive */
@media (max-width: 768px) {
  .adaptive-channel-sidebar {
    width: 100%;
  }
  
  .social-sidebar {
    padding: 12px;
    gap: 16px;
  }
  
  .user-profile-card,
  .quick-stats,
  .instance-info {
    padding: 12px;
  }
}
</style>