<template>
  <div class="unified-context-bar" :class="{ mobile: isMobile }">
    <!-- Chat Mode Context Bar -->
    <div v-if="mode === 'chat'" class="context-content chat-context">
      <div class="context-left">
      </div>
      <div class="context-center">
        <button 
          v-if="isMobile"
          class="mobile-menu-btn"
          @click="$emit('toggle-left-sidebar')"
          :class="{ active: leftSidebarOpen }"
        >
          <Icon name="menu" />
        </button>
        
        <div class="context-title">
          <div class="server-info" v-if="!isDM && currentServer">
            <img 
              v-if="currentServer.icon" 
              :src="currentServer.icon" 
              :alt="currentServer.name"
              class="server-icon"
            />
            <div class="server-details">
              <h2 class="server-name">{{ currentServer.name }}</h2>
            </div>
          </div>
          <div class="dm-info" v-else-if="isDM">
            <Icon name="message-circle" />
            <h2 class="dm-title">Direct Messages</h2>
          </div>
          <div class="app-info" v-else>
            <h2 class="app-name">Harmony</h2>
          </div>
        </div>
      </div>
      <div class="context-actions">
        <button 
          v-if="!isDM"
          class="action-btn"
          @click="$emit('toggle-voice-panel')"
          :class="{ active: voicePanelOpen }"
          title="Voice & Video"
        >
          <Icon name="phone" />
        </button>
        
        <button 
          class="action-btn"
          @click="$emit('toggle-search')"
          title="Search"
        >
          <Icon name="search" />
        </button>
        
        <button 
          v-if="!isMobile"
          class="action-btn"
          @click="$emit('toggle-right-sidebar')"
          :class="{ active: rightSidebarOpen }"
          title="Member List"
        >
          <Icon name="users" />
        </button>
        
        <button 
          v-if="isMobile"
          class="mobile-menu-btn"
          @click="$emit('toggle-right-sidebar')"
          :class="{ active: rightSidebarOpen }"
        >
          <Icon name="users" />
        </button>
      </div>
    </div>
    
    <!-- ActivityPub Mode Context Bar -->
    <div v-else-if="mode === 'activitypub'" class="context-content activitypub-context">
      <div class="context-left"></div>
      <div class="context-center">
        <button 
          v-if="isMobile"
          class="mobile-menu-btn"
          @click="$emit('toggle-left-sidebar')"
          :class="{ active: leftSidebarOpen }"
        >
          <Icon name="menu" />
        </button>
        
        <div class="context-title">
          <div class="feed-info">
            <Icon name="globe" />
            <div class="feed-details">
              <div class="feed-name"><span>{{ currentViewTitle }}</span><span>|</span><span class="instance-name">{{ instanceDomain }}</span></div>
            </div>
          </div>
        </div>
      </div>
      
      <div class="context-actions">
        
        <button 
          v-if="currentView === 'home'"
          class="action-btn"
          @click="$emit('refresh-timeline')"
          title="Refresh Timeline"
        >
          <Icon name="refresh-cw" />
        </button>
        
        <button 
          class="action-btn"
          @click="$emit('open-search')"
          title="Search"
        >
          <Icon name="search" />
        </button>
        
        <button 
          class="action-btn compose-btn"
          @click="$emit('open-composer')"
          title="Create Post"
        >
          <Icon name="edit" />
        </button>
        
        <button 
          v-if="isMobile"
          class="mobile-menu-btn"
          @click="$emit('toggle-right-sidebar')"
          :class="{ active: rightSidebarOpen }"
        >
          <Icon name="trending-up" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from '@/components/common/Icon.vue';
import type { Server, Channel } from '@/types';

interface Props {
  mode: 'chat' | 'activitypub';
  isMobile?: boolean;
  leftSidebarOpen?: boolean;
  rightSidebarOpen?: boolean;
  voicePanelOpen?: boolean;
  
  // Chat mode props
  currentServer?: Server | null;
  currentChannel?: Channel | null;
  isDM?: boolean;
  
  // ActivityPub mode props
  currentView?: 'home' | 'local' | 'public' | 'trending' | 'instances';
  instanceDomain?: string;
}

const props = withDefaults(defineProps<Props>(), {
  isMobile: false,
  leftSidebarOpen: false,
  rightSidebarOpen: false,
  voicePanelOpen: false,
  isDM: false,
  currentView: 'home',
});

defineEmits<{
  'toggle-left-sidebar': [];
  'toggle-right-sidebar': [];
  'toggle-voice-panel': [];
  'toggle-search': [];
  'switch-feed': [feedType: 'home' | 'local' | 'public' | 'trending' | 'instances'];
  'refresh-timeline': [];
  'open-search': [];
  'open-composer': [];
}>();

const feedTabs = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'local', label: 'Local', icon: 'users' },
  { id: 'public', label: 'Federated', icon: 'globe' },
  { id: 'trending', label: 'Trending', icon: 'trending-up' },
  { id: 'instances', label: 'Instances', icon: 'server' }
];

const currentViewTitle = computed(() => {
  const tab = feedTabs.find(t => t.id === props.currentView);
  return tab ? `${tab.label}` : 'Timeline';
});
</script>

<style scoped>
.unified-context-bar {
  height: 36px;
  background: var(--background-tertiary);
  display: flex;
  align-items: center;
  padding: 0 16px;
  position: relative;
  z-index: 100;
}

.context-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 16px;
}

.context-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.context-center {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.mobile-menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.mobile-menu-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.mobile-menu-btn.active {
  background: var(--brand-primary);
  color: white;
}

.context-title {
  flex: 1;
  min-width: 0;
}

.server-info, .dm-info, .app-info, .feed-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.server-icon {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  object-fit: cover;
}

.server-details, .feed-details {
  min-width: 0;
}

.server-name, .dm-title, .app-name, .feed-name {
  font-size: 16px;
  margin: 0;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.8;
  display: flex;
  align-items: center;
  gap: 8px;
}

.channel-name, .instance-name {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.channel-name {
  margin-left: 10px;
}

.context-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.action-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.action-btn.active {
  background: var(--brand-primary);
  color: white;
}

.compose-btn {
  background: var(--brand-primary);
  color: white;
}

.compose-btn:hover {
  background: var(--brand-primary-hover);
}

/* Mobile specific styles */
.unified-context-bar.mobile .feed-switcher {
  gap: 2px;
  padding: 2px;
}

.unified-context-bar.mobile .feed-tab {
  padding: 8px;
  min-width: 40px;
}

.unified-context-bar.mobile .feed-tab span {
  display: none;
}

@media (max-width: 768px) {
  .unified-context-bar {
    padding: 0 12px;
  }
  
  .context-left {
    gap: 8px;
  }
  
  .context-actions {
    gap: 4px;
  }
}
</style>