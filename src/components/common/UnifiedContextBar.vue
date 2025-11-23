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
            <ServerIcon 
              :id="currentServer.id"
              :src="currentServer.icon"
              :class="'rounded'"
              size="xs"
              v-if="currentServer.icon" 
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
            <Icon :name="currentTab.icon" />
            <div class="feed-details">
              <div class="feed-name"><span>{{ currentTab.title }}</span><span>|</span><span class="instance-name">{{ instanceDomain }}</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/common/Icon.vue';
import type { Server, Channel } from '@/types';
import ServerIcon from './ServerIcon.vue';

const { t } = useI18n();

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
}>();

const feedTabs = [
  { id: 'home', label: t('activitypub.home'), icon: 'home' },
  { id: 'local', label: t('activitypub.local'), icon: 'users' },
  { id: 'public', label: t('activitypub.federated'), icon: 'globe' },
  { id: 'trending', label: t('activitypub.trending'), icon: 'trending-up' },
  { id: 'instances', label: t('activitypub.instances'), icon: 'server' }
];

const currentTab= computed(() => {
  const tab = feedTabs.find(tab => tab.id === props.currentView);
  return tab
    ? { id: tab.id, title: tab.label, icon: tab.icon }
    : { id: 'unknown', title: t('activitypub.timeline'), icon: 'globe' };
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
  background: var(--harmony-primary);
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

.server-icon{
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
  background: var(--harmony-primary);
  color: white;
}

.compose-btn {
  background: var(--harmony-primary);
  color: white;
}

.compose-btn:hover {
  background: var(--harmony-primary-hover);
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