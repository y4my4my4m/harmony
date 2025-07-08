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
          :currentServer="currentServer || undefined"
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
    
    <!-- ActivityPub Mode: Social Navigation -->
    <div v-else-if="mode === 'activitypub'" class="social-sidebar">
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

      <!-- Instance Info -->
      <div class="instance-info">
        <h4 class="section-title">Instance</h4>
        <div class="instance-details">
          <p class="instance-domain">{{ instanceDomain }}</p>
          <p class="instance-stats">{{ instanceUserCount }} users</p>
          <p class="instance-stats">{{ instancePostCount }} posts</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ChannelSidebar from '@/components/ChannelSidebar.vue';
import DMSidebar from '@/components/DMSidebar.vue';
import Icon from '@/components/common/Icon.vue';
import { useAuthStore } from '@/stores/auth';
import { useProfileStore } from '@/stores/useProfile';
import type { Server, Channel, Category } from '@/types';

interface Props {
  mode: 'chat' | 'activitypub';
  
  // Chat mode props
  currentServer?: Server | null;
  channels?: Channel[];
  currentChannelId?: string;
  categories?: Category[];
  categoryChannels?: Record<string, Channel[]>;
  isDM?: boolean;
  
  // ActivityPub mode props
  followingCount?: number;
  followersCount?: number;
  instanceDomain?: string;
  instanceUserCount?: number;
  instancePostCount?: number;
}

const props = withDefaults(defineProps<Props>(), {
  channels: () => [],
  currentChannelId: '',
  categories: () => [],
  categoryChannels: () => ({}),
  isDM: false,
  followingCount: 0,
  followersCount: 0,
  instanceDomain: 'harmony.com',
  instanceUserCount: 0,
  instancePostCount: 0
});

defineEmits<{
  // Chat mode events
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
.adaptive-channel-sidebar {
  width: 240px;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
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

.dm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 2px solid var(--border-color);
  background: var(--background-secondary);
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
  padding: 16px;
  gap: 20px;
  overflow-y: auto;
}

.social-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 2px solid var(--border-color);
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
  padding: 8px 12px;
  text-decoration: none;
  color: var(--text-secondary);
  border-radius: 6px;
  transition: all 0.15s ease;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 2px;
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
  background: var(--background-primary);
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

.instance-info {
  padding: 16px;
  background: var(--background-primary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
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