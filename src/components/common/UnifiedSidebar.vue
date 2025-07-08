<template>
  <div class="unified-sidebar" :class="{ 'mobile-open': mobileOpen, mobile: isMobile }">
    <!-- Chat Mode Sidebar -->
    <div v-if="mode === 'chat'" class="sidebar-content chat-sidebar">
      <!-- Server Navigation -->
      <ServerSidebar
        :servers="servers"
        @showPublicServers="$emit('show-public-servers')"
      />
      
      <!-- Channel/DM Navigation -->
      <div class="navigation-area">
        <ChannelSidebar
          v-if="!isDM"
          :currentServer="currentServer"
          :channels="channels"
          :currentChannelId="currentChannelId"
          :categories="categories"
          :categoryChannels="categoryChannels"
          @channelSelected="$emit('channel-selected', $event)"
          @createChannel="$emit('create-channel', $event)"
        />
        <DMSidebar
          v-else
          @conversationSelected="$emit('conversation-selected', $event)"
        />
      </div>
      
      <!-- Social Mode Quick Access -->
      <div class="mode-quick-access">
        <button 
          @click="$emit('switch-mode', 'activitypub')" 
          class="social-access-btn"
          title="Switch to Social Mode"
        >
          <Icon name="globe" />
          <span>Social Feed</span>
        </button>
      </div>
      
      <!-- User Profile at Bottom -->
      <div class="user-profile-section">
        <UserProfileComponent />
      </div>
    </div>
    
    <!-- ActivityPub Mode Sidebar -->
    <div v-else-if="mode === 'activitypub'" class="sidebar-content activitypub-sidebar">
      <!-- Mode Switcher -->
      <div class="mode-switcher">
        <button 
          @click="$emit('switch-mode', 'chat')"
          class="mode-btn chat-mode-btn"
          title="Switch to Chat"
        >
          <Icon name="message-circle" />
          <span>Chat</span>
        </button>
        <button 
          @click="$emit('switch-mode', 'activitypub')"
          class="mode-btn activitypub-mode-btn active"
          title="Social Mode"
        >
          <Icon name="globe" />
          <span>Social</span>
        </button>
      </div>
      
      <!-- User Profile Card -->
      <div class="user-profile-card">
        <img 
          :src="currentUser?.avatar_url || '/default_avatar.png'" 
          :alt="currentUser?.display_name"
          class="user-avatar"
        />
        <div class="user-info">
          <h3 class="user-name">{{ currentUser?.display_name || currentUser?.username }}</h3>
          <p class="user-handle">{{ currentUserHandle }}</p>
        </div>
      </div>

      <!-- Navigation Links -->
      <nav class="activitypub-nav">
        <router-link 
          v-for="navItem in navigationItems"
          :key="navItem.id"
          :to="navItem.path"
          :class="['nav-item', { active: $route.path === navItem.path }]"
        >
          <Icon :name="navItem.icon" />
          <span>{{ navItem.label }}</span>
        </router-link>
      </nav>

      <!-- Quick Stats -->
      <div class="quick-stats">
        <div class="stat-item">
          <span class="stat-value">{{ followingCount }}</span>
          <span class="stat-label">Following</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">{{ followersCount }}</span>
          <span class="stat-label">Followers</span>
        </div>
      </div>

      <!-- Back to Chat (Alternative to mode switcher) -->
      <div class="mode-actions">
        <button 
          @click="$emit('switch-mode', 'chat')" 
          class="back-to-chat-btn"
        >
          <Icon name="message-circle" />
          <span>Back to Chat</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ServerSidebar from '@/components/ServerSidebar.vue';
import ChannelSidebar from '@/components/ChannelSidebar.vue';
import DMSidebar from '@/components/DMSidebar.vue';
import UserProfileComponent from '@/components/UserProfileComponent.vue';
import Icon from '@/components/common/Icon.vue';
import { useAuthStore } from '@/stores/auth';
import { useProfileStore } from '@/stores/useProfile';
import type { Server, Channel, Category, CategoryChannels } from '@/types';

