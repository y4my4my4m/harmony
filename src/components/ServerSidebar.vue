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
    
    <div class="separator"></div>
    <div v-for="server in servers" 
      :key="server.id" 
      class="server-item"
      :style="{ backgroundImage: 'url(' + server.icon + ')' }" 
      :class="[{ 'selected': server.id === serverChannelStore.currentServerId }]"
      @click="selectServer(server.id)">
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, watch, computed } from 'vue';
import type { Server } from '@/types';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useRouter, useRoute } from 'vue-router';

export default defineComponent({
  props: {
    servers: {
      type: Array as () => Server[],
      required: true
    }
  },
  setup(props, { emit }) {
    const showPublicServers = ref(false);
    const serverChannelStore = useServerChannelStore();
    const router = useRouter();
    const route = useRoute();

    // Check if we're currently in DM mode
    const isDMSelected = computed(() => {
      return route.name === 'DM' || route.name === 'DMHome';
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
      router.push({ name: 'Chat', params: { serverId: serverId } });
    };

    const goToDMs = () => {
      router.push({ name: 'DMHome' });
    };

    return {
      showPublicServers,
      selectServer,
      goToDMs,
      isDMSelected,
      serverChannelStore,
      togglePublicServers
    };
  }
});
</script>

<style scoped>
.server-sidebar {
  width: 72px;
  background-color: var(--h-black);
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
.portal:hover,
.server-item:hover {
  left:5px;
}
.dm-button::before,
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
.portal:hover::before,
.server-item:hover::before {
  left:-16px;
  opacity:1;
}

.dm-button.selected,
.portal.selected,
.server-item.selected {
  border: 3px solid var(--h-primary);
  border-radius: 50%;
}
</style>
