<template>
  <div class="server-sidebar">
    <div
      :style="{ backgroundImage: 'url(/icon16.png)', margin: '8px' }"
      class="portal"
      title="Harmony Portal"
      @click="togglePublicServers"
    >
    </div>
    <!-- DM Button at the top -->
    <div
      class="dm-button"
      :class="{ 'selected': isDMSelected }"
      @click="goToDMs"
      title="Direct Messages"
    >
      <svg viewBox="0 0 24 24" class="dm-icon">
        <path d="M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2M4,4H20V16H5.17L4,17.17V4Z" fill="currentColor"/>
      </svg>
      <div v-if="dmUnreadMentions > 0" class="unread-badge">
        {{ dmUnreadMentions > 99 ? '99+' : dmUnreadMentions }}
      </div>
    </div>

    <!-- Monyverse Button -->
    <div
      class="monyverse-button"
      :class="{ 'selected': isMonyverseSelected }"
      @click="goToMonyverse"
      title="Monyverse - Federated Social"
    >
      <div class="monyverse-icon">#</div>
      <div v-if="unreadCount > 0" class="unread-badge">
        {{ unreadCount > 99 ? '99+' : unreadCount }}
      </div>
    </div>

    <div class="separator"></div>

    <!-- The component ServerIcon is automatically available in the template -->
    <div
      v-for="server in props.servers"
      :key="server.id"
      class="server-item-wrapper"
    >
      <ServerIcon
        :id="server.id"
        :src="server.icon"
        :alt="server.name"
        size="md"
        class="server-item"
        :class="{ selected: isSelected(server.id) }"
        shape="round"
        :interactive="true"
        @click="selectServer(server.id)"
      />
      <div v-if="getServerUnreadMentions(server.id) > 0" class="unread-badge">
        {{ getServerUnreadMentions(server.id) > 99 ? '99+' : getServerUnreadMentions(server.id) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { useNotificationStore } from '@/stores/useNotification';
import { isActivityPubRoute } from '@/types/viewTypes';
import ServerIcon from '@/components/common/ServerIcon.vue';
import type { Server } from '@/types';

// Define Props
const props = defineProps<{
  servers: Server[];
}>();

// Define Emits for type safety
const emit = defineEmits<{
  (e: 'show-public-servers', value: boolean): void;
  (e: 'switch-to-activitypub'): void;
  (e: 'switch-to-chat'): void;
}>();

// Reactive state
const showPublicServers = ref(false);

// Composables and Stores
const serverChannelStore = useServerChannelStore();
const activityPubStore = useActivityPubStore();
const router = useRouter();
const route = useRoute();

// Computed properties
const isDMSelected = computed(() => {
  return route.name === 'DM' || route.name === 'DMHome' || route.name === 'DMConversation';
});

const isMonyverseSelected = computed(() => {
  return isActivityPubRoute(route.name as string);
});

// Use notification store for ActivityPub badge count (unified approach)
const unreadCount = computed(() => {
  // Count unread ActivityPub notifications (mentions, replies, reactions, etc.)
  return notificationStore.notifications.filter(
    n => !n.is_read && n.type.startsWith('activitypub_')
  ).length;
});

const notificationStore = useNotificationStore();

// Get total unread mentions across all DM conversations
const dmUnreadMentions = computed(() => {
  return notificationStore.unreadDMs;
});

// Get unread mentions for a server
const getServerUnreadMentions = (serverId: string): number => {
  return notificationStore.unreadServerMentions(serverId);
};

const isSelected = (serverId: string) => {
  return serverId === serverChannelStore.currentServerId && !isDMSelected.value && !isMonyverseSelected.value
};

// Watchers
watch(showPublicServers, (value) => {
  if (value) {
    emit('show-public-servers', value);
  }
});

// Methods
const togglePublicServers = () => {
  showPublicServers.value = !showPublicServers.value;
};

const selectServer = async (serverId?: string) => {
  if (!serverId) return;
  
  emit('switch-to-chat');
  
  // Set the current server first
  serverChannelStore.setCurrentServer(serverId);
  
  // Fetch channels for this server
  await serverChannelStore.fetchCategoriesAndChannels(serverId);
  
  // Get the default channel for this server
  const defaultChannelId = serverChannelStore.getDefaultChannel();
  
  if (defaultChannelId) {
    // Navigate to the specific server and channel
    router.push({ 
      name: 'ChatChannel', 
      params: { 
        serverId: serverId, 
        channelId: defaultChannelId 
      } 
    });
  } else {
    // Fallback to base chat route if no channels available
    router.push({ name: 'Chat' });
  }
};

const goToDMs = () => {
  emit('switch-to-chat');
  router.push({ name: 'DMHome' });
};

const goToMonyverse = () => {
  activityPubStore.clearUnreadCount();
  emit('switch-to-activitypub');
  router.push({ name: 'SocialHome' });
};
</script>

<style scoped>
.server-sidebar {
  width: 72px;
  display:flex;
  flex-direction: column;
  align-items: center;
}

.dm-button {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover));
  margin: 10px;
  padding: 4px;
  border-radius: 50%;
  text-align: center;
  vertical-align: middle;
  cursor: pointer;
  position: relative;
  left: 0;
  transition: border 0.6s ease-in-out, all 0.2s ease-in-out;
  border: 3px solid transparent;
  background-origin: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
}

