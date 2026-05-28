<template>
  <div class="adaptive-channel-sidebar">
    <!-- Chat Mode: Regular Channels -->
    <div v-if="mode === 'chat' && !isDM" class="chat-mode-container">
      
      <div class="chat-content">
        <ChannelSidebar
          v-if="currentServer"
          :currentServer="currentServer"
          :channels="channels"
          :currentChannelId="currentChannelId"
          :categories="categories"
          :categoryChannels="categoryChannels"
          @channelSelected="$emit('channel-selected', $event)"
          @createChannel="(c?: string) => $emit('create-channel', c ?? '')"
          @openThread="$emit('open-thread', $event)"
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
          <h2>{{ $t('activitypub.social') }}</h2>
        </div>
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
            <h3 class="user-name">
              <DisplayName
                v-if="currentUser?.id"
                :userId="currentUser.id"
                :fallback="currentUser?.display_name || currentUser?.username"
                :truncate="true"
              />
              <template v-else>{{ currentUser?.display_name || currentUser?.username }}</template>
            </h3>
            <p class="user-handle">{{ currentUserHandle }}</p>
          </div>
        </div>

        <!-- Navigation Links -->
        <nav class="social-nav">
          <div class="nav-section">
            <h4 class="nav-section-title">{{ $t('activitypub.navigation') }}</h4>
            <button 
              v-for="navItem in navigationItems"
              :key="navItem.id"
              :class="['nav-item', { active: isNavItemActive(navItem) }]"
              @click="handleNavItemClick(navItem)"
            >
              <Icon :name="navItem.icon" />
              <span class="nav-label">{{ navItem.label }}</span>
              <span v-if="navItem.badge" class="nav-badge">{{ navItem.badge > 99 ? '99+' : navItem.badge }}</span>
            </button>
          </div>
        </nav>

        <!-- Enhanced Quick Stats with Realtime Updates (moved to bottom) -->
        <div class="quick-stats">
          <div class="stats-header">
            <h4 class="stats-title">{{ $t('activitypub.yourActivity') }}</h4>
            <button class="stats-refresh" @click="refreshStats" :disabled="isRefreshing">
              <Icon name="refresh-cw" :class="{ spinning: isRefreshing }" />
            </button>
          </div>
          <div class="stats-grid">
            <div class="stat-item following" @click="navigateToFollowing">
              <div class="stat-value">{{ activityPubStore.formattedFollowingCount }}</div>
              <div class="stat-label">{{ $t('activitypub.following') }}</div>
              <div class="stat-change" v-if="followingChange !== 0">
                <Icon :name="followingChange > 0 ? 'arrow-up' : 'arrow-down'" />
                <span>{{ Math.abs(followingChange) }}</span>
              </div>
            </div>
            <div class="stat-item followers" @click="navigateToFollowers">
              <div class="stat-value">{{ activityPubStore.formattedFollowersCount }}</div>
              <div class="stat-label">{{ $t('activitypub.followers') }}</div>
              <div class="stat-change" v-if="followersChange !== 0">
                <Icon :name="followersChange > 0 ? 'arrow-up' : 'arrow-down'" />
                <span>{{ Math.abs(followersChange) }}</span>
              </div>
            </div>
            <div class="stat-item posts" @click="navigateToProfile">
              <div class="stat-value">{{ postsCount }}</div>
              <div class="stat-label">{{ $t('activitypub.posts') }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue';
import { debug } from '@/utils/debug'
import { useRouter, useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useProfileStore } from '@/stores/useProfile';
import { useAuthStore } from '@/stores/auth';
import { useNotificationStore } from '@/stores/useNotification';
import type { Server, Channel, Category } from '@/types';

// I18n
const { t } = useI18n();
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';
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
  instanceDomain: import.meta.env.VITE_DOMAIN as string,
  instanceUserCount: 0,
  instancePostCount: 0
});