interface Props {
  mode: 'chat' | 'activitypub';
  mobileOpen?: boolean;
  isMobile?: boolean;
  
  // Chat mode props
  servers?: Server[];
  currentServer?: Server | null;
  channels?: Channel[];
  currentChannelId?: string;
  categories?: Category[];
  categoryChannels?: CategoryChannels;
  isDM?: boolean;
  
  // ActivityPub mode props
  followingCount?: number;
  followersCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
  mobileOpen: false,
  isMobile: false,
  servers: () => [],
  channels: () => [],
  currentChannelId: '',
  categories: () => [],
  categoryChannels: () => ({}),
  isDM: false,
  followingCount: 0,
  followersCount: 0
});

defineEmits<{
  // Chat mode events
  'show-public-servers': [];
  'channel-selected': [channelId: string];
  'create-channel': [categoryId: string];
  'conversation-selected': [conversationId: string];
  
  // Mode switching
  'switch-mode': [mode: 'chat' | 'activitypub'];
}>();

const route = useRoute();
const authStore = useAuthStore();
const profileStore = useProfileStore();

const currentUser = computed(() => profileStore.profile);

const currentUserHandle = computed(() => {
  if (!currentUser.value) return '';
  const domain = currentUser.value.domain || 'harmony.com';
  return domain === 'harmony.com' 
    ? `@${currentUser.value.username}`
    : `@${currentUser.value.username}@${domain}`;
});

const navigationItems = computed(() => [
  { id: 'profile', label: 'Profile', path: '/u/' + authStore.session?.user?.id, icon: 'user' },
  { id: 'notifications', label: 'Notifications', path: '/social/notifications', icon: 'bell' },
  { id: 'bookmarks', label: 'Bookmarks', path: '/social/bookmarks', icon: 'bookmark' },
  { id: 'lists', label: 'Lists', path: '/social/lists', icon: 'list' },
  { id: 'settings', label: 'Settings', path: '/settings', icon: 'settings' }
]);
</script>

<style scoped>
.unified-sidebar {
  width: 240px;
  height: 100%;
  background: var(--background-primary);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  position: relative;
  transition: transform 0.3s ease;
}

.sidebar-content {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* Chat Mode Styles */
.chat-sidebar {
  /* Inherits from existing sidebar styles */
}

.navigation-area {
  flex: 1;
  overflow: hidden;
}

.user-profile-section {
  border-top: 1px solid var(--border-color);
  background: var(--background-secondary);
}

/* ActivityPub Mode Styles */
.activitypub-sidebar {
  padding: 16px;
  gap: 20px;
}

.mode-switcher {
  display: flex;
  background: var(--background-tertiary);
  border-radius: 8px;
  padding: 4px;
  gap: 4px;
}

.mode-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 12px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mode-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.mode-btn.active {
  background: var(--brand-primary);
  color: white;
}

.user-profile-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.user-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
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

.activitypub-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  text-decoration: none;
  color: var(--text-secondary);
  border-radius: 6px;
  transition: all 0.15s ease;
  font-size: 14px;
  font-weight: 500;
}

.nav-item:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--brand-primary);
  color: white;
}

.quick-stats {
  display: flex;
  justify-content: space-around;
  padding: 16px;
  background: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
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

.mode-actions {
  margin-top: auto;
}

.back-to-chat-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.back-to-chat-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.mode-quick-access {
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
  background: var(--background-secondary);
}

.social-access-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.social-access-btn:hover {
  background: var(--brand-primary);
  color: white;
  border-color: var(--brand-primary);
}

/* Mobile Styles */
.unified-sidebar.mobile {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 200;
  transform: translateX(-100%);
}

.unified-sidebar.mobile.mobile-open {
  transform: translateX(0);
}

@media (max-width: 768px) {
  .unified-sidebar {
    width: 280px;
  }
  
  .activitypub-sidebar {
    padding: 12px;
    gap: 16px;
  }
  
  .user-profile-card {
    padding: 12px;
  }
  
  .quick-stats {
    padding: 12px;
  }
}
</style>