<template>
  <div class="server-sidebar">
    <div 
      :style="{ backgroundImage: 'url(portal.png)' }"
      class="portal">
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

<script setup lang="ts">
  import { defineProps, defineEmits } from 'vue';
  import type { Server } from '@/types';
  import { useServerChannelStore } from '@/stores/useServerChannel';

  // TODO: were using the store but maybe it should just be passed as a prop from ChatView?
  const serverChannelStore = useServerChannelStore();
  defineProps({
    // make an array of type Server
    servers: {
      type: Array as () => Server[],
      required: true
    }
  });
  const emits = defineEmits(['serverSelected']);

  const selectServer = (serverId: string) => {
    emits('serverSelected', serverId);
  };
  
</script>

<style scoped>
.server-sidebar {
  width: 72px;
  background-color: #202225;
  display:flex;
  flex-direction: column;
  align-items: center;
}
.portal,
.server-item {
  width: 48px;
  height: 48px;
  background-color: #313336;
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
}
.portal {
  border-radius: 12px;
}
.separator {
  position: relative;
  width:80%;
  border-top: 1px solid #1d1d1d;
  border-bottom: 1px solid #2d2d2d;
}
.portal:hover,
.server-item:hover {
  left:5px;
}
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
.portal:hover::before,
.server-item:hover::before {
  left:-16px;
  opacity:1;
}

.portal.selected,
.server-item.selected {
  border: 3px solid #7289da;
  border-radius: 50%;
}
</style>
