<template>
  <div v-if="mode === ViewMode.CHAT" class="chat-header">
    <div class="channel-header"><HashTagIcon class="channel-icon" /><span>{{ currentChannel?.name || 'Channel' }}</span></div>
  </div>
  <div v-else class="mony-header">
    <div></div>
    <!-- Feed Type Switcher -->
    <div class="feed-switcher">
      <!-- Main feed tabs (always visible) -->
      <button
        v-for="tab in mainFeedTabs"
        :key="tab.id"
        @click="$emit('switch-feed', tab.id)"
        :class="['feed-tab', { active: currentView === tab.id }]"
        :title="tab.label"
      >
        <Icon :name="tab.icon" />
        <span v-if="!isMobile">{{ tab.label }}</span>
      </button>
    </div>
    <div></div>
    <div></div>
  </div>
</template>
<script setup lang="ts">
import { ref, computed } from 'vue';
import HashTagIcon from '@/components/icons/HashTag.vue';
import Icon from '@/components/common/Icon.vue';
import type { Channel } from '@/types';
import { ViewMode, ViewType, CurrentView, VIEW_CONFIGS } from '@/types/viewTypes';

// Professional tab configuration using the centralized type system
const mainFeedTabs = [
  { id: CurrentView.HOME, label: 'Home', icon: 'home' },
  { id: CurrentView.LOCAL, label: 'Local', icon: 'users' },
  { id: CurrentView.PUBLIC, label: 'Federated', icon: 'globe' },
  { id: CurrentView.TRENDING, label: 'Trending', icon: 'trending-up' },
  { id: CurrentView.INSTANCES, label: 'Instances', icon: 'server' }
];

const props = defineProps<{
  mode: ViewMode;
  currentView: string;
  isMobile: boolean;
  currentChannel?: Channel;
  viewType?: ViewType;
}>();

defineEmits<{
  'switch-feed': [feedType: string];
}>();
</script>

<style scoped>
.chat-header, .mony-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-primary);
  height: 48px;
}

.channel-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.channel-icon {
  width: 16px;
  height: 16px;
}

.mony-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

/* Feed Switcher */
.feed-switcher {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(32, 34, 37, 0.8);
  border: 2px solid rgba(88, 101, 242, 0.3);
  border-radius: 16px;
  padding: 4px;
  backdrop-filter: blur(10px);
}

.feed-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 16px;
  background: transparent;
  border: none;
  border-radius: 12px;
  color: #80848e;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  white-space: nowrap;
  position: relative;
  overflow: hidden;
}

.feed-tab::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(88, 101, 242, 0.1), rgba(88, 101, 242, 0.05));
  opacity: 0;
  transition: opacity 0.3s ease;
}

.feed-tab:hover {
  color: #ffffff;
  transform: translateY(-1px);
}

.feed-tab:hover::before {
  opacity: 1;
}

.feed-tab.active {
  background: linear-gradient(135deg, var(--brand-primary), #4752c4);
  color: #ffffff;
  box-shadow: 
    0 4px 15px rgba(88, 101, 242, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}

.feed-tab.active::before {
  opacity: 0;
}


</style>