.dm-icon {
  width: 24px;
  height: 24px;
  transition: color 0.2s ease;
}

.dm-button:hover .dm-icon {
  color: #ffffff;
}

.dm-button.selected {
  background: var(--harmony-primary, --harmony-primary-hover);
  border-radius: 50%;
}

.dm-button.selected .dm-icon {
  color: #ffffff;
}

/* Monyverse Button */
.monyverse-button {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover));
  margin: 10px;
  padding: 4px;
  border-radius: 12px;
  text-align: center;
  vertical-align: middle;
  cursor: pointer;
  position: relative;
  left: 0;
  transition: border 0.6s ease-in-out, all 0.2s ease-in-out;
  border: 3px solid transparent;
  background-origin: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
}

.monyverse-icon {
  font-size: 20px;
  font-weight: bold;
  color: #ffffff;
  font-family: 'Inter', sans-serif;
  transition: transform 0.2s ease;
}

.monyverse-button:hover {
  left: 5px;
  transform: scale(1.05);
}

.monyverse-button:hover .monyverse-icon {
  transform: scale(1.1);
}

.monyverse-button.selected {
  background: linear-gradient(135deg, var(--harmony-primary), var(--harmony-primary-hover));
  border: 3px solid var(--h-primary);
  border-radius: 50%;
}

.unread-badge {
  position: absolute;
  top: -8px;
  right: -8px;
  background: #f04747;
  color: white;
  font-size: 10px;
  font-weight: bold;
  padding: 2px 6px;
  border-radius: 10px;
  min-width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0% { transform: scale(1); }
  50% { transform: scale(1.1); }
  100% { transform: scale(1); }
}

.server-item-wrapper {
  position: relative;
  margin: 10px;
}

.portal,
.server-item {
  width: 48px;
  height: 48px;
  background-color:var(--h-black-light);
  margin: 0;
  border-radius: 50%;
  cursor:pointer;
  position:relative;
  left:0;
  transition: border 0.6s ease-in-out, all 0.2s ease-in-out;
  /* border: 2px solid transparent; */
  background-origin: content-box;
  background-position: center;
  background-size: cover;
}
.portal {
  border-radius: 12px;
}
.separator {
  position: relative;
  width:80%;
  /* border-top: 1px solid #000000; */
  border-top: 1px solid var(--border-secondary);
  /* border-bottom: 1px solid #2d2d2d; */
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 5px;
}
.dm-button:hover,
.monyverse-button:hover,
.portal:hover,
.server-item:hover {
  left:5px;
}
.dm-button::before,
.monyverse-button::before,
.portal::before,
.server-item::before {
  opacity:0;
  content: "";
  position: absolute;
  transition: all 0.2s ease-in-out;
  left:-25px;
  top: 17px;
  border-radius: 50%;
  width: 8px;
  height: 8px;
  background-color: var(--vt-c-divider-dark-1);
}
.dm-button:hover::before,
.monyverse-button:hover::before,
.portal:hover::before,
.server-item:hover::before {
  left:-16px;
  opacity:1;
}

.dm-button.selected,
.monyverse-button.selected,
.portal.selected,
.server-item.selected {
  border: 2px solid var(--h-secondary);
  border-radius: 50%;
}

.server-item.selected {
  border: 2px solid var(--h-secondary);
  border-radius: 50%;
}
</style>