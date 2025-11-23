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
import { useI18n } from 'vue-i18n';
import HashTagIcon from '@/components/icons/HashTag.vue';
import Icon from '@/components/common/Icon.vue';
import type { Channel } from '@/types';
import { ViewMode, ViewType, CurrentView, VIEW_CONFIGS } from '@/types/viewTypes';

const { t } = useI18n();

// Professional tab configuration using the centralized type system
const mainFeedTabs = [
  { id: CurrentView.HOME, label: t('activitypub.home'), icon: 'home' },
  { id: CurrentView.LOCAL, label: t('activitypub.local'), icon: 'users' },
  { id: CurrentView.PUBLIC, label: t('activitypub.federated'), icon: 'globe' },
  { id: CurrentView.TRENDING, label: t('activitypub.trending'), icon: 'trending-up' },
  { id: CurrentView.INSTANCES, label: t('activitypub.instances'), icon: 'server' }
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


</style>