// eslint-disable-next-line unused-imports/no-unused-vars
const emit = defineEmits<{
  // Chat mode events
  'channel-selected': [channelId: string];
  'create-channel': [categoryId: string];
  'conversation-selected': [conversationId: string];
  'open-thread': [thread: any];
  
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
const authStore = useAuthStore();
const notificationStore = useNotificationStore();

// State
const followingChange = ref(0);
const followersChange = ref(0);
const previousFollowingCount = ref(0);
const previousFollowersCount = ref(0);

// Computed properties
const currentUser = computed(() => {
  // Try profile store first, fallback to auth store user data
  if (profileStore.profile) {
    return profileStore.profile
  }
  
  // Fallback to basic user info from auth if profile isn't loaded yet
  const authUser = authStore.session?.user
  if (authUser) {
    return {
      id: authUser.id,
      username: authUser.user_metadata?.username || authUser.email?.split('@')[0] || 'User',
      display_name: authUser.user_metadata?.display_name || authUser.user_metadata?.username || 'User',
      avatar_url: authUser.user_metadata?.avatar_url || null,
      status: 0, // Default to offline
      domain: import.meta.env.VITE_DOMAIN as string
    }
  }
  
  return null
});

const currentUserHandle = computed(() => {
  if (!currentUser.value) return '';
  
  // Handle case where domain might not be set yet
  const domain = currentUser.value.domain || import.meta.env.VITE_DOMAIN as string;
  const username = currentUser.value.username;
  
  if (!username) return '';
  
  return domain === import.meta.env.VITE_DOMAIN as string 
    ? `@${username}`
    : `@${username}@${domain}`;
});

const getUserProfilePath = () => {
  if (!currentUser.value?.username) return '/social/home';
  
  const domain = currentUser.value.domain || import.meta.env.VITE_DOMAIN as string;
  const username = currentUser.value.username;
  
  // Generate clean handle without @ symbol for URL
  const handle = domain === import.meta.env.VITE_DOMAIN as string 
    ? username 
    : `${username}@${domain}`;
    
  return `/social/profile/${handle}`;
};

// eslint-disable-next-line unused-imports/no-unused-vars
const getProfileUrl = (handle: string) => {
  return `/social/profile/${handle}`;
};


const postsCount = computed(() => {
  return activityPubStore.homeFeed.posts.filter(post => 
    post.author_id === currentUser.value?.id
  ).length;
});

const navigationItems = computed(() => [
  { id: 'explore', label: t('activitypub.explore'), path: '/explore', icon: 'compass' },
  { id: 'feed', label: t('activitypub.feed'), path: '/social/home', icon: 'mony-mascot' },
  { id: 'profile', label: t('activitypub.profile'), path: getUserProfilePath(), icon: 'user' },
  { id: 'mentions', label: t('activitypub.mentions'), path: '/social/mentions', icon: 'at-sign', badge: notificationStore.unreadMentions },
  { id: 'bookmarks', label: t('activitypub.bookmarks'), path: '/social/bookmarks', icon: 'bookmark' },
  { id: 'lists', label: t('activitypub.lists'), path: '/social/lists', icon: 'list' },
  { id: 'settings', label: t('navigation.settings'), path: '/settings', icon: 'settings' }
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

const refreshingStats = ref(false);

const refreshStats = async () => {
  if (refreshingStats.value) return;
  refreshingStats.value = true;
  try {
    await activityPubStore.initialize();
  } catch (e) {
    debug.error('Failed to refresh stats:', e);
  } finally {
    refreshingStats.value = false;
  }
};

const isRefreshing = computed(() => refreshingStats.value);

const navigateToFollowing = () => {
  router.push('/social/following');
};

const navigateToFollowers = () => {
  router.push('/social/followers');
};

const navigateToProfile = () => {
  if (currentUserHandle.value) {
    // Remove all @ symbols and use just the username part for local users
    let handle = currentUserHandle.value.replace(/^@/, ''); // Remove leading @
    
    // For local users, remove domain part if present
    if (!handle.includes('@')) {
      // Already clean handle for local user
    } else if (handle.endsWith(`@${import.meta.env.VITE_DOMAIN as string}`)) {
      // Remove local domain for clean local handle
      handle = handle.replace(`@${import.meta.env.VITE_DOMAIN as string}`, '');
    }
    
    debug.log(`🔗 Navigating to profile with handle: ${handle}`);
    router.push({ 
      name: 'UserProfile', 
      params: { handle } 
    });
  }
};

const navigateToRoute = (path: string) => {
  router.push(path);
};

const handleNavItemClick = (navItem: { id: string; path: string }) => {
  // Special handling for profile navigation
  if (navItem.id === 'profile') {
    navigateToProfile();
  } else {
    // Use regular path navigation for other items
    navigateToRoute(navItem.path);
  }
};

// Format numbers for display (e.g., 1000 -> 1K)
// eslint-disable-next-line unused-imports/no-unused-vars
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
  overflow-y: auto;
  overflow-x: hidden;
  /* Smooth scrolling */
  scroll-behavior: smooth;
  /* Custom scrollbar styling */
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb, rgba(79, 84, 92, 0.8)) transparent;
}

.chat-content::-webkit-scrollbar {
  width: 6px;
}

.chat-content::-webkit-scrollbar-track {
  background: transparent;
}

.chat-content::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb, rgba(79, 84, 92, 0.8));
  border-radius: 3px;
}

.chat-content::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-thumb-hover, rgba(79, 84, 92, 1));
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
  color: var(--text-primary);
}

.dm-title h2 {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
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
  padding-top: 0;
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
  color: var(--harmony-primary);
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
  color: var(--harmony-primary);
}

.nav-badge {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--status-danger, #ed4245);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
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
  color: var(--text-primary);
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

/* Mobile responsive */
@media (max-width: 768px) {
  .adaptive-channel-sidebar {
    width: 100%;
    border-top-left-radius: 0;
    border-top: 0;
  }
  
  .social-sidebar-content {
    padding: 12px;
    padding-top: 0;
  }
  .social-sidebar {
    gap: 12px;
  }
  
  .user-profile-card,
  .quick-stats,
  .instance-info {
    padding: 12px;
  }
}
</style>