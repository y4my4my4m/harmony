<template>
  <div class="server-sidebar">
    <div 
      :style="{ backgroundImage: 'url(/icon16.png)' }"
      class="portal"
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
    </div>

    <!-- Monyverse Button -->
    <div 
      class="monyverse-button"
      :class="{ 'selected': isMonyverseSelected }"
      @click="goToMonyverse"
      title="Monyverse - Federated Social"
    >
      <div class="monyverse-icon">M</div>
      <div v-if="unreadCount > 0" class="unread-badge">
        {{ unreadCount > 99 ? '99+' : unreadCount }}
      </div>
    </div>
    
    <div class="separator"></div>
    <div v-for="server in servers" 
      :key="server.id" 
      class="server-item"
      :style="{ backgroundImage: 'url(' + server.icon + ')' }" 
      :class="[{ 'selected': server.id === serverChannelStore.currentServerId && !isDMSelected && !isMonyverseSelected }]"
      @click="selectServer(server.id)">
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, computed, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { ViewMode, isActivityPubRoute } from '@/types/viewTypes';
import type { Server } from '@/types';

export default defineComponent({
  props: {
    servers: {
      type: Array as () => Server[],
      required: true
    }
  },
  emits: ['show-public-servers', 'switch-to-activitypub', 'switch-to-chat'],
  setup(props, { emit }) {
    const showPublicServers = ref(false);
    const serverChannelStore = useServerChannelStore();
    const activityPubStore = useActivityPubStore();
    const router = useRouter();
    const route = useRoute();

    // Check if we're currently in DM mode
    const isDMSelected = computed(() => {
      return route.name === 'DM' || route.name === 'DMHome';
    });

    // Check if we're currently in Monyverse/Social (ActivityPub)
    const isMonyverseSelected = computed(() => {
      return isActivityPubRoute(route.name as string);
    });

    // Get unread count from ActivityPub store
    const unreadCount = computed(() => {
      return activityPubStore.unreadCount;
    });

    const togglePublicServers = () => {
      showPublicServers.value = !showPublicServers.value;
    };

    watch(showPublicServers, (value) => {
      if (value) {
        emit('show-public-servers', value); 
      }
    });

    const selectServer = (serverId: string) => {
      emit('switch-to-chat');
      router.push({ name: 'Chat', params: { serverId: serverId } });
    };

    const goToDMs = () => {
      emit('switch-to-chat');
      router.push({ name: 'DMHome' });
    };

    const goToMonyverse = () => {
      activityPubStore.clearUnreadCount();
      emit('switch-to-activitypub');
      router.push({ name: 'Monyverse' });
    };

    return {
      showPublicServers,
      selectServer,
      goToDMs,
      goToMonyverse,
      isDMSelected,
      isMonyverseSelected,
      unreadCount,
      serverChannelStore,
      togglePublicServers
    };
  }
});
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
  background-color: var(--h-black-light);
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
  color: #b9bbbe;
  transition: color 0.2s ease;
}

.dm-button:hover .dm-icon {
  color: #ffffff;
}

.dm-button.selected {
  background: var(--h-brand, #5865f2);
  border-radius: 50%;
}

.dm-button.selected .dm-icon {
  color: #ffffff;
}

/* Monyverse Button */
.monyverse-button {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
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
  background: linear-gradient(135deg, #5865f2 0%, #7289da 100%);
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

.portal,
.server-item {
  width: 48px;
  height: 48px;
  background-color:var(--h-black-light);
  margin: 10px;
  padding: 4px;
  border-radius: 50%;
  text-align:center;
  vertical-align: middle;
  background-size: cover;
  background-position: center;
  cursor:pointer;
  position:relative;
  left:0;
  transition: border 0.6s ease-in-out, all 0.2s ease-in-out;
  border: 3px solid transparent;
  background-origin: border-box;
}
.portal {
  border-radius: 12px;
}
.separator {
  position: relative;
  width:80%;
  border-top: 1px solid #000000;
  border-bottom: 1px solid #2d2d2d;
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
  border: 3px solid var(--h-primary);
  border-radius: 50%;
}
</style>
